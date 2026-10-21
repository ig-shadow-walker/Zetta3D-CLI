/**
 * THE RECIPE AS THE EDITOR OPENS IT, AND AS A NEW RUN'S COPY — ports of the web editor's load
 * normalisation (`pipeline-editor.tsx`) and `forNewRun` / `withoutRunInput` (`node-config.ts`).
 */
import { inputPort, isNodeKind, isSeed } from './catalogue'
import { withRequests, type NodeContext } from './request'
import { setOnEachRun } from './rules'
import { RIG_SPEC_REPLACED_MESSAGE, defaultSettings, settingsWithDefaults, withKnownRigSpec } from './settings'
import type { PipelineGraph, PipelineNode } from './types'

/** A step set on each run, with the input a run gives it taken out. */
export function withoutRunInput(node: PipelineNode): PipelineNode {
  if (!setOnEachRun(node)) return node
  if (node.kind === 'ai_edit') return { ...node, settings: { ...node.settings, prompt: '' } }
  if (node.kind === 'texture') return { ...node, settings: { ...node.settings, prompt: '', reference: null } }
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
 * A saved graph as the web editor opens it: each step's settings over the editor's defaults (a graph
 * the in-app agent drafted names only what it changed), no picture or model in the seed (each run
 * chooses its own), no per-run input kept, no wire into an input a step no longer has, and a bone
 * naming other than standard or mixamo replaced by standard. Requests are rebuilt from the settings.
 */
export function normalizeGraph(
  graph: PipelineGraph,
  context: Omit<NodeContext, 'incoming'> = {},
): { graph: PipelineGraph; warnings: string[] } {
  const warnings: string[] = []
  const nodes = graph.nodes.map((node) => {
    if (!isNodeKind(node.kind)) return node
    if (isSeed(node.kind)) return { ...node, settings: defaultSettings(node.kind), request: {} }
    const known = withKnownRigSpec(node.kind, node.settings)
    if (known.replaced) warnings.push(`Step "${node.id}": ${RIG_SPEC_REPLACED_MESSAGE}`)
    return withoutRunInput({ ...node, settings: settingsWithDefaults(node.kind, known.settings) })
  })
  const edges = graph.edges.filter((edge) => {
    const target = graph.nodes.find((node) => node.id === edge.target)
    const port = target ? inputPort(target.kind, edge.targetHandle) : null
    const keep = !target || !isNodeKind(target.kind) || (port !== null && !port.legacy)
    if (!keep) warnings.push(`Step "${edge.target}": a wire into an input it no longer has ("${edge.targetHandle}") was dropped.`)
    return keep
  })
  return { graph: withRequests({ ...graph, nodes, edges }, context), warnings }
}
