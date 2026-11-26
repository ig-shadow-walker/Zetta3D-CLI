import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { pipeline as P, ZettaError, type GraphPayload, type PipelineRecord, type RunSeed, type ZettaClient } from '@zetta3d/sdk'
import { parse as parseYaml, stringify as toYaml } from 'yaml'
import { z } from 'zod'
import type { Context } from '../core/context'
import { defineCommand, spendShape, waitShape } from '../core/define'
import { usageError } from '../core/errors'
import { waitPlan, type WaitFlags, type WaitPlan } from '../core/jobs'
import { isUrl, requireFile, uploadLocal } from '../core/local-files'
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

/** What each run of a graph gives it: its seed, and the steps set on each run. */
export function eachRunGives(graph: P.PipelineGraph): string[] {
  const seed = P.seedType(graph)
  return [
    ...(seed ? [seed === 'views' ? 'pictures of each side, a front one at least (the seed)' : `a ${seed} (the seed)`] : []),
    ...graph.nodes
      .filter((node) => P.perRunIn(graph, node))
      .map(
        (node) =>
          `${node.id}: ${node.kind === 'texture_multiview' ? 'pictures of each side' : node.kind === 'texture' ? 'a texture description or reference picture' : 'an edit instruction'} (on a draft run: zetta run set-input)`,
      ),
  ]
}

const SEED_PHRASE = { picture: 'a picture', model: 'a model', views: 'pictures of each side' } as const

function summarizePipeline(record: PipelineRecord) {
  const graph = P.parseGraph(record.graph)
  const decompiled = P.decompilePipeline({ title: record.title ?? undefined, graph })
  return {
    id: record.id,
    title: record.title,
    steps: record.graph.nodes.length,
    seed: P.seedType(graph),
    eachRunGives: eachRunGives(graph),
    problems: record.problems ?? [],
    doc: decompiled.doc,
    updatedAt: record.updatedAt,
  }
}

const renderPipeline = (r: ReturnType<typeof summarizePipeline>) =>
  [
    `# Pipeline #${r.id}${r.title ? ` — ${r.title}` : ''} (${r.steps} steps, starts from ${r.seed ? SEED_PHRASE[r.seed] : 'nothing'})`,
    ...(r.problems.length ? [`# problems: ${r.problems.map((p) => p.message).join('; ')}`] : []),
    toYaml(r.doc),
  ].join('\n')

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
  text: (r: { steps: Array<{ kind: string; group: string; label: string }>; examples: Array<{ name: string; description: string; doc: unknown }> }) =>
    [
      'Recipe format (full JSON Schema and every step kind: zetta pipeline schema --json). Steps:',
      ...['seed', 'picture', 'make', 'refine'].map(
        (group) => `  ${group}: ${r.steps.filter((step) => step.group === group).map((step) => `${step.kind} (${step.label})`).join(', ')}`,
      ),
      'One picture goes to generate_3d / generate_smart_3d; pictures of each side (seed_views, draw_views) to the *_multiview steps.',
      'Examples:',
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
      warnings: [...warnings, ...local.warnings.map((w) => (w.nodeId ? `${w.nodeId}: ${w.message}` : w.message))],
      creditsPerRun: server.credits,
      startsFrom: P.seedType(graph),
      eachRunGives: eachRunGives(graph),
      ...(unique.length ? { exitCode: 2 } : {}),
    }
  },
  text: (r: { valid: boolean; problems: Array<{ nodeId?: string; message: string }>; warnings: string[]; creditsPerRun: number; eachRunGives: string[] }) =>
    [
      r.valid ? `Valid. About ${r.creditsPerRun} credits per run.` : 'Not runnable:',
      ...r.problems.map((p) => `  ✗ ${p.nodeId ? `${p.nodeId}: ` : ''}${p.message}`),
      ...r.warnings.map((w) => `  ! ${w}`),
      ...r.eachRunGives.map((g) => `  each run gives: ${g}`),
    ].join('\n'),
})

