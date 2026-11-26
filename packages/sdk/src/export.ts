import { ZettaError } from './errors'
import { crc32, detectFile } from './files'
import type { TextureMapKind } from './resources/images'

/**
 * Free, local conversion of a GLB into OBJ (+ MTL and textures) or binary STL.
 *
 * Geometry is baked with each node's world transform. Supports float positions/normals/UVs,
 * indexed and non-indexed triangles, and embedded PNG/JPEG/WebP base-colour textures.
 * Compressed meshes (Draco, meshopt) are refused with a clear error — convert those on the server.
 */

interface TextureInfo {
  index: number
  texCoord?: number
  scale?: number
  strength?: number
  extensions?: Record<string, unknown>
}

interface GltfMaterial {
  name?: string
  pbrMetallicRoughness?: {
    baseColorFactor?: number[]
    baseColorTexture?: TextureInfo
    metallicFactor?: number
    roughnessFactor?: number
    metallicRoughnessTexture?: TextureInfo
  }
  normalTexture?: TextureInfo
  occlusionTexture?: TextureInfo
  emissiveTexture?: TextureInfo
  emissiveFactor?: number[]
}

interface GltfJson {
  asset?: { version?: string }
  scene?: number
  scenes?: Array<{ nodes?: number[] }>
  nodes?: Array<{ name?: string; mesh?: number; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }>
  meshes?: Array<{ name?: string; primitives: Array<{ attributes: Record<string, number>; indices?: number; material?: number; mode?: number }> }>
  accessors?: Array<{ bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string; normalized?: boolean }>
  bufferViews?: Array<{ buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }>
  buffers?: Array<{ byteLength: number; uri?: string }>
  materials?: GltfMaterial[]
  textures?: Array<{ source?: number; sampler?: number; extensions?: Record<string, { source?: number }> }>
  images?: Array<{ bufferView?: number; mimeType?: string; name?: string; uri?: string }>
  extensionsRequired?: string[]
  extensionsUsed?: string[]
}

export interface ParsedGlb {
  json: GltfJson
  bin: Uint8Array
}

export interface ExportedFile {
  name: string
  bytes: Uint8Array
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }
const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }

/** `geometry: false` reads a GLB for its materials and textures only, so compressed meshes are fine. */
export function parseGlb(data: Uint8Array, options: { geometry?: boolean } = {}): ParsedGlb {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  if (data.length < 20 || view.getUint32(0, true) !== 0x46546c67) {
    throw new ZettaError({ code: 'UNSUPPORTED_FILE_TYPE', message: 'Not a GLB file.' })
  }
  let offset = 12
  let json: GltfJson | undefined
  let bin: Uint8Array = new Uint8Array(0)
  while (offset + 8 <= data.length) {
    const length = view.getUint32(offset, true)
    const type = view.getUint32(offset + 4, true)
    const chunk = data.subarray(offset + 8, offset + 8 + length)
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(chunk)) as GltfJson
    else if (type === 0x004e4942) bin = chunk
    offset += 8 + length
  }
  if (!json) throw new ZettaError({ code: 'UNSUPPORTED_FILE_TYPE', message: 'The GLB has no JSON chunk.' })
  const compressed = (json.extensionsRequired ?? []).filter((ext) => /draco|meshopt|quantization/i.test(ext))
  if (compressed.length && options.geometry !== false) {
    throw new ZettaError({
      code: 'UNSUPPORTED_FILE_TYPE',
      message: `This model uses compressed geometry (${compressed.join(', ')}), which local export cannot read. Convert it on the server with \`zetta refine convert\`.`,
    })
  }
  return { json, bin }
}

