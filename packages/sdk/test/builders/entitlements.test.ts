import { describe, expect, it } from 'vitest'
import {
  PLAN_REQUIRED_MESSAGE,
  buildGenerateRequest,
  checkEntitlements,
  type GenerateInput,
  type ThreeDEntitlements,
} from '../../src/builders/gen3d'
import { buildRefineRequest } from '../../src/builders/refine'
import { buildSplatRequest, buildWorldExportRequest } from '../../src/builders/splat'
import type { CreateGenerationRequest } from '../../src/builders/common'

/*
 * The plan ladder, from the server's seed values and entitlement tests. Since free accounts stopped
 * generating, an unpaid plan has one answer (PLAN_REQUIRED) and every paid plan has every feature,
 * so the per-feature gates are exercised with a hypothetical paid plan that lacks them all.
 */

const base = {
  maxConcurrentJobs: null,
  concurrency: { total: null, perCategory: {} },
}
/** `none` and `free`: may sign in and look around, may not generate. */
const FREE: ThreeDEntitlements = {
  ...base,
  maxConcurrentJobs: 1,
  maxMultiViewImages: 0,
  allowsLowPoly: false,
  allowsQuadMesh: false,
  allowsCustomFaceCount: false,
  maxFaceCount: 200_000,
  allowsZettaN25: false,
  allowsZettaNp1: false,
  allowsPostProcess: false,
  allowsPrivateGenerations: false,
  allowsSplat: false,
}
/** Tester, Basic and up, as seeded: every feature. */
const PAID: ThreeDEntitlements = {
  ...base,
  maxMultiViewImages: 4,
  allowsLowPoly: true,
  allowsQuadMesh: true,
  allowsCustomFaceCount: true,
  maxFaceCount: 1_500_000,
  allowsZettaN25: true,
  allowsZettaNp1: true,
  allowsPostProcess: true,
  allowsPrivateGenerations: true,
  allowsSplat: true,
}
/** A paid plan without any of the gated features, to exercise each gate. */
const LIMITED: ThreeDEntitlements = {
  ...FREE,
  allowsPrivateGenerations: true,
}

const IMG = 'https://cdn.example.com/a.png'
const V = (n: number) => `https://cdn.example.com/view-${n}.png`

function request(input: GenerateInput): CreateGenerationRequest {
  const result = buildGenerateRequest(input)
  if (!result.ok) throw new Error(result.problems.map((p) => p.message).join('; '))
  return result.request
}

const codes = (req: CreateGenerationRequest, ent: ThreeDEntitlements) => checkEntitlements(req, ent).map((p) => p.code)

describe('no plan, no generating', () => {
  it('gives an unpaid account one answer, whatever it asked for', () => {
    const rig = buildRefineRequest('rig', { sourcePostId: 3 })
    const splat = buildSplatRequest({ engine: 'zs2', imageUrl: IMG })
    const exported = buildWorldExportRequest({ sourcePostId: 3, kind: 'mesh', engine: 'zs2' })
    if (!rig.ok || !splat.ok || !exported.ok) throw new Error('expected requests')
    for (const req of [request({ imageUrl: IMG }), request({ engine: 'np1', imageUrl: IMG }), rig.request, splat.request, exported.request]) {
      expect(codes(req, FREE)).toEqual(['PLAN_REQUIRED'])
    }
    expect(checkEntitlements(request({ imageUrl: IMG }), FREE)[0]?.message).toBe(PLAN_REQUIRED_MESSAGE)
  })

  it('lets a paid plan through', () => {
    expect(codes(request({ imageUrl: IMG }), PAID)).toEqual([])
    expect(codes(request({ engine: 'np15', imageUrl: IMG, polygonType: 'quad' }), PAID)).toEqual([])
  })
})

describe('multi-view', () => {
  const two = request({ views: { front: V(1), left: V(2) } })
  const three = request({ views: { front: V(1), left: V(2), back: V(3) } })
  const four = request({ views: { front: V(1), left: V(2), back: V(3), right: V(4) } })

  it('is refused on a plan without it', () => {
    expect(codes(two, LIMITED)).toContain('MULTI_VIEW_NOT_AVAILABLE')
  })

  it('is capped by the plan’s view count', () => {
    const twoViews = { ...PAID, maxMultiViewImages: 2 }
    expect(codes(two, twoViews)).toEqual([])
    expect(codes(three, twoViews)).toEqual(['MULTI_VIEW_TOO_MANY_IMAGES'])
    expect(checkEntitlements(three, twoViews)[0]?.message).toMatch(/Four views — front, back, left and right/)
  })

  it('allows all four on every paid plan', () => {
    expect(codes(four, PAID)).toEqual([])
  })

  it('refuses the paid modifier even with no images attached', () => {
    const forged: CreateGenerationRequest = { spec: { generation: { base: 'textured', modifiers: ['multi_view'] } }, imageUrl: IMG, model: 'n25' }
    expect(codes(forged, LIMITED)).toContain('MULTI_VIEW_NOT_AVAILABLE')
  })
})

