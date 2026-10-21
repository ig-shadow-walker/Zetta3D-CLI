import { basename, resolve } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { assertSucceeded, detectFile, fileFormat, glbToObj, glbToStl, selectResultFiles, toBase64, type Frame, type GenerationStatus } from '@zetta3d/sdk'
import { z } from 'zod'
import { defineCommand, pageShape } from '../core/define'
import { usageError } from '../core/errors'
import { downloadAsset, downloadFinished, featureLabel, summarizeAsset, waitForAsset, waitPlan, type AssetSummary, type DownloadedFile } from '../core/jobs'
import { inlinePicture, requireDir, requireFile, targetPath, uploadLocal } from '../core/local-files'
import { table } from '../core/output'

const STATUSES = ['pending', 'queued', 'processing', 'saving', 'success', 'failed', 'cancelled'] as const

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

export const assetList = defineCommand({
  path: ['asset', 'list'],
  summary: 'List your 3D library (newest first).',
  kind: 'read',
  input: z.object({
    ...pageShape,
    status: z.array(z.enum(STATUSES)).optional().describe('Only these statuses.'),
    kind: z.string().optional().describe('Only this kind, e.g. img23d, txt23d, retopology, autoRigging, imageToSplat.'),
    search: z.string().optional().describe('Search titles, tags and prompts.'),
    visibility: z.enum(['public', 'private']).optional().describe('Only shared (public) or private items.'),
    oldestFirst: z.boolean().optional().describe('Oldest first.'),
  }),
  examples: ['zetta asset list --limit 10', 'zetta asset list --status processing --status queued', 'zetta asset list --search chair --json'],
  async run(ctx, input) {
    const page = await (await ctx.client()).generations.list({
      page: input.page ?? 1,
      pageSize: input.limit ?? 24,
      ...(input.status?.length ? { status: input.status as GenerationStatus[] } : {}),
      ...(input.kind ? { feature: input.kind } : {}),
      ...(input.search ? { search: input.search } : {}),
      ...(input.visibility ? { availability: input.visibility } : {}),
      sortDir: input.oldestFirst ? 'ASC' : 'DESC',
    })
    return {
      items: page.items.map((g) => summarizeAsset(g, ctx.profile.siteUrl)),
      total: page.total,
      page: page.page,
      pageSize: page.pageSize,
      hasMore: page.page * page.pageSize < page.total,
    }
  },
  text: (r: { items: AssetSummary[]; total: number; page: number; hasMore: boolean }) =>
    `${table(
      r.items.map((a) => ({ id: a.id, status: a.status, kind: featureLabel(a.kind), engine: a.engineLabel, title: a.title, created: a.createdAt.slice(0, 16).replace('T', ' ') })),
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
    if (!input.yes) {
      const ok = ctx.interactive && (await ctx.confirm(`Delete ${input.ids.length} asset(s) (${input.ids.map((id) => `#${id}`).join(', ')})?`))
      if (!ok) throw usageError(ctx.interactive ? 'Cancelled; nothing was deleted.' : 'Pass --yes to delete without a terminal.')
    }
    const client = await ctx.client()
    const deleted: number[] = []
    const failed: Array<{ id: number; error: string }> = []
    for (const id of input.ids) {
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
  summary: 'Upload your own GLB model into the library (free).',
  description: 'The imported model can then go through any finishing tool: `zetta refine retopo <id>` …',
  kind: 'write',
  positionals: [{ name: 'file', required: true }],
  input: z.object({
    file: z.string().describe('A .glb file.'),
    title: z.string().max(200).optional().describe('Title in the library (default: the file name).'),
  }),
  async run(ctx, input) {
    const client = await ctx.client()
    const uploaded = await uploadLocal(ctx, client, input.file, 'model')
    const generation = await client.uploads.register({ key: uploaded.key, bytes: uploaded.bytes, title: input.title ?? basename(input.file).replace(/\.glb$/i, ''), feature: 'upload' })
    return summarizeAsset(generation, ctx.profile.siteUrl)
  },
  text: (a: AssetSummary) => `Imported as #${a.id}.`,
})

async function framesFor(ctx: Parameters<typeof assetGet.run>[0], id: number, frameFiles: string[] | undefined): Promise<Frame[]> {
  if (frameFiles?.length) {
    if (frameFiles.length > 4) throw usageError('Give at most 4 --frame pictures.')
    return frameFiles.map((file) => {
      const inline = inlinePicture(file)
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
  return [{ data: toBase64(bytes), mediaType: info?.contentType ?? 'image/png' }]
}

export const assetAutoTag = defineCommand({
  path: ['asset', 'auto-tag'],
  summary: 'Suggest a category and tags for an asset with AI (uses AI tokens).',
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
  summary: 'Guess which skeleton an asset needs before rigging it.',
  kind: 'read',
  positionals: [{ name: 'id', required: true }],
  input: z.object({
    id: assetId,
    frame: z.array(z.string()).optional().describe('Pictures of the model (1–4) instead of the thumbnail.'),
  }),
  async run(ctx, input) {
    const frames = await framesFor(ctx, input.id, input.frame)
    const result = await (await ctx.client()).tools.riggingPrecheck({ frames })
    return { id: input.id, ...result, next: `zetta refine rig ${input.id} --rig-type ${result.bodyType}` }
  },
  text: (r: { bodyType: string; confidence: string; reason: string; next: string }) => `${r.bodyType} (${r.confidence} confidence): ${r.reason}\nnext: ${r.next}`,
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
  assetAutoTag,
  assetRigCheck,
  assetFeatured,
]
