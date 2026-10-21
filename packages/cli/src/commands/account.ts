import type { CreditPool, PublicUser, UsageEntry } from '@zetta3d/sdk'
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

export const accountShow = defineCommand({
  path: ['account', 'show'],
  summary: 'Your account: email, plan, credits and access.',
  kind: 'read',
  input: z.object({}),
  async run(ctx) {
    const { user } = await (await ctx.client()).auth.me()
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      plan: user.paymentPlan,
      subscriptionStatus: user.subscriptionStatus,
      earlyAccess: user.earlyAccess,
      onboardingDone: Boolean(user.onboardingCompletedAt),
      credits: credits(user),
      createdAt: user.createdAt,
    }
  },
  text: (r: { email: string; plan: string; credits: ReturnType<typeof credits>; earlyAccess: boolean; onboardingDone: boolean }) =>
    [
      `${r.email} · ${r.plan} plan${r.earlyAccess ? ' · early access' : ''}`,
      `3D credits: ${r.credits.threeD.total}   AI tokens: ${r.credits.ai.total}`,
      r.onboardingDone ? '' : 'Tip: `zetta account onboarding` pays a one-time credit bonus.',
    ]
      .filter(Boolean)
      .join('\n'),
})

export const accountCredits = defineCommand({
  path: ['account', 'credits'],
  summary: 'Your credit balances, per pool.',
  description: '3D credits pay for generations and finishing tools (1 credit = €0.01). AI tokens pay for AI helpers such as auto-tagging.',
  kind: 'read',
  input: z.object({}),
  async run(ctx) {
    const { user } = await (await ctx.client()).auth.me()
    return { plan: user.paymentPlan, ...credits(user) }
  },
  text: (r: { plan: string } & ReturnType<typeof credits>) =>
    [
      `Plan: ${r.plan}`,
      table(
        [
          { pool: '3D credits', ...r.threeD },
          { pool: 'AI tokens', ...r.ai },
        ],
        ['pool', 'total', 'monthly', ['bonusMonthly', 'monthly bonus'], 'bonus', 'purchased'],
      ),
    ].join('\n'),
})

/** Our own fields only: refund reasons can quote upstream error codes. */
function usageRow(entry: UsageEntry) {
  return {
    id: entry.id,
    date: entry.createdAt,
    meter: entry.meter === 'three_d_credit' ? '3d_credits' : entry.meter === 'ai_token' ? 'ai_tokens' : entry.meter,
    type: entry.entryType,
    amount: entry.amount,
    operation: entry.operationType,
    subject: entry.subjectType && entry.subjectId !== null ? `${entry.subjectType}:${String(entry.subjectId)}` : null,
  }
}

export const accountUsage = defineCommand({
  path: ['account', 'usage'],
  summary: 'Your credit history: what was charged and refunded.',
  kind: 'read',
  input: z.object({
    limit: z.number().int().min(1).max(100).optional().describe('Entries per page (max 100).'),
    before: z.string().optional().describe('Show entries older than this cursor (the `nextCursor` of the previous page).'),
    all: z.boolean().optional().describe('Fetch every page.'),
  }),
  async run(ctx, input) {
    const client = await ctx.client()
    const rows: ReturnType<typeof usageRow>[] = []
    let cursor = input.before
    for (;;) {
      const page = await client.billing.usage({ limit: input.limit ?? 25, ...(cursor ? { before: cursor } : {}) })
      rows.push(...page.entries.map(usageRow))
      cursor = page.nextCursor ?? undefined
      if (!input.all || !cursor) return { entries: rows, nextCursor: cursor ?? null }
    }
  },
  text: (r: { entries: Array<Record<string, unknown>>; nextCursor: string | null }) =>
    `${table(r.entries, [['date', 'date'], 'meter', 'type', 'amount', 'operation', 'subject'])}${r.nextCursor ? `\nMore: --before ${r.nextCursor}` : ''}`,
})

const ONBOARDING = {
  userType: ['company', 'startup', 'personal'],
  industry: ['gaming', 'film', 'ecommerce', 'printing', 'architecture', 'interior', 'fashion', 'xr', 'other'],
  heardFrom: ['google', 'word-of-mouth', 'linkedin', 'youtube', 'x', 'friend', 'other'],
} as const

export const accountOnboarding = defineCommand({
  path: ['account', 'onboarding'],
  summary: 'Answer the five onboarding questions and get the one-time credit bonus.',
  description: 'Answers use the ids the web onboarding uses. Calling it again is harmless; the bonus is paid once.',
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
    const result = await (await ctx.client()).auth.completeOnboarding(input)
    return { granted: result.granted, credits: credits(result.user) }
  },
  text: (r: { granted: boolean; credits: ReturnType<typeof credits> }) =>
    r.granted ? `Thanks! Bonus added. 3D credits now: ${r.credits.threeD.total}.` : 'Onboarding was already complete; no new bonus.',
})

export const accountEarlyAccess = defineCommand({
  path: ['account', 'early-access'],
  summary: 'Ask for access to an early-access feature (e.g. splat).',
  kind: 'write',
  positionals: [{ name: 'feature', required: true }],
  input: z.object({
    feature: z.string().describe('The feature to ask for, e.g. "Zetta Splat".'),
    email: z.string().email().optional().describe('Where to reach you, if not your account email.'),
  }),
  async run(ctx, input) {
    return (await ctx.client()).tools.requestEarlyAccess(input.feature, input.email)
  },
  text: (r: { status: string; email: string }) =>
    r.status === 'granted' ? 'You already have access.' : `Request ${r.status}. We'll write to ${r.email}.`,
})

