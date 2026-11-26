import type { AgentPlanPrice, CreditPool, Pricing, PublicUser, UsageMeter, UsageRecord } from '@zetta3d/sdk'
import { z } from 'zod'
import { openBrowser } from '../auth/browser'
import type { Context } from '../core/context'
import { defineCommand } from '../core/define'
import { cliError, usageError } from '../core/errors'
import { table } from '../core/output'

const total = (pool: CreditPool) => pool.monthly + pool.purchased + pool.bonusMonthly + pool.bonus

function credits(user: PublicUser) {
  return {
    threeD: { total: total(user.credits.threeD), ...user.credits.threeD },
    ai: { total: total(user.credits.ai), ...user.credits.ai },
  }
}

/** `free` and `none` are not plans any more: they cannot generate, whatever credits they still hold. */
const hasPlan = (plan: string | null | undefined) => Boolean(plan) && plan !== 'free' && plan !== 'none'

const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '-')
const num = (n: number) => n.toLocaleString('en')

/**
 * AI tokens as approximate hours of agent work, as the website sells Agent plans: one "AI hour" is a
 * typical hour on the everyday tier. An estimate, so everything that prints it says "≈".
 */
const AI_HOUR_TOKENS = 1_200_000
function aiHours(tokens: number): string {
  const hours = Math.max(0, tokens) / AI_HOUR_TOKENS
  return hours >= 10 ? `≈ ${Math.round(hours)} h` : hours >= 1 ? `≈ ${Math.round(hours * 10) / 10} h` : `≈ ${Math.round(hours * 60)} min`
}

const noPlanNote = (trialAvailable: boolean) =>
  `No plan yet, so nothing can be generated. See \`zetta billing plans\`${trialAvailable ? ', or redeem a trial code with `zetta account redeem <code>`' : ''}.`

interface ShowResult {
  id: number
  email: string
  displayName: string | null
  plan: string
  subscriptionStatus: string | null
  /** A trial from a trial code while it runs; null otherwise. */
  trial: { endsAt: string; plan: string } | null
  /** Whether a trial code can still be redeemed on this account. */
  trialAvailable: boolean
  /** Whether an Agent plan is in force. */
  agentPlan: boolean
  earlyAccess: boolean
  onboardingDone: boolean
  /** 3D credits finishing onboarding would still pay (0 when there is none). */
  onboardingBonus: number
  credits: ReturnType<typeof credits>
  createdAt: string
}

export const accountShow = defineCommand({
  path: ['account', 'show'],
  summary: 'Your account: email, plan, trial, Agent plan, credits and access.',
  kind: 'read',
  input: z.object({}),
  async run(ctx): Promise<ShowResult> {
    const { user, onboardingBonus } = await (await ctx.client()).auth.me()
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      plan: user.paymentPlan,
      subscriptionStatus: user.subscriptionStatus,
      trial: user.trial ?? null,
      trialAvailable: user.trialAvailable ?? false,
      agentPlan: user.agentPlan ?? false,
      earlyAccess: user.earlyAccess,
      onboardingDone: Boolean(user.onboardingCompletedAt),
      onboardingBonus: typeof onboardingBonus === 'number' ? onboardingBonus : 0,
      credits: credits(user),
      createdAt: user.createdAt,
    }
  },
  text: (r: ShowResult) =>
    [
      `${r.email} · ${r.plan} plan${r.trial ? ' (trial)' : ''}${r.agentPlan ? ' · Agent plan' : ''}${r.earlyAccess ? ' · early access' : ''}`,
      `3D credits: ${num(r.credits.threeD.total)}   AI tokens: ${num(r.credits.ai.total)}`,
      r.trial ? `Free trial of ${r.trial.plan} until ${day(r.trial.endsAt)}. Subscribe before then to keep it: \`zetta billing plans\`.` : '',
      hasPlan(r.plan) ? '' : noPlanNote(r.trialAvailable),
      !r.onboardingDone && r.onboardingBonus > 0 ? `Tip: \`zetta account onboarding\` pays a one-time bonus of ${num(r.onboardingBonus)} 3D credits.` : '',
    ]
      .filter(Boolean)
      .join('\n'),
})

