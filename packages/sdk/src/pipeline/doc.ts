/**
 * THE FRIENDLY PIPELINE DOCUMENT — what a person or an agent writes instead of a raw graph.
 *
 * ```yaml
 * version: 1
 * title: Picture to rigged character
 * steps:
 *   photo: { kind: seed_picture }
 *   clean: { kind: remove_background, from: photo }
 *   model: { kind: generate_3d, from: clean, engine: n25, quality: high, output: textured }
 *   rig:   { kind: rigging, from: model, rigType: biped, rigSpec: standard, format: fbx }
 * ```
 *
 * Each step is keyed by its id. `from` names the step (and, where it has several, the output) it
 * follows. Settings are written inline in the catalogue's friendly names; anything not named keeps the
 * editor's default. `compilePipeline` turns a document into a graph — positions laid out, edges wired
 * to the right handles, `settings` filled and `request` built by `requestFor` — and `decompilePipeline`
 * turns a graph back into a document, keeping whatever it cannot say in friendly names under `settings`.
 */
import { NODE_KINDS, OFFERED_NODE_KINDS, inputPort, isNodeKind, isSeed, outputType, settingSpecByKey } from './catalogue'
import { withRequests, type NodeContext } from './request'
import { graphWarnings, runInputProblems, topologicalOrder, validateGraph, withMultiViewSteps, type ValidateOptions } from './rules'
import {
  RIG_SPEC_REPLACED_MESSAGE,
  defaultSettings,
  settingNotes,
  toFriendlyValue,
  withKnownRigSpec,
  withKnownRigSpecRequest,
} from './settings'
import { buildStepSettings, deepEqual } from './step-settings'
import {
  PIPELINE_GRAPH_VERSION,
  PIPELINE_LIMITS,
  type NodeKind,
  type PipelineEdge,
  type PipelineGraph,
  type PipelineNode,
  type Problem,
} from './types'

/** A reference to a step's output: `photo`, `iso.each`, `iso.character`, `iso.part:sword`. */
export type StepRef = string

/**
 * What a step follows. A string fills its main input; a list fills its inputs in order; an object
 * names the inputs (`{ in: model, reference: photo }`).
 */
export type PipelineDocFrom = StepRef | StepRef[] | Record<string, StepRef | StepRef[]>

export interface PipelineDocStep {
  kind: NodeKind
  from?: PipelineDocFrom
  /** A name shown on the canvas (at most 80 characters). */
  label?: string
  /** Raw editor settings, applied as they are after the friendly ones — for what the friendly names do not cover. */
  settings?: Record<string, unknown>
  /** A raw API request, used as it is instead of one built from the settings. For graphs written against the API. */
  request?: Record<string, unknown>
  /** The step's settings, in the catalogue's friendly names. */
  [setting: string]: unknown
}

export interface PipelineDoc {
  version?: 1
  /** The pipeline's name (at most 200 characters). */
  title?: string
  steps: Record<string, PipelineDocStep>
  /** Canvas positions by step id. Steps not listed are laid out left to right. */
  layout?: Record<string, { x: number; y: number }>
}

export const DOC_PROBLEM_CODES = {
  docInvalid: 'DOC_INVALID',
  versionUnsupported: 'VERSION_UNSUPPORTED',
  titleInvalid: 'TITLE_INVALID',
  stepsInvalid: 'STEPS_INVALID',
  stepIdInvalid: 'STEP_ID_INVALID',
  stepInvalid: 'STEP_INVALID',
  unknownKind: 'UNKNOWN_KIND',
  labelInvalid: 'LABEL_INVALID',
  settingsInvalid: 'SETTINGS_INVALID',
  requestInvalid: 'REQUEST_INVALID',
  unknownSetting: 'UNKNOWN_SETTING',
  settingInvalid: 'SETTING_INVALID',
  fromInvalid: 'FROM_INVALID',
  unknownStep: 'UNKNOWN_STEP',
  unknownOutput: 'UNKNOWN_OUTPUT',
  outputAmbiguous: 'OUTPUT_AMBIGUOUS',
  unknownInput: 'UNKNOWN_INPUT',
  layoutInvalid: 'LAYOUT_INVALID',
} as const

