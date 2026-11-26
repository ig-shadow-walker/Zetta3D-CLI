import { describe, expect, it } from 'vitest'
import {
  ENGINES,
  GENERATE_ENGINE_IDS,
  buildGenerateRequest,
  defaultFaceCount,
  faceCountRange,
  needsImageForPrompt,
  type GenerateInput,
} from '../../src/builders/gen3d'

/*
 * Parity vectors ported from the Studio's own request tests (`gen3d-request.test.ts`,
 * `gen3d-request.n25-matrix.test.ts`, `np1.test.ts`), re-expressed in CLI options. Where the Studio
 * silently coerces a control and the CLI refuses an explicit choice instead, the test says so.
 */

const IMG = 'https://cdn.example.com/chair.png'

function ok(input: GenerateInput) {
  const result = buildGenerateRequest(input)
  if (!result.ok) throw new Error(`expected valid, got: ${result.problems.map((p) => p.message).join('; ')}`)
  return result
}

function req(input: GenerateInput) {
  return ok(input).request
}

function codes(input: GenerateInput): string[] {
  const result = buildGenerateRequest(input)
  return result.ok ? [] : result.problems.map((p) => p.code)
}

function modifiers(input: GenerateInput): string[] {
  return req(input).spec.generation?.modifiers ?? []
}

describe('the default engine', () => {
  it('is Zetta N2.5', () => {
    expect(req({ imageUrl: IMG }).model).toBe('n25')
  })

  it('refuses a retired engine by name, before anything is charged', () => {
    for (const engine of ['n1', 'n2']) {
      const result = buildGenerateRequest({ engine: engine as never, imageUrl: IMG })
      expect(!result.ok && result.problems.map((p) => p.code)).toEqual(['ENGINE_RETIRED'])
      expect(!result.ok && result.problems[0]?.message).toMatch(/has been retired\. Use Zetta N2\.5 or Np1\./)
    }
  })
})

describe('quality and output resolve to one priced base', () => {
  it.each([
    ['high', 'textured', 'textured'],
    ['high', 'geometry', 'geometry_only'],
    ['ultra', 'textured', 'textured'],
    ['ultra', 'geometry', 'geometry_only'],
    ['lowpoly', 'textured', 'lowpoly'],
    ['lowpoly', 'geometry', 'lowpoly'],
  ] as const)('quality %s + output %s → %s', (quality, output, base) => {
    expect(req({ imageUrl: IMG, quality, output }).spec.generation?.base).toBe(base)
  })

  it('tells Ultra from High by the paid level and the count', () => {
    const at = (quality: 'ultra' | 'high') => req({ imageUrl: IMG, quality, pbr: false })
    expect(at('ultra').spec.generation?.modifiers).toEqual(['detailed_geometry'])
    expect(at('high').spec.generation?.modifiers).toEqual([])
    expect(at('ultra').faceCount).toBe(2_000_000)
    expect(at('high').faceCount).toBe(1_000_000)
  })

  it('makes an untextured low-poly mesh at the low-poly price', () => {
    const request = req({ imageUrl: IMG, quality: 'lowpoly', output: 'geometry' })
    expect(request.spec.generation?.base).toBe('lowpoly')
    expect(request.generationType).toBe('Geometry')
    expect(request.spec.generation?.modifiers).not.toContain('pbr')
  })

  it('leaves the textured low-poly mode unnamed', () => {
    expect(req({ imageUrl: IMG, quality: 'lowpoly' })).not.toHaveProperty('generationType')
  })
})

describe('PBR', () => {
  it('is on by default for a textured output', () => {
    expect(modifiers({ imageUrl: IMG })).toEqual(['pbr'])
  })

  it('is dropped on a geometry output when left at its default', () => {
    expect(modifiers({ imageUrl: IMG, output: 'geometry' })).toEqual([])
  })

  it('is refused when asked for explicitly on a geometry output', () => {
    expect(codes({ imageUrl: IMG, output: 'geometry', pbr: true })).toEqual(['PBR_NEEDS_TEXTURE'])
  })

  it('can be turned off', () => {
    expect(modifiers({ imageUrl: IMG, pbr: false })).toEqual([])
  })
})