export const accountCredits = defineCommand({
  path: ['account', 'credits'],
  summary: 'Your credit balances, per pool.',
  description:
    '3D credits pay for generations and finishing tools (1 credit = €0.01). AI tokens pay for the agents and AI helpers such as auto-tagging. Spending needs a plan (or a running trial); without one, balances cannot be used.',
  kind: 'read',
  input: z.object({}),
  async run(ctx) {
    const { user } = await (await ctx.client()).auth.me()
    return { plan: user.paymentPlan, canSpend: hasPlan(user.paymentPlan), ...credits(user) }
  },
  text: (r: { plan: string; canSpend: boolean } & ReturnType<typeof credits>) =>
    [
      `Plan: ${r.plan}`,
      table(
        [
          { pool: '3D credits', ...r.threeD },
          { pool: 'AI tokens', ...r.ai },
        ],
        ['pool', 'total', 'monthly', ['bonusMonthly', 'monthly bonus'], 'bonus', 'purchased'],
      ),
      r.canSpend ? '' : 'No plan: these balances cannot be spent until you choose one (`zetta billing plans`) or redeem a trial code (`zetta account redeem <code>`).',
    ]
      .filter(Boolean)
      .join('\n'),
})

const METERS = { credits: 'three_d_credit', 'ai-tokens': 'ai_token' } as const satisfies Record<string, UsageMeter>
const meterLabel = (meter: string) => (meter === 'three_d_credit' ? '3d_credits' : meter === 'ai_token' ? 'ai_tokens' : meter)

/** Our own fields only: refund reasons can quote upstream error codes. */
function usageRow(entry: UsageRecord) {
  return {
    id: entry.id,
    date: entry.createdAt,
    meter: meterLabel(entry.meter),
    type: entry.entryType,
    amount: entry.amount,
    operation: entry.operationType,
    /** web, unity, blender, unreal, pipeline, cli or api; null when not recorded. */
    origin: entry.origin ?? null,
    /** AI turns: the tier that ran it and how hard it thought. */
    tier: entry.ai?.tier ?? null,
    thinking: entry.ai?.thinking ?? null,
    subject: entry.subjectType && entry.subjectId !== null ? `${entry.subjectType}:${String(entry.subjectId)}` : null,
  }
}

interface BreakdownResult {
  breakdown: true
  meter: string
  since: string
  total: number
  byOperation: Array<{ operation: string; amount: number; count: number }>
  byTier: Array<{ tier: string; amount: number; count: number }>
  truncated: boolean
}

interface HistoryResult {
  entries: ReturnType<typeof usageRow>[]
  nextCursor: string | null
}

