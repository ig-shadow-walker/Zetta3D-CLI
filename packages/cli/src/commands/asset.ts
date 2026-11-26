import { basename, resolve } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import {
  applyTextureMaps,
  assertSucceeded,
  collectMaterials,
  decodePng,
  detectFile,
  encodePng,
  extensionFor,
  fileFormat,
  formatBytes,
  fromBase64,
  glbToObj,
  glbToStl,
  parseGlb,
  resizeImage,
  resultParts,
  RIG_TYPES,
  SEGMENTED_FEATURES,
  selectResultFiles,
  TEXTURE_MAPS,
  toBase64,
  ZettaError,
  type Frame,
  type Generation,
  type GenerationStatus,
  type InlineImage,
  type ResultFile,
  type TextureMapEdit,
  type TextureMapKind,
} from '@zetta3d/sdk'
import { z } from 'zod'
import type { Context } from '../core/context'
import { defineCommand, pageShape } from '../core/define'
import { cliError, usageError } from '../core/errors'
import { downloadAsset, downloadFinished, featureLabel, summarizeAsset, waitForAsset, waitPlan, type AssetSummary, type DownloadedFile } from '../core/jobs'
import { importModel, inlinePicture, replaceLocal, requireDir, requireFile, targetPath } from '../core/local-files'
import { table } from '../core/output'

const STATUSES = ['pending', 'queued', 'processing', 'saving', 'success', 'failed', 'cancelled'] as const

/** What a library item can be (the server's `feature`), as `asset list --kind` takes it. */
export const ASSET_KINDS = [
  'img23d',
  'txt23d',
  'multiView23d',
  'retopology',
  'segmentation',
  'smartSegmentation',
  'uvUnwrap',
  'retexture',
  'autoRigging',
  'convertFormat',
  'upload',
  'imageToSplat',
  'worldSplatExport',
  'worldMeshExport',
] as const

const assetId = z.number().int().positive().describe('The asset id (shown by `zetta asset list`).')

const renderAsset = (a: AssetSummary) =>
  [
    `#${a.id} ${a.title ? `“${a.title}” ` : ''}· ${featureLabel(a.kind) ?? 'asset'}${a.engineLabel ? ` · ${a.engineLabel}` : ''}`,
    `  status:   ${a.status}${a.error ? ` — ${a.error}` : ''}`,
    a.tags.length ? `  tags:     ${a.tags.join(', ')}` : '',
    `  visible:  ${a.availability}${a.shareUrl ? ` (${a.shareUrl})` : ''}`,
    a.files.length ? `  files:    ${a.files.map((f) => f.format).join(', ')}` : '',
    `  created:  ${a.createdAt}`,
  ]
    .filter(Boolean)
    .join('\n')

interface RunGroupWire {
  runId: number
  pipelineId: number | null
  pipelineTitle: string | null
  count: number
  members?: Generation[]
}

type ListedAsset = AssetSummary & { run?: { id: number; pipelineId: number | null; pipeline: string | null; count: number; members: number[] } }

export const assetList = defineCommand({
  path: ['asset', 'list'],
  summary: 'List your 3D library (newest first).',
  description: 'Filters combine. With --group-runs, each pipeline run is one entry (its newest model) and lists the ids of every model it made.',
  kind: 'read',
  input: z.object({
    ...pageShape,
    status: z.array(z.enum(STATUSES)).optional().describe('Only these statuses (repeat for several).'),
    kind: z.enum(ASSET_KINDS).optional().describe('Only this kind: img23d, txt23d, multiView23d, retopology, segmentation, smartSegmentation, uvUnwrap, retexture, autoRigging, convertFormat, upload, imageToSplat, worldSplatExport, worldMeshExport.'),
    search: z.string().max(120).optional().describe('Search ids, titles and tags (e.g. 412 or dragon).'),
    visibility: z.enum(['public', 'private']).optional().describe('Only shared (public) or private items.'),
    groupRuns: z.boolean().optional().describe('Show each pipeline run as one entry, with the ids of the models it made.'),
    sort: z.enum(['created', 'updated']).optional().describe('Order by when items were created (default) or last changed.'),
    oldestFirst: z.boolean().optional().describe('Oldest first.'),
  }),
  examples: [
    'zetta asset list --limit 10',
    'zetta asset list --status processing --status queued',
    'zetta asset list --kind autoRigging --search dragon --json',
    'zetta asset list --group-runs --sort updated',
  ],
  async run(ctx, input) {
    const page = await (await ctx.client()).generations.list({
      page: input.page ?? 1,
      pageSize: input.limit ?? 24,
      ...(input.status?.length ? { status: input.status as GenerationStatus[] } : {}),
      ...(input.kind ? { feature: input.kind } : {}),
      ...(input.search?.trim() ? { search: input.search.trim() } : {}),
      ...(input.visibility ? { availability: input.visibility } : {}),
      ...(input.groupRuns ? { groupRuns: true } : {}),
      ...(input.sort ? { sortBy: input.sort === 'updated' ? 'updatedAt' : 'createdAt' } : {}),
      sortDir: input.oldestFirst ? 'ASC' : 'DESC',
    })
    const items = page.items.map((g): ListedAsset => {
      const summary: ListedAsset = summarizeAsset(g, ctx.profile.siteUrl)
      const group = g.runGroup as RunGroupWire | undefined
      if (group && typeof group.runId === 'number') {
        summary.run = { id: group.runId, pipelineId: group.pipelineId ?? null, pipeline: group.pipelineTitle ?? null, count: group.count, members: (group.members ?? []).map((m) => m.id) }
      }
      return summary
    })
    return { items, total: page.total, page: page.page, pageSize: page.pageSize, hasMore: page.page * page.pageSize < page.total }
  },
  text: (r: { items: ListedAsset[]; total: number; page: number; hasMore: boolean }) =>
    `${table(
      r.items.map((a) => ({
        id: a.id,
        status: a.status,
        kind: featureLabel(a.kind),
        engine: a.engineLabel,
        title: a.title,
        ...(a.run ? { run: `${a.run.pipeline ?? `run ${a.run.id}`} (${a.run.count})` } : {}),
        created: a.createdAt.slice(0, 16).replace('T', ' '),
      })),
    )}\n${r.total} item(s)${r.hasMore ? ` · next page: --page ${r.page + 1}` : ''}`,
})