describe('the documented shape', () => {
  it('builds a plain image request the way the Studio opens', () => {
    expect(req({ imageUrl: IMG, pbr: false })).toEqual({
      spec: { generation: { base: 'textured', modifiers: [] } },
      imageUrl: IMG,
      faceCount: 1_000_000,
      polygonType: 'triangle',
      textureAlignment: 'geometry',
      model: 'n25',
      origin: 'cli',
    })
  })

  it('sends nothing the server does not accept', () => {
    const keys = Object.keys(req({ imageUrl: IMG, advanceControl: true }))
    expect(keys.sort()).toEqual([
      'advanceControl',
      'faceCount',
      'imageUrl',
      'model',
      'origin',
      'polygonType',
      'spec',
      'textureAlignment',
    ])
  })

  it('returns the matching quote spec', () => {
    expect(ok({ imageUrl: IMG }).quote).toEqual({
      generation: { base: 'textured', modifiers: ['pbr'] },
      model: 'n25',
    })
  })

  it('lets the caller name the origin, and says cli otherwise', () => {
    expect(req({ imageUrl: IMG }).origin).toBe('cli')
    expect(req({ imageUrl: IMG, origin: 'mcp' }).origin).toBe('mcp')
    expect(codes({ imageUrl: IMG, origin: 'x'.repeat(65) })).toEqual(['ORIGIN_TOO_LONG'])
  })
})

describe('availability, title and tags', () => {
  it('omits availability until somebody chooses one', () => {
    expect(req({ imageUrl: IMG })).not.toHaveProperty('availability')
  })

  it('sends the choice either way', () => {
    expect(req({ imageUrl: IMG, availability: 'private' }).availability).toBe('private')
    expect(req({ imageUrl: IMG, availability: 'public' }).availability).toBe('public')
  })

  it('omits a blank title and trims a real one', () => {
    expect(req({ imageUrl: IMG, title: '   ' })).not.toHaveProperty('title')
    expect(req({ imageUrl: IMG, title: '  Robot  ' }).title).toBe('Robot')
    expect(codes({ imageUrl: IMG, title: 'x'.repeat(256) })).toEqual(['TITLE_TOO_LONG'])
  })

  it('sends tags within the server limits', () => {
    expect(req({ imageUrl: IMG, tags: ['a', ' b '] }).tags).toEqual(['a', 'b'])
    expect(codes({ imageUrl: IMG, tags: Array.from({ length: 21 }, (_, i) => `t${i}`) })).toEqual(['TOO_MANY_TAGS'])
    expect(codes({ imageUrl: IMG, tags: ['x'.repeat(65)] })).toEqual(['TAG_TOO_LONG'])
  })

  it('maps advanceControl through only when asked', () => {
    expect(req({ imageUrl: IMG, advanceControl: true }).advanceControl).toBe(true)
    expect(req({ imageUrl: IMG })).not.toHaveProperty('advanceControl')
  })
})

describe('exactly one input mode', () => {
  it('rejects a prompt and an image together', () => {
    expect(codes({ imageUrl: IMG, prompt: 'a chair' })).toEqual(['PROMPT_AND_IMAGE'])
  })

  it('rejects neither', () => {
    expect(codes({})).toEqual(['NO_INPUT'])
    expect(codes({ prompt: '   ' })).toEqual(['NO_INPUT'])
  })

  /* The Studio always makes the picture first; the server draws one itself for a bare prompt. */
  it('accepts a bare prompt on every engine, warning that the server draws the picture unseen', () => {
    for (const engine of GENERATE_ENGINE_IDS) {
      const result = ok({ engine, prompt: 'a weathered helmet' })
      expect(result.request.prompt).toBe('a weathered helmet')
      expect(result.request).not.toHaveProperty('imageUrl')
      expect(result.warnings.join(' ')).toMatch(/draws one from the prompt first/)
    }
  })

  it('refuses a prompt over 1,024 characters', () => {
    expect(codes({ prompt: 'x'.repeat(1025) })).toEqual(['PROMPT_TOO_LONG'])
  })
})

