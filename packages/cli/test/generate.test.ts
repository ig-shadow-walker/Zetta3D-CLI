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
    const run = await zetta(['generate', '--image', pngFile(dir), '--engine', 'n2.5', '--dry-run'], { fetch, env: { ZETTA_TEST_SIGN_IN: tokenFor() } })
    expect(run.code).toBe(0)
    expect(run.json()).toMatchObject({ dryRun: true, credits: 50 })
    expect(calls.some((c) => c.url.includes('/3d/uploads'))).toBe(false)
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/3d/generations'))).toBe(false)
  })

  it('refuses to spend without a terminal unless confirmed (exit 5)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zg-'))
    const { fetch, calls } = routes()
    const run = await zetta(['generate', '--image', pngFile(dir)], { fetch, env: { ZETTA_TEST_SIGN_IN: tokenFor() } })
    expect(run.code).toBe(5)
    expect(run.errorJson().error).toMatchObject({ code: 'SPEND_NOT_CONFIRMED', details: { credits: 50 } })
    expect(calls.some((c) => c.url.includes('/3d/uploads'))).toBe(false)
  })

  it('refuses when the price is over --max-credits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zg-'))
    const { fetch } = routes()
    const run = await zetta(['generate', '--image', pngFile(dir), '--max-credits', '10'], { fetch, env: { ZETTA_TEST_SIGN_IN: tokenFor() } })
    expect(run.code).toBe(5)
    expect(run.errorJson().error.code).toBe('SPEND_LIMIT')
  })

  it('uploads, submits with an idempotency key and returns the asset id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zg-'))
    const { fetch, calls } = routes()
    const run = await zetta(['generate', '--image', pngFile(dir), '--engine', 'n2.5', '--title', 'Chair', '--yes'], { fetch, env: { ZETTA_TEST_SIGN_IN: tokenFor() } })
    expect(run.code).toBe(0)
    expect(run.json()).toMatchObject({ id: 42, status: 'queued', credits: 50, charged: true, next: 'zetta asset wait 42' })
    const create = calls.find((c) => c.method === 'POST' && c.url.endsWith('/3d/generations'))!
    expect(create.headers['idempotency-key']).toBeTruthy()
    expect(create.body).toMatchObject({ imageUrl: 'https://files.example/a.png', model: 'n25', title: 'Chair', origin: 'cli' })
  })

  it('rejects impossible combinations before anything is sent (exit 2)', async () => {
    const { fetch, calls } = routes()
    const run = await zetta(['generate', '-p', 'a chair', '--engine', 'np1', '--parts', '--yes'], { fetch, env: { ZETTA_TEST_SIGN_IN: tokenFor() } })
    expect(run.code).toBe(2)
    expect(run.errorJson().error.code).toBe('BUILD_PROBLEMS')
    expect(calls.some((c) => c.url.endsWith('/3d/generations'))).toBe(false)
    expect(calls.some((c) => c.url.includes('/2d/'))).toBe(false)
  })

  it('makes text to 3D as the Studio does: a picture first, then the model from it', async () => {
    const { fetch, calls } = routes([
      [`POST ${API}/2d/generate`, { json: { postId: 3, images: [{ base64: 'iVBORw0KGgo=', contentType: 'image/png', bytes: 8 }], text: null, model: 'image' } }],
    ])
    const run = await zetta(['generate', '-p', 'a brass lantern', '--yes'], { fetch, env: { ZETTA_TEST_SIGN_IN: tokenFor() } })
    expect(run.code).toBe(0)
    const picture = calls.find((c) => c.url.endsWith('/2d/generate'))!
    expect(picture.body).toEqual({ prompt: 'a brass lantern', for3D: true })
    const create = calls.find((c) => c.method === 'POST' && c.url.endsWith('/3d/generations'))!
    expect(create.body).toMatchObject({
      prompt: 'a brass lantern',
      imageUrl: 'https://files.example/a.png',
      imageFromPrompt: true,
      model: 'n25',
      faceCount: 1_000_000,
      textureAlignment: 'geometry',
      spec: { generation: { base: 'textured', modifiers: ['pbr'] } },
    })
  })

  it('prices a dry run without making the picture', async () => {
    const { fetch, calls } = routes()
    const run = await zetta(['generate', '-p', 'a brass lantern', '--quality', 'lowpoly', '--quads', '--dry-run'], { fetch, env: { ZETTA_TEST_SIGN_IN: tokenFor() } })
    expect(run.code).toBe(0)
    expect(calls.some((c) => c.url.includes('/2d/'))).toBe(false)
    expect(calls.find((c) => c.url.endsWith('/3d/quote'))!.body).toMatchObject({ generation: { base: 'lowpoly' }, model: 'n25' })
    expect(run.json().request).toMatchObject({ faceCount: 10_000, polygonType: 'quadrilateral', imageFromPrompt: true })
  })

  it('takes the Smart engines, extreme textures and the older 8k spelling', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zg-'))
    for (const tier of ['extreme', '8k']) {
      const { fetch, calls } = routes()
      const run = await zetta(['generate', '-i', pngFile(dir), '--engine', 'np1.5', '--quads', '--faces', '8000', '--texture-quality', tier, '--dry-run'], { fetch, env: { ZETTA_TEST_SIGN_IN: tokenFor() } })
      expect(run.code).toBe(0)
      expect(calls.find((c) => c.url.endsWith('/3d/quote'))!.body).toEqual({
        generation: { base: 'textured', modifiers: ['pbr', 'extreme_texture', 'custom_face_count'] },
        model: 'np15',
      })
    }
  })

  it('refuses quads on Np1 and extreme textures on N2.5 (exit 2)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zg-'))
    const { fetch } = routes()
    const quads = await zetta(['generate', '-i', pngFile(dir), '--engine', 'np1', '--quads', '--dry-run'], { fetch, env: { ZETTA_TEST_SIGN_IN: tokenFor() } })
    expect(quads.code).toBe(2)
    expect(quads.errorJson().error.details.problems[0].code).toBe('QUADS_NOT_SUPPORTED')
    const extreme = await zetta(['generate', '-i', pngFile(dir), '--texture-quality', 'extreme', '--dry-run'], { fetch, env: { ZETTA_TEST_SIGN_IN: tokenFor() } })
    expect(extreme.code).toBe(2)
    expect(extreme.errorJson().error.details.problems[0].code).toBe('TEXTURE_QUALITY_NOT_SUPPORTED')
  })

  it('no longer offers Zetta N1, and says so when a saved default still names it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zg-'))
    const flag = await zetta(['generate', '-i', pngFile(dir), '--engine', 'n1', '--dry-run'], { env: { ZETTA_TEST_SIGN_IN: tokenFor() } })
    expect(flag.code).toBe(2)
    const configDir = mkdtempSync(join(tmpdir(), 'zg-cfg-'))
    expect((await zetta(['config', 'set', 'defaults.engine', 'n1'], { configDir })).code).toBe(0)
    const saved = await zetta(['generate', '-i', pngFile(dir), '--dry-run'], { configDir, env: { ZETTA_TEST_SIGN_IN: tokenFor() } })
    expect(saved.code).toBe(2)
    expect(saved.errorJson().error.message).toMatch(/Zetta N1 has been retired/)
  })

  it('takes the four sides as views, front required', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zg-'))
    const { fetch, calls } = routes()
    const run = await zetta(['generate', '--view', `front=${pngFile(dir, 'f.png')}`, '--view', `back=${pngFile(dir, 'b.png')}`, '--dry-run'], { fetch, env: { ZETTA_TEST_SIGN_IN: tokenFor() } })
    expect(run.code).toBe(0)
    expect(calls.find((c) => c.url.endsWith('/3d/quote'))!.body).toMatchObject({ generation: { modifiers: ['multi_view', 'pbr'] } })
    const top = await zetta(['generate', '--view', `top=${pngFile(dir, 't.png')}`, '--dry-run'], { fetch, env: { ZETTA_TEST_SIGN_IN: tokenFor() } })
    expect(top.code).toBe(2)
    const noFront = await zetta(['generate', '--view', `left=${pngFile(dir, 'l.png')}`, '--view', `back=${pngFile(dir, 'b.png')}`, '--dry-run'], { fetch, env: { ZETTA_TEST_SIGN_IN: tokenFor() } })
    expect(noFront.code).toBe(2)
    expect(noFront.errorJson().error.details.problems[0].code).toBe('FRONT_VIEW_REQUIRED')
  })

  it('waits and downloads with --out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zg-'))
    const { fetch } = routes([
      [`GET ${API}/3d/generations/42/download`, { json: { key: 'gen3d/1/42/model.glb', url: 'https://files.example/model.glb', expiresInSeconds: 900 } }],
      [`GET ${API}/3d/generations/42`, { json: { generation: generation(42, 'success'), queuePosition: null } }],
      ['GET https://files.example/model.glb', { text: 'glTF' }],
    ])
    const run = await zetta(['generate', '--image', pngFile(dir), '--yes', '--out', join(dir, 'out')], { fetch, env: { ZETTA_TEST_SIGN_IN: tokenFor() } })
    expect(run.code).toBe(0)
    const result = run.json()
    expect(result.status).toBe('success')
    expect(result.files[0].path).toContain('42-model.glb')
    expect(existsSync(result.files[0].path)).toBe(true)
    expect(readFileSync(result.files[0].path, 'utf8')).toBe('glTF')
  })

  it('needs a paid plan to generate anything (PLAN_REQUIRED, exit 4)', async () => {
    const { fetch, calls } = fakeFetch([
      [`GET ${API}/3d/entitlements`, { json: { plan: 'free', entitlements: { ...entitlements.entitlements, allowsPrivateGenerations: false, allowsZettaN25: false } } }],
    ])
    const run = await zetta(['generate', '-p', 'a chair', '--yes'], { fetch, env: { ZETTA_TEST_SIGN_IN: tokenFor() } })
    expect(run.code).toBe(4)
    expect(run.errorJson().error).toMatchObject({ code: 'PLAN_REQUIRED', message: 'Choose a plan to start generating.' })
    expect(calls.some((c) => c.url.includes('/2d/') || c.url.endsWith('/3d/quote'))).toBe(false)
  })

  it('checks the plan before spending', async () => {
    const { fetch } = fakeFetch([
      [`GET ${API}/3d/entitlements`, { json: { plan: 'free', entitlements: { ...entitlements.entitlements, allowsZettaN25: false } } }],
    ])
    const run = await zetta(['generate', '-p', 'a chair', '--engine', 'n2.5', '--yes'], { fetch, env: { ZETTA_TEST_SIGN_IN: tokenFor() } })
    expect(run.code).toBe(4)
    expect(run.errorJson().error.code).toBe('PLAN_CAPABILITY_REQUIRED')
  })
})
