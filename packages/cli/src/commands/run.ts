import { pipeline as P, ZettaError, type PipelineRun, type ZettaClient } from '@zetta3d/sdk'
import { z } from 'zod'
import type { Context } from '../core/context'
import { defineCommand, spendShape } from '../core/define'
import { usageError } from '../core/errors'
import { downloadAsset, waitPlan } from '../core/jobs'
import { isUrl, uploadLocal } from '../core/local-files'
import { table } from '../core/output'
import { authorizeSpend } from '../core/spend'

const runId = z.number().int().positive().describe('Run id (from `zetta pipeline runs <id>` or a batch result).')

export interface RunSummary {
  id: number
  pipelineId: number
  status: string
  mode: string
  paused: boolean
  estimatedCredits: number | null
  spentCredits: number | null
  steps: Array<{ stepId: number; step: string; kind: string | null; part: string | null; status: string; assetId: number | null; credits: number | null; attempt: number; error: string | null }>
  blocked: Array<{ stepId: number; step: string; reason: string; next: string }>
  createdAt?: string
  next?: string
}

/** A compact view of a run: one line per step, plus what (if anything) waits on a person. */
export function summarizeRun(run: PipelineRun): RunSummary {
  const kinds = new Map((run.graph?.nodes ?? []).map((node) => [String(node.id), String(node.kind)]))
  const steps = (run.steps ?? []).map((step) => ({
    stepId: step.id,
    step: step.nodeId,
    kind: kinds.get(step.nodeId) ?? null,
    part: step.partKey ?? null,
    status: step.status,
    assetId: step.gen3dPostId ?? null,
    credits: step.credits ?? null,
    attempt: step.attempt,
    error: step.errorMessage ?? null,
  }))
  const blocked: RunSummary['blocked'] = []
  for (const step of steps) {
    if (step.status === 'review') blocked.push({ stepId: step.stepId, step: step.step, reason: 'Isolate Parts found parts; choose which to keep.', next: `zetta run confirm-parts ${run.id} ${step.stepId} --keys <part,…>` })
    else if (step.status === 'ready' && run.mode === 'manual') blocked.push({ stepId: step.stepId, step: step.step, reason: 'Manual mode: ready to run.', next: `zetta run step-run ${run.id} ${step.stepId}` })
    else if (step.status === 'failed') blocked.push({ stepId: step.stepId, step: step.step, reason: step.error ?? 'Failed (refunded).', next: `zetta run step-retry ${run.id} ${step.stepId}` })
  }
  const summary: RunSummary = {
    id: run.id,
    pipelineId: run.pipelineId,
    status: run.status,
    mode: run.mode,
    paused: Boolean(run.paused),
    estimatedCredits: run.estimatedCredits ?? null,
    spentCredits: run.spentCredits ?? null,
    steps,
    blocked,
    ...(run.createdAt ? { createdAt: run.createdAt } : {}),
  }
  if (run.status === 'draft') summary.next = `zetta run set-input ${run.id} <step> --prompt "…" (if needed), then zetta run start ${run.id}`
  else if (run.status === 'paused' || run.paused) summary.next = `zetta run resume ${run.id}`
  else if (run.status === 'done') summary.next = `zetta run outputs ${run.id} --out ./out`
  else if (!['failed', 'cancelled'].includes(run.status)) summary.next = `zetta run wait ${run.id} --timeout 90s`
  return summary
}

const renderRun = (r: RunSummary) =>
  [
    `Run #${r.id} of pipeline #${r.pipelineId} · ${r.status}${r.paused ? ' (paused)' : ''} · ${r.mode} · ${r.spentCredits ?? 0}/${r.estimatedCredits ?? '?'} credits`,
    r.steps.length ? table(r.steps.map((s) => ({ id: s.stepId, step: s.step + (s.part ? `[${s.part}]` : ''), kind: s.kind, status: s.status, asset: s.assetId ? `#${s.assetId}` : '', error: s.error }))) : '',
    ...r.blocked.map((b) => `waiting: ${b.step} — ${b.reason}\n  next: ${b.next}`),
    r.next && !r.blocked.length ? `next: ${r.next}` : '',
  ]
    .filter(Boolean)
    .join('\n')

