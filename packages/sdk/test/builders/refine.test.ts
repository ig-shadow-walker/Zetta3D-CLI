import { describe, expect, it } from 'vitest'
import {
  REFINE_TOOLS,
  REFINE_TOOL_IDS,
  acceptedFormats,
  buildRefineRequest,
  convertTier,
  costOf,
  meshFormatFromUrl,
  needsConversion,
  refineOperation,
  type RefineInput,
  type RefineToolId,
} from '../../src/builders/refine'

/* Bodies ported from the Studio's tool panels (`*-settings-value.ts` → `postProcessRequestBody`). */

function ok<T extends RefineToolId>(tool: T, input: RefineInput<T>) {
  const result = buildRefineRequest(tool, input)
  if (!result.ok) throw new Error(`expected valid, got: ${result.problems.map((p) => p.message).join('; ')}`)
  return result
}

function codes<T extends RefineToolId>(tool: T, input: RefineInput<T>): string[] {
  const result = buildRefineRequest(tool, input)
  return result.ok ? [] : result.problems.map((p) => p.code)
}

const POST = { sourcePostId: 5 }
const REF = 'https://cdn.example.com/ref.png'

describe('retopo', () => {
  it('sends the Studio’s defaults: Zetta R1, an exact budget of 8,000 triangles, baking left on', () => {
    const result = ok('retopo', POST)
    expect(result.request).toEqual({
      spec: { postProcess: ['smart_topology'] },
      sourcePostId: 5,
      model: 'r1',
      faceCount: 8_000,
      polygonType: 'triangle',
      origin: 'cli',
    })
    expect(result.quote).toEqual({ postProcess: ['smart_topology'], model: 'r1' })
  })

  it('refuses the retired Zetta N1, by name', () => {
    const result = buildRefineRequest('retopo', { ...POST, engine: 'n1' as never })
    expect(!result.ok && result.problems.map((p) => p.code)).toEqual(['ENGINE_RETIRED'])
    expect(!result.ok && result.problems[0]?.message).toMatch(/Zetta N1 has been retired\. Retopology runs on Zetta R1\./)
    expect(codes('retopo', { ...POST, engine: 'r1' })).toEqual([])
  })

  it('refuses the retired face level, saying what to use instead', () => {
    const result = buildRefineRequest('retopo', { ...POST, faceLevel: 'low' } as RefineInput<'retopo'>)
    expect(!result.ok && result.problems.map((p) => p.code)).toEqual(['OPTION_RETIRED'])
    expect(!result.ok && result.problems[0]?.message).toMatch(/Set faces/)
  })

  it('halves the ceiling for quads', () => {
    expect(codes('retopo', { ...POST, faces: 20_000 })).toEqual([])
    expect(codes('retopo', { ...POST, faces: 20_001 })).toEqual(['OUT_OF_RANGE'])
    expect(codes('retopo', { ...POST, faces: 10_000, polygonType: 'quad' })).toEqual([])
    expect(codes('retopo', { ...POST, faces: 10_001, polygonType: 'quad' })).toEqual(['OUT_OF_RANGE'])
    expect(codes('retopo', { ...POST, faces: 499 })).toEqual(['OUT_OF_RANGE'])
    expect(codes('retopo', { ...POST, faces: 500, polygonType: 'quad' })).toEqual([])
  })

  it('sends bake only as false, unwrapUvs only as true, and part names', () => {
    expect(ok('retopo', { ...POST, bake: false }).request.bake).toBe(false)
    expect(ok('retopo', { ...POST, bake: true }).request).not.toHaveProperty('bake')
    expect(ok('retopo', { ...POST, unwrapUvs: true }).request.unwrapUvs).toBe(true)
    expect(ok('retopo', { ...POST, unwrapUvs: false }).request).not.toHaveProperty('unwrapUvs')
    expect(ok('retopo', { ...POST, partNames: [' arm ', ''] }).request.partNames).toEqual(['arm'])
  })

  it('reads GLB, OBJ and FBX', () => {
    expect(acceptedFormats('retopo')).toEqual(['GLB', 'OBJ', 'FBX'])
    expect(codes('retopo', { sourceFileUrl: 'https://cdn.example.com/mesh.fbx' })).toEqual([])
  })

  it('takes a source up to 150MB', () => {
    expect(codes('retopo', { ...POST, sourceBytes: 150 * 1024 * 1024 })).toEqual([])
    expect(codes('retopo', { ...POST, sourceBytes: 200 * 1024 * 1024 })).toEqual(['SOURCE_TOO_LARGE'])
  })
})

