import { apiKeyHint, isApiKey, isWellFormedApiKey, tokenExpiry, ZettaError } from '@zetta3d/sdk'
import { z } from 'zod'
import { openBrowser } from '../auth/browser'
import { startLoopbackLogin } from '../auth/loopback'
import type { Context } from '../core/context'
import { credentialKind, type CredentialKind, type StoredCredential } from '../core/credentials'
import { defineCommand } from '../core/define'
import { usageError } from '../core/errors'

type LoginMethod = 'web' | 'api_key'

interface LoginResult {
  signedIn: true
  email: string
  plan: string
  profile: string
  method: LoginMethod
  /** `session` (a 30-day token) or `api_key` (until revoked). */
  credential: CredentialKind
  /** For an API key: `zk_live_Ab3x…wxyz`. Never the key itself. */
  keyHint?: string
  storedIn: string
  expiresAt: string | null
}

/**
 * Checks a credential against the API and saves it as this profile's sign-in, replacing whatever
 * was there. Also used by `apikey create --save`.
 */
export async function saveCredential(
  ctx: Context,
  token: string,
  method: LoginMethod,
  extra: Pick<StoredCredential, 'apiKeyId'> = {},
): Promise<LoginResult> {
  const kind = credentialKind(token)
  const { user } = await ctx.makeClient(token).auth.me()
  const expiry = kind === 'session' ? tokenExpiry(token) : undefined
  const storedIn = await ctx.credentials.set(ctx.profileName, {
    token,
    email: user.email,
    userId: user.id,
    ...(expiry ? { expiresAt: expiry.toISOString() } : {}),
    savedAt: new Date().toISOString(),
    method: kind === 'api_key' ? 'api_key' : method,
    ...extra,
  })
  return {
    signedIn: true,
    email: user.email,
    plan: user.paymentPlan,
    profile: ctx.profileName,
    method: kind === 'api_key' ? 'api_key' : method,
    credential: kind,
    ...(kind === 'api_key' ? { keyHint: apiKeyHint(token) } : {}),
    storedIn: storedIn === 'keychain' ? 'system keychain' : 'credentials file',
    expiresAt: expiry?.toISOString() ?? null,
  }
}

function envOverrideWarning(ctx: Context): void {
  const set = ctx.credentials.envVarsSet()
  if (set.length) ctx.out.warn(`${set.join(' and ')} ${set.length > 1 ? 'are' : 'is'} set and wins over the saved sign-in; unset it to use what you just saved.`)
}

const renderLogin = (r: LoginResult) =>
  [
    `Signed in as ${r.email} (${r.plan} plan)${r.profile === 'default' ? '' : ` on profile "${r.profile}"`}${r.credential === 'api_key' ? ` with API key ${r.keyHint}` : ''}.`,
    r.credential === 'api_key'
      ? `Key saved in the ${r.storedIn}; it works until it is revoked. Key management and billing changes still need \`zetta auth login\`.`
      : `Token saved in the ${r.storedIn}${r.expiresAt ? `; it expires ${r.expiresAt.slice(0, 10)}` : ''}.`,
  ].join('\n')

async function readApiKey(ctx: Context): Promise<string> {
  if (ctx.interactive) {
    ctx.out.info('Paste your API key (zk_live_…). Make one with `zetta apikey create <name>` or on the website under Profile › API keys.')
    return (await ctx.askSecret('API key: ')).trim()
  }
  return (await ctx.readStdin()).trim()
}

