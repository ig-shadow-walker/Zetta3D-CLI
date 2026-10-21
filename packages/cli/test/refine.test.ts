import { describe, expect, it } from 'vitest'
import { fakeFetch } from './fake-fetch'
import { generation, tokenFor, zetta } from './harness'

const API = 'https://api.zetta3d.ai/api'
const entitlements = { plan: 'creator', entitlements: { maxMultiViewImages: 4, allowsLowPoly: true, allowsQuadMesh: true, allowsCustomFaceCount: true, maxFaceCount: 2_000_000, allowsZettaN25: true, allowsZettaNp1: true, allowsPostProcess: true, allowsPrivateGenerations: true, allowsSplat: true, maxConcurrentJobs: 3 } }

function api(extra: Array<[string | RegExp, unknown]> = []) {
  return fakeFetch([
    [`GET ${API}/3d/entitlements`, { json: entitlements }],
    [`GET ${API}/3d/generations/7`, { json: { generation: generation(7, 'success'), queuePosition: null } }],
    [`POST ${API}/3d/quote`, { json: { credits: 42, lines: [{ code: 'auto_rigging', label: 'Auto rig', credits: 42 }] } }],
    [`POST ${API}/3d/generations`, { json: { generation: generation(8, 'queued', { selectedFeature: 'autoRigging' }), quote: { credits: 42, lines: [] }, charged: true } }],
    ...(extra as Array<[string | RegExp, never]>),
  ])
}

describe('zetta refine', () => {
  it('rigs a library asset with neutral bone naming', async () => {
    const { fetch, calls } = api()
    const run = await zetta(['refine', 'rig', '7', '--rig-type', 'quadruped', '--rig-spec', 'mixamo', '--rig-format', 'fbx', '--yes'], { fetch, env: { ZETTA_TOKEN: tokenFor() } })
    expect(run.code).toBe(0)
    const create = calls.find((c) => c.method === 'POST' && c.url.endsWith('/3d/generations'))!
    expect(create.body).toMatchObject({ sourcePostId: 7, rigType: 'quadruped', rigSpec: 'mixamo', rigOutFormat: 'fbx', origin: 'cli' })
    expect((create.body as { spec: { postProcess: string[] } }).spec.postProcess).toEqual(['auto_rigging'])
  })

  it('rejects an unknown bone naming value', async () => {
    const run = await zetta(['refine', 'rig', '7', '--rig-spec', 'legacy-x'], { env: { ZETTA_TOKEN: tokenFor() } })
    expect(run.code).toBe(2)
  })

  it('prices a conversion without spending', async () => {
    const { fetch, calls } = api()
    const run = await zetta(['refine', 'convert', '7', '--to', 'usdz', '--dry-run'], { fetch, env: { ZETTA_TOKEN: tokenFor() } })
    expect(run.code).toBe(0)
    expect(run.json()).toMatchObject({ dryRun: true, request: { outputFormat: 'USDZ', sourcePostId: 7 } })
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/3d/generations'))).toBe(false)
  })

  it('refuses a source that has not finished', async () => {
    const { fetch } = fakeFetch([[`GET ${API}/3d/generations/7`, { json: { generation: generation(7, 'processing'), queuePosition: null } }]])
    const run = await zetta(['refine', 'uv', '7', '--yes'], { fetch, env: { ZETTA_TOKEN: tokenFor() } })
    expect(run.code).toBe(7)
    expect(run.errorJson().error.code).toBe('GEN3D_NOT_READY')
  })

  it('refuses local OBJ/FBX files (the relay takes GLB)', async () => {
    const run = await zetta(['refine', 'retopo', './model.obj', '--yes'], { env: { ZETTA_TOKEN: tokenFor() } })
    expect(run.code).toBe(2)
  })
})

describe('zetta splat', () => {
  it('prices a world from a video URL', async () => {
    const { fetch, calls } = api()
    const run = await zetta(['splat', 'create', '--video', 'https://files.example/walk.mp4', '--engine', 'splat2', '--dry-run'], { fetch, env: { ZETTA_TOKEN: tokenFor() } })
    expect(run.code).toBe(0)
    expect(run.json().dryRun).toBe(true)
    expect(calls.find((c) => c.url.endsWith('/3d/quote'))!.body).toMatchObject({ generation: { base: 'gaussian_splat' }, model: 'zs2' })
  })
})
