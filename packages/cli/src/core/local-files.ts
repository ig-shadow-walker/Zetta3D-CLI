import { createWriteStream, existsSync, mkdirSync, openSync, readSync, closeSync, readdirSync, renameSync, statSync, readFileSync, unlinkSync } from 'node:fs'
import { openAsBlob } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { deflateRawSync } from 'node:zlib'
import {
  checkUpload,
  crc32,
  detectFile,
  extensionOf,
  formatBytes,
  fromBase64,
  MODEL_FORMAT_HINT,
  MODEL_MAX_BYTES,
  modelUploadType,
  pickMainModel,
  toBase64,
  ZettaError,
  type Generation,
  type RegisterUploadInput,
  type ReplacedResult,
  type UploadedFile,
  type ZettaClient,
} from '@zetta3d/sdk'
import type { Context } from './context'
import { cliError, usageError } from './errors'

export function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

export function requireFile(path: string): string {
  const full = resolve(path)
  if (!existsSync(full) || !statSync(full).isFile()) throw cliError('FILE_NOT_FOUND', `No such file: ${path}`)
  return full
}

export async function fileBlob(path: string): Promise<Blob> {
  const bun = (globalThis as { Bun?: { file(path: string): Blob } }).Bun
  return bun ? bun.file(path) : openAsBlob(path)
}

export function readHead(path: string, bytes = 64 * 1024): Uint8Array {
  const fd = openSync(path, 'r')
  try {
    const buffer = new Uint8Array(bytes)
    const read = readSync(fd, buffer, 0, bytes, 0)
    return buffer.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}

export type Purpose = 'picture' | 'video' | 'model'

/** Checks and uploads a local file through the relay, reporting progress. */
export async function uploadLocal(ctx: Context, client: ZettaClient, path: string, purpose: Purpose, label = basename(path)): Promise<UploadedFile> {
  const full = requireFile(path)
  const size = statSync(full).size
  const info = checkUpload(detectFile(readHead(full), full), size, purpose, label)
  ctx.out.progress({ stage: 'upload', message: `Uploading ${label} (${formatBytes(size)})…`, file: label, bytes: size })
  const blob = await fileBlob(full)
  const uploaded = await client.uploads.upload(blob, {
    contentType: info.contentType,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    onProgress: ({ sentBytes, totalBytes }) => {
      if (totalBytes > 8 * 1024 * 1024) {
        ctx.out.progress({ stage: 'upload', message: `Uploading ${label}: ${Math.round((sentBytes / totalBytes) * 100)}%`, file: label, sentBytes, totalBytes })
      }
    },
  })
  return uploaded
}

export interface PictureRef {
  /** A URL the engines can read. */
  url: string
  /** Present when the picture was uploaded by this command. */
  uploadKey?: string
  source: 'url' | 'file' | 'image-library'
}

/**
 * Turns a picture argument into a URL the engines can read.
 *
 * Accepts an http(s) URL, `image:<id>` (a picture from your image library), or a local path.
 * With `removeBackground`, the picture goes through background removal first.
 */
export async function resolvePicture(
  ctx: Context,
  client: ZettaClient,
  value: string,
  options: { removeBackground?: boolean; label?: string } = {},
): Promise<PictureRef> {
  const libraryId = /^image:(\d+)$/.exec(value)?.[1]
  if (!options.removeBackground) {
    if (isUrl(value)) return { url: value, source: 'url' }
    if (libraryId) return { url: await imageLibraryUrl(client, Number(libraryId)), source: 'image-library' }
    const uploaded = await uploadLocal(ctx, client, value, 'picture', options.label)
    return { url: uploaded.fileUrl, uploadKey: uploaded.key, source: 'file' }
  }

  let bytes: Uint8Array
  if (isUrl(value) || libraryId) {
    const url = libraryId ? await imageLibraryUrl(client, Number(libraryId)) : value
    const response = await fetch(url)
    if (!response.ok) throw cliError('DOWNLOAD_FAILED', `Could not fetch the picture (${response.status}).`)
    bytes = new Uint8Array(await response.arrayBuffer())
  } else {
    const full = requireFile(value)
    bytes = new Uint8Array(readFileSync(full))
    checkUpload(detectFile(bytes, full), bytes.length, 'picture', options.label ?? basename(full))
  }
  ctx.out.progress({ stage: 'remove-background', message: `Removing the background from ${options.label ?? 'the picture'}…` })
  const cleaned = await client.tools.removeBackground(toBase64(bytes))
  const png = fromBase64(cleaned.image)
  const uploaded = await client.uploads.upload(new Blob([png as BlobPart], { type: 'image/png' }), { contentType: 'image/png' })
  return { url: uploaded.fileUrl, uploadKey: uploaded.key, source: 'file' }
}

async function imageLibraryUrl(client: ZettaClient, id: number): Promise<string> {
  const post = await client.images.get(id)
  const url = post?.images[0]?.url
  if (!url) throw new ZettaError({ code: 'NOT_FOUND', message: `There is no picture image:${id} in your image library.`, status: 404 })
  return url
}

/** Reads a local picture as inline base64 for the image routes. */
export function inlinePicture(path: string): { data: string; contentType: string } {
  const full = requireFile(path)
  const bytes = new Uint8Array(readFileSync(full))
  const info = checkUpload(detectFile(bytes, full), bytes.length, 'picture', basename(full))
  return { data: toBase64(bytes), contentType: info.contentType }
}

/** Streams a URL to a file atomically. No credentials are sent: download URLs are pre-signed. */
export async function downloadTo(url: string, target: string, signal?: AbortSignal): Promise<number> {
  mkdirSync(dirname(target), { recursive: true })
  const response = await fetch(url, signal ? { signal } : {})
  if (!response.ok || !response.body) throw cliError('DOWNLOAD_FAILED', `Download failed (${response.status}).`, { status: response.status })
  const tmp = `${target}.part`
  try {
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(tmp))
    renameSync(tmp, target)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      // nothing to clean up
    }
    throw error
  }
  return statSync(target).size
}

