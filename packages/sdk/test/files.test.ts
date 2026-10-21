import { describe, expect, it } from 'vitest'
import { checkUpload, detectFile, fromBase64, toBase64 } from '../src/files'

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(bytes.buffer).setUint32(16, width)
  new DataView(bytes.buffer).setUint32(20, height)
  return bytes
}

function jpeg(width: number, height: number): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 3, 0, 0, 0, 0])
}

describe('detectFile', () => {
  it('reads PNG and JPEG sizes', () => {
    expect(detectFile(png(1024, 768))).toEqual({ contentType: 'image/png', kind: 'image', width: 1024, height: 768 })
    expect(detectFile(jpeg(640, 480))).toMatchObject({ contentType: 'image/jpeg', width: 640, height: 480 })
  })
  it('recognises GLB and falls back to the extension', () => {
    expect(detectFile(new TextEncoder().encode('glTF\u0002\u0000\u0000\u0000'))?.contentType).toBe('model/gltf-binary')
    expect(detectFile(new Uint8Array(4), 'clip.mov')?.contentType).toBe('video/quicktime')
    expect(detectFile(new Uint8Array(4), 'notes.txt')).toBeUndefined()
  })
})

describe('checkUpload', () => {
  it('rejects tiny pictures, wrong kinds and oversize files', () => {
    expect(() => checkUpload(detectFile(png(64, 64)), 100, 'picture')).toThrow(/128/)
    expect(() => checkUpload(detectFile(png(512, 512)), 100, 'model')).toThrow(/GLB/)
    expect(() => checkUpload(detectFile(png(512, 512)), 9 * 1024 * 1024, 'picture')).toThrow(/limit/)
    expect(checkUpload(detectFile(png(512, 512)), 100, 'picture').contentType).toBe('image/png')
  })
})

it('round-trips base64', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 255])
  expect(fromBase64(toBase64(bytes))).toEqual(bytes)
  expect(fromBase64('data:image/png;base64,' + toBase64(bytes))).toEqual(bytes)
})