describe('segment', () => {
  it('sends the AI defaults', () => {
    expect(ok('segment', POST).request).toEqual({
      spec: { postProcess: ['ai_segmentation'] },
      sourcePostId: 5,
      segmentGranularity: 'balanced',
      origin: 'cli',
    })
  })

  it('sends splitByConnectivity only as false', () => {
    expect(ok('segment', { ...POST, splitByConnectivity: false }).request.splitByConnectivity).toBe(false)
    expect(ok('segment', { ...POST, splitByConnectivity: true }).request).not.toHaveProperty('splitByConnectivity')
  })

  it('sends a hint as the prompt on smart, and refuses each mode’s option on the other', () => {
    const request = ok('segment', { ...POST, mode: 'smart', prompt: ' a robot ', granularity: 'detailed' }).request
    expect(request).toMatchObject({ spec: { postProcess: ['smart_segmentation'] }, prompt: 'a robot', segmentGranularity: 'detailed' })
    expect(codes('segment', { ...POST, mode: 'smart', splitByConnectivity: false })).toEqual(['OPTION_NOT_APPLICABLE'])
    expect(codes('segment', { ...POST, prompt: 'a robot' })).toEqual(['OPTION_NOT_APPLICABLE'])
  })

  it('reads GLB only on smart', () => {
    expect(acceptedFormats('segment', { mode: 'smart' })).toEqual(['GLB'])
    const result = buildRefineRequest('segment', { sourceFileUrl: 'https://cdn.example.com/a.obj', mode: 'smart' })
    expect(!result.ok && result.problems[0]?.message).toMatch(/needs a GLB mesh.*Use a GLB source instead/)
  })
})

describe('uv', () => {
  it('sends bare UVs by default, as the Studio does', () => {
    expect(ok('uv', POST).request).toEqual({ spec: { postProcess: ['smart_uv'] }, sourcePostId: 5, bake: false, origin: 'cli' })
  })

  it('re-bakes the textures only when asked, and sends nothing for it', () => {
    expect(ok('uv', { ...POST, bake: true }).request).not.toHaveProperty('bake')
  })

  it('sends each other change from the default', () => {
    expect(ok('uv', { ...POST, exportOrientation: '+y', compressGeometry: true }).request).toMatchObject({
      bake: false,
      exportOrientation: '+y',
      compressGeometry: true,
    })
    for (const orientation of ['+x', '-x', '+y', '-y'] as const) {
      expect(ok('uv', { ...POST, exportOrientation: orientation }).request.exportOrientation).toBe(orientation)
    }
    expect(ok('uv', { ...POST, exportOrientation: 'as-is' }).request).not.toHaveProperty('exportOrientation')
  })

  it('refuses a source over 80,000 triangles', () => {
    expect(codes('uv', { ...POST, sourceTriangles: 80_000 })).toEqual([])
    expect(codes('uv', { ...POST, sourceTriangles: 80_001 })).toEqual(['SOURCE_TOO_DENSE'])
  })
})