export const runGet = defineCommand({
  path: ['run', 'get'],
  summary: 'Show a pipeline run: every step, its status and its asset.',
  kind: 'read',
  positionals: [{ name: 'id', required: true }],
  input: z.object({ id: runId }),
  async run(ctx, input) {
    return summarizeRun(await (await ctx.client()).runs.get(input.id))
  },
  text: renderRun,
})

export const runWait = defineCommand({
  path: ['run', 'wait'],
  summary: 'Wait until a run finishes, or needs you (review, manual step, draft input).',
  description:
    'Exits 0 when done or waiting on you (see `blocked`), 9 if it failed or was cancelled, 10 if --timeout passed first. With the download.auto setting on (the default in a terminal), the final models download into the current folder.',
  kind: 'read',
  positionals: [{ name: 'id', required: true }],
  input: z.object({
    id: runId,
    timeout: z.string().optional().describe('Stop waiting after this long, e.g. 90s, 10m.'),
    out: z.string().optional().describe('When done, download every output into this folder.'),
    download: z.boolean().optional().describe('When done, download the final models into the current folder (default: the download.auto setting). --no-download only waits.'),
  }),
  async run(ctx, input) {
    const plan = waitPlan(ctx, { ...input, wait: true })
    const client = await ctx.client()
    const run = await waitForRun(ctx, client, input.id, plan.timeoutMs)
    const summary = summarizeRun(run)
    if (run.status === 'failed' || run.status === 'cancelled') {
      throw new ZettaError({ code: 'RUN_FAILED', message: `Run #${run.id} ${run.status}. ${summary.blocked.map((b) => `${b.step}: ${b.reason}`).join(' ')}`.trim(), details: { run: summary } })
    }
    if (run.status !== 'done' || !plan.out) return summary
    if (!plan.auto) return { ...summary, saved: await downloadRunOutputs(ctx, client, run, plan.out) }
    const result = await downloadRunQuietly(ctx, client, run, plan.out, plan.formats)
    return { ...summary, saved: result.saved, ...(result.next ? { next: result.next } : {}) }
  },
  text: (r: RunSummary & { saved?: Array<{ path: string }> }) => [renderRun(r), ...(r.saved ?? []).map((f) => `saved: ${f.path}`)].join('\n'),
})

/** Waits for a run with progress events; stops early when it needs you. Throws WAIT_TIMEOUT when time runs out. */
export async function waitForRun(ctx: Context, client: ZettaClient, id: number, timeoutMs: number | undefined): Promise<PipelineRun> {
  let last = ''
  return client.runs.wait(id, {
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    onUpdate: (r) => {
      const done = r.steps.filter((s) => s.status === 'success').length
      const line = `Run #${r.id}: ${r.status} · ${done}/${r.steps.length} steps done`
      if (line !== last) ctx.out.progress({ stage: 'wait', message: line, runId: r.id, status: r.status })
      last = line
    },
  })
}

export type SavedOutput = { runId: number; step: string; assetId: number; path: string; format: string }

/** Only the last step of each branch: the run's finished models, not the steps in between. */
export function finalSteps(run: PipelineRun): PipelineRun {
  const sources = new Set((run.graph?.edges ?? []).map((edge) => String(edge.source)))
  return { ...run, steps: run.steps.filter((s) => !sources.has(s.nodeId)) }
}