/** A target path inside `dir` that does not overwrite anything unless `overwrite` is set. */
export function targetPath(dir: string, name: string, overwrite = false): string {
  const clean = name.replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '') || 'file'
  let candidate = join(dir, clean)
  if (overwrite) return candidate
  const dot = clean.lastIndexOf('.')
  const stem = dot > 0 ? clean.slice(0, dot) : clean
  const ext = dot > 0 ? clean.slice(dot) : ''
  for (let i = 2; existsSync(candidate); i++) candidate = join(dir, `${stem}-${i}${ext}`)
  return candidate
}

export function requireDir(path: string): string {
  const full = resolve(path)
  if (existsSync(full) && !statSync(full).isDirectory()) throw usageError(`${path} exists and is not a folder.`)
  mkdirSync(full, { recursive: true })
  return full
}

// ── Model imports ──────────────────────────────────────────────────────────

/** A model ready to upload: the user's one file as it is, or several files as one zip. */
export interface PreparedModel {
  blob: Blob
  /** What the stored file is: `glb`, `stl`, `fbx`, … or `zip` for several files together. */
  extension: string
  /** The model's own file name, e.g. `chair.obj` (inside the zip when zipped). */
  main: string
  /** The title the Studio would give it: the model's name without its extension. */
  title: string
  /** Files sent (1 unless zipped). */
  files: number
  zipped: boolean
}

const RAW_LIMIT = 2 * 1024 * 1024 * 1024
const STORED_TYPES = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'ktx2', 'zip', 'glb', 'usdz', 'kmz', '3mf'])

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // Hidden files and the metadata macOS adds (`.DS_Store`, `__MACOSX`, `._x`) are not part of a model.
    if (entry.name.startsWith('.') || entry.name === '__MACOSX') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

