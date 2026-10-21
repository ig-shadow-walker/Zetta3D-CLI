import {
  assertSucceeded,
  fileFormat,
  selectResultFiles,
  ZettaError,
  type Generation,
  type GenerationDetail,
  type Quote,
  type QuoteRequest,
  type ZettaClient,
} from '@zetta3d/sdk'
import type { Context } from './context'
import { parseDuration } from './define'
import { usageError } from './errors'
import { downloadTo, requireDir, targetPath } from './local-files'
import { authorizeSpend, refundBudget, type SpendFlags } from './spend'

const ENGINE_LABELS: Record<string, string> = {
  n1: 'Zetta N1',
  n2: 'Zetta N2',
  n25: 'Zetta N2.5',
  np1: 'Zetta Np1',
  np15: 'Zetta Np1.5',
  r1: 'Zetta R1',
  zs2: 'Zetta Splat 2',
  zs21: 'Zetta Splat 2.1',
}

const FEATURE_LABELS: Record<string, string> = {
  img23d: 'image to 3D',
  txt23d: 'text to 3D',
  multiView23d: 'multi-view to 3D',
  retopology: 'retopology',
  segmentation: 'segmentation',
  smartSegmentation: 'smart segmentation',
  uvUnwrap: 'Smart UV',
  retexture: 'texturing',
  autoRigging: 'auto rig',
  convertFormat: 'format conversion',
  upload: 'upload',
  imageToSplat: 'splat',
  worldSplatExport: 'world splat export',
  worldMeshExport: 'world mesh export',
  worldColliderExport: 'world collider export',
}

export function engineLabel(id: string | null | undefined): string | null {
  if (!id) return null
  return ENGINE_LABELS[id] ?? id
}

export function featureLabel(code: string | null | undefined): string | null {
  if (!code) return null
  return FEATURE_LABELS[code] ?? code
}

export interface AssetSummary {
  id: number
  status: string
  kind: string | null
  engine: string | null
  engineLabel: string | null
  title: string | null
  tags: string[]
  availability: string
  prompt: string | null
  error: string | null
  files: Array<{ key: string; format: string; bytes: number | null; label: string | null }>
  thumbnailUrl: string | null
  pipelineRunId: number | null
  createdAt: string
  updatedAt: string
  shareUrl?: string
}

/** The stable, compact shape of an asset that commands print and agents read. */
export function summarizeAsset(generation: Generation, siteUrl?: string): AssetSummary {
  const summary: AssetSummary = {
    id: generation.id,
    status: generation.status,
    kind: generation.selectedFeature ?? null,
    engine: generation.selectedModel ?? null,
    engineLabel: engineLabel(generation.selectedModel),
    title: generation.title ?? null,
    tags: generation.tags ?? [],
    availability: generation.availability,
    prompt: generation.inputPrompt ?? null,
    error: generation.errorMessage ?? null,
    files: (generation.result?.files ?? []).map((file) => ({
      key: file.key,
      format: fileFormat(file),
      bytes: file.bytes ?? null,
      label: file.label ?? null,
    })),
    thumbnailUrl: generation.thumbnailURL ?? null,
    pipelineRunId: generation.pipelineRunId ?? null,
    createdAt: generation.createdAt,
    updatedAt: generation.updatedAt,
  }
  if (siteUrl && generation.availability === 'public') summary.shareUrl = new URL(`/view/${generation.id}`, siteUrl).toString()
  return summary
}

export interface WaitFlags {
  wait?: boolean
  timeout?: string
  out?: string
}

export interface DownloadedFile {
  path: string
  format: string
  bytes: number
  key: string
}

export interface JobOutcome {
  id: number
  status: string
  credits: number
  charged: boolean
  queuePosition?: number | null
  asset: AssetSummary
  files?: DownloadedFile[]
  next?: string
}

export interface DryRunOutcome {
  dryRun: true
  credits: number
  lines: Quote['lines']
  request: Record<string, unknown>
}

/** Resolves --wait/--timeout/--out (and the configured default) into one decision. */
export function waitPlan(ctx: Context, flags: WaitFlags): { wait: boolean; timeoutMs: number | undefined; out: string | undefined } {
  const timeoutMs = parseDuration(flags.timeout)
  if (Number.isNaN(timeoutMs)) throw usageError(`--timeout "${flags.timeout}" is not a duration (try 90s, 10m or 1h).`)
  const wait = Boolean(flags.out) || (flags.wait ?? ctx.config.file.defaults?.wait ?? false)
  return { wait, timeoutMs, out: flags.out }
}

/**
 * The shared path of every paid 3D job: quote → spend guard → create → (wait → download).
 */
