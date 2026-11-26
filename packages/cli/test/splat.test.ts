import { describe, expect, it } from 'vitest'
import { fakeFetch } from './fake-fetch'
import { generation, tokenFor, zetta } from './harness'

const API = 'https://api.zetta3d.ai/api'
const entitlements = { plan: 'creator', entitlements: { maxMultiViewImages: 4, allowsLowPoly: true, allowsQuadMesh: true, allowsCustomFaceCount: true, maxFaceCount: 2_000_000, allowsZettaN25: true, allowsZettaNp1: true, allowsPostProcess: true, allowsPrivateGenerations: true, allowsSplat: true, maxConcurrentJobs: 3 } }
const PICTURE = { postId: 3, images: [{ base64: 'iVBORw0KGgo=', contentType: 'image/png', bytes: 8 }], text: null, model: 'image' }

function api(extra: Array<[string | RegExp, unknown]> = []) {
  return fakeFetch([
    [`GET ${API}/3d/entitlements`, { json: entitlements }],
    [`POST ${API}/3d/quote`, { json: { credits: 60, lines: [{ code: 'gaussian_splat', label: 'Gaussian splat', credits: 60 }] } }],
    [`POST ${API}/2d/generate`, { json: PICTURE }],
    [`POST ${API}/tools/rembg`, { json: { image: 'iVBORw0KGgo=' } }],
    [/^POST https:\/\/api\.zetta3d\.ai\/api\/3d\/uploads$/, { json: { uploadUrl: `${API}/3d/uploads/relay?ticket=t1`, method: 'PUT', headers: { 'Content-Type': 'image/png' }, key: 'inputImg/1/a.png', fileUrl: 'https://files.example/a.png' } }],
    [`PUT ${API}/3d/uploads/relay`, { json: { key: 'inputImg/1/a.png', bytes: 8 } }],
    [`POST ${API}/3d/generations`, { json: { generation: generation(9, 'queued', { selectedModel: 'zs2' }), quote: { credits: 60, lines: [] }, charged: true } }],
    ...(extra as Array<[string | RegExp, never]>),
  ])
}

const env = () => ({ ZETTA_TEST_SIGN_IN: tokenFor() })
const created = (calls: ReturnType<typeof api>['calls']) => calls.find((c) => c.method === 'POST' && c.url.endsWith('/3d/generations'))?.body
const picture = (calls: ReturnType<typeof api>['calls']) => calls.find((c) => c.url.endsWith('/2d/generate'))?.body

