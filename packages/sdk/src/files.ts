import { LocalErrorCodes, ZettaError } from './errors'
import { UPLOAD_LIMITS } from './uploads'

export type FileKind = 'image' | 'video' | 'model'

export interface FileInfo {
  contentType: string
  kind: FileKind
  width?: number
  height?: number
}

const EXTENSION_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  glb: 'model/gltf-binary',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
}

/** Limits the engines apply to input pictures. */
export const IMAGE_RULES = { minSide: 128, maxSide: 5000, maxBytes: 8 * 1024 * 1024 } as const

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  return signature.every((value, i) => bytes[offset + i] === value)
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length))
}

/** Identifies a file from its first bytes (at least 64 KB recommended for JPEG dimensions), falling back to its name. */
export function detectFile(head: Uint8Array, name = ''): FileInfo | undefined {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength)
    return head.length >= 24
      ? { contentType: 'image/png', kind: 'image', width: view.getUint32(16), height: view.getUint32(20) }
      : { contentType: 'image/png', kind: 'image' }
  }
  if (startsWith(head, [0xff, 0xd8, 0xff])) return { contentType: 'image/jpeg', kind: 'image', ...jpegSize(head) }
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WEBP') return { contentType: 'image/webp', kind: 'image', ...webpSize(head) }
  if (ascii(head, 0, 4) === 'glTF') return { contentType: 'model/gltf-binary', kind: 'model' }
  if (ascii(head, 4, 4) === 'ftyp') {
    const brand = ascii(head, 8, 4)
    return { contentType: brand.startsWith('qt') ? 'video/quicktime' : 'video/mp4', kind: 'video' }
  }
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) return { contentType: 'video/webm', kind: 'video' }
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'AVI ') return { contentType: 'video/x-msvideo', kind: 'video' }

  const extension = name.toLowerCase().split('.').pop() ?? ''
  const type = EXTENSION_TYPES[extension]
  if (!type) return undefined
  return { contentType: type, kind: type.startsWith('image/') ? 'image' : type.startsWith('video/') ? 'video' : 'model' }
}

function jpegSize(bytes: Uint8Array): { width?: number; height?: number } {
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++
      continue
    }
    const marker = bytes[offset + 1] ?? 0
    // Start-of-frame markers carry the dimensions (excluding DHT, JPG and DAC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0)
      const width = ((bytes[offset + 7] ?? 0) << 8) | (bytes[offset + 8] ?? 0)
      return { width, height }
    }
    const length = ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0)
    if (length < 2) break
    offset += 2 + length
  }
  return {}
}

function webpSize(bytes: Uint8Array): { width?: number; height?: number } {
  const chunk = ascii(bytes, 12, 4)
  const at = (i: number) => bytes[i] ?? 0
  if (chunk === 'VP8 ' && bytes.length >= 30) {
    return { width: (at(26) | (at(27) << 8)) & 0x3fff, height: (at(28) | (at(29) << 8)) & 0x3fff }
  }
  if (chunk === 'VP8L' && bytes.length >= 25) {
    const b = [at(21), at(22), at(23), at(24)]
    return { width: 1 + (((b[1]! & 0x3f) << 8) | b[0]!), height: 1 + (((b[3]! & 0x0f) << 10) | (b[2]! << 2) | ((b[1]! & 0xc0) >> 6)) }
  }
  if (chunk === 'VP8X' && bytes.length >= 30) {
    return { width: 1 + (at(24) | (at(25) << 8) | (at(26) << 16)), height: 1 + (at(27) | (at(28) << 8) | (at(29) << 16)) }
  }
  return {}
}

/**
 * Checks a file before uploading it, so a bad input fails here instead of after credits move.
 *
 * `purpose` narrows what is accepted: `picture` (engine input), `video`, or `model` (GLB).
 */
export function checkUpload(info: FileInfo | undefined, size: number, purpose: 'picture' | 'video' | 'model', name = 'the file'): FileInfo {
  const expected: FileKind = purpose === 'picture' ? 'image' : purpose
  if (!info || info.kind !== expected) {
    const wanted = purpose === 'picture' ? 'a PNG, JPEG or WebP picture' : purpose === 'video' ? 'an MP4, WebM, MOV or AVI video' : 'a GLB model'
    throw new ZettaError({ code: LocalErrorCodes.UNSUPPORTED_FILE_TYPE, message: `${name} is not ${wanted}.`, details: { detected: info?.contentType ?? null } })
  }
  const limit = purpose === 'picture' ? IMAGE_RULES.maxBytes : UPLOAD_LIMITS[expected]
  if (size > limit) {
    throw new ZettaError({
      code: LocalErrorCodes.FILE_TOO_LARGE,
      message: `${name} is ${formatBytes(size)}; the limit is ${formatBytes(limit)}.`,
      details: { bytes: size, limit },
    })
  }
  if (purpose === 'picture' && info.width && info.height) {
    const small = Math.min(info.width, info.height)
    const large = Math.max(info.width, info.height)
    if (small < IMAGE_RULES.minSide || large > IMAGE_RULES.maxSide) {
      throw new ZettaError({
        code: LocalErrorCodes.INVALID_IMAGE,
        message: `${name} is ${info.width}×${info.height}; each side must be ${IMAGE_RULES.minSide}–${IMAGE_RULES.maxSide} px.`,
        details: { width: info.width, height: info.height },
      })
    }
  }
  return info
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** Base64 without a `data:` prefix, which is what the image and tool routes expect. */
export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return btoa(binary)
}

export function fromBase64(base64: string): Uint8Array {
  const clean = base64.replace(/^data:[^,]*,/, '')
  return Uint8Array.from(atob(clean), (c) => c.charCodeAt(0))
}

export function extensionFor(contentType: string): string {
  const map: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'model/gltf-binary': 'glb' }
  return map[contentType] ?? contentType.split('/').pop() ?? 'bin'
}
