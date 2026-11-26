import type { Transport } from '../transport'
import type { PricingResponse, Subscription, UsageEntry, UsagePage } from '../types'

/** One Agent plan size: extra AI tokens every month, a subscription of its own beside any 3D plan. */
export interface AgentPlanPrice {
  priceId: string
  productId?: string
  name: string
  /** Minor units: 2000 is €20.00. */
  amount: number
  currency: string
  /** AI tokens granted every month. */
  aiTokens: number
  /** Agent plans are sold monthly; a yearly price is kept only for existing subscribers. */
  interval?: 'month' | 'year'
}

/** The Agent plan on an account, while it is a subscription at all. */
export interface AgentPlanSubscription {
  priceId: string | null
  /** AI tokens a month. */
  tokens: number
  status: string | null
  cancelAtPeriodEnd: boolean
  currentPeriodEnd: string | null
}

/** `GET /pricing`: 3D plans, credit packs, Agent plans and the per-operation price table. */
export interface Pricing extends PricingResponse {
  /** Agent plans, monthly prices only. Absent on older servers. */
  aiAddOns?: AgentPlanPrice[]
}

export interface SubscriptionDetails extends Subscription {
  /** The Agent plan, or null when there is none. Absent on older servers. */
  aiAddOn?: AgentPlanSubscription | null
}

/** Which balance a ledger entry moved. The two are never interchangeable. */
export type UsageMeter = 'three_d_credit' | 'ai_token'

/** Where a charge was made. */
export type UsageOrigin = 'web' | 'unity' | 'blender' | 'unreal' | 'pipeline' | 'cli' | 'api'

export interface UsageRecord extends UsageEntry {
  /** Where it was spent; null when nothing recorded it. */
  origin?: UsageOrigin | null
  /** For an AI turn: the tier that ran it (Fast, Capable, Intelligent), how hard it thought, raw tokens and their weight. */
  ai?: { tier: string; thinking: string; rawTokens: number; weight: number }
}

export interface UsageRecordPage extends Omit<UsagePage, 'entries' | 'nextCursor'> {
  entries: UsageRecord[]
  nextCursor: string | number | null
}

/** One balance's spend this billing period (or the last 30 days without a subscription). */
export interface UsageBreakdown {
  meter: UsageMeter
  since: string
  /** Net spend: charges less refunds. */
  total: number
  byOperation: Array<{ operationType: string; amount: number; count: number }>
  /** AI only: by tier, largest first. */
  byTier: Array<{ tier: string; amount: number; count: number }>
  /** More rows than were read: the figures are a floor. */
  truncated: boolean
}

export class Billing {
  constructor(private readonly transport: Transport) {}

  /** Plans, credit packs, Agent plans and the per-operation price table (public). */
  pricing(): Promise<Pricing> {
    return this.transport.request('GET', '/pricing', { auth: false })
  }

  /** The plan, its renewal, and the Agent plan. Works with an API key. */
  subscription(): Promise<SubscriptionDetails> {
    return this.transport.request('GET', '/billing/subscription')
  }

  /**
   * The usage ledger, newest first. Pass the previous page's `nextCursor` as `before`; `meter`
   * narrows it to one balance. Works with an API key.
   */
  usage(query: { limit?: number; before?: string | number; meter?: UsageMeter } = {}): Promise<UsageRecordPage> {
    return this.transport.request('GET', '/billing/usage', { query })
  }

  /** This billing period's spend on one balance, by feature (and, for AI, by tier). Works with an API key. */
  usageBreakdown(meter: UsageMeter): Promise<UsageBreakdown> {
    return this.transport.request('GET', '/billing/usage/breakdown', { query: { meter } })
  }

  /**
   * A hosted checkout page for a 3D plan, a credit pack or an Agent plan; the price decides which.
   * Card details never pass through this client. Browser sign-in only.
   */
  checkout(priceId: string): Promise<{ url: string }> {
    return this.transport.request('POST', '/billing/checkout', { body: { priceId }, retry: 'never' })
  }

  /** The hosted billing portal (change plan, card, invoices, cancel). Browser sign-in only. */
  portal(priceId?: string): Promise<{ url: string }> {
    return this.transport.request('POST', '/billing/portal', { body: priceId ? { priceId } : {}, retry: 'never' })
  }

  /**
   * Switches a live Agent plan to another size. The difference for the rest of the period is
   * charged (or credited) to the card on file at once. Browser sign-in only.
   */
  changeAgentPlan(priceId: string): Promise<{ changed: boolean }> {
    return this.transport.request('POST', '/billing/ai-add-on/change', { body: { priceId }, retry: 'never' })
  }
}
