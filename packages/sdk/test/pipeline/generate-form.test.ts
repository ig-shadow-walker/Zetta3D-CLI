import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FORM,
  POLYGON_MAX,
  POLYGON_MIN,
  QUALITY_POLYGONS,
  applyFormPatch,
  buildCreateRequest,
  defaultPolygonCount,
  deriveSpec,
  hasCustomPolygonCount,
  parameterProblems,
  polygonBounds,
  qualityForPolygons,
  type GenerateForm,
} from '../../src/pipeline/generate-form'

/* Parity vectors from the web's `gen3d-request.test.ts` and `gen3d-request.n25-matrix.test.ts`. */

function form(overrides: Partial<GenerateForm> = {}): GenerateForm {
  return {
    quality: 'high-res',
    output: 'textured',
    pbrMaterials: false,
    textureQuality: 'standard',
    exportUv: true,
    segmentParts: false,
    realWorldScale: false,
    textureAlignment: 'original_image',
    delight: false,
    availability: null,
    autofixImage: false,
    compressGeometry: false,
    polygonCount: String(QUALITY_POLYGONS['high-res']),
    polygonType: 'triangle',
    title: '',
    imageFromPrompt: false,
    removeBackground: true,
    controlMode: false,
    model: 'n1',
    imageUrl: 'https://cdn.example.com/chair.png',
    prompt: '',
    ...overrides,
  }
}

function built(overrides: Partial<GenerateForm> = {}) {
  const result = buildCreateRequest(form(overrides))
  if (!result.ok) throw new Error(`expected valid, got: ${result.problems.join('; ')}`)
  return result.input
}

function problems(overrides: Partial<GenerateForm> = {}) {
  const result = buildCreateRequest(form(overrides))
  return result.ok ? [] : result.problems
}

describe('deriveSpec', () => {
  it.each([
    ['high-res', 'textured', 'textured'],
    ['high-res', 'geometry', 'geometry_only'],
    ['ultra', 'textured', 'textured'],
    ['ultra', 'geometry', 'geometry_only'],
    ['low-poly', 'textured', 'lowpoly'],
    ['low-poly', 'geometry', 'lowpoly'],
  ] as const)('quality %s + output %s → %s', (quality, output, base) => {
    expect(deriveSpec(form({ quality, output })).generation.base).toBe(base)
  })

  it('cannot yet tell Ultra from High-Res on N1', () => {
    const at = (quality: 'ultra' | 'high-res') => deriveSpec(form({ quality, polygonCount: String(QUALITY_POLYGONS[quality]) }))
    expect(at('ultra')).toEqual(at('high-res'))
  })

  it('adds PBR on a textured output and drops it on geometry', () => {
    expect(deriveSpec(form({ pbrMaterials: true, output: 'textured' })).generation.modifiers).toEqual(['pbr'])
    expect(deriveSpec(form({ pbrMaterials: true, output: 'geometry' })).generation.modifiers).toEqual([])
  })

  it('bills a custom count only when the count moves off the rung’s own', () => {
    expect(deriveSpec(form({ polygonCount: '50000' })).generation.modifiers).toEqual(['custom_face_count'])
    expect(deriveSpec(form()).generation.modifiers).toEqual([])
    expect(deriveSpec(form({ polygonCount: '' })).generation.modifiers).toEqual([])
    expect(deriveSpec(form({ polygonCount: '  ' })).generation.modifiers).toEqual([])
  })
})

