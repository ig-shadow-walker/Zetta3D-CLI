import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { decodePng, encodePng, parseGlb, TEXTURE_MAP_PROMPTS, type RasterImage } from '@zetta3d/sdk'
import { describe, expect, it } from 'vitest'
import { zipEntryNames, zipFiles } from '../src/core/local-files'
import { fakeFetch, type Call } from './fake-fetch'
import { generation, tokenFor, zetta } from './harness'

const API = 'https://api.zetta3d.ai/api'
const env = { ZETTA_TEST_SIGN_IN: tokenFor() }
const RELAY = `${API}/3d/uploads/relay?ticket=t1`
const ticket = (key: string) => ({ uploadUrl: RELAY, method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, key, fileUrl: 'https://files.example/x', expiresAt: 'x' })

/** Serves binary files by URL, and everything else from a scripted fake. */
function withFiles(base: typeof fetch, files: Record<string, Uint8Array>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const bytes = files[String(input)]
    return bytes ? new Response(bytes as BodyInit) : base(input, init)
  }) as typeof fetch
}

const bodyBytes = async (call: Call) => new Uint8Array(await (call.body as Blob).arrayBuffer())

function solid(width: number, height: number, rgba: [number, number, number, number]): RasterImage {
  const data = new Uint8Array(width * height * 4)
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i)
  return { width, height, data }
}

/** A one-triangle GLB whose material has an embedded base-colour picture (and optionally more). */
function texturedGlb(baseColour: Uint8Array, material: Record<string, unknown> = {}): Uint8Array {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
  const pad = (n: number) => Math.ceil(n / 4) * 4
  const bin = new Uint8Array(36 + pad(baseColour.length))
  bin.set(new Uint8Array(positions.buffer), 0)
  bin.set(baseColour, 36)
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ name: 'Body', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, ...material } }],
    textures: [{ source: 0 }],
    images: [{ bufferView: 1, mimeType: 'image/png' }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: baseColour.length },
    ],
    buffers: [{ byteLength: bin.length }],
  }
  let text = JSON.stringify(json)
  while (text.length % 4) text += ' '
  const jsonBytes = new TextEncoder().encode(text)
  const out = new Uint8Array(12 + 8 + jsonBytes.length + 8 + bin.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, 0x46546c67, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, out.length, true)
  view.setUint32(12, jsonBytes.length, true)
  view.setUint32(16, 0x4e4f534a, true)
  out.set(jsonBytes, 20)
  view.setUint32(20 + jsonBytes.length, bin.length, true)
  view.setUint32(24 + jsonBytes.length, 0x004e4942, true)
  out.set(bin, 28 + jsonBytes.length)
  return out
}

/** The files inside a zip, unpacked. */
function unzip(bytes: Uint8Array): Record<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out: Record<string, Uint8Array> = {}
  for (let at = 0; view.getUint32(at, true) === 0x04034b50; ) {
    const method = view.getUint16(at + 8, true)
    const size = view.getUint32(at + 18, true)
    const nameLength = view.getUint16(at + 26, true)
    const extra = view.getUint16(at + 28, true)
    const name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLength))
    const data = bytes.subarray(at + 30 + nameLength + extra, at + 30 + nameLength + extra + size)
    out[name] = method === 8 ? new Uint8Array(inflateRawSync(data)) : data
    at += 30 + nameLength + extra + size
  }
  return out
}

describe('asset list', () => {
  it('sends the current library query and shows pipeline runs as one entry', async () => {
    const run = { runId: 9, pipelineId: 3, pipelineTitle: 'Props', count: 2, members: [generation(11), generation(10)] }
    const { fetch, calls } = fakeFetch([[`GET ${API}/3d/generations`, { json: { items: [generation(11, 'success', { runGroup: run })], total: 1, page: 1, pageSize: 50 } }]])
    const result = await zetta(
      ['asset', 'list', '--status', 'success', '--status', 'failed', '--kind', 'smartSegmentation', '--search', ' dragon ', '--visibility', 'private', '--group-runs', '--sort', 'updated', '--oldest-first', '--limit', '50'],
      { fetch, env },
    )
    expect(result.code).toBe(0)
    const url = new URL(calls[0]!.url)
    expect(url.searchParams.getAll('status')).toEqual(['success', 'failed'])
    expect(Object.fromEntries([...url.searchParams].filter(([k]) => k !== 'status'))).toEqual({
      page: '1',
      pageSize: '50',
      feature: 'smartSegmentation',
      search: 'dragon',
      availability: 'private',
      groupRuns: 'true',
      sortBy: 'updatedAt',
      sortDir: 'ASC',
    })
    expect(result.json().items[0].run).toEqual({ id: 9, pipelineId: 3, pipeline: 'Props', count: 2, members: [11, 10] })
  })

  it('refuses a kind the library does not have', async () => {
    expect((await zetta(['asset', 'list', '--kind', 'sculpt'], { env })).code).toBe(2)
  })
})