/** A step id: letters, digits, `_` and `-`, 1 to 64 of them. */
export const STEP_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

const RESERVED_FIELDS = new Set(['kind', 'from', 'label', 'settings', 'request'])
const DOC_FIELDS = new Set(['version', 'title', 'steps', 'layout'])

/** The horizontal and vertical spacing of the automatic layout (the in-app agent's). */
export const LAYOUT_SPACING = { x: 300, y: 200 } as const

export interface CompileOptions extends Omit<NodeContext, 'incoming'>, Pick<ValidateOptions, 'requireSeedAsset'> {
  /** Refuse a graph `validateGraph` finds problems with. Default true; false compiles a work in progress. */
  validate?: boolean
}

export type CompileResult =
  | { ok: true; graph: PipelineGraph; title?: string; warnings: string[] }
  | { ok: false; problems: Problem[]; warnings: string[] }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const say = (id: string, message: string) => `Step "${id}": ${message}`

/** What each run gives a seed step. */
const SEED_GIVES: Record<string, string> = {
  seed_picture: 'picture',
  seed_model: 'model',
  seed_views: 'pictures of each side',
}

/** The output a bare step reference means: its one output, or null when it has several. */
function defaultOutput(kind: string): string | null {
  if (!isNodeKind(kind)) return null
  const spec = NODE_KINDS[kind]
  return spec.outputs.length === 1 && !spec.dynamicOutputs ? spec.outputs[0]!.handle : null
}

function outputNames(kind: NodeKind): string {
  const spec = NODE_KINDS[kind]
  return [
    ...spec.outputs.map((output) => output.handle),
    ...(spec.dynamicOutputs ? [`${spec.dynamicOutputs.prefix}<key>`] : []),
  ].join(', ')
}

/** Positions left to right by depth from the seed, one row per sibling (the in-app agent's layout). */
export function autoLayout(graph: PipelineGraph): Map<string, { x: number; y: number }> {
  const order = topologicalOrder(graph) ?? graph.nodes.map((node) => node.id)
  const depth = new Map<string, number>()
  for (const id of order) {
    let level = depth.get(id) ?? 0
    for (const edge of graph.edges) {
      if (edge.target === id && depth.has(edge.source)) level = Math.max(level, depth.get(edge.source)! + 1)
    }
    depth.set(id, level)
  }
  const rows = new Map<number, number>()
  const positions = new Map<string, { x: number; y: number }>()
  for (const node of graph.nodes) {
    if (positions.has(node.id)) continue
    const level = depth.get(node.id) ?? 0
    const row = rows.get(level) ?? 0
    rows.set(level, row + 1)
    positions.set(node.id, { x: level * LAYOUT_SPACING.x, y: row * LAYOUT_SPACING.y })
  }
  return positions
}

/* ---------------------------------------------------------------------------------- compile */

/**
 * A friendly document as a graph. Problems with the document (an unknown kind, a setting a step does
 * not have, a value it does not take, a `from` that names nothing) refuse it; so, unless
 * `validate: false`, does anything `validateGraph` finds. Warnings say what was changed or assumed.
 */
