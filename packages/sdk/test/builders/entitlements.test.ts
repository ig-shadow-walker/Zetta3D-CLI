import { describe, expect, it } from 'vitest'
import {
  buildGenerateRequest,
  checkEntitlements,
  type GenerateInput,
  type ThreeDEntitlements,
} from '../../src/builders/gen3d'
import { buildRefineRequest } from '../../src/builders/refine'
import { buildSplatRequest } from '../../src/builders/splat'
import type { CreateGenerationRequest } from '../../src/builders/common'

/* The plan ladder, ported from the server's own entitlement tests and seed values. */

const base = {
  maxConcurrentJobs: null,
  concurrency: { total: null, perCategory: {} },
}
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
const TESTER: ThreeDEntitlements = {
  ...base,
  maxMultiViewImages: 2,
  allowsLowPoly: true,
  allowsQuadMesh: false,
  allowsCustomFaceCount: true,
  maxFaceCount: 200_000,
  allowsZettaN25: true,
  allowsZettaNp1: true,
  allowsPostProcess: true,
  allowsPrivateGenerations: true,
  allowsSplat: true,
}
const BASIC: ThreeDEntitlements = { ...TESTER, maxMultiViewImages: 4, allowsQuadMesh: true, maxFaceCount: 1_500_000 }

const IMG = 'https://cdn.example.com/a.png'
const V = (n: number) => `https://cdn.example.com/view-${n}.png`

function request(input: GenerateInput): CreateGenerationRequest {
  const result = buildGenerateRequest(input)
  if (!result.ok) throw new Error(result.problems.map((p) => p.message).join('; '))
  return result.request
}

const codes = (req: CreateGenerationRequest, ent: ThreeDEntitlements) => checkEntitlements(req, ent).map((p) => p.code)

describe('multi-view: paid plans only, two on Tester, all four from Basic', () => {
  const two = request({ views: { front: V(1), left: V(2) } })
  const three = request({ views: { front: V(1), left: V(2), back: V(3) } })
  const four = request({ views: { front: V(1), left: V(2), back: V(3), right: V(4) } })

  it('refuses any multi-view on an unpaid plan', () => {
    expect(codes(two, FREE)).toEqual(['MULTI_VIEW_NOT_AVAILABLE'])
  })

  it('allows two on Tester and refuses the third', () => {
    expect(codes(two, TESTER)).toEqual([])
    expect(codes(three, TESTER)).toEqual(['MULTI_VIEW_TOO_MANY_IMAGES'])
  })

  it('allows four on Basic', () => {
    expect(codes(four, BASIC)).toEqual([])
  })

  it('refuses the paid modifier even with no images attached', () => {
    const forged: CreateGenerationRequest = { spec: { generation: { base: 'textured', modifiers: ['multi_view'] } }, imageUrl: IMG }
    expect(codes(forged, FREE)).toEqual(['MULTI_VIEW_NOT_AVAILABLE'])
  })
})

describe('low-poly, quads and the polygon count', () => {
  it('refuses low-poly on free and allows it from Tester', () => {
    const lowpoly = request({ imageUrl: IMG, quality: 'lowpoly' })
    expect(codes(lowpoly, FREE)).toContain('LOWPOLY_NOT_AVAILABLE')
    expect(codes(lowpoly, TESTER)).toEqual([])
  })

  it('refuses quads below Basic, on generation and refine alike', () => {
    const quads = request({ imageUrl: IMG, quality: 'lowpoly', polygonType: 'quad' })
    expect(codes(quads, TESTER)).toEqual(['QUAD_MESH_NOT_AVAILABLE'])
    expect(codes(quads, BASIC)).toEqual([])
    const retopo = buildRefineRequest('retopo', { sourcePostId: 3, polygonType: 'quad' })
    if (!retopo.ok) throw new Error('expected a request')
    expect(codes(retopo.request, TESTER)).toEqual(['QUAD_MESH_NOT_AVAILABLE'])
    expect(codes(retopo.request, BASIC)).toEqual([])
  })

  it('never refuses triangles', () => {
    expect(codes(request({ imageUrl: IMG, quality: 'lowpoly' }), TESTER)).toEqual([])
  })

  it('refuses a custom count on a plan that cannot choose one', () => {
    const custom = request({ imageUrl: IMG, faceCount: 250_000 })
    expect(codes(custom, FREE)).toEqual(['CUSTOM_FACE_COUNT_NOT_AVAILABLE'])
    expect(codes(custom, TESTER)).toEqual([])
  })
})