describe('texture', () => {
  it('sends the Studio’s defaults with the reference picture', () => {
    expect(ok('texture', { ...POST, imageUrl: REF }).request).toEqual({
      spec: { postProcess: ['retexture'] },
      sourcePostId: 5,
      imageUrl: REF,
      textureAlignment: 'original_image',
      enablePBR: true,
      delight: true,
      origin: 'cli',
    })
  })

  it('bills the tier as its own code', () => {
    expect(ok('texture', { ...POST, imageUrl: REF, tier: 'hd' }).request.spec.postProcess).toEqual(['retexture_hd'])
    expect(ok('texture', { ...POST, imageUrl: REF, tier: '8k' }).quote).toEqual({ postProcess: ['retexture_8k'] })
  })

  it('sends textureFast only on the standard tier', () => {
    expect(ok('texture', { ...POST, imageUrl: REF, textureFast: true }).request.textureFast).toBe(true)
    const result = ok('texture', { ...POST, imageUrl: REF, textureFast: true, tier: '8k' })
    expect(result.request).not.toHaveProperty('textureFast')
    expect(result.warnings.join(' ')).toMatch(/textureFast/)
  })

  it('sends bake only as false, and the other options as chosen', () => {
    expect(
      ok('texture', { ...POST, imageUrl: REF, bake: false, enablePBR: false, delight: false, textureSeed: 4, partNames: ['head'] }).request,
    ).toMatchObject({ bake: false, enablePBR: false, delight: false, textureSeed: 4, partNames: ['head'] })
  })

  it('needs a reference picture', () => {
    expect(codes('texture', POST)).toEqual(['REFERENCE_REQUIRED'])
  })

  it('paints from reference views, front first, with no multi_view charge', () => {
    const views = { left: 'https://cdn.example.com/l.png', front: REF, right: 'https://cdn.example.com/r.png' }
    const result = ok('texture', { ...POST, views })
    expect(result.request.multiViewImages).toEqual([
      { viewType: 'front', imageUrl: REF },
      { viewType: 'left', imageUrl: views.left },
      { viewType: 'right', imageUrl: views.right },
    ])
    expect(result.request).not.toHaveProperty('imageUrl')
    expect(result.request.spec).toEqual({ postProcess: ['retexture'] })
    expect(ok('texture', { ...POST, views: { front: REF } }).request.multiViewImages).toHaveLength(1)
  })

  it('needs the front view, and one reference kind only', () => {
    expect(codes('texture', { ...POST, views: { left: REF, back: REF } })).toEqual(['FRONT_VIEW_REQUIRED'])
    expect(codes('texture', { ...POST, imageUrl: REF, views: { front: REF } })).toEqual(['IMAGE_WITH_VIEWS'])
    expect(codes('texture', { ...POST, views: { front: REF, top: REF } as never })).toEqual(['VIEW_NOT_SUPPORTED'])
    expect(codes('texture', { ...POST, views: { front: 'cdn.example.com/f.png' } })).toEqual(['INVALID_URL'])
  })
})

describe('rig', () => {
  it('sends nothing for the defaults', () => {
    expect(ok('rig', POST).request).toEqual({ spec: { postProcess: ['auto_rigging'] }, sourcePostId: 5, origin: 'cli' })
  })

  it('sends a skeleton naming in our own words, only when not the default', () => {
    expect(ok('rig', { ...POST, rigSpec: 'standard' }).request).not.toHaveProperty('rigSpec')
    for (const rigSpec of ['mixamo', 'unity', 'unreal', 'vrm', 'actorcore'] as const) {
      expect(ok('rig', { ...POST, rigSpec }).request.rigSpec).toBe(rigSpec)
      expect(ok('rig', { ...POST, rigType: 'biped', rigSpec }).request.rigSpec).toBe(rigSpec)
    }
  })

  it('names a skeleton for a humanoid only', () => {
    expect(codes('rig', { ...POST, rigType: 'quadruped', rigSpec: 'mixamo' })).toEqual(['RIG_SPEC_NEEDS_BIPED'])
    expect(ok('rig', { ...POST, rigType: 'quadruped', rigSpec: 'standard' }).request).not.toHaveProperty('rigSpec')
  })

  it('sends another body and the output format', () => {
    expect(ok('rig', { ...POST, rigType: 'quadruped', rigOutFormat: 'fbx' }).request).toMatchObject({
      rigType: 'quadruped',
      rigOutFormat: 'fbx',
    })
    expect(ok('rig', { ...POST, rigType: 'others' }).request.rigType).toBe('others')
  })

  it('refuses a naming it does not offer, the old vendor-named one included', () => {
    expect(codes('rig', { ...POST, rigSpec: 'legacy' as never })).toEqual(['INVALID_OPTION'])
  })
})

