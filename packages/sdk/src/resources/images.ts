import type { Transport } from '../transport'
import type { ComposeImageInput, EditImageInput, GenerateImageInput, ImagePost, ImageResult, InlineImage, Page } from '../types'

const IMAGE_TIMEOUT_MS = 180_000

/** The PBR maps the Studio's inspector derives from a material's base-colour texture. */
export const TEXTURE_MAPS = ['normal', 'roughness', 'metalness', 'emissive', 'ao'] as const
export type TextureMapKind = (typeof TEXTURE_MAPS)[number]

/**
 * How the Studio asks for each map, word for word (`texture-channels.ts`). Each prompt describes
 * what the output looks like rather than naming the format, because "a normal map of this" alone
 * comes back as a bluish picture of the object.
 */
export const TEXTURE_MAP_PROMPTS: Record<TextureMapKind, string> = {
  normal:
    'Convert this texture into a tangent-space normal map. Output must be flat lavender-blue ' +
    '(RGB 128,128,255) wherever the surface is flat, with red and green deviating only to encode ' +
    'the slope of the surface detail visible here. Keep the same layout and scale. No shading, ' +
    'no colour from the original, no lighting.',
  roughness:
    'Convert this texture into a greyscale roughness map. Black is mirror-smooth, white is ' +
    'fully matte. Base the values on the material each area appears to be — polished metal dark, ' +
    'raw wood or cloth light. Keep the same layout. Greyscale only, no colour, no shading.',
  metalness:
    'Convert this texture into a greyscale metalness mask. Pure white where the surface is ' +
    'metal, pure black everywhere else, with no midtones except at a genuine boundary. Keep the ' +
    'same layout. Greyscale only.',
  emissive:
    'Convert this texture into an emissive map. Pure black everywhere the surface does not emit ' +
    'light, and the emitted colour only where it genuinely glows — screens, lamps, hot metal, ' +
    'runes. If nothing in this texture would emit light, return solid black. Keep the same layout.',
  ao:
    'Convert this texture into a greyscale ambient occlusion map. White where light reaches ' +
    'freely, darkening only inside crevices, seams and contact areas implied by the detail here. ' +
    'Keep the same layout. Greyscale only, no colour, no directional shading.',
}

/**
 * The frame size to ask a map for: the nearest offered size at or above the source texture's
 * longest edge, so a 4K atlas gets a 4K map rather than a 1K one stretched to fit.
 */
export function textureMapResolution(longestEdge: number): '1K' | '2K' | '4K' {
  if (longestEdge > 2048) return '4K'
  if (longestEdge > 1024) return '2K'
  return '1K'
}

export class Images {
  constructor(private readonly transport: Transport) {}

  list(query: { page?: number; pageSize?: number; feature?: 'genImg' | 'editImg' | 'composeImg'; search?: string } = {}): Promise<Page<ImagePost>> {
    return this.transport.request('GET', '/2d', { query })
  }

  async get(id: number): Promise<ImagePost | undefined> {
    // There is no detail route; search the pages for the id.
    for (let page = 1; page <= 50; page++) {
      const result = await this.list({ page, pageSize: 100 })
      const found = result.items.find((item) => item.id === id)
      if (found) return found
      if (page * result.pageSize >= result.total) return undefined
    }
    return undefined
  }

  delete(id: number): Promise<void> {
    return this.transport.request('DELETE', `/2d/${id}`)
  }

  generate(input: GenerateImageInput, idempotencyKey?: string): Promise<ImageResult> {
    return this.transport.request('POST', '/2d/generate', { body: input, timeoutMs: IMAGE_TIMEOUT_MS, retry: 'never', ...(idempotencyKey ? { idempotencyKey } : {}) })
  }

  edit(input: EditImageInput, idempotencyKey?: string): Promise<ImageResult> {
    return this.transport.request('POST', '/2d/img-edit', { body: input, timeoutMs: IMAGE_TIMEOUT_MS, retry: 'never', ...(idempotencyKey ? { idempotencyKey } : {}) })
  }

  /**
   * Derives one PBR map from a base-colour texture, the way the Studio's inspector does: an image
   * edit marked `textureMap` (a paid-plan feature), square, at the size the source needs, on the
   * server's default engine. `longestEdge` is the source texture's own longest edge in pixels.
   */
  textureMap(map: TextureMapKind, baseColour: InlineImage, longestEdge: number, idempotencyKey?: string): Promise<ImageResult> {
    return this.edit(
      { prompt: TEXTURE_MAP_PROMPTS[map], image: baseColour, textureMap: true, aspectRatio: '1:1', resolution: textureMapResolution(longestEdge) },
      idempotencyKey,
    )
  }

  compose(input: ComposeImageInput, idempotencyKey?: string): Promise<ImageResult> {
    return this.transport.request('POST', '/2d/img-compose', { body: input, timeoutMs: IMAGE_TIMEOUT_MS, retry: 'never', ...(idempotencyKey ? { idempotencyKey } : {}) })
  }
}