describe('asset delete', () => {
  it('deletes several assets and reports the ones that failed', async () => {
    const { fetch, calls } = fakeFetch([
      [`DELETE ${API}/3d/generations/1`, { status: 204 }],
      [`DELETE ${API}/3d/generations/2`, { status: 404, json: { message: 'Generation 2 was not found.' } }],
    ])
    const run = await zetta(['asset', 'delete', '1', '2', '1', '--yes'], { fetch, env })
    expect(run.code).toBe(1)
    expect(run.json()).toMatchObject({ deleted: [1], failed: [{ id: 2 }] })
    expect(calls).toHaveLength(2)
  })
})

describe('asset import', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zimport-'))
  const glb = join(dir, 'chair.glb')
  writeFileSync(glb, texturedGlb(new Uint8Array([1, 2, 3, 4])))

  function api() {
    return fakeFetch([
      [`POST ${API}/3d/uploads/post`, { status: 201, json: { generation: generation(50, 'success', { selectedFeature: 'upload' }) } }],
      [`POST ${API}/3d/uploads`, { json: ticket('inputImg/1/u.bin') }],
      [`PUT ${RELAY}`, { json: {} }],
    ])
  }

  it('sends a GLB as it is', async () => {
    const { fetch, calls } = api()
    const run = await zetta(['asset', 'import', glb], { fetch, env })
    expect(run.code).toBe(0)
    expect(calls[0]!.body).toEqual({ contentType: 'model/gltf-binary' })
    expect(await bodyBytes(calls[1]!)).toEqual(new Uint8Array(readFileSync(glb)))
    expect(calls[2]!.body).toEqual({ key: 'inputImg/1/u.bin', bytes: readFileSync(glb).length, title: 'chair', feature: 'upload' })
    expect(run.json()).toMatchObject({ id: 50, imported: { model: 'chair.glb', format: 'glb', files: 1, zipped: false } })
  })

  it('sends any other format with its extension', async () => {
    const stl = join(dir, 'bracket.STL')
    writeFileSync(stl, 'solid bracket\nendsolid bracket\n')
    const { fetch, calls } = api()
    const run = await zetta(['asset', 'import', stl, '--title', 'Wall bracket', '--source', '7', '--rigged'], { fetch, env })
    expect(run.code).toBe(0)
    expect(calls[0]!.body).toEqual({ contentType: 'application/octet-stream', extension: 'stl' })
    expect(calls[2]!.body).toMatchObject({ title: 'Wall bracket', feature: 'autoRigging', sourcePostId: 7 })
  })

  it('zips a model with its companion files', async () => {
    const obj = join(dir, 'lamp.obj')
    writeFileSync(obj, 'mtllib lamp.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'.repeat(20))
    writeFileSync(join(dir, 'lamp.mtl'), 'newmtl a\nmap_Kd brass.png\n')
    writeFileSync(join(dir, 'brass.png'), await encodePng(solid(2, 2, [200, 150, 50, 255])))
    const { fetch, calls } = api()
    const run = await zetta(['asset', 'import', obj, join(dir, 'lamp.mtl'), join(dir, 'brass.png')], { fetch, env })
    expect(run.code).toBe(0)
    expect(calls[0]!.body).toEqual({ contentType: 'application/octet-stream', extension: 'zip' })
    const files = unzip(await bodyBytes(calls[1]!))
    expect(Object.keys(files).sort()).toEqual(['brass.png', 'lamp.mtl', 'lamp.obj'])
    expect(new TextDecoder().decode(files['lamp.obj'])).toBe(readFileSync(obj, 'utf8'))
    expect(calls[2]!.body).toMatchObject({ title: 'lamp' })
    expect(run.json().imported).toMatchObject({ model: 'lamp.obj', format: 'zip', files: 3, zipped: true })
  })

  it('zips a folder, keeping paths inside it and skipping hidden files', async () => {
    const folder = join(dir, 'robot')
    mkdirSync(join(folder, 'textures'), { recursive: true })
    writeFileSync(join(folder, 'robot.gltf'), '{"asset":{"version":"2.0"}}')
    writeFileSync(join(folder, 'robot.bin'), new Uint8Array(16))
    writeFileSync(join(folder, 'textures', 'metal.png'), await encodePng(solid(1, 1, [9, 9, 9, 255])))
    writeFileSync(join(folder, '.DS_Store'), 'x')
    const { fetch, calls } = api()
    const run = await zetta(['asset', 'import', folder], { fetch, env })
    expect(run.code).toBe(0)
    expect(Object.keys(unzip(await bodyBytes(calls[1]!))).sort()).toEqual(['robot.bin', 'robot.gltf', 'textures/metal.png'])
    expect(calls[2]!.body).toMatchObject({ title: 'robot' })
  })

  it('sends a zip as it is once it holds a model', async () => {
    const zip = join(dir, 'pack.zip')
    writeFileSync(zip, zipFiles([{ name: 'model/boat.fbx', bytes: new Uint8Array([1]) }, { name: 'model/wood.jpg', bytes: new Uint8Array([2]) }]))
    expect(zipEntryNames(zip)).toEqual(['model/boat.fbx', 'model/wood.jpg'])
    const { fetch, calls } = api()
    const run = await zetta(['asset', 'import', zip], { fetch, env })
    expect(run.code).toBe(0)
    expect(calls[0]!.body).toEqual({ contentType: 'application/octet-stream', extension: 'zip' })
    expect(calls[2]!.body).toMatchObject({ title: 'boat' })
  })

  it('refuses files with no model among them, before uploading', async () => {
    const { fetch, calls } = api()
    const run = await zetta(['asset', 'import', join(dir, 'brass.png')], { fetch, env })
    expect(run.code).toBe(2)
    expect(run.errorJson().error.code).toBe('UNSUPPORTED_FILE_TYPE')
    expect(calls).toHaveLength(0)
  })

  it('needs --source with --rigged', async () => {
    expect((await zetta(['asset', 'import', glb, '--rigged'], { env })).code).toBe(2)
  })
})