function readAccessor(glb: ParsedGlb, index: number): { values: Float64Array; size: number; count: number } {
  const accessor = glb.json.accessors?.[index]
  if (!accessor) throw new ZettaError({ code: 'INVALID_INPUT', message: `Accessor ${index} is missing.` })
  const size = COMPONENTS[accessor.type] ?? 1
  const values = new Float64Array(accessor.count * size)
  if (accessor.bufferView === undefined) return { values, size, count: accessor.count }
  const view = glb.json.bufferViews![accessor.bufferView]!
  const componentBytes = COMPONENT_BYTES[accessor.componentType] ?? 4
  const stride = view.byteStride ?? componentBytes * size
  const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0)
  const data = new DataView(glb.bin.buffer, glb.bin.byteOffset, glb.bin.byteLength)
  for (let i = 0; i < accessor.count; i++) {
    for (let c = 0; c < size; c++) {
      const at = base + i * stride + c * componentBytes
      let value: number
      switch (accessor.componentType) {
        case 5126: value = data.getFloat32(at, true); break
        case 5125: value = data.getUint32(at, true); break
        case 5123: value = data.getUint16(at, true); if (accessor.normalized) value /= 65535; break
        case 5122: value = data.getInt16(at, true); if (accessor.normalized) value = Math.max(value / 32767, -1); break
        case 5121: value = data.getUint8(at); if (accessor.normalized) value /= 255; break
        case 5120: value = data.getInt8(at); if (accessor.normalized) value = Math.max(value / 127, -1); break
        default: value = 0
      }
      values[i * size + c] = value
    }
  }
  return { values, size, count: accessor.count }
}

type Mat4 = number[]
const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out: number[] = Array.from({ length: 16 }, () => 0)
  for (let col = 0; col < 4; col++) for (let row = 0; row < 4; row++) for (let k = 0; k < 4; k++) out[col * 4 + row]! += a[k * 4 + row]! * b[col * 4 + k]!
  return out
}

function localMatrix(node: NonNullable<GltfJson['nodes']>[number]): Mat4 {
  if (node.matrix?.length === 16) return node.matrix
  const [tx, ty, tz] = node.translation ?? [0, 0, 0]
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1]
  const [sx, sy, sz] = node.scale ?? [1, 1, 1]
  const r = [
    1 - 2 * (y! * y! + z! * z!), 2 * (x! * y! + z! * w!), 2 * (x! * z! - y! * w!),
    2 * (x! * y! - z! * w!), 1 - 2 * (x! * x! + z! * z!), 2 * (y! * z! + x! * w!),
    2 * (x! * z! + y! * w!), 2 * (y! * z! - x! * w!), 1 - 2 * (x! * x! + y! * y!),
  ]
  return [r[0]! * sx!, r[1]! * sx!, r[2]! * sx!, 0, r[3]! * sy!, r[4]! * sy!, r[5]! * sy!, 0, r[6]! * sz!, r[7]! * sz!, r[8]! * sz!, 0, tx!, ty!, tz!, 1]
}

function transformPoint(m: Mat4, x: number, y: number, z: number): [number, number, number] {
  return [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!]
}

function transformNormal(m: Mat4, x: number, y: number, z: number): [number, number, number] {
  const n = [m[0]! * x + m[4]! * y + m[8]! * z, m[1]! * x + m[5]! * y + m[9]! * z, m[2]! * x + m[6]! * y + m[10]! * z]
  const len = Math.hypot(n[0]!, n[1]!, n[2]!) || 1
  return [n[0]! / len, n[1]! / len, n[2]! / len]
}

export interface MeshPart {
  name: string
  material: number | undefined
  positions: number[]
  normals: number[] | undefined
  uvs: number[] | undefined
  /** Triangle vertex indices into this part's arrays. */
  triangles: number[]
}

/** Every triangle primitive in the default scene, with world transforms applied. */
export function collectParts(glb: ParsedGlb): MeshPart[] {
  const { json } = glb
  const parts: MeshPart[] = []
  const visit = (nodeIndex: number, parent: Mat4) => {
    const node = json.nodes?.[nodeIndex]
    if (!node) return
    const world = multiply(parent, localMatrix(node))
    if (node.mesh !== undefined) {
      const mesh = json.meshes?.[node.mesh]
      mesh?.primitives.forEach((primitive, p) => {
        if (primitive.mode !== undefined && primitive.mode !== 4) return
        if (primitive.attributes.POSITION === undefined) return
        const pos = readAccessor(glb, primitive.attributes.POSITION)
        const nor = primitive.attributes.NORMAL !== undefined ? readAccessor(glb, primitive.attributes.NORMAL) : undefined
        const uv = primitive.attributes.TEXCOORD_0 !== undefined ? readAccessor(glb, primitive.attributes.TEXCOORD_0) : undefined
        const positions: number[] = []
        const normals: number[] | undefined = nor ? [] : undefined
        for (let i = 0; i < pos.count; i++) {
          positions.push(...transformPoint(world, pos.values[i * 3]!, pos.values[i * 3 + 1]!, pos.values[i * 3 + 2]!))
          if (nor && normals) normals.push(...transformNormal(world, nor.values[i * 3]!, nor.values[i * 3 + 1]!, nor.values[i * 3 + 2]!))
        }
        const triangles = primitive.indices !== undefined ? Array.from(readAccessor(glb, primitive.indices).values) : Array.from({ length: pos.count }, (_, i) => i)
        parts.push({
          name: `${node.name ?? mesh.name ?? `mesh${node.mesh}`}${mesh.primitives.length > 1 ? `_${p}` : ''}`,
          material: primitive.material,
          positions,
          normals,
          uvs: uv ? Array.from(uv.values) : undefined,
          triangles,
        })
      })
    }
    for (const child of node.children ?? []) visit(child, world)
  }
  const roots = json.scenes?.[json.scene ?? 0]?.nodes ?? (json.nodes ?? []).map((_, i) => i)
  for (const root of roots) visit(root, IDENTITY)
  return parts
}

