import { tokenExpiry, ZettaError } from '@zetta3d/sdk'
import { z } from 'zod'
import { openBrowser } from '../auth/browser'
import { startLoopbackLogin } from '../auth/loopback'
import type { Context } from '../core/context'
import { defineCommand } from '../core/define'
import { cliError, usageError } from '../core/errors'

interface LoginResult {
  signedIn: true
  email: string
  plan: string
  profile: string
  method: 'web' | 'email' | 'token'
  storedIn: string
  expiresAt: string | null
}

async function finishLogin(ctx: Context, token: string, method: LoginResult['method']): Promise<LoginResult> {
  const { user } = await ctx.makeClient(token).auth.me()
  const expiry = tokenExpiry(token)
  const storedIn = await ctx.credentials.set(ctx.profileName, {
    token,
    email: user.email,
    userId: user.id,
    ...(expiry ? { expiresAt: expiry.toISOString() } : {}),
    savedAt: new Date().toISOString(),
    method,
  })
  return {
    signedIn: true,
    email: user.email,
    plan: user.paymentPlan,
    profile: ctx.profileName,
    method,
    storedIn: storedIn === 'keychain' ? 'system keychain' : 'credentials file',
    expiresAt: expiry?.toISOString() ?? null,
  }
}

const renderLogin = (r: LoginResult) =>
  `Signed in as ${r.email} (${r.plan} plan)${r.profile === 'default' ? '' : ` on profile "${r.profile}"`}.\nToken saved in the ${r.storedIn}${r.expiresAt ? `; it expires ${r.expiresAt.slice(0, 10)}` : ''}.`

export const authLogin = defineCommand({
  path: ['auth', 'login'],
  summary: 'Sign in to your Zetta 3D account.',
  description: [
    'Three ways to sign in:',
    '  (default)        Opens zetta3d.ai in your browser; click Connect.',
    '  --email <addr>   No browser needed: we email you a sign-in link; paste it back here.',
    '  --with-token     Reads a token from stdin (for CI and agents). Get one with `zetta auth token` on a machine where you are signed in.',
    'You can also skip signing in and set ZETTA_TOKEN.',
  ].join('\n'),
  kind: 'write',
  auth: false,
  mcp: false,
  input: z.object({
    email: z.string().email().optional().describe('Sign in with an emailed link instead of the browser.'),
    withToken: z.boolean().optional().describe('Read a token from stdin.'),
    link: z.string().optional().describe('With --email: the link (or token) from the email, if you already have it.'),
    printUrl: z.boolean().optional().describe('Print the sign-in address instead of opening a browser.'),
  }),
  examples: ['zetta auth login', 'zetta auth login --email you@example.com', 'echo "$ZETTA_TOKEN" | zetta auth login --with-token'],
  async run(ctx, input) {
    if (input.withToken) {
      const token = (await ctx.readStdin()).trim()
      if (!token) throw usageError('No token on stdin. Pipe one in: echo "$TOKEN" | zetta auth login --with-token')
      return finishLogin(ctx, token, 'token')
    }

    if (input.email || input.link) {
      let link = input.link
      if (!link) {
        if (!input.email) throw usageError('Give --email <address>.')
        await ctx.publicClient().auth.requestMagicLink(input.email)
        if (!ctx.interactive) {
          return {
            signedIn: false,
            emailSent: true,
            email: input.email,
            next: `Copy the link from the email (do not click it — it works only once) and run: zetta auth login --email ${input.email} --link "<link>"`,
          }
        }
        ctx.out.info(`We emailed a sign-in link to ${input.email}.`)
        ctx.out.info('Copy the link from the email — do not click it; it works only once — and paste it here.')
        link = (await ctx.ask('Link: ')).trim()
        if (!link) throw cliError('LOGIN_CANCELLED', 'No link given.')
      }
      const verified = await ctx.publicClient().auth.verifyMagicLink(link)
      return finishLogin(ctx, verified.token, 'email')
    }

    if (!ctx.interactive && !input.printUrl) {
      throw usageError('Signing in with the browser needs a terminal. Use --email <address>, --with-token, or set ZETTA_TOKEN.')
    }
    const session = await startLoopbackLogin(ctx.profile.siteUrl)
    try {
      const opened = !input.printUrl && ctx.canOpenBrowser && (await openBrowser(session.url))
      ctx.out.info(opened ? 'Opened your browser. Click Connect to finish signing in.' : 'Open this address in a browser on this computer and click Connect:')
      if (!opened) ctx.out.info(`  ${session.url}`)
      ctx.out.info('Waiting… (Ctrl-C to cancel; no browser here? use --email)')
      const token = await session.token
      return await finishLogin(ctx, token, 'web')
    } finally {
      session.close()
    }
  },
  text: (r: LoginResult | { signedIn: false; next: string; email: string }) =>
    'next' in r ? `Sign-in link sent to ${r.email}.\n${r.next}` : renderLogin(r),
})

