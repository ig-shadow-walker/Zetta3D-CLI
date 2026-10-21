import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { pipeline as P, ZettaError, type GraphPayload, type PipelineRecord, type RunSeed, type ZettaClient } from '@zetta3d/sdk'
import { parse as parseYaml, stringify as toYaml } from 'yaml'
import { z } from 'zod'
import type { Context } from '../core/context'
import { defineCommand, spendShape, waitShape } from '../core/define'
import { usageError } from '../core/errors'
import { waitPlan, type WaitFlags, type WaitPlan } from '../core/jobs'
import { requireFile, uploadLocal } from '../core/local-files'
import { table } from '../core/output'
import { authorizeSpend } from '../core/spend'
import { downloadRunOutputs, downloadRunQuietly, finalSteps, summarizeRun, waitForRun, type RunSummary, type SavedOutput } from './run'

const pipelineId = z.number().int().positive().describe('Pipeline id (from `zetta pipeline list`).')

/** Reads a recipe file: the friendly document (`steps:`) or a raw graph (`nodes:`/`edges:`), YAML or JSON. */
export function readRecipe(path: string): { graph: P.PipelineGraph; title?: string; warnings: string[] } {
  const full = requireFile(path)
  const text = readFileSync(full, 'utf8')
  let data: unknown
  try {
    data = /\.json$/i.test(full) ? JSON.parse(text) : parseYaml(text)
  } catch (error) {
    throw usageError(`${basename(full)} is not valid ${/\.json$/i.test(full) ? 'JSON' : 'YAML'}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (data && typeof data === 'object' && 'nodes' in data) {
    const graph = P.parseGraph(data)
    return { graph, warnings: [] }
  }
  const compiled = P.compilePipeline(data, { validate: false })
  if (!compiled.ok) throw problemsError(compiled.problems, `${basename(full)} is not a valid pipeline`)
  return { graph: compiled.graph, ...(compiled.title ? { title: compiled.title } : {}), warnings: compiled.warnings }
}

export function problemsError(problems: Array<{ code: string; message: string; nodeId?: string }>, what: string): ZettaError {
  return new ZettaError({
    code: 'PIPELINE_NOT_RUNNABLE',
    message: `${what}: ${problems.map((p) => (p.nodeId ? `${p.nodeId}: ${p.message}` : p.message)).join(' ')}`,
    details: { problems },
  })
}

function summarizePipeline(record: PipelineRecord) {
  const decompiled = P.decompilePipeline({ title: record.title ?? undefined, graph: P.parseGraph(record.graph) } as never)
  return {
    id: record.id,
    title: record.title,
    steps: record.graph.nodes.length,
    seed: P.seedType(P.parseGraph(record.graph)),
    problems: record.problems ?? [],
    doc: decompiled.doc,
    updatedAt: record.updatedAt,
  }
}

const renderPipeline = (r: ReturnType<typeof summarizePipeline>) =>
  [`# Pipeline #${r.id}${r.title ? ` — ${r.title}` : ''} (${r.steps} steps, starts from a ${r.seed ?? 'nothing'})`, ...(r.problems.length ? [`# problems: ${r.problems.map((p) => p.message).join('; ')}`] : []), toYaml(r.doc)].join('\n')

export const pipelineList = defineCommand({
  path: ['pipeline', 'list'],
  summary: 'List your pipelines.',
  kind: 'read',
  input: z.object({}),
  async run(ctx) {
    const items = await (await ctx.client()).pipelines.list()
    return { items: items.map((p) => ({ id: p.id, title: p.title, steps: p.steps, lastRun: p.lastRun, runCounts: p.runCounts, updatedAt: p.updatedAt })) }
  },
  text: (r: { items: Array<Record<string, unknown> & { lastRun: { id: number; status: string } | null }> }) =>
    table(r.items.map((p) => ({ ...p, lastRun: p.lastRun ? `#${p.lastRun.id} ${p.lastRun.status}` : '-' })), ['id', 'title', 'steps', ['lastRun', 'last run'], 'updatedAt']),
})

export const pipelineGet = defineCommand({
  path: ['pipeline', 'get'],
  summary: 'Show a pipeline as an editable recipe (YAML in a terminal).',
  description: 'Save it with `zetta pipeline get <id> --output text > recipe.yaml`, edit, then `zetta pipeline update <id> --file recipe.yaml`. --raw gives the stored graph.',
  kind: 'read',
  positionals: [{ name: 'id', required: true }],
  input: z.object({ id: pipelineId, raw: z.boolean().optional().describe('The stored graph instead of the recipe.') }),
  async run(ctx, input) {
    const record = await (await ctx.client()).pipelines.get(input.id)
    if (input.raw) return { id: record.id, title: record.title, graph: record.graph, problems: record.problems }
    return summarizePipeline(record)
  },
  text: (r: ReturnType<typeof summarizePipeline> | { graph: unknown }) => ('doc' in r ? renderPipeline(r) : JSON.stringify(r, null, 2)),
})

export const pipelineSchema = defineCommand({
  path: ['pipeline', 'schema'],
  summary: 'The recipe format: JSON Schema, every step kind with its settings, and examples.',
  kind: 'local',
  input: z.object({}),
  async run() {
    return {
      schema: P.PIPELINE_DOC_JSON_SCHEMA,
      steps: P.OFFERED_NODE_KINDS.map((kind) => {
        const { kind: _ignored, ...spec } = P.NODE_KINDS[kind] as P.NodeKindSpec & { kind?: unknown }
        void _ignored
        return { kind, ...spec }
      }),
      examples: P.PIPELINE_DOC_EXAMPLES,
    }
  },
  text: (r: { examples: Array<{ name: string; description: string; doc: unknown }> }) =>
    [
      'Recipe format (full JSON Schema and every step kind: zetta pipeline schema --json). Examples:',
      ...r.examples.map((e) => `\n# ${e.name}: ${e.description}\n${toYaml(e.doc)}`),
    ].join('\n'),
})

export const pipelineValidate = defineCommand({
  path: ['pipeline', 'validate'],
  summary: 'Check a recipe file (or a saved pipeline) without saving or spending anything.',
  kind: 'read',
  positionals: [{ name: 'target', required: true }],
  input: z.object({ target: z.string().describe('A recipe file (.yaml/.json) or a pipeline id.') }),
  async run(ctx, input) {
    const client = await ctx.client()
    const { graph, warnings } = /^\d+$/.test(input.target) ? { graph: P.parseGraph((await client.pipelines.get(Number(input.target))).graph), warnings: [] as string[] } : readRecipe(input.target)
    const local = P.checkGraph(graph)
    const server = await client.pipelines.estimate(graph as unknown as GraphPayload)
    const problems = [...local.problems, ...server.problems.map((p) => P.problemFromServer({ nodeId: p.nodeId ?? null, message: p.message }))]
    const unique = problems.filter((p, i) => problems.findIndex((q) => q.message === p.message && q.nodeId === p.nodeId) === i)
    return {
      valid: unique.length === 0,
      problems: unique,
      warnings: [...warnings, ...local.warnings.map((w) => w.message)],
      creditsPerRun: server.credits,
      ...(unique.length ? { exitCode: 2 } : {}),
    }
  },
  text: (r: { valid: boolean; problems: Array<{ nodeId?: string; message: string }>; warnings: string[]; creditsPerRun: number }) =>
    [
      r.valid ? `Valid. About ${r.creditsPerRun} credits per run.` : 'Not runnable:',
      ...r.problems.map((p) => `  ✗ ${p.nodeId ? `${p.nodeId}: ` : ''}${p.message}`),
      ...r.warnings.map((w) => `  ! ${w}`),
    ].join('\n'),
})

export const pipelineEstimate = defineCommand({
  path: ['pipeline', 'estimate'],
  summary: 'Price one run of a pipeline (or a recipe file), step by step.',
  kind: 'read',
  positionals: [{ name: 'target', required: true }],
  input: z.object({
    target: z.string().describe('A pipeline id or a recipe file.'),
    seeds: z.number().int().min(1).optional().describe('Multiply by this many runs.'),
  }),
  async run(ctx, input) {
    const client = await ctx.client()
    const graph = /^\d+$/.test(input.target) ? P.parseGraph((await client.pipelines.get(Number(input.target))).graph) : readRecipe(input.target).graph
    const estimate = await client.pipelines.estimate(graph as unknown as GraphPayload)
    const runs = input.seeds ?? 1
    return { creditsPerRun: estimate.credits, runs, totalCredits: estimate.credits * runs, lines: estimate.lines, perPart: estimate.perPart, problems: estimate.problems }
  },
  text: (r: { creditsPerRun: number; runs: number; totalCredits: number; lines: Array<{ nodeId: string; credits: number; count: number }>; perPart: unknown }) =>
    [
      `${r.creditsPerRun} credits per run${r.runs > 1 ? ` × ${r.runs} = ${r.totalCredits}` : ''}${r.perPart ? ' (plus per isolated part)' : ''}`,
      table(r.lines.map((l) => ({ step: l.nodeId, credits: l.credits, count: l.count }))),
    ].join('\n'),
})

export const pipelineCreate = defineCommand({
  path: ['pipeline', 'create'],
  summary: 'Save a new pipeline from a recipe file (see `zetta pipeline schema`).',
  kind: 'write',
  input: z.object({
    file: z.string().describe('Recipe file (.yaml or .json): the friendly format, or a raw graph.'),
    title: z.string().max(200).optional().describe('Title (overrides the file’s).'),
  }),
  examples: ['zetta pipeline create --file product-to-rig.yaml'],
  async run(ctx, input) {
    const recipe = readRecipe(input.file)
    for (const warning of recipe.warnings) ctx.out.warn(warning)
    const problems = P.validateGraph(recipe.graph)
    if (problems.length) throw problemsError(problems, 'The recipe is not runnable yet')
    const record = await (await ctx.client()).pipelines.create({ title: input.title ?? recipe.title, graph: recipe.graph as unknown as GraphPayload })
    return summarizePipeline(record)
  },
  text: (r: ReturnType<typeof summarizePipeline>) => `Saved pipeline #${r.id}. Next: zetta pipeline estimate ${r.id}`,
})

export const pipelineUpdate = defineCommand({
  path: ['pipeline', 'update'],
  summary: 'Replace a pipeline’s steps from a recipe file, or rename it.',
  kind: 'write',
  positionals: [{ name: 'id', required: true }],
  input: z.object({
    id: pipelineId,
    file: z.string().optional().describe('Recipe file with the new steps.'),
    title: z.string().max(200).optional().describe('New title.'),
  }),
  async run(ctx, input) {
    if (!input.file && !input.title) throw usageError('Give --file and/or --title.')
    const recipe = input.file ? readRecipe(input.file) : undefined
    if (recipe) {
      for (const warning of recipe.warnings) ctx.out.warn(warning)
      const problems = P.validateGraph(recipe.graph)
      if (problems.length) throw problemsError(problems, 'The recipe is not runnable yet')
    }
    const title = input.title ?? recipe?.title
    const record = await (await ctx.client()).pipelines.update(input.id, { ...(title ? { title } : {}), ...(recipe ? { graph: recipe.graph as unknown as GraphPayload } : {}) })
    return summarizePipeline(record)
  },
  text: (r: ReturnType<typeof summarizePipeline>) => `Updated pipeline #${r.id}.`,
})

export const pipelineDuplicate = defineCommand({
  path: ['pipeline', 'duplicate'],
  summary: 'Copy a pipeline.',
  kind: 'write',
  positionals: [{ name: 'id', required: true }],
  input: z.object({ id: pipelineId }),
  async run(ctx, input) {
    return summarizePipeline(await (await ctx.client()).pipelines.duplicate(input.id))
  },
  text: (r: ReturnType<typeof summarizePipeline>) => `Copied to pipeline #${r.id}.`,
})

export const pipelineDelete = defineCommand({
  path: ['pipeline', 'delete'],
  summary: 'Delete a pipeline (its finished models stay in your library).',
  kind: 'destructive',
  positionals: [{ name: 'id', required: true }],
  input: z.object({ id: pipelineId, yes: z.boolean().optional().describe('Delete without asking.') }),
  async run(ctx, input) {
    if (!input.yes && !(ctx.interactive && (await ctx.confirm(`Delete pipeline #${input.id}?`)))) {
      throw usageError(ctx.interactive ? 'Cancelled.' : 'Pass --yes to delete without a terminal.')
    }
    await (await ctx.client()).pipelines.delete(input.id)
    return { deleted: input.id }
  },
  text: (r: { deleted: number }) => `Deleted pipeline #${r.deleted}.`,
})

export const pipelineRuns = defineCommand({
  path: ['pipeline', 'runs'],
  summary: 'Recent runs of a pipeline.',
  kind: 'read',
  positionals: [{ name: 'id', required: true }],
  input: z.object({ id: pipelineId }),
  async run(ctx, input) {
    const runs = await (await ctx.client()).pipelines.runs(input.id)
    return { items: runs.map((r) => ({ id: r.id, status: r.status, mode: r.mode, estimatedCredits: r.estimatedCredits, createdAt: r.createdAt })) }
  },
})

const PICTURE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp'])

/** Expands seed arguments: picture files, folders of pictures, GLB files, asset ids and image:<id>. */
function expandSeeds(values: string[]): string[] {
  const out: string[] = []
  for (const value of values) {
    if (/^(asset:|image:)?\d+$/.test(value)) out.push(value)
    else if (existsSync(value) && statSync(value).isDirectory()) {
      for (const name of readdirSync(value).sort()) {
        const ext = extname(name).toLowerCase()
        if (PICTURE_EXT.has(ext) || ext === '.glb') out.push(join(value, name))
      }
    } else out.push(value)
  }
  return out
}

async function seedFor(ctx: Context, client: ZettaClient, value: string, kind: 'picture' | 'model'): Promise<RunSeed> {
  const image = /^image:(\d+)$/.exec(value)?.[1]
  if (image) {
    if (kind !== 'picture') throw usageError(`${value} is a picture, but this pipeline starts from a model.`)
    return { gen2dPostId: Number(image) }
  }
  const asset = /^(?:asset:)?(\d+)$/.exec(value)?.[1]
  if (asset) {
    if (kind !== 'model') throw usageError(`${value} is a model, but this pipeline starts from a picture.`)
    return { gen3dPostId: Number(asset) }
  }
  if (kind === 'model') {
    if (!/\.glb$/i.test(value)) throw usageError(`${value}: a model seed must be an asset id or a .glb file.`)
    const uploaded = await uploadLocal(ctx, client, value, 'model')
    const generation = await client.uploads.register({ key: uploaded.key, bytes: uploaded.bytes, title: basename(value).replace(/\.glb$/i, ''), feature: 'upload' })
    return { gen3dPostId: generation.id }
  }
  const uploaded = await uploadLocal(ctx, client, value, 'picture')
  return { uploadKey: uploaded.key, name: basename(value) }
}

const runShape = {
  mode: z.enum(['auto', 'manual']).default('auto').describe('auto runs every step; manual waits for you to run each step.'),
  draft: z.boolean().optional().describe('Create the runs as drafts: give per-run inputs (`zetta run set-input`), then `zetta run start`.'),
  ...spendShape,
  ...waitShape,
}

type StartInput = {
  id: number
  seeds: string[]
  mode: 'auto' | 'manual'
  draft?: boolean | undefined
  yes?: boolean | undefined
  maxCredits?: number | undefined
  dryRun?: boolean | undefined
} & WaitFlags

async function startRuns(ctx: Context, input: StartInput) {
  if (input.draft && (input.wait || input.out || input.download)) throw usageError('Drafts do not start, so there is nothing to wait for: drop --draft, or --wait/--out/--download.')
  const plan = input.draft ? undefined : waitPlan(ctx, input)
  const client = await ctx.client()
  const record = await client.pipelines.get(input.id)
  const graph = P.parseGraph(record.graph)
  const kind = P.seedType(graph)
  if (!kind) throw usageError(`Pipeline #${input.id} has no seed step.`)
  const seeds = expandSeeds(input.seeds)
  if (!seeds.length) throw usageError('No seeds found (give pictures, a folder, asset ids or image:<id>).')

  const runGraph = P.newRunGraph(graph)
  const problems = P.validateGraph(runGraph)
  if (problems.length) throw problemsError(problems, `Pipeline #${input.id} cannot run`)
  if (!input.draft) {
    const needs = P.runInputProblems(runGraph)
    if (needs.length) {
      throw new ZettaError({ code: 'RUN_NEEDS_INPUT', message: `Each run needs input first: ${needs.map((p) => p.message).join(' ')} Use --draft, then \`zetta run set-input\`.`, details: { problems: needs } })
    }
  }

  const estimate = await client.pipelines.estimate(runGraph as unknown as GraphPayload)
  const total = { credits: estimate.credits * seeds.length, lines: estimate.lines.map((l) => ({ code: l.nodeId, label: l.nodeId, credits: l.credits * seeds.length })) }
  if (estimate.perPart) ctx.out.warn('Isolate Parts steps cost more for each part found; the price shown is the minimum.')
  if (input.draft) {
    if (input.dryRun) return { dryRun: true, credits: total.credits, runs: seeds.length, lines: total.lines }
  } else {
    const decision = await authorizeSpend(ctx, total, input, `${seeds.length} run(s) of pipeline #${input.id}`)
    if (!decision.go) return { dryRun: true, credits: total.credits, runs: seeds.length, lines: total.lines }
  }

  const created: RunSummary[] = []
  for (const batch of P.batchesOf(seeds)) {
    const resolved: RunSeed[] = []
    for (const value of batch) resolved.push(await seedFor(ctx, client, value, kind))
    ctx.out.progress({ stage: 'submit', message: `Starting ${resolved.length} run(s)…` })
    const result = await client.pipelines.batch(input.id, { mode: input.mode, seeds: resolved, graph: runGraph as unknown as GraphPayload, ...(input.draft ? { draft: true } : {}) })
    for (const run of result.runs) created.push(summarizeRun({ steps: [], graph: runGraph, pipelineId: input.id, ...run } as never))
  }
  const started = {
    pipelineId: input.id,
    runs: created.map((r) => ({ id: r.id, status: r.status, mode: r.mode })),
    estimatedCredits: total.credits,
    next: input.draft ? `zetta run set-input ${created[0]?.id} <step> --prompt "…" ; zetta run start ${created[0]?.id}` : `zetta run wait ${created[0]?.id} --timeout 90s`,
  }
  return plan?.wait ? finishRuns(ctx, client, created, plan, started) : started
}

/** --wait / --out / automatic downloads: wait for every run, then download the final models of those that are done. */
async function finishRuns(ctx: Context, client: ZettaClient, created: RunSummary[], plan: WaitPlan, started: { pipelineId: number; estimatedCredits: number }) {
  const deadline = plan.timeoutMs === undefined ? undefined : Date.now() + plan.timeoutMs
  const runs: RunSummary[] = []
  const saved: SavedOutput[] = []
  let next: string | undefined
  for (const { id } of created) {
    const run = await waitForRun(ctx, client, id, deadline === undefined ? undefined : Math.max(0, deadline - Date.now()))
    const summary = summarizeRun(run)
    runs.push(summary)
    next ??= summary.blocked[0]?.next
    if (run.status !== 'done' || !plan.out) continue
    if (plan.auto) {
      const result = await downloadRunQuietly(ctx, client, run, plan.out, plan.formats)
      saved.push(...result.saved)
      next ??= result.next
    } else {
      saved.push(...(await downloadRunOutputs(ctx, client, finalSteps(run), plan.out)))
    }
  }
  const failed = runs.filter((r) => r.status === 'failed' || r.status === 'cancelled')
  const outcome = {
    pipelineId: started.pipelineId,
    estimatedCredits: started.estimatedCredits,
    runs: runs.map((r) => ({ id: r.id, status: r.status, mode: r.mode, spentCredits: r.spentCredits, blocked: r.blocked })),
    ...(plan.out ? { saved } : {}),
    ...(next ? { next } : {}),
  }
  if (failed.length) {
    const reasons = failed.map((r) => `#${r.id} ${r.status}${r.blocked[0] ? ` (${r.blocked[0].step}: ${r.blocked[0].reason})` : ''}`).join(', ')
    throw new ZettaError({ code: 'RUN_FAILED', message: `${failed.length} of ${runs.length} run(s) did not finish: ${reasons}.`, details: outcome })
  }
  return outcome
}

type StartedRun = { id: number; status: string; blocked?: RunSummary['blocked'] }

const renderStarted = (r: { dryRun?: boolean; credits?: number; runs: unknown; next?: string; estimatedCredits?: number; saved?: SavedOutput[] }) => {
  if (r.dryRun) return `Price: about ${r.credits} credits for ${String(r.runs)} run(s) (nothing was spent).`
  const runs = r.runs as StartedRun[]
  const lines = [`Started ${runs.length} run(s): ${runs.map((x) => `#${x.id}`).join(', ')} · about ${r.estimatedCredits} credits`]
  if (runs.some((x) => x.blocked)) {
    for (const run of runs) lines.push(`  #${run.id} ${run.status}${run.blocked?.length ? ` · waiting on you: ${run.blocked.map((b) => `${b.step} (${b.reason})`).join(', ')}` : ''}`)
  }
  for (const file of r.saved ?? []) lines.push(`  saved: ${file.path}`)
  if (r.next) lines.push(`next: ${r.next}`)
  return lines.join('\n')
}

export const pipelineRun = defineCommand({
  path: ['pipeline', 'run'],
  summary: 'Run a pipeline on one seed (a picture or a model).',
  description:
    'Returns at once with the run id, unless the final models download: with the download.auto setting on (the default in a terminal), or with --wait, --out or --download, it waits for the run and saves them. --no-wait returns at once.',
  kind: 'spend',
  positionals: [
    { name: 'id', required: true },
    { name: 'seed', required: true },
  ],
  input: z.object({ id: pipelineId, seed: z.string().describe('A picture file, image:<id>, an asset id, or a .glb.'), ...runShape }),
  examples: ['zetta pipeline run 12 ./shoe.jpg --max-credits 300'],
  async run(ctx, input) {
    return startRuns(ctx, { ...input, seeds: [input.seed] })
  },
  text: renderStarted,
})

export const pipelineBatch = defineCommand({
  path: ['pipeline', 'batch'],
  summary: 'Run a pipeline once per seed: many pictures, a folder, or several assets.',
  description:
    'More than 20 seeds are sent in several batches. The total price is checked against --max-credits first. Downloads work as for `pipeline run`: every run is waited for, then its final models are saved.',
  kind: 'spend',
  positionals: [
    { name: 'id', required: true },
    { name: 'seeds', required: true, variadic: true },
  ],
  input: z.object({ id: pipelineId, seeds: z.array(z.string()).min(1).describe('Pictures, folders, asset ids or image:<id>.'), ...runShape }),
  examples: ['zetta pipeline batch 12 ./photos --max-credits 3000', 'zetta pipeline batch 12 a.jpg b.jpg c.jpg --draft'],
  async run(ctx, input) {
    return startRuns(ctx, input)
  },
  text: renderStarted,
})

export const pipelineCommands = [
  pipelineList,
  pipelineGet,
  pipelineSchema,
  pipelineValidate,
  pipelineEstimate,
  pipelineCreate,
  pipelineUpdate,
  pipelineDuplicate,
  pipelineDelete,
  pipelineRuns,
  pipelineRun,
  pipelineBatch,
]
