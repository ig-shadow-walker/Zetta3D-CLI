import { describe, expect, it } from 'vitest'
import {
  SPLAT_ASPECT_RATIOS,
  SPLAT_EARLY_ACCESS_NOTE,
  SPLAT_ENGINES,
  SPLAT_RESOLUTIONS,
  buildSplatRequest,
  buildWorldExportRequest,
  defaultSplatSubject,
  maxWorldPictures,
  splatOffersCutOut,
  splatPictureProblems,
  type SplatInput,
  type WorldExportInput,
} from '../../src/builders/splat'
import { imageForPromptRequest } from '../../src/builders/prompts'

const IMG = 'https://cdn.example.com/room.png'
const VIDEO = 'https://cdn.example.com/walk.mp4'
const view = (azimuth: number | null, n = azimuth ?? 0) => ({ azimuth, imageUrl: `https://cdn.example.com/v${n}.png` })

function ok(input: SplatInput) {
  const result = buildSplatRequest(input)
  if (!result.ok) throw new Error(`expected valid, got: ${result.problems.map((p) => p.message).join('; ')}`)
  return result
}

function codes(input: SplatInput): string[] {
  const result = buildSplatRequest(input)
  return result.ok ? [] : result.problems.map((p) => p.code)
}

describe('a splat from one picture', () => {
  it('sends the fixed spec, the picture and the engine', () => {
    const result = ok({ imageUrl: IMG })
    expect(result.request).toEqual({
      spec: { generation: { base: 'gaussian_splat', modifiers: [] } },
      imageUrl: IMG,
      model: 'n25',
      origin: 'cli',
    })
    expect(result.quote).toEqual({ generation: { base: 'gaussian_splat', modifiers: [] }, model: 'n25' })
  })

  it('carries the early-access note', () => {
    expect(ok({ imageUrl: IMG }).warnings).toContain(SPLAT_EARLY_ACCESS_NOTE)
  })

  it('needs exactly one picture or, on a world engine, one video', () => {
    expect(codes({})).toEqual(['IMAGE_OR_VIDEO'])
    expect(codes({ engine: 'zs2', imageUrl: IMG, videoUrl: VIDEO })).toEqual(['IMAGE_OR_VIDEO'])
    expect(codes({ videoUrl: VIDEO })).toEqual(['VIDEO_NOT_SUPPORTED'])
    expect(ok({ engine: 'zs21', videoUrl: VIDEO }).request).toMatchObject({ videoUrl: VIDEO, model: 'zs21' })
  })

  it('sends a prompt on Zetta Splat only as the sentence the picture came from', () => {
    expect(ok({ imageUrl: IMG, prompt: 'a red chair', imageFromPrompt: true }).request).toMatchObject({
      prompt: 'a red chair',
      imageFromPrompt: true,
    })
    expect(codes({ imageUrl: IMG, prompt: 'a red chair' })).toEqual(['PROMPT_AND_IMAGE'])
    expect(codes({ prompt: 'a red chair' })).toEqual(['IMAGE_OR_VIDEO', 'PROMPT_NEEDS_IMAGE'])
  })

  it('reads a prompt on the world engines as a description of the scene', () => {
    const request = ok({ engine: 'zs2', imageUrl: IMG, prompt: 'a misty forest' }).request
    expect(request.prompt).toBe('a misty forest')
    expect(request).not.toHaveProperty('imageFromPrompt')
    expect(ok({ engine: 'zs2', videoUrl: VIDEO, prompt: 'a beach' }).request).toMatchObject({ videoUrl: VIDEO, prompt: 'a beach' })
  })

  it('takes a seed on Zetta Splat only', () => {
    expect(ok({ imageUrl: IMG, seed: 3 }).request.modelSeed).toBe(3)
    expect(codes({ engine: 'zs2', imageUrl: IMG, seed: 3 })).toEqual(['SEED_NOT_SUPPORTED'])
    expect(codes({ imageUrl: IMG, seed: 2.5 })).toEqual(['SEED_NOT_WHOLE'])
  })

  it('refuses an engine that does not make splats', () => {
    expect(codes({ engine: 'n1' as never, imageUrl: IMG })).toEqual(['INVALID_OPTION'])
  })

  it('cuts out only an object on Zetta Splat', () => {
    expect(splatOffersCutOut('n25', 'object')).toBe(true)
    expect(splatOffersCutOut('n25', 'environment')).toBe(false)
    expect(splatOffersCutOut('zs2', 'object')).toBe(false)
  })

  it('lists the three engines under our own names', () => {
    expect(Object.values(SPLAT_ENGINES).map((e) => e.label)).toEqual(['Zetta Splat', 'Zetta Splat 2', 'Zetta Splat 2.1'])
  })
})

