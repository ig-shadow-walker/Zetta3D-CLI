/**
 * THE RECIPE AS THE EDITOR OPENS IT, AND AS A NEW RUN'S COPY — ports of the web editor's load
 * normalisation (`pipeline-editor.tsx`) and `forNewRun` / `withoutRunInput` (`node-config.ts`), and of
 * what the server copies for a run when it is sent no graph (`withoutTextureInput`).
 */
import { inputPort, isNodeKind, isSeed } from './catalogue'
import { withRequests, type NodeContext } from './request'
import { setOnEachRun, withMultiViewSteps } from './rules'
import { RIG_SPEC_REPLACED_MESSAGE, defaultSettings, settingsWithDefaults, withKnownRigSpec } from './settings'
import { deepEqual } from './step-settings'
import type { PipelineGraph, PipelineNode } from './types'

/** A step set on each run, with the input a run gives it taken out. */
export function withoutRunInput(node: PipelineNode): PipelineNode {
  if (!setOnEachRun(node)) return node
  if (node.kind === 'ai_edit') return { ...node, settings: { ...node.settings, prompt: '' } }
  if (node.kind === 'texture') return { ...node, settings: { ...node.settings, prompt: '', reference: null, referenceViews: {} } }
  if (node.kind === 'texture_multiview') return { ...node, settings: { ...node.settings, referenceViews: {} } }
  return node
}

/** The recipe as a new run's copy: a step set on each run starts empty, so the run asks for its own input. */
export function forNewRun(graph: PipelineGraph): PipelineGraph {
  return { ...graph, nodes: graph.nodes.map(withoutRunInput) }
}

/**
 * The graph the web editor sends for a new batch of draft runs: each run's copy, with what is set on
 * each run left empty, and every request rebuilt (`withRequests(forNewRun(graph))`).
 */
export function newRunGraph(graph: PipelineGraph, context: Omit<NodeContext, 'incoming'> = {}): PipelineGraph {
  return withRequests(forNewRun(graph), context)
}

/**
 * The graph new runs of a saved pipeline should copy: its requests rebuilt from its settings, as the
 * editor does before starting anything, and — for draft runs — what is set on each run left empty
 * (`newRunGraph`). A run started straight away keeps what the recipe holds (a texture description kept
 * in it is used), as the server does.
 */
export function runGraphFor(
  stored: PipelineGraph,
  options: { draft?: boolean } & Omit<NodeContext, 'incoming'> = {},
): PipelineGraph {
  const { draft, ...context } = options
  return draft ? newRunGraph(stored, context) : withRequests(stored, context)
}

/**
 * What the server copies for each new run when it is sent no graph: the pipeline as saved, and for a
 * draft its AI texturing emptied (`withoutTextureInput`) — the run asks for its own description or
 * pictures. The seed's request is each run's seed.
 */
export function serverRunCopy(stored: PipelineGraph, draft: boolean): PipelineGraph {
  if (!draft) return stored
  return {
    ...stored,
    nodes: stored.nodes.map((node) => {
      if (node.kind !== 'texture' && node.kind !== 'texture_multiview') return node
      const { prompt: _prompt, referenceUploadKey: _upload, referenceImageId: _image, referenceViews: _views, ...request } = node.request ?? {}
      return {
        ...node,
        request,
        ...(node.settings ? { settings: { ...node.settings, prompt: '', reference: null, referenceViews: {} } } : {}),
      }
    }),
  }
}

/** A request as the engine reads it: no pictures of each side reads the same as an empty list of them. */
function engineView(request: Record<string, unknown> | undefined): Record<string, unknown> {
  const { referenceViews, ...rest } = request ?? {}
  return Array.isArray(referenceViews) && referenceViews.length === 0 ? rest : { ...rest, ...(referenceViews !== undefined ? { referenceViews } : {}) }
}

/**
 * THE STEPS A RUN'S GRAPH WOULD CHANGE. Starting runs with a `graph` saves it onto the pipeline first —
 * which an API key may not do (403 `PIPELINE_EDIT_NOT_ALLOWED`). So a graph is worth sending only when
 * what the engine reads (each step's kind and request, and the wires) differs from what the server
 * copies without one (`serverRunCopy`). Empty: send no graph; the runs are the same.
 *
 * Seeds are not compared — each run's seed replaces the seed's request.
 */
export function runGraphChanges(stored: PipelineGraph, wanted: PipelineGraph, draft: boolean): string[] {
  const server = serverRunCopy(stored, draft)
  const changed: string[] = []
  const theirs = new Map(server.nodes.map((node) => [node.id, node]))
  const ours = new Map(wanted.nodes.map((node) => [node.id, node]))
  for (const node of wanted.nodes) {
    const other = theirs.get(node.id)
    if (!other || other.kind !== node.kind || (other.label ?? '') !== (node.label ?? '')) {
      changed.push(node.id)
      continue
    }
    if (isSeed(node.kind)) continue
    if (!deepEqual(engineView(node.request), engineView(other.request))) changed.push(node.id)
  }
  for (const node of server.nodes) if (!ours.has(node.id)) changed.push(node.id)
  const wires = (graph: PipelineGraph) =>
    graph.edges.map((edge) => `${edge.source}.${edge.sourceHandle}->${edge.target}.${edge.targetHandle}`).sort()
  if (!deepEqual(wires(server), wires(wanted))) changed.push('(connections)')
  return changed
}

/**
 * A saved graph as the web editor opens it: a generation fed views as its multi-view step, each step's
 * settings over the editor's defaults (a graph the in-app agent drafted names only what it changed), no
 * picture or model in the seed (each run chooses its own), no per-run input kept, no wire into an input
 * a step no longer has, and a bone naming the Studio does not offer replaced by standard. Requests are
 * rebuilt from the settings.
 */
export function normalizeGraph(
  graph: PipelineGraph,
  context: Omit<NodeContext, 'incoming'> = {},
): { graph: PipelineGraph; warnings: string[] } {
  const warnings: string[] = []
  const converted = withMultiViewSteps(graph)
  converted.nodes.forEach((node, index) => {
    if (node.kind !== graph.nodes[index]?.kind) {
      warnings.push(`Step "${node.id}": ${graph.nodes[index]?.kind} is now ${node.kind}, the step for pictures of each side.`)
    }
  })
  const nodes = converted.nodes.map((node) => {
    if (!isNodeKind(node.kind)) return node
    if (isSeed(node.kind)) return { ...node, settings: defaultSettings(node.kind), request: {} }
    const known = withKnownRigSpec(node.kind, node.settings)
    if (known.replaced) warnings.push(`Step "${node.id}": ${RIG_SPEC_REPLACED_MESSAGE}`)
    return withoutRunInput({ ...node, settings: settingsWithDefaults(node.kind, known.settings) })
  })
  const edges = converted.edges.filter((edge) => {
    const target = converted.nodes.find((node) => node.id === edge.target)
    const port = target ? inputPort(target.kind, edge.targetHandle) : null
    const keep = !target || !isNodeKind(target.kind) || (port !== null && !port.legacy)
    if (!keep) warnings.push(`Step "${edge.target}": a wire into an input it no longer has ("${edge.targetHandle}") was dropped.`)
    return keep
  })
  return { graph: withRequests({ ...converted, nodes, edges }, context), warnings }
}