export const pipelineEstimate = defineCommand({
  path: ['pipeline', 'estimate'],
  summary: 'Price one run of a pipeline (or a recipe file), step by step.',
  kind: 'read',
  positionals: [{ name: 'target', required: true }],
  input: z.object({
    target: z.string().describe('A pipeline id or a recipe file.'),
    seeds: z.number().int().min(1).optional().describe('Multiply by this many runs (seeds, or sets of pictures of each side).'),
  }),
  async run(ctx, input) {
    const client = await ctx.client()
    const graph = /^\d+$/.test(input.target) ? P.parseGraph((await client.pipelines.get(Number(input.target))).graph) : readRecipe(input.target).graph
    const estimate = await client.pipelines.estimate(graph as unknown as GraphPayload)
    const runs = input.seeds ?? 1
    return {
      creditsPerRun: estimate.credits,
      runs,
      totalCredits: estimate.credits * runs,
      startsFrom: P.seedType(graph),
      lines: estimate.lines,
      perPart: estimate.perPart,
      problems: estimate.problems,
    }
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
    const runs = (await (await ctx.client()).pipelines.runs(input.id)) as unknown as P.PipelineRunSummary[]
    return {
      items: runs.map((r) => ({
        id: r.id,
        status: r.status,
        mode: r.mode,
        // What it started from: a picture, a model or pictures of each side, by name.
        seed: r.seed ? { type: r.seed.type, name: r.seed.name } : null,
        progress: r.progress,
        ...(r.inputsNeeded ? { inputsNeeded: r.inputsNeeded } : {}),
        estimatedCredits: r.estimatedCredits,
        spentCredits: r.spentCredits,
        createdAt: r.createdAt,
      })),
    }
  },
  text: (r: { items: Array<{ id: number; status: string; mode: string; seed: { type: string; name: string | null } | null; progress?: { done: number; total: number }; createdAt: string }> }) =>
    table(
      r.items.map((run) => ({
        id: run.id,
        status: run.status,
        mode: run.mode,
        seed: run.seed ? `${run.seed.type === 'views' ? 'views' : run.seed.type}${run.seed.name ? `: ${run.seed.name}` : ''}` : '-',
        steps: run.progress ? `${run.progress.done}/${run.progress.total}` : '',
        createdAt: run.createdAt,
      })),
    ),
})

const PICTURE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp'])
const VIEW_ITEM = /^(front|back|left|right)=(.+)$/i

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

/** One multi-view set before upload: a picture (a file or image:<id>) for each side given, and the run's name. */
export interface ViewSetArg {
  views: Partial<Record<P.ViewType, string>>
  name?: string
}

const SETS_HELP = 'Give each run its pictures of each side: --views front=a.png,back=b.png (front first; a new front starts the next set), or a folder holding front.png (and back/left/right), or a folder of such folders.'

/**
 * `side=picture` items grouped into sets: each set starts at its `front=`, and takes the sides that
 * follow until the next `front=`. Commas and repeated flags read the same, so
 * `--views front=a.png,back=b.png --views front=c.png` is two sets.
 */
export function viewSetsFrom(items: readonly string[]): ViewSetArg[] {
  const sets: ViewSetArg[] = []
  for (const item of items.flatMap((entry) => entry.split(',')).map((entry) => entry.trim()).filter(Boolean)) {
    const match = VIEW_ITEM.exec(item)
    if (!match) throw usageError(`"${item}" is not side=picture (front, back, left or right). ${SETS_HELP}`)
    const side = match[1]!.toLowerCase() as P.ViewType
    const picture = match[2]!.trim()
    if (side === 'front') sets.push({ views: { front: picture } })
    const current = sets.at(-1)
    if (!current) throw usageError(`Start each set with its front picture: front=a.png,${side}=${picture}. ${SETS_HELP}`)
    if (side !== 'front') {
      if (current.views[side]) throw usageError(`A set gives its ${side} picture twice. Start the next set with front=…`)
      current.views[side] = picture
    }
  }
  for (const set of sets) if (set.views.front && !/^image:\d+$/.test(set.views.front)) set.name = basename(set.views.front)
  return sets
}

/** A folder's pictures named by side (front.png, Back.JPG …), or null when it holds none. */
function viewFolder(dir: string): Partial<Record<P.ViewType, string>> | null {
  const views: Partial<Record<P.ViewType, string>> = {}
  for (const name of readdirSync(dir).sort()) {
    const ext = extname(name).toLowerCase()
    const side = basename(name, extname(name)).toLowerCase()
    if (!PICTURE_EXT.has(ext) || !(P.VIEW_TYPES as readonly string[]).includes(side)) continue
    const full = join(dir, name)
    if (!statSync(full).isFile()) continue
    if (views[side as P.ViewType]) throw usageError(`${dir} has two ${side} pictures; keep one.`)
    views[side as P.ViewType] = full
  }
  return Object.keys(views).length ? views : null
}

