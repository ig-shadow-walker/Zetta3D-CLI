import type { Transport } from '../transport'
import type { ComposeImageInput, EditImageInput, GenerateImageInput, ImagePost, ImageResult, Page } from '../types'

const IMAGE_TIMEOUT_MS = 180_000

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

  compose(input: ComposeImageInput, idempotencyKey?: string): Promise<ImageResult> {
    return this.transport.request('POST', '/2d/img-compose', { body: input, timeoutMs: IMAGE_TIMEOUT_MS, retry: 'never', ...(idempotencyKey ? { idempotencyKey } : {}) })
  }
}