export const accountUsage = defineCommand({
  path: ['account', 'usage'],
  summary: 'Your usage history (what was charged and refunded, and where), or this period’s totals with --breakdown.',
  description: [
    'Entries are newest first, each with where it was spent (web, unity, blender, unreal, pipeline, cli or api) and, for AI turns, the tier.',
    '--breakdown sums this billing period (the last 30 days without a subscription) by feature, and AI tokens also by tier.',
  ].join('\n'),
  kind: 'read',
  input: z.object({
    meter: z.enum(['credits', 'ai-tokens']).optional().describe('One balance only: 3D credits or AI tokens (default: both; with --breakdown, credits).'),
    breakdown: z.boolean().optional().describe('Totals for this billing period by feature (and AI tier) instead of the entry list.'),
    limit: z.number().int().min(1).max(100).optional().describe('Entries per page (max 100).'),
    before: z.string().optional().describe('Show entries older than this cursor (the `nextCursor` of the previous page).'),
    all: z.boolean().optional().describe('Fetch every page.'),
  }),
  examples: ['zetta account usage --meter ai-tokens', 'zetta account usage --breakdown --meter ai-tokens'],
  async run(ctx, input): Promise<BreakdownResult | HistoryResult> {
    const client = await ctx.client()
    const meter = input.meter ? METERS[input.meter] : undefined
    if (input.breakdown) {
      if (input.before || input.all || input.limit) throw usageError('--breakdown sums the whole billing period; it takes only --meter.')
      const b = await client.billing.usageBreakdown(meter ?? 'three_d_credit')
      return {
        breakdown: true,
        meter: meterLabel(b.meter),
        since: b.since,
        total: b.total,
        byOperation: (b.byOperation ?? []).map((row) => ({ operation: row.operationType, amount: row.amount, count: row.count })),
        byTier: (b.byTier ?? []).map((row) => ({ tier: row.tier, amount: row.amount, count: row.count })),
        truncated: Boolean(b.truncated),
      }
    }
    const rows: ReturnType<typeof usageRow>[] = []
    let cursor: string | undefined = input.before
    for (;;) {
      const page = await client.billing.usage({ limit: input.limit ?? 25, ...(cursor ? { before: cursor } : {}), ...(meter ? { meter } : {}) })
      rows.push(...page.entries.map(usageRow))
      cursor = page.nextCursor === null || page.nextCursor === undefined ? undefined : String(page.nextCursor)
      if (!input.all || !cursor) return { entries: rows, nextCursor: cursor ?? null }
    }
  },
  text: (r: BreakdownResult | HistoryResult) => {
    if ('breakdown' in r) {
      const unit = r.meter === 'ai_tokens' ? 'AI tokens' : '3D credits'
      return [
        `${unit} since ${day(r.since)}: ${num(r.total)} net${r.meter === 'ai_tokens' ? ` (${aiHours(r.total)})` : ''}`,
        '',
        table(r.byOperation, ['operation', 'amount', 'count']),
        ...(r.byTier.length ? ['', 'By tier:', table(r.byTier, ['tier', 'amount', 'count'])] : []),
        ...(r.truncated ? ['', 'Partial: more entries than could be read, so these are lower bounds.'] : []),
      ].join('\n')
    }
    const withTier = r.entries.some((e) => e.tier)
    return `${table(
      r.entries.map((e) => ({ ...e, tier: e.tier ? `${e.tier}${e.thinking ? ` · ${e.thinking}` : ''}` : '' })),
      ['date', 'meter', 'type', 'amount', 'operation', 'origin', ...(withTier ? ['tier'] : []), 'subject'],
    )}${r.nextCursor ? `\nMore: --before ${r.nextCursor}` : ''}`
  },
})

export const accountRedeem = defineCommand({
  path: ['account', 'redeem'],
  summary: 'Redeem a trial code: 10 days of the Basic plan, free.',
  description:
    'For accounts without a plan that have not had a trial. Any shape works: ZETTA-7KQ2-M9XD, lower case, without dashes, or the whole link with ?trial=. Needs a browser sign-in.',
  kind: 'write',
  positionals: [{ name: 'code', required: true }],
  input: z.object({
    code: z.string().trim().min(4).max(300).describe('The trial code (e.g. ZETTA-7KQ2-M9XD) or the link that carries it.'),
  }),
  examples: ['zetta account redeem ZETTA-7KQ2-M9XD'],
  async run(ctx, input) {
    const result = await (await ctx.sessionClient('Redeeming a trial code')).trials.redeem(input.code)
    return { redeemed: true, plan: result.plan, trialEndsAt: result.trialEndsAt }
  },
  text: (r: { plan: string; trialEndsAt: string }) =>
    `Trial started: the ${r.plan} plan, free until ${day(r.trialEndsAt)}. Subscribe before then to keep it: \`zetta billing plans\`.`,
})

const CLIENT_NAMES: Record<string, string> = {
  cli: 'CLI',
  'cli-mcp': 'CLI (MCP server)',
  sdk: 'SDK',
  unity: 'Unity',
  blender: 'Blender',
  unreal: 'Unreal Engine',
  plugin: 'plugin',
}

