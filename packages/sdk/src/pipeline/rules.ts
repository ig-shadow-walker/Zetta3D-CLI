/**
 * THE GRAPH'S RULES — what may connect, what stops a graph from running, what a run asks for, and what
 * may go wrong once it runs. Ports of the backend's `graphProblems` / `runInputProblems` / `parseGraph`
 * (`pipeline-graph.ts`) and the web editor's copies (`lib/pipelines.ts`, `node-config.ts`), merged so
 * nothing the server would refuse is missed and nothing the editor allows is refused.
 */
import { NODE_KINDS, inputPort, isMultiViewGenerate, isNodeKind, isSeed, outputType } from './catalogue'
import { effectiveSettings, settingNotes, withKnownRigSpecRequest } from './settings'
import { SMART_UV_MAX_TRIANGLES } from './tool-settings'
import { formatCount } from './generate-form'
import { incomingType, nodeProblems, withRequests, type NodeContext } from './request'
import {
  PIPELINE_GRAPH_VERSION,
  PIPELINE_LIMITS,
  VIEW_TYPES,
  type NodeKind,
  type PipelineEdge,
  type PipelineGraph,
  type PipelineNode,
  type Problem,
  type ServerGraphProblem,
} from './types'

/** Problem codes, stable across versions. */
export const PROBLEM_CODES = {
  graphTooLarge: 'GRAPH_TOO_LARGE',
  unknownKind: 'UNKNOWN_KIND',
  duplicateId: 'DUPLICATE_ID',
  noSeed: 'NO_SEED',
  extraSeed: 'EXTRA_SEED',
  edgeDangling: 'EDGE_DANGLING',
  unknownHandle: 'UNKNOWN_HANDLE',
  portMismatch: 'PORT_MISMATCH',
  inputTaken: 'INPUT_TAKEN',
  inputNotConnected: 'INPUT_NOT_CONNECTED',
  cycle: 'CYCLE',
  engineMissing: 'ENGINE_MISSING',
  promptMissing: 'PROMPT_MISSING',
  formatMissing: 'FORMAT_MISSING',
  seedNotChosen: 'SEED_NOT_CHOSEN',
  settingInvalid: 'SETTING_INVALID',
  aiEditPromptMissing: 'AI_EDIT_PROMPT_MISSING',
  textureInputMissing: 'TEXTURE_INPUT_MISSING',
  viewsInputMissing: 'VIEWS_INPUT_MISSING',
  seedsCount: 'SEEDS_COUNT',
  seedInvalid: 'SEED_INVALID',
  serverProblem: 'SERVER_PROBLEM',
} as const

/** Warning codes (`graphWarnings`). */
export const WARNING_CODES = {
  legacyKind: 'LEGACY_KIND',
  legacyInput: 'LEGACY_INPUT',
  unknownValue: 'UNKNOWN_VALUE',
  rigSpecReplaced: 'RIG_SPEC_REPLACED',
  smartUvTriangles: 'SMART_UV_TRIANGLES',
  noViews: 'NO_VIEWS',
  /** A step names an engine that was retired (Zetta N1): a generation on it fails; a retopology runs on Zetta R1. */
  engineRetired: 'ENGINE_RETIRED',
} as const

/* -------------------------------------------------------------------------- graph helpers */

/** Node ids in an order where every node comes after the one feeding it. Null when there is a loop. */
export function topologicalOrder(graph: PipelineGraph): string[] | null {
  const incoming = new Map<string, number>()
  for (const node of graph.nodes) incoming.set(node.id, 0)
  for (const edge of graph.edges) {
    if (incoming.has(edge.target)) incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1)
  }
  const queue = graph.nodes.filter((node) => incoming.get(node.id) === 0).map((node) => node.id)
  const order: string[] = []
  while (queue.length) {
    const id = queue.shift()!
    order.push(id)
    for (const edge of graph.edges) {
      if (edge.source !== id || !incoming.has(edge.target)) continue
      const left = (incoming.get(edge.target) ?? 0) - 1
      incoming.set(edge.target, left)
      if (left === 0) queue.push(edge.target)
    }
  }
  return order.length === graph.nodes.length ? order : null
}