describe('ultra detail: a locked rung, from Basic', () => {
  it('refuses Ultra below Basic, by either signal', () => {
    expect(codes(request({ engine: 'n25', imageUrl: IMG, quality: 'ultra', faceCount: 500_000 }), TESTER)).toEqual([
      'ULTRA_DETAIL_NOT_AVAILABLE',
    ])
    expect(codes(request({ imageUrl: IMG, quality: 'ultra' }), TESTER)).toEqual(['ULTRA_DETAIL_NOT_AVAILABLE'])
  })

  /* The Studio also blocks counts above the plan's 200,000; the server does not, and wins. */
  it('does not clip a count that is merely above the old plan ceiling', () => {
    expect(codes(request({ imageUrl: IMG, quality: 'high', faceCount: 500_000 }), TESTER)).toEqual([])
  })

  it('allows Ultra from Basic', () => {
    expect(codes(request({ engine: 'n25', imageUrl: IMG, quality: 'ultra' }), BASIC)).toEqual([])
  })

  it('ignores an absent face count', () => {
    expect(codes(request({ imageUrl: IMG, allowsCustomFaceCount: false }), FREE)).toEqual([])
  })
})

describe('paid engines', () => {
  it('refuses N2.5 and the Np line on an unpaid plan', () => {
    for (const engine of ['n25', 'np1', 'np15'] as const) {
      expect(codes(request({ engine, imageUrl: IMG, allowsCustomFaceCount: false }), FREE)).toEqual(['MODEL_NOT_AVAILABLE'])
    }
  })

  it('allows them from Tester', () => {
    expect(codes(request({ engine: 'np15', imageUrl: IMG }), TESTER)).toEqual([])
  })

  it('names the engine it is talking about', () => {
    const [found] = checkEntitlements(request({ engine: 'n25', imageUrl: IMG, allowsCustomFaceCount: false }), FREE)
    expect(found?.message).toMatch(/Zetta N2\.5/)
    expect(found?.field).toBe('engine')
  })
})

describe('private generations', () => {
  it('refuses an explicit private on an unpaid plan', () => {
    expect(codes(request({ imageUrl: IMG, availability: 'private' }), FREE)).toEqual(['PRIVATE_NOT_AVAILABLE'])
  })

  it('never refuses public, and says nothing when no visibility is named', () => {
    expect(codes(request({ imageUrl: IMG, availability: 'public' }), FREE)).toEqual([])
    expect(codes(request({ imageUrl: IMG }), FREE)).toEqual([])
  })
})

describe('the refine tools and splats', () => {
  it('refuses a refine job on an unpaid plan', () => {
    const rig = buildRefineRequest('rig', { sourcePostId: 3 })
    if (!rig.ok) throw new Error('expected a request')
    expect(codes(rig.request, FREE)).toEqual(['TOOLS_NOT_AVAILABLE'])
    expect(codes(rig.request, TESTER)).toEqual([])
  })

  it('does not touch a generation with no refine step', () => {
    expect(codes(request({ imageUrl: IMG }), FREE)).toEqual([])
  })

  it('refuses splats on an unpaid plan', () => {
    const splat = buildSplatRequest({ engine: 'zs2', imageUrl: IMG })
    if (!splat.ok) throw new Error('expected a request')
    expect(codes(splat.request, FREE)).toEqual(['SPLAT_NOT_AVAILABLE'])
    expect(codes(splat.request, TESTER)).toEqual([])
    // An older response without allowsSplat answers from the same plan rule.
    const { allowsSplat: _, ...older } = TESTER
    expect(codes(splat.request, older)).toEqual([])
  })
})

it('reports every violation in one pass', () => {
  const req = request({ engine: 'n25', views: { front: V(1), left: V(2) }, availability: 'private', quality: 'lowpoly', allowsCustomFaceCount: false })
  expect(codes(req, FREE)).toEqual([
    'MODEL_NOT_AVAILABLE',
    'PRIVATE_NOT_AVAILABLE',
    'MULTI_VIEW_NOT_AVAILABLE',
    'LOWPOLY_NOT_AVAILABLE',
  ])
})