export async function runPaidJob(
  ctx: Context,
  client: ZettaClient,
  job: {
    what: string
    request: Record<string, unknown>
    quote: QuoteRequest
    flags: SpendFlags & WaitFlags & { idempotencyKey?: string }
    formats?: string[]
    /** Runs after the spend is approved and before submitting: uploads, picture generation. Returns the final request. */
    prepare?: () => Promise<Record<string, unknown>>
  },
): Promise<JobOutcome | DryRunOutcome> {
  const plan = waitPlan(ctx, job.flags)
  ctx.out.progress({ stage: 'quote', message: 'Checking the price…' })
  const quote = await client.catalog.quote(job.quote)
  const decision = await authorizeSpend(ctx, quote, job.flags, job.what)
  if (!decision.go) return { dryRun: true, credits: quote.credits, lines: quote.lines, request: job.request }

  let created
  try {
    const request = job.prepare ? await job.prepare() : job.request
    ctx.out.progress({ stage: 'submit', message: `Starting ${job.what}…` })
    created = await client.generations.create(request, job.flags.idempotencyKey)
  } catch (error) {
    refundBudget(ctx, quote.credits)
    throw error
  }
  if (!created.charged) refundBudget(ctx, quote.credits)
  if (created.charged && created.quote.credits > quote.credits) {
    ctx.out.warn(`The job was charged ${created.quote.credits} credits; the quote said ${quote.credits}.`)
  }

  let detail: GenerationDetail = { generation: created.generation, queuePosition: null }
  if (plan.wait) detail = await waitForAsset(ctx, client, created.generation.id, plan.timeoutMs)

  const outcome: JobOutcome = {
    id: detail.generation.id,
    status: detail.generation.status,
    credits: created.quote.credits,
    charged: created.charged,
    queuePosition: detail.queuePosition,
    asset: summarizeAsset(detail.generation, ctx.profile.siteUrl),
  }
  if (!plan.wait) {
    outcome.next = `zetta asset wait ${outcome.id}`
    return outcome
  }
  assertSucceeded(detail.generation)
  if (plan.out) outcome.files = await downloadAsset(ctx, client, detail.generation, plan.out, { formats: job.formats })
  return outcome
}

/** Waits for an asset with progress events; throws WAIT_TIMEOUT (job untouched) when time runs out. */
export async function waitForAsset(ctx: Context, client: ZettaClient, id: number, timeoutMs: number | undefined): Promise<GenerationDetail> {
  let last = ''
  return client.generations.wait(id, {
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    onUpdate: ({ generation, queuePosition }) => {
      const key = `${generation.status}:${queuePosition ?? ''}`
      if (key === last) return
      last = key
      const position = queuePosition ? ` (position ${queuePosition} in the queue)` : ''
      ctx.out.progress({ stage: 'wait', message: `#${id} is ${generation.status}${position}`, id, status: generation.status, queuePosition })
    },
  })
}

/** Downloads an asset's result files into `dir` with fresh signed links. */
export async function downloadAsset(
  ctx: Context,
  client: ZettaClient,
  generation: Generation,
  dir: string,
  options: { formats?: string[]; primary?: boolean; overwrite?: boolean } = {},
): Promise<DownloadedFile[]> {
  const files = selectResultFiles(generation, options)
  if (!files.length) {
    const available = [...new Set((generation.result?.files ?? []).map(fileFormat))]
    throw new ZettaError({
      code: 'GEN3D_NO_FILES',
      message: options.formats?.length
        ? `#${generation.id} has no ${options.formats.join('/')} file. It has: ${available.join(', ') || 'nothing yet'}.`
        : `#${generation.id} has no files to download yet.`,
      details: { id: generation.id, available },
    })
  }
  const folder = requireDir(dir)
  const saved: DownloadedFile[] = []
  for (const file of files) {
    const name = `${generation.id}-${file.key.split('/').pop() ?? 'file'}`
    const path = targetPath(folder, name, options.overwrite)
    ctx.out.progress({ stage: 'download', message: `Downloading ${name}…`, id: generation.id, key: file.key })
    const link = await client.generations.downloadLink(generation.id, file.key)
    const bytes = await downloadTo(link.url, path, ctx.signal)
    saved.push({ path, format: fileFormat(file), bytes, key: file.key })
  }
  return saved
}

export function renderJob(outcome: JobOutcome | DryRunOutcome): string {
  if ('dryRun' in outcome) {
    const lines = outcome.lines.map((line) => `  ${line.label.padEnd(32)} ${String(line.credits).padStart(5)}`)
    return [`Price: ${outcome.credits} credits (nothing was spent)`, ...lines].join('\n')
  }
  const head = `#${outcome.id} · ${outcome.asset.kind ? featureLabel(outcome.asset.kind) : 'job'}${outcome.asset.engineLabel ? ` · ${outcome.asset.engineLabel}` : ''}`
  const lines = [`${head}`, `  status:  ${outcome.status}${outcome.queuePosition ? ` (queue position ${outcome.queuePosition})` : ''}`]
  lines.push(`  credits: ${outcome.credits}${outcome.charged ? '' : ' (already charged earlier — this was a retry)'}`)
  for (const file of outcome.files ?? []) lines.push(`  saved:   ${file.path}`)
  if (outcome.next) lines.push(`  next:    ${outcome.next}`)
  return lines.join('\n')
}
