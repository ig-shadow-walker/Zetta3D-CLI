/**
 * 3D PIPELINES — the shapes the API stores and returns, and the bodies it takes.
 *
 * A pipeline is a recipe: nodes that are the Studio's own tools, wired from ONE seed (a picture or a
 * model) to the steps that follow. Each node keeps two things: `settings` (the editor's form state,
 * which the engine never reads) and `request` (what that form builds for the API, minus its inputs —
 * the only thing the engine reads). `requestFor` builds the second from the first.
 *
 * Mirrors the backend's `pipeline-graph.ts`, `pipeline-plan.ts`, the pipeline DTOs and what
 * `pipelines.service.ts` returns. Fields the server may add later are tolerated.
 */

export const PIPELINE_GRAPH_VERSION = 1

/** What travels along a connection. */
export type PortType = 'picture' | 'views' | 'mesh' | 'splat' | 'file'

export const ALL_NODE_KINDS = [
  'seed_picture',
  'seed_model',
  'remove_background',
  'ai_edit',
  'draw_views',
  'isolate_parts',
  'generate_3d',
  'generate_smart_3d',
  'generate_splat',
  'retopology',
  'segmentation',
  'smart_segmentation',
  'texture',
  'smart_uv',
  'rigging',
  'export',
] as const
export type NodeKind = (typeof ALL_NODE_KINDS)[number]

export interface PipelineNode {
  id: string
  kind: NodeKind
  position: { x: number; y: number }
  /** The editor form's own state. Never read by the engine. */
  settings?: Record<string, unknown>
  /** What the node's form builds for the API, minus its inputs — the only thing the engine reads. */
  request?: Record<string, unknown>
  /** A name the user gave it, shown on the canvas (at most 80 characters). */
  label?: string
}

export interface PipelineEdge {
  id: string
  source: string
  sourceHandle: string
  target: string
  targetHandle: string
}

export interface PipelineGraph {
  version: number
  nodes: PipelineNode[]
  edges: PipelineEdge[]
}

/**
 * Something wrong with a graph, a document or a run's inputs.
 *
 * `code` is stable and machine-readable; `message` is for people. `nodeId` names the step it is about
 * (absent for the graph as a whole) and `field` the setting, in the friendly document's names.
 */
export interface Problem {
  code: string
  nodeId?: string
  field?: string
  message: string
}

/** A problem as the server sends it (`problems` on a pipeline, an estimate or a refused run). */
export interface ServerGraphProblem {
  nodeId: string | null
  message: string
}

/** Error codes the pipeline endpoints put on a 400 body (`{ message, code, problems? }`). */
export const PIPELINE_ERROR_CODES = {
  /** Starting a run (or a batch) on a graph that has problems. `problems` lists them. */
  notRunnable: 'PIPELINE_NOT_RUNNABLE',
  /** Starting a draft run while a step still needs its per-run input. `problems` lists them. */
  needsInput: 'RUN_NEEDS_INPUT',
  /** Auto mode, and the balance does not cover the estimate. Carries `required` and `available`. */
  insufficientCredits: 'INSUFFICIENT_CREDITS',
} as const

/** The 400 body of a refused run. */
export interface PipelineRunRefusal {
  message: string
  code: (typeof PIPELINE_ERROR_CODES)[keyof typeof PIPELINE_ERROR_CODES] | string
  problems?: ServerGraphProblem[]
  required?: number
  available?: number
}

/* ---------------------------------------------------------------------------------- runs */

/** Auto runs every step as soon as its input arrives; Manual waits for a press before each one. */
export type RunMode = 'auto' | 'manual'

/**
 * `draft`: made but not started — the user gives the steps that take a fresh input on each run, then
 * presses Start.
 */
export type RunStatus = 'draft' | 'running' | 'awaiting' | 'paused' | 'failed' | 'done' | 'cancelled'

export const RUN_STATUSES: readonly RunStatus[] = ['draft', 'running', 'awaiting', 'paused', 'failed', 'done', 'cancelled']