export const accountConnections = defineCommand({
  path: ['account', 'connections'],
  summary: 'Plugins and CLIs connected to your account, with versions and when each was last seen.',
  description: 'Needs a browser sign-in.',
  kind: 'read',
  input: z.object({}),
  async run(ctx) {
    const list = await (await ctx.sessionClient('Listing connections')).auth.connections()
    return {
      connections: list.map((c) => ({
        client: c.client,
        name: CLIENT_NAMES[c.client] ?? c.client,
        version: c.pluginVersion,
        hostVersion: c.hostVersion,
        firstSeenAt: c.firstSeenAt,
        lastSeenAt: c.lastSeenAt,
      })),
    }
  },
  text: (r: { connections: Array<Record<string, unknown> & { firstSeenAt: string; lastSeenAt: string }> }) =>
    r.connections.length
      ? table(
          r.connections.map((c) => ({ ...c, firstSeenAt: day(c.firstSeenAt), lastSeenAt: day(c.lastSeenAt) })),
          ['name', 'version', ['hostVersion', 'host'], ['firstSeenAt', 'first seen'], ['lastSeenAt', 'last seen']],
        )
      : 'Nothing connected yet.',
})

const ONBOARDING = {
  userType: ['company', 'startup', 'personal'],
  industry: ['gaming', 'film', 'ecommerce', 'printing', 'architecture', 'interior', 'fashion', 'xr', 'other'],
  heardFrom: ['google', 'word-of-mouth', 'linkedin', 'youtube', 'x', 'friend', 'other'],
} as const

export const accountOnboarding = defineCommand({
  path: ['account', 'onboarding'],
  summary: 'Answer the five onboarding questions (pays a one-time credit bonus on plans that have one).',
  description:
    'Answers use the ids the web onboarding uses. `zetta account show` says whether a bonus is waiting. Calling it again is harmless; a bonus is paid once. Needs a browser sign-in.',
  kind: 'write',
  input: z.object({
    userType: z.enum(ONBOARDING.userType).describe('Who you are.'),
    industry: z.enum(ONBOARDING.industry).describe('Your industry.'),
    industryOther: z.string().max(500).optional().describe('Your industry, when --industry is other.'),
    tools: z.array(z.string()).describe('3D tools you use (ids as in the web onboarding, e.g. blender, max, c4d, zbrush, houdini, or none).'),
    engines: z.array(z.string()).describe('Game engines you use (e.g. unity, unreal, godot, or none).'),
    heardFrom: z.enum(ONBOARDING.heardFrom).optional().describe('Where you heard about Zetta 3D.'),
  }),
  async run(ctx, input) {
    const client = await ctx.sessionClient('Onboarding')
    const before = await client.auth.me()
    const pending = typeof before.onboardingBonus === 'number' ? before.onboardingBonus : 0
    const result = await client.auth.completeOnboarding(input)
    return { granted: result.granted, bonus: result.granted ? pending : 0, credits: credits(result.user) }
  },
  text: (r: { granted: boolean; bonus: number; credits: ReturnType<typeof credits> }) =>
    !r.granted
      ? 'Onboarding was already complete; no new bonus.'
      : r.bonus > 0
        ? `Thanks! ${num(r.bonus)} bonus 3D credits added; you now have ${num(r.credits.threeD.total)}.`
        : 'Thanks! Onboarding is complete.',
})

export const accountEarlyAccess = defineCommand({
  path: ['account', 'early-access'],
  summary: 'Ask for access to an early-access feature (e.g. splat).',
  description: 'Needs a browser sign-in.',
  kind: 'write',
  positionals: [{ name: 'feature', required: true }],
  input: z.object({
    feature: z.string().describe('The feature to ask for, e.g. "Zetta Splat".'),
    email: z.string().email().optional().describe('Where to reach you, if not your account email.'),
  }),
  async run(ctx, input) {
    return (await ctx.sessionClient('Asking for early access')).tools.requestEarlyAccess(input.feature, input.email)
  },
  text: (r: { status: string; email: string }) =>
    r.status === 'granted' ? 'You already have access.' : `Request ${r.status}. We'll write to ${r.email}.`,
})