const clean = (name: string) => name.replace(/[^\w.-]+/g, '_') || 'part'

/** GLB → `<base>.obj`, `<base>.mtl` and any embedded textures. */
export function glbToObj(data: Uint8Array, base = 'model'): ExportedFile[] {
  const glb = parseGlb(data)
  const parts = collectParts(glb)
  if (!parts.length) throw new ZettaError({ code: 'INVALID_INPUT', message: 'The model has no triangles to export.' })
  const files: ExportedFile[] = []
  const textureNames = new Map<number, string>()
  const imageFile = (textureIndex: number): string | undefined => {
    if (textureNames.has(textureIndex)) return textureNames.get(textureIndex)
    const image = glb.json.images?.[glb.json.textures?.[textureIndex]?.source ?? -1]
    if (!image || image.bufferView === undefined) return undefined
    const view = glb.json.bufferViews![image.bufferView]!
    const ext = image.mimeType === 'image/jpeg' ? 'jpg' : image.mimeType === 'image/webp' ? 'webp' : 'png'
    const name = `${base}_texture${textureNames.size}.${ext}`
    files.push({ name, bytes: glb.bin.slice(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength) })
    textureNames.set(textureIndex, name)
    return name
  }

  const mtl: string[] = []
  const materialNames = new Map<number, string>()
  for (const [index, material] of (glb.json.materials ?? []).entries()) {
    const name = `material${index}`
    materialNames.set(index, name)
    const [r, g, b, a] = material.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1, 1]
    mtl.push(`newmtl ${name}`, `Kd ${r!.toFixed(6)} ${g!.toFixed(6)} ${b!.toFixed(6)}`, `d ${a!.toFixed(6)}`, 'illum 2')
    const texture = material.pbrMetallicRoughness?.baseColorTexture?.index
    const file = texture !== undefined ? imageFile(texture) : undefined
    if (file) mtl.push(`map_Kd ${file}`)
    mtl.push('')
  }

  const obj: string[] = [`mtllib ${base}.mtl`]
  let vOffset = 1
  let tOffset = 1
  let nOffset = 1
  for (const part of parts) {
    obj.push(`o ${clean(part.name)}`)
    for (let i = 0; i < part.positions.length; i += 3) obj.push(`v ${part.positions[i]!.toFixed(6)} ${part.positions[i + 1]!.toFixed(6)} ${part.positions[i + 2]!.toFixed(6)}`)
    if (part.uvs) for (let i = 0; i < part.uvs.length; i += 2) obj.push(`vt ${part.uvs[i]!.toFixed(6)} ${(1 - part.uvs[i + 1]!).toFixed(6)}`)
    if (part.normals) for (let i = 0; i < part.normals.length; i += 3) obj.push(`vn ${part.normals[i]!.toFixed(6)} ${part.normals[i + 1]!.toFixed(6)} ${part.normals[i + 2]!.toFixed(6)}`)
    if (part.material !== undefined && materialNames.has(part.material)) obj.push(`usemtl ${materialNames.get(part.material)}`)
    const ref = (i: number) => {
      const v = i + vOffset
      if (part.uvs && part.normals) return `${v}/${i + tOffset}/${i + nOffset}`
      if (part.uvs) return `${v}/${i + tOffset}`
      if (part.normals) return `${v}//${i + nOffset}`
      return `${v}`
    }
    for (let t = 0; t + 2 < part.triangles.length; t += 3) obj.push(`f ${ref(part.triangles[t]!)} ${ref(part.triangles[t + 1]!)} ${ref(part.triangles[t + 2]!)}`)
    const vertexCount = part.positions.length / 3
    vOffset += vertexCount
    if (part.uvs) tOffset += vertexCount
    if (part.normals) nOffset += vertexCount
  }

  const encoder = new TextEncoder()
  return [{ name: `${base}.obj`, bytes: encoder.encode(`${obj.join('\n')}\n`) }, { name: `${base}.mtl`, bytes: encoder.encode(mtl.join('\n')) }, ...files]
}

