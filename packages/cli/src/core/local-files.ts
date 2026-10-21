import { createWriteStream, existsSync, mkdirSync, openSync, readSync, closeSync, renameSync, statSync, readFileSync, unlinkSync } from 'node:fs'
import { openAsBlob } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { checkUpload, detectFile, formatBytes, fromBase64, toBase64, ZettaError, type UploadedFile, type ZettaClient } from '@zetta3d/sdk'
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