describe('an image generated from the prompt', () => {
  it('sends the prompt, the image and the provenance', () => {
    expect(req({ imageUrl: IMG, prompt: 'a brass dragon', imageFromPrompt: true })).toMatchObject({
      imageUrl: IMG,
      prompt: 'a brass dragon',
      imageFromPrompt: true,
    })
  })

  it('works the same on the Smart engines', () => {
    expect(req({ engine: 'np15', imageUrl: IMG, prompt: 'a brass dragon', imageFromPrompt: true })).toMatchObject({
      imageFromPrompt: true,
      model: 'np15',
    })
  })

  it('is dropped, with a warning, when there is no image to have produced', () => {
    const result = ok({ prompt: 'a brass dragon', imageFromPrompt: true })
    expect(result.request).not.toHaveProperty('imageFromPrompt')
    expect(result.request.prompt).toBe('a brass dragon')
    expect(result.warnings.join(' ')).toMatch(/imageFromPrompt was ignored/)
  })

  it('is dropped for an ordinary image job', () => {
    const request = req({ imageUrl: IMG, imageFromPrompt: true })
    expect(request).not.toHaveProperty('imageFromPrompt')
    expect(request).not.toHaveProperty('prompt')
  })
})

describe('the image address', () => {
  it('requires a scheme', () => {
    expect(codes({ imageUrl: 'cdn.example.com/chair.png' })).toEqual(['INVALID_URL'])
  })

  it('accepts http as well as https, and trims', () => {
    expect(req({ imageUrl: 'http://example.com/a.png' }).imageUrl).toBe('http://example.com/a.png')
    expect(req({ imageUrl: '  https://example.com/a.png  ' }).imageUrl).toBe('https://example.com/a.png')
  })

  it('rejects an address past 2,048 characters', () => {
    expect(codes({ imageUrl: `https://example.com/${'a'.repeat(2100)}.png` })).toEqual(['URL_TOO_LONG'])
  })
})

describe('the Ultra rung', () => {
  it('is a paid modifier', () => {
    expect(modifiers({ imageUrl: IMG, quality: 'ultra' })).toContain('detailed_geometry')
  })

  it('is absent on the other rungs', () => {
    for (const quality of ['high', 'lowpoly'] as const) {
      expect(modifiers({ imageUrl: IMG, quality })).not.toContain('detailed_geometry')
    }
  })

  it('fills the rung’s maximum and does not bill for it', () => {
    for (const [quality, expected] of [
      ['lowpoly', 20_000],
      ['high', 1_000_000],
      ['ultra', 2_000_000],
    ] as const) {
      const request = req({ imageUrl: IMG, quality })
      expect(request.faceCount).toBe(expected)
      expect(request.spec.generation?.modifiers).not.toContain('custom_face_count')
    }
  })

  it('fills the quad maximum when quads are asked for', () => {
    for (const [quality, expected] of [
      ['lowpoly', 10_000],
      ['high', 150_000],
      ['ultra', 150_000],
    ] as const) {
      const request = req({ imageUrl: IMG, quality, polygonType: 'quad' })
      expect(request.faceCount).toBe(expected)
      expect(request.polygonType).toBe('quadrilateral')
      expect(request.spec.generation?.modifiers).not.toContain('custom_face_count')
    }
  })

  it('keeps the rung when a count is typed, and bills the custom count', () => {
    const request = req({ imageUrl: IMG, quality: 'ultra', faceCount: 500_000 })
    expect(request.spec.generation?.modifiers).toEqual(['pbr', 'detailed_geometry', 'custom_face_count'])
    expect(request.faceCount).toBe(500_000)
  })

  it('refuses a count outside the rung’s range', () => {
    const result = buildGenerateRequest({ imageUrl: IMG, quality: 'lowpoly', faceCount: 200_000 })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.problems[0]?.message).toMatch(/between 1,000 and 20,000/)
  })

  it('allows two million on Ultra', () => {
    expect(req({ imageUrl: IMG, quality: 'ultra', faceCount: 2_000_000 }).faceCount).toBe(2_000_000)
  })
})