export const assetGet = defineCommand({
  path: ['asset', 'get'],
  summary: 'Show one asset: status, queue position, files.',
  kind: 'read',
  positionals: [{ name: 'id', required: true }],
  input: z.object({
    id: assetId,
    public: z.boolean().optional().describe('Read a shared asset of anyone (no sign-in needed).'),
  }),
  async run(ctx, input) {
    if (input.public) return summarizeAsset(await ctx.publicClient().generations.getPublic(input.id), ctx.profile.siteUrl)
    const detail = await (await ctx.client()).generations.get(input.id)
    return { ...summarizeAsset(detail.generation, ctx.profile.siteUrl), queuePosition: detail.queuePosition }
  },
  auth: true,
  text: renderAsset,
})

export const assetWait = defineCommand({
  path: ['asset', 'wait'],
  summary: 'Wait until an asset finishes (success, failed or cancelled).',
  description:
    'Exits 0 on success, 9 if the job failed or was cancelled, 10 if --timeout passed first (the job keeps running). With the download.auto setting on (the default in a terminal), the results download into the current folder.',
  kind: 'read',
  positionals: [{ name: 'id', required: true }],
  input: z.object({
    id: assetId,
    timeout: z.string().optional().describe('Stop waiting after this long, e.g. 90s, 10m.'),
    out: z.string().optional().describe('Download the results into this folder when done.'),
    download: z.boolean().optional().describe('Download the results into the current folder (default: the download.auto setting). --no-download only waits.'),
    format: z.array(z.string()).optional().describe('When downloading: only these formats (glb, fbx, obj, usdz, …).'),
  }),
  examples: ['zetta asset wait 1234 --timeout 9m', 'zetta asset wait 1234 --out ./models --format glb'],
  async run(ctx, input) {
    const plan = waitPlan(ctx, { ...input, wait: true })
    const client = await ctx.client()
    const detail = await waitForAsset(ctx, client, input.id, plan.timeoutMs)
    assertSucceeded(detail.generation)
    const summary: AssetSummary & { saved?: DownloadedFile[]; next?: string } = summarizeAsset(detail.generation, ctx.profile.siteUrl)
    if (!plan.out) return summary
    if (!plan.auto) return { ...summary, saved: await downloadAsset(ctx, client, detail.generation, plan.out, input.format ? { formats: input.format } : {}) }
    const result = await downloadFinished(ctx, client, detail.generation, plan.out, input.format ?? plan.formats)
    return { ...summary, saved: result.files, ...(result.next ? { next: result.next } : {}) }
  },
  text: (r: AssetSummary & { saved?: Array<{ path: string }>; next?: string }) =>
    [renderAsset(r), ...(r.saved ?? []).map((f) => `  saved:    ${f.path}`), r.next ? `  next:     ${r.next}` : ''].filter(Boolean).join('\n'),
})

export const assetDownload = defineCommand({
  path: ['asset', 'download'],
  summary: 'Download an asset’s result files.',
  description: 'Without --format, every result file is downloaded. --primary keeps only the best model file (GLB, then FBX, glTF, OBJ).',
  kind: 'read',
  positionals: [{ name: 'id', required: true }],
  input: z.object({
    id: assetId,
    out: z.string().optional().describe('Folder to save into (default: the current folder, or the download.dir setting).'),
    format: z.array(z.string()).optional().describe('Only these formats, e.g. glb, fbx, obj, usdz, ply.'),
    primary: z.boolean().optional().describe('Only the single best model file.'),
    overwrite: z.boolean().optional().describe('Replace existing files instead of adding -2, -3 …'),
  }),
  examples: ['zetta asset download 1234 --out ./models', 'zetta asset download 1234 --format fbx'],
  async run(ctx, input) {
    const client = await ctx.client()
    const { generation } = await client.generations.get(input.id)
    assertSucceeded(generation)
    const files = await downloadAsset(ctx, client, generation, input.out ?? ctx.downloadDir(), {
      ...(input.format ? { formats: input.format } : {}),
      primary: Boolean(input.primary),
      overwrite: Boolean(input.overwrite),
    })
    return { id: input.id, files }
  },
  text: (r: { files: Array<{ path: string; bytes: number }> }) => r.files.map((f) => `Saved ${f.path}`).join('\n'),
})