export async function downloadRunOutputs(ctx: Context, client: ZettaClient, run: PipelineRun, out: string, formats?: string[]): Promise<SavedOutput[]> {
  const saved: SavedOutput[] = []
  const ids = [...new Set(run.steps.filter((s) => s.status === 'success' && s.gen3dPostId).map((s) => [s.nodeId, s.gen3dPostId!] as const).map(([n, id]) => `${n}:${id}`))]
  for (const entry of ids) {
    const [step, id] = entry.split(':') as [string, string]
    const { generation } = await client.generations.get(Number(id))
    if (generation.status !== 'success') continue
    const files = await downloadAsset(ctx, client, generation, out, formats?.length ? { formats } : {})
    for (const file of files) saved.push({ runId: run.id, step, assetId: Number(id), path: file.path, format: file.format })
  }
  return saved
}

/** The automatic download of a finished run's final models: a problem becomes a warning, never a failure. */
export async function downloadRunQuietly(
  ctx: Context,
  client: ZettaClient,
  run: PipelineRun,
  out: string,
  formats?: string[],
): Promise<{ saved: SavedOutput[]; next?: string }> {
  try {
    return { saved: await downloadRunOutputs(ctx, client, finalSteps(run), out, formats) }
  } catch (error) {
    if (ctx.signal?.aborted) throw error
    ctx.out.warn(`Run #${run.id} is done but its models were not downloaded: ${error instanceof Error ? error.message : String(error)}`)
    return { saved: [], next: `zetta run outputs ${run.id} --final-only` }
  }
}

export const runOutputs = defineCommand({
  path: ['run', 'outputs'],
  summary: 'Download every model a run produced.',
  kind: 'read',
  positionals: [{ name: 'id', required: true }],
  input: z.object({
    id: runId,
    out: z.string().optional().describe('Folder to save into (default: the current folder, or the download.dir setting).'),
    format: z.array(z.string()).optional().describe('Only these formats (glb, fbx, …).'),
    finalOnly: z.boolean().optional().describe('Only the last step of each branch.'),
  }),
  async run(ctx, input) {
    const client = await ctx.client()
    let run = await client.runs.get(input.id)
    if (input.finalOnly) run = finalSteps(run)
    const saved = await downloadRunOutputs(ctx, client, run, input.out ?? ctx.downloadDir(), input.format)
    return { runId: run.id, status: run.status, saved }
  },
  text: (r: { saved: Array<{ step: string; path: string }> }) => (r.saved.length ? r.saved.map((f) => `${f.step}: ${f.path}`).join('\n') : 'No finished models yet.'),
})

/** Price of what remains, for the spend guard on commands that resume work. */
function remaining(run: PipelineRun): { credits: number; lines: Array<{ code: string; label: string; credits: number }> } {
  const credits = Math.max(0, (run.estimatedCredits ?? 0) - (run.spentCredits ?? 0))
  return { credits, lines: [{ code: 'pipeline_run', label: `Run #${run.id} (remaining estimate)`, credits }] }
}

function controlCommand(name: string, summary: string, kind: 'write' | 'spend' | 'destructive', act: (client: ZettaClient, id: number) => Promise<PipelineRun>) {
  return defineCommand({
    path: ['run', name],
    summary,
    kind,
    positionals: [{ name: 'id', required: true }],
    input: kind === 'spend' ? z.object({ id: runId, ...spendShape }) : z.object({ id: runId }),
    async run(ctx, input: { id: number; yes?: boolean; maxCredits?: number; dryRun?: boolean }) {
      const client = await ctx.client()
      if (kind === 'spend') {
        const decision = await authorizeSpend(ctx, remaining(await client.runs.get(input.id)), input, `Run #${input.id}`)
        if (!decision.go) return { dryRun: true, ...remaining(await client.runs.get(input.id)) }
      }
      return summarizeRun(await act(client, input.id))
    },
    text: (r: RunSummary | { dryRun: true; credits: number }) => ('dryRun' in r ? `About ${r.credits} credits remain (nothing was spent).` : renderRun(r)),
  })
}

