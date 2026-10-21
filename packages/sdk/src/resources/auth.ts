import { LocalErrorCodes, ZettaError } from '../errors'
import type { Transport } from '../transport'
import type { MeResponse, OnboardingAnswers, PluginTokenResponse, PublicUser, VerifyResponse } from '../types'

export const SESSION_COOKIE = 'zetta_session'

export class Auth {
  constructor(private readonly transport: Transport) {}

  /** The signed-in account, its plan and credit balances. */
  me(): Promise<MeResponse> {
    return this.transport.request<MeResponse>('GET', '/auth/me')
  }

  /** Emails a sign-in link (also creates the account on first use). The answer never says whether the address exists. */
  requestMagicLink(email: string): Promise<{ message: string }> {
    return this.transport.request('POST', '/auth/magic-link', { body: { email }, auth: false, retry: 'never' })
  }

  /**
   * Exchanges a magic-link token for a session token.
   *
   * The server puts the session in a cookie only, so the token is read from `Set-Cookie`.
   * Accepts the token itself or the whole link from the email.
   */
  async verifyMagicLink(tokenOrLink: string): Promise<{ token: string; user: PublicUser; newAccount: boolean }> {
    const token = extractMagicToken(tokenOrLink)
    const response = await this.transport.send('POST', '/auth/verify', { body: { token }, auth: false, retry: 'never' })
    const body = (await response.json()) as VerifyResponse
    const session = sessionFromSetCookie(response.headers)
    if (!session) {
      throw new ZettaError({
        code: LocalErrorCodes.INVALID_RESPONSE,
        message: 'Signed in, but the server did not return a session token.',
        status: response.status,
      })
    }
    return { token: session, user: body.user, newAccount: body.newAccount }
  }

  /** Issues a long-lived token for desktop clients (the browser hand-off page calls this). */
  pluginToken(): Promise<PluginTokenResponse> {
    return this.transport.request('POST', '/auth/plugin-token', { retry: 'never' })
  }

  /** Clears the server cookie. The token itself stays valid until it expires. */
  logout(): Promise<{ message: string }> {
    return this.transport.request('POST', '/auth/logout', { retry: 'never' })
  }

  completeOnboarding(answers: OnboardingAnswers): Promise<{ user: PublicUser; granted: boolean; onboardingBonus: unknown }> {
    return this.transport.request('POST', '/auth/onboarding/complete', { body: answers, retry: 'never' })
  }

  /** Deletes the account. Fails with SUBSCRIPTION_ACTIVE while a subscription is live. */
  deleteAccount(): Promise<{ message: string }> {
    return this.transport.request('DELETE', '/auth/account', { retry: 'never' })
  }
}

/** Accepts `…/auth/callback?token=XYZ`, `token=XYZ` or the bare token. */
export function extractMagicToken(input: string): string {
  const trimmed = input.trim()
  try {
    const url = new URL(trimmed)
    const token = url.searchParams.get('token')
    if (token) return token
  } catch {
    // not a URL
  }
  const match = /(?:^|[?&])token=([^&\s]+)/.exec(trimmed)
  return match?.[1] ? decodeURIComponent(match[1]) : trimmed
}

export function sessionFromSetCookie(headers: Headers): string | undefined {
  const cookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [headers.get('set-cookie') ?? '']
  for (const cookie of cookies) {
    const match = new RegExp(`(?:^|[;,]\\s*)${SESSION_COOKIE}=([^;]+)`).exec(cookie)
    if (match?.[1]) return decodeURIComponent(match[1])
  }
  return undefined
}

/** Reads a JWT's `exp` without verifying it (only to tell the user when to sign in again). */
export function tokenExpiry(token: string): Date | undefined {
  const part = token.split('.')[1]
  if (!part) return undefined
  try {
    const json = JSON.parse(decodeBase64Url(part)) as { exp?: unknown }
    return typeof json.exp === 'number' ? new Date(json.exp * 1000) : undefined
  } catch {
    return undefined
  }
}

function decodeBase64Url(input: string): string {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(input.length / 4) * 4, '=')
  return new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)))
}