export const assetRename = defineCommand({
  path: ['asset', 'rename'],
  summary: 'Give an asset a title.',
  kind: 'write',
  positionals: [
    { name: 'id', required: true },
    { name: 'title', required: true },
  ],
  input: z.object({ id: assetId, title: z.string().min(1).max(200).describe('The new title.') }),
  async run(ctx, input) {
    return summarizeAsset(await (await ctx.client()).generations.update(input.id, { title: input.title }), ctx.profile.siteUrl)
  },
  text: renderAsset,
})

export const assetTag = defineCommand({
  path: ['asset', 'tag'],
  summary: 'Set, add or remove an asset’s tags.',
  kind: 'write',
  positionals: [{ name: 'id', required: true }],
  input: z.object({
    id: assetId,
    set: z.array(z.string()).optional().describe('Replace all tags with these.'),
    add: z.array(z.string()).optional().describe('Add these tags.'),
    remove: z.array(z.string()).optional().describe('Remove these tags.'),
  }),
  examples: ['zetta asset tag 1234 --add chair --add wood', 'zetta asset tag 1234 --set prop,interior'],
  async run(ctx, input) {
    if (!input.set && !input.add && !input.remove) throw usageError('Give --set, --add or --remove.')
    const client = await ctx.client()
    let tags = input.set
    if (!tags) {
      const { generation } = await client.generations.get(input.id)
      const current = new Set(generation.tags ?? [])
      for (const tag of input.add ?? []) current.add(tag)
      for (const tag of input.remove ?? []) current.delete(tag)
      tags = [...current]
    }
    return summarizeAsset(await client.generations.update(input.id, { tags }), ctx.profile.siteUrl)
  },
  text: renderAsset,
})

export const assetShare = defineCommand({
  path: ['asset', 'share'],
  summary: 'Make an asset public and get its share link.',
  kind: 'write',
  positionals: [{ name: 'id', required: true }],
  input: z.object({ id: assetId }),
  async run(ctx, input) {
    return summarizeAsset(await (await ctx.client()).generations.update(input.id, { availability: 'public' }), ctx.profile.siteUrl)
  },
  text: (a: AssetSummary) => `#${a.id} is public: ${a.shareUrl ?? ''}`,
})

export const assetUnshare = defineCommand({
  path: ['asset', 'unshare'],
  summary: 'Make an asset private again (needs a paid plan).',
  kind: 'write',
  positionals: [{ name: 'id', required: true }],
  input: z.object({ id: assetId }),
  async run(ctx, input) {
    return summarizeAsset(await (await ctx.client()).generations.update(input.id, { availability: 'private' }), ctx.profile.siteUrl)
  },
  text: (a: AssetSummary) => `#${a.id} is private.`,
})

export const assetCancel = defineCommand({
  path: ['asset', 'cancel'],
  summary: 'Cancel a job that has not started yet (full refund).',
  kind: 'destructive',
  positionals: [{ name: 'id', required: true }],
  input: z.object({ id: assetId }),
  async run(ctx, input) {
    return summarizeAsset(await (await ctx.client()).generations.cancel(input.id), ctx.profile.siteUrl)
  },
  text: (a: AssetSummary) => `#${a.id} is ${a.status}.`,
})

