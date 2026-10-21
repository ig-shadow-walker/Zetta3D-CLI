import { readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { extensionFor, fromBase64, toBase64, ZettaError, type ImagePost, type ImageResult, type InlineImage, type ZettaClient } from '@zetta3d/sdk'
import { z } from 'zod'
import type { Context } from '../core/context'
import { defineCommand, pageShape } from '../core/define'
import { usageError } from '../core/errors'
import { downloadTo, inlinePicture, isUrl, requireDir, requireFile, targetPath } from '../core/local-files'
import { table } from '../core/output'

export const ASPECT_RATIOS = ['9:16', '2:3', '3:4', '4:5', '1:1', '5:4', '4:3', '3:2', '16:9', '21:9'] as const
const RESOLUTIONS = ['1K', '2K', '4K'] as const

const engineField = z.string().optional().describe('Image engine by name: flash (default) or pro. See `zetta catalog engines --images`.')

/**
 * Image engines are chosen by their public label (Flash, Pro). The server's ids are looked up
 * at run time and never printed.
 */
export async function imageEngineId(client: ZettaClient, name: string | undefined): Promise<string | undefined> {
  if (!name) return undefined
  const { models } = await client.catalog.imageModels()
  const wanted = name.trim().toLowerCase()
  const match = models.find((m) => m.label.toLowerCase() === wanted || m.label.toLowerCase().startsWith(wanted))
  if (!match) throw usageError(`Unknown image engine "${name}". Engines: ${models.map((m) => m.label.toLowerCase()).join(', ')}.`)
  if (match.locked) throw new ZettaError({ code: 'IMAGE_PRO_MODEL_REQUIRES_PLAN', message: `${match.label} needs a paid plan.`, status: 403 })
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
    return { image: { data: toBase64(bytes), contentType: response.headers.get('content-type')?.split(';')[0] ?? 'image/png' } }
  }
  return { image: inlinePicture(value) }
}

export interface SavedImages {
  imageId: number
  files: Array<{ path: string; bytes: number; contentType: string }>
  text: string | null
  next?: string
}

/**
 * Pictures come back with the reply, so saving them costs nothing: they save unless --no-download or
 * the download.auto setting is false (then they stay in your image library only).
 */
function saveImages(ctx: Context, result: ImageResult, input: { out?: string | undefined; download?: boolean | undefined }, stem: string): SavedImages {
  const save = Boolean(input.out) || (input.download ?? (ctx.mode === 'mcp' || ctx.config.file.download?.auto !== false))
  if (!save) return { imageId: result.postId, files: [], text: result.text ?? null, next: `zetta image download ${result.postId}` }
  const dir = requireDir(input.out ? resolve(ctx.cwd, input.out) : ctx.downloadDir())
  const files = result.images.map((image, index) => {
    const path = targetPath(dir, `${stem}-${result.postId}${result.images.length > 1 ? `-${index + 1}` : ''}.${extensionFor(image.contentType)}`)
    const bytes = fromBase64(image.base64)
    writeFileSync(path, bytes)
    return { path, bytes: bytes.length, contentType: image.contentType }
  })
  for (const file of files) ctx.out.progress({ stage: 'save', message: `Saved ${file.path}`, path: file.path })
  return { imageId: result.postId, files, text: result.text ?? null }
}

const renderSaved = (r: SavedImages) =>
  [`Image #${r.imageId}`, ...r.files.map((f) => `  saved: ${f.path}`), r.text ? `  note: ${r.text}` : '', r.next ? `  next:  ${r.next}` : ''].filter(Boolean).join('\n')

const common = {
  aspectRatio: z.enum(ASPECT_RATIOS).optional().describe('Aspect ratio.'),
  resolution: z.enum(RESOLUTIONS).optional().describe('Resolution (4K needs a paid plan).'),
  engine: engineField,
  out: z.string().optional().describe('Folder to save the picture(s) into (default: the current folder, or the download.dir setting).'),
  download: z.boolean().optional().describe('Save the picture(s) (default: on, unless the download.auto setting is false). --no-download keeps them in your image library only.'),
}

export const imageGenerate = defineCommand({
  path: ['image', 'generate'],
  summary: 'Make a picture from a text prompt.',
  description: 'Use --for-3d to get a square picture ready for `zetta generate --image`.',
  kind: 'write',
  input: z.object({
    prompt: z.string().min(1).max(5000).describe('What to draw.'),
    ...common,
    for3d: z.boolean().optional().describe('A clean, square picture made to be turned into 3D.'),
    subject: z.enum(['object', 'environment']).optional().describe('An object, or a whole environment.'),
    fast: z.boolean().optional().describe('Faster, lighter generation.'),
    style: z.array(z.string()).optional().describe('Up to 3 style reference pictures (files).'),
  }),
  short: { prompt: 'p' },
  examples: ['zetta image generate -p "a red vintage armchair, studio light" --for-3d --out ./refs'],
  async run(ctx, input) {
    const client = await ctx.client()
    if ((input.style?.length ?? 0) > 3) throw usageError('Give at most 3 --style pictures.')
    ctx.out.progress({ stage: 'generate', message: 'Making the picture…' })
    const model = await imageEngineId(client, input.engine)
    const result = await client.images.generate({
      prompt: input.prompt,
      ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
      ...(input.resolution ? { resolution: input.resolution } : {}),
      ...(model ? { model } : {}),
      ...(input.for3d ? { for3D: true } : {}),
      ...(input.subject ? { subject: input.subject } : {}),
      ...(input.fast ? { fast: true } : {}),
      ...(input.style?.length ? { styleReferences: input.style.map(inlinePicture) } : {}),
    }, crypto.randomUUID())
    return saveImages(ctx, result, input, 'image')
  },
  text: renderSaved,
})