describe('zetta splat create', () => {
  it('makes a world from a prompt: an environment picture in the chosen frame, then the world from it', async () => {
    const { fetch, calls } = api()
    const run = await zetta(['splat', 'create', '-p', 'a misty pine forest', '--engine', 'splat2', '--aspect-ratio', '21:9', '--resolution', '2K', '--yes'], { fetch, env: env() })
    expect(run.code).toBe(0)
    expect(picture(calls)).toEqual({ prompt: 'a misty pine forest', for3D: true, subject: 'environment', aspectRatio: '21:9', resolution: '2K' })
    expect(created(calls)).toMatchObject({
      spec: { generation: { base: 'gaussian_splat', modifiers: [] } },
      imageUrl: 'https://files.example/a.png',
      prompt: 'a misty pine forest',
      imageFromPrompt: true,
      model: 'zs2',
      origin: 'cli',
    })
  })

  it('frames an environment at 16:9 and 1K unless told otherwise', async () => {
    const { fetch, calls } = api()
    expect((await zetta(['splat', 'create', '-p', 'a canyon', '--engine', 'splat2.1', '--yes'], { fetch, env: env() })).code).toBe(0)
    expect(picture(calls)).toMatchObject({ subject: 'environment', aspectRatio: '16:9', resolution: '1K' })
    expect(created(calls)).toMatchObject({ model: 'zs21' })
  })

  it('makes an object picture for Zetta Splat, and cuts it out when asked', async () => {
    const { fetch, calls } = api()
    const run = await zetta(['splat', 'create', '-p', 'a red armchair', '--remove-bg', '--yes'], { fetch, env: env() })
    expect(run.code).toBe(0)
    expect(picture(calls)).toEqual({ prompt: 'a red armchair', for3D: true })
    expect(calls.some((c) => c.url.endsWith('/tools/rembg'))).toBe(true)
    expect(created(calls)).toMatchObject({ model: 'n25', imageFromPrompt: true })
  })

  it('refuses a frame for an object, or beside a picture of your own (exit 2)', async () => {
    const { fetch, calls } = api()
    const object = await zetta(['splat', 'create', '-p', 'a chair', '--subject', 'object', '--aspect-ratio', '16:9', '--dry-run'], { fetch, env: env() })
    expect(object.code).toBe(2)
    expect(object.errorJson().error.details.problems[0].code).toBe('OPTION_NOT_APPLICABLE')
    const own = await zetta(['splat', 'create', '--image', 'https://files.example/room.png', '--engine', 'splat2', '--resolution', '4K', '--dry-run'], { fetch, env: env() })
    expect(own.code).toBe(2)
    const odd = await zetta(['splat', 'create', '-p', 'a beach', '--engine', 'splat2', '--aspect-ratio', '9:16', '--dry-run'], { fetch, env: env() })
    expect(odd.code).toBe(2)
    expect(calls.some((c) => c.url.includes('/2d/') || c.url.endsWith('/3d/generations'))).toBe(false)
  })

  it('cuts out only an object on Zetta Splat (exit 2 elsewhere)', async () => {
    const { fetch } = api()
    const run = await zetta(['splat', 'create', '--image', 'https://files.example/room.png', '--engine', 'splat2', '--remove-bg', '--dry-run'], { fetch, env: env() })
    expect(run.code).toBe(2)
    expect(run.errorJson().error.details.problems[0].code).toBe('CUT_OUT_NOT_OFFERED')
  })

  it('places more directions of a world, and keeps them off Zetta Splat', async () => {
    const { fetch, calls } = api()
    const run = await zetta(
      ['splat', 'create', '--image', 'https://files.example/f.png', '--engine', 'splat2', '--world-view', '90=https://files.example/r.png', '--world-view', 'https://files.example/x.png', '--yes'],
      { fetch, env: env() },
    )
    expect(run.code).toBe(0)
    expect(created(calls)).toMatchObject({
      imageUrl: 'https://files.example/f.png',
      worldViews: [{ azimuth: 90, imageUrl: 'https://files.example/r.png' }, { imageUrl: 'https://files.example/x.png' }],
    })
    const object = await zetta(['splat', 'create', '--image', 'https://files.example/f.png', '--world-view', '90=https://files.example/r.png', '--dry-run'], { fetch, env: env() })
    expect(object.code).toBe(2)
  })

  it('takes up to eight pictures of the same space', async () => {
    const { fetch } = api()
    const views = [10, 20, 30, 40, 50, 60, 70].flatMap((a) => ['--world-view', `${a}=https://files.example/${a}.png`])
    const ok = await zetta(['splat', 'create', '--image', 'https://files.example/f.png', '--engine', 'splat2', ...views, '--same-space', '--dry-run'], { fetch, env: env() })
    expect(ok.code).toBe(0)
    expect(ok.json().request).toMatchObject({ reconstructImages: true })
    const tooMany = await zetta(['splat', 'create', '--image', 'https://files.example/f.png', '--engine', 'splat2', ...views, '--dry-run'], { fetch, env: env() })
    expect(tooMany.code).toBe(2)
  })

  it('builds a world from a video, as a place only', async () => {
    const { fetch } = api()
    const ok = await zetta(['splat', 'create', '--video', 'https://files.example/walk.mp4', '--engine', 'splat2', '--dry-run'], { fetch, env: env() })
    expect(ok.code).toBe(0)
    expect(ok.json().request).toMatchObject({ model: 'zs2' })
    expect(ok.json().request.videoUrl).toBeTruthy()
    expect(ok.json().request).not.toHaveProperty('imageUrl')
    const object = await zetta(['splat', 'create', '--video', 'https://files.example/walk.mp4', '--engine', 'splat2', '--subject', 'object', '--dry-run'], { fetch, env: env() })
    expect(object.code).toBe(2)
    expect(object.errorJson().error.details.problems[0].code).toBe('VIDEO_NEEDS_ENVIRONMENT')
  })

  it('needs a paid plan (PLAN_REQUIRED, exit 4)', async () => {
    const { fetch } = fakeFetch([[`GET ${API}/3d/entitlements`, { json: { plan: 'free', entitlements: { ...entitlements.entitlements, allowsPrivateGenerations: false, allowsSplat: false } } }]])
    const run = await zetta(['splat', 'create', '--image', 'https://files.example/f.png', '--yes'], { fetch, env: env() })
    expect(run.code).toBe(4)
    expect(run.errorJson().error.code).toBe('PLAN_REQUIRED')
  })
})

describe('zetta splat export', () => {
  const world = [`GET ${API}/3d/generations/9`, { json: { generation: generation(9, 'success', { selectedModel: 'zs21', selectedFeature: 'gaussianSplat' }), queuePosition: null } }] as [string, unknown]

  it('exports the splats at a chosen size on the engine that made the world', async () => {
    const { fetch, calls } = api([world])
    const run = await zetta(['splat', 'export', '9', '--as', 'splat', '--resolution', '500k', '--dry-run'], { fetch, env: env() })
    expect(run.code).toBe(0)
    expect(run.json().request).toEqual({
      spec: { postProcess: ['world_splat_export'] },
      sourcePostId: 9,
      model: 'zs21',
      splatResolution: '500k',
      origin: 'cli',
    })
    expect(calls.find((c) => c.url.endsWith('/3d/quote'))!.body).toEqual({ postProcess: ['world_splat_export'], model: 'zs21' })
  })

  it('names the mesh variant on a mesh export, and nothing on a collider', async () => {
    const { fetch } = api([world])
    const mesh = await zetta(['splat', 'export', '9', '--as', 'mesh', '--mesh-variant', 'vertex_colored', '--dry-run'], { fetch, env: env() })
    expect(mesh.json().request).toMatchObject({ spec: { postProcess: ['world_mesh_export'] }, meshVariant: 'vertex_colored' })
    const collider = await zetta(['splat', 'export', '9', '--as', 'collider', '--dry-run'], { fetch, env: env() })
    expect(collider.json().request.spec).toEqual({ postProcess: ['world_collider_export'] })
    expect(collider.json().request).not.toHaveProperty('meshVariant')
    const wrong = await zetta(['splat', 'export', '9', '--as', 'collider', '--resolution', '150k', '--dry-run'], { fetch, env: env() })
    expect(wrong.code).toBe(2)
  })
})