export const assetDelete = defineCommand({
  path: ['asset', 'delete'],
  summary: 'Delete assets and their files.',
  description: 'A job that is still running is not refunded. In a terminal you are asked first; otherwise pass --yes.',
  kind: 'destructive',
  positionals: [{ name: 'ids', required: true, variadic: true }],
  input: z.object({
    ids: z.array(z.number().int().positive()).min(1).describe('Asset ids.'),
    yes: z.boolean().optional().describe('Delete without asking.'),
  }),
  async run(ctx, input) {
    const ids = [...new Set(input.ids)]
    if (!input.yes) {
      const ok = ctx.interactive && (await ctx.confirm(`Delete ${ids.length} asset(s) (${ids.map((id) => `#${id}`).join(', ')})?`))
      if (!ok) throw usageError(ctx.interactive ? 'Cancelled; nothing was deleted.' : 'Pass --yes to delete without a terminal.')
    }
    const client = await ctx.client()
    const deleted: number[] = []
    const failed: Array<{ id: number; error: string }> = []
    for (const id of ids) {
      try {
        await client.generations.delete(id)
        deleted.push(id)
      } catch (error) {
        failed.push({ id, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return { deleted, failed, ...(failed.length ? { exitCode: 1 } : {}) }
  },
  text: (r: { deleted: number[]; failed: Array<{ id: number; error: string }> }) =>
    [r.deleted.length ? `Deleted ${r.deleted.map((id) => `#${id}`).join(', ')}.` : '', ...r.failed.map((f) => `Could not delete #${f.id}: ${f.error}`)].filter(Boolean).join('\n'),
})

export const assetImport = defineCommand({
  path: ['asset', 'import'],
  summary: 'Upload your own 3D model into the library (free): GLB, glTF, FBX, OBJ, STL, PLY, DAE, 3DS, 3MF, AMF, USD/USDZ, VRML, LWO, KMZ or a zip.',
  description:
    'One file is stored exactly as it is; nothing is converted. Several files, or a folder (an OBJ with its .mtl and textures, a glTF with its .bin and images), are stored together as one zip, as the Studio does. Up to 512 MB. When several models are given, the most complete format is the model (GLB, then glTF, FBX, OBJ …).',
  kind: 'write',
  positionals: [{ name: 'files', required: true, variadic: true }],
  input: z.object({
    files: z.array(z.string()).min(1).describe('The model file; or the model and its companion files; or a folder; or a .zip of them.'),
    title: z.string().max(120).optional().describe('Title in the library (default: the model\'s file name).'),
    source: z.number().int().positive().optional().describe('The library asset this model was made from, recorded with it.'),
    rigged: z.boolean().optional().describe('It is a rig you made yourself from --source: filed as a rig rather than an upload.'),
  }),
  examples: ['zetta asset import ./chair.glb --title "Lounge chair"', 'zetta asset import ./chair.obj ./chair.mtl ./wood.png', 'zetta asset import ./chair-folder/', 'zetta asset import ./model.fbx --json'],
  async run(ctx, input) {
    if (input.rigged && !input.source) throw usageError('--rigged needs --source <id>: the asset the rig was made from.')
    const client = await ctx.client()
    const { generation, prepared } = await importModel(ctx, client, input.files, {
      ...(input.title ? { title: input.title } : {}),
      feature: input.rigged ? 'autoRigging' : 'upload',
      ...(input.source ? { sourcePostId: input.source } : {}),
    })
    return {
      ...summarizeAsset(generation, ctx.profile.siteUrl),
      imported: { model: prepared.main, format: prepared.extension, files: prepared.files, zipped: prepared.zipped, bytes: prepared.blob.size },
    }
  },
  text: (a: AssetSummary & { imported: { model: string; files: number; zipped: boolean; bytes: number } }) =>
    `Imported ${a.imported.model}${a.imported.zipped ? ` with ${a.imported.files - 1} other file(s), as one zip` : ''} (${formatBytes(a.imported.bytes)}) as #${a.id}.`,
})

export const assetReplace = defineCommand({
  path: ['asset', 'replace'],
  summary: 'Save a model file over an asset’s stored GLB or FBX (the Studio’s Save).',
  description:
    'Overwrites the stored file in place: the asset keeps its id, title and share link, and the old file cannot be got back. In a terminal you are asked first; otherwise pass --yes. A segmented asset needs --part (1 = the first part). The format follows your file; --format fbx replaces the asset’s one FBX (a rig, a retopology).',
  kind: 'destructive',
  positionals: [
    { name: 'id', required: true },
    { name: 'file', required: true },
  ],
  input: z.object({
    id: assetId,
    file: z.string().describe('The new model: a .glb (or .fbx) file, up to 512 MB.'),
    part: z.number().int().min(1).optional().describe('For a segmented asset: which part to replace (1 = the first).'),
    format: z.enum(['glb', 'fbx']).optional().describe('Which stored file to replace: glb (default) or fbx. Must match the file.'),
    yes: z.boolean().optional().describe('Replace without asking.'),
  }),
  examples: ['zetta asset replace 1234 ./chair-fixed.glb', 'zetta asset replace 1240 ./part-2.glb --part 2 --yes', 'zetta asset replace 1250 ./rig.fbx --format fbx --yes'],
  async run(ctx, input) {
    if (!input.yes) {
      const what = `#${input.id}${input.part !== undefined ? ` part ${input.part}` : ''}`
      const ok = ctx.interactive && (await ctx.confirm(`Replace ${what}'s model with ${basename(input.file)}? The old file cannot be got back.`))
      if (!ok) throw usageError(ctx.interactive ? 'Cancelled; nothing was replaced.' : 'Pass --yes to replace without a terminal.')
    }
    const client = await ctx.client()
    const saved = await replaceLocal(ctx, client, input.id, input.file, {
      ...(input.part !== undefined ? { part: input.part } : {}),
      ...(input.format ? { format: input.format } : {}),
    })
    return { id: input.id, ...(input.part !== undefined ? { part: input.part } : {}), format: saved.format, key: saved.key, bytes: saved.bytes }
  },
  text: (r: { id: number; part?: number; format: string; bytes: number }) => `Saved over #${r.id}${r.part !== undefined ? ` part ${r.part}` : ''} (${r.format.toUpperCase()}, ${formatBytes(r.bytes)}).`,
})

/** The AI routes take frames of at most 4 MiB of base64 each. */
const MAX_FRAME_BASE64 = 4 * 1024 * 1024

async function framesFor(ctx: Context, id: number, frameFiles: string[] | undefined): Promise<Frame[]> {
  if (frameFiles?.length) {
    if (frameFiles.length > 4) throw usageError('Give at most 4 --frame pictures.')
    return frameFiles.map((file) => {
      const inline = inlinePicture(file)
      if (inline.data.length > MAX_FRAME_BASE64) throw cliError('FILE_TOO_LARGE', `${basename(file)} is too large to look at; each picture must be under 3 MB.`)
      return { data: inline.data, mediaType: inline.contentType }
    })
  }
  const { generation } = await (await ctx.client()).generations.get(id)
  const url = generation.thumbnailURL
  if (!url) throw usageError(`#${id} has no thumbnail to look at. Render 1–4 pictures of the model and pass them with --frame.`)
  const response = await fetch(url)
  if (!response.ok) throw usageError(`Could not fetch #${id}'s thumbnail. Pass pictures with --frame instead.`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const info = detectFile(bytes)
  const data = toBase64(bytes)
  if (data.length > MAX_FRAME_BASE64) throw usageError(`#${id}'s thumbnail is too large to send. Pass 1–4 smaller pictures with --frame.`)
  return [{ data, mediaType: info?.contentType ?? 'image/png' }]
}

export const assetAutoTag = defineCommand({
  path: ['asset', 'auto-tag'],
  summary: 'Suggest a category and tags for an asset with AI (paid plans; uses AI tokens).',
  description: 'Looks at the asset’s thumbnail, or at up to 4 pictures you pass with --frame. Add --apply to save the tags.',
  kind: 'write',
  positionals: [{ name: 'id', required: true }],
  input: z.object({
    id: assetId,
    frame: z.array(z.string()).optional().describe('Pictures of the model (1–4) to look at instead of the thumbnail.'),
    apply: z.boolean().optional().describe('Save the suggested tags on the asset.'),
  }),
  async run(ctx, input) {
    const client = await ctx.client()
    const frames = await framesFor(ctx, input.id, input.frame)
    const result = await client.tools.tags({ frames })
    if (input.apply) await client.generations.update(input.id, { tags: result.tags })
    return { id: input.id, category: result.category, tags: result.tags, applied: Boolean(input.apply), aiTokensCharged: result.tokens }
  },
  text: (r: { category: string; tags: string[]; applied: boolean }) => `${r.category}: ${r.tags.join(', ')}${r.applied ? ' (saved)' : ''}`,
})

export const assetRigCheck = defineCommand({
  path: ['asset', 'rig-check'],
  summary: 'Guess which skeleton an asset needs before rigging it (paid plans).',
  description: 'Looks at the asset’s thumbnail, or at 1–4 pictures of it from different angles that you pass with --frame (the Studio sends up to 4). Answers biped, quadruped, hexapod, octopod, avian, serpentine, aquatic, others, or unknown.',
  kind: 'read',
  positionals: [{ name: 'id', required: true }],
  input: z.object({
    id: assetId,
    frame: z.array(z.string()).optional().describe('1–4 pictures of the model (front, side, back …; PNG, JPEG or WebP under 3 MB each) instead of the thumbnail.'),
  }),
  examples: ['zetta asset rig-check 1234', 'zetta asset rig-check 1234 --frame front.png --frame side.png --frame back.png --frame top.png'],
  async run(ctx, input) {
    const frames = await framesFor(ctx, input.id, input.frame)
    const result = await (await ctx.client()).tools.riggingPrecheck({ frames })
    const rigType = (RIG_TYPES as readonly string[]).includes(result.bodyType)
    return { id: input.id, ...result, frames: frames.length, next: rigType ? `zetta refine rig ${input.id} --rig-type ${result.bodyType}` : `zetta refine rig ${input.id} --rig-type <type>` }
  },
  text: (r: { bodyType: string; confidence: string; reason: string; next: string }) => `${r.bodyType} (${r.confidence} confidence): ${r.reason}\nnext: ${r.next}`,
})

const MAP_NAMES: Record<TextureMapKind, string> = { normal: 'normal', roughness: 'roughness', metalness: 'metalness', emissive: 'emissive', ao: 'ambient occlusion' }

/** The image routes take at most 10,000,000 characters of base64 per picture. */
const MAX_PICTURE_BASE64 = 10_000_000

interface TextureSource {
  /** Material names sharing this texture, for file names and messages. */
  label: string
  /** Material indexes in the GLB (empty for a picture given directly). */
  materials: number[]
  texture: { bytes: Uint8Array; mimeType: string; width?: number; height?: number }
}

interface MadeMap {
  map: TextureMapKind
  material: string
  imageId: number | null
  path: string
  bytes: number
  contentType: string
}

/**
 * The picture the Studio sends for a texture: its own bytes, or, for a PNG over 1024 px, a
 * 1024×1024 copy (the model reads material and shape fine at 1K; the map is still asked for at
 * the source's full size).
 */
async function texturePicture(texture: TextureSource['texture']): Promise<{ image: InlineImage; longestEdge: number }> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(texture.mimeType)) {
    throw cliError('UNSUPPORTED_FILE_TYPE', `The base-colour texture is ${texture.mimeType}; maps can be made from PNG, JPEG or WebP textures only.`)
  }
  const longestEdge = Math.max(texture.width ?? 1024, texture.height ?? 1024)
  let bytes = texture.bytes
  if (texture.mimeType === 'image/png' && longestEdge > 1024) bytes = await encodePng(resizeImage(await decodePng(bytes), 1024, 1024))
  const data = toBase64(bytes)
  if (data.length > MAX_PICTURE_BASE64) {
    throw cliError('FILE_TOO_LARGE', `The base-colour texture is ${formatBytes(bytes.length)}, more than the image service takes (about 7 MB). Save it smaller and pass the picture itself.`)
  }
  return { image: { data, contentType: texture.mimeType }, longestEdge }
}

const fileSafe = (text: string) => text.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'material'

export const assetTextureMap = defineCommand({
  path: ['asset', 'texture-map'],
  summary: 'Make PBR maps (normal, roughness, metalness, emissive, AO) from a model’s base-colour texture with AI (paid plans).',
  description:
    'What the Studio’s inspector does: each map is an AI image edit of the material’s base-colour texture, square, at the texture’s own size (1K, 2K or 4K). The maps are saved as pictures (and kept in your image library). --apply also puts them on the model and saves it: over the library asset’s GLB (cannot be undone), or as <name>-maps.glb for a local file. Roughness and metalness share one packed texture in a GLB.',
  kind: 'write',
  positionals: [{ name: 'source', required: true }],
  input: z.object({
    source: z.string().describe('An asset id, a local .glb file, or a base-colour picture (PNG, JPEG or WebP).'),
    map: z.array(z.enum(TEXTURE_MAPS)).min(1).describe('Which map(s): normal, roughness, metalness, emissive or ao. Repeat, or separate with commas.'),
    material: z.string().optional().describe('Only this material: its number (from 0) or its name. Default: every material with a base-colour texture.'),
    part: z.number().int().min(1).optional().describe('For a segmented asset: which part (1 = the first).'),
    out: z.string().optional().describe('Folder to save the maps into (default: the current folder, or the download.dir setting).'),
    apply: z.boolean().optional().describe('Also put the maps on the model and save it (over the asset’s GLB, or as <name>-maps.glb).'),
  }),
  examples: [
    'zetta asset texture-map 1234 --map normal --out ./maps',
    'zetta asset texture-map 1234 --map roughness,metalness --apply',
    'zetta asset texture-map ./chair.glb --map normal --map ao --apply --out ./out',
    'zetta asset texture-map ./albedo.png --map normal',
  ],
  async run(ctx, input) {
    const client = await ctx.client()
    const maps = [...new Set(input.map)]
    let glbBytes: Uint8Array | undefined
    let stem: string
    let target: { id: number; part?: number; key: string } | { path: string } | undefined
    let picture: TextureSource['texture'] | undefined

    if (/^\d+$/.test(input.source)) {
      const id = Number(input.source)
      const { generation } = await client.generations.get(id)
      assertSucceeded(generation)
      const segmented = SEGMENTED_FEATURES.includes(generation.selectedFeature)
      let file: ResultFile | undefined
      if (segmented) {
        const parts = resultParts(generation)
        if (input.part === undefined) throw usageError(`#${id} is in ${parts.length} parts; say which with --part (1–${parts.length}).`)
        file = parts[input.part - 1]
        if (!file) throw usageError(`#${id} has no part ${input.part}; it has ${parts.length}.`)
      } else {
        if (input.part !== undefined) throw usageError(`#${id} is one model, not parts; leave out --part.`)
        file = selectResultFiles(generation, { formats: ['glb'], primary: true })[0]
      }
      if (!file) {
        const has = [...new Set((generation.result?.files ?? []).map(fileFormat))].join(', ')
        throw usageError(`#${id} has no GLB to read textures from (it has: ${has || 'nothing'}).`)
      }
      ctx.out.progress({ stage: 'download', message: `Fetching #${id}…` })
      const link = await client.generations.downloadLink(id, file.key)
      const response = await fetch(link.url, ctx.signal ? { signal: ctx.signal } : {})
      if (!response.ok) throw cliError('DOWNLOAD_FAILED', `Could not fetch #${id} (${response.status}).`)
      glbBytes = new Uint8Array(await response.arrayBuffer())
      stem = `${id}${segmented ? `-part${input.part}` : ''}`
      target = { id, ...(segmented ? { part: input.part! } : {}), key: file.key }
    } else {
      const full = requireFile(resolve(ctx.cwd, input.source))
      const bytes = new Uint8Array(readFileSync(full))
      const info = detectFile(bytes, full)
      stem = basename(full).replace(/\.[^.]+$/, '')
      if (input.part !== undefined) throw usageError('--part is for segmented library assets.')
      if (info?.contentType === 'model/gltf-binary') {
        glbBytes = bytes
        target = { path: full }
      } else if (info?.kind === 'image') {
        picture = { bytes, mimeType: info.contentType, ...(info.width ? { width: info.width } : {}), ...(info.height ? { height: info.height } : {}) }
      } else throw cliError('UNSUPPORTED_FILE_TYPE', `${basename(full)} is not a GLB or a PNG, JPEG or WebP picture.`)
    }
    if (input.apply && !glbBytes) throw usageError('--apply needs a model (an asset id or a .glb); a picture has nothing to put the maps on.')
    if (input.material !== undefined && !glbBytes) throw usageError('--material is for a model, not a picture.')

    let sources: TextureSource[]
    if (glbBytes) {
      let materials = collectMaterials(parseGlb(glbBytes, { geometry: false }))
      if (input.material !== undefined) {
        const wanted = input.material.trim()
        const chosen = materials.filter((m) => (/^\d+$/.test(wanted) ? m.index === Number(wanted) : m.name.toLowerCase() === wanted.toLowerCase()))
        if (!chosen.length) throw usageError(`There is no material "${wanted}". Materials: ${materials.map((m) => `${m.index} ${m.name}`).join(', ') || 'none'}.`)
        materials = chosen
      }
      const byImage = new Map<number, TextureSource>()
      for (const material of materials) {
        if (!material.texture) continue
        const known = byImage.get(material.texture.image)
        if (known) {
          known.materials.push(material.index)
          known.label += `+${material.name}`
        } else byImage.set(material.texture.image, { label: material.name, materials: [material.index], texture: material.texture })
      }
      sources = [...byImage.values()]
      if (!sources.length) throw usageError('The model has no base-colour texture to make maps from. Texture it first (`zetta refine texture`), or pass a picture.')
    } else sources = [{ label: stem, materials: [], texture: picture! }]

    const dir = requireDir(input.out ? resolve(ctx.cwd, input.out) : ctx.downloadDir())
    const made: MadeMap[] = []
    const failed: Array<{ map: TextureMapKind; material: string; error: string }> = []
    const edits: TextureMapEdit[] = []
    let firstError: unknown
    for (const source of sources) {
      const { image, longestEdge } = await texturePicture(source.texture)
      for (const map of maps) {
        const about = sources.length > 1 ? ` for ${source.label}` : ''
        ctx.out.progress({ stage: 'generate', message: `Making the ${MAP_NAMES[map]} map${about}…` })
        try {
          const result = await client.images.textureMap(map, image, longestEdge, crypto.randomUUID())
          const first = result.images[0]
          if (!first) throw cliError('IMAGE_GEN_NO_IMAGE', `No ${MAP_NAMES[map]} map came back.`)
          const bytes = fromBase64(first.base64)
          const name = `${stem}${sources.length > 1 ? `-${fileSafe(source.label)}` : ''}-${map}.${extensionFor(first.contentType)}`
          const path = targetPath(dir, name)
          writeFileSync(path, bytes)
          ctx.out.progress({ stage: 'save', message: `Saved ${path}`, path })
          made.push({ map, material: source.label, imageId: result.postId ?? null, path, bytes: bytes.length, contentType: first.contentType })
          for (const material of source.materials) edits.push({ material, map, image: { bytes, mimeType: first.contentType } })
        } catch (error) {
          // A plan or sign-in refusal applies to every map; anything else is this map's alone.
          if (error instanceof ZettaError && (error.status === 401 || error.status === 403)) throw error
          firstError ??= error
          failed.push({ map, material: source.label, error: error instanceof Error ? error.message : String(error) })
        }
      }
    }
    if (!made.length) throw firstError

    let applied: { id?: number; part?: number; key?: string; path?: string; bytes: number; notes: string[] } | undefined
    if (input.apply && glbBytes && target && edits.length) {
      ctx.out.progress({ stage: 'apply', message: 'Putting the maps on the model…' })
      const out = await applyTextureMaps(glbBytes, edits)
      if ('id' in target) {
        const saved = await replaceLocal(ctx, client, target.id, { bytes: out.glb, name: `#${target.id}` }, { format: 'glb', expectedKey: target.key, ...(target.part ? { part: target.part } : {}) })
        applied = { id: target.id, ...(target.part ? { part: target.part } : {}), key: saved.key, bytes: saved.bytes, notes: out.notes }
      } else {
        const path = targetPath(dir, `${stem}-maps.glb`)
        writeFileSync(path, out.glb)
        applied = { path, bytes: out.glb.length, notes: out.notes }
      }
    }
    return { maps: made, ...(applied ? { applied } : {}), ...(failed.length ? { failed, exitCode: 1 } : {}) }
  },
  text: (r: { maps: MadeMap[]; applied?: { id?: number; part?: number; path?: string; notes: string[] }; failed?: Array<{ map: string; material: string; error: string }> }) =>
    [
      ...r.maps.map((m) => `Saved ${m.path}${m.imageId ? ` (image:${m.imageId})` : ''}`),
      r.applied?.id !== undefined ? `Applied the maps and saved #${r.applied.id}${r.applied.part ? ` part ${r.applied.part}` : ''}.` : r.applied?.path ? `Applied the maps: ${r.applied.path}` : '',
      ...(r.applied?.notes ?? []).map((n) => `  note: ${n}`),
      ...(r.failed ?? []).map((f) => `Could not make the ${f.map} map for ${f.material}: ${f.error}`),
    ]
      .filter(Boolean)
      .join('\n'),
})

export const assetFeatured = defineCommand({
  path: ['asset', 'featured'],
  summary: 'Featured public assets from the community.',
  kind: 'read',
  auth: false,
  input: z.object({ limit: z.number().int().min(1).max(50).optional().describe('How many.') }),
  async run(ctx, input) {
    const items = await ctx.publicClient().generations.featured(input.limit)
    return { items: items.map((g) => summarizeAsset(g, ctx.profile.siteUrl)) }
  },
  text: (r: { items: AssetSummary[] }) => table(r.items.map((a) => ({ id: a.id, title: a.title, kind: featureLabel(a.kind), link: a.shareUrl }))),
})

export const assetExport = defineCommand({
  path: ['asset', 'export'],
  summary: 'Convert a GLB to OBJ, FBX (both with materials and textures) or STL, locally and for free.',
  description: 'Works on a library asset or a local .glb file. For USDZ, 3MF or clean-up options, use `zetta refine convert` (server-side). Compressed geometry is refused here; convert those on the server.',
  kind: 'read',
  positionals: [{ name: 'source', required: true }],
  input: z.object({
    source: z.string().describe('An asset id, or a local .glb file.'),
    format: z.enum(['obj', 'fbx', 'stl']).describe('Target format.'),
    fbxPreset: z.enum(['unity', 'unreal', 'blender', 'maya', 'threejs']).optional().describe('With --format fbx: axes and units for this app (default unity).'),
    out: z.string().optional().describe('Folder to save into (default: the current folder, or the download.dir setting).'),
  }),
  examples: ['zetta asset export 1234 --format stl --out ./print', 'zetta asset export ./chair.glb --format obj', 'zetta asset export 1234 --format fbx --fbx-preset blender'],
  async run(ctx, input) {
    let data: Uint8Array
    let base: string
    if (/^\d+$/.test(input.source)) {
      const id = Number(input.source)
      const client = await ctx.client()
      const { generation } = await client.generations.get(id)
      assertSucceeded(generation)
      const glb = selectResultFiles(generation, { formats: ['glb'], primary: true })[0]
      if (!glb) {
        const has = [...new Set((generation.result?.files ?? []).map(fileFormat))].join(', ')
        throw usageError(`#${id} has no GLB to convert (it has: ${has || 'nothing'}). Try \`zetta refine convert ${id}\`.`)
      }
      ctx.out.progress({ stage: 'download', message: `Fetching #${id}…` })
      const link = await client.generations.downloadLink(id, glb.key)
      const response = await fetch(link.url)
      if (!response.ok) throw usageError(`Could not fetch #${id} (${response.status}).`)
      data = new Uint8Array(await response.arrayBuffer())
      base = `${id}-${(glb.key.split('/').pop() ?? 'model').replace(/\.glb$/i, '')}`
    } else {
      const full = requireFile(input.source)
      data = new Uint8Array(readFileSync(full))
      base = basename(full).replace(/\.glb$/i, '')
    }
    ctx.out.progress({ stage: 'convert', message: `Converting to ${input.format.toUpperCase()}…` })
    const files =
      input.format === 'obj'
        ? glbToObj(data, base)
        : input.format === 'stl'
          ? glbToStl(data, base)
          : await (await import('../export/fbx')).glbToFbx(data, base, input.fbxPreset ?? 'unity')
    const dir = requireDir(input.out ? resolve(ctx.cwd, input.out) : ctx.downloadDir())
    const saved = files.map((file) => {
      const path = targetPath(dir, file.name, true)
      writeFileSync(path, file.bytes)
      return { path, bytes: file.bytes.length }
    })
    return { format: input.format, files: saved }
  },
  text: (r: { files: Array<{ path: string }> }) => r.files.map((f) => `Saved ${f.path}`).join('\n'),
})

export const assetCommands = [
  assetExport,
  assetList,
  assetGet,
  assetWait,
  assetDownload,
  assetRename,
  assetTag,
  assetShare,
  assetUnshare,
  assetCancel,
  assetDelete,
  assetImport,
  assetReplace,
  assetAutoTag,
  assetRigCheck,
  assetTextureMap,
  assetFeatured,
]
