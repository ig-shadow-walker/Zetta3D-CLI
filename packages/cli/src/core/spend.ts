import type { Quote } from '@zetta3d/sdk'
import type { Context } from './context'
import { cliError } from './errors'

export interface SpendFlags {
  yes?: boolean
  maxCredits?: number
  dryRun?: boolean
}

export type SpendDecision = { go: true } | { go: false; dryRun: true }

/**
 * The spend guard. Every paid command calls it with the quoted price before anything is charged.
 *
 * - `--dry-run`: stop and report the price.
 * - over `--max-credits` (or the configured `spend.maxPerCommand`): refuse with SPEND_LIMIT.
 * - `--yes`, or an explicit limit that covers the price: go.
 * - in a terminal: ask (unless `spend.requireConfirm` is false).
 * - otherwise (agents, CI, MCP): refuse with SPEND_NOT_CONFIRMED, so nothing is spent by accident.
 * - MCP sessions also draw from the server's budget.
 */
export async function authorizeSpend(ctx: Context, quote: Quote, flags: SpendFlags, what: string): Promise<SpendDecision> {
  const credits = quote.credits
  if (flags.dryRun) return { go: false, dryRun: true }

  const configured = ctx.config.file.spend?.maxPerCommand
  const limit = flags.maxCredits ?? (typeof configured === 'number' ? configured : undefined)
  const details = { credits, lines: quote.lines, ...(limit !== undefined ? { limit } : {}) }

  if (ctx.budget && credits > ctx.budget.remaining) {
    throw cliError('SPEND_LIMIT', `${what} costs ${credits} credits, but only ${ctx.budget.remaining} are left in this session's budget.`, {
      ...details,
      budgetRemaining: ctx.budget.remaining,
    })
  }
  if (limit !== undefined && credits > limit) {
    throw cliError('SPEND_LIMIT', `${what} costs ${credits} credits, more than the limit of ${limit}.`, details)
  }

  // A limit someone set on purpose (flag, config, or the MCP session budget) is consent up to that limit.
  const consented =
    credits === 0 ||
    flags.yes === true ||
    flags.maxCredits !== undefined ||
    ctx.budget !== undefined ||
    (limit !== undefined && !ctx.interactive)
  if (!consented) {
    if (ctx.interactive && ctx.config.file.spend?.requireConfirm !== false) {
      const ok = await ctx.confirm(`${what} will spend ${credits} credit${credits === 1 ? '' : 's'}. Continue?`)
      if (!ok) throw cliError('SPEND_NOT_CONFIRMED', 'Cancelled; nothing was spent.', details)
    } else if (!ctx.interactive) {
      throw cliError('SPEND_NOT_CONFIRMED', `${what} costs ${credits} credits. Confirm with --yes or --max-credits ${credits}.`, details)
    }
  }

  if (ctx.budget) ctx.budget.remaining -= credits
  return { go: true }
}

/** Gives back budget when the server did not charge (an idempotent replay, or a failure before charging). */
export function refundBudget(ctx: Context, credits: number): void {
  if (ctx.budget) ctx.budget.remaining += credits
}