export type StepStatus =
  /** Manual mode: due, waiting for the user's Run. */
  | 'waiting'
  /** Due and approved; the server will start it. */
  | 'ready'
  | 'running'
  /** A 3D job is queued; the server watches it. */
  | 'submitted'
  /** Isolate Parts in Manual mode: parts found, waiting for the user to confirm them. */
  | 'review'
  | 'success'
  | 'failed'
  | 'cancelled'

export const STEP_STATUSES: readonly StepStatus[] = [
  'waiting',
  'ready',
  'running',
  'submitted',
  'review',
  'success',
  'failed',
  'cancelled',
]

/** Steps the server is working on. */
export const ACTIVE_STEP_STATUSES: readonly StepStatus[] = ['ready', 'running', 'submitted']
/** Steps waiting for the user. */
export const AWAITING_STEP_STATUSES: readonly StepStatus[] = ['waiting', 'review']

/** Whether a run is still moving (worth polling). */
export function isLive(status: RunStatus): boolean {
  return status === 'running' || status === 'paused' || status === 'awaiting'
}

/** Whether a run is over: nothing more will happen unless a step is retried. */
export function isFinished(status: RunStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled'
}

/**
 * What one run starts from — the seed node's request for that run: an uploaded picture (the key the
 * upload relay returned, and its file name), a picture from the Image library, or a model from the 3D
 * library.
 */
export type Seed = { uploadKey: string; name?: string } | { gen2dPostId: number } | { gen3dPostId: number }

/** A picture as a run returns it: a short-lived signed URL, and its library row when it is one. */
export interface SignedPicture {
  url: string
  gen2dPostId: number | null
}

export interface IdentifiedPart {
  key: string
  label: string
  kind: 'held' | 'attached' | 'detail'
  level: 'low' | 'medium' | 'high'
  box: [number, number, number, number] | null
}

export type StepOutput =
  | { type: 'picture'; picture: SignedPicture | null }
  | { type: 'views'; views: Array<{ viewType: string; picture: SignedPicture | null }> }
  | { type: 'mesh'; gen3dPostId: number }
  | { type: 'splat'; gen3dPostId: number }
  | { type: 'file'; gen3dPostId: number; format: string }
  | {
      type: 'isolated'
      character: SignedPicture | null
      parts: Array<{
        key: string
        label: string
        kind: string
        box: [number, number, number, number] | null
        picture: SignedPicture | null
      }>
    }

/** One node's work in one run — one per part downstream of Isolate Parts' `each`. */
export interface PipelineStep {
  id: number
  nodeId: string
  /** '' for the one instance; `sword`, `knight/sword` … downstream of Isolate Parts' `each`. */
  partKey: string
  status: StepStatus
  attempt: number
  credits: number
  errorMessage: string | null
  /** The 3D job it made, while and after it runs. */
  gen3dPostId: number | null
  output: StepOutput | null
  /** Isolate Parts waiting for the user: what it found, what it proposes, and the picture it read. */
  review: {
    identification: { subject: string; humanoid: boolean; parts: IdentifiedPart[] } | null
    proposedKeys: string[]
    source: SignedPicture | null
  } | null
  /** The 3D job's generation, as `GET /3d/generations/:id` shapes it. */
  generation: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
}

export interface PipelineRun {
  id: number
  pipelineId: number
  mode: RunMode
  status: RunStatus
  /** The user paused it. `status` says what that means right now. */
  paused: boolean
  /** What it started from: `{ type: 'picture' | 'model', ...the seed }`. */
  seed: Record<string, unknown> | null
  estimatedCredits: number
  spentCredits: number
  /** The run's own copy of the graph, made when it was created. */
  graph: PipelineGraph
  createdAt: string
  updatedAt: string
  finishedAt: string | null
  steps: PipelineStep[]
}