describe('the topology', () => {
  it('travels at any rung on N2.5, triangles included', () => {
    expect(req({ imageUrl: IMG, polygonType: 'quad' }).polygonType).toBe('quadrilateral')
    expect(req({ imageUrl: IMG, quality: 'lowpoly', polygonType: 'quad' }).polygonType).toBe('quadrilateral')
    expect(req({ imageUrl: IMG }).polygonType).toBe('triangle')
  })

  it('travels on Np1.5, which builds quads natively', () => {
    expect(req({ engine: 'np15', imageUrl: IMG, polygonType: 'quad' }).polygonType).toBe('quadrilateral')
    expect(req({ engine: 'np15', imageUrl: IMG }).polygonType).toBe('triangle')
  })

  it('refuses quads on Np1, which has none, and sends no topology there', () => {
    expect(codes({ engine: 'np1', imageUrl: IMG, polygonType: 'quad' })).toEqual(['QUADS_NOT_SUPPORTED'])
    expect(req({ engine: 'np1', imageUrl: IMG })).not.toHaveProperty('polygonType')
  })

  it('bounds quads by the rung: 500–10,000 on low-poly, up to 150,000 above it', () => {
    expect(codes({ imageUrl: IMG, quality: 'lowpoly', polygonType: 'quad', faceCount: 500 })).toEqual([])
    expect(codes({ imageUrl: IMG, quality: 'lowpoly', polygonType: 'quad', faceCount: 499 })).toEqual(['FACE_COUNT_OUT_OF_RANGE'])
    expect(codes({ imageUrl: IMG, quality: 'lowpoly', polygonType: 'quad', faceCount: 10_001 })).toEqual(['FACE_COUNT_OUT_OF_RANGE'])
    expect(codes({ imageUrl: IMG, polygonType: 'quad', faceCount: 150_000 })).toEqual([])
    expect(codes({ imageUrl: IMG, polygonType: 'quad', faceCount: 150_001 })).toEqual(['FACE_COUNT_OUT_OF_RANGE'])
  })
})

describe('the polygon count', () => {
  it('is billed once it differs from the rung’s default', () => {
    const request = req({ imageUrl: IMG, quality: 'high', faceCount: 250_000, pbr: false })
    expect(request.faceCount).toBe(250_000)
    expect(request.spec.generation?.modifiers).toEqual(['custom_face_count'])
  })

  it.each([
    ['lowpoly', 20_000],
    ['high', 1_000_000],
    ['ultra', 2_000_000],
  ] as const)('sends %s’s own default without billing it', (quality, count) => {
    expect(req({ imageUrl: IMG, quality, pbr: false }).faceCount).toBe(count)
    // Typing the default by hand is not a custom count either.
    expect(req({ imageUrl: IMG, quality, faceCount: count, pbr: false }).spec.generation?.modifiers).not.toContain(
      'custom_face_count',
    )
  })

  it.each([999, 1_000_001])('rejects %d on High', (faceCount) => {
    expect(codes({ imageUrl: IMG, quality: 'high', faceCount })).toEqual(['FACE_COUNT_OUT_OF_RANGE'])
  })

  it.each([1_000, 1_000_000])('accepts %d on High', (faceCount) => {
    expect(codes({ imageUrl: IMG, quality: 'high', faceCount })).toEqual([])
  })

  it('never moves the rung: a low count on High stays High, and is billed', () => {
    const request = req({ imageUrl: IMG, faceCount: 9_000, pbr: false })
    expect(request.spec.generation).toEqual({ base: 'textured', modifiers: ['custom_face_count'] })
  })

  it('rejects a count that is not a whole number', () => {
    expect(codes({ imageUrl: IMG, faceCount: 50_000.5 })).toEqual(['FACE_COUNT_NOT_WHOLE'])
  })

  it('reports every problem it finds', () => {
    expect(codes({ faceCount: 10 })).toEqual(['FACE_COUNT_OUT_OF_RANGE', 'NO_INPUT'])
  })
})

