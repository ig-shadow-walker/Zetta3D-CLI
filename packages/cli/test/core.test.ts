import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseDuration } from '../src/core/define'
import { exitCodeFor } from '../src/core/exit-codes'
import { toErrorEnvelope } from '../src/core/output'
import { CredentialStore } from '../src/core/credentials'
import { ConfigStore } from '../src/core/config'
import { ZettaError } from '@zetta3d/sdk'
import { fakeFetch } from './fake-fetch'
import { generation, tokenFor, user, zetta } from './harness'

describe('durations and exit codes', () => {
  it('parses durations', () => {
    expect(parseDuration('90')).toBe(90_000)
    expect(parseDuration('90s')).toBe(90_000)
    expect(parseDuration('10m')).toBe(600_000)
    expect(parseDuration('1h30m')).toBe(5_400_000)
    expect(parseDuration('soon')).toBeNaN()
    expect(parseDuration(undefined)).toBeUndefined()
  })
  it('maps codes to exit codes', () => {
    expect(exitCodeFor('INSUFFICIENT_CREDITS')).toBe(5)
    expect(exitCodeFor('PLAN_CAPABILITY_REQUIRED')).toBe(4)
    expect(exitCodeFor('WAIT_TIMEOUT')).toBe(10)
    expect(exitCodeFor('SOMETHING', 404)).toBe(6)
    expect(exitCodeFor('SOMETHING', 503)).toBe(11)
  })
  it('drops upstream details and replaces upstream-worded messages', () => {
    const envelope = toErrorEnvelope(new ZettaError({ code: 'JOB_LIMIT_REACHED', message: 'Too many', status: 409, details: { category: 'x_series', limit: 2, vendorThing: 1 } }))
    expect(envelope.error.details).toEqual({ limit: 2 })
    expect(toErrorEnvelope(new ZettaError({ code: 'IMAGE_GEN_QUOTA', message: 'upstream said something', status: 503 })).error.message).not.toContain('upstream')
  })
})

describe('config and credentials', () => {
  it('resolves profiles with env overrides', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zc-'))
    const config = new ConfigStore(dir)
    expect(config.resolveProfile(undefined, {}).profile.apiUrl).toBe('https://api.zetta3d.ai/api')
    expect(config.resolveProfile('local', {}).profile.apiUrl).toBe('http://localhost:4000/api')
    expect(config.resolveProfile(undefined, { ZETTA_API_URL: 'http://x/api' }).profile.apiUrl).toBe('http://x/api')
    expect(() => config.resolveProfile('nope', {})).toThrow(/no profile/)
    config.set('spend.maxPerCommand', '200')
    config.save()
    expect(new ConfigStore(dir).get('spend.maxPerCommand')).toBe(200)
    expect(() => config.set('spend.maxPerCommand', 'lots')).toThrow()
  })
  it('stores tokens in a private file without a keychain, and prefers ZETTA_TOKEN', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zc-'))
    const store = new CredentialStore(dir, { ZETTA_NO_KEYCHAIN: '1' })
    expect(await store.set('default', { token: 't1', savedAt: 'now' })).toBe('file')
    expect((await store.get('default'))?.credential.token).toBe('t1')
    expect((await new CredentialStore(dir, { ZETTA_NO_KEYCHAIN: '1', ZETTA_TOKEN: 'env' }).get('default'))?.source).toBe('env')
    expect(await store.delete('default')).toBe(true)
    expect(await store.get('default')).toBeUndefined()
  })
})

