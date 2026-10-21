import { describe, expect, it } from 'vitest'
import {
  DRAW_VIEWS,
  TEXTURE_MAP_CHANNELS,
  directionLabel,
  drawViewPrompt,
  drawViewRequest,
  imageForPromptRequest,
  missingViews,
  nearestFrame,
  normalizeAzimuth,
  referenceView,
  textureMapPrompt,
  textureMapRequest,
  textureMapResolution,
  textureReferenceEditRequest,
  worldDirectionPrompt,
  worldDirectionRequest,
} from '../../src/builders/prompts'

/* Ported from the Studio's multi-view and world-direction tests. */

describe('drawing a missing view', () => {
  it('forbids redesigning the object', () => {
    const prompt = drawViewPrompt('back')
    expect(prompt).toMatch(/SAME object/)
    expect(prompt).toMatch(/do not add or remove any part/i)
  })

  it('names a different camera per view', () => {
    expect(drawViewPrompt('left')).toMatch(/left flank/i)
    expect(drawViewPrompt('right')).toMatch(/right flank/i)
    expect(drawViewPrompt('left')).not.toBe(drawViewPrompt('right'))
  })

  it('asks the two side views to face opposite ways in the frame', () => {
    expect(drawViewPrompt('left')).toMatch(/FRONT points to the LEFT edge/)
    expect(drawViewPrompt('right')).toMatch(/FRONT points to the RIGHT edge/)
    expect(drawViewPrompt('left')).not.toMatch(/FRONT points to the RIGHT edge/)
    expect(drawViewPrompt('right')).not.toMatch(/FRONT points to the LEFT edge/)
  })

  it('hides the opposite flank on both side views', () => {
    for (const view of ['left', 'right'] as const) {
      expect(drawViewPrompt(view)).toMatch(/opposite flank is entirely behind/i)
    }
  })

  it('leaves framing to the server preset', () => {
    for (const view of DRAW_VIEWS) expect(drawViewPrompt(view)).not.toMatch(/aspect ratio|1:1|1K/i)
  })

  it('sends it as a 3D pipeline edit of the reference', () => {
    expect(drawViewRequest('back', 'QUJD')).toEqual({
      method: 'POST',
      path: '/2d/img-edit',
      body: { prompt: drawViewPrompt('back'), image: { data: 'QUJD' }, for3D: true, pipelineStep: true },
    })
  })

  it('takes a data URL or a library picture as the reference', () => {
    expect(drawViewRequest('left', 'data:image/jpeg;base64,QUJD').body.image).toEqual({ data: 'QUJD', contentType: 'image/jpeg' })
    const fromPost = drawViewRequest('left', { sourcePostId: 12 }).body
    expect(fromPost.sourcePostId).toBe(12)
    expect(fromPost).not.toHaveProperty('image')
  })

  it('draws from the front when there is one, else the first filled view', () => {
    expect(referenceView({ back: 'x', left: 'y', front: 'z' })).toBe('front')
    expect(referenceView({ right: 'x', left: 'y' })).toBe('left')
    expect(referenceView({})).toBeNull()
    expect(missingViews({ front: 'x' })).toEqual(['back', 'left', 'right'])
    expect(missingViews({ front: 'a', back: 'b', left: 'c', right: 'd' })).toEqual([])
  })

  it('sends an edit of the texture reference the same way', () => {
    expect(textureReferenceEditRequest(' make it rusty ', 'QUJD').body).toEqual({
      prompt: 'make it rusty',
      image: { data: 'QUJD' },
      for3D: true,
      pipelineStep: true,
    })
  })
})