export const accountDelete = defineCommand({
  path: ['account', 'delete'],
  summary: 'Delete your account and everything in it. Cannot be undone.',
  description:
    'Only works in a terminal, after typing your email to confirm, with a browser sign-in. Cancel any subscription and any Agent plan first (`zetta billing portal`).',
  kind: 'destructive',
  mcp: false,
  input: z.object({}),
  async run(ctx: Context) {
    if (!ctx.interactive) throw usageError('Deleting an account needs a terminal, so a person confirms it.')
    const client = await ctx.sessionClient('Deleting the account')
    const { user } = await client.auth.me()
    ctx.out.warn(`This permanently deletes ${user.email}: every model, picture, pipeline and credit.`)
    const typed = (await ctx.ask(`Type ${user.email} to confirm: `)).trim()
    if (typed !== user.email) throw cliError('CANCELLED', 'The email did not match; nothing was deleted.')
    await client.auth.deleteAccount()
    await ctx.credentials.delete(ctx.profileName)
    return { deleted: true, email: user.email }
  },
  text: () => 'Your account was deleted.',
})

// ── Billing ────────────────────────────────────────────────────────────────

interface Price {
  id: string
  amount: number
  currency: string
  interval: 'month' | 'year'
}

const money = (amount: number, currency: string) =>
  new Intl.NumberFormat('en', { style: 'currency', currency: currency.toUpperCase() }).format(amount / 100)

/** Agent plans on sale: monthly prices only (a yearly one is kept for existing subscribers), smallest first. */
function agentPlans(pricing: Pricing): AgentPlanPrice[] {
  return (pricing.aiAddOns ?? []).filter((a) => (a.interval ?? 'month') !== 'year').sort((a, b) => a.aiTokens - b.aiTokens)
}

const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '')
/** "Agent - Plus" → "Agent Plus", as the website titles it. */
const agentTitle = (name: string) => name.replace(/\s+-\s+/g, ' ').trim()

/** An Agent plan by price id, full name ("Agent Plus", "agent-plus") or short name ("plus"). */
function findAgentPlan(plans: AgentPlanPrice[], query: string): AgentPlanPrice | undefined {
  const q = squash(query)
  const short = q.replace(/^(agent|ai)/, '')
  return plans.find((p) => {
    const full = squash(p.name)
    return p.priceId === query.trim() || full === q || full.replace(/^(agent|ai)/, '') === short
  })
}

function findPlan(pricing: Pricing, query: string) {
  const q = squash(query)
  return pricing.plans.find((p) => p.plan === query || squash(String(p.name)) === q || squash(p.plan) === q)
}

/**
 * A plan's 3D entitlements without the per-category concurrency table: its keys are internal
 * category names, kept out of output like the `category` of a concurrency error. The total stays.
 */
function threeDEntitlements(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  const { concurrency, ...rest } = value as Record<string, unknown> & { concurrency?: { total?: number | null } }
  return { ...rest, maxConcurrentJobs: rest.maxConcurrentJobs ?? concurrency?.total ?? null }
}

function agentPlanRow(a: AgentPlanPrice) {
  return {
    name: agentTitle(a.name),
    aiTokens: a.aiTokens,
    approxHours: aiHours(a.aiTokens),
    price: money(a.amount, a.currency),
    priceId: a.priceId,
  }
}

