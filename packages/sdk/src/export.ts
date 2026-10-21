import { ZettaError } from './errors'

/**
 * Free, local conversion of a GLB into OBJ (+ MTL and textures) or binary STL.
 *
 * Geometry is baked with each node's world transform. Supports float positions/normals/UVs,
 * indexed and non-indexed triangles, and embedded PNG/JPEG/WebP base-colour textures.
 * Compressed meshes (Draco, meshopt) are refused with a clear error — convert those on the server.
 */

interface GltfJson {
  asset?: { version?: string }
  scene?: number
  scenes?: Array<{ nodes?: number[] }>
  nodes?: Array<{ name?: string; mesh?: number; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }>
  meshes?: Array<{ name?: string; primitives: Array<{ attributes: Record<string, number>; indices?: number; material?: number; mode?: number }> }>
  accessors?: Array<{ bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string; normalized?: boolean }>
  bufferViews?: Array<{ buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }>
  materials?: Array<{ name?: string; pbrMetallicRoughness?: { baseColorFactor?: number[]; baseColorTexture?: { index: number } } }>
  textures?: Array<{ source?: number }>
  images?: Array<{ bufferView?: number; mimeType?: string; name?: string; uri?: string }>
  extensionsRequired?: string[]
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

export function parseGlb(data: Uint8Array): ParsedGlb {
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
  if (compressed.length) {
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