describe('the texture quality', () => {
  it('bills nothing on standard', () => {
    expect(modifiers({ imageUrl: IMG })).not.toContain('detailed_texture')
  })

  it('bills the detailed band on every engine', () => {
    for (const engine of GENERATE_ENGINE_IDS) {
      expect(modifiers({ engine, imageUrl: IMG, textureQuality: 'detailed' })).toContain('detailed_texture')
    }
  })

  it('is refused on a geometry output', () => {
    expect(codes({ imageUrl: IMG, output: 'geometry', textureQuality: 'detailed' })).toEqual([
      'TEXTURE_QUALITY_NEEDS_TEXTURE',
    ])
  })

  it('refuses extreme on N2.5, which has no 8K tier', () => {
    expect(codes({ imageUrl: IMG, textureQuality: 'extreme' })).toEqual(['TEXTURE_QUALITY_NOT_SUPPORTED'])
  })

  it('stacks with the Ultra rung', () => {
    const list = modifiers({ imageUrl: IMG, quality: 'ultra', textureQuality: 'detailed' })
    expect(list).toContain('detailed_geometry')
    expect(list).toContain('detailed_texture')
  })

  it('bills extreme alone on the Np line, never beside HD', () => {
    for (const engine of ['np1', 'np15'] as const) {
      const list = modifiers({ engine, imageUrl: IMG, textureQuality: 'extreme' })
      expect(list).toContain('extreme_texture')
      expect(list).not.toContain('detailed_texture')
    }
  })

  it('reads the older 8k spelling as extreme', () => {
    expect(modifiers({ engine: 'np1', imageUrl: IMG, textureQuality: '8k' })).toContain('extreme_texture')
  })

  it('refuses a value it does not offer', () => {
    expect(codes({ imageUrl: IMG, textureQuality: 'ultra' as never })).toEqual(['INVALID_OPTION'])
  })
})

describe('the tuning options', () => {
  it('travel when turned on', () => {
    expect(
      req({ imageUrl: IMG, autoSize: true, autofixImage: true, compressGeometry: true, delight: true, textureAlignment: 'geometry' }),
    ).toMatchObject({ autoSize: true, autofixImage: true, compressGeometry: true, delight: true, textureAlignment: 'geometry' })
  })

  it('travel on the Smart engines too', () => {
    expect(req({ engine: 'np1', imageUrl: IMG, autoSize: true, delight: true, exportUv: false })).toMatchObject({
      autoSize: true,
      delight: true,
      exportUv: false,
    })
  })

  it('send the Studio’s fit-to-mesh alignment by default, and nothing else', () => {
    for (const engine of GENERATE_ENGINE_IDS) {
      const request = req({ engine, imageUrl: IMG })
      expect(request.textureAlignment).toBe('geometry')
      for (const key of ['autoSize', 'autofixImage', 'compressGeometry', 'delight', 'exportUv', 'textureFast']) {
        expect(request).not.toHaveProperty(key)
      }
    }
  })

  it('omit the alignment when it is the engine’s own default', () => {
    expect(req({ imageUrl: IMG, textureAlignment: 'original_image' })).not.toHaveProperty('textureAlignment')
  })

  it('send seeds as whole numbers', () => {
    expect(req({ imageUrl: IMG, modelSeed: 7, textureSeed: 8 })).toMatchObject({ modelSeed: 7, textureSeed: 8 })
    expect(codes({ imageUrl: IMG, modelSeed: 1.5 })).toEqual(['SEED_NOT_WHOLE'])
  })

  it('send the fast texture setting, and warn that it does nothing on a paid tier', () => {
    expect(req({ imageUrl: IMG, textureFast: true }).textureFast).toBe(true)
    const result = ok({ imageUrl: IMG, textureFast: true, textureQuality: 'detailed' })
    expect(result.warnings.join(' ')).toMatch(/textureFast/)
  })
})