/** GLB → binary STL (geometry only, metres as stored). */
export function glbToStl(data: Uint8Array, base = 'model'): ExportedFile[] {
  const parts = collectParts(parseGlb(data))
  const triangles = parts.reduce((sum, part) => sum + Math.floor(part.triangles.length / 3), 0)
  if (!triangles) throw new ZettaError({ code: 'INVALID_INPUT', message: 'The model has no triangles to export.' })
  const out = new Uint8Array(84 + triangles * 50)
  const view = new DataView(out.buffer)
  out.set(new TextEncoder().encode('Exported by Zetta 3D'.padEnd(80, ' ')).subarray(0, 80))
  view.setUint32(80, triangles, true)
  let at = 84
  for (const part of parts) {
    const p = part.positions
    for (let t = 0; t + 2 < part.triangles.length; t += 3) {
      const [a, b, c] = [part.triangles[t]! * 3, part.triangles[t + 1]! * 3, part.triangles[t + 2]! * 3]
      const u = [p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!]
      const v = [p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!]
      const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!]
      const len = Math.hypot(n[0]!, n[1]!, n[2]!) || 1
      for (const value of [n[0]! / len, n[1]! / len, n[2]! / len, p[a]!, p[a + 1]!, p[a + 2]!, p[b]!, p[b + 1]!, p[b + 2]!, p[c]!, p[c + 1]!, p[c + 2]!]) {
        view.setFloat32(at, value, true)
        at += 4
      }
      at += 2
    }
  }
  return [{ name: `${base}.stl`, bytes: out }]
}

export interface MaterialInfo {
  index: number
  name: string
  /** Base colour factor, RGBA in 0–1. */
  color: [number, number, number, number]
  /** The embedded base-colour picture, as stored (PNG, JPEG or WebP bytes). */
  texture?: {
    bytes: Uint8Array
    mimeType: string
    extension: string
    /** The glTF image it comes from; materials sharing a picture share this. */
    image: number
    width?: number
    height?: number
  }
}

/** The glTF image a texture shows (its own source, or a WebP/Basis extension's). */
function textureSource(json: GltfJson, textureIndex: number | undefined): number | undefined {
  if (textureIndex === undefined) return undefined
  const texture = json.textures?.[textureIndex]
  if (!texture) return undefined
  if (texture.source !== undefined) return texture.source
  return Object.values(texture.extensions ?? {}).find((ext) => typeof ext?.source === 'number')?.source
}

/** The bytes of an embedded image, with its type (from the GLB, or sniffed from the bytes). */
function imageBytes(glb: ParsedGlb, imageIndex: number): { bytes: Uint8Array; mimeType: string } | undefined {
  const image = glb.json.images?.[imageIndex]
  if (!image) return undefined
  let bytes: Uint8Array | undefined
  if (image.bufferView !== undefined) {
    const view = glb.json.bufferViews?.[image.bufferView]
    if (!view) return undefined
    bytes = glb.bin.slice(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength)
  } else if (image.uri?.startsWith('data:')) {
    const comma = image.uri.indexOf(',')
    bytes = Uint8Array.from(atob(image.uri.slice(comma + 1)), (c) => c.charCodeAt(0))
  }
  if (!bytes) return undefined
  return { bytes, mimeType: image.mimeType ?? detectFile(bytes)?.contentType ?? 'image/png' }
}