/** The file names inside a zip, read from its central directory (nothing is unpacked). */
export function zipEntryNames(path: string): string[] {
  const size = statSync(path).size
  const tailLength = Math.min(size, 65_557)
  const fd = openSync(path, 'r')
  try {
    const tail = new Uint8Array(tailLength)
    readSync(fd, tail, 0, tailLength, size - tailLength)
    const view = new DataView(tail.buffer)
    let end = -1
    for (let i = tailLength - 22; i >= 0; i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        end = i
        break
      }
    }
    if (end < 0) throw cliError('UNSUPPORTED_FILE_TYPE', `${basename(path)} is not a zip file that can be read.`)
    const count = view.getUint16(end + 10, true)
    const dirSize = view.getUint32(end + 12, true)
    const dirOffset = view.getUint32(end + 16, true)
    if (dirOffset === 0xffffffff || dirOffset + dirSize > size) throw cliError('UNSUPPORTED_FILE_TYPE', `${basename(path)} is a zip format (zip64) that cannot be checked here.`)
    const directory = new Uint8Array(dirSize)
    readSync(fd, directory, 0, dirSize, dirOffset)
    const dir = new DataView(directory.buffer)
    const names: string[] = []
    for (let at = 0, i = 0; i < count && at + 46 <= dirSize; i++) {
      if (dir.getUint32(at, true) !== 0x02014b50) break
      const nameLength = dir.getUint16(at + 28, true)
      const extra = dir.getUint16(at + 30, true)
      const comment = dir.getUint16(at + 32, true)
      names.push(new TextDecoder().decode(directory.subarray(at + 46, at + 46 + nameLength)))
      at += 46 + nameLength + extra + comment
    }
    return names.filter((name) => !name.endsWith('/') && !name.includes('__MACOSX/') && !(name.split('/').pop() ?? '').startsWith('._'))
  } finally {
    closeSync(fd)
  }
}

/** A zip (deflated, or stored when that is no smaller) of named files. */
export function zipFiles(entries: Array<{ name: string; bytes: Uint8Array; modified?: Date }>): Uint8Array {
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name)
    const ext = extensionOf(entry.name)
    const deflated = STORED_TYPES.has(ext) ? undefined : new Uint8Array(deflateRawSync(entry.bytes, { level: 6 }))
    const useDeflate = deflated !== undefined && deflated.length < entry.bytes.length
    const data = useDeflate ? deflated! : entry.bytes
    const crc = crc32(entry.bytes)
    const date = entry.modified ?? new Date()
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)
    const dosDate = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(6, 0x0800, true) // UTF-8 names
    lv.setUint16(8, useDeflate ? 8 : 0, true)
    lv.setUint16(10, dosTime, true)
    lv.setUint16(12, dosDate, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, data.length, true)
    lv.setUint32(22, entry.bytes.length, true)
    lv.setUint16(26, name.length, true)
    local.set(name, 30)
    const central = new Uint8Array(46 + name.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(8, 0x0800, true)
    cv.setUint16(10, useDeflate ? 8 : 0, true)
    cv.setUint16(12, dosTime, true)
    cv.setUint16(14, dosDate, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, entry.bytes.length, true)
    cv.setUint16(28, name.length, true)
    cv.setUint32(42, offset, true)
    central.set(name, 46)
    locals.push(local, data)
    centrals.push(central)
    offset += local.length + data.length
  }
  const dirSize = centrals.reduce((sum, c) => sum + c.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, dirSize, true)
  ev.setUint32(16, offset, true)
  const parts = [...locals, ...centrals, end]
  const out = new Uint8Array(offset + dirSize + 22)
  parts.reduce((at, part) => (out.set(part, at), at + part.length), 0)
  return out
}