describe('the UV map field, which is inverted', () => {
  it('sends nothing while on', () => {
    expect(req({ imageUrl: IMG, exportUv: true })).not.toHaveProperty('exportUv')
  })

  it('sends false only when turned off', () => {
    expect(req({ imageUrl: IMG, exportUv: false }).exportUv).toBe(false)
  })
})

describe('a mesh in parts', () => {
  it('forces a bare mesh in triangles', () => {
    const result = ok({ imageUrl: IMG, parts: true })
    expect(result.request.spec.generation).toEqual({ base: 'geometry_only', modifiers: ['generate_parts'] })
    expect(result.request.polygonType).toBe('triangle')
    expect(result.warnings.join(' ')).toMatch(/untextured/)
  })

  it('works at Ultra', () => {
    expect(modifiers({ imageUrl: IMG, parts: true, quality: 'ultra' })).toEqual(['detailed_geometry', 'generate_parts'])
  })

  it.each([
    [{ output: 'textured' as const }, 'PARTS_NEED_GEOMETRY'],
    [{ polygonType: 'quad' as const }, 'PARTS_NEED_TRIANGLES'],
    [{ quality: 'lowpoly' as const }, 'PARTS_NOT_AT_LOWPOLY'],
  ])('refuses %o', (extra, code) => {
    expect(codes({ imageUrl: IMG, parts: true, ...extra })).toContain(code)
  })

  it('is refused on the Smart engines', () => {
    expect(codes({ engine: 'np1', imageUrl: IMG, parts: true })).toContain('PARTS_NOT_SUPPORTED')
    expect(codes({ engine: 'np15', imageUrl: IMG, parts: true })).toContain('PARTS_NOT_SUPPORTED')
  })
})

describe('the Np line', () => {
  it('bounds the budget to its own range', () => {
    expect(faceCountRange('np1')).toEqual({ min: 48, max: 20_000 })
    expect(faceCountRange('np1', 'high', 'quad')).toEqual({ min: 48, max: 20_000 })
    expect(faceCountRange('np15', 'high', 'triangle')).toEqual({ min: 48, max: 50_000 })
    expect(faceCountRange('np15', 'high', 'quad')).toEqual({ min: 48, max: 25_000 })
    expect(faceCountRange('n25', 'lowpoly')).toEqual({ min: 1_000, max: 20_000 })
    expect(faceCountRange('n25', 'lowpoly', 'quad')).toEqual({ min: 500, max: 10_000 })
  })

  it('opens the count at the ceiling, inside the quad range for quads', () => {
    expect(defaultFaceCount('np1')).toBe(20_000)
    expect(defaultFaceCount('np15', 'high', 'quad')).toBe(25_000)
    expect(defaultFaceCount('np15', 'high', 'triangle')).toBe(50_000)
    expect(req({ engine: 'np15', imageUrl: IMG, polygonType: 'quad' }).faceCount).toBe(25_000)
    expect(req({ engine: 'np1', imageUrl: IMG }).faceCount).toBe(20_000)
  })

  it('takes 48 polygons and no fewer', () => {
    expect(codes({ engine: 'np1', imageUrl: IMG, faceCount: 48 })).toEqual([])
    expect(codes({ engine: 'np1', imageUrl: IMG, faceCount: 47 })).toEqual(['FACE_COUNT_OUT_OF_RANGE'])
    expect(codes({ engine: 'np1', imageUrl: IMG, faceCount: 20_001 })).toEqual(['FACE_COUNT_OUT_OF_RANGE'])
  })

  it('refuses a quad count over the halved ceiling', () => {
    expect(codes({ engine: 'np15', imageUrl: IMG, polygonType: 'quad', faceCount: 40_000 })).toEqual([
      'FACE_COUNT_OUT_OF_RANGE',
    ])
    expect(codes({ engine: 'np15', imageUrl: IMG, polygonType: 'triangle', faceCount: 40_000 })).toEqual([])
  })

  it('has no quality levels', () => {
    expect(codes({ engine: 'np1', imageUrl: IMG, quality: 'lowpoly' })).toEqual(['QUALITY_NOT_SUPPORTED'])
    expect(codes({ engine: 'np15', imageUrl: IMG, quality: 'ultra' })).toEqual(['QUALITY_NOT_SUPPORTED'])
    expect(modifiers({ engine: 'np1', imageUrl: IMG, quality: 'high' })).not.toContain('detailed_geometry')
  })

  it('offers both outputs, and PBR on the textured one', () => {
    expect(req({ engine: 'np1', imageUrl: IMG, output: 'geometry' }).spec.generation).toEqual({
      base: 'geometry_only',
      modifiers: [],
    })
    expect(req({ engine: 'np1', imageUrl: IMG }).spec.generation).toEqual({ base: 'textured', modifiers: ['pbr'] })
  })
})