/** Where each step comes in a run, 1 first, the seed uncounted. A graph with a loop falls back to node order. */
export function stepPositions(graph: PipelineGraph): Map<string, number> {
  const order = topologicalOrder(graph) ?? graph.nodes.map((node) => node.id)
  const kinds = new Map(graph.nodes.map((node) => [node.id, node.kind as string]))
  const steps = order.filter((id) => {
    const kind = kinds.get(id)
    return kind !== undefined && !(isNodeKind(kind) && isSeed(kind))
  })
  return new Map(steps.map((id, index) => [id, index + 1]))
}

/** The nodes that run once per part — everything downstream of an Isolate Parts `each`. */
export function fanOutNodes(graph: PipelineGraph): Set<string> {
  const result = new Set<string>()
  const visit = (nodeId: string) => {
    for (const edge of graph.edges) {
      if (edge.source !== nodeId || result.has(edge.target)) continue
      result.add(edge.target)
      visit(edge.target)
    }
  }
  for (const edge of graph.edges) {
    if (edge.sourceHandle !== 'each' || result.has(edge.target)) continue
    result.add(edge.target)
    visit(edge.target)
  }
  return result
}

/** The node feeding this one's input. */
export function sourceOf(graph: PipelineGraph, nodeId: string, handle = 'in'): PipelineNode | null {
  const edge = graph.edges.find((candidate) => candidate.target === nodeId && candidate.targetHandle === handle)
  return edge ? (graph.nodes.find((node) => node.id === edge.source) ?? null) : null
}

function reaches(graph: PipelineGraph, from: string, to: string): boolean {
  const seen = new Set<string>()
  const stack = [from]
  while (stack.length) {
    const id = stack.pop()!
    if (id === to) return true
    if (seen.has(id)) continue
    seen.add(id)
    for (const edge of graph.edges) if (edge.source === id) stack.push(edge.target)
  }
  return false
}

/** Whether a connection from this output into that input would be allowed: the types match and it makes no loop. */
export function canConnect(
  graph: PipelineGraph,
  connection: { source: string; sourceHandle: string; target: string; targetHandle: string },
): boolean {
  if (connection.source === connection.target) return false
  const source = graph.nodes.find((node) => node.id === connection.source)
  const target = graph.nodes.find((node) => node.id === connection.target)
  if (!source || !target) return false
  const carries = outputType(source.kind, connection.sourceHandle)
  const port = inputPort(target.kind, connection.targetHandle)
  if (!carries || !port || !port.accepts.includes(carries)) return false
  return !reaches(graph, connection.target, connection.source)
}

/** The multi-view step for a one-picture generation, and back. */
const MULTI_VIEW_OF: Partial<Record<NodeKind, NodeKind>> = {
  generate_3d: 'generate_3d_multiview',
  generate_smart_3d: 'generate_smart_3d_multiview',
}
const ONE_PICTURE_OF: Partial<Record<NodeKind, NodeKind>> = {
  generate_3d_multiview: 'generate_3d',
  generate_smart_3d_multiview: 'generate_smart_3d',
}

/**
 * Why a connection's types do not match, in the server's words: a one-picture generation fed views
 * names its multi-view step, and the other way round.
 */
export function mismatchMessage(kind: string, carries: string, accepts: readonly string[]): string {
  const label = (of: NodeKind) => NODE_KINDS[of].label
  const multi = isNodeKind(kind) ? MULTI_VIEW_OF[kind] : undefined
  const single = isNodeKind(kind) ? ONE_PICTURE_OF[kind] : undefined
  if (multi && carries === 'views') {
    return `${label(kind as NodeKind)} takes one picture. For pictures of each side, use ${label(multi)}.`
  }
  if (single && carries === 'picture') {
    return `${label(kind as NodeKind)} takes pictures of each side — connect a Multi-view seed or Draw views, or use ${label(single)} for one picture.`
  }
  return `This input takes a ${accepts.join(' or ')}, not a ${carries}.`
}