export const authLogin = defineCommand({
  path: ['auth', 'login'],
  summary: 'Sign in to your Zetta 3D account in the browser (or with an API key).',
  description: [
    'Ways to sign in:',
    '  (default)        Opens zetta3d.ai in your browser; sign in there and click Connect.',
    '  --api-key        An API key (zk_live_…), piped on stdin or typed at a hidden prompt. For CI, scripts, servers and',
    '                   machines without a browser. Make one on the website (Profile › API keys) or with `zetta apikey create`.',
    'Instead of signing in, a script can also set ZETTA_API_KEY.',
    'An API key generates, makes pictures, runs pipelines and reads your balance; managing keys, billing and the account needs the browser sign-in.',
  ].join('\n'),
  kind: 'write',
  auth: false,
  mcp: false,
  input: z.object({
    apiKey: z.boolean().optional().describe('Sign in with an API key, read from stdin when piped, else from a hidden prompt. Never pass the key as an argument.'),
    printUrl: z.boolean().optional().describe('Print the sign-in address instead of opening the browser (open it in a browser on this computer).'),
  }),
  examples: ['zetta auth login', 'zetta auth login --api-key', 'echo "$ZETTA_API_KEY" | zetta auth login --api-key'],
  async run(ctx, input) {
    if (input.apiKey) {
      const key = await readApiKey(ctx)
      if (!key) throw usageError('No API key given. Pipe one in (echo "$ZETTA_API_KEY" | zetta auth login --api-key) or run it in a terminal to be asked.')
      if (!isApiKey(key) || !isWellFormedApiKey(key)) {
        throw usageError('That does not look like a Zetta API key. Keys start with zk_live_ and have 51 characters.')
      }
      const result = await saveCredential(ctx, key, 'api_key')
      envOverrideWarning(ctx)
      return result
    }

    // The browser hands the sign-in back to this computer (127.0.0.1), so it has to run here.
    if (!input.printUrl && !ctx.interactive) {
      throw usageError('Signing in opens a browser, so it needs a person at a terminal. For scripts, CI and agents, use an API key: set ZETTA_API_KEY.')
    }
    if (!input.printUrl && !ctx.canOpenBrowser) {
      throw usageError(
        'This computer has no browser to sign in with (a server, or an SSH session). Use an API key here: make one on zetta3d.ai (Profile › API keys), then run `zetta auth login --api-key` or set ZETTA_API_KEY. On a desktop where the browser did not open, use --print-url.',
      )
    }
    const session = await startLoopbackLogin(ctx.profile.siteUrl)
    try {
      const opened = !input.printUrl && (await openBrowser(session.url))
      ctx.out.info(opened ? 'Opened your browser. Sign in there and click Connect.' : 'Open this address in a browser on this computer, sign in and click Connect:')
      if (!opened) ctx.out.info(`  ${session.url}`)
      ctx.out.info('Waiting… (Ctrl-C to cancel)')
      const token = await session.token
      const result = await saveCredential(ctx, token, 'web')
      envOverrideWarning(ctx)
      return result
    } finally {
      session.close()
    }
  },
  text: renderLogin,
})

export const authLogout = defineCommand({
  path: ['auth', 'logout'],
  summary: 'Forget the saved sign-in (token or API key) for this profile.',
  description:
    'Only the local copy is deleted. A session token keeps working until it expires; an API key keeps working until it is revoked (`zetta apikey revoke <id>`, or on the website).',
  kind: 'write',
  auth: false,
  mcp: false,
  input: z.object({}),
  async run(ctx) {
    const saved = await ctx.credentials.get(ctx.profileName, { ignoreEnv: true })
    const removed = await ctx.credentials.delete(ctx.profileName)
    for (const name of ctx.credentials.envVarsSet()) ctx.out.warn(`${name} is still set in your environment; unset it to sign out completely.`)
    return {
      signedOut: removed,
      profile: ctx.profileName,
      ...(removed && saved ? { credential: saved.kind, ...(saved.kind === 'api_key' ? { keyHint: apiKeyHint(saved.credential.token) } : {}) } : {}),
    }
  },
  text: (r: { signedOut: boolean; credential?: CredentialKind; keyHint?: string }) =>
    !r.signedOut
      ? 'You were not signed in.'
      : r.credential === 'api_key'
        ? `Signed out. The API key ${r.keyHint} still works until you revoke it: \`zetta apikey revoke <id>\` (after \`zetta auth login\`) or on the website.`
        : 'Signed out.',
})