describe('buildCreateRequest', () => {
  it('builds the documented shape for a plain image request', () => {
    expect(built()).toEqual({
      spec: { generation: { base: 'textured', modifiers: [] } },
      imageUrl: 'https://cdn.example.com/chair.png',
      faceCount: 200_000,
      model: 'n1',
      origin: 'studio',
    })
  })

  it('sends nothing the server does not accept', () => {
    expect(Object.keys(built({ pbrMaterials: true, controlMode: true })).sort()).toEqual([
      'advanceControl',
      'faceCount',
      'imageUrl',
      'model',
      'origin',
      'spec',
    ])
  })

  it('never sends removeBackground, and omits availability until chosen', () => {
    expect(JSON.stringify(built({ removeBackground: true }))).not.toMatch(/removeB/i)
    expect(built()).not.toHaveProperty('availability')
    expect(built({ availability: 'private' }).availability).toBe('private')
    expect(built({ availability: 'public' }).availability).toBe('public')
  })

  it('maps Control Mode to advanceControl', () => {
    expect(built({ controlMode: true }).advanceControl).toBe(true)
    expect(built({ controlMode: false })).not.toHaveProperty('advanceControl')
  })

  it('takes exactly one input mode', () => {
    expect(problems({ prompt: 'a chair' })).toContain('Use either a prompt or an image, not both.')
    expect(problems({ imageUrl: '' })).toContain('Attach an image to generate from.')
    expect(problems({ imageUrl: 'cdn.example.com/a.png' })).toContain('The image address must start with http:// or https://')
    expect(problems({ imageUrl: '', prompt: '', polygonCount: '10' })).toHaveLength(2)
  })

  describe('the Ultra rung', () => {
    it('adds the paid modifier on N2.5, and nothing on N1', () => {
      expect(built({ model: 'n25', quality: 'ultra' }).spec.generation.modifiers).toContain('detailed_geometry')
      expect(built({ model: 'n1', quality: 'ultra' }).spec.generation.modifiers).not.toContain('detailed_geometry')
    })

    it('fills the rung’s maximum on N2.5, and does not bill for it', () => {
      for (const [from, quality, expected] of [
        ['high-res', 'low-poly', 20_000],
        ['low-poly', 'high-res', 1_000_000],
        ['high-res', 'ultra', 2_000_000],
      ] as const) {
        const next = applyFormPatch(applyFormPatch(form({ model: 'n25' }), { quality: from }), { quality })
        expect(next.polygonCount).toBe(String(expected))
        expect(hasCustomPolygonCount(next)).toBe(false)
      }
    })

    it('refills to the quad maximum when the topology changes', () => {
      const lowPoly = applyFormPatch(form({ model: 'n25' }), { quality: 'low-poly' })
      const quads = applyFormPatch(lowPoly, { polygonType: 'quadrilateral' })
      expect(quads.polygonCount).toBe('10000')
      expect(hasCustomPolygonCount(quads)).toBe(false)
    })

    it('keeps the rung when a count is typed on N2.5', () => {
      const typed = applyFormPatch(applyFormPatch(form({ model: 'n25' }), { quality: 'ultra' }), { polygonCount: '500000' })
      expect(typed.quality).toBe('ultra')
      expect(hasCustomPolygonCount(typed)).toBe(true)
    })

    it('sends the topology on any rung for N2.5, and only on low-poly for N1', () => {
      expect(built({ model: 'n25', quality: 'high-res', polygonType: 'quadrilateral', polygonCount: '150000' }).polygonType).toBe('quadrilateral')
      expect(built({ model: 'n1', quality: 'high-res', polygonType: 'quadrilateral' }).polygonType).toBeUndefined()
      expect(built({ quality: 'low-poly', polygonType: 'quadrilateral' }).polygonType).toBe('quadrilateral')
    })

    it('refuses a count outside the rung’s range, and allows two million on Ultra', () => {
      expect(problems({ model: 'n25', quality: 'low-poly', polygonCount: '200000' }).join(' ')).toMatch(/between 1,000 and 20,000/)
      expect(built({ model: 'n25', quality: 'ultra', polygonCount: '2000000' }).faceCount).toBe(2_000_000)
    })
  })

  describe('the texture quality band', () => {
    it('is billed on a textured N2.5 job only', () => {
      expect(built({ model: 'n25', textureQuality: 'standard' }).spec.generation.modifiers).not.toContain('detailed_texture')
      expect(built({ model: 'n25', textureQuality: 'detailed' }).spec.generation.modifiers).toContain('detailed_texture')
      expect(built({ model: 'n25', textureQuality: 'detailed', output: 'geometry' }).spec.generation.modifiers).not.toContain('detailed_texture')
      expect(built({ model: 'n1', textureQuality: 'detailed' }).spec.generation.modifiers).not.toContain('detailed_texture')
    })

    it('stacks with the Ultra rung', () => {
      const modifiers = built({ model: 'n25', quality: 'ultra', textureQuality: 'detailed' }).spec.generation.modifiers
      expect(modifiers).toEqual(expect.arrayContaining(['detailed_geometry', 'detailed_texture']))
    })
  })

  describe('the tuning options', () => {
    it('travel on N2.5 when on, and are withheld from N1', () => {
      expect(built({ model: 'n25', realWorldScale: true, autofixImage: true, compressGeometry: true, textureAlignment: 'geometry' })).toMatchObject({
        autoSize: true,
        autofixImage: true,
        compressGeometry: true,
        textureAlignment: 'geometry',
      })
      const off = built({ model: 'n25' })
      for (const key of ['autoSize', 'autofixImage', 'compressGeometry', 'textureAlignment']) expect(off).not.toHaveProperty(key)
      const n1 = built({ model: 'n1', realWorldScale: true, autofixImage: true })
      expect(n1).not.toHaveProperty('autoSize')
      expect(n1).not.toHaveProperty('autofixImage')
    })

    it('sends exportUv only as false, and only where it is taken', () => {
      expect(built({ model: 'n25', exportUv: true })).not.toHaveProperty('exportUv')
      expect(built({ model: 'n25', exportUv: false }).exportUv).toBe(false)
      expect(built({ model: 'n1', exportUv: false })).not.toHaveProperty('exportUv')
    })
  })

  describe('the polygon count', () => {
    it('is sent with its modifier once it differs from the rung default', () => {
      const input = built({ quality: 'high-res', polygonCount: '250000' })
      expect(input.faceCount).toBe(250_000)
      expect(input.spec.generation.modifiers).toEqual(['custom_face_count'])
    })

    it.each(['low-poly', 'high-res', 'ultra'] as const)('sends %s’s own default without paying for it', (quality) => {
      const input = built({ quality, polygonCount: String(QUALITY_POLYGONS[quality]) })
      expect(input.faceCount).toBe(QUALITY_POLYGONS[quality])
      expect(input.spec.generation.modifiers).toEqual([])
    })

    it('sends neither when the field is empty', () => {
      const input = built({ polygonCount: '' })
      expect(input).not.toHaveProperty('faceCount')
      expect(input.spec.generation.modifiers).toEqual([])
    })

    it.each([String(POLYGON_MIN - 1), String(POLYGON_MAX + 1)])('rejects %s', (value) => {
      expect(problems({ polygonCount: value })).toContain('The polygon count must be between 3,100 and 1,480,000.')
    })

    it.each(['50000.5', 'abc', '12,000'])('rejects %p as not a whole number', (value) => {
      expect(problems({ polygonCount: value })).toContain('The polygon count must be a whole number.')
    })

    it('accepts exponent notation as the number it is', () => {
      expect(built({ polygonCount: '1e5' }).faceCount).toBe(100_000)
    })
  })
})

