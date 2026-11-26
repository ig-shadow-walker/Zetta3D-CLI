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
    const run = await zetta(['refine', 'rig', '7', '--rig-spec', 'mixamo', '--rig-format', 'fbx', '--yes'], { fetch, env: { ZETTA_TEST_SIGN_IN: tokenFor() } })
    expect(run.code).toBe(0)
    const create = calls.find((c) => c.method === 'POST' && c.url.endsWith('/3d/generations'))!
    expect(create.body).toMatchObject({ sourcePostId: 7, rigSpec: 'mixamo', rigOutFormat: 'fbx', origin: 'cli' })
    expect(create.body).not.toHaveProperty('rigType')
    expect((create.body as { spec: { postProcess: string[] } }).spec.postProcess).toEqual(['auto_rigging'])
  })

  it('rejects an unknown bone naming value', async () => {
    const run = await zetta(['refine', 'rig', '7', '--rig-spec', 'legacy-x'], { env: { ZETTA_TEST_SIGN_IN: tokenFor() } })
    expect(run.code).toBe(2)
  })

  it('writes a humanoid in an engine’s skeleton naming, and refuses one for another body', async () => {
    const { fetch, calls } = api()
    const run = await zetta(['refine', 'rig', '7', '--rig-spec', 'unreal', '--dry-run'], { fetch, env: { ZETTA_TEST_SIGN_IN: tokenFor() } })
    expect(run.code).toBe(0)
    expect(run.json().request).toMatchObject({ rigSpec: 'unreal' })
    expect(run.json().request).not.toHaveProperty('rigType')
    const others = await zetta(['refine', 'rig', '7', '--rig-type', 'others', '--dry-run'], { fetch, env: { ZETTA_TEST_SIGN_IN: tokenFor() } })
    expect(others.json().request).toMatchObject({ rigType: 'others' })
    const refused = await zetta(['refine', 'rig', '7', '--rig-type', 'quadruped', '--rig-spec', 'mixamo', '--dry-run'], { fetch, env: { ZETTA_TEST_SIGN_IN: tokenFor() } })
    expect(refused.code).toBe(2)
    expect(refused.errorJson().error.details.problems[0].code).toBe('RIG_SPEC_NEEDS_BIPED')
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/3d/generations'))).toBe(false)
  })

  it('retopologises on Zetta R1 with the Studio’s defaults', async () => {
    const { fetch, calls } = api()
    const run = await zetta(['refine', 'retopo', '7', '--dry-run'], { fetch, env: { ZETTA_TEST_SIGN_IN: tokenFor() } })
    expect(run.code).toBe(0)
    expect(run.json().request).toEqual({
      spec: { postProcess: ['smart_topology'] },
      sourcePostId: 7,
      model: 'r1',
      faceCount: 8_000,
      polygonType: 'triangle',
      origin: 'cli',
    })
    expect(calls.find((c) => c.url.endsWith('/3d/quote'))!.body).toEqual({ postProcess: ['smart_topology'], model: 'r1' })
  })

  it('unwraps UVs and leaves the textures behind when asked', async () => {
    const { fetch } = api()
    const run = await zetta(['refine', 'retopo', '7', '--faces', '5000', '--quads', '--unwrap-uvs', '--no-bake', '--dry-run'], { fetch, env: { ZETTA_TEST_SIGN_IN: tokenFor() } })
    expect(run.code).toBe(0)
    expect(run.json().request).toMatchObject({ faceCount: 5_000, polygonType: 'quadrilateral', unwrapUvs: true, bake: false })
  })

  it('no longer takes the retired engine or its face level (exit 2)', async () => {
    for (const args of [['--engine', 'n1'], ['--face-level', 'low'], ['--faces', '12000', '--quads']]) {
      const { fetch } = api()
      const run = await zetta(['refine', 'retopo', '7', ...args, '--dry-run'], { fetch, env: { ZETTA_TEST_SIGN_IN: tokenFor() } })
      expect(run.code).toBe(2)
    }
  })

  it('lays out bare UVs by default, and re-bakes only when asked', async () => {
    const { fetch } = api()
    const bare = await zetta(['refine', 'uv', '7', '--orientation', '-x', '--dry-run'], { fetch, env: { ZETTA_TEST_SIGN_IN: tokenFor() } })
    expect(bare.json().request).toMatchObject({ spec: { postProcess: ['smart_uv'] }, bake: false, exportOrientation: '-x' })
    const baked = await zetta(['refine', 'uv', '7', '--bake', '--dry-run'], { fetch, env: { ZETTA_TEST_SIGN_IN: tokenFor() } })
    expect(baked.json().request).not.toHaveProperty('bake')
  })

  it('textures from reference views, front first', async () => {
    const { fetch, calls } = api()
    const run = await zetta(
      ['refine', 'texture', '7', '--view', 'left=https://files.example/l.png', '--view', 'front=https://files.example/f.png', '--tier', 'hd', '--no-delight', '--yes'],
      { fetch, env: { ZETTA_TEST_SIGN_IN: tokenFor() } },
    )
    expect(run.code).toBe(0)
    const create = calls.find((c) => c.method === 'POST' && c.url.endsWith('/3d/generations'))!
    expect(create.body).toMatchObject({
      spec: { postProcess: ['retexture_hd'] },
      sourcePostId: 7,
      multiViewImages: [
        { viewType: 'front', imageUrl: 'https://files.example/f.png' },
        { viewType: 'left', imageUrl: 'https://files.example/l.png' },
      ],
      enablePBR: true,
      delight: false,
    })
    expect(create.body).not.toHaveProperty('imageUrl')
  })

  it('refuses views without the front, or beside a reference (exit 2)', async () => {
    const { fetch } = api()
    const noFront = await zetta(['refine', 'texture', '7', '--view', 'back=https://files.example/b.png', '--dry-run'], { fetch, env: { ZETTA_TEST_SIGN_IN: tokenFor() } })
    expect(noFront.code).toBe(2)
    expect(noFront.errorJson().error.details.problems[0].code).toBe('FRONT_VIEW_REQUIRED')
    const both = await zetta(['refine', 'texture', '7', '--view', 'front=https://files.example/f.png', '--reference', 'https://files.example/r.png', '--dry-run'], { fetch, env: { ZETTA_TEST_SIGN_IN: tokenFor() } })
    expect(both.code).toBe(2)
  })

  it('bounds a conversion’s polygon limit as N2.5’s High rung', async () => {
    const { fetch } = api()
    const ok = await zetta(['refine', 'convert', '7', '--to', 'obj', '--faces', '1000000', '--dry-run'], { fetch, env: { ZETTA_TEST_SIGN_IN: tokenFor() } })
    expect(ok.code).toBe(0)
    expect(ok.json().request).toMatchObject({ spec: { postProcess: ['convert_format_advanced'] }, faceCount: 1_000_000 })
    const over = await zetta(['refine', 'convert', '7', '--to', 'obj', '--faces', '1500000', '--dry-run'], { fetch, env: { ZETTA_TEST_SIGN_IN: tokenFor() } })
    expect(over.code).toBe(2)
  })

  it('prices a conversion without spending', async () => {
    const { fetch, calls } = api()
    const run = await zetta(['refine', 'convert', '7', '--to', 'usdz', '--dry-run'], { fetch, env: { ZETTA_TEST_SIGN_IN: tokenFor() } })
    expect(run.code).toBe(0)
    expect(run.json()).toMatchObject({ dryRun: true, request: { outputFormat: 'USDZ', sourcePostId: 7 } })
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/3d/generations'))).toBe(false)
  })

  it('refuses a source that has not finished', async () => {
    const { fetch } = fakeFetch([[`GET ${API}/3d/generations/7`, { json: { generation: generation(7, 'processing'), queuePosition: null } }]])
    const run = await zetta(['refine', 'uv', '7', '--yes'], { fetch, env: { ZETTA_TEST_SIGN_IN: tokenFor() } })
    expect(run.code).toBe(7)
    expect(run.errorJson().error.code).toBe('GEN3D_NOT_READY')
  })

  it('refuses local OBJ/FBX files (the relay takes GLB)', async () => {
    const run = await zetta(['refine', 'retopo', './model.obj', '--yes'], { env: { ZETTA_TEST_SIGN_IN: tokenFor() } })
    expect(run.code).toBe(2)
  })
})

describe('zetta splat', () => {
  it('prices a world from a video URL', async () => {
    const { fetch, calls } = api()
    const run = await zetta(['splat', 'create', '--video', 'https://files.example/walk.mp4', '--engine', 'splat2', '--dry-run'], { fetch, env: { ZETTA_TEST_SIGN_IN: tokenFor() } })
    expect(run.code).toBe(0)
    expect(run.json().dryRun).toBe(true)
    expect(calls.find((c) => c.url.endsWith('/3d/quote'))!.body).toMatchObject({ generation: { base: 'gaussian_splat' }, model: 'zs2' })
  })
})