describe('program', () => {
  it('prints JSON when piped and text in a terminal', async () => {
    const { fetch } = fakeFetch([['GET https://api.zetta3d.ai/api/auth/me', { json: { user, onboardingBonus: null } }]])
    const piped = await zetta(['account', 'credits'], { fetch, env: { ZETTA_TOKEN: tokenFor() } })
    expect(piped.code).toBe(0)
    expect(piped.json().threeD.total).toBe(650)
    const tty = await zetta(['account', 'credits'], { fetch, env: { ZETTA_TOKEN: tokenFor() }, tty: true })
    expect(tty.stdout).toContain('3D credits')
  })

  it('rejects unknown flags and unknown --input keys with exit 2', async () => {
    const bad = await zetta(['asset', 'list', '--nope'])
    expect(bad.code).toBe(2)
    expect(bad.errorJson().error.code).toBe('USAGE')
    const badInput = await zetta(['asset', 'list', '--input', '{"wat":1}'], { env: { ZETTA_TOKEN: tokenFor() } })
    expect(badInput.code).toBe(2)
    expect(badInput.errorJson().error.message).toContain('wat')
  })

  it('takes inputs from --input JSON, overridden by flags', async () => {
    const { fetch, calls } = fakeFetch([['GET https://api.zetta3d.ai/api/3d/generations', { json: { items: [generation(5)], total: 1, page: 1, pageSize: 3 } }]])
    const run = await zetta(['asset', 'list', '--input', '{"limit":50,"search":"chair"}', '--limit', '3'], { fetch, env: { ZETTA_TOKEN: tokenFor() } })
    expect(run.code).toBe(0)
    const url = new URL(calls[0]!.url)
    expect(url.searchParams.get('pageSize')).toBe('3')
    expect(url.searchParams.get('search')).toBe('chair')
    expect(run.json().items[0]).toMatchObject({ id: 5, engine: 'n25', engineLabel: 'Zetta N2.5', files: [{ format: 'glb' }] })
  })

  it('exits 3 when signed out, and 3 for an expired token', async () => {
    expect((await zetta(['account', 'show'])).code).toBe(3)
    const expired = await zetta(['account', 'show'], { env: { ZETTA_TOKEN: tokenFor(1000) } })
    expect(expired.code).toBe(3)
    expect(expired.errorJson().error.code).toBe('INVALID_SESSION')
  })

  it('exits 9 when waiting on a job that failed', async () => {
    const { fetch } = fakeFetch([['GET https://api.zetta3d.ai/api/3d/generations/9', { json: { generation: generation(9, 'failed'), queuePosition: null } }]])
    const run = await zetta(['asset', 'wait', '9'], { fetch, env: { ZETTA_TOKEN: tokenFor() } })
    expect(run.code).toBe(9)
    expect(run.errorJson().error.message).toContain('could not be read')
  })

  it('lists commands and schemas for agents', async () => {
    const commands = (await zetta(['commands', '--json'])).json()
    expect(commands.commands.map((c: { command: string }) => c.command)).toContain('zetta asset list')
    expect(commands.exitCodes).toHaveLength(12)
    const schema = (await zetta(['schema', 'asset', 'download', '--json'])).json()
    expect(schema.inputSchema.properties.id.type).toBe('integer')
    expect(schema.inputSchema.required).toEqual(['id'])
  })

  it('signs in with a token from stdin and stores it', async () => {
    const { fetch } = fakeFetch([['GET https://api.zetta3d.ai/api/auth/me', { json: { user, onboardingBonus: null } }]])
    const dir = mkdtempSync(join(tmpdir(), 'zc-'))
    const login = await zetta(['auth', 'login', '--with-token'], { fetch, stdin: tokenFor(), configDir: dir })
    expect(login.code).toBe(0)
    expect(login.json()).toMatchObject({ signedIn: true, email: 'dev@example.com', storedIn: 'credentials file' })
    const status = await zetta(['auth', 'status'], { fetch, configDir: dir })
    expect(status.json()).toMatchObject({ signedIn: true, tokenSource: 'file' })
  })
})

describe('positionals', () => {
  it('can come from --input, and are still required', async () => {
    const { fetch } = fakeFetch([['GET https://api.zetta3d.ai/api/3d/generations/5', { json: { generation: generation(5), queuePosition: null } }]])
    const viaInput = await zetta(['asset', 'get', '--input', '{"id":5}'], { fetch, env: { ZETTA_TOKEN: tokenFor() } })
    expect(viaInput.code).toBe(0)
    expect(viaInput.json().id).toBe(5)
    const missing = await zetta(['asset', 'get'], { env: { ZETTA_TOKEN: tokenFor() } })
    expect(missing.code).toBe(2)
    expect(missing.errorJson().error.message).toContain('<id>')
  })
})
