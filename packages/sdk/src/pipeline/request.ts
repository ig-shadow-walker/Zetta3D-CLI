/**
 * WHAT EACH NODE SENDS — a port of the web editor's `requestFor` / `withRequests` / `nodeProblems`
 * (`node-config.ts`). A node keeps the form's value in `settings` and the request that form builds in
 * `request`, built here by the Studio's own rules, so a node sends exactly what the Studio would. The
 * server reads only `request`, adding the inputs that arrive along the connections.
 */
import { isMultiViewGenerate, outputType } from './catalogue'
import { buildCreateRequest, deriveSpec, formatCount, type GenerateForm } from './generate-form'
import { effectiveSettings } from './settings'
import {
  DEFAULT_ISOLATE_SETTINGS,
  SPLAT_BASE,
  autoRigRequest,
  postProcessBody,
  retopologyBounds,
  retopologyOutOfRange,
  retopologyRequest,
  segmentRequest,
  smartUvRequest,
  splatRequest,
  textureRequest,
} from './tool-settings'
import { VIEW_TYPES, type PipelineGraph, type PipelineNode, type PortType, type ViewSeed } from './types'

/** What a node's request depends on beyond its settings. */
export interface NodeContext {
  /** What arrives on the node's main input, when it is connected. Views make a generation multi-view. */
  incoming?: PortType | null
  /**
   * Whether the account may choose a polygon count. False sends no count and no custom-count extra
   * (as the editor does for plans without it). Unknown counts as allowed.
   */
  allowsCustomFaceCount?: boolean
}

/** A picture address the generation builder accepts; the server puts the real picture in its place. */
export const INPUT_PLACEHOLDER = 'https://pipeline.input/picture.png'

type Settings = Record<string, unknown>

/** Lists are copied so a request never shares an array with the settings it came from. */
const copy = (value: unknown): unknown => (Array.isArray(value) ? [...value] : value)

function generateRequest(form: GenerateForm, context: NodeContext): Settings {
  const mayChoose = context.allowsCustomFaceCount !== false
  const built = buildCreateRequest({ ...form, imageUrl: INPUT_PLACEHOLDER, prompt: '', imageFromPrompt: false }, mayChoose)
  if (!built.ok) return { model: form.model }
  const body: Settings = { ...built.input }
  delete body.imageUrl
  delete body.prompt
  delete body.imageFromPrompt
  delete body.origin
  if (context.incoming === 'views') body.spec = deriveSpec(form, true, mayChoose)
  return { ...body, removeBackground: form.removeBackground === true }
}

/**
 * A multi-view set as the server reads it (the editor's `viewsRequest`): each given side once, in the
 * slots' order — front, back, left, right — with its upload key or library picture, and its name.
 */
export function viewsRequest(set: unknown): ViewSeed[] {
  const value = (typeof set === 'object' && set !== null && !Array.isArray(set) ? set : {}) as Record<string, unknown>
  return VIEW_TYPES.flatMap((viewType): ViewSeed[] => {
    const view = value[viewType] as { uploadKey?: unknown; gen2dPostId?: unknown; name?: unknown } | undefined
    if (!view || typeof view !== 'object') return []
    const name = typeof view.name === 'string' && view.name ? { name: view.name } : {}
    if (typeof view.uploadKey === 'string' && view.uploadKey) return [{ viewType, uploadKey: view.uploadKey, ...name }]
    if (typeof view.gen2dPostId === 'number') return [{ viewType, gen2dPostId: view.gen2dPostId, ...name }]
    return []
  })
}

/**
 * The request a node's settings build. Never throws: a form the Studio would refuse yields the
 * engine alone, and `nodeProblems` says why. Settings missing a field read the editor's default for it.
 */
