import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline as P } from '@zetta3d/sdk'
import { describe, expect, it } from 'vitest'
import { Context } from '../src/core/context'
import { waitPlan } from '../src/core/jobs'
import { fakeFetch } from './fake-fetch'
import { generation, tokenFor, zetta } from './harness'

const API = 'https://api.zetta3d.ai/api'
const env = { ZETTA_TOKEN: tokenFor(), CI: 'false' }
const temp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix))

function png(dir: string): string {
  const bytes = new Uint8Array(64)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(bytes.buffer).setUint32(16, 512)
  new DataView(bytes.buffer).setUint32(20, 512)
  const path = join(dir, 'chair.png')
  writeFileSync(path, bytes)
  return path
}

const entitlements = {
  plan: 'creator',
  entitlements: { maxMultiViewImages: 4, allowsLowPoly: true, allowsQuadMesh: true, allowsCustomFaceCount: true, maxFaceCount: 2_000_000, allowsZettaN25: true, allowsZettaNp1: true, allowsPostProcess: true, allowsPrivateGenerations: true, allowsSplat: true, maxConcurrentJobs: 3 },
}

/** A generation that finishes at once, with one GLB to download. */
function api() {
  return fakeFetch([
    [`GET ${API}/3d/entitlements`, { json: entitlements }],
    [`POST ${API}/3d/quote`, { json: { credits: 50, lines: [{ code: 'textured', label: 'Textured model', credits: 50 }] } }],
    [/^POST https:\/\/api\.zetta3d\.ai\/api\/3d\/uploads$/, { json: { uploadUrl: `${API}/3d/uploads/relay?ticket=t1`, method: 'PUT', headers: { 'Content-Type': 'image/png' }, key: 'inputImg/1/a.png', fileUrl: 'https://files.example/a.png' } }],
    [`PUT ${API}/3d/uploads/relay`, { json: { key: 'inputImg/1/a.png', bytes: 64 } }],
    [`POST ${API}/3d/generations`, { json: { generation: generation(42, 'queued'), quote: { credits: 50, lines: [] }, charged: true } }],
    [`GET ${API}/3d/generations/42/download`, { json: { key: 'gen3d/1/42/model.glb', url: 'https://files.example/model.glb', expiresInSeconds: 900 } }],
    [`GET ${API}/3d/generations/42`, { json: { generation: generation(42, 'success'), queuePosition: null } }],
    ['GET https://files.example/model.glb', { text: 'glTF' }],
  ])
}

const files = (dir: string) => readdirSync(dir).filter((name) => name.endsWith('.glb'))

async function configured(settings: Record<string, string>): Promise<string> {
  const configDir = temp('zd-config-')
  for (const [key, value] of Object.entries(settings)) {
    const set = await zetta(['config', 'set', key, value], { configDir })
    expect(set.code).toBe(0)
  }
  return configDir
}