describe('low-poly, quads and the polygon count', () => {
  it('refuses low-poly on a plan without it', () => {
    const lowpoly = request({ imageUrl: IMG, quality: 'lowpoly' })
    expect(codes(lowpoly, LIMITED)).toContain('LOWPOLY_NOT_AVAILABLE')
    expect(codes(lowpoly, PAID)).toEqual([])
  })

  it('refuses quads on a plan without them, on generation and refine alike', () => {
    const quads = request({ imageUrl: IMG, quality: 'lowpoly', polygonType: 'quad' })
    expect(codes(quads, { ...PAID, allowsQuadMesh: false })).toEqual(['QUAD_MESH_NOT_AVAILABLE'])
    expect(codes(quads, PAID)).toEqual([])
    const retopo = buildRefineRequest('retopo', { sourcePostId: 3, polygonType: 'quad' })
    if (!retopo.ok) throw new Error('expected a request')
    expect(codes(retopo.request, { ...PAID, allowsQuadMesh: false })).toEqual(['QUAD_MESH_NOT_AVAILABLE'])
    expect(codes(retopo.request, PAID)).toEqual([])
  })

  it('never refuses triangles', () => {
    expect(codes(request({ imageUrl: IMG, quality: 'lowpoly' }), { ...PAID, allowsQuadMesh: false })).toEqual([])
  })

  it('refuses a custom count on a plan that cannot choose one', () => {
    const custom = request({ imageUrl: IMG, faceCount: 250_000 })
    expect(codes(custom, { ...PAID, allowsCustomFaceCount: false })).toEqual(['CUSTOM_FACE_COUNT_NOT_AVAILABLE'])
    expect(codes(custom, PAID)).toEqual([])
  })
})

describe('ultra detail: a locked rung', () => {
  const noUltra = { ...PAID, maxFaceCount: 200_000 }

  it('refuses Ultra on a plan without it, by either signal', () => {
    expect(codes(request({ imageUrl: IMG, quality: 'ultra', faceCount: 500_000 }), noUltra)).toEqual(['ULTRA_DETAIL_NOT_AVAILABLE'])
    // High opens at 1,000,000 on N2.5, which the server also reads as asking for Ultra.
    expect(codes(request({ imageUrl: IMG }), noUltra)).toEqual(['ULTRA_DETAIL_NOT_AVAILABLE'])
  })

  it('does not clip a count below 1,000,000', () => {
    expect(codes(request({ imageUrl: IMG, quality: 'high', faceCount: 500_000 }), noUltra)).toEqual([])
  })

  it('allows Ultra on every paid plan', () => {
    expect(codes(request({ imageUrl: IMG, quality: 'ultra' }), PAID)).toEqual([])
  })

  it('ignores an absent face count', () => {
    expect(codes(request({ imageUrl: IMG, allowsCustomFaceCount: false }), noUltra)).toEqual([])
  })
})

describe('engines', () => {
  it('refuses N2.5 and the Np line on a plan without them', () => {
    for (const engine of ['n25', 'np1', 'np15'] as const) {
      expect(codes(request({ engine, imageUrl: IMG, faceCount: engine === 'n25' ? 500_000 : 1_000 }), LIMITED)).toContain(
        'MODEL_NOT_AVAILABLE',
      )
    }
  })

  it('names the engine it is talking about, and no retired one', () => {
    const [found] = checkEntitlements(request({ imageUrl: IMG, allowsCustomFaceCount: false }), LIMITED)
    expect(found?.message).toMatch(/Zetta N2\.5/)
    expect(found?.message).not.toMatch(/N1/)
    expect(found?.field).toBe('engine')
  })

  it('reads a request naming no engine as N2.5, as the server does', () => {
    const unnamed: CreateGenerationRequest = { spec: { generation: { base: 'textured', modifiers: [] } }, imageUrl: IMG }
    expect(codes(unnamed, LIMITED)).toContain('MODEL_NOT_AVAILABLE')
  })

  it('runs every retopology on R1, whatever it names', () => {
    const retopo: CreateGenerationRequest = { spec: { postProcess: ['smart_topology'] }, sourcePostId: 3, faceCount: 8_000 }
    expect(codes(retopo, { ...PAID, allowsZettaN25: false })).toEqual([])
  })
})

describe('private generations', () => {
  it('never refuses public, and says nothing when no visibility is named', () => {
    expect(codes(request({ imageUrl: IMG, availability: 'public' }), PAID)).toEqual([])
    expect(codes(request({ imageUrl: IMG, availability: 'private' }), PAID)).toEqual([])
    expect(codes(request({ imageUrl: IMG }), PAID)).toEqual([])
  })
})

describe('the refine tools and splats', () => {
  it('refuses a refine job on a plan without the tools', () => {
    const rig = buildRefineRequest('rig', { sourcePostId: 3 })
    if (!rig.ok) throw new Error('expected a request')
    expect(codes(rig.request, LIMITED)).toContain('TOOLS_NOT_AVAILABLE')
    expect(codes(rig.request, PAID)).toEqual([])
  })

  it('does not touch a generation with no refine step', () => {
    expect(codes(request({ imageUrl: IMG }), { ...PAID, allowsPostProcess: false })).toEqual([])
  })

  it('refuses splats on a plan without them', () => {
    const splat = buildSplatRequest({ engine: 'zs2', imageUrl: IMG })
    if (!splat.ok) throw new Error('expected a request')
    expect(codes(splat.request, { ...PAID, allowsSplat: false })).toEqual(['SPLAT_NOT_AVAILABLE'])
    expect(codes(splat.request, PAID)).toEqual([])
    // An older response without allowsSplat answers from the same plan rule.
    const { allowsSplat: _, ...older } = PAID
    expect(codes(splat.request, older)).toEqual([])
  })
})

it('reports every violation of a paid plan in one pass', () => {
  const req = request({ views: { front: V(1), left: V(2) }, quality: 'lowpoly', polygonType: 'quad', faceCount: 5_000 })
  expect(codes(req, LIMITED)).toEqual([
    'MODEL_NOT_AVAILABLE',
    'MULTI_VIEW_NOT_AVAILABLE',
    'LOWPOLY_NOT_AVAILABLE',
    'QUAD_MESH_NOT_AVAILABLE',
    'CUSTOM_FACE_COUNT_NOT_AVAILABLE',
  ])
})