/**
 * Multi-view seeds from the arguments: `side=picture` items (grouped as `viewSetsFrom` does), a folder
 * holding front.png and the other sides (one run, named after the folder), or a folder of such folders
 * (one run each, in name order).
 */
export function expandViewSets(values: readonly string[], flags: readonly string[]): ViewSetArg[] {
  const sets: ViewSetArg[] = []
  let items: string[] = []
  const flush = () => {
    if (items.length) sets.push(...viewSetsFrom(items))
    items = []
  }
  for (const value of values) {
    if (VIEW_ITEM.test(value.trim())) {
      items.push(value)
      continue
    }
    flush()
    if (!existsSync(value) || !statSync(value).isDirectory()) {
      throw usageError(`${value}: this pipeline starts from pictures of each side, not one picture. ${SETS_HELP}`)
    }
    const own = viewFolder(value)
    if (own) {
      if (!own.front) throw usageError(`${value} has pictures of some sides but no front (front.png, .jpg or .webp).`)
      sets.push({ views: own, name: basename(resolve(value)) })
      continue
    }
    const found: ViewSetArg[] = []
    const missing: string[] = []
    for (const name of readdirSync(value).sort()) {
      const sub = join(value, name)
      if (!statSync(sub).isDirectory()) continue
      const views = viewFolder(sub)
      if (!views) continue
      if (!views.front) missing.push(name)
      else found.push({ views, name })
    }
    if (missing.length) throw usageError(`No front picture in ${missing.map((name) => join(value, name)).join(', ')}.`)
    if (!found.length) throw usageError(`${value} holds no front.png, nor folders that do. ${SETS_HELP}`)
    sets.push(...found)
  }
  flush()
  if (flags.length) sets.push(...viewSetsFrom(flags))
  return sets
}

/** Uploads each local picture once, however many sets use it. */
type UploadCache = Map<string, string>

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

/** One side's picture of a multi-view set: a library picture, or a local file uploaded once. */
export async function viewPicture(ctx: Context, client: ZettaClient, side: P.ViewType, value: string, cache: UploadCache = new Map()): Promise<P.ViewSeed> {
  const image = /^image:(\d+)$/.exec(value)?.[1]
  if (image) return { viewType: side, gen2dPostId: Number(image) }
  if (isUrl(value)) throw usageError(`${side}=${value}: give a local file or image:<id>.`)
  const full = resolve(value)
  let key = cache.get(full)
  if (!key) {
    key = (await uploadLocal(ctx, client, value, 'picture', `${basename(value)} (${side})`)).key
    cache.set(full, key)
  }
  return { viewType: side, uploadKey: key, name: basename(value) }
}

/** A multi-view set as a run's seed: its pictures in the slots' order, named after the folder or the front. */
async function viewSeedFor(ctx: Context, client: ZettaClient, set: ViewSetArg, cache: UploadCache): Promise<RunSeed> {
  const views: P.ViewSeed[] = []
  for (const side of P.VIEW_TYPES) {
    const value = set.views[side]
    if (value) views.push(await viewPicture(ctx, client, side, value, cache))
  }
  return { views, ...(set.name ? { name: set.name } : {}) } as RunSeed
}

const runShape = {
  mode: z.enum(['auto', 'manual']).default('auto').describe('auto runs every step; manual waits for you to run each step.'),
  draft: z.boolean().optional().describe('Create the runs as drafts: give per-run inputs (`zetta run set-input`), then `zetta run start`.'),
  ...spendShape,
  ...waitShape,
}

const viewsFlag = z
  .array(z.string())
  .optional()
  .describe('For a pipeline that starts from pictures of each side: front=a.png,back=b.png,left=c.png,right=d.png (front required and first; image:<id> works too). Each front starts another run.')

type StartInput = {
  id: number
  seeds: string[]
  views?: string[] | undefined
  mode: 'auto' | 'manual'
  draft?: boolean | undefined
  yes?: boolean | undefined
  maxCredits?: number | undefined
  dryRun?: boolean | undefined
} & WaitFlags

