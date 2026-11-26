import { readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { detectFile, extensionFor, formatBytes, fromBase64, toBase64, ZettaError, type ImageModel, type ImagePost, type ImageResult, type InlineImage, type ZettaClient } from '@zetta3d/sdk'
import { z } from 'zod'
import type { Context } from '../core/context'
import { defineCommand, pageShape } from '../core/define'
import { cliError, usageError } from '../core/errors'
import { downloadTo, inlinePicture, isUrl, requireDir, requireFile, targetPath } from '../core/local-files'
import { table } from '../core/output'

export const ASPECT_RATIOS = ['9:16', '2:3', '3:4', '4:5', '1:1', '5:4', '4:3', '3:2', '16:9', '21:9'] as const
const RESOLUTIONS = ['1K', '2K', '4K'] as const

const engineField = z.string().optional().describe('Image engine by name: flash or pro (default: the best your plan allows). See `zetta catalog engines --images`.')

/** An image engine as people see it: its public name, never the server’s model id. */
export interface PublicImageEngine {
  /** What --engine takes: flash, pro, image-1 … */
  name: string
  /** What the server wants in `model` for this caller (a session sees configured ids, an API key public names). */
  id: string
  resolutions: string[]
  locked: boolean
  lockedReason: string | null
  default: boolean
}

/**
 * Names `GET /2d/models` in public terms, as the server itself names engines for API keys: its two
 * main engines are flash and pro, and any others image-1, image-2 … in list order. Through a
 * session the ids are configured model ids, which are sent but never shown.
 */
export function publicImageEngines(response: { models: ImageModel[]; default?: string }): PublicImageEngine[] {
  let extra = 0
  return response.models.map((model) => {
    const label = model.label.trim().toLowerCase()
    const name = label === 'flash' || label === 'pro' ? label : `image-${++extra}`
    return { name, id: model.id, resolutions: model.resolutions ?? [], locked: Boolean(model.locked), lockedReason: model.lockedReason ?? null, default: model.id === response.default }
  })
}

/**
 * Turns --engine (flash, pro, image-1 …, any case, or a unique prefix) into the `model` to send.
 * Locked engines and resolutions an engine cannot make are refused here, before anything is sent.
 */
export async function imageEngineId(client: ZettaClient, name: string | undefined, resolution?: string): Promise<string | undefined> {
  if (!name) return undefined
  const engines = publicImageEngines(await client.catalog.imageModels())
  const wanted = name.trim().toLowerCase()
  const prefixed = engines.filter((e) => e.name.startsWith(wanted))
  const match = engines.find((e) => e.name === wanted) ?? (prefixed.length === 1 ? prefixed[0] : undefined)
  if (!match) throw usageError(`Unknown image engine "${name}". Engines: ${engines.map((e) => e.name).join(', ')}.`)
  if (match.locked) throw new ZettaError({ code: 'IMAGE_PRO_MODEL_REQUIRES_PLAN', message: `${match.name} needs a paid plan.`, status: 403 })
  if (resolution && match.resolutions.length && !match.resolutions.includes(resolution)) {
    throw usageError(`${match.name} cannot make ${resolution} pictures; it makes ${match.resolutions.join(', ')}.`)
  }
  return match.id
}

/** A picture for the image routes: a local file, `image:<id>` (your image library) or a URL. */
async function pictureInput(value: string): Promise<{ image?: InlineImage; sourcePostId?: number }> {
  const library = /^image:(\d+)$/.exec(value)?.[1]
  if (library) return { sourcePostId: Number(library) }
  if (isUrl(value)) {
    const response = await fetch(value)
    if (!response.ok) throw usageError(`Could not fetch ${value} (${response.status}).`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    const info = detectFile(bytes)
    if (info?.kind !== 'image') throw usageError(`${value} is not a PNG, JPEG or WebP picture.`)
    return { image: { data: toBase64(bytes), contentType: info.contentType } }
  }
  return { image: inlinePicture(value) }
}

export interface SavedImages {
  /** The image-library id (image:<id>); null if the server could not record it. */
  imageId: number | null
  files: Array<{ path: string; bytes: number; contentType: string }>
  text: string | null
  next?: string
}

/**
 * Pictures come back with the reply, so saving them costs nothing: they save unless --no-download or
 * the download.auto setting is false (then they stay in your image library only).
 */
function saveImages(ctx: Context, result: ImageResult, input: { out?: string | undefined; download?: boolean | undefined }, stem: string): SavedImages {
  const postId = (result.postId as number | null | undefined) ?? null
  const save = Boolean(input.out) || postId === null || (input.download ?? (ctx.mode === 'mcp' || ctx.config.file.download?.auto !== false))
  if (!save) return { imageId: postId, files: [], text: result.text ?? null, next: `zetta image download ${postId}` }
  const dir = requireDir(input.out ? resolve(ctx.cwd, input.out) : ctx.downloadDir())
  const id = postId ?? Date.now()
  const files = result.images.map((image, index) => {
    const path = targetPath(dir, `${stem}-${id}${result.images.length > 1 ? `-${index + 1}` : ''}.${extensionFor(image.contentType)}`)
    const bytes = fromBase64(image.base64)
    writeFileSync(path, bytes)
    return { path, bytes: bytes.length, contentType: image.contentType }
  })
  for (const file of files) ctx.out.progress({ stage: 'save', message: `Saved ${file.path}`, path: file.path })
  return { imageId: postId, files, text: result.text ?? null }
}

const renderSaved = (r: SavedImages) =>
  [r.imageId !== null ? `Image #${r.imageId}` : 'Image (not recorded in your image library)', ...r.files.map((f) => `  saved: ${f.path}`), r.text ? `  note: ${r.text}` : '', r.next ? `  next:  ${r.next}` : ''].filter(Boolean).join('\n')

const common = {
  aspectRatio: z.enum(ASPECT_RATIOS).optional().describe('Aspect ratio: 9:16, 2:3, 3:4, 4:5, 1:1, 5:4, 4:3, 3:2, 16:9 or 21:9.'),
  resolution: z.enum(RESOLUTIONS).optional().describe('Resolution: 1K, 2K or 4K (4K needs a paid plan and the pro engine).'),
  engine: engineField,
  for3d: z.boolean().optional().describe('A clean, square 1K picture made to be turned into 3D (overrides aspect ratio, resolution and engine).'),
  subject: z.enum(['object', 'environment']).optional().describe('With --for-3d: an object on a plain background (default), or a whole environment.'),
  fast: z.boolean().optional().describe('Prefer the faster engine (an explicit --engine wins).'),
  out: z.string().optional().describe('Folder to save the picture(s) into (default: the current folder, or the download.dir setting).'),
  download: z.boolean().optional().describe('Save the picture(s) (default: on, unless the download.auto setting is false). --no-download keeps them in your image library only.'),
}

/** The options every image route shares, as the request wants them. */
async function options(client: ZettaClient, input: { aspectRatio?: string | undefined; resolution?: (typeof RESOLUTIONS)[number] | undefined; engine?: string | undefined; for3d?: boolean | undefined; subject?: 'object' | 'environment' | undefined; fast?: boolean | undefined }) {
  if (input.subject && !input.for3d) throw usageError('--subject goes with --for-3d.')
  if (input.for3d && input.engine) throw usageError('--for-3d always uses the fast engine; leave out --engine.')
  const model = input.for3d ? undefined : await imageEngineId(client, input.engine, input.resolution)
  return {
    ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
    ...(input.resolution ? { resolution: input.resolution } : {}),
    ...(model ? { model } : {}),
    ...(input.for3d ? { for3D: true } : {}),
    ...(input.for3d && input.subject ? { subject: input.subject } : {}),
    ...(input.fast ? { fast: true } : {}),
  }
}

export const imageGenerate = defineCommand({
  path: ['image', 'generate'],
  summary: 'Make a picture from a text prompt (paid plans).',
  description: 'Use --for-3d to get a square picture ready for `zetta generate --image`.',
  kind: 'write',
  input: z.object({
    prompt: z.string().min(1).max(5000).describe('What to draw.'),
    ...common,
    style: z.array(z.string()).optional().describe('Up to 3 style reference pictures (files).'),
  }),
  short: { prompt: 'p' },
  examples: ['zetta image generate -p "a red vintage armchair, studio light" --for-3d --out ./refs', 'zetta image generate -p "a misty pine forest" --aspect-ratio 21:9 --resolution 4K --engine pro'],
  async run(ctx, input) {
    const client = await ctx.client()
    if ((input.style?.length ?? 0) > 3) throw usageError('Give at most 3 --style pictures.')
    const shared = await options(client, input)
    ctx.out.progress({ stage: 'generate', message: 'Making the picture…' })
    const result = await client.images.generate(
      { prompt: input.prompt, ...shared, ...(input.style?.length ? { styleReferences: input.style.map(inlinePicture) } : {}) },
      crypto.randomUUID(),
    )
    return saveImages(ctx, result, input, 'image')
  },
  text: renderSaved,
})

export const imageEdit = defineCommand({
  path: ['image', 'edit'],
  summary: 'Change a picture with an instruction (paid plans).',
  kind: 'write',
  positionals: [{ name: 'image', required: true }],
  input: z.object({
    image: z.string().describe('The picture: a file, a URL, or image:<id> from your image library.'),
    prompt: z.string().min(1).max(5000).describe('What to change.'),
    ...common,
  }),
  short: { prompt: 'p' },
  examples: ['zetta image edit ./chair.png -p "make it dark green velvet"', 'zetta image edit image:812 -p "remove the cushion" --for-3d'],
  async run(ctx, input) {
    const client = await ctx.client()
    const source = await pictureInput(input.image)
    const shared = await options(client, input)
    ctx.out.progress({ stage: 'generate', message: 'Editing the picture…' })
    const result = await client.images.edit({ prompt: input.prompt, ...source, ...shared }, crypto.randomUUID())
    return saveImages(ctx, result, input, 'edit')
  },
  text: renderSaved,
})

export const MAX_COMPOSE_PICTURES = 14

export const imageCompose = defineCommand({
  path: ['image', 'compose'],
  summary: 'Combine 2–14 pictures into one, following a prompt (paid plans).',
  description: 'Pictures can be files, URLs or image:<id> entries from your image library, in any mix: at least 2 and at most 14 in all.',
  kind: 'write',
  positionals: [{ name: 'images', required: true, variadic: true }],
  input: z.object({
    images: z.array(z.string()).min(2).max(MAX_COMPOSE_PICTURES).describe('2–14 pictures: files, URLs or image:<id>.'),
    prompt: z.string().min(1).max(5000).describe('How to combine them.'),
    ...common,
  }),
  short: { prompt: 'p' },
  examples: ['zetta image compose sofa.png lamp.png rug.png -p "a cosy living room with these items"', 'zetta image compose image:812 image:813 ./logo.png -p "the logo on both mugs" --aspect-ratio 16:9'],
  async run(ctx, input) {
    const client = await ctx.client()
    const images: InlineImage[] = []
    const sourcePostIds: number[] = []
    for (const value of input.images) {
      const source = await pictureInput(value)
      if (source.image) images.push(source.image)
      if (source.sourcePostId) sourcePostIds.push(source.sourcePostId)
    }
    const shared = await options(client, input)
    ctx.out.progress({ stage: 'generate', message: `Combining ${input.images.length} pictures…` })
    const result = await client.images.compose(
      { prompt: input.prompt, ...(images.length ? { images } : {}), ...(sourcePostIds.length ? { sourcePostIds } : {}), ...shared },
      crypto.randomUUID(),
    )
    return saveImages(ctx, result, input, 'compose')
  },
  text: renderSaved,
})

function imageSummary(post: ImagePost) {
  return {
    id: post.id,
    ref: `image:${post.id}`,
    kind: post.feature === 'genImg' ? 'generate' : post.feature === 'editImg' ? 'edit' : post.feature === 'composeImg' ? 'compose' : post.feature,
    prompt: post.prompt,
    aspectRatio: post.aspectRatio,
    resolution: post.resolution,
    pictures: post.images.length,
    error: post.errorMessage,
    createdAt: post.createdAt,
  }
}

const LIST_KINDS = { generate: 'genImg', edit: 'editImg', compose: 'composeImg', genImg: 'genImg', editImg: 'editImg', composeImg: 'composeImg' } as const

export const imageList = defineCommand({
  path: ['image', 'list'],
  summary: 'List your image library (newest first).',
  kind: 'read',
  input: z.object({
    ...pageShape,
    kind: z.enum(Object.keys(LIST_KINDS) as [keyof typeof LIST_KINDS, ...Array<keyof typeof LIST_KINDS>]).optional().describe('Only this kind: generate, edit or compose (or genImg, editImg, composeImg).'),
    search: z.string().max(200).optional().describe('Search prompts.'),
  }),
  examples: ['zetta image list --kind generate --search lamp', 'zetta image list --kind compose --limit 50 --json'],
  async run(ctx, input) {
    const feature = input.kind ? LIST_KINDS[input.kind] : undefined
    const page = await (await ctx.client()).images.list({ page: input.page ?? 1, pageSize: input.limit ?? 18, ...(feature ? { feature } : {}), ...(input.search?.trim() ? { search: input.search.trim() } : {}) })
    return { items: page.items.map(imageSummary), total: page.total, page: page.page, hasMore: page.page * page.pageSize < page.total }
  },
  text: (r: { items: Array<ReturnType<typeof imageSummary>>; total: number; page: number; hasMore: boolean }) =>
    `${table(r.items.map((i) => ({ ref: i.ref, kind: i.kind, prompt: i.prompt, created: i.createdAt.slice(0, 16).replace('T', ' ') })))}\n${r.total} picture set(s)${r.hasMore ? ` · next page: --page ${r.page + 1}` : ''}. Use image:<id> anywhere a picture is expected.`,
})

export const imageGet = defineCommand({
  path: ['image', 'get'],
  summary: 'Show one picture set from your image library.',
  kind: 'read',
  positionals: [{ name: 'id', required: true }],
  input: z.object({ id: z.number().int().positive().describe('Image id (from `zetta image list`).') }),
  async run(ctx, input) {
    const post = await (await ctx.client()).images.get(input.id)
    if (!post) throw new ZettaError({ code: 'NOT_FOUND', message: `There is no image #${input.id}.`, status: 404 })
    return imageSummary(post)
  },
})

export const imageDownload = defineCommand({
  path: ['image', 'download'],
  summary: 'Download the pictures of an image-library entry.',
  kind: 'read',
  positionals: [{ name: 'id', required: true }],
  input: z.object({
    id: z.number().int().positive().describe('Image id.'),
    out: z.string().optional().describe('Folder to save into (default: the current folder, or the download.dir setting).'),
  }),
  async run(ctx, input) {
    const post = await (await ctx.client()).images.get(input.id)
    if (!post) throw new ZettaError({ code: 'NOT_FOUND', message: `There is no image #${input.id}.`, status: 404 })
    const dir = requireDir(input.out ? resolve(ctx.cwd, input.out) : ctx.downloadDir())
    const files = []
    for (const [index, image] of post.images.entries()) {
      const path = targetPath(dir, `image-${post.id}${post.images.length > 1 ? `-${index + 1}` : ''}.${extensionFor(image.contentType)}`)
      files.push({ path, bytes: await downloadTo(image.url, path, ctx.signal) })
    }
    return { id: post.id, files }
  },
  text: (r: { files: Array<{ path: string }> }) => r.files.map((f) => `Saved ${f.path}`).join('\n'),
})

export const imageDelete = defineCommand({
  path: ['image', 'delete'],
  summary: 'Delete image-library entries.',
  description: 'In a terminal you are asked first; otherwise pass --yes.',
  kind: 'destructive',
  positionals: [{ name: 'ids', required: true, variadic: true }],
  input: z.object({ ids: z.array(z.number().int().positive()).min(1).describe('Image ids.'), yes: z.boolean().optional().describe('Delete without asking.') }),
  async run(ctx, input) {
    const ids = [...new Set(input.ids)]
    if (!input.yes) {
      const ok = ctx.interactive && (await ctx.confirm(`Delete ${ids.length} picture set(s) (${ids.map((id) => `image:${id}`).join(', ')})?`))
      if (!ok) throw usageError(ctx.interactive ? 'Cancelled; nothing was deleted.' : 'Pass --yes to delete without a terminal.')
    }
    const client = await ctx.client()
    const deleted: number[] = []
    const failed: Array<{ id: number; error: string }> = []
    for (const id of ids) {
      try {
        await client.images.delete(id)
        deleted.push(id)
      } catch (error) {
        failed.push({ id, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return { deleted, failed, ...(failed.length ? { exitCode: 1 } : {}) }
  },
  text: (r: { deleted: number[]; failed: Array<{ id: number; error: string }> }) =>
    [r.deleted.length ? `Deleted ${r.deleted.map((id) => `image:${id}`).join(', ')}.` : '', ...r.failed.map((f) => `Could not delete image:${f.id}: ${f.error}`)].filter(Boolean).join('\n'),
})

const REMOVE_BG_MAX_BYTES = 8 * 1024 * 1024

export const imageRemoveBg = defineCommand({
  path: ['image', 'remove-bg'],
  summary: 'Remove the background from a picture (saves a PNG).',
  kind: 'write',
  positionals: [{ name: 'file', required: true }],
  input: z.object({
    file: z.string().describe('A PNG, JPEG or WebP picture (max 8 MB).'),
    out: z.string().optional().describe('Where to save the PNG (default: <name>-nobg.png next to the input).'),
  }),
  async run(ctx, input) {
    const full = requireFile(resolve(ctx.cwd, input.file))
    const bytes = new Uint8Array(readFileSync(full))
    const info = detectFile(bytes, full)
    if (info?.kind !== 'image') throw cliError('UNSUPPORTED_FILE_TYPE', `${basename(full)} is not a PNG, JPEG or WebP picture.`)
    if (bytes.length > REMOVE_BG_MAX_BYTES) throw cliError('FILE_TOO_LARGE', `${basename(full)} is ${formatBytes(bytes.length)}; the limit is 8 MB.`, { bytes: bytes.length, limit: REMOVE_BG_MAX_BYTES })
    ctx.out.progress({ stage: 'remove-background', message: 'Removing the background…' })
    const result = await (await ctx.client()).tools.removeBackground(toBase64(bytes))
    const target = input.out ?? full.replace(/\.[^./\\]+$/, '') + '-nobg.png'
    const png = fromBase64(result.image)
    writeFileSync(target, png)
    return { path: target, bytes: png.length, source: basename(full) }
  },
  text: (r: { path: string }) => `Saved ${r.path}`,
})

export const imageCommands = [imageGenerate, imageEdit, imageCompose, imageList, imageGet, imageDownload, imageDelete, imageRemoveBg]