describe('asset replace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zreplace-'))
  const glb = join(dir, 'fixed.glb')
  writeFileSync(glb, texturedGlb(new Uint8Array([5, 6, 7, 8])))

  it('saves a GLB over one part of a segmented asset (parts count from 1)', async () => {
    const { fetch, calls } = fakeFetch([
      [`POST ${API}/3d/generations/40/result-upload`, { json: { uploadUrl: RELAY, method: 'PUT', headers: { 'Content-Type': 'model/gltf-binary' }, key: 'gen3d/1/40/model-2.glb' } }],
      [`PUT ${RELAY}`, { json: {} }],
    ])
    const run = await zetta(['asset', 'replace', '40', glb, '--part', '2', '--yes'], { fetch, env })
    expect(run.code).toBe(0)
    expect(calls[0]!.body).toEqual({ part: 1, format: 'glb' })
    expect(calls[1]!.headers['content-type']).toBe('model/gltf-binary')
    expect(await bodyBytes(calls[1]!)).toEqual(new Uint8Array(readFileSync(glb)))
    expect(run.json()).toMatchObject({ id: 40, part: 2, format: 'glb', key: 'gen3d/1/40/model-2.glb' })
  })

  it('asks first, and without a terminal needs --yes (nothing is sent)', async () => {
    const { fetch, calls } = fakeFetch([])
    const run = await zetta(['asset', 'replace', '40', glb], { fetch, env })
    expect(run.code).toBe(2)
    expect(run.errorJson().error.message).toContain('--yes')
    expect(calls).toHaveLength(0)
  })

  it('refuses a file that does not match --format', async () => {
    const run = await zetta(['asset', 'replace', '40', glb, '--format', 'fbx', '--yes'], { env })
    expect(run.code).toBe(2)
  })

  it('sends an FBX as the FBX', async () => {
    const fbx = join(dir, 'rig.fbx')
    writeFileSync(fbx, Buffer.concat([Buffer.from('Kaydara FBX Binary  \0'), Buffer.alloc(40)]))
    const { fetch, calls } = fakeFetch([
      [`POST ${API}/3d/generations/41/result-upload`, { json: { uploadUrl: RELAY, method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, key: 'gen3d/1/41/rig.fbx' } }],
      [`PUT ${RELAY}`, { json: {} }],
    ])
    const run = await zetta(['asset', 'replace', '41', fbx, '--yes'], { fetch, env })
    expect(run.code).toBe(0)
    expect(calls[0]!.body).toEqual({ format: 'fbx' })
  })
})