export const billingPlans = defineCommand({
  path: ['billing', 'plans'],
  summary: '3D plans, credit packs and Agent plans, with what each includes.',
  description:
    'There is no free tier: generating needs a 3D plan (or a trial code). Agent plans add AI time for the agents every month, on their own or beside a 3D plan, billed monthly.',
  kind: 'read',
  auth: false,
  input: z.object({}),
  async run(ctx) {
    const pricing = await ctx.publicClient().billing.pricing()
    const plans = pricing.plans.map((plan) => {
      const monthly = plan.monthly as Price | null
      const yearly = plan.yearly as Price | null
      return {
        plan: plan.plan,
        name: plan.name,
        monthly: monthly ? { price: money(monthly.amount, monthly.currency), priceId: monthly.id } : null,
        yearly: yearly ? { price: money(yearly.amount, yearly.currency), priceId: yearly.id } : null,
        threeDCredits: plan.threeDCredits as number,
        aiTokens: plan.aiTokens as number,
        threeD: threeDEntitlements(plan.threeD),
        image: plan.image,
      }
    })
    const packs = pricing.creditPacks.map((pack) => ({
      name: pack.name as string,
      credits: pack.credits as number,
      price: money(pack.amount as number, pack.currency as string),
      priceId: pack.priceId as string,
    }))
    return { plans, creditPacks: packs, agentPlans: agentPlans(pricing).map(agentPlanRow) }
  },
  text: (r: {
    plans: Array<Record<string, unknown> & { monthly: { price: string } | null; yearly: { price: string } | null }>
    creditPacks: Array<Record<string, unknown>>
    agentPlans: ReturnType<typeof agentPlanRow>[]
  }) =>
    [
      '3D plans:',
      table(
        r.plans.map((p) => ({ ...p, monthly: p.monthly?.price ?? '-', yearly: p.yearly?.price ?? '-' })),
        ['plan', 'name', 'monthly', 'yearly', ['threeDCredits', '3d credits/mo'], ['aiTokens', 'ai tokens/mo']],
      ),
      '',
      'Credit packs (one-time, on top of a plan):',
      table(r.creditPacks, ['name', 'credits', 'price']),
      ...(r.agentPlans.length
        ? [
            '',
            'Agent plans (AI time for the agents, monthly):',
            table(
              r.agentPlans.map((a) => ({ ...a, aiTokens: num(a.aiTokens) })),
              ['name', ['aiTokens', 'ai tokens/mo'], ['approxHours', 'agent time/mo'], ['price', 'per month']],
            ),
          ]
        : []),
      '',
      'Buy: zetta billing checkout <plan> [--yearly] · --pack <credits> · --agent <name>',
      'No plan yet? A trial code gives 10 days of Basic: zetta account redeem <code>',
    ].join('\n'),
})

interface SubscriptionResult {
  plan: string
  status: string | null
  priceId: string | null
  cancelAtPeriodEnd: boolean
  currentPeriodEnd: string | null
  manageable: boolean
  aiAddOn: {
    name: string | null
    priceId: string | null
    tokens: number
    status: string | null
    cancelAtPeriodEnd: boolean
    currentPeriodEnd: string | null
  } | null
}

const unpaid = (status: string | null) => status === 'past_due' || status === 'unpaid'

export const billingSubscription = defineCommand({
  path: ['billing', 'subscription'],
  summary: 'Your subscription and Agent plan: status and renewal dates.',
  kind: 'read',
  input: z.object({}),
  async run(ctx): Promise<SubscriptionResult> {
    const client = await ctx.client()
    const sub = await client.billing.subscription()
    const addOn = sub.aiAddOn ?? null
    let name: string | null = null
    if (addOn?.priceId) {
      // Best effort: the plan's name comes from the public catalogue.
      const pricing = await client.billing.pricing().catch(() => undefined)
      const match = pricing?.aiAddOns?.find((a) => a.priceId === addOn.priceId)
      name = match ? agentTitle(match.name) : null
    }
    return {
      plan: sub.plan,
      status: sub.status,
      priceId: sub.priceId,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      currentPeriodEnd: sub.currentPeriodEnd,
      manageable: sub.manageable,
      aiAddOn: addOn
        ? {
            name,
            priceId: addOn.priceId,
            tokens: addOn.tokens,
            status: addOn.status,
            cancelAtPeriodEnd: addOn.cancelAtPeriodEnd,
            currentPeriodEnd: addOn.currentPeriodEnd,
          }
        : null,
    }
  },
  text: (r: SubscriptionResult) => {
    const renew = (cancel: boolean, end: string | null) => (end ? ` · ${cancel ? 'ends' : 'renews'} ${day(end)}` : '')
    const a = r.aiAddOn
    return [
      `Plan: ${r.plan}${r.status ? ` · ${r.status}` : ''}${renew(r.cancelAtPeriodEnd, r.currentPeriodEnd)}`,
      unpaid(r.status) ? 'The last payment failed, so the plan is paused. Update your card: `zetta billing portal`.' : '',
      a
        ? `Agent plan: ${a.name ? `${a.name} · ` : ''}${num(a.tokens)} AI tokens a month (${aiHours(a.tokens)})${a.status ? ` · ${a.status}` : ''}${renew(a.cancelAtPeriodEnd, a.currentPeriodEnd)}`
        : 'Agent plan: none (see `zetta billing plans`)',
      a && unpaid(a.status) ? "The Agent plan's last payment failed, so its tokens are paused. Update your card: `zetta billing portal`." : '',
      r.manageable ? 'Manage or cancel: zetta billing portal' : '',
    ]
      .filter(Boolean)
      .join('\n')
  },
})