/**
 * A GENERATION FED VIEWS BECOMES ITS MULTI-VIEW STEP — the server's `withMultiViewSteps`, applied when
 * it reads any graph. A graph made before the multi-view steps existed (Draw views into Generate 3D),
 * or one still built that way, keeps working: the step becomes the kind that takes what it is given,
 * with every setting it had. AI texturing in its first multi-view mode (`referenceMode: multi-view`)
 * becomes Multi-view - AI texturing.
 */
export function withMultiViewSteps(graph: PipelineGraph): PipelineGraph {
  const kinds = new Map(graph.nodes.map((node) => [node.id, node.kind as string]))
  const fedViews = new Set(
    graph.edges
      .filter((edge) => {
        const source = kinds.get(edge.source)
        return edge.targetHandle === 'in' && source !== undefined && outputType(source, edge.sourceHandle) === 'views'
      })
      .map((edge) => edge.target),
  )
  const multiViewTexture = (node: PipelineNode) =>
    node.kind === 'texture' && (node.request?.referenceMode === 'multi-view' || node.settings?.referenceMode === 'multi-view')
  if (!fedViews.size && !graph.nodes.some(multiViewTexture)) return graph
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const multi = fedViews.has(node.id) && isNodeKind(node.kind) ? MULTI_VIEW_OF[node.kind] : undefined
      if (multi) return { ...node, kind: multi }
      if (multiViewTexture(node)) return { ...node, kind: 'texture_multiview' as const }
      return node
    }),
  }
}

/**
 * Whether a step's input is given on each run rather than kept in the pipeline: AI texturing — one
 * picture or pictures of each side — always (as the editor treats it), AI edit when its `askAtRun`
 * is on. `perRunIn` also knows the graph.
 */
export function setOnEachRun(node: Pick<PipelineNode, 'kind' | 'settings'>): boolean {
  return (
    node.kind === 'texture' ||
    node.kind === 'texture_multiview' ||
    (node.kind === 'ai_edit' && node.settings?.askAtRun === true)
  )
}

/** `setOnEachRun`, knowing the graph: Multi-view - AI texturing with views wired in asks nothing of a run. */
export function perRunIn(graph: PipelineGraph, node: Pick<PipelineNode, 'id' | 'kind' | 'settings'>): boolean {
  if (node.kind === 'texture_multiview' && graph.edges.some((edge) => edge.target === node.id && edge.targetHandle === 'views')) {
    return false
  }
  return setOnEachRun(node)
}

/** One picture of a multi-view set as the server reads it (`readViews`): a known side, placed. */
function readViews(value: unknown): Array<{ viewType: string }> {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const views: Array<{ viewType: string }> = []
  for (const entry of value as Array<Record<string, unknown> | null>) {
    const viewType = typeof entry?.viewType === 'string' ? entry.viewType : ''
    if (!(VIEW_TYPES as readonly string[]).includes(viewType) || seen.has(viewType)) continue
    if (typeof entry?.uploadKey !== 'string' && typeof entry?.gen2dPostId !== 'number') continue
    seen.add(viewType)
    views.push({ viewType })
  }
  return views
}

/** Whether a multi-view set, as the server reads it, has its front. */
export function hasFront(views: unknown): boolean {
  return readViews(views).some((view) => view.viewType === 'front')
}

const text = (value: unknown) => typeof value === 'string' && value.trim() !== ''

/* ---------------------------------------------------------------------------- validation */

export interface ValidateOptions extends Omit<NodeContext, 'incoming'> {
  /**
   * Ask for the seed's own picture or model too — for a run started on the graph's own seed
   * (`POST /pipelines/:id/runs`). Off by default: a batch gives each run its seed.
   */
  requireSeedAsset?: boolean
}

/**
 * Everything that stops a graph from running, each said once and pinned to its step. AN EMPTY LIST
 * MEANS RUNNABLE (given its seeds, and the per-run inputs `runInputProblems` names).
 *
 * Requests are rebuilt from settings first, as the editor does before saving; a node with no
 * settings is judged on the request it has, as the server judges it.
 */