describe('convert', () => {
  it('needs an output format', () => {
    expect(codes('convert', POST)).toEqual(['OUTPUT_FORMAT_REQUIRED'])
  })

  it('bills the basic tier for a plain export', () => {
    const result = ok('convert', { ...POST, outputFormat: 'USDZ' })
    expect(result.request).toEqual({
      spec: { postProcess: ['convert_format'] },
      sourcePostId: 5,
      outputFormat: 'USDZ',
      origin: 'cli',
    })
  })

  it('bills the advanced tier as soon as a setting leaves its default', () => {
    expect(convertTier({ textureSize: 4096, scaleFactor: 1, textureFormat: 'JPEG' })).toBe('convert_format')
    for (const options of [
      { textureSize: 2048 },
      { textureFormat: 'PNG' as const },
      { scaleFactor: 0.01 },
      { flattenBottom: true },
      { pivotToCenterBottom: true },
      { faceLimit: 5_000 },
      { quad: true },
    ]) {
      expect(convertTier(options)).toBe('convert_format_advanced')
    }
    expect(ok('convert', { ...POST, outputFormat: 'OBJ', scaleFactor: 0.01 }).request.spec.postProcess).toEqual([
      'convert_format_advanced',
    ])
  })

  it('applies the exporter’s own rules', () => {
    expect(codes('convert', { ...POST, outputFormat: 'USDZ', quad: true })).toEqual(['QUAD_NEEDS_FBX'])
    expect(codes('convert', { ...POST, outputFormat: 'FBX', forceSymmetry: true })).toEqual(['SYMMETRY_NEEDS_QUAD'])
    expect(codes('convert', { ...POST, outputFormat: 'FBX', exportVertexColors: true })).toEqual(['VERTEX_COLORS_NEED_OBJ_OR_GLTF'])
    expect(codes('convert', { ...POST, outputFormat: 'STL', fbxPreset: 'mixamo' })).toEqual(['FBX_PRESET_NEEDS_FBX'])
    expect(codes('convert', { ...POST, outputFormat: 'OBJ', flattenBottomThreshold: 0.1 })).toEqual(['OPTION_NOT_APPLICABLE'])
    expect(codes('convert', { ...POST, outputFormat: 'OBJ', textureSize: 8192 })).toEqual(['OUT_OF_RANGE'])
    expect(codes('convert', { ...POST, outputFormat: 'OBJ', scaleFactor: 0 })).toEqual(['OUT_OF_RANGE'])
  })

  it('writes quads to FBX on the engine that takes them', () => {
    const result = ok('convert', { ...POST, outputFormat: 'FBX', quad: true, forceSymmetry: true })
    expect(result.request).toMatchObject({
      spec: { postProcess: ['convert_format_advanced'] },
      polygonType: 'quadrilateral',
      model: 'n25',
      forceSymmetry: true,
    })
    expect(result.quote.model).toBe('n25')
  })

  it('bounds the polygon limit as the default engine’s High rung, by topology', () => {
    expect(codes('convert', { ...POST, outputFormat: 'OBJ', faceLimit: 999 })).toEqual(['OUT_OF_RANGE'])
    expect(ok('convert', { ...POST, outputFormat: 'OBJ', faceLimit: 1_000 }).request.faceCount).toBe(1_000)
    expect(ok('convert', { ...POST, outputFormat: 'OBJ', faceLimit: 1_000_000 }).request.faceCount).toBe(1_000_000)
    expect(codes('convert', { ...POST, outputFormat: 'OBJ', faceLimit: 1_000_001 })).toEqual(['OUT_OF_RANGE'])
    expect(codes('convert', { ...POST, outputFormat: 'FBX', quad: true, faceLimit: 150_000 })).toEqual([])
    expect(codes('convert', { ...POST, outputFormat: 'FBX', quad: true, faceLimit: 200_000 })).toEqual(['OUT_OF_RANGE'])
  })

  it('sends booleans by definedness, so withAnimation false travels', () => {
    expect(ok('convert', { ...POST, outputFormat: 'GLTF', withAnimation: false, packUv: true }).request).toMatchObject({
      withAnimation: false,
      packUv: true,
    })
  })
})