export const imageEdit = defineCommand({
  path: ['image', 'edit'],
  summary: 'Change a picture with an instruction (needs a paid plan).',
  kind: 'write',
  positionals: [{ name: 'image', required: true }],
  input: z.object({
    image: z.string().describe('The picture: a file, a URL, or image:<id> from your image library.'),
    prompt: z.string().min(1).max(5000).describe('What to change.'),
    ...common,
  }),
  short: { prompt: 'p' },
  examples: ['zetta image edit ./chair.png -p "make it dark green velvet"'],
  async run(ctx, input) {
    const client = await ctx.client()
    const source = await pictureInput(input.image)
    const model = await imageEngineId(client, input.engine)
    ctx.out.progress({ stage: 'generate', message: 'Editing the picture…' })
    const result = await client.images.edit({
      prompt: input.prompt,
      ...source,
      ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
      ...(input.resolution ? { resolution: input.resolution } : {}),
      ...(model ? { model } : {}),
    }, crypto.randomUUID())
    return saveImages(ctx, result, input, 'edit')
  },
  text: renderSaved,
})

export const imageCompose = defineCommand({
  path: ['image', 'compose'],
  summary: 'Combine 2–14 pictures into one, following a prompt.',
  kind: 'write',
  positionals: [{ name: 'images', required: true, variadic: true }],
  input: z.object({
    images: z.array(z.string()).min(2).max(14).describe('Pictures: files, URLs or image:<id>.'),
    prompt: z.string().min(1).max(5000).describe('How to combine them.'),
    ...common,
  }),
  short: { prompt: 'p' },
  examples: ['zetta image compose sofa.png lamp.png rug.png -p "a cosy living room with these items"'],
  async run(ctx, input) {
    const client = await ctx.client()
    const images: InlineImage[] = []
    const sourcePostIds: number[] = []
    for (const value of input.images) {
      const source = await pictureInput(value)
      if (source.image) images.push(source.image)
      if (source.sourcePostId) sourcePostIds.push(source.sourcePostId)
    }
    const model = await imageEngineId(client, input.engine)
    ctx.out.progress({ stage: 'generate', message: `Combining ${input.images.length} pictures…` })
    const result = await client.images.compose({
      prompt: input.prompt,
      ...(images.length ? { images } : {}),
      ...(sourcePostIds.length ? { sourcePostIds } : {}),
      ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
      ...(input.resolution ? { resolution: input.resolution } : {}),
      ...(model ? { model } : {}),
    }, crypto.randomUUID())
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

export const imageList = defineCommand({
  path: ['image', 'list'],
  summary: 'List your image library (newest first).',
  kind: 'read',
  input: z.object({
    ...pageShape,
    kind: z.enum(['generate', 'edit', 'compose']).optional().describe('Only this kind.'),
    search: z.string().optional().describe('Search prompts.'),
  }),
  async run(ctx, input) {
    const feature = input.kind === 'generate' ? 'genImg' : input.kind === 'edit' ? 'editImg' : input.kind === 'compose' ? 'composeImg' : undefined
    const page = await (await ctx.client()).images.list({ page: input.page ?? 1, pageSize: input.limit ?? 18, ...(feature ? { feature } : {}), ...(input.search ? { search: input.search } : {}) })
    return { items: page.items.map(imageSummary), total: page.total, page: page.page, hasMore: page.page * page.pageSize < page.total }
  },
  text: (r: { items: Array<ReturnType<typeof imageSummary>>; total: number }) =>
    `${table(r.items.map((i) => ({ ref: i.ref, kind: i.kind, prompt: i.prompt, created: i.createdAt.slice(0, 16).replace('T', ' ') })))}\n${r.total} picture set(s). Use image:<id> anywhere a picture is expected.`,
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
  kind: 'destructive',
  positionals: [{ name: 'ids', required: true, variadic: true }],
  input: z.object({ ids: z.array(z.number().int().positive()).min(1).describe('Image ids.'), yes: z.boolean().optional().describe('Delete without asking.') }),
  async run(ctx, input) {
    if (!input.yes) {
      const ok = ctx.interactive && (await ctx.confirm(`Delete ${input.ids.length} picture set(s)?`))
      if (!ok) throw usageError(ctx.interactive ? 'Cancelled.' : 'Pass --yes to delete without a terminal.')
    }
    const client = await ctx.client()
    for (const id of input.ids) await client.images.delete(id)
    return { deleted: input.ids }
  },
  text: (r: { deleted: number[] }) => `Deleted ${r.deleted.map((id) => `image:${id}`).join(', ')}.`,
})

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
    const full = requireFile(input.file)
    const bytes = new Uint8Array(readFileSync(full))
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
