import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fakeFetch } from './fake-fetch'
import { generation, tokenFor, zetta } from './harness'

const API = 'https://api.zetta3d.ai/api'

function pngFile(dir: string, name = 'chair.png', size = 512): string {
  const bytes = new Uint8Array(64)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(bytes.buffer).setUint32(16, size)
  new DataView(bytes.buffer).setUint32(20, size)
  const path = join(dir, name)
  writeFileSync(path, bytes)
  return path
}

const entitlements = {
  plan: 'creator',
  entitlements: { maxMultiViewImages: 4, allowsLowPoly: true, allowsQuadMesh: true, allowsCustomFaceCount: true, maxFaceCount: 2_000_000, allowsZettaN25: true, allowsZettaNp1: true, allowsPostProcess: true, allowsPrivateGenerations: true, allowsSplat: true, maxConcurrentJobs: 3 },
}

function routes(extra: Array<[string | RegExp, unknown]> = []) {
  return fakeFetch([
    [`GET ${API}/3d/entitlements`, { json: entitlements }],
    [`POST ${API}/3d/quote`, { json: { credits: 50, lines: [{ code: 'textured', label: 'Textured model', credits: 50 }] } }],
    [/^POST https:\/\/api\.zetta3d\.ai\/api\/3d\/uploads$/, { json: { uploadUrl: `${API}/3d/uploads/relay?ticket=t1`, method: 'PUT', headers: { 'Content-Type': 'image/png' }, key: 'inputImg/1/a.png', fileUrl: 'https://files.example/a.png' } }],
    [`PUT ${API}/3d/uploads/relay`, { json: { key: 'inputImg/1/a.png', bytes: 64 } }],
    [`POST ${API}/3d/generations`, { json: { generation: generation(42, 'queued'), quote: { credits: 50, lines: [] }, charged: true } }],
    ...(extra as Array<[string | RegExp, never]>),
  ])
}

describe('zetta generate', () => {
  it('prices with --dry-run without uploading or spending', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zg-'))
    const { fetch, calls } = routes()
    const run = await zetta(['generate', '--image', pngFile(dir), '--engine', 'n2.5', '--dry-run'], { fetch, env: { ZETTA_TOKEN: tokenFor() } })
    expect(run.code).toBe(0)
    expect(run.json()).toMatchObject({ dryRun: true, credits: 50 })
    expect(calls.some((c) => c.url.includes('/3d/uploads'))).toBe(false)
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/3d/generations'))).toBe(false)
  })

  it('refuses to spend without a terminal unless confirmed (exit 5)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zg-'))
    const { fetch, calls } = routes()
    const run = await zetta(['generate', '--image', pngFile(dir)], { fetch, env: { ZETTA_TOKEN: tokenFor() } })
    expect(run.code).toBe(5)
    expect(run.errorJson().error).toMatchObject({ code: 'SPEND_NOT_CONFIRMED', details: { credits: 50 } })
    expect(calls.some((c) => c.url.includes('/3d/uploads'))).toBe(false)
  })

  it('refuses when the price is over --max-credits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zg-'))
    const { fetch } = routes()
    const run = await zetta(['generate', '--image', pngFile(dir), '--max-credits', '10'], { fetch, env: { ZETTA_TOKEN: tokenFor() } })
    expect(run.code).toBe(5)
    expect(run.errorJson().error.code).toBe('SPEND_LIMIT')
  })

  it('uploads, submits with an idempotency key and returns the asset id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zg-'))
    const { fetch, calls } = routes()
    const run = await zetta(['generate', '--image', pngFile(dir), '--engine', 'n2.5', '--title', 'Chair', '--yes'], { fetch, env: { ZETTA_TOKEN: tokenFor() } })
    expect(run.code).toBe(0)
    expect(run.json()).toMatchObject({ id: 42, status: 'queued', credits: 50, charged: true, next: 'zetta asset wait 42' })
    const create = calls.find((c) => c.method === 'POST' && c.url.endsWith('/3d/generations'))!
    expect(create.headers['idempotency-key']).toBeTruthy()
    expect(create.body).toMatchObject({ imageUrl: 'https://files.example/a.png', model: 'n25', title: 'Chair', origin: 'cli' })
  })

  it('rejects impossible combinations before anything is sent (exit 2)', async () => {
    const { fetch, calls } = routes()
    const run = await zetta(['generate', '-p', 'a chair', '--engine', 'n1', '--parts', '--yes'], { fetch, env: { ZETTA_TOKEN: tokenFor() } })
    expect(run.code).toBe(2)
    expect(run.errorJson().error.code).toBe('BUILD_PROBLEMS')
    expect(calls.some((c) => c.url.endsWith('/3d/generations'))).toBe(false)
  })

  it('waits and downloads with --out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zg-'))
    const { fetch } = routes([
      [`GET ${API}/3d/generations/42/download`, { json: { key: 'gen3d/1/42/model.glb', url: 'https://files.example/model.glb', expiresInSeconds: 900 } }],
      [`GET ${API}/3d/generations/42`, { json: { generation: generation(42, 'success'), queuePosition: null } }],
      ['GET https://files.example/model.glb', { text: 'glTF' }],
    ])
    const run = await zetta(['generate', '--image', pngFile(dir), '--yes', '--out', join(dir, 'out')], { fetch, env: { ZETTA_TOKEN: tokenFor() } })
    expect(run.code).toBe(0)
    const result = run.json()
    expect(result.status).toBe('success')
    expect(result.files[0].path).toContain('42-model.glb')
    expect(existsSync(result.files[0].path)).toBe(true)
    expect(readFileSync(result.files[0].path, 'utf8')).toBe('glTF')
  })

  it('checks the plan before spending', async () => {
    const { fetch } = fakeFetch([
      [`GET ${API}/3d/entitlements`, { json: { plan: 'free', entitlements: { ...entitlements.entitlements, allowsZettaN25: false } } }],
    ])
    const run = await zetta(['generate', '-p', 'a chair', '--engine', 'n2.5', '--yes'], { fetch, env: { ZETTA_TOKEN: tokenFor() } })
    expect(run.code).toBe(4)
    expect(run.errorJson().error.code).toBe('PLAN_CAPABILITY_REQUIRED')
  })
})
