import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodePng } from '@zetta3d/sdk'
import { describe, expect, it } from 'vitest'
import { publicImageEngines } from '../src/commands/image'
import { fakeFetch } from './fake-fetch'
import { tokenFor, zetta } from './harness'

const API = 'https://api.zetta3d.ai/api'
const env = { ZETTA_TEST_SIGN_IN: tokenFor() }
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='
const picture = (postId: number | null = 812) => ({ json: { postId, images: [{ base64: PNG, contentType: 'image/png', bytes: 70 }], text: null, model: 'flash' } })

/** What `GET /2d/models` answers through a session: configured ids, labels for the two main engines. */
const sessionModels = {
  models: [
    { id: 'model-light-7', label: 'Flash', resolutions: ['1K', '2K'] },
    { id: 'model-heavy-3', label: 'Pro', resolutions: ['1K', '2K', '4K'] },
    { id: 'model-extra-1', label: 'model-extra-1', resolutions: ['1K'] },
  ],
  default: 'model-heavy-3',
}
/** The same through an API key: the ids are public names. */
const keyModels = {
  models: [
    { id: 'flash', label: 'Flash', resolutions: ['1K', '2K'] },
    { id: 'pro', label: 'Pro', resolutions: ['1K', '2K', '4K'], locked: true, lockedReason: 'Pro is available on a paid plan.' },
    { id: 'image-1', label: 'image-1', resolutions: ['1K'] },
  ],
  default: 'flash',
}

describe('image engines', () => {
  it('names engines publicly either way, and never shows a configured id', () => {
    expect(publicImageEngines(sessionModels).map((e) => e.name)).toEqual(['flash', 'pro', 'image-1'])
    expect(publicImageEngines(keyModels).map((e) => [e.name, e.id])).toEqual([['flash', 'flash'], ['pro', 'pro'], ['image-1', 'image-1']])
  })

  it('sends the id the server listed for the engine chosen', async () => {
    const { fetch, calls } = fakeFetch([
      [`GET ${API}/2d/models`, { json: sessionModels }],
      [`POST ${API}/2d/generate`, picture()],
    ])
    const dir = mkdtempSync(join(tmpdir(), 'zimg-'))
    const run = await zetta(['image', 'generate', '-p', 'a lamp', '--engine', 'PRO', '--resolution', '4K', '--aspect-ratio', '21:9', '--out', dir], { fetch, env })
    expect(run.code).toBe(0)
    expect(calls.find((c) => c.url.endsWith('/2d/generate'))!.body).toEqual({ prompt: 'a lamp', aspectRatio: '21:9', resolution: '4K', model: 'model-heavy-3' })
    expect(run.stdout).not.toContain('model-heavy-3')
  })

  it('refuses a resolution the engine cannot make, and a locked engine, before sending', async () => {
    const { fetch, calls } = fakeFetch([[`GET ${API}/2d/models`, { json: keyModels }]])
    const tooBig = await zetta(['image', 'generate', '-p', 'a lamp', '--engine', 'flash', '--resolution', '4K'], { fetch, env })
    expect(tooBig.code).toBe(2)
    const locked = await zetta(['image', 'generate', '-p', 'a lamp', '--engine', 'pro'], { fetch, env })
    expect(locked.code).toBe(4)
    expect(locked.errorJson().error.code).toBe('IMAGE_PRO_MODEL_REQUIRES_PLAN')
    const unknown = await zetta(['image', 'generate', '-p', 'a lamp', '--engine', 'turbo'], { fetch, env })
    expect(unknown.code).toBe(2)
    expect(unknown.errorJson().error.message).toContain('flash, pro, image-1')
    expect(calls.every((c) => c.url.endsWith('/2d/models'))).toBe(true)
  })
})

describe('image commands', () => {
  it('composes files and image-library entries together', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zimg-'))
    const file = join(dir, 'sofa.png')
    writeFileSync(file, await encodePng({ width: 200, height: 200, data: new Uint8Array(200 * 200 * 4).fill(128) }))
    const { fetch, calls } = fakeFetch([[`POST ${API}/2d/img-compose`, picture(900)]])
    const run = await zetta(['image', 'compose', file, 'image:5', 'image:6', '-p', 'a room', '--fast', '--out', dir], { fetch, env })
    expect(run.code).toBe(0)
    const body = calls[0]!.body as { images: unknown[]; sourcePostIds: number[]; fast: boolean }
    expect(body.images).toHaveLength(1)
    expect(body.sourcePostIds).toEqual([5, 6])
    expect(body.fast).toBe(true)
  })

  it('needs at least 2 and at most 14 pictures to compose', async () => {
    expect((await zetta(['image', 'compose', 'image:5', '-p', 'x'], { env })).code).toBe(2)
    const fifteen = Array.from({ length: 15 }, (_, i) => `image:${i + 1}`)
    expect((await zetta(['image', 'compose', ...fifteen, '-p', 'x'], { env })).code).toBe(2)
  })

  it('edits a library picture with the 3D preset', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zimg-'))
    const { fetch, calls } = fakeFetch([[`POST ${API}/2d/img-edit`, picture()]])
    const run = await zetta(['image', 'edit', 'image:812', '-p', 'remove the cushion', '--for-3d', '--subject', 'object', '--out', dir], { fetch, env })
    expect(run.code).toBe(0)
    expect(calls[0]!.body).toEqual({ prompt: 'remove the cushion', sourcePostId: 812, for3D: true, subject: 'object' })
  })

  it('saves the picture even when the server could not record it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zimg-'))
    const { fetch } = fakeFetch([[`POST ${API}/2d/generate`, picture(null)]])
    const run = await zetta(['image', 'generate', '-p', 'a lamp', '--no-download', '--out', dir], { fetch, env })
    expect(run.code).toBe(0)
    expect(run.json().imageId).toBeNull()
    expect(run.json().files).toHaveLength(1)
  })

  it('filters the image library by kind (friendly or server names) and search', async () => {
    const { fetch, calls } = fakeFetch([[`GET ${API}/2d`, { json: { items: [], total: 0, page: 1, pageSize: 18 } }]])
    expect((await zetta(['image', 'list', '--kind', 'composeImg', '--search', 'lamp'], { fetch, env })).code).toBe(0)
    expect((await zetta(['image', 'list', '--kind', 'edit'], { fetch, env })).code).toBe(0)
    expect(new URL(calls[0]!.url).searchParams.get('feature')).toBe('composeImg')
    expect(new URL(calls[0]!.url).searchParams.get('search')).toBe('lamp')
    expect(new URL(calls[1]!.url).searchParams.get('feature')).toBe('editImg')
  })
})