export function validateGraph(graph: PipelineGraph, options: ValidateOptions = {}): Problem[] {
  const built = withRequests(graph, options)
  const problems: Problem[] = []
  const byId = new Map(built.nodes.map((node) => [node.id, node]))

  if (built.nodes.length > PIPELINE_LIMITS.maxSteps) {
    problems.push({ code: PROBLEM_CODES.graphTooLarge, message: 'A pipeline holds at most 200 steps.' })
  }

  const ids = new Set<string>()
  for (const node of built.nodes) {
    if (!isNodeKind(node.kind)) {
      problems.push({ code: PROBLEM_CODES.unknownKind, nodeId: node.id, message: 'This step is not one Zetta runs.' })
    }
    if (ids.has(node.id)) {
      problems.push({ code: PROBLEM_CODES.duplicateId, nodeId: node.id, message: 'Two steps share one id.' })
    }
    ids.add(node.id)
  }

  const seeds = built.nodes.filter((node) => isNodeKind(node.kind) && isSeed(node.kind))
  if (seeds.length === 0) {
    problems.push({ code: PROBLEM_CODES.noSeed, message: 'Add a seed — the picture or model the pipeline starts from.' })
  }
  for (const seed of seeds.slice(1)) {
    problems.push({ code: PROBLEM_CODES.extraSeed, nodeId: seed.id, message: 'A pipeline starts from one seed.' })
  }

  const filled = new Set<string>()
  for (const edge of built.edges) {
    const source = byId.get(edge.source)
    const target = byId.get(edge.target)
    if (!source || !target || !isNodeKind(source.kind) || !isNodeKind(target.kind)) {
      problems.push({ code: PROBLEM_CODES.edgeDangling, message: 'A connection points at a step that is gone.' })
      continue
    }
    const carries = outputType(source.kind, edge.sourceHandle)
    const port = inputPort(target.kind, edge.targetHandle)
    if (!carries || !port) {
      problems.push({
        code: PROBLEM_CODES.unknownHandle,
        nodeId: target.id,
        message: 'A connection uses a socket this step does not have.',
      })
      continue
    }
    if (!port.accepts.includes(carries)) {
      problems.push({ code: PROBLEM_CODES.portMismatch, nodeId: target.id, message: mismatchMessage(target.kind, carries, port.accepts) })
    }
    const slot = `${edge.target}:${edge.targetHandle}`
    if (filled.has(slot)) {
      problems.push({ code: PROBLEM_CODES.inputTaken, nodeId: target.id, message: 'An input takes one connection.' })
    }
    filled.add(slot)
  }

  for (const node of built.nodes) {
    if (!isNodeKind(node.kind)) continue
    for (const port of NODE_KINDS[node.kind].inputs) {
      if (port.required && !filled.has(`${node.id}:${port.handle}`)) {
        problems.push({
          code: PROBLEM_CODES.inputNotConnected,
          nodeId: node.id,
          message: 'Connect this step to the one before it.',
        })
      }
    }
  }

  if (topologicalOrder(built) === null) {
    problems.push({ code: PROBLEM_CODES.cycle, message: 'The pipeline loops back on itself.' })
  }

  for (const node of built.nodes) {
    if (!isNodeKind(node.kind)) continue
    const request = node.request ?? {}
    if (isSeed(node.kind)) {
      if (!options.requireSeedAsset) continue
      if (node.kind === 'seed_picture' && !(typeof request.uploadKey === 'string' || typeof request.gen2dPostId === 'number')) {
        problems.push({
          code: PROBLEM_CODES.seedNotChosen,
          nodeId: node.id,
          message: 'Choose the picture this pipeline starts from.',
        })
      }
      if (node.kind === 'seed_model' && typeof request.gen3dPostId !== 'number') {
        problems.push({
          code: PROBLEM_CODES.seedNotChosen,
          nodeId: node.id,
          message: 'Choose the model this pipeline starts from.',
        })
      }
      if (node.kind === 'seed_views' && !hasFront(request.views)) {
        problems.push({
          code: PROBLEM_CODES.seedNotChosen,
          nodeId: node.id,
          message: 'Choose the pictures this run starts from — a front one at least.',
        })
      }
      continue
    }
    if (node.kind === 'ai_edit' && !setOnEachRun(node) && !text(request.prompt)) {
      problems.push({
        code: PROBLEM_CODES.promptMissing,
        nodeId: node.id,
        field: 'prompt',
        message: 'Say how to change the picture — or set it on each run.',
      })
    } else if (NODE_KINDS[node.kind].engineChoice && typeof request.model !== 'string') {
      problems.push({ code: PROBLEM_CODES.engineMissing, nodeId: node.id, field: 'engine', message: 'Choose an engine.' })
    } else if (node.kind === 'export' && typeof request.format !== 'string') {
      problems.push({ code: PROBLEM_CODES.formatMissing, nodeId: node.id, field: 'format', message: 'Choose a file format.' })
    }
    if (node.settings) {
      for (const problem of nodeProblems(node, { ...options, incoming: incomingType(built, node.id) })) {
        problems.push({ code: PROBLEM_CODES.settingInvalid, nodeId: node.id, field: problem.field, message: problem.message })
      }
    }
  }
  return problems
}

