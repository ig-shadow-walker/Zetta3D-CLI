import type { ApiKeySummary, ApiKeyUsage, ApiRequestEntry, ZettaClient } from '@zetta3d/sdk'
import { z } from 'zod'
import { defineCommand } from '../core/define'
import { usageError } from '../core/errors'
import { table } from '../core/output'
import { saveCredential } from './auth'

/**
 * API keys for scripts, CI and servers. Managing them needs the browser sign-in:
 * the API refuses every call here made with a key, so a leaked key cannot make or revoke keys.
 */

const MANAGE = 'Managing API keys'

const keyShape = z.string().min(1).optional().describe('One key only: its id (see `zetta apikey list`) or its name. Default: every key.')

/** `--key 12` or `--key ci`: an id as is, a name looked up among the live keys. */
async function resolveKeyId(client: ZettaClient, key: string | undefined): Promise<number | undefined> {
  if (key === undefined) return undefined
  const trimmed = key.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed)
  const keys = await client.apiKeys.list()
  const lower = trimmed.toLowerCase()
  const match = keys.find((k) => k.name.toLowerCase() === lower || k.hint === trimmed)
  if (!match) {
    throw usageError(`No API key called "${trimmed}". Keys: ${keys.map((k) => `${k.name} (#${k.id})`).join(', ') || 'none'}. Revoked keys are named by id.`)
  }
  return match.id
}

const date = (iso: string | null | undefined) => (iso ? iso.slice(0, 16).replace('T', ' ') : '-')

function keyRow(k: ApiKeySummary) {
  return { id: k.id, name: k.name, hint: k.hint, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt }
}

export const apikeyList = defineCommand({
  path: ['apikey', 'list'],
  summary: 'Your API keys: name, hint and when each was last used. Never the keys themselves.',
  description: 'Needs a browser sign-in (`zetta auth login`); API keys cannot list keys.',
  kind: 'read',
  input: z.object({}),
  async run(ctx) {
    const keys = await (await ctx.sessionClient(MANAGE)).apiKeys.list()
    return { apiKeys: keys.map(keyRow) }
  },
  text: (r: { apiKeys: ReturnType<typeof keyRow>[] }) =>
    r.apiKeys.length
      ? table(
          r.apiKeys.map((k) => ({ ...k, createdAt: date(k.createdAt), lastUsedAt: k.lastUsedAt ? date(k.lastUsedAt) : 'never' })),
          ['id', 'name', 'hint', ['createdAt', 'created'], ['lastUsedAt', 'last used']],
        )
      : 'No API keys yet. Make one with `zetta apikey create <name>`.',
})

interface CreateResult {
  apiKey: ReturnType<typeof keyRow>
  /** The whole key. Present only when it was not saved: it is shown this once and never again. */
  key?: string
  saved: boolean
  profile?: string
  storedIn?: string
  saveError?: string
}

export const apikeyCreate = defineCommand({
  path: ['apikey', 'create'],
  summary: 'Make an API key for scripts, CI or a server. The key is shown once.',
  description: [
    'Needs a paid plan and a browser sign-in. An account can have 10 keys.',
    'The whole key is printed once and never again: copy it into your secret store, then use it as ZETTA_API_KEY or with `zetta auth login --api-key`.',
    "--save stores it as this profile's sign-in instead (in the system keychain) and does not print it. That replaces the browser sign-in, so managing keys and billing will need `zetta auth login` again.",
    'Not offered as an MCP tool: a new key must not land in an agent’s context.',
  ].join('\n'),
  kind: 'write',
  mcp: false,
  positionals: [{ name: 'name', required: true }],
  input: z.object({
    name: z.string().trim().min(1).max(60).describe('What the key is for, so you can tell keys apart (at most 60 characters), e.g. "ci" or "build server".'),
    save: z.boolean().optional().describe("Save the key as this profile's sign-in (keychain) instead of printing it."),
  }),
  examples: ['zetta apikey create ci', 'zetta apikey create laptop --save'],
  async run(ctx, input): Promise<CreateResult> {
    const client = await ctx.sessionClient(MANAGE)
    const created = await client.apiKeys.create(input.name)
    const apiKey = keyRow(created.apiKey)
    if (!input.save) return { apiKey, key: created.key, saved: false }
    try {
      const login = await saveCredential(ctx, created.key, 'api_key', { apiKeyId: created.apiKey.id })
      for (const name of ctx.credentials.envVarsSet()) ctx.out.warn(`${name} is set and wins over the saved key; unset it to use the key.`)
      return { apiKey, saved: true, profile: login.profile, storedIn: login.storedIn }
    } catch (error) {
      // The key exists now; losing it would waste one of the account's 10 slots. Show it instead.
      ctx.out.warn('The key was made but could not be saved, so here it is instead.')
      return { apiKey, key: created.key, saved: false, saveError: error instanceof Error ? error.message : String(error) }
    }
  },
  text: (r: CreateResult) =>
    r.saved
      ? [
          `Created API key "${r.apiKey.name}" (#${r.apiKey.id}, ${r.apiKey.hint}) and saved it as the sign-in of profile ${String(r.profile)} (${String(r.storedIn)}). It is not shown.`,
          'Managing keys and billing now needs `zetta auth login` again.',
        ].join('\n')
      : [
          `Created API key "${r.apiKey.name}" (#${r.apiKey.id}).`,
          '',
          `  ${String(r.key)}`,
          '',
          "Copy it now: it won't be shown again. Use it as ZETTA_API_KEY, or save it on a machine with `zetta auth login --api-key`.",
        ].join('\n'),
})

export const apikeyRevoke = defineCommand({
  path: ['apikey', 'revoke'],
  summary: 'Revoke an API key. Anything using it stops working at once.',
  description: 'Needs a browser sign-in. In a terminal you are asked first; otherwise pass --yes.',
  kind: 'destructive',
  positionals: [{ name: 'id', required: true }],
  input: z.object({
    id: z.number().int().positive().describe('The key id (see `zetta apikey list`).'),
    yes: z.boolean().optional().describe('Revoke without asking.'),
  }),
  async run(ctx, input) {
    const client = await ctx.sessionClient(MANAGE)
    if (!input.yes) {
      let label = `#${input.id}`
      if (ctx.interactive) {
        const key = (await client.apiKeys.list()).find((k) => k.id === input.id)
        if (key) label = `"${key.name}" (#${key.id}, ${key.hint})`
      }
      const ok = ctx.interactive && (await ctx.confirm(`Revoke API key ${label}? Anything using it stops working at once.`))
      if (!ok) throw usageError(ctx.interactive ? 'Cancelled; nothing was revoked.' : 'Pass --yes to revoke without a terminal.')
    }
    await client.apiKeys.revoke(input.id)
    const saved = await ctx.credentials.get(ctx.profileName, { ignoreEnv: true })
    if (saved?.credential.apiKeyId === input.id) ctx.out.warn('That was the key saved for this profile; sign in again with `zetta auth login`.')
    return { revoked: true, id: input.id }
  },
  text: (r: { id: number }) => `Revoked API key #${r.id}.`,
})

export const apikeyUsage = defineCommand({
  path: ['apikey', 'usage'],
  summary: 'What your API keys did: requests, errors, jobs, credits and AI tokens over recent days.',
  description: 'Needs a browser sign-in. Covers every key unless --key names one.',
  kind: 'read',
  input: z.object({
    key: keyShape,
    days: z.number().int().min(1).max(90).optional().describe('How many days back (1–90, default 30).'),
  }),
  examples: ['zetta apikey usage', 'zetta apikey usage --key ci --days 7'],
  async run(ctx, input) {
    const client = await ctx.sessionClient(MANAGE)
    const keyId = await resolveKeyId(client, input.key)
    const usage = await client.apiKeys.usage({ ...(keyId !== undefined ? { keyId } : {}), ...(input.days !== undefined ? { days: input.days } : {}) })
    return { keyId: keyId ?? null, ...usage }
  },
  text: (r: ApiKeyUsage & { keyId: number | null }) =>
    [
      `Last ${r.days} day${r.days === 1 ? '' : 's'} (since ${r.since.slice(0, 10)}), ${r.keyId === null ? 'all keys' : `key #${r.keyId}`}:`,
      `  requests:     ${r.requests.toLocaleString('en')} (${r.errors.toLocaleString('en')} failed)`,
      `  made:         ${r.jobs} 3D job${r.jobs === 1 ? '' : 's'}, ${r.pictures} picture${r.pictures === 1 ? '' : 's'}, ${r.pipelineRuns} pipeline run${r.pipelineRuns === 1 ? '' : 's'}`,
      `  3D credits:   ${r.credits.net.toLocaleString('en')} net (${r.credits.charged.toLocaleString('en')} charged, ${r.credits.refunded.toLocaleString('en')} refunded)`,
      `  AI tokens:    ${r.aiTokens.toLocaleString('en')}`,
      ...(r.byOperation.length ? ['', table(r.byOperation, [['operationType', 'operation'], 'credits', 'count'])] : []),
      ...(r.truncated ? ['', 'Partial: the window held more jobs than could be read, so these are lower bounds.'] : []),
    ].join('\n'),
})

function subjectLabel(subject: ApiRequestEntry['subjects'][number]): string {
  if (subject.type === 'gen3d_post') return `asset:${subject.id}`
  if (subject.type === 'gen2d_post') return `image:${subject.id}`
  return `run:${subject.id}`
}

export const apikeyLogs = defineCommand({
  path: ['apikey', 'logs'],
  summary: 'Requests made with your API keys, newest first (kept 90 days).',
  description: 'Needs a browser sign-in. Each row: when, which key, the call, its status and what it made.',
  kind: 'read',
  input: z.object({
    key: keyShape,
    errors: z.boolean().optional().describe('Only failed requests (status 400 and up).'),
    before: z.number().int().positive().optional().describe('Older than this request id (the `nextCursor` of the previous page).'),
    limit: z.number().int().min(1).max(100).optional().describe('Requests per page (1–100, default 50).'),
  }),
  examples: ['zetta apikey logs --errors', 'zetta apikey logs --key ci --limit 100'],
  async run(ctx, input) {
    const client = await ctx.sessionClient(MANAGE)
    const keyId = await resolveKeyId(client, input.key)
    const page = await client.apiKeys.logs({
      ...(keyId !== undefined ? { keyId } : {}),
      ...(input.before !== undefined ? { before: input.before } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.errors ? { errors: true } : {}),
    })
    const names = new Map(page.keys.map((k) => [k.id, k.revoked ? `${k.name} (revoked)` : k.name]))
    return {
      requests: page.items.map((item) => ({
        id: item.id,
        date: item.createdAt,
        keyId: item.apiKeyId,
        key: names.get(item.apiKeyId) ?? `#${item.apiKeyId}`,
        method: item.method,
        path: item.path,
        route: item.route,
        status: item.statusCode,
        durationMs: item.durationMs,
        errorCode: item.errorCode,
        made: item.subjects.map(subjectLabel),
        aiTokens: item.aiTokens,
      })),
      nextCursor: page.nextCursor,
    }
  },
  text: (r: { requests: Array<Record<string, unknown> & { date: string; made: string[] }>; nextCursor: number | null }) =>
    r.requests.length
      ? `${table(
          r.requests.map((q) => ({ ...q, date: date(q.date), made: q.made.join(' ') })),
          ['date', 'key', 'method', 'path', 'status', ['durationMs', 'ms'], ['errorCode', 'error'], 'made'],
        )}${r.nextCursor ? `\nMore: --before ${r.nextCursor}` : ''}`
      : 'No requests in this window.',
})

export const apikeyCommands = [apikeyList, apikeyCreate, apikeyRevoke, apikeyUsage, apikeyLogs]