type SeedArg = { value: string } | { set: ViewSetArg }

const SEED_WORDS = { picture: 'a picture', model: 'a model', views: 'pictures of each side' } as const

async function startRuns(ctx: Context, input: StartInput, single = false) {
  if (input.draft && (input.wait || input.out || input.download)) throw usageError('Drafts do not start, so there is nothing to wait for: drop --draft, or --wait/--out/--download.')
  const plan = input.draft ? undefined : waitPlan(ctx, input)
  const client = await ctx.client()
  const record = await client.pipelines.get(input.id)
  const stored = P.parseGraph(record.graph)
  const kind = P.seedType(stored)
  if (!kind) throw usageError(`Pipeline #${input.id} has no seed step.`)

  let seeds: SeedArg[]
  if (kind === 'views') {
    seeds = expandViewSets(input.seeds, input.views ?? []).map((set) => ({ set }))
    if (!seeds.length) throw usageError(`Pipeline #${input.id} starts from pictures of each side. ${SETS_HELP}`)
  } else {
    if (input.views?.length || input.seeds.some((value) => VIEW_ITEM.test(value.trim()))) {
      throw usageError(`--views and side=picture are for pipelines that start from pictures of each side; pipeline #${input.id} starts from ${SEED_WORDS[kind]}.`)
    }
    seeds = expandSeeds(input.seeds).map((value) => ({ value }))
    if (!seeds.length) throw usageError('No seeds found (give pictures, a folder, asset ids or image:<id>).')
  }
  if (single && seeds.length !== 1) throw usageError(`\`pipeline run\` takes one seed; ${seeds.length} were given. Use \`zetta pipeline batch\` for several.`)

  // The run's copy: requests rebuilt as the editor builds them; a draft's per-run inputs left empty.
  const runGraph = P.runGraphFor(stored, { draft: Boolean(input.draft) })
  const problems = P.validateGraph(runGraph)
  if (problems.length) throw problemsError(problems, `Pipeline #${input.id} cannot run`)
  if (!input.draft) {
    const needs = P.runInputProblems(runGraph)
    if (needs.length) {
      throw new ZettaError({ code: 'RUN_NEEDS_INPUT', message: `Each run needs input first: ${needs.map((p) => p.message).join(' ')} Use --draft, then \`zetta run set-input\`.`, details: { problems: needs } })
    }
  }
  /*
   * A GRAPH ONLY WHEN IT CHANGES SOMETHING. Sent with the runs, it is saved onto the pipeline first —
   * which an API key may not do — so it goes only when the copy the server would make on its own
   * differs from this one in what the engine reads.
   */
  const changed = P.runGraphChanges(stored, runGraph, Boolean(input.draft))
  const sending = { graph: changed.length > 0 }

  const estimate = await client.pipelines.estimate(runGraph as unknown as GraphPayload)
  const total = { credits: estimate.credits * seeds.length, lines: estimate.lines.map((l) => ({ code: l.nodeId, label: l.nodeId, credits: l.credits * seeds.length })) }
  if (estimate.perPart) ctx.out.warn('Isolate Parts steps cost more for each part found; the price shown is the minimum.')
  if (input.draft) {
    if (input.dryRun) return { dryRun: true, credits: total.credits, runs: seeds.length, lines: total.lines }
  } else {
    const decision = await authorizeSpend(ctx, total, input, `${seeds.length} run(s) of pipeline #${input.id}`)
    if (!decision.go) return { dryRun: true, credits: total.credits, runs: seeds.length, lines: total.lines }
  }

  const cache: UploadCache = new Map()
  const created: RunSummary[] = []
  for (const batch of P.batchesOf(seeds)) {
    const resolved: RunSeed[] = []
    for (const seed of batch) resolved.push('set' in seed ? await viewSeedFor(ctx, client, seed.set, cache) : await seedFor(ctx, client, seed.value, kind as 'picture' | 'model'))
    const seedProblems = P.validateSeeds(stored, resolved)
    if (seedProblems.length) throw usageError(seedProblems.map((p) => p.message).join(' '), { problems: seedProblems })
    ctx.out.progress({ stage: 'submit', message: `Starting ${resolved.length} run(s)…` })
    const result = await startBatch(ctx, client, input, resolved, runGraph, sending, changed)
    for (const run of result.runs) created.push(summarizeRun({ steps: [], graph: runGraph, pipelineId: input.id, ...run } as never))
  }
  const firstId = created[0]?.id
  const started = {
    pipelineId: input.id,
    runs: created.map((r) => ({ id: r.id, status: r.status, mode: r.mode })),
    estimatedCredits: total.credits,
    next: input.draft ? draftNext(runGraph, firstId) : `zetta run wait ${firstId} --timeout 90s`,
  }
  return plan?.wait ? finishRuns(ctx, client, created, plan, started) : started
}