/** Each material's base colour and embedded base-colour texture. */
export function collectMaterials(glb: ParsedGlb): MaterialInfo[] {
  return (glb.json.materials ?? []).map((material, index) => {
    const [r, g, b, a] = material.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1, 1]
    const info: MaterialInfo = { index, name: material.name ?? `material${index}`, color: [r ?? 1, g ?? 1, b ?? 1, a ?? 1] }
    const imageIndex = textureSource(glb.json, material.pbrMetallicRoughness?.baseColorTexture?.index)
    const image = imageIndex !== undefined ? imageBytes(glb, imageIndex) : undefined
    if (image && imageIndex !== undefined) {
      const size = detectFile(image.bytes.subarray(0, 256 * 1024))
      info.texture = {
        bytes: image.bytes,
        mimeType: image.mimeType,
        extension: image.mimeType === 'image/jpeg' ? 'jpg' : image.mimeType === 'image/webp' ? 'webp' : image.mimeType === 'image/png' ? 'png' : (image.mimeType.split('/').pop() ?? 'bin'),
        image: imageIndex,
        ...(size?.width ? { width: size.width } : {}),
        ...(size?.height ? { height: size.height } : {}),
      }
    }
    return info
  })
}

// ── Writing GLBs ───────────────────────────────────────────────────────────

/** A GLB from its JSON and binary chunk (each padded to 4 bytes, as the format requires). */
export function writeGlb(json: unknown, bin: Uint8Array): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(json))
  const jsonLength = Math.ceil(text.length / 4) * 4
  const binLength = Math.ceil(bin.length / 4) * 4
  const total = 12 + 8 + jsonLength + (bin.length ? 8 + binLength : 0)
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint32(0, 0x46546c67, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, total, true)
  view.setUint32(12, jsonLength, true)
  view.setUint32(16, 0x4e4f534a, true)
  out.fill(0x20, 20, 20 + jsonLength)
  out.set(text, 20)
  if (bin.length) {
    const at = 20 + jsonLength
    view.setUint32(at, binLength, true)
    view.setUint32(at + 4, 0x004e4942, true)
    out.set(bin, at + 8)
  }
  return out
}

// ── PNG ────────────────────────────────────────────────────────────────────

/** Pixels, 8 bits per channel, RGBA, row by row from the top. */
export interface RasterImage {
  width: number
  height: number
  data: Uint8Array
}

async function zlibStream(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const piped = new Blob([data as BlobPart]).stream().pipeThrough(stream)
  return new Uint8Array(await new Response(piped).arrayBuffer())
}

function pictureError(message: string): ZettaError {
  return new ZettaError({ code: 'UNSUPPORTED_FILE_TYPE', message })
}

/** Decodes a PNG (any colour type and bit depth, not interlaced) into RGBA. */
export async function decodePng(bytes: Uint8Array): Promise<RasterImage> {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (!signature.every((value, i) => bytes[i] === value)) throw pictureError('Not a PNG picture.')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let width = 0
  let height = 0
  let depth = 0
  let type = 0
  let interlace = 0
  let palette: Uint8Array | undefined
  let transparency: Uint8Array | undefined
  const idat: Uint8Array[] = []
  for (let offset = 8; offset + 8 <= bytes.length; ) {
    const length = view.getUint32(offset)
    const name = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    const body = bytes.subarray(offset + 8, offset + 8 + length)
    if (name === 'IHDR') {
      width = view.getUint32(offset + 8)
      height = view.getUint32(offset + 12)
      depth = bytes[offset + 16] ?? 0
      type = bytes[offset + 17] ?? 0
      interlace = bytes[offset + 20] ?? 0
    } else if (name === 'PLTE') palette = body
    else if (name === 'tRNS') transparency = body
    else if (name === 'IDAT') idat.push(body)
    else if (name === 'IEND') break
    offset += 12 + length
  }
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[type]
  if (!width || !height || !channels || ![1, 2, 4, 8, 16].includes(depth)) throw pictureError('That PNG could not be read.')
  if (interlace) throw pictureError('Interlaced PNGs are not supported here; save the picture without interlacing.')
  const joined = new Uint8Array(idat.reduce((sum, part) => sum + part.length, 0))
  idat.reduce((at, part) => (joined.set(part, at), at + part.length), 0)
  const raw = await zlibStream(joined, new DecompressionStream('deflate'))
  const bitsPerPixel = channels * depth
  const bpp = Math.max(1, bitsPerPixel >> 3)
  const stride = Math.ceil((width * bitsPerPixel) / 8)
  if (raw.length < (stride + 1) * height) throw pictureError('That PNG is cut short.')
  const pixels = new Uint8Array(stride * height)
  let previous = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const out = pixels.subarray(y * stride, (y + 1) * stride)
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[i - bpp]! : 0
      const b = previous[i]!
      const c = i >= bpp ? previous[i - bpp]! : 0
      let x = line[i]!
      if (filter === 1) x += a
      else if (filter === 2) x += b
      else if (filter === 3) x += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        x += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      } else if (filter !== 0) throw pictureError('That PNG could not be read.')
      out[i] = x & 0xff
    }
    previous = out
  }
  const sample = (row: Uint8Array, index: number): number => {
    if (depth === 8) return row[index]!
    if (depth === 16) return row[index * 2]!
    const bit = index * depth
    return ((row[bit >> 3]! >> (8 - depth - (bit & 7))) & ((1 << depth) - 1)) * (type === 3 ? 1 : 255 / ((1 << depth) - 1))
  }
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    const row = pixels.subarray(y * stride, (y + 1) * stride)
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      const s = x * channels
      if (type === 3) {
        const index = sample(row, x)
        data[o] = palette?.[index * 3] ?? 0
        data[o + 1] = palette?.[index * 3 + 1] ?? 0
        data[o + 2] = palette?.[index * 3 + 2] ?? 0
        data[o + 3] = transparency?.[index] ?? 255
      } else if (type === 0 || type === 4) {
        const grey = sample(row, s)
        data[o] = data[o + 1] = data[o + 2] = grey
        data[o + 3] = type === 4 ? sample(row, s + 1) : 255
      } else {
        data[o] = sample(row, s)
        data[o + 1] = sample(row, s + 1)
        data[o + 2] = sample(row, s + 2)
        data[o + 3] = type === 6 ? sample(row, s + 3) : 255
      }
    }
  }
  return { width, height, data }
}

