import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fakeFetch } from './fake-fetch'
import { tokenFor, zetta } from './harness'

const API = 'https://api.zetta3d.ai/api'
const env = { ZETTA_TEST_SIGN_IN: tokenFor() }

describe('config', () => {
  it('sets, reads and validates settings; profiles switch the API', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zc-'))
    expect((await zetta(['config', 'set', 'spend.maxPerCommand', '200'], { configDir: dir })).code).toBe(0)
    expect((await zetta(['config', 'get', 'spend.maxPerCommand'], { configDir: dir })).json().value).toBe(200)
    expect((await zetta(['config', 'set', 'output', 'yaml'], { configDir: dir })).code).toBe(2)
    expect((await zetta(['config', 'add-profile', 'staging', '--api', 'https://staging.example/api', '--use'], { configDir: dir })).code).toBe(0)
    const status = await zetta(['auth', 'status'], { configDir: dir })
    expect(status.json()).toMatchObject({ profile: 'staging', apiUrl: 'https://staging.example/api' })
    expect((await zetta(['config', 'remove-profile', 'default'], { configDir: dir })).code).toBe(2)
  })

  it('a configured per-command limit lets agents spend without --yes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zc-'))
    await zetta(['config', 'set', 'spend.maxPerCommand', '100'], { configDir: dir })
    const { fetch } = fakeFetch([
      [`GET ${API}/3d/entitlements`, { status: 404, json: {} }],
      [`POST ${API}/3d/quote`, { json: { credits: 40, lines: [] } }],
      [`POST ${API}/3d/generations`, { json: { generation: { id: 1, status: 'queued', result: null, tags: [], availability: 'private', createdAt: 'x', updatedAt: 'x' }, quote: { credits: 40, lines: [] }, charged: true } }],
    ])
    const ok = await zetta(['generate', '--image', 'https://files.example/mug.png'], { fetch, env, configDir: dir })
    expect(ok.code).toBe(0)
  })
})

describe('billing', () => {
  const pricing = {
    plans: [{ plan: 'creator', name: 'Creator', monthly: { id: 'price_m', amount: 5000, currency: 'eur', interval: 'month' }, yearly: { id: 'price_y', amount: 50000, currency: 'eur', interval: 'year' }, threeDCredits: 5000, aiTokens: 1 }],
    freePlan: null,
    creditPacks: [{ priceId: 'price_pack', name: '1,000 credits', amount: 1000, currency: 'eur', credits: 1000 }],
    operations: [],
  }
  it('turns a plan or pack name into a checkout link', async () => {
    const { fetch, calls } = fakeFetch([
      [`GET ${API}/pricing`, { json: pricing }],
      [`POST ${API}/billing/checkout`, { json: { url: 'https://checkout.example/s/1' } }],
    ])
    const yearly = await zetta(['billing', 'checkout', 'creator', '--yearly'], { fetch, env })
    expect(yearly.json()).toMatchObject({ url: 'https://checkout.example/s/1', opened: false })
    expect(calls.find((c) => c.url.endsWith('/billing/checkout'))!.body).toEqual({ priceId: 'price_y' })
    await zetta(['billing', 'checkout', '--pack', '1000'], { fetch, env })
    expect(calls.filter((c) => c.url.endsWith('/billing/checkout')).at(-1)!.body).toEqual({ priceId: 'price_pack' })
    expect((await zetta(['billing', 'checkout', 'mega'], { fetch, env })).code).toBe(2)
  })
})

describe('safety', () => {
  it('refuses to delete the account without a terminal', async () => {
    const run = await zetta(['account', 'delete'], { env })
    expect(run.code).toBe(2)
  })
  it('refuses to delete assets without --yes when piped', async () => {
    const { fetch, calls } = fakeFetch([[`DELETE ${API}/3d/generations/1`, { status: 204 }]])
    expect((await zetta(['asset', 'delete', '1'], { fetch, env })).code).toBe(2)
    expect(calls).toHaveLength(0)
    expect((await zetta(['asset', 'delete', '1', '--yes'], { fetch, env })).code).toBe(0)
    expect(calls).toHaveLength(1)
  })
})