/** What a new draft asks for first: its per-run inputs, then Start. */
function draftNext(graph: P.PipelineGraph, runId: number | undefined): string {
  const needs = P.runInputProblems(graph)
  const first = needs[0]
  const input = first ? graph.nodes.find((node) => node.id === first.nodeId) : undefined
  const set = input ? `zetta run set-input ${runId} ${input.id} ${input.kind === 'texture_multiview' ? '--views front=a.png,back=b.png' : '--prompt "…"'} ; ` : ''
  return `${set}zetta run start ${runId}`
}

/**
 * Starts one batch. With a graph that an API key may not carry (403 PIPELINE_EDIT_NOT_ALLOWED), the
 * runs start on the pipeline as saved instead — said once, and the graph is not sent again.
 */
async function startBatch(
  ctx: Context,
  client: ZettaClient,
  input: StartInput,
  seeds: RunSeed[],
  graph: P.PipelineGraph,
  sending: { graph: boolean },
  changed: string[],
) {
  const body = { mode: input.mode, seeds, ...(input.draft ? { draft: true } : {}) }
  if (!sending.graph) return client.pipelines.batch(input.id, body)
  try {
    return await client.pipelines.batch(input.id, { ...body, graph: graph as unknown as GraphPayload })
  } catch (error) {
    if (!(error instanceof ZettaError) || error.code !== P.PIPELINE_ERROR_CODES.editNotAllowed) throw error
    sending.graph = false
    ctx.out.warn(
      `Runs use pipeline #${input.id} exactly as saved: this sign-in cannot change a pipeline, and the CLI's copy differs at ${changed.join(', ')}. ` +
        'Re-save it from a browser sign-in (zetta pipeline update) to run it as the CLI would.',
    )
    return client.pipelines.batch(input.id, body)
  }
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
  summary: 'Run a pipeline on one seed (a picture, a model, or pictures of each side).',
  description:
    'Returns at once with the run id, unless the final models download: with the download.auto setting on (the default in a terminal), or with --wait, --out or --download, it waits for the run and saves them. --no-wait returns at once. ' +
    'A pipeline that starts from pictures of each side (a Multi-view seed) takes --views front=a.png,back=b.png, or a folder holding front.png (and back/left/right .png/.jpg/.webp).',
  kind: 'spend',
  positionals: [
    { name: 'id', required: true },
    { name: 'seed' },
  ],
  input: z.object({
    id: pipelineId,
    seed: z.string().optional().describe('A picture file, image:<id>, an asset id or a .glb — or, for pictures of each side, a folder holding front.png (back/left/right).'),
    views: viewsFlag,
    ...runShape,
  }),
  examples: ['zetta pipeline run 12 ./shoe.jpg --max-credits 300', 'zetta pipeline run 14 --views front=chair-f.jpg,back=chair-b.jpg --max-credits 300', 'zetta pipeline run 14 ./chair --max-credits 300'],
  async run(ctx, input) {
    if (!input.seed && !input.views?.length) throw usageError('Give the seed: a picture, a model, or --views front=a.png,… for pictures of each side.')
    if (input.seed && input.views?.length) throw usageError('Give one seed: the positional seed or --views, not both.')
    return startRuns(ctx, { ...input, seeds: input.seed ? [input.seed] : [] }, true)
  },
  text: renderStarted,
})

