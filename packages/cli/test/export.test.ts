import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { zetta } from './harness'

/** A one-triangle GLB with a red material, built by hand. */
function tinyGlb(): Uint8Array {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
  const uvs = new Float32Array([0, 0, 1, 0, 0, 1])
  const indices = new Uint16Array([0, 1, 2, 0])
  const bin = new Uint8Array(positions.byteLength + uvs.byteLength + indices.byteLength)
  bin.set(new Uint8Array(positions.buffer), 0)
  bin.set(new Uint8Array(uvs.buffer), 36)
  bin.set(new Uint8Array(indices.buffer), 60)
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'tri', mesh: 0, translation: [1, 2, 3] }],
    meshes: [{ name: 'tri', primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }] }],
    materials: [{ name: 'red', pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' },
      { bufferView: 2, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 24 },
      { buffer: 0, byteOffset: 60, byteLength: 6 },
    ],
    buffers: [{ byteLength: bin.byteLength }],
  }
  let text = JSON.stringify(json)
  while (text.length % 4) text += ' '
  const jsonBytes = new TextEncoder().encode(text)
  const total = 12 + 8 + jsonBytes.length + 8 + bin.length
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint32(0, 0x46546c67, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, total, true)
  view.setUint32(12, jsonBytes.length, true)
  view.setUint32(16, 0x4e4f534a, true)
  out.set(jsonBytes, 20)
  view.setUint32(20 + jsonBytes.length, bin.length, true)
  view.setUint32(24 + jsonBytes.length, 0x004e4942, true)
  out.set(bin, 28 + jsonBytes.length)
  return out
}

describe('asset export (local)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zx-'))
  const glb = join(dir, 'tri.glb')
  writeFileSync(glb, tinyGlb())

  it('writes OBJ + MTL with the node transform baked in', async () => {
    const run = await zetta(['asset', 'export', glb, '--format', 'obj', '--out', join(dir, 'obj')])
    expect(run.code).toBe(0)
    const obj = readFileSync(join(dir, 'obj', 'tri.obj'), 'utf8')
    expect(obj).toContain('v 1.000000 2.000000 3.000000')
    expect(obj).toContain('f 1/1 2/2 3/3')
    expect(readFileSync(join(dir, 'obj', 'tri.mtl'), 'utf8')).toContain('Kd 1.000000 0.000000 0.000000')
  })

  it('writes a binary STL with one triangle', async () => {
    await zetta(['asset', 'export', glb, '--format', 'stl', '--out', join(dir, 'stl')])
    const stl = readFileSync(join(dir, 'stl', 'tri.stl'))
    expect(stl.readUInt32LE(80)).toBe(1)
    expect(stl.length).toBe(84 + 50)
  })

  it('writes a binary FBX', async () => {
    const run = await zetta(['asset', 'export', glb, '--format', 'fbx', '--fbx-preset', 'blender', '--out', join(dir, 'fbx')])
    expect(run.code).toBe(0)
    const fbx = readFileSync(join(dir, 'fbx', 'tri.fbx'))
    expect(fbx.subarray(0, 18).toString('latin1')).toBe('Kaydara FBX Binary')
    expect(existsSync(join(dir, 'fbx', 'tri.fbx'))).toBe(true)
  })

  it('refuses something that is not a GLB', async () => {
    const bad = join(dir, 'bad.glb')
    writeFileSync(bad, 'nope')
    expect((await zetta(['asset', 'export', bad, '--format', 'obj'])).code).toBe(2)
  })
})