describe('automatic downloads', () => {
  it('are off for scripts and agents by default: the job returns at once', async () => {
    const cwd = temp('zd-')
    const { fetch, calls } = api()
    const run = await zetta(['generate', '--image', png(cwd), '--yes'], { fetch, env, cwd })
    expect(run.code).toBe(0)
    expect(run.json()).toMatchObject({ id: 42, status: 'queued', next: 'zetta asset wait 42' })
    expect(calls.some((c) => c.url.endsWith('/3d/generations/42'))).toBe(false)
    expect(files(cwd)).toEqual([])
  })

  it('are on in a terminal by default and save into the current folder', async () => {
    const cwd = temp('zd-')
    const { fetch } = api()
    const run = await zetta(['--json', 'generate', '--image', png(cwd), '--yes'], { fetch, env, cwd, tty: true })
    expect(run.code).toBe(0)
    const result = run.json()
    expect(result.status).toBe('success')
    expect(result.files[0].path).toBe(join(cwd, '42-model.glb'))
    expect(result.next).toBeUndefined()
    expect(files(cwd)).toEqual(['42-model.glb'])
  })

  it('--no-download and --no-wait turn them off in a terminal', async () => {
    for (const flag of ['--no-download', '--no-wait']) {
      const cwd = temp('zd-')
      const { fetch } = api()
      const run = await zetta(['--json', 'generate', '--image', png(cwd), '--yes', flag], { fetch, env, cwd, tty: true })
      expect(run.code).toBe(0)
      expect(run.json()).toMatchObject({ status: 'queued', next: 'zetta asset wait 42' })
      expect(files(cwd)).toEqual([])
    }
  })

  it('download.auto false turns them off in a terminal too', async () => {
    const cwd = temp('zd-')
    const configDir = await configured({ 'download.auto': 'false' })
    const { fetch } = api()
    const run = await zetta(['--json', 'generate', '--image', png(cwd), '--yes'], { fetch, env, cwd, tty: true, configDir })
    expect(run.json().status).toBe('queued')
    expect(files(cwd)).toEqual([])
  })

  it('download.auto true turns them on for scripts and agents', async () => {
    const cwd = temp('zd-')
    const configDir = await configured({ 'download.auto': 'true' })
    const { fetch } = api()
    const run = await zetta(['generate', '--image', png(cwd), '--yes'], { fetch, env, cwd, configDir })
    expect(run.code).toBe(0)
    expect(run.json().files.map((f: { path: string }) => f.path)).toEqual([join(cwd, '42-model.glb')])
  })

  it('--download turns them on for one command', async () => {
    const cwd = temp('zd-')
    const { fetch } = api()
    const run = await zetta(['generate', '--image', png(cwd), '--yes', '--download'], { fetch, env, cwd })
    expect(run.code).toBe(0)
    expect(files(cwd)).toEqual(['42-model.glb'])
  })

  it('download.dir picks the folder, relative to where zetta runs', async () => {
    const cwd = temp('zd-')
    const configDir = await configured({ 'download.auto': 'true', 'download.dir': 'models' })
    const { fetch } = api()
    const run = await zetta(['generate', '--image', png(cwd), '--yes'], { fetch, env, cwd, configDir })
    expect(run.json().files[0].path).toBe(join(cwd, 'models', '42-model.glb'))
    expect(files(join(cwd, 'models'))).toEqual(['42-model.glb'])
  })

  it('download.formats with no match warns but never fails the finished job', async () => {
    const cwd = temp('zd-')
    const configDir = await configured({ 'download.auto': 'true', 'download.formats': 'FBX, .usdz' })
    const { fetch } = api()
    const run = await zetta(['generate', '--image', png(cwd), '--yes'], { fetch, env, cwd, configDir })
    expect(run.code).toBe(0)
    expect(run.json()).toMatchObject({ status: 'success', files: [], next: 'zetta asset download 42' })
    expect(run.stderr).toContain('has no fbx/usdz file')
    expect(files(cwd)).toEqual([])
  })

  it('an explicit --out still fails loudly when the format is missing', async () => {
    const cwd = temp('zd-')
    const { fetch } = api()
    const run = await zetta(['generate', '--image', png(cwd), '--yes', '--out', join(cwd, 'out'), '--format', 'fbx'], { fetch, env, cwd })
    expect(run.code).not.toBe(0)
    expect(run.errorJson().error.code).toBe('GEN3D_NO_FILES')
  })

  it('apply to `asset wait`', async () => {
    const cwd = temp('zd-')
    const configDir = await configured({ 'download.auto': 'true' })
    const { fetch } = api()
    const on = await zetta(['asset', 'wait', '42'], { fetch, env, cwd, configDir })
    expect(on.code).toBe(0)
    expect(on.json().saved[0].path).toBe(join(cwd, '42-model.glb'))

    const elsewhere = temp('zd-')
    const off = await zetta(['asset', 'wait', '42', '--no-download'], { fetch, env, cwd: elsewhere, configDir })
    expect(off.json().saved).toBeUndefined()
    expect(files(elsewhere)).toEqual([])
  })

  it('`asset download` without --out uses download.dir', async () => {
    const cwd = temp('zd-')
    const configDir = await configured({ 'download.dir': 'models' })
    const { fetch } = api()
    const run = await zetta(['asset', 'download', '42'], { fetch, env, cwd, configDir })
    expect(run.code).toBe(0)
    expect(files(join(cwd, 'models'))).toEqual(['42-model.glb'])
  })
})