export const runStart = controlCommand('start', 'Start a draft run (after its per-run inputs are set).', 'spend', (c, id) => c.runs.start(id))
export const runPause = controlCommand('pause', 'Pause a run after the steps already running.', 'write', (c, id) => c.runs.pause(id))
export const runResume = controlCommand('resume', 'Resume a paused run.', 'spend', (c, id) => c.runs.resume(id))
export const runContinue = controlCommand('continue', 'Manual mode: run every step that is ready.', 'spend', (c, id) => c.runs.runWaiting(id))
export const runCancel = controlCommand('cancel', 'Cancel a run (steps not started are not charged).', 'destructive', (c, id) => c.runs.cancel(id))

export const runMode = defineCommand({
  path: ['run', 'mode'],
  summary: 'Switch a run between auto and manual.',
  kind: 'write',
  positionals: [
    { name: 'id', required: true },
    { name: 'mode', required: true },
  ],
  input: z.object({ id: runId, mode: z.enum(['auto', 'manual']).describe('auto or manual.') }),
  async run(ctx, input) {
    return summarizeRun(await (await ctx.client()).runs.setMode(input.id, input.mode))
  },
  text: renderRun,
})

export const runSetInput = defineCommand({
  path: ['run', 'set-input'],
  summary: 'Set a step’s per-run input or settings before it runs (e.g. a draft’s texture prompt).',
  description: 'Use friendly setting names as in recipes: --prompt, --reference, or --set key=value for anything else.',
  kind: 'write',
  positionals: [
    { name: 'id', required: true },
    { name: 'step', required: true },
  ],
  input: z.object({
    id: runId,
    step: z.string().describe('The step id (as in the recipe).'),
    prompt: z.string().max(5000).optional().describe('Instruction or description for this run.'),
    reference: z.string().optional().describe('A reference picture for this run: a file or image:<id>.'),
    set: z.array(z.string()).optional().describe('Other settings as key=value (friendly names).'),
  }),
  examples: ['zetta run set-input 88 paint --prompt "matte black ceramic"', 'zetta run set-input 88 gen --set quality=ultra'],
  async run(ctx, input) {
    const client = await ctx.client()
    const run = await client.runs.get(input.id)
    const fields: Record<string, unknown> = {}
    if (input.prompt) fields.prompt = input.prompt
    if (input.reference) {
      const image = /^image:(\d+)$/.exec(input.reference)?.[1]
      if (image) fields.reference = { gen2dPostId: Number(image) }
      else if (isUrl(input.reference)) throw usageError('--reference takes a local file or image:<id>.')
      else fields.reference = { uploadKey: (await uploadLocal(ctx, client, input.reference, 'picture')).key }
    }
    for (const pair of input.set ?? []) {
      const at = pair.indexOf('=')
      if (at <= 0) throw usageError(`--set "${pair}" should be key=value.`)
      const raw = pair.slice(at + 1)
      fields[pair.slice(0, at)] = raw === 'true' ? true : raw === 'false' ? false : /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw
    }
    if (!Object.keys(fields).length) throw usageError('Give --prompt, --reference or --set.')
    const change = P.runNodeChange(P.parseGraph(run.graph), input.step, fields)
    if (!change.ok) throw new ZettaError({ code: 'USAGE', message: change.problems.map((p) => p.message).join(' '), details: { problems: change.problems } })
    for (const warning of change.warnings) ctx.out.warn(warning)
    return summarizeRun(await client.runs.setNode(input.id, input.step, change.body))
  },
  text: renderRun,
})

export const runStepRun = defineCommand({
  path: ['run', 'step-run'],
  summary: 'Manual mode: run one ready step.',
  kind: 'spend',
  positionals: [
    { name: 'id', required: true },
    { name: 'stepId', required: true },
  ],
  input: z.object({ id: runId, stepId: z.number().int().positive().describe('The step’s numeric id (from `zetta run get`).'), ...spendShape }),
  async run(ctx, input) {
    const client = await ctx.client()
    const run = await client.runs.get(input.id)
    const decision = await authorizeSpend(ctx, remaining(run), input, `A step of run #${input.id}`)
    if (!decision.go) return { dryRun: true, ...remaining(run) }
    return summarizeRun(await client.runs.runStep(input.id, input.stepId))
  },
  text: (r: RunSummary | { dryRun: true; credits: number }) => ('dryRun' in r ? `Up to ${r.credits} credits (nothing was spent).` : renderRun(r)),
})