interface StatusResult {
  profile: string
  apiUrl: string
  signedIn: boolean
  email?: string
  plan?: string
  earlyAccess?: boolean
  /** `session` or `api_key`. */
  credential?: CredentialKind
  keyHint?: string
  /** `env`, `keychain` or `file`. */
  tokenSource?: string
  /** The variable it came from, when `tokenSource` is `env`. */
  envVar?: string
  expiresAt?: string | null
  daysLeft?: number | null
  reason?: string
  next?: string
}

function describeSource(r: StatusResult): string {
  const what = r.credential === 'api_key' ? `API key ${r.keyHint}` : 'session token'
  const from = r.tokenSource === 'env' ? (r.envVar ?? 'environment') : r.tokenSource === 'keychain' ? 'keychain' : 'credentials file'
  return `${what} from ${from}`
}

export const authStatus = defineCommand({
  path: ['auth', 'status'],
  summary: 'Show who you are signed in as, with what kind of credential, and where it comes from.',
  description:
    'The credential is the browser sign-in (30 days) or an API key (zk_live_…, until revoked). ZETTA_API_KEY wins over the saved sign-in. Keys are shown as a hint (zk_live_Ab3x…wxyz), never in full.',
  kind: 'read',
  auth: false,
  input: z.object({}),
  async run(ctx): Promise<StatusResult> {
    const stored = await ctx.storedCredential()
    const base = { profile: ctx.profileName, apiUrl: ctx.profile.apiUrl }
    if (!stored) return { ...base, signedIn: false, next: 'zetta auth login' }
    const set = ctx.credentials.envVarsSet()
    if (set.length > 1) ctx.out.warn(`${set.join(' and ')} are both set; ${set[0]} is used.`)
    const isKey = stored.kind === 'api_key'
    const source = {
      credential: stored.kind,
      ...(isKey ? { keyHint: apiKeyHint(stored.credential.token) } : {}),
      tokenSource: stored.source,
      ...(stored.envVar ? { envVar: stored.envVar } : {}),
    }
    const expiry = isKey ? undefined : stored.credential.expiresAt ? new Date(stored.credential.expiresAt) : tokenExpiry(stored.credential.token)
    const daysLeft = expiry ? Math.floor((expiry.getTime() - Date.now()) / 86_400_000) : null
    try {
      const { user } = await ctx.makeClient(stored.credential.token).auth.me()
      if (daysLeft !== null && daysLeft < 3) ctx.out.warn(`Your sign-in expires in ${Math.max(daysLeft, 0)} day(s). Run \`zetta auth login\` to renew it.`)
      return {
        ...base,
        signedIn: true,
        email: user.email,
        plan: user.paymentPlan,
        earlyAccess: user.earlyAccess,
        ...source,
        expiresAt: expiry?.toISOString() ?? null,
        daysLeft,
      }
    } catch (error) {
      if (error instanceof ZettaError && error.status === 401) {
        return {
          ...base,
          signedIn: false,
          ...source,
          reason: isKey ? 'The API key is no longer accepted (revoked, or mistyped).' : 'The saved token is no longer accepted.',
          next: isKey && stored.envVar ? `Fix or unset ${stored.envVar}, or run \`zetta auth login\`` : 'zetta auth login',
        }
      }
      throw error
    }
  },
  text: (r: StatusResult) =>
    r.signedIn
      ? `Signed in as ${String(r.email)} (${String(r.plan)} plan) · profile ${r.profile} · ${describeSource(r)}${
          r.credential === 'api_key' ? ' · does not expire' : r.daysLeft !== null && r.daysLeft !== undefined ? ` · expires in ${r.daysLeft} days` : ''
        }`
      : `Not signed in${r.reason ? `: ${r.reason}` : ''}${r.tokenSource ? ` (${describeSource(r)})` : ''}. Run \`zetta auth login\`.`,
})

export const authCommands = [authLogin, authLogout, authStatus]