async function openOrPrint(ctx: Context, url: string, what: string): Promise<{ url: string; opened: boolean }> {
  const opened = ctx.interactive && ctx.canOpenBrowser ? await openBrowser(url) : false
  if (opened) ctx.out.info(`Opened ${what} in your browser.`)
  return { url, opened }
}

interface CheckoutItem {
  kind: 'plan' | 'pack' | 'agent_plan' | 'price'
  name: string
  priceId: string
}

export const billingCheckout = defineCommand({
  path: ['billing', 'checkout'],
  summary: 'Get a secure checkout link to buy a 3D plan, a credit pack or an Agent plan.',
  description: [
    'Payment happens on the hosted checkout page in your browser; this CLI never sees card details. An agent can hand the link to a person.',
    'An account has one Agent plan at a time: to change its size, use `zetta billing agent-plan <name>`. Needs a browser sign-in.',
  ].join('\n'),
  kind: 'write',
  positionals: [{ name: 'plan' }],
  input: z.object({
    plan: z.string().optional().describe('3D plan to subscribe to (e.g. basic, creator), or a raw price id.'),
    yearly: z.boolean().optional().describe('Pay a 3D plan yearly instead of monthly.'),
    pack: z.number().int().optional().describe('Buy the credit pack with this many credits instead of a plan.'),
    agent: z.string().optional().describe('Buy this Agent plan (e.g. plus, or "Agent Plus"); see `zetta billing plans`.'),
  }),
  examples: ['zetta billing checkout creator', 'zetta billing checkout --pack 1000', 'zetta billing checkout --agent plus'],
  async run(ctx, input) {
    const chosen = [input.plan, input.pack, input.agent].filter((v) => v !== undefined).length
    if (chosen > 1) throw usageError('Buy one thing per checkout: a plan, --pack or --agent.')
    if (chosen === 0) throw usageError('Name a plan (zetta billing checkout creator), a pack (--pack 1000) or an Agent plan (--agent plus).')
    const client = await ctx.sessionClient('Buying')
    let item: CheckoutItem
    if (input.plan?.startsWith('price_')) item = { kind: 'price', name: input.plan, priceId: input.plan }
    else {
      const pricing = await client.billing.pricing()
      const agents = agentPlans(pricing)
      const agentNames = agents.map((a) => agentTitle(a.name)).join(', ') || 'none'
      if (input.pack !== undefined) {
        const pack = pricing.creditPacks.find((p) => p.credits === input.pack)
        if (!pack?.priceId) throw usageError(`There is no ${input.pack}-credit pack. Packs: ${pricing.creditPacks.map((p) => String(p.credits)).join(', ')}.`)
        item = { kind: 'pack', name: String(pack.name ?? `${input.pack} credits`), priceId: pack.priceId }
      } else if (input.agent !== undefined) {
        if (input.yearly) throw usageError('Agent plans are billed monthly; leave out --yearly.')
        const agent = findAgentPlan(agents, input.agent)
        if (!agent) throw usageError(`Unknown Agent plan "${input.agent}". Agent plans: ${agentNames}.`)
        item = { kind: 'agent_plan', name: agentTitle(agent.name), priceId: agent.priceId }
      } else {
        const query = input.plan!
        const plan = findPlan(pricing, query)
        const agent = plan ? undefined : findAgentPlan(agents, query)
        if (plan) {
          const priceId = ((input.yearly ? plan.yearly : plan.monthly) as Price | null)?.id
          if (!priceId) throw usageError(`${plan.name} has no ${input.yearly ? 'yearly' : 'monthly'} price.`)
          item = { kind: 'plan', name: String(plan.name), priceId }
        } else if (agent && !input.yearly) {
          item = { kind: 'agent_plan', name: agentTitle(agent.name), priceId: agent.priceId }
        } else {
          throw usageError(`Unknown plan "${query}". 3D plans: ${pricing.plans.map((p) => p.plan).join(', ')}. Agent plans (--agent): ${agentNames}.`)
        }
      }
    }
    const { url } = await client.billing.checkout(item.priceId)
    return { ...(await openOrPrint(ctx, url, 'checkout')), item }
  },
  text: (r: { url: string; opened: boolean; item: CheckoutItem }) =>
    r.opened ? `Finish buying ${r.item.name} in your browser.` : `Open this link to pay for ${r.item.name}:\n${r.url}`,
})