export function compilePipeline(doc: unknown, options: CompileOptions = {}): CompileResult {
  const problems: Problem[] = []
  const warnings: string[] = []
  const fail = (): CompileResult => ({ ok: false, problems, warnings })

  if (!isRecord(doc)) {
    problems.push({ code: DOC_PROBLEM_CODES.docInvalid, message: 'A pipeline document is an object with `steps`.' })
    return fail()
  }
  if (doc.version !== undefined && doc.version !== 1) {
    problems.push({ code: DOC_PROBLEM_CODES.versionUnsupported, message: 'This version reads pipeline documents of version 1.' })
  }
  if (doc.title !== undefined && (typeof doc.title !== 'string' || doc.title.length > PIPELINE_LIMITS.maxTitle)) {
    problems.push({ code: DOC_PROBLEM_CODES.titleInvalid, message: 'title is a string of at most 200 characters.' })
  }
  for (const key of Object.keys(doc)) {
    if (!DOC_FIELDS.has(key)) warnings.push(`"${key}" is not part of a pipeline document and was ignored.`)
  }
  if (!isRecord(doc.steps) || Object.keys(doc.steps).length === 0) {
    problems.push({
      code: DOC_PROBLEM_CODES.stepsInvalid,
      message: 'steps is an object of steps keyed by id, e.g. { photo: { kind: seed_picture } }.',
    })
    return fail()
  }

  const entries = Object.entries(doc.steps)
  const stepIds = new Set(entries.map(([id]) => id))
  const kinds = new Map<string, NodeKind>()
  const nodes: PipelineNode[] = []
  const explicitRequests = new Map<string, Record<string, unknown>>()

  for (const [id, step] of entries) {
    if (!STEP_ID_PATTERN.test(id)) {
      problems.push({
        code: DOC_PROBLEM_CODES.stepIdInvalid,
        nodeId: id,
        message: 'A step id is 1 to 64 letters, digits, "_" or "-".',
      })
      continue
    }
    if (!isRecord(step)) {
      problems.push({ code: DOC_PROBLEM_CODES.stepInvalid, nodeId: id, message: 'A step is an object with a `kind`.' })
      continue
    }
    if (!isNodeKind(step.kind)) {
      problems.push({
        code: DOC_PROBLEM_CODES.unknownKind,
        nodeId: id,
        field: 'kind',
        message: `kind must be one of: ${OFFERED_NODE_KINDS.join(', ')}.`,
      })
      continue
    }
    const kind = step.kind
    kinds.set(id, kind)

    if (step.label !== undefined && (typeof step.label !== 'string' || step.label.length > PIPELINE_LIMITS.maxLabel)) {
      problems.push({ code: DOC_PROBLEM_CODES.labelInvalid, nodeId: id, field: 'label', message: 'label is a string of at most 80 characters.' })
    }
    if (step.settings !== undefined && !isRecord(step.settings)) {
      problems.push({ code: DOC_PROBLEM_CODES.settingsInvalid, nodeId: id, field: 'settings', message: 'settings is an object of raw editor settings.' })
    }
    if (step.request !== undefined && !isRecord(step.request)) {
      problems.push({ code: DOC_PROBLEM_CODES.requestInvalid, nodeId: id, field: 'request', message: 'request is an object (a raw API request).' })
    }

    const fields: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(step)) if (!RESERVED_FIELDS.has(name)) fields[name] = value

    if (isSeed(kind) && Object.keys(fields).length) {
      for (const name of Object.keys(fields)) {
        problems.push({
          code: DOC_PROBLEM_CODES.unknownSetting,
          nodeId: id,
          field: name,
          message: `${kind} has no settings: each run is given its ${SEED_GIVES[kind] ?? 'seed'} as a seed.`,
        })
      }
      continue
    }

    const raw = isRecord(step.settings) ? step.settings : undefined
    const hasSettings = Object.keys(fields).length > 0 || raw !== undefined || !isRecord(step.request)
    const built = buildStepSettings(kind, fields, raw)
    for (const problem of built.problems) {
      problems.push({ code: problem.code, nodeId: id, field: problem.field, message: problem.message })
    }
    for (const note of built.notes) warnings.push(say(id, note))

    const node: PipelineNode = {
      id,
      kind,
      position: { x: 0, y: 0 },
      ...(hasSettings ? { settings: built.settings } : {}),
      ...(typeof step.label === 'string' && step.label !== '' ? { label: step.label } : {}),
    }
    if (isRecord(step.request)) {
      const known = withKnownRigSpecRequest(kind, step.request)
      if (known.replaced) warnings.push(say(id, RIG_SPEC_REPLACED_MESSAGE))
      explicitRequests.set(id, { ...known.request })
      node.request = { ...known.request }
      if (hasSettings) warnings.push(say(id, 'request is used as it is; the settings are kept for the editor but do not build it.'))
    }
    nodes.push(node)
  }

  // Wires, once every step is known.
  const edges: PipelineEdge[] = []
  for (const [id, step] of entries) {
    const kind = kinds.get(id)
    if (!kind || !isRecord(step) || step.from === undefined) continue
    const inputs = NODE_KINDS[kind].inputs
    if (inputs.length === 0) {
      problems.push({ code: DOC_PROBLEM_CODES.fromInvalid, nodeId: id, field: 'from', message: `${kind} starts the pipeline and follows no step.` })
      continue
    }
    const wanted: Array<{ handle: string; ref: unknown }> = []
    if (typeof step.from === 'string') {
      wanted.push({ handle: inputs[0]!.handle, ref: step.from })
    } else if (Array.isArray(step.from)) {
      if (step.from.length > inputs.length) {
        problems.push({
          code: DOC_PROBLEM_CODES.fromInvalid,
          nodeId: id,
          field: 'from',
          message: `${kind} takes ${inputs.length === 1 ? 'one input' : `${inputs.length} inputs (${inputs.map((input) => input.handle).join(', ')})`}.`,
        })
        continue
      }
      step.from.forEach((ref, index) => wanted.push({ handle: inputs[index]!.handle, ref }))
    } else if (isRecord(step.from)) {
      for (const [handle, refs] of Object.entries(step.from)) {
        if (!inputPort(kind, handle)) {
          problems.push({
            code: DOC_PROBLEM_CODES.unknownInput,
            nodeId: id,
            field: 'from',
            message: `${kind} has no input "${handle}". Its inputs: ${inputs.map((input) => input.handle).join(', ')}.`,
          })
          continue
        }
        for (const ref of Array.isArray(refs) ? refs : [refs]) wanted.push({ handle, ref })
      }
    } else {
      problems.push({ code: DOC_PROBLEM_CODES.fromInvalid, nodeId: id, field: 'from', message: 'from is a step id, "step.output", a list of them, or an object by input.' })
      continue
    }

    for (const { handle, ref } of wanted) {
      if (typeof ref !== 'string' || ref === '') {
        problems.push({ code: DOC_PROBLEM_CODES.fromInvalid, nodeId: id, field: 'from', message: 'from names a step: "photo" or "iso.each".' })
        continue
      }
      let sourceId = ref
      let sourceHandle: string | null = null
      if (!stepIds.has(ref)) {
        const dot = ref.lastIndexOf('.')
        if (dot > 0) {
          sourceId = ref.slice(0, dot)
          sourceHandle = ref.slice(dot + 1)
        }
      }
      const sourceKind = kinds.get(sourceId)
      if (!sourceKind) {
        if (!stepIds.has(sourceId)) {
          problems.push({ code: DOC_PROBLEM_CODES.unknownStep, nodeId: id, field: 'from', message: `from names no step "${sourceId}".` })
        }
        continue
      }
      if (sourceHandle === null) {
        sourceHandle = defaultOutput(sourceKind)
        if (sourceHandle === null) {
          problems.push({
            code: DOC_PROBLEM_CODES.outputAmbiguous,
            nodeId: id,
            field: 'from',
            message: `${sourceId} (${sourceKind}) has several outputs: write ${outputNames(sourceKind)
              .split(', ')
              .map((name) => `${sourceId}.${name}`)
              .join(', ')}.`,
          })
          continue
        }
      } else if (outputType(sourceKind, sourceHandle) === null) {
        problems.push({
          code: DOC_PROBLEM_CODES.unknownOutput,
          nodeId: id,
          field: 'from',
          message: `${sourceId} (${sourceKind}) has no output "${sourceHandle}". Its outputs: ${outputNames(sourceKind)}.`,
        })
        continue
      }
      edges.push({ id: `e${edges.length + 1}`, source: sourceId, sourceHandle, target: id, targetHandle: handle })
    }
  }

  // Positions.
  const layout = doc.layout
  const placed = new Map<string, { x: number; y: number }>()
  if (layout !== undefined) {
    if (!isRecord(layout)) {
      problems.push({ code: DOC_PROBLEM_CODES.layoutInvalid, field: 'layout', message: 'layout is an object of { x, y } by step id.' })
    } else {
      for (const [id, position] of Object.entries(layout)) {
        if (!isRecord(position) || typeof position.x !== 'number' || typeof position.y !== 'number' || !Number.isFinite(position.x) || !Number.isFinite(position.y)) {
          problems.push({ code: DOC_PROBLEM_CODES.layoutInvalid, nodeId: id, field: 'layout', message: 'A layout entry is { x, y }, two numbers.' })
        } else if (!kinds.has(id)) {
          warnings.push(`layout names no step "${id}"; it was ignored.`)
        } else {
          placed.set(id, { x: position.x, y: position.y })
        }
      }
    }
  }

  if (problems.length) return fail()

  let graph: PipelineGraph = { version: PIPELINE_GRAPH_VERSION, nodes, edges }
  // A one-picture generation fed views is its multi-view step, as the server reads it.
  const converted = withMultiViewSteps(graph)
  converted.nodes.forEach((node, index) => {
    const before = graph.nodes[index]!.kind
    if (node.kind !== before) {
      warnings.push(say(node.id, `${before} takes one picture; fed pictures of each side it is ${node.kind} — write that kind.`))
    }
  })
  graph = converted
  const auto = autoLayout(graph)
  graph = {
    ...graph,
    nodes: graph.nodes.map((node) => ({ ...node, position: placed.get(node.id) ?? auto.get(node.id) ?? { x: 0, y: 0 } })),
  }
  graph = withRequests(graph, options)
  if (explicitRequests.size) {
    graph = {
      ...graph,
      nodes: graph.nodes.map((node) => (explicitRequests.has(node.id) ? { ...node, request: explicitRequests.get(node.id)! } : node)),
    }
  }

  for (const warning of graphWarnings(graph)) {
    if (warning.code === 'RIG_SPEC_REPLACED') continue // already said
    warnings.push(warning.nodeId ? say(warning.nodeId, warning.message) : warning.message)
  }
  for (const needed of runInputProblems(graph)) {
    warnings.push(say(needed.nodeId ?? '', `each run must give it — ${needed.message}`))
  }

  if (options.validate !== false) {
    const found = validateGraph(graph, options)
    if (found.length) return { ok: false, problems: found, warnings }
  }
  return { ok: true, graph, ...(typeof doc.title === 'string' ? { title: doc.title } : {}), warnings }
}

