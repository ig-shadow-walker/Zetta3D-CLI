import type { Transport } from '../transport'
import type { Frame, RembgResult, RiggingPrecheck, TagsResult } from '../types'

export class Tools {
  constructor(private readonly transport: Transport) {}

  /** Removes a picture's background. `image` is base64 without a `data:` prefix (max 8 MB). Returns a PNG. */
  removeBackground(imageBase64: string): Promise<RembgResult> {
    return this.transport.request('POST', '/tools/rembg', { body: { image: imageBase64 }, timeoutMs: 120_000 })
  }

  /** Suggests a category and tags from 1–4 rendered frames. Billed in AI tokens. */
  tags(input: { frames: Frame[]; triangles?: number; subject?: string }): Promise<TagsResult> {
    return this.transport.request('POST', '/ai/tags', { body: input, retry: 'never', timeoutMs: 120_000 })
  }

  /** Guesses the body type of a model from frames, before rigging. */
  riggingPrecheck(input: { frames: Frame[] }): Promise<RiggingPrecheck> {
    return this.transport.request('POST', '/ai/rigging-precheck', { body: input, retry: 'never', timeoutMs: 120_000 })
  }

  /** Asks for access to an early-access feature. */
  requestEarlyAccess(featureName: string, email?: string): Promise<{ status: string; email: string }> {
    return this.transport.request('POST', '/early-access/requests', { body: email ? { featureName, email } : { featureName }, retry: 'never' })
  }
}