export const billingAgentPlan = defineCommand({
  path: ['billing', 'agent-plan'],
  summary: 'Switch your Agent plan to another size. The prorated difference is charged to your card at once.',
  description: [
    'Only for an Agent plan you already have; buy the first one with `zetta billing checkout --agent <name>`.',
    'A bigger plan charges the difference for the rest of this billing period to the card on file now (a smaller one is credited); a declined card changes nothing.',
    'In a terminal you are asked first; otherwise pass --yes. Needs a browser sign-in. Not offered as an MCP tool, because it charges a card.',
  ].join('\n'),
  kind: 'write',
  mcp: false,
  positionals: [{ name: 'name', required: true }],
  input: z.object({
    name: z.string().min(1).describe('The Agent plan to switch to: its name (e.g. plus, or "Agent Plus") or price id. See `zetta billing plans`.'),
    yes: z.boolean().optional().describe('Switch (and pay the difference) without asking.'),
  }),
  examples: ['zetta billing agent-plan max'],
  async run(ctx, input) {
    const client = await ctx.sessionClient('Changing the Agent plan')
    const plans = agentPlans(await client.billing.pricing())
    const target = findAgentPlan(plans, input.name)
    if (!target) throw usageError(`Unknown Agent plan "${input.name}". Agent plans: ${plans.map((a) => agentTitle(a.name)).join(', ') || 'none'}.`)
    const row = agentPlanRow(target)
    if (!input.yes) {
      const ok =
        ctx.interactive &&
        (await ctx.confirm(
          `Switch your Agent plan to ${row.name} (${row.price} a month, ${num(row.aiTokens)} AI tokens)? The difference for the rest of this period is charged to your card now.`,
        ))
      if (!ok) throw usageError(ctx.interactive ? 'Cancelled; nothing changed.' : 'This charges your card. Pass --yes to switch without a terminal.')
    }
    await client.billing.changeAgentPlan(target.priceId)
    return { changed: true, agentPlan: row }
  },
  text: (r: { agentPlan: ReturnType<typeof agentPlanRow> }) =>
    `Switched to ${r.agentPlan.name}: ${num(r.agentPlan.aiTokens)} AI tokens a month (${r.agentPlan.approxHours}), ${r.agentPlan.price} a month.\nThe difference for the rest of this period was charged to your card (or credited, for a smaller plan); the new tokens arrive once the payment is confirmed.`,
})

export const billingPortal = defineCommand({
  path: ['billing', 'portal'],
  summary: 'Get a link to manage your subscription, Agent plan, card and invoices.',
  description: 'Needs a browser sign-in.',
  kind: 'write',
  input: z.object({}),
  async run(ctx) {
    const { url } = await (await ctx.sessionClient('The billing portal')).billing.portal()
    return openOrPrint(ctx, url, 'the billing portal')
  },
  text: (r: { url: string; opened: boolean }) => (r.opened ? 'Opened the billing portal.' : `Manage billing here:\n${r.url}`),
})

export const accountCommands = [accountShow, accountCredits, accountUsage, accountRedeem, accountConnections, accountOnboarding, accountEarlyAccess, accountDelete]
export const billingCommands = [billingPlans, billingSubscription, billingCheckout, billingAgentPlan, billingPortal]