export const accountDelete = defineCommand({
  path: ['account', 'delete'],
  summary: 'Delete your account and everything in it. Cannot be undone.',
  description: 'Only works in a terminal, after typing your email to confirm. Cancel any subscription first (`zetta billing portal`).',
  kind: 'destructive',
  mcp: false,
  input: z.object({}),
  async run(ctx: Context) {
    if (!ctx.interactive) throw usageError('Deleting an account needs a terminal, so a person confirms it.')
    const client = await ctx.client()
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

export const billingPlans = defineCommand({
  path: ['billing', 'plans'],
  summary: 'Plans, what each includes, and credit packs.',
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
        threeD: plan.threeD,
        image: plan.image,
      }
    })
    const packs = pricing.creditPacks.map((pack) => ({
      name: pack.name as string,
      credits: pack.credits as number,
      price: money(pack.amount as number, pack.currency as string),
      priceId: pack.priceId as string,
    }))
    return { plans, creditPacks: packs }
  },
  text: (r: { plans: Array<Record<string, unknown> & { monthly: { price: string } | null; yearly: { price: string } | null }>; creditPacks: Array<Record<string, unknown>> }) =>
    [
      table(
        r.plans.map((p) => ({ ...p, monthly: p.monthly?.price ?? '-', yearly: p.yearly?.price ?? '-' })),
        ['plan', 'name', 'monthly', 'yearly', ['threeDCredits', '3d credits/mo'], ['aiTokens', 'ai tokens']],
      ),
      '',
      'Credit packs:',
      table(r.creditPacks, ['name', 'credits', 'price']),
      '',
      'Buy: zetta billing checkout <plan> [--yearly], or zetta billing checkout --pack <credits>',
    ].join('\n'),
})

export const billingSubscription = defineCommand({
  path: ['billing', 'subscription'],
  summary: 'Your subscription: plan, status and renewal date.',
  kind: 'read',
  input: z.object({}),
  async run(ctx) {
    return (await ctx.client()).billing.subscription()
  },
})

async function openOrPrint(ctx: Context, url: string, what: string): Promise<{ url: string; opened: boolean }> {
  const opened = ctx.interactive && ctx.canOpenBrowser ? await openBrowser(url) : false
  if (opened) ctx.out.info(`Opened ${what} in your browser.`)
  return { url, opened }
}

export const billingCheckout = defineCommand({
  path: ['billing', 'checkout'],
  summary: 'Get a secure checkout link to buy a plan or a credit pack.',
  description: 'Payment happens on the hosted checkout page in your browser; this CLI never sees card details. An agent can hand the link to a person.',
  kind: 'write',
  positionals: [{ name: 'plan' }],
  input: z.object({
    plan: z.string().optional().describe('Plan to subscribe to (e.g. basic, creator), or a raw price id.'),
    yearly: z.boolean().optional().describe('Pay yearly instead of monthly.'),
    pack: z.number().int().optional().describe('Buy the credit pack with this many credits instead of a plan.'),
  }),
  examples: ['zetta billing checkout creator', 'zetta billing checkout --pack 1000'],
  async run(ctx, input) {
    const client = await ctx.client()
    let priceId: string | undefined
    if (input.plan?.startsWith('price_')) priceId = input.plan
    else {
      const pricing = await client.billing.pricing()
      if (input.pack !== undefined) {
        const pack = pricing.creditPacks.find((p) => p.credits === input.pack)
        if (!pack) throw usageError(`There is no ${input.pack}-credit pack. Packs: ${pricing.creditPacks.map((p) => String(p.credits)).join(', ')}.`)
        priceId = pack.priceId
      } else if (input.plan) {
        const plan = pricing.plans.find((p) => p.plan === input.plan || String(p.name).toLowerCase() === input.plan!.toLowerCase())
        if (!plan) throw usageError(`Unknown plan "${input.plan}". Plans: ${pricing.plans.map((p) => p.plan).join(', ')}.`)
        priceId = ((input.yearly ? plan.yearly : plan.monthly) as Price | null)?.id
        if (!priceId) throw usageError(`${plan.name} has no ${input.yearly ? 'yearly' : 'monthly'} price.`)
      } else throw usageError('Name a plan (zetta billing checkout creator) or a pack (--pack 1000).')
    }
    const { url } = await client.billing.checkout(priceId!)
    return openOrPrint(ctx, url, 'checkout')
  },
  text: (r: { url: string; opened: boolean }) => (r.opened ? 'Finish the purchase in your browser.' : `Open this link to pay:\n${r.url}`),
})

export const billingPortal = defineCommand({
  path: ['billing', 'portal'],
  summary: 'Get a link to manage your subscription, card and invoices.',
  kind: 'write',
  input: z.object({}),
  async run(ctx) {
    const { url } = await (await ctx.client()).billing.portal()
    return openOrPrint(ctx, url, 'the billing portal')
  },
  text: (r: { url: string; opened: boolean }) => (r.opened ? 'Opened the billing portal.' : `Manage billing here:\n${r.url}`),
})

export const accountCommands = [accountShow, accountCredits, accountUsage, accountOnboarding, accountEarlyAccess, accountDelete]
export const billingCommands = [billingPlans, billingSubscription, billingCheckout, billingPortal]