describe('multi-view', () => {
  const views = { front: 'https://cdn.example.com/front.png', left: 'https://cdn.example.com/left.png' }

  it('carries the multi_view modifier and the views, front last', () => {
    const request = req({ views: { ...views, back: 'https://cdn.example.com/back.png' }, pbr: false })
    expect(request.spec.generation?.modifiers).toEqual(['multi_view'])
    expect(request.multiViewImages).toEqual([
      { viewType: 'left', imageUrl: views.left },
      { viewType: 'back', imageUrl: 'https://cdn.example.com/back.png' },
      { viewType: 'front', imageUrl: views.front },
    ])
    expect(request).not.toHaveProperty('imageUrl')
    expect(request).not.toHaveProperty('prompt')
  })

  it('refuses a prompt or a separate image beside views', () => {
    expect(codes({ views, prompt: 'a leftover sentence' })).toEqual(['PROMPT_WITH_VIEWS'])
    expect(codes({ views, imageUrl: IMG })).toEqual(['IMAGE_WITH_VIEWS'])
  })

  it('omits advanceControl unless asked', () => {
    expect(req({ views })).not.toHaveProperty('advanceControl')
  })

  it('refuses a view address with no scheme', () => {
    expect(codes({ views: { front: 'cdn.example.com/front.png', left: views.left } })).toEqual(['INVALID_URL'])
  })

  it('still reports a bad polygon count', () => {
    expect(codes({ views, faceCount: 12 })).toEqual(['FACE_COUNT_OUT_OF_RANGE'])
  })

  it('needs the front view and two views on every engine, and takes the four sides only', () => {
    for (const engine of GENERATE_ENGINE_IDS) {
      expect(codes({ engine, views: { left: views.left, back: views.left } })).toEqual(['FRONT_VIEW_REQUIRED'])
      expect(codes({ engine, views: { front: views.front } })).toEqual(['TOO_FEW_VIEWS'])
      expect(codes({ engine, views: { ...views, top: views.left } })).toEqual(['VIEW_NOT_SUPPORTED'])
    }
  })

  it('forwards quads, the untextured low-poly mode and the tuning options, as on one image', () => {
    expect(req({ views, polygonType: 'quad' })).toMatchObject({ polygonType: 'quadrilateral' })
    expect(req({ views, quality: 'lowpoly', output: 'geometry' }).generationType).toBe('Geometry')
    expect(req({ views, autoSize: true, autofixImage: true })).toMatchObject({ autoSize: true, autofixImage: true })
  })

  it('works on the Smart engines', () => {
    const request = req({ engine: 'np1', views, textureQuality: 'extreme' })
    expect(request.spec.generation?.modifiers).toEqual(['multi_view', 'pbr', 'extreme_texture'])
  })

  it('refuses a slot that is not a view', () => {
    expect(codes({ views: { front: IMG, left: IMG, sideways: IMG } as never })).toEqual(['INVALID_VIEW'])
  })
})