/* -------------------------------------------------------------------------------- decompile */

export interface DecompileOptions {
  /** The pipeline's title, when a bare graph is given. */
  title?: string
  /** Keep canvas positions that differ from the automatic layout under `layout`. Default true. */
  positions?: boolean
}

export interface DecompileResult {
  doc: PipelineDoc
  warnings: string[]
}

const isEmptyObject = (value: unknown) => isRecord(value) && Object.keys(value).length === 0

/** A step's settings as friendly fields, plus the raw settings they cannot say. */
function friendlySettings(
  kind: NodeKind,
  original: Record<string, unknown>,
): { fields: Record<string, unknown>; residue: Record<string, unknown> } {
  const specs = NODE_KINDS[kind].settings
  if (kind === 'texture' && isEmptyObject(original.referenceViews)) {
    // What a new run's copy empties on AI texturing (`withoutRunInput`); AI texturing itself never reads it.
    const { referenceViews: _empty, ...rest } = original
    original = rest
  }
  const full = { ...defaultSettings(kind), ...original }
  const fields: Record<string, unknown> = {}
  for (const spec of specs) {
    if (spec.derived || !(spec.key in full)) continue
    const friendly = toFriendlyValue(spec, full[spec.key])
    if (friendly && !deepEqual(friendly.value, spec.default)) fields[spec.name] = friendly.value
  }

  const residue: Record<string, unknown> = {}
  const differences = (candidate: Record<string, unknown>) => {
    const built = buildStepSettings(kind, candidate, Object.keys(residue).length ? residue : undefined).settings
    return Object.keys(original).filter((key) => !deepEqual(built[key], original[key]))
  }
  // Friendly fields first; only what they cannot reproduce is carried raw.
  for (let pass = 0; pass < 12; pass++) {
    const differing = differences(fields)
    if (!differing.length) break
    let changed = false
    for (const key of differing) {
      const spec = settingSpecByKey(kind, key)
      const friendly = spec && !(key in residue) ? toFriendlyValue(spec, original[key]) : null
      if (spec && friendly && !deepEqual(fields[spec.name], friendly.value)) {
        fields[spec.name] = friendly.value
        changed = true
      }
    }
    if (!changed) for (const key of differing) residue[key] = original[key]
  }

  // Leave out what the rest implies (a count that moves the rung, a key carried raw).
  for (const name of Object.keys(fields).reverse()) {
    const { [name]: _left, ...without } = fields
    if (!differences(without).length) delete fields[name]
  }
  return { fields, residue }
}

