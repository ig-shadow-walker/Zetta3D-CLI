import { describe, expect, it } from 'vitest'
import { ZettaClient } from '../src/client'
import { extractMagicToken, sessionFromSetCookie, tokenExpiry } from '../src/resources/auth'
import { selectResultFiles } from '../src/resources/generations'
import { assertSucceeded } from '../src/resources/generations'
import { isBlocked } from '../src/resources/pipelines'
import { fakeFetch, noSleep } from './fake-fetch'

const gen = (status: string, extra: Record<string, unknown> = {}) => ({ generation: { id: 7, status, result: null, errorMessage: null, ...extra }, queuePosition: null })

describe('auth helpers', () => {
  it('extracts the magic token from a link or a bare token', () => {
    expect(extractMagicToken('https://zetta3d.ai/auth/callback?token=abc_123-x')).toBe('abc_123-x')
    expect(extractMagicToken('  token=abc  ')).toBe('abc')
    expect(extractMagicToken('abc')).toBe('abc')
  })
  it('reads the session cookie', () => {
    const headers = new Headers()
    headers.append('set-cookie', 'other=1; Path=/')
    headers.append('set-cookie', 'zetta_session=eyJ.abc.def; Path=/; HttpOnly; SameSite=Lax')
    expect(sessionFromSetCookie(headers)).toBe('eyJ.abc.def')
  })
  it('reads a token expiry without verifying it', () => {
    const payload = btoa(JSON.stringify({ sub: 1, exp: 2_000_000_000 })).replace(/=+$/, '')
    expect(tokenExpiry(`h.${payload}.s`)?.getTime()).toBe(2_000_000_000_000)
    expect(tokenExpiry('garbage')).toBeUndefined()
  })
  it('verifies a magic link and returns the session token', async () => {
    const { fetch } = fakeFetch([
      ['POST https://api.test/api/auth/verify', { json: { user: { id: 1 }, newAccount: false }, headers: { 'set-cookie': 'zetta_session=tok123; Path=/; HttpOnly' } }],
    ])
    const client = new ZettaClient({ baseUrl: 'https://api.test/api', fetch, sleep: noSleep })
    const result = await client.auth.verifyMagicLink('https://zetta3d.ai/auth/callback?token=magic')
    expect(result.token).toBe('tok123')
  })
})

describe('generations', () => {
  it('waits until the job is final', async () => {
    const { fetch, calls } = fakeFetch([['GET https://api.test/api/3d/generations/7', [{ json: gen('queued') }, { json: gen('processing') }, { json: gen('success') }]]])
    const client = new ZettaClient({ baseUrl: 'https://api.test/api', fetch, sleep: noSleep })
    const updates: string[] = []
    const detail = await client.generations.wait(7, { intervalMs: 1, onUpdate: (d) => updates.push(d.generation.status) })
    expect(detail.generation.status).toBe('success')
    expect(updates).toEqual(['queued', 'processing', 'success'])
    expect(calls).toHaveLength(3)
  })
  it('times out with WAIT_TIMEOUT and leaves the job alone', async () => {
    const { fetch } = fakeFetch([['GET https://api.test/api/3d/generations/7', { json: gen('processing') }]])
    const client = new ZettaClient({ baseUrl: 'https://api.test/api', fetch, sleep: noSleep })
    await expect(client.generations.wait(7, { intervalMs: 10, timeoutMs: 0 })).rejects.toMatchObject({ code: 'WAIT_TIMEOUT' })
  })
  it('always sends an idempotency key on create', async () => {
    const { fetch, calls } = fakeFetch([['POST https://api.test/api/3d/generations', { json: { generation: {}, quote: { credits: 1, lines: [] }, charged: true } }]])
    const client = new ZettaClient({ baseUrl: 'https://api.test/api', fetch, sleep: noSleep })
    await client.generations.create({ prompt: 'x' })
    expect(calls[0]!.headers['idempotency-key']).toMatch(/[0-9a-f-]{36}/)
  })
  it('selects files by format and picks a primary model', () => {
    const files = ['a/model.fbx', 'a/model.glb', 'a/model.obj.zip', 'a/uv.png'].map((key) => ({ key, type: '', url: 'u' }))
    expect(selectResultFiles({ result: { files } }, { primary: true }).map((f) => f.key)).toEqual(['a/model.glb'])
    expect(selectResultFiles({ result: { files } }, { formats: ['fbx'] }).map((f) => f.key)).toEqual(['a/model.fbx'])
    expect(selectResultFiles({ result: { files } })).toHaveLength(4)
  })
  it('turns a failed job into JOB_FAILED', () => {
    expect(() => assertSucceeded({ id: 3, status: 'failed', errorMessage: 'Bad picture' } as never)).toThrow(/Bad picture/)
  })
})

describe('runs', () => {
  it('knows when a run needs a person', () => {
    expect(isBlocked({ status: 'running', steps: [{ status: 'review' } as never] })).toBe(true)
    expect(isBlocked({ status: 'draft', steps: [] })).toBe(true)
    expect(isBlocked({ status: 'running', steps: [{ status: 'running' } as never] })).toBe(false)
  })
})