export const pipelineBatch = defineCommand({
  path: ['pipeline', 'batch'],
  summary: 'Run a pipeline once per seed: many pictures, a folder, several assets, or sets of pictures of each side.',
  description:
    'More than 20 seeds are sent in several batches. The total price is checked against --max-credits first. Downloads work as for `pipeline run`: every run is waited for, then its final models are saved. ' +
    'For a pipeline that starts from pictures of each side, each run is a set: --views front=a.png,back=b.png (repeat, or start the next set with another front=), a folder holding front.png (one run), or a folder of such folders (one run each).',
  kind: 'spend',
  positionals: [
    { name: 'id', required: true },
    { name: 'seeds', variadic: true },
  ],
  input: z.object({
    id: pipelineId,
    seeds: z.array(z.string()).optional().describe('Pictures, folders, asset ids or image:<id> — or folders of pictures of each side.'),
    views: viewsFlag,
    ...runShape,
  }),
  examples: [
    'zetta pipeline batch 12 ./photos --max-credits 3000',
    'zetta pipeline batch 12 a.jpg b.jpg c.jpg --draft',
    'zetta pipeline batch 14 ./products --max-credits 3000   # one run per folder: products/chair/front.png, products/lamp/front.png …',
    'zetta pipeline batch 14 --views front=a1.png,back=a2.png --views front=b1.png --yes',
  ],
  async run(ctx, input) {
    if (!input.seeds?.length && !input.views?.length) throw usageError('Give the seeds: pictures, a folder, asset ids, image:<id> — or --views front=a.png,… sets.')
    return startRuns(ctx, { ...input, seeds: input.seeds ?? [] })
  },
  text: renderStarted,
})

/* ------------------------------------------------------------------------------- drafts */

const isUntitled = (title: string | null | undefined) => !title?.trim() || title === 'Untitled pipeline'

interface DraftResult {
  title: string
  summary: string
  /** What it changed: a pipeline id or a recipe file, when it edited one. */
  editedFrom?: string
  recipe: P.PipelineDoc
  problems: P.Problem[]
  warnings: string[]
  /** What each run has to give it besides its seed. */
  eachRunGives: string[]
  pipeline?: { id: number; title: string | null; action: 'created' | 'updated' }
  next: string
}