export const authLogout = defineCommand({
  path: ['auth', 'logout'],
  summary: 'Forget the saved token for this profile.',
  description: 'Note: tokens cannot be revoked server-side yet, so a copied token keeps working until it expires.',
  kind: 'write',
  auth: false,
  mcp: false,
  input: z.object({}),
  async run(ctx) {
    const removed = await ctx.credentials.delete(ctx.profileName)
    if (ctx.env.ZETTA_TOKEN) ctx.out.warn('ZETTA_TOKEN is still set in your environment; unset it to sign out completely.')
    return { signedOut: removed, profile: ctx.profileName }
  },
  text: (r: { signedOut: boolean; profile: string }) => (r.signedOut ? 'Signed out.' : 'You were not signed in.'),
})

export const authStatus = defineCommand({
  path: ['auth', 'status'],
  summary: 'Show who you are signed in as, and where the token comes from.',
  kind: 'read',
  auth: false,
  input: z.object({}),
  async run(ctx) {
    const stored = await ctx.storedCredential()
    const base = { profile: ctx.profileName, apiUrl: ctx.profile.apiUrl }
    if (!stored) return { ...base, signedIn: false, next: 'zetta auth login' }
    const expiry = stored.credential.expiresAt ? new Date(stored.credential.expiresAt) : tokenExpiry(stored.credential.token)
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
        tokenSource: stored.source,
        expiresAt: expiry?.toISOString() ?? null,
        daysLeft,
      }
    } catch (error) {
      if (error instanceof ZettaError && error.status === 401) {
        return { ...base, signedIn: false, tokenSource: stored.source, reason: 'The saved token is no longer accepted.', next: 'zetta auth login' }
      }
      throw error
    }
  },
  text: (r: Record<string, unknown>) =>
    r.signedIn
      ? `Signed in as ${String(r.email)} (${String(r.plan)} plan) · profile ${String(r.profile)} · token from ${String(r.tokenSource)}${r.daysLeft !== null ? ` · expires in ${String(r.daysLeft)} days` : ''}`
      : `Not signed in${r.reason ? `: ${String(r.reason)}` : ''}. Run \`zetta auth login\`.`,
})

export const authToken = defineCommand({
  path: ['auth', 'token'],
  summary: 'Print the saved token (to copy to CI or a machine without a browser).',
  description: 'Treat it like a password: anyone with it can use your account and credits until it expires.',
  kind: 'read',
  auth: true,
  mcp: false,
  input: z.object({}),
  async run(ctx) {
    const stored = await ctx.storedCredential()
    if (!stored) throw cliError('NOT_LOGGED_IN', 'Not signed in.')
    if (ctx.out.isText) ctx.out.warn('This token gives full access to your account. Store it as a secret.')
    return { token: stored.credential.token, expiresAt: stored.credential.expiresAt ?? tokenExpiry(stored.credential.token)?.toISOString() ?? null }
  },
  text: (r: { token: string }) => r.token,
})

export const authCommands = [authLogin, authLogout, authStatus, authToken]