describe('the source', () => {
  it('takes one of sourcePostId and sourceFileUrl', () => {
    expect(codes('rig', {})).toEqual(['SOURCE_REQUIRED'])
    expect(codes('rig', { sourcePostId: 5, sourceFileUrl: 'https://cdn.example.com/a.glb' })).toEqual(['SOURCE_CONFLICT'])
    expect(codes('rig', { sourcePostId: 0 })).toEqual(['INVALID_SOURCE'])
  })

  it('reads the format from a signed URL’s path', () => {
    expect(meshFormatFromUrl('https://cdn.example.com/mesh.glb?X-Signature=abc.def')).toBe('GLB')
    expect(meshFormatFromUrl('https://cdn.example.com/mesh.zip')).toBeNull()
    expect(ok('rig', { sourceFileUrl: 'https://cdn.example.com/mesh.glb?sig=1' }).request.sourceFileUrl).toBe(
      'https://cdn.example.com/mesh.glb?sig=1',
    )
    expect(codes('rig', { sourceFileUrl: 'https://cdn.example.com/mesh.stl' })).toEqual(['SOURCE_FORMAT_UNKNOWN'])
    expect(codes('rig', { sourceFileUrl: 'cdn.example.com/mesh.glb' })).toEqual(['INVALID_URL'])
  })

  it('checks the formats a post holds, when given', () => {
    expect(codes('segment', { ...POST, mode: 'smart', sourceFormat: ['GLB', 'FBX'] })).toEqual([])
    expect(codes('segment', { ...POST, mode: 'smart', sourceFormat: 'FBX' })).toEqual(['SOURCE_FORMAT_NOT_ACCEPTED'])
  })

  it('refuses an option of another tool', () => {
    const result = buildRefineRequest('rig', { ...POST, bake: false } as RefineInput<'rig'>)
    expect(!result.ok && result.problems).toEqual([
      { code: 'UNKNOWN_OPTION', field: 'bake', message: 'bake is not an option of refine rig.' },
    ])
  })

  it('carries the metadata', () => {
    expect(ok('rig', { ...POST, title: ' Troll ', origin: 'mcp', availability: 'private' }).request).toMatchObject({
      title: 'Troll',
      origin: 'mcp',
      availability: 'private',
    })
  })
})

describe('conversion and cost', () => {
  const prices = {
    items: [
      { code: 'smart_topology', credits: 38, model: 'r1' },
      { code: 'convert_format', credits: 5, model: null },
      { code: 'retexture', credits: 30, model: null },
    ],
  }

  it('says when a source has to be converted first', () => {
    expect(needsConversion('retopo', ['FBX'])).toBe(false)
    expect(needsConversion('segment', 'OBJ', { mode: 'smart' })).toBe(true)
    expect(needsConversion('segment', ['OBJ', 'GLB'], { mode: 'smart' })).toBe(false)
    expect(needsConversion('rig', [])).toBe(false)
  })

  it('prices retopology on R1, with the conversion added when needed', () => {
    expect(costOf('retopo', prices, {}, ['GLB'])).toBe(38)
    expect(costOf('segment', { items: [...prices.items, { code: 'smart_segmentation', credits: 55, model: null }] }, { mode: 'smart' }, ['OBJ'])).toBe(60)
    expect(costOf('texture', prices, {}, ['GLB'])).toBe(30)
    expect(costOf('rig', prices)).toBeNull()
    expect(costOf('retopo', undefined)).toBeNull()
  })

  it('resolves the billed code from the settings', () => {
    expect(refineOperation('segment', { mode: 'smart' })).toBe('smart_segmentation')
    expect(refineOperation('texture', { tier: 'hd' })).toBe('retexture_hd')
    expect(refineOperation('convert', { outputFormat: 'OBJ' })).toBe('convert_format')
  })
})

describe('the catalogue', () => {
  it('covers every tool, with consistent option metadata', () => {
    expect(Object.keys(REFINE_TOOLS)).toEqual([...REFINE_TOOL_IDS])
    for (const tool of Object.values(REFINE_TOOLS)) {
      expect(tool.codes.length).toBeGreaterThan(0)
      expect(tool.description).toBeTruthy()
      for (const option of tool.options) {
        expect(option.description).toBeTruthy()
        if (option.type === 'enum' || option.type === 'views') {
          expect(option.values?.length).toBeGreaterThan(0)
          if (option.default !== undefined) expect(option.values).toContain(option.default)
        }
      }
    }
  })

  it('builds every tool’s defaults into a request the server accepts', () => {
    const minimal: { [T in RefineToolId]: RefineInput<T> } = {
      retopo: POST,
      segment: POST,
      uv: POST,
      texture: { ...POST, imageUrl: REF },
      rig: POST,
      convert: { ...POST, outputFormat: 'FBX' },
    }
    for (const tool of REFINE_TOOL_IDS) {
      const result = buildRefineRequest(tool, minimal[tool] as RefineInput<typeof tool>)
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.request.spec.postProcess).toHaveLength(1)
    }
  })
})