describe('asset texture-map', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zmaps-'))

  async function edits(maps: Record<string, RasterImage>) {
    const replies = await Promise.all(
      Object.values(maps).map(async (image, i) => ({ json: { postId: 900 + i, images: [{ base64: Buffer.from(await encodePng(image)).toString('base64'), contentType: 'image/png', bytes: 1 }], text: null, model: 'flash' } })),
    )
    return replies
  }

  it('asks for each map the way the Studio does, and saves the pictures', async () => {
    const glb = join(dir, 'crate.glb')
    writeFileSync(glb, texturedGlb(await encodePng(solid(4, 2, [120, 80, 40, 255]))))
    const { fetch, calls } = fakeFetch([[`POST ${API}/2d/img-edit`, await edits({ normal: solid(2, 2, [128, 128, 255, 255]), ao: solid(2, 2, [200, 200, 200, 255]) })]])
    const run = await zetta(['asset', 'texture-map', glb, '--map', 'normal,ao', '--out', join(dir, 'maps')], { fetch, env })
    expect(run.code).toBe(0)
    const sent = calls.map((c) => c.body as Record<string, unknown>)
    expect(sent[0]).toMatchObject({ prompt: TEXTURE_MAP_PROMPTS.normal, textureMap: true, aspectRatio: '1:1', resolution: '1K', image: { contentType: 'image/png' } })
    expect(sent[1]).toMatchObject({ prompt: TEXTURE_MAP_PROMPTS.ao, textureMap: true })
    expect(sent[0]).not.toHaveProperty('pipelineStep')
    const maps = run.json().maps
    expect(maps.map((m: { map: string; imageId: number }) => [m.map, m.imageId])).toEqual([['normal', 900], ['ao', 901]])
    expect((await decodePng(new Uint8Array(readFileSync(maps[0].path)))).data.subarray(0, 4)).toEqual(new Uint8Array([128, 128, 255, 255]))
    expect(run.json().applied).toBeUndefined()
  })

  it('--apply embeds the maps, packing roughness and metalness into one texture', async () => {
    const glb = join(dir, 'barrel.glb')
    writeFileSync(glb, texturedGlb(await encodePng(solid(2, 2, [90, 90, 90, 255])), { metallicFactor: 0 }))
    const { fetch } = fakeFetch([
      [`POST ${API}/2d/img-edit`, await edits({ normal: solid(2, 2, [128, 128, 255, 255]), roughness: solid(2, 2, [60, 60, 60, 255]), metalness: solid(2, 2, [250, 250, 250, 255]) })],
    ])
    const run = await zetta(['asset', 'texture-map', glb, '--map', 'normal', '--map', 'roughness', '--map', 'metalness', '--apply', '--out', join(dir, 'out')], { fetch, env })
    expect(run.code).toBe(0)
    const applied = run.json().applied
    expect(applied.path).toMatch(/barrel-maps\.glb$/)
    const out = parseGlb(new Uint8Array(readFileSync(applied.path)), { geometry: false })
    const material = (out.json.materials as Array<Record<string, any>>)[0]!
    expect(material.normalTexture.index).toBe(1)
    expect(material.pbrMetallicRoughness.metallicFactor).toBe(1)
    const packedImage = out.json.images![out.json.textures![material.pbrMetallicRoughness.metallicRoughnessTexture.index]!.source!]!
    const view = out.json.bufferViews![packedImage.bufferView!]!
    const packed = await decodePng(out.bin.slice(view.byteOffset, view.byteOffset! + view.byteLength))
    expect([packed.data[1], packed.data[2]]).toEqual([60, 250])
    expect(applied.notes.join(' ')).toContain('metallic factor set to 1')
  })

  it('--apply on a library asset saves over its GLB', async () => {
    const source = texturedGlb(await encodePng(solid(2, 2, [10, 20, 30, 255])))
    const { fetch: base, calls } = fakeFetch([
      [`GET ${API}/3d/generations/60/download`, { json: { key: 'gen3d/1/60/model.glb', url: 'https://files.example/60.glb', expiresInSeconds: 900 } }],
      [`GET ${API}/3d/generations/60`, { json: { generation: generation(60, 'success', { result: { files: [{ type: 'glb', key: 'gen3d/1/60/model.glb', url: 'x' }] } }), queuePosition: null } }],
      [`POST ${API}/2d/img-edit`, await edits({ emissive: solid(2, 2, [0, 0, 0, 255]) })],
      [`POST ${API}/3d/generations/60/result-upload`, { json: { uploadUrl: RELAY, method: 'PUT', headers: { 'Content-Type': 'model/gltf-binary' }, key: 'gen3d/1/60/model.glb' } }],
      [`PUT ${RELAY}`, { json: {} }],
    ])
    const fetch = withFiles(base, { 'https://files.example/60.glb': source })
    const run = await zetta(['asset', 'texture-map', '60', '--map', 'emissive', '--apply', '--out', join(dir, 'lib')], { fetch, env })
    expect(run.code).toBe(0)
    expect(run.json().applied).toMatchObject({ id: 60, key: 'gen3d/1/60/model.glb' })
    const upload = calls.find((c) => c.url.endsWith('/result-upload'))!
    expect(upload.body).toEqual({ format: 'glb' })
    const saved = parseGlb(await bodyBytes(calls.find((c) => c.method === 'PUT')!), { geometry: false })
    expect((saved.json.materials as Array<Record<string, any>>)[0]!.emissiveFactor).toEqual([1, 1, 1])
  })

  it('a segmented asset needs --part', async () => {
    const { fetch } = fakeFetch([
      [`GET ${API}/3d/generations/61`, { json: { generation: generation(61, 'success', { selectedFeature: 'segmentation', result: { files: [{ type: 'glb', key: 'a-1.glb', url: 'x' }, { type: 'glb', key: 'a-0.glb', url: 'x' }] } }), queuePosition: null } }],
    ])
    const run = await zetta(['asset', 'texture-map', '61', '--map', 'normal'], { fetch, env })
    expect(run.code).toBe(2)
    expect(run.errorJson().error.message).toContain('--part')
  })

  it('makes a map from a picture, but will not --apply to one', async () => {
    const png = join(dir, 'albedo.png')
    writeFileSync(png, await encodePng(solid(3000, 1, [1, 2, 3, 255])))
    const { fetch, calls } = fakeFetch([[`POST ${API}/2d/img-edit`, await edits({ normal: solid(1, 1, [128, 128, 255, 255]) })]])
    expect((await zetta(['asset', 'texture-map', png, '--map', 'normal', '--apply'], { fetch, env })).code).toBe(2)
    const run = await zetta(['asset', 'texture-map', png, '--map', 'normal', '--out', join(dir, 'pic')], { fetch, env })
    expect(run.code).toBe(0)
    // A PNG over 1024 px goes as a 1024×1024 copy, and the map is asked for at the source's size.
    const sent = calls.at(-1)!.body as { resolution: string; image: { data: string } }
    expect(sent.resolution).toBe('4K')
    const picture = await decodePng(new Uint8Array(Buffer.from(sent.image.data, 'base64')))
    expect([picture.width, picture.height]).toEqual([1024, 1024])
  })
})

