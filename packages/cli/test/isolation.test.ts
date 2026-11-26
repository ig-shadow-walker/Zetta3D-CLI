import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fakeFetch } from './fake-fetch'
import { tokenFor, zetta } from './harness'

const API = 'https://api.zetta3d.ai/api'
// Made-up upstream identifiers: the CLI must never repeat them.
const UPSTREAM_ID = 'acmevendor-image-9'
const UPSTREAM_CODE = 'AcmeVendor.InvalidParameter'

describe('the CLI does not repeat upstream details', () => {
  it('image generate writes files and leaves out the engine id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zi-'))
    const { fetch, calls } = fakeFetch([
      [`GET ${API}/2d/models`, { json: { models: [{ id: UPSTREAM_ID, label: 'Pro', resolutions: ['1K', '2K'] }], default: UPSTREAM_ID } }],
      [`POST ${API}/2d/generate`, { json: { postId: 9, images: [{ base64: Buffer.from('png').toString('base64'), contentType: 'image/png', bytes: 3 }], text: null, model: UPSTREAM_ID } }],
    ])
    const run = await zetta(['image', 'generate', '-p', 'a lamp', '--engine', 'pro', '--out', dir], { fetch, env: { ZETTA_TEST_SIGN_IN: tokenFor() } })
    expect(run.code).toBe(0)
    expect(run.stdout).not.toContain(UPSTREAM_ID)
    expect(existsSync(run.json().files[0].path)).toBe(true)
    expect(calls.find((c) => c.url.endsWith('/2d/generate'))!.body).toMatchObject({ model: UPSTREAM_ID })
  })

  it('image engines are listed by label only', async () => {
    const { fetch } = fakeFetch([[`GET ${API}/2d/models`, { json: { models: [{ id: UPSTREAM_ID, label: 'Flash', resolutions: ['1K'] }], default: UPSTREAM_ID } }]])
    const run = await zetta(['catalog', 'engines', '--images'], { fetch, env: { ZETTA_TEST_SIGN_IN: tokenFor() } })
    expect(run.stdout).not.toContain(UPSTREAM_ID)
    expect(run.json().imageEngines[0].name).toBe('flash')
  })

  it('usage history leaves out refund reasons', async () => {
    const { fetch } = fakeFetch([[`GET ${API}/billing/usage`, { json: { entries: [{ id: 1, meter: 'three_d_credit', entryType: 'refund', bucket: 'monthly', operationType: 'textured', amount: 50, subjectType: 'gen3d_post', subjectId: 7, reason: UPSTREAM_CODE, userPaymentPlan: 'creator', createdAt: '2026-10-20T00:00:00Z' }], nextCursor: null } }]])
    const run = await zetta(['account', 'usage'], { fetch, env: { ZETTA_TEST_SIGN_IN: tokenFor() } })
    expect(run.code).toBe(0)
    expect(run.stdout).not.toContain(UPSTREAM_CODE)
    expect(run.json().entries[0]).toMatchObject({ type: 'refund', amount: 50, subject: 'gen3d_post:7' })
  })

  it('plans leave out model lists and margin fields', async () => {
    const { fetch } = fakeFetch([[`GET ${API}/pricing`, { json: { plans: [{ plan: 'creator', name: 'Creator', monthly: { id: 'price_1', amount: 5000, currency: 'eur', interval: 'month' }, yearly: null, threeDCredits: 5000, aiTokens: 1, allowedModels: [UPSTREAM_ID], maxDrainMultiplierX100: 150, threeD: {}, image: {} }], freePlan: null, creditPacks: [], operations: [] } }]])
    const run = await zetta(['billing', 'plans'], { fetch })
    expect(run.code).toBe(0)
    expect(run.stdout).not.toContain(UPSTREAM_ID)
    expect(run.stdout).not.toContain('maxDrainMultiplierX100')
    expect(run.json().plans[0].monthly.price).toBe('€50.00')
  })

  it('concurrency errors leave out internal category names', async () => {
    const { fetch } = fakeFetch([
      [`GET ${API}/3d/entitlements`, { status: 500, json: {} }],
      [`POST ${API}/3d/quote`, { json: { credits: 10, lines: [] } }],
      [`POST ${API}/3d/generations`, { status: 409, json: { code: 'JOB_LIMIT_REACHED', message: 'Too many jobs running.', category: 'acme_series', scope: 'category', limit: 1, running: 1, plan: 'free', upgradeTo: 'basic', upgradeLimit: 3 } }],
    ])
    const run = await zetta(['generate', '--image', 'https://files.example/cup.png', '--yes'], { fetch, env: { ZETTA_TEST_SIGN_IN: tokenFor() } })
    expect(run.code).toBe(7)
    expect(run.stderr).not.toContain('acme_series')
    expect(run.errorJson().error.details).toMatchObject({ limit: 1, upgradeTo: 'basic' })
  })
})