/**
 * WHAT A RUN NEEDS FROM THE USER BEFORE IT CAN START — the server's own rule: AI texturing a
 * description or a reference picture, Multi-view - AI texturing its pictures of each side (unless
 * views are wired in), AI edit an instruction. A draft run is made without them; its
 * Start is refused (`RUN_NEEDS_INPUT`) until each is given.
 */
export function runInputProblems(graph: PipelineGraph): Problem[] {
  const built = withRequests(graph)
  const problems: Problem[] = []
  for (const node of built.nodes) {
    const request = node.request ?? {}
    if (node.kind === 'ai_edit' && !text(request.prompt)) {
      problems.push({
        code: PROBLEM_CODES.aiEditPromptMissing,
        nodeId: node.id,
        field: 'prompt',
        message: `${node.label || 'AI edit'}: say how to change the picture.`,
      })
    }
    if (node.kind === 'texture') {
      const wired = built.edges.some((edge) => edge.target === node.id && edge.targetHandle === 'reference')
      const given =
        wired ||
        text(request.prompt) ||
        typeof request.referenceUploadKey === 'string' ||
        typeof request.referenceImageId === 'number'
      if (!given) {
        problems.push({
          code: PROBLEM_CODES.textureInputMissing,
          nodeId: node.id,
          field: 'prompt',
          message: `${node.label || 'AI texturing'}: describe the texture or add a reference picture.`,
        })
      }
    }
    if (node.kind === 'texture_multiview') {
      const wired = built.edges.some((edge) => edge.target === node.id && edge.targetHandle === 'views')
      if (!wired && !hasFront(request.referenceViews)) {
        problems.push({
          code: PROBLEM_CODES.viewsInputMissing,
          nodeId: node.id,
          field: 'views',
          message: `${node.label || 'Multi-view - AI texturing'}: add the pictures of each side — a front one at least.`,
        })
      }
    }
  }
  return problems
}

/** The triangle budget arriving at a node: the nearest step upstream that sets one (quads count twice). */
function polygonBudgetBefore(graph: PipelineGraph, nodeId: string): { from: string; triangles: number } | null {
  const seen = new Set<string>()
  let current = nodeId
  while (!seen.has(current)) {
    seen.add(current)
    const source = sourceOf(graph, current)
    if (!source) return null
    const settings = effectiveSettings(source)
    const label = source.label || source.kind.replace(/_/g, ' ').replace(/^./, (char) => char.toUpperCase())
    if (source.kind === 'retopology') {
      if (settings.engine !== 'r1' || typeof settings.faces !== 'number') return null
      return { from: label, triangles: settings.faces * (settings.polygonType === 'quadrilateral' ? 2 : 1) }
    }
    if (source.kind === 'generate_3d' || source.kind === 'generate_smart_3d' || isMultiViewGenerate(source.kind)) {
      const count = Number(settings.polygonCount)
      if (!Number.isFinite(count) || count <= 0) return null
      return { from: label, triangles: count * (settings.polygonType === 'quadrilateral' ? 2 : 1) }
    }
    if (source.kind === 'seed_model') return null
    current = source.id
  }
  return null
}