/** Encodes RGBA pixels as a PNG; `alpha: false` drops the alpha channel (RGB). */
export async function encodePng(image: RasterImage, options: { alpha?: boolean } = {}): Promise<Uint8Array> {
  const channels = options.alpha === false ? 3 : 4
  const { width, height, data } = image
  const stride = width * channels
  const raw = new Uint8Array((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1)
    raw[at] = 1 // "Sub": each byte minus the one to its left, which keeps flat maps small.
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < channels; c++) {
        const value = data[(y * width + x) * 4 + c]!
        const left = x > 0 ? data[(y * width + x - 1) * 4 + c]! : 0
        raw[at + 1 + x * channels + c] = (value - left) & 0xff
      }
    }
  }
  const idat = await zlibStream(raw, new CompressionStream('deflate'))
  const header = new Uint8Array(13)
  const headerView = new DataView(header.buffer)
  headerView.setUint32(0, width)
  headerView.setUint32(4, height)
  header.set([8, channels === 4 ? 6 : 2, 0, 0, 0], 8)
  const chunk = (name: string, body: Uint8Array) => {
    const out = new Uint8Array(12 + body.length)
    const view = new DataView(out.buffer)
    view.setUint32(0, body.length)
    out.set(new TextEncoder().encode(name), 4)
    out.set(body, 8)
    view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)))
    return out
  }
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))]
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  parts.reduce((at, part) => (out.set(part, at), at + part.length), 0)
  return out
}

/** Resizes RGBA pixels: an area average when shrinking, bilinear when growing. */
export function resizeImage(image: RasterImage, width: number, height: number): RasterImage {
  if (image.width === width && image.height === height) return image
  const { data: src, width: sw, height: sh } = image
  const out = new Uint8Array(width * height * 4)
  const sx = sw / width
  const sy = sh / height
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      if (sx >= 1 && sy >= 1) {
        const x0 = Math.floor(x * sx)
        const x1 = Math.max(x0 + 1, Math.min(sw, Math.floor((x + 1) * sx)))
        const y0 = Math.floor(y * sy)
        const y1 = Math.max(y0 + 1, Math.min(sh, Math.floor((y + 1) * sy)))
        const sums = [0, 0, 0, 0]
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) for (let c = 0; c < 4; c++) sums[c]! += src[(yy * sw + xx) * 4 + c]!
        const count = (x1 - x0) * (y1 - y0)
        for (let c = 0; c < 4; c++) out[o + c] = Math.round(sums[c]! / count)
      } else {
        const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) * sx - 0.5))
        const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) * sy - 0.5))
        const x0 = Math.floor(fx)
        const y0 = Math.floor(fy)
        const x1 = Math.min(sw - 1, x0 + 1)
        const y1 = Math.min(sh - 1, y0 + 1)
        const tx = fx - x0
        const ty = fy - y0
        for (let c = 0; c < 4; c++) {
          const top = src[(y0 * sw + x0) * 4 + c]! * (1 - tx) + src[(y0 * sw + x1) * 4 + c]! * tx
          const bottom = src[(y1 * sw + x0) * 4 + c]! * (1 - tx) + src[(y1 * sw + x1) * 4 + c]! * tx
          out[o + c] = Math.round(top * (1 - ty) + bottom * ty)
        }
      }
    }
  }
  return { width, height, data: out }
}