describe('the rung and the count move together', () => {
  it.each([
    ['low-poly', '9000'],
    ['high-res', '200000'],
    ['ultra', '1000000'],
  ] as const)('choosing %s fills in %s', (quality, count) => {
    const next = applyFormPatch(form({ quality: 'high-res' }), { quality })
    expect(next.polygonCount).toBe(count)
    expect(next.quality).toBe(quality)
  })

  it.each([
    ['3100', 'low-poly'],
    ['15000', 'low-poly'],
    ['15001', 'high-res'],
    ['999999', 'high-res'],
    ['1000000', 'ultra'],
    ['1480000', 'ultra'],
  ] as const)('typing %s on N1 moves the rung to %s', (count, quality) => {
    expect(qualityForPolygons(count)).toBe(quality)
    expect(applyFormPatch(form({ quality: 'high-res' }), { polygonCount: count }).quality).toBe(quality)
  })

  it.each(['', '2', '3099', '1480001', 'abc', '9000.5'])('holds the rung still for %p', (count) => {
    const next = applyFormPatch(form({ quality: 'ultra' }), { polygonCount: count })
    expect(next.quality).toBe('ultra')
    expect(next.polygonCount).toBe(count)
  })

  it('counts another rung’s default as custom', () => {
    expect(hasCustomPolygonCount(form({ quality: 'ultra', polygonCount: '200000' }))).toBe(true)
  })
})