/**
 * What may go wrong once it runs, or what the graph holds that this version reads with care. None of
 * these stops a run: steps the editor no longer offers, settings with values this version does not
 * know (a bone naming other than standard or mixamo is treated as standard), Smart UV past its
 * triangle limit, and Draw views with no views.
 */
export function graphWarnings(graph: PipelineGraph): Problem[] {
  const warnings: Problem[] = []
  for (const node of graph.nodes) {
    if (!isNodeKind(node.kind)) continue
    const spec = NODE_KINDS[node.kind]
    if (spec.legacy) {
      warnings.push({
        code: WARNING_CODES.legacyKind,
        nodeId: node.id,
        message: `${spec.label} is no longer offered by the editor; the step still runs.`,
      })
    }
    for (const note of settingNotes(node.kind, node.settings)) {
      warnings.push({ code: note.code, nodeId: node.id, field: note.field, message: note.message })
    }
    if (!node.settings && withKnownRigSpecRequest(node.kind, node.request).replaced) {
      warnings.push({
        code: WARNING_CODES.rigSpecReplaced,
        nodeId: node.id,
        field: 'rigSpec',
        message: 'Unknown bone-naming value replaced with standard.',
      })
    }
    if (node.kind === 'draw_views') {
      const views = effectiveSettings(node).views
      if (Array.isArray(views) && views.length === 0) {
        warnings.push({
          code: WARNING_CODES.noViews,
          nodeId: node.id,
          field: 'views',
          message: 'No views chosen: only the front picture goes on.',
        })
      }
    }
    const settings = node.settings
    if ((node.kind === 'generate_3d' || node.kind === 'generate_3d_multiview') && (settings ? settings.model : node.request?.model) === 'n1') {
      warnings.push({
        code: WARNING_CODES.engineRetired,
        nodeId: node.id,
        field: 'engine',
        message: 'Zetta N1 has been retired: the server refuses it, so this step fails when it runs. Use engine n25.',
      })
    }
    if (node.kind === 'retopology' && (settings ? settings.engine : node.request?.model) === 'n1') {
      warnings.push({
        code: WARNING_CODES.engineRetired,
        nodeId: node.id,
        field: 'engine',
        message: 'Zetta N1 has been retired: this step runs on Zetta R1, to its polygon count (faces).',
      })
    }
    if (node.kind === 'smart_uv') {
      const budget = polygonBudgetBefore(graph, node.id)
      if (budget && budget.triangles > SMART_UV_MAX_TRIANGLES) {
        warnings.push({
          code: WARNING_CODES.smartUvTriangles,
          nodeId: node.id,
          message: `${budget.from} can make about ${formatCount(budget.triangles)} triangles — over Smart UV’s ${formatCount(SMART_UV_MAX_TRIANGLES)}. Add Retopology before it, or lower the polygon count.`,
        })
      }
    }
  }
  for (const edge of graph.edges) {
    const target = graph.nodes.find((node) => node.id === edge.target)
    if (!target) continue
    if (inputPort(target.kind, edge.targetHandle)?.legacy) {
      warnings.push({
        code: WARNING_CODES.legacyInput,
        nodeId: target.id,
        message:
          'The editor no longer has this input and drops the connection when the pipeline is opened there; the server still follows it.',
      })
    }
  }
  return warnings
}

/** The problems and the warnings together. */
export function checkGraph(graph: PipelineGraph, options: ValidateOptions = {}): { problems: Problem[]; warnings: Problem[] } {
  return { problems: validateGraph(graph, options), warnings: graphWarnings(graph) }
}

/* ----------------------------------------------------------------------------------- seeds */

/** What a pipeline's runs start from: a picture, a model, pictures of each side, or null when it has no seed. */
export function seedType(graph: PipelineGraph): 'picture' | 'model' | 'views' | null {
  const seed = graph.nodes.find((node) => isSeed(node.kind))
  if (!seed) return null
  return seed.kind === 'seed_model' ? 'model' : seed.kind === 'seed_views' ? 'views' : 'picture'
}