describe('automatic downloads of pipeline runs', () => {
  const recipe = { version: 1, title: 'Picture to rig', steps: { photo: { kind: 'seed_picture' }, model: { kind: 'generate_3d', from: 'photo', engine: 'n25' }, rig: { kind: 'rigging', from: 'model', rigType: 'biped', rigSpec: 'standard', format: 'fbx' } } }
  const compiled = P.compilePipeline(recipe as never)
  if (!compiled.ok) throw new Error('recipe did not compile')
  const graph = compiled.graph
  const step = (id: number, nodeId: string, assetId: number) => ({ id, nodeId, partKey: null, status: 'success', attempt: 1, credits: 50, errorMessage: null, gen3dPostId: assetId, output: null, review: null })
  const doneRun = { id: 7, pipelineId: 12, mode: 'auto', status: 'done', paused: false, seed: null, estimatedCredits: 100, spentCredits: 100, graph, steps: [step(1, 'model', 51), step(2, 'rig', 52)], createdAt: 'x' }

  function runApi() {
    return fakeFetch([
      [`GET ${API}/pipelines/12`, { json: { id: 12, title: 'Picture to rig', graph, problems: [], createdAt: 'x', updatedAt: 'x' } }],
      [`POST ${API}/pipelines/estimate`, { json: { credits: 100, lines: [], perPart: null, problems: [] } }],
      [/^POST https:\/\/api\.zetta3d\.ai\/api\/3d\/uploads$/, { json: { uploadUrl: `${API}/3d/uploads/relay?ticket=t`, method: 'PUT', headers: { 'Content-Type': 'image/png' }, key: 'inputImg/1/x.png', fileUrl: 'https://files.example/x.png' } }],
      [`PUT ${API}/3d/uploads/relay`, { json: {} }],
      [`POST ${API}/pipelines/12/batch`, { json: { runs: [{ id: 7, mode: 'auto', status: 'running' }] } }],
      [`GET ${API}/pipeline-runs/7`, { json: doneRun }],
      [`GET ${API}/3d/generations/52/download`, { json: { key: 'gen3d/1/52/rig.fbx', url: 'https://files.example/rig.fbx', expiresInSeconds: 900 } }],
      [`GET ${API}/3d/generations/52`, { json: { generation: generation(52, 'success', { result: { files: [{ type: 'fbx', key: 'gen3d/1/52/rig.fbx', url: 'x', bytes: 3 }] } }), queuePosition: null } }],
      ['GET https://files.example/rig.fbx', { text: 'FBX' }],
    ])
  }

  it('`run wait` saves only the final models', async () => {
    const cwd = temp('zd-')
    const configDir = await configured({ 'download.auto': 'true' })
    const { fetch, calls } = runApi()
    const run = await zetta(['run', 'wait', '7'], { fetch, env, cwd, configDir })
    expect(run.code).toBe(0)
    expect(run.json().saved.map((f: { path: string }) => f.path)).toEqual([join(cwd, '52-rig.fbx')])
    expect(calls.some((c) => c.url.endsWith('/3d/generations/51'))).toBe(false)
  })

  it('`pipeline run --download` waits for the run, then saves its final models', async () => {
    const cwd = temp('zd-')
    const { fetch } = runApi()
    const run = await zetta(['pipeline', 'run', '12', png(cwd), '--yes', '--download'], { fetch, env, cwd })
    expect(run.code).toBe(0)
    const result = run.json()
    expect(result.runs).toMatchObject([{ id: 7, status: 'done' }])
    expect(result.saved.map((f: { path: string; runId: number }) => [f.runId, f.path])).toEqual([[7, join(cwd, '52-rig.fbx')]])
    expect(result.next).toBeUndefined()
  })

  it('`pipeline run` without the setting returns at once', async () => {
    const cwd = temp('zd-')
    const { fetch, calls } = runApi()
    const run = await zetta(['pipeline', 'run', '12', png(cwd), '--yes'], { fetch, env, cwd })
    expect(run.json()).toMatchObject({ runs: [{ id: 7, status: 'running' }], next: 'zetta run wait 7 --timeout 90s' })
    expect(calls.some((c) => c.url.endsWith('/pipeline-runs/7'))).toBe(false)
  })

  it('drafts cannot be waited for', async () => {
    const cwd = temp('zd-')
    const { fetch } = runApi()
    const run = await zetta(['pipeline', 'run', '12', png(cwd), '--draft', '--download'], { fetch, env, cwd })
    expect(run.code).toBe(2)
  })
})

describe('pictures and the download setting', () => {
  const picture = { postId: 9, images: [{ base64: Buffer.from('png').toString('base64'), contentType: 'image/png' }], text: null }

  it('save into the current folder by default, for scripts too', async () => {
    const cwd = temp('zd-')
    const { fetch } = fakeFetch([[`POST ${API}/2d/generate`, { json: picture }]])
    const run = await zetta(['image', 'generate', '-p', 'a chair'], { fetch, env, cwd })
    expect(run.code).toBe(0)
    expect(run.json().files[0].path).toBe(join(cwd, 'image-9.png'))
  })

  it('stay in the image library with download.auto false', async () => {
    const cwd = temp('zd-')
    const configDir = await configured({ 'download.auto': 'false' })
    const { fetch } = fakeFetch([[`POST ${API}/2d/generate`, { json: picture }]])
    const run = await zetta(['image', 'generate', '-p', 'a chair'], { fetch, env, cwd, configDir })
    expect(run.json()).toMatchObject({ imageId: 9, files: [], next: 'zetta image download 9' })
    expect(existsSync(join(cwd, 'image-9.png'))).toBe(false)
  })
})

describe('the download settings', () => {
  it('parse formats as a list and reject bad values', async () => {
    const configDir = await configured({ 'download.formats': 'GLB, .fbx' })
    const get = await zetta(['config', 'get', 'download.formats'], { configDir })
    expect(JSON.stringify(get.json())).toContain('["glb","fbx"]')
    const bad = await zetta(['config', 'set', 'download.auto', 'sometimes'], { configDir })
    expect(bad.code).toBe(2)
  })

  it('are ignored by MCP tools unless a call asks for a download', () => {
    const configDir = temp('zd-config-')
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ download: { auto: true } }))
    const quiet = { write: () => true, isTTY: false }
    const ctx = new Context({ mode: 'mcp', cwd: '/work', env: { ZETTA_CONFIG_DIR: configDir, ZETTA_NO_KEYCHAIN: '1' }, streams: { stdout: quiet, stderr: quiet } })
    expect(waitPlan(ctx, {}).out).toBeUndefined()
    expect(waitPlan(ctx, { download: true })).toMatchObject({ wait: true, out: '/work', auto: true })
  })
})