/**
 * Packages files for a library import the way the Studio's Upload button does.
 *
 * One file goes as it is, byte for byte (a `.zip` too, once it is known to hold a model). Several
 * files, or a folder, go as one zip — an OBJ means nothing without its `.mtl` and textures, and an
 * import holds one file. Chosen files are stored by name; a folder's files keep their paths inside
 * it, so an OBJ's `textures/wood.png` still resolves. Nothing is converted.
 */
export async function prepareModelImport(ctx: Context, paths: readonly string[]): Promise<PreparedModel> {
  if (!paths.length) throw usageError('Give a model file, several files, or a folder.')
  const chosen: Array<{ full: string; name: string }> = []
  for (const path of paths) {
    const full = resolve(ctx.cwd, path)
    if (!existsSync(full)) throw cliError('FILE_NOT_FOUND', `No such file or folder: ${path}`)
    if (statSync(full).isDirectory()) {
      const files = walk(full)
      if (!files.length) throw usageError(`${path} is empty.`)
      for (const file of files) chosen.push({ full: file, name: relative(full, file).split(sep).join('/') })
    } else chosen.push({ full, name: basename(full) })
  }

  // The names a model could be picked from: the files, and what any zip among them holds.
  const names: string[] = []
  for (const file of chosen) {
    if (extensionOf(file.name) === 'zip') names.push(...zipEntryNames(file.full).map((n) => n.split('/').pop() ?? n))
    else names.push(file.name.split('/').pop() ?? file.name)
  }
  const main = pickMainModel(names)
  if (!main) throw cliError('UNSUPPORTED_FILE_TYPE', `That is not a 3D model the library can import. Import one of: ${MODEL_FORMAT_HINT}.`)
  const title = main.replace(/\.[^.]+$/, '')

  const single = paths.length === 1 && chosen.length === 1 && !statSync(resolve(ctx.cwd, paths[0]!)).isDirectory() ? chosen[0] : undefined
  if (single) {
    const extension = extensionOf(single.name)
    modelUploadType(extension)
    if (extension === 'glb' && detectFile(readHead(single.full, 16))?.contentType !== 'model/gltf-binary') {
      throw cliError('UNSUPPORTED_FILE_TYPE', `${single.name} is not a GLB file.`)
    }
    const size = statSync(single.full).size
    checkModelSize(single.name, size)
    return { blob: await fileBlob(single.full), extension, main, title, files: 1, zipped: false }
  }

  const seen = new Set<string>()
  let raw = 0
  for (const file of chosen) {
    const key = file.name.toLowerCase()
    if (seen.has(key)) throw usageError(`Two of the files are both called ${file.name}; rename one, or import their folder instead.`)
    seen.add(key)
    raw += statSync(file.full).size
  }
  if (raw > RAW_LIMIT) checkModelSize('The files', raw)
  ctx.out.progress({ stage: 'package', message: `Packing ${chosen.length} files into one zip…` })
  const zip = zipFiles(chosen.map((file) => ({ name: file.name, bytes: new Uint8Array(readFileSync(file.full)), modified: statSync(file.full).mtime })))
  checkModelSize(`${title}.zip`, zip.length)
  return { blob: new Blob([zip as BlobPart], { type: 'application/zip' }), extension: 'zip', main, title, files: chosen.length, zipped: true }
}

function checkModelSize(label: string, bytes: number): void {
  if (bytes > MODEL_MAX_BYTES) {
    throw cliError('FILE_TOO_LARGE', `${label} is ${formatBytes(bytes)}; the limit is 512 MB.`, { bytes, limit: MODEL_MAX_BYTES })
  }
}

