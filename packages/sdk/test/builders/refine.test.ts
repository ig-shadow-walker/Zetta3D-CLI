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
  it('sends the R1 defaults: an exact budget of 8,000 triangles, baking left on', () => {
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

  it('sends a level, not a count, on N1', () => {
    expect(ok('retopo', { ...POST, engine: 'n1' }).request).toEqual({
      spec: { postProcess: ['smart_topology'] },
      sourcePostId: 5,
      model: 'n1',
      faceLevel: 'medium',
      polygonType: 'triangle',
      origin: 'cli',
    })
  })

  it('halves the R1 ceiling for quads', () => {
    expect(codes('retopo', { ...POST, faces: 20_000 })).toEqual([])
    expect(codes('retopo', { ...POST, faces: 20_001 })).toEqual(['OUT_OF_RANGE'])
    expect(codes('retopo', { ...POST, faces: 10_000, polygonType: 'quad' })).toEqual([])
    expect(codes('retopo', { ...POST, faces: 10_001, polygonType: 'quad' })).toEqual(['OUT_OF_RANGE'])
    expect(codes('retopo', { ...POST, faces: 499 })).toEqual(['OUT_OF_RANGE'])
  })

  it('refuses R1-only options on N1', () => {
    expect(codes('retopo', { ...POST, engine: 'n1', faces: 5_000 })).toEqual(['OPTION_NOT_APPLICABLE'])
    expect(codes('retopo', { ...POST, engine: 'n1', bake: false })).toEqual(['OPTION_NOT_APPLICABLE'])
    expect(codes('retopo', { ...POST, engine: 'n1', partNames: ['arm'] })).toEqual(['OPTION_NOT_APPLICABLE'])
  })

  it('sends bake only as false, and part names on R1', () => {
    expect(ok('retopo', { ...POST, bake: false }).request.bake).toBe(false)
    expect(ok('retopo', { ...POST, bake: true }).request).not.toHaveProperty('bake')
    expect(ok('retopo', { ...POST, partNames: [' arm ', ''] }).request.partNames).toEqual(['arm'])
  })

  it('takes a level on R1 in place of a count, but not both', () => {
    const request = ok('retopo', { ...POST, faceLevel: 'low' }).request
    expect(request.faceLevel).toBe('low')
    expect(request).not.toHaveProperty('faceCount')
    expect(codes('retopo', { ...POST, faceLevel: 'low', faces: 5_000 })).toEqual(['FACES_AND_LEVEL'])
  })

  it('reads FBX on R1 but not on N1', () => {
    const url = 'https://cdn.example.com/mesh.fbx'
    expect(codes('retopo', { sourceFileUrl: url })).toEqual([])
    const result = buildRefineRequest('retopo', { sourceFileUrl: url, engine: 'n1' })
    expect(!result.ok && result.problems.map((p) => p.code)).toEqual(['SOURCE_FORMAT_NOT_ACCEPTED'])
    expect(!result.ok && result.problems[0]?.message).toMatch(/needs a GLB or OBJ mesh.*Convert it to OBJ/)
  })

  it('has no size ceiling on N1, 150MB on R1', () => {
    const big = 200 * 1024 * 1024
    expect(codes('retopo', { ...POST, engine: 'n1', sourceBytes: big })).toEqual([])
    expect(codes('retopo', { ...POST, sourceBytes: big })).toEqual(['SOURCE_TOO_LARGE'])
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
  it('sends nothing for the defaults', () => {
    expect(ok('uv', POST).request).toEqual({ spec: { postProcess: ['smart_uv'] }, sourcePostId: 5, origin: 'cli' })
  })

  it('sends each change from the default', () => {
    expect(ok('uv', { ...POST, bake: false, exportOrientation: '+y', compressGeometry: true }).request).toMatchObject({
      bake: false,
      exportOrientation: '+y',
      compressGeometry: true,
    })
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

  /* The Studio sends views here; the server refuses them without a multi_view modifier. */
  it('refuses reference views, which the server does not take on a retexture', () => {
    expect(codes('texture', { ...POST, views: { front: REF, left: REF } })).toEqual(['TEXTURE_VIEWS_NOT_ACCEPTED'])
  })
})

describe('rig', () => {
  it('sends nothing for the defaults', () => {
    expect(ok('rig', POST).request).toEqual({ spec: { postProcess: ['auto_rigging'] }, sourcePostId: 5, origin: 'cli' })
  })

  it('sends standard and mixamo in our own words, only when not the default', () => {
    expect(ok('rig', { ...POST, rigSpec: 'standard' }).request).not.toHaveProperty('rigSpec')
    expect(ok('rig', { ...POST, rigSpec: 'mixamo' }).request.rigSpec).toBe('mixamo')
    expect(ok('rig', { ...POST, rigType: 'quadruped', rigOutFormat: 'fbx' }).request).toMatchObject({
      rigType: 'quadruped',
      rigOutFormat: 'fbx',
    })
  })

  it('refuses a naming it does not offer', () => {
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

  it('bounds the polygon limit by topology', () => {
    expect(codes('convert', { ...POST, outputFormat: 'OBJ', faceLimit: 3_000 })).toEqual(['OUT_OF_RANGE'])
    expect(ok('convert', { ...POST, outputFormat: 'OBJ', faceLimit: 5_000 }).request.faceCount).toBe(5_000)
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
      { code: 'smart_topology', credits: 85, model: 'n1' },
      { code: 'convert_format', credits: 5, model: null },
      { code: 'retexture', credits: 30, model: null },
    ],
  }

  it('says when a source has to be converted first', () => {
    expect(needsConversion('retopo', ['FBX'], { engine: 'n1' })).toBe(true)
    expect(needsConversion('retopo', ['FBX'])).toBe(false)
    expect(needsConversion('retopo', ['FBX', 'GLB'], { engine: 'n1' })).toBe(false)
    expect(needsConversion('segment', 'OBJ', { mode: 'smart' })).toBe(true)
    expect(needsConversion('rig', [])).toBe(false)
  })

  it('prices per engine, with the conversion added when needed', () => {
    expect(costOf('retopo', prices, {}, ['GLB'])).toBe(38)
    expect(costOf('retopo', prices, { engine: 'n1' }, ['GLB'])).toBe(85)
    expect(costOf('retopo', prices, { engine: 'n1' }, ['FBX'])).toBe(90)
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
        if (option.type === 'enum') {
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
