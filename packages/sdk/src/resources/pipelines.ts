import { LocalErrorCodes, ZettaError } from '../errors'
import type { Transport } from '../transport'

/** A pipeline graph as the API stores it (see `pipeline/` for the full typed model and validation). */
export interface GraphPayload {
  version: number
  nodes: Array<Record<string, unknown>>
  edges: Array<Record<string, unknown>>
}

export interface PipelineSummary {
  id: number
  title: string | null
  steps: number
  createdAt: string
  updatedAt: string
  lastRun: { id: number; status: string; createdAt: string } | null
  runCounts: Record<string, number>
}

export interface PipelineRecord {
  id: number
  title: string | null
  graph: GraphPayload
  problems: Array<{ nodeId?: string; message: string }>
  createdAt: string
  updatedAt: string
  [key: string]: unknown
}

export interface PipelineEstimate {
  credits: number
  lines: Array<{ nodeId: string; credits: number; count: number }>
  perPart: unknown
  problems: Array<{ nodeId?: string; message: string }>
}

export type RunStatus = 'draft' | 'running' | 'awaiting' | 'paused' | 'failed' | 'done' | 'cancelled'
export type StepStatus = 'waiting' | 'ready' | 'running' | 'submitted' | 'review' | 'success' | 'failed' | 'cancelled'
export type RunMode = 'auto' | 'manual'

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['done', 'failed', 'cancelled']

export interface RunStep {
  id: number
  nodeId: string
  partKey: string | null
  status: StepStatus
  attempt: number
  credits: number | null
  errorMessage: string | null
  gen3dPostId: number | null
  output: unknown
  review: unknown
  generation?: Record<string, unknown> | null
  [key: string]: unknown
}

export interface PipelineRun {
  id: number
  pipelineId: number
  mode: RunMode
  status: RunStatus
  paused?: boolean
  seed: unknown
  estimatedCredits: number | null
  spentCredits: number | null
  graph: GraphPayload
  steps: RunStep[]
  createdAt: string
  finishedAt?: string | null
  [key: string]: unknown
}

export type RunSeed = { uploadKey: string; name?: string } | { gen2dPostId: number } | { gen3dPostId: number }

export interface RunWaitOptions {
  intervalMs?: number
  timeoutMs?: number
  signal?: AbortSignal
  /** Stop waiting when the run needs a person (manual review, draft input, paused). Default true. */
  stopWhenBlocked?: boolean
  onUpdate?: (run: PipelineRun) => void
}

export class Pipelines {
  constructor(private readonly transport: Transport) {}

  list(): Promise<PipelineSummary[]> {
    return this.transport.request('GET', '/pipelines')
  }

  get(id: number): Promise<PipelineRecord> {
    return this.transport.request('GET', `/pipelines/${id}`)
  }

  create(input: { title?: string; graph?: GraphPayload }): Promise<PipelineRecord> {
    return this.transport.request('POST', '/pipelines', { body: input, retry: 'never' })
  }

  update(id: number, input: { title?: string; graph?: GraphPayload }): Promise<PipelineRecord> {
    return this.transport.request('PATCH', `/pipelines/${id}`, { body: input })
  }

  delete(id: number): Promise<void> {
    return this.transport.request('DELETE', `/pipelines/${id}`)
  }

  duplicate(id: number): Promise<PipelineRecord> {
    return this.transport.request('POST', `/pipelines/${id}/duplicate`, { retry: 'never' })
  }

  /** Prices a graph and lists its problems, without saving or running anything. */
  estimate(graph: GraphPayload): Promise<PipelineEstimate> {
    return this.transport.request('POST', '/pipelines/estimate', { body: { graph } })
  }

  runs(pipelineId: number): Promise<Array<Record<string, unknown>>> {
    return this.transport.request('GET', `/pipelines/${pipelineId}/runs`)
  }

  /** Starts one run on the pipeline's own seed. Passing `graph` saves it first. */
  startRun(pipelineId: number, input: { mode: RunMode; graph?: GraphPayload }): Promise<PipelineRun> {
    return this.transport.request('POST', `/pipelines/${pipelineId}/runs`, { body: input, retry: 'never' })
  }

