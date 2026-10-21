import type { Transport } from '../transport'
import type { ImageEntitlementsResponse, ImageModel, PriceListItem, Quote, ThreeDEntitlementsResponse } from '../types'

export interface QuoteRequest {
  generation?: { base: string; modifiers?: string[] }
  postProcess?: string[]
  model?: string
}

export class Catalog {
  constructor(private readonly transport: Transport) {}

  /** Customer prices per 3D option, one row per code (and per engine where prices differ). */
  async prices3d(): Promise<PriceListItem[]> {
    const result = await this.transport.request<{ items: PriceListItem[] }>('GET', '/3d/pricing')
    return result.items
  }

  /** What this account's plan allows for 3D. */
  entitlements3d(): Promise<ThreeDEntitlementsResponse> {
    return this.transport.request('GET', '/3d/entitlements')
  }

  /** What this account's plan allows for images. */
  entitlements2d(): Promise<ImageEntitlementsResponse> {
    return this.transport.request('GET', '/2d/entitlements')
  }

  /** Image engines available to this account. */
  imageModels(): Promise<{ models: ImageModel[]; default: string }> {
    return this.transport.request('GET', '/2d/models')
  }

  /** Prices a job without spending anything. */
  async quote(request: QuoteRequest): Promise<Quote> {
    const quote = await this.transport.request<Quote & Record<string, unknown>>('POST', '/3d/quote', { body: request })
    return { credits: quote.credits, lines: (quote.lines ?? []).map(({ code, label, credits }) => ({ code, label, credits })) }
  }
}