const isPlaced = (value: Record<string, unknown>) =>
  (typeof value.uploadKey === 'string' && value.uploadKey !== '') ||
  (typeof value.gen2dPostId === 'number' && Number.isInteger(value.gen2dPostId) && value.gen2dPostId > 0)

/** What is wrong with one multi-view seed: known sides, each once and placed, the front among them. */
function viewSeedProblem(value: Record<string, unknown>): string | null {
  if (!Array.isArray(value.views) || value.views.length === 0) return 'a multi-view pipeline takes { views: [{ viewType, uploadKey | gen2dPostId }], name? }.'
  const seen = new Set<string>()
  for (const entry of value.views as unknown[]) {
    const view = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>
    const viewType = typeof view.viewType === 'string' ? view.viewType : ''
    if (!(VIEW_TYPES as readonly string[]).includes(viewType)) return `each view is one of ${VIEW_TYPES.join(', ')}.`
    if (seen.has(viewType)) return `the ${viewType} picture is given twice.`
    if (!isPlaced(view)) return `the ${viewType} picture needs an uploadKey or a gen2dPostId.`
    seen.add(viewType)
  }
  if (!seen.has('front')) return 'a front picture is required.'
  return null
}

/**
 * Whether these seeds can each start a run of this graph (`POST /pipelines/:id/batch`): 1 to 20 of
 * them, each the kind the seed step takes — an upload or an Image library picture for a picture
 * pipeline, a 3D library model for a model pipeline, a set of pictures of each side (the front at
 * least) for a multi-view pipeline.
 */
export function validateSeeds(graph: PipelineGraph, seeds: readonly unknown[]): Problem[] {
  const problems: Problem[] = []
  if (seeds.length < 1 || seeds.length > PIPELINE_LIMITS.maxBatchSeeds) {
    problems.push({ code: PROBLEM_CODES.seedsCount, message: 'A batch takes 1 to 20 seeds — split a longer list.' })
  }
  const type = seedType(graph)
  if (!type) {
    problems.push({ code: PROBLEM_CODES.noSeed, message: 'Add a seed — the picture or model the pipeline starts from.' })
    return problems
  }
  seeds.forEach((seed, index) => {
    const value = (typeof seed === 'object' && seed !== null ? seed : {}) as Record<string, unknown>
    if (type === 'views') {
      const problem = viewSeedProblem(value)
      if (problem) problems.push({ code: PROBLEM_CODES.seedInvalid, field: `seeds[${index}]`, message: `Seed ${index + 1}: ${problem}` })
      return
    }
    const fits =
      type === 'picture'
        ? (typeof value.uploadKey === 'string' && value.uploadKey !== '') || typeof value.gen2dPostId === 'number'
        : typeof value.gen3dPostId === 'number'
    if (!fits) {
      problems.push({
        code: PROBLEM_CODES.seedInvalid,
        field: `seeds[${index}]`,
        message:
          type === 'picture'
            ? `Seed ${index + 1}: a picture pipeline takes { uploadKey, name? } or { gen2dPostId }.`
            : `Seed ${index + 1}: a model pipeline takes { gen3dPostId }.`,
      })
    }
  })
  return problems
}

/** Splits seeds into batches the server takes (20 at most). */
export function batchesOf<T>(seeds: readonly T[], size: number = PIPELINE_LIMITS.maxBatchSeeds): T[][] {
  const batches: T[][] = []
  for (let index = 0; index < seeds.length; index += size) batches.push(seeds.slice(index, index + size))
  return batches
}

/* --------------------------------------------------------------------- server's problems */