// ── Texture maps ───────────────────────────────────────────────────────────

/** One generated map to put on one material. */
export interface TextureMapEdit {
  /** Index into the GLB's materials. */
  material: number
  map: TextureMapKind
  /** The map picture (PNG or JPEG; roughness and metalness must be PNG, since they are packed). */
  image: { bytes: Uint8Array; mimeType: string }
}

export interface AppliedTextureMaps {
  glb: Uint8Array
  /** What was adjusted besides the maps themselves, for people to read. */
  notes: string[]
}

/**
 * Puts generated PBR maps on a GLB's materials, as the Studio's inspector does before Save.
 *
 * Normal, emissive and ambient occlusion each get their own texture. Roughness and metalness share
 * glTF's one metal/rough texture (green = roughness, blue = metalness), so they are packed into a
 * new PNG, keeping the other channel from the existing texture when only one is new (that texture
 * must then be a PNG). A slot that had a texture keeps its UV set and transform; an empty one takes
 * the base colour's, since the map was drawn from it. The images are embedded; nothing else in the
 * file changes, apart from a zero emissive, metallic or roughness factor (which would hide its new
 * map) becoming 1.
 */
export async function applyTextureMaps(data: Uint8Array, edits: readonly TextureMapEdit[]): Promise<AppliedTextureMaps> {
  const glb = parseGlb(data, { geometry: false })
  const json = structuredClone(glb.json)
  if (json.buffers?.[0]?.uri !== undefined) throw new ZettaError({ code: 'UNSUPPORTED_FILE_TYPE', message: 'This GLB keeps its data in an external file; maps cannot be embedded.' })
  const notes: string[] = []
  const pieces: Uint8Array[] = [glb.bin]
  let length = glb.bin.length
  const images = new Map<Uint8Array, number>()

  const appendImage = (bytes: Uint8Array, mimeType: string): number => {
    const known = images.get(bytes)
    if (known !== undefined) return known
    if (mimeType !== 'image/png' && mimeType !== 'image/jpeg') {
      throw new ZettaError({ code: 'UNSUPPORTED_FILE_TYPE', message: `A ${mimeType} map cannot be embedded in a GLB; use PNG or JPEG.` })
    }
    const padding = (4 - (length % 4)) % 4
    if (padding) pieces.push(new Uint8Array(padding))
    length += padding
    json.bufferViews = json.bufferViews ?? []
    json.bufferViews.push({ buffer: 0, byteOffset: length, byteLength: bytes.length })
    pieces.push(bytes)
    length += bytes.length
    json.images = json.images ?? []
    json.images.push({ bufferView: json.bufferViews.length - 1, mimeType })
    images.set(bytes, json.images.length - 1)
    return json.images.length - 1
  }
  const newTexture = (image: number, like: TextureInfo | undefined): number => {
    const sampler = like ? json.textures?.[like.index]?.sampler : undefined
    json.textures = json.textures ?? []
    json.textures.push({ source: image, ...(sampler !== undefined ? { sampler } : {}) })
    return json.textures.length - 1
  }
  /** The slot's own placement when it had a texture, else the base colour's. */
  const placed = (existing: TextureInfo | undefined, base: TextureInfo | undefined, index: number): TextureInfo => {
    const like = existing ?? base
    return {
      ...existing,
      index,
      ...(like?.texCoord !== undefined ? { texCoord: like.texCoord } : {}),
      ...(like?.extensions ? { extensions: like.extensions } : {}),
    }
  }

  const byMaterial = new Map<number, Map<TextureMapKind, TextureMapEdit['image']>>()
  for (const edit of edits) {
    if (!json.materials?.[edit.material]) throw new ZettaError({ code: 'INVALID_INPUT', message: `The model has no material ${edit.material}.` })
    const maps = byMaterial.get(edit.material) ?? new Map()
    maps.set(edit.map, edit.image)
    byMaterial.set(edit.material, maps)
  }

  for (const [index, maps] of byMaterial) {
    const material = json.materials![index]!
    const label = material.name ?? `material${index}`
    const base = material.pbrMetallicRoughness?.baseColorTexture
    const like = (existing: TextureInfo | undefined) => existing ?? base
    const normal = maps.get('normal')
    if (normal) material.normalTexture = placed(material.normalTexture, base, newTexture(appendImage(normal.bytes, normal.mimeType), like(material.normalTexture)))
    const ao = maps.get('ao')
    if (ao) material.occlusionTexture = placed(material.occlusionTexture, base, newTexture(appendImage(ao.bytes, ao.mimeType), like(material.occlusionTexture)))
    const emissive = maps.get('emissive')
    if (emissive) {
      material.emissiveTexture = placed(material.emissiveTexture, base, newTexture(appendImage(emissive.bytes, emissive.mimeType), like(material.emissiveTexture)))
      if (!material.emissiveFactor || material.emissiveFactor.every((value) => value === 0)) {
        material.emissiveFactor = [1, 1, 1]
        notes.push(`${label}: emissive colour set to white, so the emissive map shows.`)
      }
    }
    const roughness = maps.get('roughness')
    const metalness = maps.get('metalness')
    if (roughness || metalness) {
      const pbr = (material.pbrMetallicRoughness = material.pbrMetallicRoughness ?? {})
      const existing = pbr.metallicRoughnessTexture
      const decode = async (image: { bytes: Uint8Array; mimeType: string }, what: string) => {
        if (image.mimeType !== 'image/png' && detectFile(image.bytes)?.contentType !== 'image/png') {
          throw new ZettaError({
            code: 'UNSUPPORTED_FILE_TYPE',
            message: `${what} is ${image.mimeType.replace('image/', '').toUpperCase()}, and roughness and metalness can only be packed from PNGs here. Generate both maps together (--map roughness --map metalness), or apply them in the Studio.`,
          })
        }
        return decodePng(image.bytes)
      }
      let old: RasterImage | undefined
      if (existing && !(roughness && metalness)) {
        const source = textureSource(json, existing.index)
        const stored = source !== undefined ? imageBytes(glb, source) : undefined
        if (stored) old = await decode(stored, `${label}'s current metal/rough texture`)
      }
      const rough = roughness ? await decode(roughness, 'The roughness map') : undefined
      const metal = metalness ? await decode(metalness, 'The metalness map') : undefined
      const width = Math.max(old?.width ?? 0, rough?.width ?? 0, metal?.width ?? 0)
      const height = Math.max(old?.height ?? 0, rough?.height ?? 0, metal?.height ?? 0)
      const [o, r, m] = [old, rough, metal].map((img) => (img ? resizeImage(img, width, height).data : undefined))
      const out = new Uint8Array(width * height * 4)
      for (let i = 0; i < out.length; i += 4) {
        out[i] = o ? o[i]! : 0
        out[i + 1] = r ? r[i + 1]! : o ? o[i + 1]! : 255
        out[i + 2] = m ? m[i + 2]! : o ? o[i + 2]! : 255
        out[i + 3] = 255
      }
      const png = await encodePng({ width, height, data: out }, { alpha: false })
      pbr.metallicRoughnessTexture = placed(existing, base, newTexture(appendImage(png, 'image/png'), like(existing)))
      if (metalness && pbr.metallicFactor === 0) {
        pbr.metallicFactor = 1
        notes.push(`${label}: metallic factor set to 1, so the metalness map shows.`)
      }
      if (roughness && pbr.roughnessFactor === 0) {
        pbr.roughnessFactor = 1
        notes.push(`${label}: roughness factor set to 1, so the roughness map shows.`)
      }
    }
  }

  const bin = new Uint8Array(length)
  pieces.reduce((at, piece) => (bin.set(piece, at), at + piece.length), 0)
  json.buffers = json.buffers?.length ? json.buffers : [{ byteLength: 0 }]
  json.buffers[0]!.byteLength = length
  return { glb: writeGlb(json, bin), notes }
}