export const pipelineDraft = defineCommand({
  path: ['pipeline', 'draft'],
  summary: 'Describe a recipe in your own words: an AI drafts it (or changes one) and prints it as a recipe.',
  description:
    'Uses AI tokens and needs a paid plan (at most 10 a minute). Nothing is saved unless you add --create (a new pipeline) or --update <id>. ' +
    'With --from <pipeline id | recipe file> the AI changes that recipe as asked — keeping its steps and settings — instead of drafting a new one; --update <id> changes that pipeline (unless --from names another). ' +
    'Save the printed recipe with `--output text > recipe.yaml`.',
  kind: 'write',
  positionals: [{ name: 'description', required: true }],
  input: z.object({
    description: z
      .string()
      .min(P.PIPELINE_LIMITS.minDraftDescription)
      .max(P.PIPELINE_LIMITS.maxDraftDescription)
      .describe('What the recipe should do, or what to change, in your own words (3–2,000 characters).'),
    from: z.string().optional().describe('Change this recipe instead of drafting a new one: a pipeline id or a recipe file (.yaml/.json).'),
    create: z.boolean().optional().describe('Save the drafted recipe as a new pipeline.'),
    update: z.number().int().positive().optional().describe('Save the drafted recipe over this pipeline (also the recipe changed, unless --from says otherwise).'),
    title: z.string().max(200).optional().describe('The title --create or --update saves (default: the drafted title; --update keeps a pipeline’s own title).'),
  }),
  examples: [
    'zetta pipeline draft "a game-ready character from a photo, rigged for Unity" --output text > recipe.yaml',
    'zetta pipeline draft "add AI texturing at the end" --update 12',
    'zetta pipeline draft "use quads everywhere" --from recipe.yaml --output text > recipe-quads.yaml',
    'zetta pipeline draft "products from photos of each side, clean low-poly, retextured" --create',
  ],
  async run(ctx, input): Promise<DraftResult> {
    if (input.create && input.update) throw usageError('Give --create or --update, not both.')
    if (input.title && !input.create && !input.update) throw usageError('--title names the pipeline that --create or --update saves.')
    const description = input.description.trim()
    if (description.length < P.PIPELINE_LIMITS.minDraftDescription) throw usageError('Describe the recipe in at least 3 characters.')
    const client = await ctx.client()

    // The recipe being changed, if any: a saved pipeline or a recipe file.
    const fromRef = input.from ?? (input.update !== undefined ? String(input.update) : undefined)
    let base: { graph: P.PipelineGraph; title: string | null; label: string } | undefined
    if (fromRef) {
      if (/^\d+$/.test(fromRef)) {
        const record = await client.pipelines.get(Number(fromRef))
        base = { graph: P.parseGraph(record.graph), title: record.title, label: `pipeline #${fromRef}` }
      } else {
        const recipe = readRecipe(fromRef)
        for (const warning of recipe.warnings) ctx.out.warn(warning)
        base = { graph: recipe.graph, title: recipe.title ?? null, label: basename(fromRef) }
      }
    }
    // A recipe with nothing but its seed is drafted afresh, as the Studio does.
    const editing = base && base.graph.nodes.some((node) => !P.isSeed(node.kind)) ? base : undefined
    ctx.out.progress({ stage: 'draft', message: editing ? `Changing ${editing.label}…` : 'Drafting the recipe…' })
    const drafted = await client.pipelines.draft({ description, ...(editing ? { graph: editing.graph as unknown as GraphPayload } : {}) })

    // The server names only what each step changes: the Studio's defaults fill the rest, then the requests are built.
    const parsed = P.parseGraph(drafted.graph)
    const graph = P.withRequests({
      ...parsed,
      nodes: parsed.nodes.map((node) => (P.isNodeKind(node.kind) ? { ...node, settings: P.settingsWithDefaults(node.kind, node.settings) } : node)),
    })
    const { problems, warnings } = P.checkGraph(graph)
    const decompiled = P.decompilePipeline({ title: drafted.title, graph })
    let pipeline: DraftResult['pipeline']
    if (input.create) {
      const record = await client.pipelines.create({ title: input.title ?? drafted.title, graph: graph as unknown as GraphPayload })
      pipeline = { id: record.id, title: record.title, action: 'created' }
    } else if (input.update !== undefined) {
      const current = base && fromRef === String(input.update) ? base.title : (await client.pipelines.get(input.update)).title
      const title = input.title ?? (isUntitled(current) ? drafted.title : undefined)
      const record = await client.pipelines.update(input.update, { graph: graph as unknown as GraphPayload, ...(title ? { title } : {}) })
      pipeline = { id: record.id, title: record.title, action: 'updated' }
    }
    if (problems.length) ctx.out.warn(`The drafted recipe has ${problems.length} thing(s) to fix before it can run: ${problems.map((p) => (p.nodeId ? `${p.nodeId}: ${p.message}` : p.message)).join(' ')}`)
    return {
      title: drafted.title,
      summary: drafted.summary,
      ...(editing ? { editedFrom: editing.label } : {}),
      recipe: decompiled.doc,
      problems,
      warnings: [...warnings.map((w) => (w.nodeId ? `${w.nodeId}: ${w.message}` : w.message)), ...decompiled.warnings],
      eachRunGives: eachRunGives(graph),
      ...(pipeline ? { pipeline } : {}),
      next: pipeline
        ? `zetta pipeline estimate ${pipeline.id}`
        : 'save it (zetta pipeline draft … --output text > recipe.yaml), then zetta pipeline create --file recipe.yaml — or run the draft again with --create',
    }
  },
  text: (r: DraftResult) =>
    [
      `# ${r.title}${r.editedFrom ? ` (changed from ${r.editedFrom})` : ''}`,
      ...(r.summary ? [`# ${r.summary}`] : []),
      ...r.problems.map((p) => `# to fix: ${p.nodeId ? `${p.nodeId}: ` : ''}${p.message}`),
      ...r.warnings.map((w) => `# note: ${w}`),
      ...r.eachRunGives.map((g) => `# each run gives: ${g}`),
      toYaml(r.recipe).trimEnd(),
      r.pipeline ? `# ${r.pipeline.action === 'created' ? 'Saved as' : 'Saved over'} pipeline #${r.pipeline.id}. Next: ${r.next}` : `# next: ${r.next}`,
    ].join('\n'),
})

export const pipelineCommands = [
  pipelineList,
  pipelineGet,
  pipelineSchema,
  pipelineDraft,
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