/**
 * A graph as a friendly document. Settings are written in friendly names where they differ from the
 * defaults; what friendly names cannot say (an editor-only key, a value this version does not know) is
 * kept under the step's `settings`, so compiling the document gives the same settings back. A step
 * with no settings keeps its raw `request`. Never throws.
 */
export function decompilePipeline(
  input: PipelineGraph | { title?: string; graph: PipelineGraph },
  options: DecompileOptions = {},
): DecompileResult {
  const warnings: string[] = []
  const graph: PipelineGraph = 'graph' in input ? input.graph : input
  const title = options.title ?? ('graph' in input && typeof input.title === 'string' ? input.title : undefined)
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  const edges = Array.isArray(graph?.edges) ? graph.edges : []
  const ids = new Set(nodes.map((node) => node.id))

  const steps: Array<[string, PipelineDocStep]> = []
  const seen = new Set<string>()
  const kept: PipelineEdge[] = []
  for (const node of nodes) {
    if (seen.has(node.id)) {
      warnings.push(say(node.id, 'a second step with this id was left out.'))
      continue
    }
    seen.add(node.id)
    const step: PipelineDocStep = { kind: node.kind }
    if (typeof node.label === 'string' && node.label !== '') step.label = node.label

    // What it follows.
    const incoming = edges.filter((edge) => edge.target === node.id)
    const wires: Array<{ handle: string; ref: string }> = []
    for (const edge of incoming) {
      if (!ids.has(edge.source)) {
        warnings.push(say(node.id, 'a connection from a step that is gone was left out.'))
        continue
      }
      if (isNodeKind(node.kind) && !inputPort(node.kind, edge.targetHandle)) {
        warnings.push(say(node.id, `a connection into an input it does not have ("${edge.targetHandle}") was left out.`))
        continue
      }
      const source = nodes.find((candidate) => candidate.id === edge.source)!
      const ref = edge.sourceHandle === defaultOutput(source.kind) ? edge.source : `${edge.source}.${edge.sourceHandle}`
      wires.push({ handle: edge.targetHandle, ref })
      kept.push(edge)
    }
    if (wires.length === 1 && wires[0]!.handle === 'in') {
      step.from = wires[0]!.ref
    } else if (wires.length) {
      const byHandle: Record<string, StepRef | StepRef[]> = {}
      for (const wire of wires) {
        const current = byHandle[wire.handle]
        byHandle[wire.handle] = current === undefined ? wire.ref : [...(Array.isArray(current) ? current : [current]), wire.ref]
      }
      step.from = byHandle
    }

    if (!isNodeKind(node.kind)) {
      warnings.push(say(node.id, 'its kind is not one this version knows; it is kept as it is but will not compile.'))
      if (node.settings) step.settings = { ...node.settings }
      if (node.request) step.request = { ...node.request }
      steps.push([node.id, step])
      continue
    }

    if (!node.settings) {
      const known = withKnownRigSpecRequest(node.kind, node.request)
      if (known.replaced) warnings.push(say(node.id, RIG_SPEC_REPLACED_MESSAGE))
      step.request = { ...known.request }
      warnings.push(say(node.id, 'it has no editor settings, so its raw request is kept as it is.'))
    } else {
      const known = withKnownRigSpec(node.kind, node.settings)
      if (known.replaced) warnings.push(say(node.id, RIG_SPEC_REPLACED_MESSAGE))
      const original = known.settings ?? {}
      for (const note of settingNotes(node.kind, original)) warnings.push(say(node.id, note.message))
      const { fields, residue } = friendlySettings(node.kind, original)
      Object.assign(step, fields)
      if (Object.keys(residue).length) step.settings = residue
    }
    steps.push([node.id, step])
  }

  const doc: PipelineDoc = { version: 1, ...(title !== undefined ? { title } : {}), steps: Object.fromEntries(steps) }

  if (options.positions !== false) {
    const unique = nodes.filter((node, index) => nodes.findIndex((other) => other.id === node.id) === index)
    // Laid out as the compiler will lay it out: the same steps, and only the wires the document keeps.
    const auto = autoLayout({ version: PIPELINE_GRAPH_VERSION, nodes: unique, edges: kept })
    const layout: Array<[string, { x: number; y: number }]> = []
    for (const node of unique) {
      const expected = auto.get(node.id)
      if (expected && node.position && (node.position.x !== expected.x || node.position.y !== expected.y)) {
        layout.push([node.id, { x: node.position.x, y: node.position.y }])
      }
    }
    if (layout.length) doc.layout = Object.fromEntries(layout)
  }
  return { doc, warnings }
}