export const runStepRetry = defineCommand({
  path: ['run', 'step-retry'],
  summary: 'Retry a failed step, optionally with changed settings.',
  kind: 'spend',
  positionals: [
    { name: 'id', required: true },
    { name: 'stepId', required: true },
  ],
  input: z.object({
    id: runId,
    stepId: z.number().int().positive().describe('The failed step’s numeric id.'),
    set: z.array(z.string()).optional().describe('Changed settings as key=value (friendly names).'),
    ...spendShape,
  }),
  async run(ctx, input) {
    const client = await ctx.client()
    const run = await client.runs.get(input.id)
    const step = run.steps.find((s) => s.id === input.stepId)
    if (!step) throw new ZettaError({ code: 'NOT_FOUND', message: `Run #${input.id} has no step ${input.stepId}.`, status: 404 })
    let body: { settings?: Record<string, unknown>; request?: Record<string, unknown> } = {}
    if (input.set?.length) {
      const fields = Object.fromEntries(input.set.map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]))
      const change = P.runNodeChange(P.parseGraph(run.graph), step.nodeId, fields)
      if (!change.ok) throw new ZettaError({ code: 'USAGE', message: change.problems.map((p) => p.message).join(' '), details: { problems: change.problems } })
      body = change.body
    }
    const price = { credits: step.credits ?? 0, lines: [{ code: step.nodeId, label: `Retry ${step.nodeId}`, credits: step.credits ?? 0 }] }
    const decision = await authorizeSpend(ctx, price, input, `Retrying ${step.nodeId}`)
    if (!decision.go) return { dryRun: true, ...price }
    return summarizeRun(await client.runs.retryStep(input.id, input.stepId, body))
  },
  text: (r: RunSummary | { dryRun: true; credits: number }) => ('dryRun' in r ? `About ${r.credits} credits (nothing was spent).` : renderRun(r)),
})

export const runConfirmParts = defineCommand({
  path: ['run', 'confirm-parts'],
  summary: 'Choose which isolated parts to keep (Isolate Parts review).',
  kind: 'write',
  positionals: [
    { name: 'id', required: true },
    { name: 'stepId', required: true },
  ],
  input: z.object({
    id: runId,
    stepId: z.number().int().positive().describe('The Isolate Parts step’s numeric id.'),
    keys: z.array(z.string()).min(1).describe('Part keys to keep (shown in the step’s review).'),
    extra: z.array(z.string()).optional().describe('Extra parts to ask for, by name.'),
  }),
  async run(ctx, input) {
    return summarizeRun(await (await ctx.client()).runs.confirmParts(input.id, input.stepId, { keys: input.keys, ...(input.extra?.length ? { extraParts: input.extra } : {}) }))
  },
  text: renderRun,
})

export const runDelete = defineCommand({
  path: ['run', 'delete'],
  summary: 'Delete a run record (its models stay in your library).',
  kind: 'destructive',
  positionals: [{ name: 'id', required: true }],
  input: z.object({ id: runId, yes: z.boolean().optional().describe('Delete without asking.') }),
  async run(ctx, input) {
    if (!input.yes && !(ctx.interactive && (await ctx.confirm(`Delete run #${input.id}?`)))) {
      throw usageError(ctx.interactive ? 'Cancelled.' : 'Pass --yes to delete without a terminal.')
    }
    await (await ctx.client()).runs.delete(input.id)
    return { deleted: input.id }
  },
  text: (r: { deleted: number }) => `Deleted run #${r.deleted}.`,
})

export const runCommands = [runGet, runWait, runOutputs, runStart, runPause, runResume, runContinue, runCancel, runMode, runSetInput, runStepRun, runStepRetry, runConfirmParts, runDelete]