/** Packages, uploads and records a model in the library (free). Returns the new library item. */
export async function importModel(
  ctx: Context,
  client: ZettaClient,
  paths: readonly string[],
  options: Omit<RegisterUploadInput, 'key' | 'bytes'> = {},
): Promise<{ generation: Generation; prepared: PreparedModel }> {
  const prepared = await prepareModelImport(ctx, paths)
  const label = prepared.zipped ? `${prepared.title}.zip` : prepared.main
  const size = prepared.blob.size
  ctx.out.progress({ stage: 'upload', message: `Uploading ${label} (${formatBytes(size)})…`, file: label, bytes: size })
  const uploaded = await client.uploads.upload(prepared.blob, {
    ...modelUploadType(prepared.extension),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    onProgress: ({ sentBytes, totalBytes }) => {
      if (totalBytes > 8 * 1024 * 1024) ctx.out.progress({ stage: 'upload', message: `Uploading ${label}: ${Math.round((sentBytes / totalBytes) * 100)}%`, file: label, sentBytes, totalBytes })
    },
  })
  const title = (options.title ?? prepared.title).trim().slice(0, 120)
  const generation = await client.uploads.register({ ...options, key: uploaded.key, bytes: uploaded.bytes, ...(title ? { title } : {}) })
  return { generation, prepared }
}

// ── Replacing a stored model file ──────────────────────────────────────────

/** Whether bytes are a GLB or an FBX (binary or ASCII), from their first bytes. */
export function modelFileFormat(head: Uint8Array): 'glb' | 'fbx' | undefined {
  const text = new TextDecoder('latin1').decode(head.subarray(0, 64))
  if (text.startsWith('glTF')) return 'glb'
  if (text.startsWith('Kaydara FBX Binary') || /^\s*;\s*FBX/.test(text)) return 'fbx'
  return undefined
}

/**
 * Overwrites a library item's stored GLB (or its one FBX) with a local file or bytes — the Studio's
 * Save. Exported for other commands (AI edits) that save a model back.
 *
 * `part` counts from 1, as the Studio numbers a segmentation's parts. Without `format`, it follows
 * the file. Nothing can be undone afterwards.
 */
export async function replaceLocal(
  ctx: Context,
  client: ZettaClient,
  id: number,
  source: string | { bytes: Uint8Array; name?: string },
  options: { part?: number; format?: 'glb' | 'fbx'; expectedKey?: string } = {},
): Promise<ReplacedResult> {
  let blob: Blob
  let head: Uint8Array
  let label: string
  if (typeof source === 'string') {
    const full = requireFile(resolve(ctx.cwd, source))
    blob = await fileBlob(full)
    head = readHead(full, 64)
    label = basename(full)
  } else {
    blob = new Blob([source.bytes as BlobPart])
    head = source.bytes.subarray(0, 64)
    label = source.name ?? 'the model'
  }
  const detected = modelFileFormat(head)
  if (!detected) throw cliError('UNSUPPORTED_FILE_TYPE', `${label} is not a GLB or FBX file.`)
  const format = options.format ?? detected
  if (format !== detected) throw usageError(`${label} is a${detected === 'fbx' ? 'n FBX' : ' GLB'}, not a${format === 'fbx' ? 'n FBX' : ' GLB'}.`)
  if (options.part !== undefined && format === 'fbx') throw usageError('Parts are saved as GLBs; --part cannot go with an FBX.')
  checkModelSize(label, blob.size)
  ctx.out.progress({ stage: 'upload', message: `Saving ${label} over #${id}${options.part !== undefined ? ` part ${options.part}` : ''} (${formatBytes(blob.size)})…`, file: label, bytes: blob.size })
  return client.uploads.replaceResult(id, blob, {
    format,
    ...(options.part !== undefined ? { part: options.part - 1 } : {}),
    ...(options.expectedKey ? { expectedKey: options.expectedKey } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    onProgress: ({ sentBytes, totalBytes }) => {
      if (totalBytes > 8 * 1024 * 1024) ctx.out.progress({ stage: 'upload', message: `Saving ${label}: ${Math.round((sentBytes / totalBytes) * 100)}%`, file: label, sentBytes, totalBytes })
    },
  })
}
