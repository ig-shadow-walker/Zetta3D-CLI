import { describe, expect, it } from 'vitest'
import { buildGenerateRequest, type GenerateInput } from '../../src/builders/gen3d'

/*
 * Every combination of the Zetta N2.5 options, ported from the Studio's 96-case matrix. Each one
 * either builds a request that keeps the invariants the server enforces, or is refused for one of
 * the reasons a conflicting explicit choice should be.
 */

const QUALITIES = ['lowpoly', 'high', 'ultra'] as const
const OUTPUTS = ['geometry', 'textured'] as const
const TEXTURE_QUALITIES = ['standard', 'detailed'] as const
const POLYGON_TYPES = ['triangle', 'quad'] as const

interface Combination {
  label: string
  input: GenerateInput
}

const COMBINATIONS: Combination[] = []
for (const quality of QUALITIES) {
  for (const output of OUTPUTS) {
    for (const pbr of [false, true]) {
      for (const parts of [false, true]) {
        for (const textureQuality of TEXTURE_QUALITIES) {
          for (const polygonType of POLYGON_TYPES) {
            COMBINATIONS.push({
              label: `${quality}/${output}/pbr=${pbr}/parts=${parts}/tex=${textureQuality}/${polygonType}`,
              input: {
                engine: 'n25',
                imageUrl: 'https://cdn.example.com/uploads/a.png',
                quality,
                output,
                pbr,
                parts,
                textureQuality,
                polygonType,
              },
            })
          }
        }
      }
    }
  }
}

it('covers the whole space', () => {
  expect(COMBINATIONS).toHaveLength(96)
})

const conflicts = (input: GenerateInput): boolean =>
  (input.pbr === true && input.output === 'geometry') ||
  (input.textureQuality === 'detailed' && input.output === 'geometry') ||
  (input.parts === true && (input.quality === 'lowpoly' || input.output === 'textured' || input.polygonType === 'quad'))

const REFUSALS = [
  'PBR_NEEDS_TEXTURE',
  'TEXTURE_QUALITY_NEEDS_TEXTURE',
  'PARTS_NOT_AT_LOWPOLY',
  'PARTS_NEED_GEOMETRY',
  'PARTS_NEED_TRIANGLES',
]

describe.each(COMBINATIONS)('$label', ({ input }) => {
  const built = buildGenerateRequest(input)

  it('builds exactly when no explicit choice conflicts with another', () => {
    expect(built.ok).toBe(!conflicts(input))
    if (!built.ok) for (const p of built.problems) expect(REFUSALS).toContain(p.code)
  })

  it('never pairs parts with a texture or with quads', () => {
    if (!built.ok) return
    const { base, modifiers = [] } = built.request.spec.generation ?? { base: '' }
    if (!modifiers.includes('generate_parts')) return
    expect(base).toBe('geometry_only')
    expect(built.request.polygonType).not.toBe('quadrilateral')
  })

  it('asks for a texture exactly when the output is textured', () => {
    if (!built.ok) return
    const base = built.request.spec.generation?.base
    const untextured = base === 'geometry_only' || (base === 'lowpoly' && built.request.generationType === 'Geometry')
    expect(untextured).toBe(input.output === 'geometry')
  })

  it('bills PBR and the detailed band only where there is a texture', () => {
    if (!built.ok) return
    const { base, modifiers = [] } = built.request.spec.generation ?? { base: '' }
    if (modifiers.includes('pbr') || modifiers.includes('detailed_texture')) expect(base).not.toBe('geometry_only')
  })

  it('quotes exactly what it sends', () => {
    if (!built.ok) return
    expect(built.quote.generation).toEqual(built.request.spec.generation)
    expect(built.quote.model).toBe('n25')
  })
})