/* --------------------------------------------------------------------------- run changes */

/**
 * A step's settings changed for one run (`PATCH /pipeline-runs/:runId/nodes/:nodeId`), from friendly
 * fields over what the run's copy holds: the body to send — the new settings and the request rebuilt
 * from them — or the problems with the change. For a draft run's per-run inputs (AI texturing's
 * `prompt` or `reference`, AI edit's `prompt`) as much as for any other setting.
 */
export function runNodeChange(
  graph: PipelineGraph,
  nodeId: string,
  fields: Record<string, unknown>,
  options: Omit<NodeContext, 'incoming'> = {},
):
  | { ok: true; body: { settings: Record<string, unknown>; request: Record<string, unknown> }; warnings: string[] }
  | { ok: false; problems: Problem[] } {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId)
  if (!node) return { ok: false, problems: [{ code: DOC_PROBLEM_CODES.unknownStep, nodeId, message: 'There is no such step in this run.' }] }
  if (!isNodeKind(node.kind)) {
    return { ok: false, problems: [{ code: DOC_PROBLEM_CODES.unknownKind, nodeId, message: 'This step is not one Zetta runs.' }] }
  }
  if (isSeed(node.kind)) {
    return { ok: false, problems: [{ code: DOC_PROBLEM_CODES.stepInvalid, nodeId, message: 'A run’s seed is chosen when it starts.' }] }
  }
  const { settings: raw, ...friendly } = fields as { settings?: unknown } & Record<string, unknown>
  const base = { ...defaultSettings(node.kind), ...withKnownRigSpec(node.kind, node.settings).settings }
  const built = buildStepSettings(node.kind, friendly, isRecord(raw) ? raw : undefined, base)
  if (built.problems.length) {
    return { ok: false, problems: built.problems.map((problem) => ({ code: problem.code, nodeId, field: problem.field, message: problem.message })) }
  }
  const changed = { ...node, settings: built.settings }
  const next = { ...graph, nodes: graph.nodes.map((candidate) => (candidate.id === nodeId ? changed : candidate)) }
  const request = withRequests(next, options).nodes.find((candidate) => candidate.id === nodeId)!.request ?? {}
  return { ok: true, body: { settings: built.settings, request }, warnings: built.notes }
}