/** A run as `GET /pipelines/:id/runs` lists it. */
export interface PipelineRunSummary {
  id: number
  mode: RunMode
  status: RunStatus
  paused: boolean
  estimatedCredits: number
  spentCredits: number
  createdAt: string
  finishedAt: string | null
  progress: { done: number; total: number; waiting: number; failed: number }
  /** A draft's steps still to fill in before it can start. */
  inputsNeeded?: number
  seed: { type: 'picture' | 'model'; name: string | null; thumbnailUrl: string | null } | null
}

/** One run as `POST /pipelines/:id/batch` returns it. */
export interface BatchRun {
  id: number
  mode: RunMode
  status: RunStatus
  estimatedCredits: number
  createdAt: string
  finishedAt: string | null
}

export interface BatchResponse {
  runs: BatchRun[]
}

/* ----------------------------------------------------------------------------- pipelines */

export interface Pipeline {
  id: number
  title: string
  graph: PipelineGraph
  createdAt: string
  updatedAt: string
  /** What stops it running, as the server sees it. Empty means runnable (seed aside, when chosen per run). */
  problems: ServerGraphProblem[]
}

/** A pipeline as `GET /pipelines` lists it. */
export interface PipelineSummary {
  id: number
  title: string
  steps: number
  createdAt: string
  updatedAt: string
  lastRun: { id: number; status: RunStatus; createdAt: string } | null
  /** How many of its runs are in each state. */
  runCounts?: Partial<Record<RunStatus, number>>
}

export interface PipelineEstimate {
  /** The most one run can cost. */
  credits: number
  lines: Array<{ nodeId: string; credits: number; count: number }>
  /** Some steps run once per part: the total assumes every isolation reaches Max parts. */
  perPart: boolean
  problems: ServerGraphProblem[]
}

/* ------------------------------------------------------------------------- request bodies */

/** `POST /pipelines`. An absent graph makes an empty one; an absent title is "Untitled pipeline". */
export interface CreatePipelineBody {
  /** At most 200 characters. */
  title?: string
  graph?: PipelineGraph
}

/** `PATCH /pipelines/:id`. */
export interface UpdatePipelineBody {
  title?: string
  graph?: PipelineGraph
}

/** `POST /pipelines/estimate`: prices and checks a graph; nothing is saved. */
export interface EstimatePipelineBody {
  graph: PipelineGraph
}

/** `POST /pipelines/:id/runs`: one run on the graph's own seed. The graph, when sent, is saved first. */
export interface StartRunBody {
  mode: RunMode
  graph?: PipelineGraph
}

/** `POST /pipelines/:id/batch`: one run per seed (1 to 20). `draft` makes them without starting them. */
export interface StartBatchBody {
  mode: RunMode
  seeds: Seed[]
  graph?: PipelineGraph
  draft?: boolean
}

/** `POST /pipeline-runs/:runId/mode`. */
export interface RunModeBody {
  mode: RunMode
}

/** `PATCH /pipeline-runs/:runId/nodes/:nodeId`: a step's settings for this run only, before it has run. */
export interface PatchRunNodeBody {
  request?: Record<string, unknown>
  settings?: Record<string, unknown>
}

/** `POST /pipeline-runs/:runId/steps/:stepId/retry`: a failed step again, optionally with new settings. */
export interface RetryStepBody {
  request?: Record<string, unknown>
  settings?: Record<string, unknown>
}

/** `POST /pipeline-runs/:runId/steps/:stepId/parts`: the parts chosen in review (at most 16, 80 characters each). */
export interface ConfirmPartsBody {
  keys: string[]
  extraParts?: string[]
}

/** Limits the server enforces. */
export const PIPELINE_LIMITS = {
  maxSteps: 200,
  maxTitle: 200,
  maxLabel: 80,
  maxNodeId: 64,
  maxBatchSeeds: 20,
  maxParts: 16,
  maxPartLabel: 80,
} as const

/** The prefix of Isolate Parts' per-part outputs: `part:<key>`. */
export const PART_HANDLE_PREFIX = 'part:'