describe('a world from several directions', () => {
  it('sends each picture with the way it faces', () => {
    const request = ok({ engine: 'zs2', imageUrl: IMG, worldViews: [view(90), view(180), view(270)] }).request
    expect(request.worldViews).toEqual([view(90), view(180), view(270)])
    expect(request).not.toHaveProperty('reconstructImages')
  })

  it('leaves a direction out when it is unknown', () => {
    expect(ok({ engine: 'zs2', imageUrl: IMG, worldViews: [view(null, 1), view(null, 2)] }).request.worldViews).toEqual([
      { imageUrl: 'https://cdn.example.com/v1.png' },
      { imageUrl: 'https://cdn.example.com/v2.png' },
    ])
  })

  it('takes four pictures, or eight as pictures of the same space', () => {
    expect(maxWorldPictures(false)).toBe(4)
    expect(maxWorldPictures(true)).toBe(8)
    const four = [view(45), view(90), view(180), view(270)]
    expect(codes({ engine: 'zs2', imageUrl: IMG, worldViews: four })).toEqual(['TOO_MANY_PICTURES'])
    expect(ok({ engine: 'zs2', imageUrl: IMG, worldViews: four, reconstructImages: true }).request.reconstructImages).toBe(true)
    const eight = [10, 20, 30, 40, 50, 60, 70, 80].map((a) => view(a))
    expect(codes({ engine: 'zs2', imageUrl: IMG, worldViews: eight, reconstructImages: true })).toEqual(['TOO_MANY_PICTURES'])
  })

  it('refuses a direction outside 1–359, and two facing the same way', () => {
    expect(codes({ engine: 'zs2', imageUrl: IMG, worldViews: [view(0)] })).toEqual(['INVALID_AZIMUTH'])
    expect(codes({ engine: 'zs2', imageUrl: IMG, worldViews: [view(360)] })).toEqual(['INVALID_AZIMUTH'])
    expect(codes({ engine: 'zs2', imageUrl: IMG, worldViews: [view(45.5)] })).toEqual(['INVALID_AZIMUTH'])
    expect(codes({ engine: 'zs2', imageUrl: IMG, worldViews: [view(90, 1), view(90, 2)] })).toEqual(['SAME_DIRECTION'])
  })

  it('needs a world engine and a forward picture, not a video', () => {
    expect(codes({ imageUrl: IMG, worldViews: [view(90)] })).toEqual(['WORLD_VIEWS_NOT_SUPPORTED'])
    expect(codes({ engine: 'zs2', videoUrl: VIDEO, worldViews: [view(90)] })).toEqual(['WORLD_VIEWS_NEED_IMAGE'])
    expect(codes({ engine: 'zs2', imageUrl: IMG, reconstructImages: true })).toEqual(['RECONSTRUCT_NEEDS_VIEWS'])
  })
})

