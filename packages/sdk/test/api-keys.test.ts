import { describe, expect, it } from 'vitest'
import { ZettaClient } from '../src/client'
import { errorFromResponse } from '../src/errors'
import { apiKeyHint, isApiKey, isWellFormedApiKey } from '../src/resources/api-keys'
import { tokenExpiry } from '../src/resources/auth'
import { Transport } from '../src/transport'
import { fakeFetch, noSleep } from './fake-fetch'

const KEY = `zk_live_${'A'.repeat(39)}wxyz`
const API = 'https://api.test/api'

describe('API keys', () => {
  it('are recognised by shape and hinted, never decoded as a JWT', () => {
    expect(KEY).toHaveLength(51)
    expect(isApiKey(KEY)).toBe(true)
    expect(isWellFormedApiKey(KEY)).toBe(true)
    expect(isWellFormedApiKey('zk_live_short')).toBe(false)
    expect(isApiKey('eyJhbGciOiJIUzI1NiJ9.e30.sig')).toBe(false)
    expect(apiKeyHint(KEY)).toBe('zk_live_AAAA…wxyz')
    // A key with dots in the right places must still not be read as a token with an expiry.
    expect(tokenExpiry(KEY)).toBeUndefined()
    expect(tokenExpiry(`zk_live_x.${Buffer.from(JSON.stringify({ exp: 2_000_000_000 })).toString('base64url')}.y`)).toBeUndefined()
  })

  it('are sent as a Bearer credential, and only to the API itself', async () => {
    const { fetch, calls } = fakeFetch([
      [`GET ${API}/auth/me`, { json: { user: { id: 1 }, onboardingBonus: 0 } }],
      ['GET https://elsewhere.example/file', { json: {} }],
    ])
    const t = new Transport({ baseUrl: API, token: KEY, fetch, sleep: noSleep })
    await t.request('GET', '/auth/me')
    await t.request('GET', 'https://elsewhere.example/file')
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`)
    expect(calls[1]!.headers.authorization).toBeUndefined()
  })

  it('manage keys, trials, connections and Agent plans through the client', async () => {
    const { fetch, calls } = fakeFetch([
      [`GET ${API}/api-keys/usage`, { json: { days: 7 } }],
      [`GET ${API}/api-keys/logs`, { json: { items: [], nextCursor: null, keys: [] } }],
      [`GET ${API}/api-keys`, { json: { apiKeys: [{ id: 3, name: 'ci', hint: 'zk_live_AAAA…wxyz', createdAt: 'x', lastUsedAt: null }] } }],
      [`POST ${API}/api-keys`, { status: 201, json: { key: KEY, apiKey: { id: 4, name: 'new' } } }],
      [`DELETE ${API}/api-keys/3`, { status: 204 }],
      [`POST ${API}/trials/redeem`, { json: { trialEndsAt: '2026-12-06T00:00:00Z', plan: 'basic' } }],
      [`GET ${API}/auth/connections`, { json: { connections: [{ client: 'cli' }] } }],
      [`POST ${API}/billing/ai-add-on/change`, { json: { changed: true } }],
      [`GET ${API}/billing/usage/breakdown`, { json: { meter: 'ai_token', total: 5 } }],
      [`GET ${API}/billing/usage`, { json: { entries: [], nextCursor: null } }],
    ])
    const zetta = new ZettaClient({ baseUrl: API, token: 'session', fetch, sleep: noSleep })
    expect((await zetta.apiKeys.list())[0]!.name).toBe('ci')
    expect((await zetta.apiKeys.create('new')).key).toBe(KEY)
    await zetta.apiKeys.revoke(3)
    await zetta.apiKeys.usage({ keyId: 3, days: 7 })
    await zetta.apiKeys.logs({ keyId: 3, errors: true, limit: 10 })
    expect((await zetta.trials.redeem('zetta-7kq2-m9xd')).plan).toBe('basic')
    expect((await zetta.auth.connections())[0]!.client).toBe('cli')
    expect(await zetta.billing.changeAgentPlan('price_ai_l')).toEqual({ changed: true })
    await zetta.billing.usage({ meter: 'ai_token', limit: 5 })
    await zetta.billing.usageBreakdown('ai_token')

    const url = (end: string) => new URL(calls.find((c) => c.url.includes(end))!.url)
    expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/api-keys'))!.body).toEqual({ name: 'new' })
    expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/api-keys/3'))).toBe(true)
    expect(url('/api-keys/usage').search).toBe('?keyId=3&days=7')
    expect(url('/api-keys/logs').search).toBe('?keyId=3&errors=true&limit=10')
    expect(calls.find((c) => c.url.endsWith('/trials/redeem'))!.body).toEqual({ code: 'zetta-7kq2-m9xd' })
    expect(calls.find((c) => c.url.endsWith('/ai-add-on/change'))!.body).toEqual({ priceId: 'price_ai_l' })
    expect(url('/billing/usage?').searchParams.get('meter')).toBe('ai_token')
    expect(url('/usage/breakdown').searchParams.get('meter')).toBe('ai_token')
  })
})

describe('rate limits', () => {
  it('wait out Retry-After, and report the wait', async () => {
    const waits: number[] = []
    const retries: number[] = []
    const { fetch, calls } = fakeFetch([
      [`GET ${API}/3d/generations`, [{ status: 429, json: { code: 'RATE_LIMITED', retryAfter: 7 }, headers: { 'retry-after': '7' } }, { json: { items: [] } }]],
    ])
    const t = new Transport({
      baseUrl: API,
      fetch,
      sleep: async (ms) => void waits.push(ms),
      onRetry: (info) => void retries.push(info.status),
    })
    await t.request('GET', '/3d/generations')
    expect(calls).toHaveLength(2)
    expect(waits).toEqual([7000])
    expect(retries).toEqual([429])
  })

  it('fail at once when the wait is longer than a minute, saying how long', async () => {
    const waits: number[] = []
    const { fetch, calls } = fakeFetch([[`GET ${API}/3d/generations`, { status: 429, json: { code: 'RATE_LIMITED', retryAfter: 1800 }, headers: { 'retry-after': '1800' } }]])
    const t = new Transport({ baseUrl: API, fetch, sleep: async (ms) => void waits.push(ms) })
    await expect(t.request('GET', '/3d/generations')).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429, details: { retryAfter: 1800 } })
    expect(calls).toHaveLength(1)
    expect(waits).toEqual([])
  })

  it('say when to try again', () => {
    expect(errorFromResponse(429, { code: 'RATE_LIMITED', retryAfter: 1 }, '1').message).toBe('Too many requests. Try again in 1 second.')
    expect(errorFromResponse(429, { code: 'RATE_LIMITED' }).message).toBe('Too many requests. Slow down and try again shortly.')
    expect(errorFromResponse(429, {}, '42').details.retryAfter).toBe(42)
  })
})