describe('a plan that cannot choose a polygon count', () => {
  it('sends no count and bills no custom count', () => {
    const result = ok({ imageUrl: IMG, allowsCustomFaceCount: false })
    expect(result.request).not.toHaveProperty('faceCount')
    expect(result.request.spec.generation?.modifiers).not.toContain('custom_face_count')
    expect(result.warnings.join(' ')).toMatch(/cannot choose a polygon count/)
  })

  it('refuses a count asked for explicitly', () => {
    expect(codes({ imageUrl: IMG, faceCount: 250_000, allowsCustomFaceCount: false })).toEqual([
      'CUSTOM_FACE_COUNT_NOT_AVAILABLE',
    ])
  })

  it('leaves a paying plan alone', () => {
    const request = req({ imageUrl: IMG, faceCount: 250_000, allowsCustomFaceCount: true })
    expect(request.faceCount).toBe(250_000)
    expect(request.spec.generation?.modifiers).toContain('custom_face_count')
  })
})

describe('engines', () => {
  it('refuses engines that do not generate meshes, and names it', () => {
    expect(codes({ engine: 'r1' as never, imageUrl: IMG })).toEqual(['ENGINE_NOT_FOR_GENERATION'])
    expect(codes({ engine: 'zs2' as never, imageUrl: IMG })).toEqual(['ENGINE_NOT_FOR_GENERATION'])
    expect(codes({ engine: 'n3' as never, imageUrl: IMG })).toEqual(['INVALID_OPTION'])
  })

  it('lists the three generation engines under our own names, all on paid plans', () => {
    expect(Object.keys(ENGINES)).toEqual([...GENERATE_ENGINE_IDS])
    expect([...GENERATE_ENGINE_IDS]).toEqual(['n25', 'np1', 'np15'])
    for (const engine of Object.values(ENGINES)) {
      expect(engine.label).toMatch(/^Zetta Np?[\d.]+$/)
      expect(engine.description).toBeTruthy()
      expect(engine.paidOnly).toBe(true)
    }
    expect(ENGINES.n25.tab).toBe('generate')
    expect(ENGINES.np1.tab).toBe('smart')
    expect(ENGINES.np15.tab).toBe('smart')
  })

  it('states each engine’s surface', () => {
    expect(ENGINES.n25.inputs.prompt).toBe(true)
    expect(ENGINES.n25.inputs.viewSlots).toEqual(['front', 'back', 'left', 'right'])
    expect(ENGINES.n25.qualities).toEqual(['lowpoly', 'high', 'ultra'])
    expect(ENGINES.np1.qualities).toEqual([])
    expect(ENGINES.np1.polygonTypes).toEqual(['triangle'])
    expect(ENGINES.np15.polygonTypes).toEqual(['triangle', 'quad'])
    expect(ENGINES.n25.polygonTypes).toEqual(['triangle', 'quad'])
    expect(ENGINES.n25.textureQualities).toEqual(['standard', 'detailed'])
    expect(ENGINES.np1.textureQualities).toEqual(['standard', 'detailed', 'extreme'])
    expect(ENGINES.n25.parts && !ENGINES.np15.parts).toBe(true)
    expect(ENGINES.n25.untexturedLowpoly).toBe(true)
    expect(ENGINES.n25.defaults.quality).toBe('high')
    expect(ENGINES.np1.defaults.quality).toBeNull()
    for (const engine of Object.values(ENGINES)) expect(engine.defaults.textureAlignment).toBe('geometry')
  })

  it('opens every face band on a count inside its own range', () => {
    for (const engine of Object.values(ENGINES)) {
      expect(engine.faceCounts.length).toBeGreaterThan(0)
      for (const band of engine.faceCounts) {
        expect(band.default).toBeGreaterThanOrEqual(band.min)
        expect(band.default).toBeLessThanOrEqual(band.max)
      }
    }
    expect(ENGINES.n25.faceCounts).toHaveLength(6)
    expect(ENGINES.np1.faceCounts).toHaveLength(1)
    expect(ENGINES.np15.faceCounts).toHaveLength(2)
  })

  it('says a prompt becomes a picture first on every engine', () => {
    for (const engine of ['n25', 'np1', 'np15']) expect(needsImageForPrompt(engine)).toBe(true)
  })
})