describe('the subject and the picture a prompt becomes', () => {
  it('defaults to an environment on the world engines and an object on Zetta Splat', () => {
    expect(defaultSplatSubject('zs2')).toBe('environment')
    expect(defaultSplatSubject('zs21')).toBe('environment')
    expect(defaultSplatSubject('n25')).toBe('object')
  })

  it('offers the Studio’s frames for an environment, and none for an object', () => {
    expect([...SPLAT_ASPECT_RATIOS]).toEqual(['16:9', '21:9', '3:2', '4:3', '1:1'])
    expect([...SPLAT_RESOLUTIONS]).toEqual(['1K', '2K', '4K'])
    expect(splatPictureProblems({ subject: 'environment', aspectRatio: '21:9', resolution: '4K' })).toEqual([])
    expect(splatPictureProblems({ subject: 'environment', aspectRatio: '9:16' }).map((p) => p.code)).toEqual(['INVALID_OPTION'])
    expect(splatPictureProblems({ subject: 'object', aspectRatio: '16:9', resolution: '2K' }).map((p) => p.code)).toEqual([
      'OPTION_NOT_APPLICABLE',
      'OPTION_NOT_APPLICABLE',
    ])
  })

  it('asks for the picture the Studio asks for', () => {
    expect(imageForPromptRequest('a misty forest', { subject: 'environment', aspectRatio: '21:9', resolution: '2K' })).toEqual({
      method: 'POST',
      path: '/2d/generate',
      body: { prompt: 'a misty forest', for3D: true, subject: 'environment', aspectRatio: '21:9', resolution: '2K' },
    })
    expect(imageForPromptRequest('a misty forest', { subject: 'environment' }).body).toMatchObject({ aspectRatio: '16:9', resolution: '1K' })
    expect(imageForPromptRequest('a red chair', { subject: 'object' }).body).toEqual({ prompt: 'a red chair', for3D: true })
  })

  it('cuts out only an object on Zetta Splat, and refuses the cut-out elsewhere', () => {
    expect(codes({ imageUrl: IMG, removeBackground: true })).toEqual([])
    expect(codes({ imageUrl: IMG, subject: 'environment', removeBackground: true })).toEqual(['CUT_OUT_NOT_OFFERED'])
    expect(codes({ engine: 'zs2', imageUrl: IMG, removeBackground: true })).toEqual(['CUT_OUT_NOT_OFFERED'])
    // Neither the subject nor the cut-out travels.
    const request = ok({ imageUrl: IMG, subject: 'object', removeBackground: true }).request
    expect(request).not.toHaveProperty('subject')
    expect(request).not.toHaveProperty('removeBackground')
  })

  it('builds a place, not an object, from a video', () => {
    expect(codes({ engine: 'zs2', videoUrl: VIDEO, subject: 'object' })).toEqual(['VIDEO_NEEDS_ENVIRONMENT'])
    expect(codes({ engine: 'zs2', videoUrl: VIDEO, subject: 'environment' })).toEqual([])
  })
})

describe('world exports', () => {
  function exportOk(input: WorldExportInput) {
    const result = buildWorldExportRequest(input)
    if (!result.ok) throw new Error(result.problems.map((p) => p.message).join('; '))
    return result
  }

  it('names the full resolution on a splat export, as the Studio does', () => {
    const result = exportOk({ sourcePostId: 9, kind: 'splat', engine: 'zs2' })
    expect(result.request).toEqual({
      spec: { postProcess: ['world_splat_export'] },
      sourcePostId: 9,
      model: 'zs2',
      splatResolution: 'full_res',
      origin: 'cli',
    })
    expect(result.quote).toEqual({ postProcess: ['world_splat_export'], model: 'zs2' })
  })

  it('names the textured mesh on a mesh export, and nothing on a collider', () => {
    expect(exportOk({ sourcePostId: 9, kind: 'mesh', engine: 'zs21' }).request).toMatchObject({
      spec: { postProcess: ['world_mesh_export'] },
      meshVariant: 'textured',
    })
    const collider = exportOk({ sourcePostId: 9, kind: 'collider', engine: 'zs2' }).request
    expect(collider.spec.postProcess).toEqual(['world_collider_export'])
    expect(collider).not.toHaveProperty('meshVariant')
    expect(collider).not.toHaveProperty('splatResolution')
  })

  it('refuses an option of another kind of export', () => {
    const codesOf = (input: WorldExportInput) => {
      const result = buildWorldExportRequest(input)
      return result.ok ? [] : result.problems.map((p) => p.code)
    }
    expect(codesOf({ sourcePostId: 9, kind: 'mesh', splatResolution: '500k' })).toEqual(['OPTION_NOT_APPLICABLE'])
    expect(codesOf({ sourcePostId: 9, kind: 'splat', meshVariant: 'vertex_colored' })).toEqual(['OPTION_NOT_APPLICABLE'])
    expect(codesOf({ sourcePostId: 0, kind: 'splat' })).toEqual(['SOURCE_REQUIRED'])
    expect(codesOf({ sourcePostId: 9, kind: 'ply' as never })).toEqual(['INVALID_OPTION'])
  })

  it('asks for the engine so the quote prices the right one', () => {
    const result = exportOk({ sourcePostId: 9, kind: 'splat', splatResolution: '150k' })
    expect(result.request).not.toHaveProperty('model')
    expect(result.request.splatResolution).toBe('150k')
    expect(result.warnings.join(' ')).toMatch(/engine/)
  })
})