const SERVER_MESSAGES: ReadonlyArray<[RegExp, string]> = [
  [/^A pipeline holds at most 200 steps\.$/, PROBLEM_CODES.graphTooLarge],
  [/^This step is not one Zetta runs\.$/, PROBLEM_CODES.unknownKind],
  [/^Two steps share one id\.$/, PROBLEM_CODES.duplicateId],
  [/^Add a seed/, PROBLEM_CODES.noSeed],
  [/^A pipeline starts from one seed\.$/, PROBLEM_CODES.extraSeed],
  [/^A connection points at a step that is gone\.$/, PROBLEM_CODES.edgeDangling],
  [/^A connection uses a socket this step does not have\.$/, PROBLEM_CODES.unknownHandle],
  [/^This input takes a /, PROBLEM_CODES.portMismatch],
  [/ takes one picture\. For pictures of each side, use /, PROBLEM_CODES.portMismatch],
  [/ takes pictures of each side — connect a Multi-view seed or Draw views/, PROBLEM_CODES.portMismatch],
  [/^Choose the pictures this run starts from — a front one at least\.$/, PROBLEM_CODES.seedNotChosen],
  [/: add the pictures of each side — a front one at least\.$/, PROBLEM_CODES.viewsInputMissing],
  [/^An input takes one connection\.$/, PROBLEM_CODES.inputTaken],
  [/^Connect this step to the one before it\.$/, PROBLEM_CODES.inputNotConnected],
  [/^The pipeline loops back on itself\.$/, PROBLEM_CODES.cycle],
  [/^Choose the (picture|model) this pipeline starts from\.$/, PROBLEM_CODES.seedNotChosen],
  [/^Choose a file format\.$/, PROBLEM_CODES.formatMissing],
  [/^Choose an engine\.$/, PROBLEM_CODES.engineMissing],
  [/^Say how to change the picture/, PROBLEM_CODES.promptMissing],
  [/: say how to change the picture\.$/, PROBLEM_CODES.aiEditPromptMissing],
  [/: describe the texture or add a reference picture\.$/, PROBLEM_CODES.textureInputMissing],
]

/** A problem as the server sent it, with a code read from its message. */
export function problemFromServer(problem: ServerGraphProblem): Problem {
  const code = SERVER_MESSAGES.find(([pattern]) => pattern.test(problem.message))?.[1] ?? PROBLEM_CODES.serverProblem
  return { code, ...(problem.nodeId ? { nodeId: problem.nodeId } : {}), message: problem.message }
}

/* --------------------------------------------------------------------------------- parsing */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Reads untrusted JSON into a graph the way the server does when it saves one: nodes without an id
 * and edges without both ends are dropped, ids and labels are cut to length, missing handles are
 * `out` and `in`, and a generation fed views becomes its multi-view step (`withMultiViewSteps`). A
 * kind is otherwise kept as it came — `validateGraph` says when it is not one Zetta runs.
 */
export function parseGraph(value: unknown): PipelineGraph {
  const raw = isRecord(value) ? value : {}
  const nodes = Array.isArray(raw.nodes) ? raw.nodes : []
  const edges = Array.isArray(raw.edges) ? raw.edges : []
  return withMultiViewSteps({
    version: PIPELINE_GRAPH_VERSION,
    nodes: nodes
      .filter((node): node is Record<string, unknown> => isRecord(node) && typeof node.id === 'string')
      .map((node) => {
        const position = isRecord(node.position) ? node.position : {}
        return {
          id: (node.id as string).slice(0, PIPELINE_LIMITS.maxNodeId),
          kind: node.kind as PipelineNode['kind'],
          position: { x: Number(position.x) || 0, y: Number(position.y) || 0 },
          ...(isRecord(node.settings) ? { settings: node.settings } : {}),
          ...(isRecord(node.request) ? { request: node.request } : {}),
          ...(typeof node.label === 'string' ? { label: node.label.slice(0, PIPELINE_LIMITS.maxLabel) } : {}),
        }
      }),
    edges: edges
      .filter(
        (edge): edge is Record<string, unknown> =>
          isRecord(edge) && typeof edge.source === 'string' && typeof edge.target === 'string',
      )
      .map(
        (edge, index): PipelineEdge => ({
          id: typeof edge.id === 'string' ? edge.id.slice(0, PIPELINE_LIMITS.maxNodeId) : `e${index}`,
          source: edge.source as string,
          sourceHandle: typeof edge.sourceHandle === 'string' ? edge.sourceHandle : 'out',
          target: edge.target as string,
          targetHandle: typeof edge.targetHandle === 'string' ? edge.targetHandle : 'in',
        }),
      ),
  })
}