describe('asset rig-check', () => {
  it('sends 1–4 frames and refuses more', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zrig-'))
    const frames = await Promise.all([1, 2, 3, 4, 5].map(async (i) => {
      const path = join(dir, `view${i}.png`)
      writeFileSync(path, await encodePng(solid(200, 200, [i, i, i, 255])))
      return path
    }))
    const { fetch, calls } = fakeFetch([[`POST ${API}/ai/rigging-precheck`, { json: { bodyType: 'unknown', confidence: 'low', reason: 'A chair.' } }]])
    const flags = (n: number) => frames.slice(0, n).flatMap((f) => ['--frame', f])
    expect((await zetta(['asset', 'rig-check', '5', ...flags(5)], { fetch, env })).code).toBe(2)
    const run = await zetta(['asset', 'rig-check', '5', ...flags(4)], { fetch, env })
    expect(run.code).toBe(0)
    expect((calls[0]!.body as { frames: unknown[] }).frames).toHaveLength(4)
    expect(run.json()).toMatchObject({ bodyType: 'unknown', frames: 4, next: 'zetta refine rig 5 --rig-type <type>' })
  })
})

describe('local file helpers', () => {
  it('round-trips PNGs and zips', async () => {
    const image = solid(3, 2, [1, 2, 3, 4])
    image.data[5] = 99
    const back = await decodePng(await encodePng(image))
    expect([back.width, back.height]).toEqual([3, 2])
    expect(back.data).toEqual(image.data)
    const rgb = await decodePng(await encodePng(image, { alpha: false }))
    expect(rgb.data[3]).toBe(255)
    const zip = zipFiles([{ name: 'a.txt', bytes: new TextEncoder().encode('hello hello hello hello') }, { name: 'b/c.png', bytes: new Uint8Array([1, 2]) }])
    const files = unzip(zip)
    expect(new TextDecoder().decode(files['a.txt'])).toBe('hello hello hello hello')
    expect(files['b/c.png']).toEqual(new Uint8Array([1, 2]))
  })
})