describe('a picture made from a prompt', () => {
  it('asks for an object framed for 3D', () => {
    expect(imageForPromptRequest('  a brass dragon ')).toEqual({
      method: 'POST',
      path: '/2d/generate',
      body: { prompt: 'a brass dragon', for3D: true },
    })
  })

  it('gives an environment its frame, 16:9 at 1K by default', () => {
    expect(imageForPromptRequest('a canyon', { subject: 'environment' }).body).toEqual({
      prompt: 'a canyon',
      for3D: true,
      subject: 'environment',
      aspectRatio: '16:9',
      resolution: '1K',
    })
    expect(imageForPromptRequest('a canyon', { subject: 'environment', aspectRatio: '21:9', resolution: '2K' }).body).toMatchObject({
      aspectRatio: '21:9',
      resolution: '2K',
    })
    expect(imageForPromptRequest('a chair', { subject: 'object', aspectRatio: '21:9' }).body).toEqual({ prompt: 'a chair', for3D: true })
  })
})

describe('world directions', () => {
  it('reads a typed angle as whole degrees round the circle', () => {
    expect(normalizeAzimuth('90')).toBe(90)
    expect(normalizeAzimuth(' 359.6 ')).toBe(0)
    expect(normalizeAzimuth(-90)).toBe(270)
    expect(normalizeAzimuth(450)).toBe(90)
    expect(normalizeAzimuth('')).toBeNull()
    expect(normalizeAzimuth('left')).toBeNull()
  })

  it('names the ready-made turns and leaves the rest as angles', () => {
    expect(directionLabel(90)).toBe('Right · 90°')
    expect(directionLabel(180)).toBe('Back · 180°')
    expect(directionLabel(270)).toBe('Left · 270°')
    expect(directionLabel(135)).toBe('Back-right · 135°')
    expect(directionLabel(315)).toBe('Front-left · 315°')
    expect(directionLabel(100)).toBe('100°')
  })

  it('asks for the turn the viewer makes, clockwise to the right', () => {
    expect(worldDirectionPrompt(90)).toMatch(/turns 90° to their right/)
    expect(worldDirectionPrompt(300)).toMatch(/turns 60° to their left/)
    expect(worldDirectionPrompt(180)).toMatch(/behind them/)
    expect(worldDirectionPrompt(30)).toMatch(/overlaps/)
  })

  it('keeps a picture’s shape', () => {
    expect(nearestFrame(1920, 1080)).toBe('16:9')
    expect(nearestFrame(1080, 1920)).toBe('9:16')
    expect(nearestFrame(4032, 3024)).toBe('4:3')
    expect(nearestFrame(1000, 1000)).toBe('1:1')
    expect(nearestFrame(0, 0)).toBe('16:9')
  })

  it('sends a direction as an environment edit of the forward picture', () => {
    expect(worldDirectionRequest(90, 'QUJD', { aspectRatio: '4:3', resolution: '2K' }).body).toEqual({
      prompt: worldDirectionPrompt(90),
      image: { data: 'QUJD' },
      for3D: true,
      subject: 'environment',
      aspectRatio: '4:3',
      resolution: '2K',
      pipelineStep: true,
    })
  })
})

describe('texture maps', () => {
  it('has one instruction per channel, and none for the base colour', () => {
    expect(TEXTURE_MAP_CHANNELS).not.toContain('map' as never)
    for (const channel of TEXTURE_MAP_CHANNELS) expect(textureMapPrompt(channel)).toMatch(/^Convert this texture into/)
  })

  it('asks for the size at or above the source’s', () => {
    expect(textureMapResolution(1024)).toBe('1K')
    expect(textureMapResolution(1025)).toBe('2K')
    expect(textureMapResolution(2048)).toBe('2K')
    expect(textureMapResolution(4096)).toBe('4K')
  })

  it('declares itself a texture map, square, without the 3D pipeline exemption', () => {
    const { body, path } = textureMapRequest('roughnessMap', 'QUJD', 3000)
    expect(path).toBe('/2d/img-edit')
    expect(body).toEqual({
      prompt: textureMapPrompt('roughnessMap'),
      image: { data: 'QUJD' },
      textureMap: true,
      aspectRatio: '1:1',
      resolution: '4K',
    })
  })
})
