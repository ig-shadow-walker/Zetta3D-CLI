import type { Transport } from '../transport'
import type { PricingResponse, Subscription, UsagePage } from '../types'

export class Billing {
  constructor(private readonly transport: Transport) {}

  /** Plans, credit packs and the per-operation price table (public). */
  pricing(): Promise<PricingResponse> {
    return this.transport.request('GET', '/pricing', { auth: false })
  }

  subscription(): Promise<Subscription> {
    return this.transport.request('GET', '/billing/subscription')
  }

  /** The credit ledger, newest first. Pass the previous page's `nextCursor` as `before`. */
  usage(query: { limit?: number; before?: string } = {}): Promise<UsagePage> {
    return this.transport.request('GET', '/billing/usage', { query })
  }

  /** A hosted checkout page for a plan or credit pack. Card details never pass through this client. */
  checkout(priceId: string): Promise<{ url: string }> {
    return this.transport.request('POST', '/billing/checkout', { body: { priceId }, retry: 'never' })
  }

  /** The hosted billing portal (change plan, card, invoices, cancel). */
  portal(priceId?: string): Promise<{ url: string }> {
    return this.transport.request('POST', '/billing/portal', { body: priceId ? { priceId } : {}, retry: 'never' })
  }
}