  /** One run per seed (1–20). `draft: true` creates runs that wait for per-run input before starting. */
  batch(
    pipelineId: number,
    input: { mode: RunMode; seeds: RunSeed[]; graph?: GraphPayload; draft?: boolean },
  ): Promise<{ runs: Array<{ id: number; mode: RunMode; status: RunStatus; [key: string]: unknown }> }> {
    return this.transport.request('POST', `/pipelines/${pipelineId}/batch`, { body: input, retry: 'never' })
  }
}

export class Runs {
  constructor(
    private readonly transport: Transport,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  get(runId: number): Promise<PipelineRun> {
    return this.transport.request('GET', `/pipeline-runs/${runId}`)
  }

  delete(runId: number): Promise<void> {
    return this.transport.request('DELETE', `/pipeline-runs/${runId}`)
  }

  start(runId: number): Promise<PipelineRun> {
    return this.post(runId, 'start')
  }

  pause(runId: number): Promise<PipelineRun> {
    return this.post(runId, 'pause')
  }

  resume(runId: number): Promise<PipelineRun> {
    return this.post(runId, 'resume')
  }

  cancel(runId: number): Promise<PipelineRun> {
    return this.post(runId, 'cancel')
  }

  /** In manual mode, runs every step that is ready. */
  runWaiting(runId: number): Promise<PipelineRun> {
    return this.post(runId, 'run-waiting')
  }

  setMode(runId: number, mode: RunMode): Promise<PipelineRun> {
    return this.transport.request('POST', `/pipeline-runs/${runId}/mode`, { body: { mode }, retry: 'never' })
  }

  /** Per-run settings for a step that has not run yet (e.g. a draft's texture prompt). */
  setNode(runId: number, nodeId: string, input: { request?: Record<string, unknown>; settings?: Record<string, unknown> }): Promise<PipelineRun> {
    return this.transport.request('PATCH', `/pipeline-runs/${runId}/nodes/${encodeURIComponent(nodeId)}`, { body: input })
  }

  runStep(runId: number, stepId: number): Promise<PipelineRun> {
    return this.transport.request('POST', `/pipeline-runs/${runId}/steps/${stepId}/run`, { retry: 'never' })
  }

  retryStep(runId: number, stepId: number, input: { request?: Record<string, unknown>; settings?: Record<string, unknown> } = {}): Promise<PipelineRun> {
    return this.transport.request('POST', `/pipeline-runs/${runId}/steps/${stepId}/retry`, { body: input, retry: 'never' })
  }

  /** Confirms an Isolate Parts review in manual mode. */
  confirmParts(runId: number, stepId: number, input: { keys: string[]; extraParts?: string[] }): Promise<PipelineRun> {
    return this.transport.request('POST', `/pipeline-runs/${runId}/steps/${stepId}/parts`, { body: input, retry: 'never' })
  }

  /** Polls until the run is done, failed or cancelled — or, by default, until it needs a person. */
  async wait(runId: number, options: RunWaitOptions = {}): Promise<PipelineRun> {
    const interval = options.intervalMs ?? 3000
    const stopWhenBlocked = options.stopWhenBlocked ?? true
    const deadline = options.timeoutMs === undefined ? Infinity : Date.now() + options.timeoutMs
    for (;;) {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error('Aborted')
      let run: PipelineRun | undefined
      try {
        run = await this.get(runId)
      } catch (error) {
        if (error instanceof ZettaError && (error.status === 404 || error.status === 401 || error.status === 403)) throw error
      }
      if (run) {
        options.onUpdate?.(run)
        if (TERMINAL_RUN_STATUSES.includes(run.status)) return run
        if (stopWhenBlocked && isBlocked(run)) return run
      }
      if (Date.now() + interval > deadline) {
        throw new ZettaError({
          code: LocalErrorCodes.WAIT_TIMEOUT,
          message: `Stopped waiting for run #${runId}; it is still going.`,
          details: { runId, status: run?.status ?? null },
        })
      }
      await this.sleep(interval)
    }
  }

  private post(runId: number, action: string): Promise<PipelineRun> {
    return this.transport.request('POST', `/pipeline-runs/${runId}/${action}`, { retry: 'never' })
  }
}

/** True when a run cannot move on without someone acting: a draft, a pause, or a step awaiting review. */
export function isBlocked(run: Pick<PipelineRun, 'status' | 'paused' | 'steps'>): boolean {
  if (run.status === 'draft' || run.status === 'paused' || run.status === 'awaiting' || run.paused) return true
  return run.steps?.some((step) => step.status === 'review') ?? false
}