describe('N2.5’s dependent controls', () => {
  const reach = (patches: Array<Partial<GenerateForm>>): GenerateForm =>
    patches.reduce<GenerateForm>((current, patch) => applyFormPatch(current, patch), {
      ...DEFAULT_FORM,
      model: 'n25',
      imageUrl: 'https://cdn.example.com/a.png',
    })

  it('keeps a Geometry output on the low-poly rung, at the low-poly price', () => {
    const result = buildCreateRequest(reach([{ output: 'geometry' }, { quality: 'low-poly' }]))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.input.spec.generation.base).toBe('lowpoly')
    expect(result.input.generationType).toBe('Geometry')
    expect(result.input.spec.generation.modifiers).not.toContain('pbr')
  })

  it('moves Output to Textured on N1’s low-poly rung', () => {
    expect(reach([{ model: 'n1' }, { output: 'geometry' }, { quality: 'low-poly' }]).output).toBe('textured')
  })

  it('moves Output to Geometry and quads to triangles when segmenting', () => {
    const next = reach([{ polygonType: 'quadrilateral' }, { segmentParts: true }])
    expect(next.output).toBe('geometry')
    expect(next.polygonType).toBe('triangle')
  })

  it('drops the parts modifier on the low-poly rung', () => {
    const result = buildCreateRequest(reach([{ segmentParts: true }, { quality: 'low-poly' }]))
    expect(result.ok && result.input.spec.generation.modifiers).not.toContain('generate_parts')
  })

  it('builds every one of the 96 combinations, never pairing parts with a texture or quads', () => {
    let count = 0
    for (const quality of ['low-poly', 'high-res', 'ultra'] as const)
      for (const output of ['geometry', 'textured'] as const)
        for (const pbrMaterials of [false, true])
          for (const segmentParts of [false, true])
            for (const textureQuality of ['standard', 'detailed'] as const)
              for (const polygonType of ['triangle', 'quadrilateral'] as const) {
                count++
                const current = reach([{ quality }, { output }, { pbrMaterials }, { textureQuality }, { polygonType }, { segmentParts }])
                const result = buildCreateRequest(current)
                expect(result.ok).toBe(true)
                if (!result.ok) continue
                const { base, modifiers } = result.input.spec.generation
                if (modifiers.includes('generate_parts')) {
                  expect(base).toBe('geometry_only')
                  expect(result.input.polygonType).not.toBe('quadrilateral')
                }
                const untextured = base === 'geometry_only' || (base === 'lowpoly' && result.input.generationType === 'Geometry')
                expect(untextured).toBe(current.output === 'geometry')
              }
    expect(count).toBe(96)
  })
})

describe('a plan that cannot choose a count', () => {
  const plain = { ...DEFAULT_FORM, imageUrl: 'https://cdn.example/a.png' }

  it('never bills the custom count, reports nothing about it and sends none', () => {
    const custom = { ...plain, polygonCount: '250000' }
    expect(hasCustomPolygonCount(custom)).toBe(true)
    expect(hasCustomPolygonCount(custom, false)).toBe(false)
    expect(deriveSpec(custom, false, false).generation.modifiers).not.toContain('custom_face_count')
    expect(parameterProblems({ ...plain, polygonCount: 'not a number' }, false)).toEqual([])
    const result = buildCreateRequest(custom, false)
    expect(result.ok && result.input).not.toHaveProperty('faceCount')
  })
})

describe('the Np1.5 quad ceiling', () => {
  const np15 = { ...DEFAULT_FORM, model: 'np15' as const }

  it('offers 50,000 triangles and 25,000 quads, and fills the field inside them', () => {
    expect(polygonBounds({ ...np15, polygonType: 'triangle' })).toEqual({ min: 48, max: 50_000 })
    expect(polygonBounds({ ...np15, polygonType: 'quadrilateral' })).toEqual({ min: 48, max: 25_000 })
    expect(defaultPolygonCount({ ...np15, polygonType: 'quadrilateral' })).toBe(25_000)
  })

  it('clamps on the engine change, then again when quads are chosen', () => {
    const onNp15 = applyFormPatch({ ...DEFAULT_FORM }, { model: 'np15' })
    expect(Number(onNp15.polygonCount)).toBe(50_000)
    expect(Number(applyFormPatch(onNp15, { polygonType: 'quadrilateral' }).polygonCount)).toBe(25_000)
  })

  it('keeps a typed count across a topology switch and reports it out of range', () => {
    const start = applyFormPatch({ ...DEFAULT_FORM, model: 'np1' }, { model: 'np15' })
    const typed = applyFormPatch(start, { polygonCount: '40000', polygonCountTyped: true })
    const quads = applyFormPatch(typed, { polygonType: 'quadrilateral' })
    expect(quads.polygonCount).toBe('40000')
    expect(parameterProblems(quads)).toEqual(['The polygon count must be between 48 and 25,000.'])
  })

  it('leaves Np1 flat, with no quads', () => {
    expect(polygonBounds({ ...DEFAULT_FORM, model: 'np1', polygonType: 'quadrilateral' })).toEqual({ min: 48, max: 20_000 })
  })
})

describe('robustness', () => {
  it('does not throw on an engine it does not know', () => {
    const unknown = { ...DEFAULT_FORM, model: 'z9' as GenerateForm['model'], imageUrl: 'https://cdn.example/a.png' }
    expect(() => applyFormPatch(unknown, { quality: 'ultra' })).not.toThrow()
    expect(() => buildCreateRequest(unknown)).not.toThrow()
  })
})
