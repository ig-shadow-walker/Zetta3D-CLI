import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { exitCodeFor } from '../src/core/exit-codes'
import { hintFor } from '../src/core/hints'
import { fakeFetch } from './fake-fetch'
import { saveSignIn, tokenFor, user, zetta } from './harness'

const API = 'https://api.zetta3d.ai/api'
const KEY = `zk_live_${'Ab3x'.repeat(9)}abcwxyz`
const OTHER_KEY = `zk_live_${'Q'.repeat(39)}zzzz`
/** No credential leaks in from the shell running the tests. */
const clean = { ZETTA_API_KEY: '', ZETTA_TOKEN: '' }
const session = { ...clean, ZETTA_TEST_SIGN_IN: tokenFor() }
const withKey = { ...clean, ZETTA_API_KEY: KEY }
const me = (extra: Record<string, unknown> = {}, bonus: number | null = 0) => ({ json: { user: { ...user, ...extra }, onboardingBonus: bonus } })
const configDir = () => mkdtempSync(join(tmpdir(), 'zab-'))

describe('signing in with an API key', () => {
  it('reads the key from stdin, checks it, saves it, and never prints it', async () => {
    const dir = configDir()
    const { fetch, calls } = fakeFetch([[`GET ${API}/auth/me`, me()]])
    const login = await zetta(['auth', 'login', '--api-key'], { fetch, stdin: `${KEY}\n`, configDir: dir, env: clean })
    expect(login.code).toBe(0)
    expect(login.json()).toMatchObject({ signedIn: true, credential: 'api_key', method: 'api_key', keyHint: 'zk_live_Ab3x…wxyz', expiresAt: null })
    expect(login.stdout).not.toContain(KEY)
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`)
    expect(JSON.parse(readFileSync(join(dir, 'credentials.json'), 'utf8')).default).toMatchObject({ token: KEY, method: 'api_key' })

    const status = await zetta(['auth', 'status'], { fetch, configDir: dir, env: clean })
    expect(status.json()).toMatchObject({ signedIn: true, credential: 'api_key', keyHint: 'zk_live_Ab3x…wxyz', tokenSource: 'file', expiresAt: null, daysLeft: null })
    expect(status.stdout).not.toContain(KEY)
    const text = await zetta(['auth', 'status'], { fetch, configDir: dir, env: clean, tty: true })
    expect(text.stdout).toContain('API key zk_live_Ab3x…wxyz from credentials file · does not expire')

    // A key is never decoded as a token: commands run with it, with no expiry check.
    const show = await zetta(['account', 'show'], { fetch, configDir: dir, env: clean })
    expect(show.code).toBe(0)

    // The CLI does not hand a key back out (there is no `auth token` any more).
    const token = await zetta(['auth', 'token'], { configDir: dir, env: clean })
    expect(token.code).not.toBe(0)
    expect(token.stdout + token.stderr).not.toContain(KEY)

    const logout = await zetta(['auth', 'logout'], { configDir: dir, env: clean, tty: true })
    expect(logout.stdout).toContain('still works until you revoke it')
  })

  it('asks for the key at a hidden prompt in a terminal, without echoing it', async () => {
    const { fetch } = fakeFetch([[`GET ${API}/auth/me`, me()]])
    const run = await zetta(['auth', 'login', '--api-key'], { fetch, stdin: `${KEY}\n`, tty: true, env: clean })
    expect(run.code).toBe(0)
    expect(run.stderr).toContain('API key: ')
    expect(run.stdout + run.stderr).not.toContain(KEY)
    expect(run.stdout).toContain('with API key zk_live_Ab3x…wxyz')
  })

  it('refuses something that is not a key, without calling the API', async () => {
    const { fetch, calls } = fakeFetch([])
    const run = await zetta(['auth', 'login', '--api-key'], { fetch, stdin: 'zk_live_tooshort', env: clean })
    expect(run.code).toBe(2)
    expect(calls).toHaveLength(0)
    expect((await zetta(['auth', 'login', '--api-key'], { fetch, env: clean })).code).toBe(2)
  })

  it('reports a refused key as INVALID_API_KEY with exit 3', async () => {
    const { fetch } = fakeFetch([[`GET ${API}/auth/me`, { status: 401, json: { code: 'INVALID_API_KEY', message: 'Invalid API key.' } }]])
    const run = await zetta(['auth', 'login', '--api-key'], { fetch, stdin: KEY, env: clean })
    expect(run.code).toBe(3)
    expect(run.errorJson().error.hint).toContain('zetta apikey create')
    const status = await zetta(['auth', 'status'], { fetch, env: withKey })
    expect(status.json()).toMatchObject({ signedIn: false, credential: 'api_key', envVar: 'ZETTA_API_KEY' })
  })
})

describe('credential precedence', () => {
  it('ZETTA_API_KEY, then the browser sign-in; nothing else is read', async () => {
    const dir = configDir()
    const { fetch, calls } = fakeFetch([[`GET ${API}/auth/me`, me()]])
    saveSignIn(dir, tokenFor())

    const saved = await zetta(['auth', 'status'], { fetch, configDir: dir, env: clean })
    expect(saved.json()).toMatchObject({ credential: 'session', tokenSource: 'file' })

    const withKey = await zetta(['auth', 'status'], { fetch, configDir: dir, env: { ...clean, ZETTA_API_KEY: OTHER_KEY } })
    expect(withKey.json()).toMatchObject({ credential: 'api_key', tokenSource: 'env', envVar: 'ZETTA_API_KEY', keyHint: 'zk_live_QQQQ…zzzz' })
    expect(calls.at(-1)!.headers.authorization).toBe(`Bearer ${OTHER_KEY}`)

    // ZETTA_TOKEN is ignored: the saved sign-in is used.
    const oldVariable = await zetta(['auth', 'status'], { fetch, configDir: dir, env: { ...clean, ZETTA_TOKEN: KEY } })
    expect(oldVariable.json()).toMatchObject({ credential: 'session', tokenSource: 'file' })

    // ZETTA_API_KEY takes only an API key, never a session token.
    const notAKey = await zetta(['auth', 'status'], { fetch, configDir: dir, env: { ...clean, ZETTA_API_KEY: tokenFor() } })
    expect(notAKey.code).toBe(3)
    expect(notAKey.errorJson().error.code).toBe('INVALID_API_KEY')
  })
})

describe('commands that need a browser sign-in', () => {
  it('stop before calling the API when the credential is a key', async () => {
    const { fetch, calls } = fakeFetch([])
    for (const args of [['apikey', 'list'], ['account', 'redeem', 'ZETTA-7KQ2-M9XD'], ['account', 'connections'], ['billing', 'portal'], ['billing', 'checkout', 'price_x']]) {
      const run = await zetta(args, { fetch, env: withKey })
      expect(run.code, args.join(' ')).toBe(3)
      expect(run.errorJson().error).toMatchObject({ code: 'API_KEY_NOT_ALLOWED', details: { envVar: 'ZETTA_API_KEY' } })
      expect(run.errorJson().error.hint).toContain('zetta auth login')
    }
    expect(calls).toHaveLength(0)
  })

  it('explain the server refusing a key, and the key-only limits', async () => {
    const { fetch } = fakeFetch([[`GET ${API}/billing/subscription`, { status: 403, json: { code: 'API_KEY_NOT_ALLOWED', message: 'This endpoint is not available with an API key.' } }]])
    const run = await zetta(['billing', 'subscription'], { fetch, env: withKey })
    expect(run.code).toBe(3)
    expect(run.errorJson().error.hint).toContain('zetta auth login')
    expect(exitCodeFor('SPLAT_NOT_IN_API', 403)).toBe(4)
    expect(exitCodeFor('PIPELINE_EDIT_NOT_ALLOWED', 403)).toBe(4)
    expect(hintFor('SPLAT_NOT_IN_API')).toContain('API key')
    expect(hintFor('PIPELINE_EDIT_NOT_ALLOWED')).toContain('API key')
  })
})

describe('apikey', () => {
  const summary = { id: 12, name: 'ci', hint: 'zk_live_Ab3x…wxyz', createdAt: '2026-11-25T10:00:00Z', lastUsedAt: null }

  it('creates a key and shows it once', async () => {
    const { fetch, calls } = fakeFetch([[`POST ${API}/api-keys`, { status: 201, json: { key: KEY, apiKey: summary } }]])
    const json = await zetta(['apikey', 'create', 'ci'], { fetch, env: session })
    expect(json.code).toBe(0)
    expect(json.json()).toMatchObject({ key: KEY, saved: false, apiKey: { id: 12, name: 'ci' } })
    expect(calls[0]!.body).toEqual({ name: 'ci' })
    const text = await zetta(['apikey', 'create', 'ci'], { fetch, env: session, tty: true })
    expect(text.stdout).toContain(KEY)
    expect(text.stdout).toContain("won't be shown again")
    expect((await zetta(['apikey', 'create', 'x'.repeat(61)], { fetch, env: session })).code).toBe(2)
  })

  it('--save stores the key as this profile’s sign-in and does not print it', async () => {
    const dir = configDir()
    const { fetch } = fakeFetch([
      [`POST ${API}/api-keys`, { status: 201, json: { key: KEY, apiKey: summary } }],
      [`GET ${API}/auth/me`, me()],
    ])
    saveSignIn(dir, tokenFor())
    const run = await zetta(['apikey', 'create', 'laptop', '--save'], { fetch, configDir: dir, env: clean })
    expect(run.code).toBe(0)
    expect(run.stdout).not.toContain(KEY)
    expect(run.json()).toMatchObject({ saved: true, profile: 'default' })
    expect(JSON.parse(readFileSync(join(dir, 'credentials.json'), 'utf8')).default).toMatchObject({ token: KEY, apiKeyId: 12 })
  })

  it('is refused with a plan hint on an account without a plan', async () => {
    const { fetch } = fakeFetch([[`POST ${API}/api-keys`, { status: 403, json: { code: 'PLAN_REQUIRED', message: 'Choose a plan to start generating.' } }]])
    const run = await zetta(['apikey', 'create', 'ci'], { fetch, env: session })
    expect(run.code).toBe(4)
    expect(run.errorJson().error.hint).toContain('zetta account redeem')
    expect(run.errorJson().error.hint).toContain('zetta billing plans')
  })

  it('lists, revokes (with --yes when piped), and names keys in usage and logs', async () => {
    const { fetch, calls } = fakeFetch([
      [`GET ${API}/api-keys/usage`, { json: { since: '2026-10-27T00:00:00Z', days: 7, requests: 10, errors: 1, jobs: 2, pictures: 0, pipelineRuns: 0, credits: { charged: 80, refunded: 0, net: 80 }, byOperation: [{ operationType: 'textured', credits: 80, count: 2 }], aiTokens: 0, daily: [], truncated: false } }],
      [`GET ${API}/api-keys/logs`, { json: { items: [{ id: 99, apiKeyId: 12, method: 'POST', route: '/3d/generations', path: '/3d/generations', statusCode: 201, durationMs: 120, errorCode: null, subjects: [{ type: 'gen3d_post', id: 7 }], aiTokens: null, createdAt: '2026-11-25T10:00:00Z' }], nextCursor: 98, keys: [{ ...summary, revoked: false }] } }],
      [`GET ${API}/api-keys`, { json: { apiKeys: [summary] } }],
      [`DELETE ${API}/api-keys/12`, { status: 204 }],
    ])
    expect((await zetta(['apikey', 'list'], { fetch, env: session })).json().apiKeys[0]).toMatchObject({ id: 12, hint: 'zk_live_Ab3x…wxyz' })

    expect((await zetta(['apikey', 'revoke', '12'], { fetch, env: session })).code).toBe(2)
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    expect((await zetta(['apikey', 'revoke', '12', '--yes'], { fetch, env: session })).json()).toEqual({ revoked: true, id: 12 })

    const usage = await zetta(['apikey', 'usage', '--key', 'ci', '--days', '7'], { fetch, env: session })
    expect(usage.json()).toMatchObject({ keyId: 12, requests: 10, credits: { net: 80 } })
    expect(new URL(calls.find((c) => c.url.includes('/api-keys/usage'))!.url).search).toBe('?keyId=12&days=7')

    const logs = await zetta(['apikey', 'logs', '--errors', '--limit', '5', '--before', '200'], { fetch, env: session })
    expect(logs.json()).toMatchObject({ requests: [{ key: 'ci', status: 201, made: ['asset:7'] }], nextCursor: 98 })
    const query = new URL(calls.find((c) => c.url.includes('/api-keys/logs'))!.url).searchParams
    expect([query.get('errors'), query.get('limit'), query.get('before')]).toEqual(['true', '5', '200'])

    expect((await zetta(['apikey', 'usage', '--key', 'nope'], { fetch, env: session })).code).toBe(2)
  })
})

describe('account', () => {
  it('shows the trial, the Agent plan, and a bonus only when there is one', async () => {
    const trial = { trial: { endsAt: '2026-12-06T10:00:00Z', plan: 'basic' }, trialAvailable: false, agentPlan: true, paymentPlan: 'basic' }
    const { fetch } = fakeFetch([[`GET ${API}/auth/me`, me(trial, 0)]])
    const run = await zetta(['account', 'show'], { fetch, env: session })
    expect(run.json()).toMatchObject({ plan: 'basic', trial: { endsAt: '2026-12-06T10:00:00Z', plan: 'basic' }, trialAvailable: false, agentPlan: true, onboardingBonus: 0 })
    const text = await zetta(['account', 'show'], { fetch, env: session, tty: true })
    expect(text.stdout).toContain('Free trial of basic until 2026-12-06')
    expect(text.stdout).toContain('Agent plan')
    expect(text.stdout).not.toContain('onboarding')
  })

  it('tells an account without a plan how to get one', async () => {
    const { fetch } = fakeFetch([[`GET ${API}/auth/me`, me({ paymentPlan: 'free', trialAvailable: true, trial: null }, 0)]])
    const text = await zetta(['account', 'show'], { fetch, env: session, tty: true })
    expect(text.stdout).toContain('No plan yet')
    expect(text.stdout).toContain('zetta account redeem <code>')
    expect(text.stdout).not.toContain('bonus')
    const credits = await zetta(['account', 'credits'], { fetch, env: session })
    expect(credits.json()).toMatchObject({ plan: 'free', canSpend: false })
  })

  it('redeems a trial code', async () => {
    const { fetch, calls } = fakeFetch([[`POST ${API}/trials/redeem`, { json: { trialEndsAt: '2026-12-06T10:00:00Z', plan: 'basic' } }]])
    const run = await zetta(['account', 'redeem', 'zetta-7kq2-m9xd'], { fetch, env: session })
    expect(run.json()).toEqual({ redeemed: true, plan: 'basic', trialEndsAt: '2026-12-06T10:00:00Z' })
    expect(calls[0]!.body).toEqual({ code: 'zetta-7kq2-m9xd' })
    const { fetch: refused } = fakeFetch([[`POST ${API}/trials/redeem`, { status: 409, json: { statusCode: 409, message: 'You’ve already had your free trial.', error: 'Conflict' } }]])
    expect((await zetta(['account', 'redeem', 'ZETTA-7KQ2-M9XD'], { fetch: refused, env: session })).code).toBe(7)
  })

  it('lists connected plugins and CLIs', async () => {
    const { fetch } = fakeFetch([[`GET ${API}/auth/connections`, { json: { connections: [{ client: 'cli-mcp', pluginVersion: '0.4.0', hostVersion: null, firstSeenAt: '2026-11-01T00:00:00Z', lastSeenAt: '2026-11-25T00:00:00Z' }] } }]])
    const run = await zetta(['account', 'connections'], { fetch, env: session })
    expect(run.json().connections[0]).toMatchObject({ client: 'cli-mcp', name: 'CLI (MCP server)', version: '0.4.0' })
  })

  it('filters usage by meter, shows origin and tier, and breaks a period down', async () => {
    const entry = { id: 1, meter: 'ai_token', entryType: 'debit', bucket: 'monthly', operationType: 'unity_agent', amount: 1200, subjectType: null, subjectId: null, reason: null, userPaymentPlan: 'creator', createdAt: '2026-11-20T00:00:00Z', origin: 'unity', ai: { tier: 'Capable', thinking: 'high', rawTokens: 1200, weight: 1 } }
    const { fetch, calls } = fakeFetch([
      [`GET ${API}/billing/usage/breakdown`, { json: { meter: 'ai_token', since: '2026-11-01T00:00:00Z', total: 1200, byOperation: [{ operationType: 'unity_agent', amount: 1200, count: 1 }], byTier: [{ tier: 'Capable', amount: 1200, count: 1 }], truncated: false } }],
      [`GET ${API}/billing/usage`, { json: { entries: [entry], nextCursor: null } }],
    ])
    const list = await zetta(['account', 'usage', '--meter', 'ai-tokens'], { fetch, env: session })
    expect(list.json().entries[0]).toMatchObject({ meter: 'ai_tokens', origin: 'unity', tier: 'Capable', thinking: 'high' })
    expect(new URL(calls[0]!.url).searchParams.get('meter')).toBe('ai_token')

    const breakdown = await zetta(['account', 'usage', '--breakdown', '--meter', 'ai-tokens'], { fetch, env: session })
    expect(breakdown.json()).toMatchObject({ breakdown: true, meter: 'ai_tokens', total: 1200, byTier: [{ tier: 'Capable' }] })
    expect(new URL(calls[1]!.url).searchParams.get('meter')).toBe('ai_token')
    expect((await zetta(['account', 'usage', '--breakdown', '--all'], { fetch, env: session })).code).toBe(2)
  })

  it('explains SUBSCRIPTION_ACTIVE with the Agent plan in mind', () => {
    expect(hintFor('SUBSCRIPTION_ACTIVE')).toContain('Agent plan')
    expect(exitCodeFor('SUBSCRIPTION_ACTIVE', 409)).toBe(7)
  })
})

describe('billing', () => {
  const pricing = {
    plans: [
      {
        plan: 'creator',
        name: 'Creator',
        monthly: { id: 'price_m', amount: 5000, currency: 'eur', interval: 'month' },
        yearly: { id: 'price_y', amount: 50000, currency: 'eur', interval: 'year' },
        threeDCredits: 5000,
        aiTokens: 2_000_000,
        allowedModels: ['secret-engine-id'],
        threeD: { allowsLowPoly: true, maxConcurrentJobs: 3, concurrency: { total: 3, perCategory: { acme_series: 2 } } },
        image: { allowsImageEditing: true },
      },
    ],
    freePlan: { threeDCredits: 0, onboardingBonusCredits: 0, aiTokens: 0, onboardingBonusTokens: 0 },
    creditPacks: [{ priceId: 'price_pack', name: '1,000 credits', amount: 1000, currency: 'eur', credits: 1000 }],
    aiAddOns: [
      { priceId: 'price_ai_plus', productId: 'p1', name: 'Agent - Plus', amount: 2000, currency: 'eur', aiTokens: 21_500_000, interval: 'month' },
      { priceId: 'price_ai_plus_y', productId: 'p1', name: 'Agent - Plus', amount: 20000, currency: 'eur', aiTokens: 15_000_000, interval: 'year' },
      { priceId: 'price_ai_max', productId: 'p2', name: 'Agent - Max', amount: 5000, currency: 'eur', aiTokens: 55_000_000, interval: 'month' },
    ],
    operations: [],
  }

  it('lists 3D plans, credit packs and monthly Agent plans', async () => {
    const { fetch } = fakeFetch([[`GET ${API}/pricing`, { json: pricing }]])
    const run = await zetta(['billing', 'plans'], { fetch, env: clean })
    expect(run.json().agentPlans).toEqual([
      { name: 'Agent Plus', aiTokens: 21_500_000, approxHours: '≈ 18 h', price: '€20.00', priceId: 'price_ai_plus' },
      { name: 'Agent Max', aiTokens: 55_000_000, approxHours: '≈ 46 h', price: '€50.00', priceId: 'price_ai_max' },
    ])
    expect(run.stdout).not.toContain('secret-engine-id')
    expect(run.stdout).not.toContain('acme_series')
    expect(run.json().plans[0].threeD).toEqual({ allowsLowPoly: true, maxConcurrentJobs: 3 })
    const text = await zetta(['billing', 'plans'], { fetch, env: clean, tty: true })
    expect(text.stdout).toContain('Agent plans')
    expect(text.stdout).toContain('zetta account redeem')
    expect(text.stdout).not.toMatch(/free plan|free tier/i)
  })

  it('checks out an Agent plan by name', async () => {
    const { fetch, calls } = fakeFetch([
      [`GET ${API}/pricing`, { json: pricing }],
      [`POST ${API}/billing/checkout`, { json: { url: 'https://checkout.example/s/2' } }],
    ])
    const run = await zetta(['billing', 'checkout', '--agent', 'plus'], { fetch, env: session })
    expect(run.json()).toMatchObject({ url: 'https://checkout.example/s/2', item: { kind: 'agent_plan', name: 'Agent Plus', priceId: 'price_ai_plus' } })
    await zetta(['billing', 'checkout', 'agent max'], { fetch, env: session })
    expect(calls.filter((c) => c.url.endsWith('/billing/checkout')).map((c) => c.body)).toEqual([{ priceId: 'price_ai_plus' }, { priceId: 'price_ai_max' }])
    expect((await zetta(['billing', 'checkout', '--agent', 'plus', '--yearly'], { fetch, env: session })).code).toBe(2)
    expect((await zetta(['billing', 'checkout', 'creator', '--pack', '1000'], { fetch, env: session })).code).toBe(2)

    const { fetch: active } = fakeFetch([
      [`GET ${API}/pricing`, { json: pricing }],
      [`POST ${API}/billing/checkout`, { status: 409, json: { code: 'AI_ADD_ON_ACTIVE', message: 'You already have an Agent plan.' } }],
    ])
    const refused = await zetta(['billing', 'checkout', '--agent', 'max'], { fetch: active, env: session })
    expect(refused.code).toBe(7)
    expect(refused.errorJson().error.hint).toContain('zetta billing agent-plan')
  })

  it('switches an Agent plan only when confirmed', async () => {
    const { fetch, calls } = fakeFetch([
      [`GET ${API}/pricing`, { json: pricing }],
      [`POST ${API}/billing/ai-add-on/change`, { json: { changed: true } }],
    ])
    expect((await zetta(['billing', 'agent-plan', 'max'], { fetch, env: session })).code).toBe(2)
    expect(calls.some((c) => c.url.endsWith('/ai-add-on/change'))).toBe(false)
    const run = await zetta(['billing', 'agent-plan', 'max', '--yes'], { fetch, env: session })
    expect(run.json()).toMatchObject({ changed: true, agentPlan: { name: 'Agent Max', priceId: 'price_ai_max' } })
    expect(calls.find((c) => c.url.endsWith('/ai-add-on/change'))!.body).toEqual({ priceId: 'price_ai_max' })
    expect((await zetta(['billing', 'agent-plan', 'mega', '--yes'], { fetch, env: session })).code).toBe(2)
  })

  it('shows the Agent plan beside the subscription', async () => {
    const sub = { plan: 'creator', status: 'active', priceId: 'price_m', cancelAtPeriodEnd: false, currentPeriodEnd: '2026-12-25T00:00:00Z', manageable: true, aiAddOn: { priceId: 'price_ai_plus', tokens: 21_500_000, status: 'active', cancelAtPeriodEnd: true, currentPeriodEnd: '2026-12-20T00:00:00Z' } }
    const { fetch } = fakeFetch([
      [`GET ${API}/billing/subscription`, { json: sub }],
      [`GET ${API}/pricing`, { json: pricing }],
    ])
    const run = await zetta(['billing', 'subscription'], { fetch, env: withKey })
    expect(run.json().aiAddOn).toMatchObject({ name: 'Agent Plus', tokens: 21_500_000, cancelAtPeriodEnd: true })
    const text = await zetta(['billing', 'subscription'], { fetch, env: session, tty: true })
    expect(text.stdout).toContain('Agent plan: Agent Plus · 21,500,000 AI tokens a month')
    expect(text.stdout).toContain('ends 2026-12-20')
  })

  it('maps PLAN_REQUIRED to exit 4 with a way forward', () => {
    expect(exitCodeFor('PLAN_REQUIRED', 403)).toBe(4)
    expect(hintFor('PLAN_REQUIRED')).toMatch(/zetta billing checkout.*zetta account redeem/)
  })
})