export function requestFor(node: Pick<PipelineNode, 'kind' | 'settings'>, context: NodeContext = {}): Settings {
  const settings = effectiveSettings(node)
  switch (node.kind) {
    // The seed is chosen for each run, never kept in the pipeline.
    case 'seed_picture':
    case 'seed_model':
    case 'seed_views':
    case 'remove_background':
      return {}
    case 'ai_edit':
      return {
        prompt: typeof settings.prompt === 'string' ? settings.prompt : '',
        for3D: settings.for3D !== false,
        ...(settings.model ? { model: settings.model } : {}),
      }
    case 'draw_views':
      return { views: copy(settings.views) ?? ['back', 'left', 'right'] }
    case 'isolate_parts': {
      const value = { ...DEFAULT_ISOLATE_SETTINGS, ...settings }
      return {
        identify: value.identify,
        sensitivity: value.sensitivity,
        maxParts: value.maxParts,
        pose: value.pose,
        extraParts: copy(value.extraParts),
        ...(value.model ? { model: value.model } : {}),
      }
    }
    case 'generate_3d':
    case 'generate_smart_3d':
      return generateRequest(settings as unknown as GenerateForm, context)
    // Pictures of each side, always — built as the Studio's Multi-View to 3D builds them.
    case 'generate_3d_multiview':
    case 'generate_smart_3d_multiview':
      return generateRequest(settings as unknown as GenerateForm, { ...context, incoming: 'views' })
    case 'generate_splat': {
      const { model, removeBackground } = splatRequest(settings)
      const title = typeof settings.title === 'string' ? settings.title.trim() : ''
      return {
        spec: { generation: { base: SPLAT_BASE, modifiers: [] } },
        model,
        removeBackground,
        ...(title ? { title } : {}),
      }
    }
    case 'retopology':
      return postProcessBody(retopologyRequest(settings))
    case 'segmentation':
    case 'smart_segmentation':
      return postProcessBody(segmentRequest(settings))
    case 'texture': {
      const reference = settings.reference as { uploadKey?: unknown; gen2dPostId?: unknown } | null | undefined
      const prompt = typeof settings.prompt === 'string' ? settings.prompt.trim() : ''
      return {
        // A picture replaces the description, as in the Studio — sending both is refused.
        ...postProcessBody({ ...textureRequest(settings), ...(prompt && !reference ? { prompt } : {}) }),
        // Read by the pipeline, never sent to the 3D API: the node's own reference, and its cut-out.
        ...(reference?.uploadKey ? { referenceUploadKey: reference.uploadKey } : {}),
        ...(typeof reference?.gen2dPostId === 'number' ? { referenceImageId: reference.gen2dPostId } : {}),
        removeReferenceBackground: settings.removeBg !== false,
      }
    }
    // Pictures of each side in place of a description or one picture; views wired in win, on the server.
    case 'texture_multiview':
      return {
        ...postProcessBody(textureRequest(settings)),
        referenceViews: viewsRequest(settings.referenceViews),
        removeReferenceBackground: settings.removeBg !== false,
      }
    case 'smart_uv':
      return postProcessBody(smartUvRequest(settings))
    case 'rigging':
      return postProcessBody(autoRigRequest(settings))
    case 'export':
      return { format: settings.format ?? 'glb' }
    default:
      return {}
  }
}

/** What arrives on a node's main input, if it is connected. */
export function incomingType(graph: PipelineGraph, nodeId: string): PortType | null {
  const edge = graph.edges.find((candidate) => candidate.target === nodeId && candidate.targetHandle === 'in')
  const source = edge ? graph.nodes.find((node) => node.id === edge.source) : undefined
  return edge && source ? outputType(source.kind, edge.sourceHandle) : null
}

/**
 * Every node's request rebuilt from its settings — what the editor does before saving, pricing or
 * starting a run. A node with no settings keeps the request it has (a graph written against the raw
 * API), as does a node of a kind this version does not know.
 */
export function withRequests(graph: PipelineGraph, context: Omit<NodeContext, 'incoming'> = {}): PipelineGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.settings
        ? { ...node, request: requestFor(node, { ...context, incoming: incomingType(graph, node.id) }) }
        : node,
    ),
  }
}

/** What the Studio's form would refuse — said on the node, and no run starts on it. */
export function nodeProblems(
  node: Pick<PipelineNode, 'kind' | 'settings'>,
  context: NodeContext = {},
): Array<{ field: string; message: string }> {
  const settings = effectiveSettings(node)
  if (node.kind === 'retopology') {
    if (!retopologyOutOfRange(settings)) return []
    const bounds = retopologyBounds(settings.polygonType)
    return [
      {
        field: 'faces',
        message: `The polygon count must be between ${formatCount(bounds.min)} and ${formatCount(bounds.max)}.`,
      },
    ]
  }
  if (node.kind !== 'generate_3d' && node.kind !== 'generate_smart_3d' && !isMultiViewGenerate(node.kind)) return []
  const form = settings as unknown as GenerateForm
  const built = buildCreateRequest(
    { ...form, imageUrl: INPUT_PLACEHOLDER, prompt: '', imageFromPrompt: false },
    context.allowsCustomFaceCount !== false,
  )
  return built.ok ? [] : built.problems.map((message) => ({ field: 'polygonCount', message }))
}
