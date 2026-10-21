import { describe, expect, it } from 'vitest'
import {
  batchesOf,
  canConnect,
  checkGraph,
  defaultSettings,
  fanOutNodes,
  graphWarnings,
  incomingType,
  outputType,
  parseGraph,
  problemFromServer,
  runInputProblems,
  seedType,
  stepPositions,
  topologicalOrder,
  validateGraph,
  validateSeeds,
  type PipelineGraph,
  type PipelineNode,
} from '../../src/pipeline'

const node = (id: string, kind: PipelineNode['kind'], request: Record<string, unknown> = {}): PipelineNode => ({
  id,
  kind,
  position: { x: 0, y: 0 },
  request,
})
const withSettings = (id: string, kind: PipelineNode['kind'], settings: Record<string, unknown> = defaultSettings(kind)): PipelineNode => ({
  id,
  kind,
  position: { x: 0, y: 0 },
  settings,
})
const edge = (source: string, target: string, sourceHandle = 'out', targetHandle = 'in') => ({
  id: `${source}-${target}-${sourceHandle}`,
  source,
  sourceHandle,
  target,
  targetHandle,
})
const messages = (graph: PipelineGraph, options = {}) => validateGraph(graph, options).map((problem) => problem.message)
const codes = (graph: PipelineGraph, options = {}) => validateGraph(graph, options).map((problem) => problem.code)

/** The backend spec's runnable chain: picture → Np1.5 → Retopology → Smart UV → FBX. */
const LINEAR: PipelineGraph = {
  version: 1,
  nodes: [
    node('seed', 'seed_picture', { uploadKey: 'inputImg/7/a.png' }),
    node('gen', 'generate_smart_3d', { model: 'np15', spec: { generation: { base: 'textured' } } }),
    node('retopo', 'retopology', { model: 'r1', spec: { postProcess: ['smart_topology'] } }),
    node('uv', 'smart_uv', { model: 'n25', spec: { postProcess: ['smart_uv'] } }),
    node('fbx', 'export', { format: 'fbx' }),
  ],
  edges: [edge('seed', 'gen'), edge('gen', 'retopo'), edge('retopo', 'uv'), edge('uv', 'fbx')],
}

describe('validateGraph — the backend’s pipeline-graph.spec vectors', () => {
  it('finds nothing wrong with a runnable chain', () => {
    expect(validateGraph(LINEAR)).toEqual([])
    expect(validateGraph(LINEAR, { requireSeedAsset: true })).toEqual([])
  })

  it('asks for a seed, and for exactly one', () => {
    expect(validateGraph({ ...LINEAR, nodes: LINEAR.nodes.slice(1), edges: LINEAR.edges.slice(1) })).toContainEqual({
      code: 'NO_SEED',
      message: 'Add a seed — the picture or model the pipeline starts from.',
    })
    expect(validateGraph({ ...LINEAR, nodes: [...LINEAR.nodes, node('seed2', 'seed_model', { gen3dPostId: 4 })] })).toContainEqual({
      code: 'EXTRA_SEED',
      nodeId: 'seed2',
      message: 'A pipeline starts from one seed.',
    })
  })

  it('refuses a connection whose types do not match', () => {
    const graph = { ...LINEAR, edges: [edge('seed', 'retopo'), ...LINEAR.edges.slice(1)] }
    expect(validateGraph(graph)).toContainEqual({ code: 'PORT_MISMATCH', nodeId: 'retopo', message: 'This input takes a mesh, not a picture.' })
  })

  it('asks for every required input to be connected', () => {
    const graph = { ...LINEAR, edges: LINEAR.edges.filter((candidate) => candidate.target !== 'uv') }
    expect(validateGraph(graph)).toContainEqual({ code: 'INPUT_NOT_CONNECTED', nodeId: 'uv', message: 'Connect this step to the one before it.' })
  })

  it('asks a 3D step for its engine, and — for a run on the graph’s own seed — the seed for its asset', () => {
    const graph = {
      ...LINEAR,
      nodes: LINEAR.nodes.map((candidate) => (candidate.id === 'gen' || candidate.id === 'seed' ? { ...candidate, request: {} } : candidate)),
    }
    expect(messages(graph)).toContain('Choose an engine.')
    expect(messages(graph)).not.toContain('Choose the picture this pipeline starts from.')
    expect(messages(graph, { requireSeedAsset: true })).toContain('Choose the picture this pipeline starts from.')
  })

  it('refuses a loop and a second connection into one input', () => {
    const looped = { ...LINEAR, edges: [...LINEAR.edges, edge('uv', 'retopo')] }
    expect(codes(looped)).toEqual(expect.arrayContaining(['CYCLE', 'INPUT_TAKEN']))
  })

  it('takes several views into a generation, and an isolated part anywhere a picture goes', () => {
    const graph: PipelineGraph = {
      version: 1,
      nodes: [
        node('seed', 'seed_picture', { gen2dPostId: 3 }),
        node('iso', 'isolate_parts'),
        node('views', 'draw_views'),
        node('gen', 'generate_3d', { model: 'n25', spec: { generation: { base: 'textured' } } }),
        node('sword', 'generate_3d', { model: 'n25', spec: { generation: { base: 'textured' } } }),
      ],
      edges: [edge('seed', 'iso'), edge('iso', 'views', 'character'), edge('views', 'gen'), edge('iso', 'sword', 'part:sword')],
    }
    expect(validateGraph(graph)).toEqual([])
  })
})

describe('validateGraph — the editor’s lib/pipelines.test vectors', () => {
  it('names the step that needs a connection or an engine — never the seed, which each run chooses', () => {
    const graph: PipelineGraph = { version: 1, nodes: [node('seed', 'seed_picture'), node('gen', 'generate_3d')], edges: [] }
    expect(validateGraph(graph)).toEqual([
      { code: 'INPUT_NOT_CONNECTED', nodeId: 'gen', message: 'Connect this step to the one before it.' },
      { code: 'ENGINE_MISSING', nodeId: 'gen', field: 'engine', message: 'Choose an engine.' },
    ])
  })

  it('asks for a seed when there is none', () => {
    expect(validateGraph({ version: 1, nodes: [], edges: [] })[0]!.message).toMatch(/Add a seed/)
  })

  it('is content with Smart UV, which has no engine to choose', () => {
    const graph: PipelineGraph = {
      version: 1,
      nodes: [node('seed', 'seed_picture'), node('gen', 'generate_smart_3d', { model: 'np15' }), node('uv', 'smart_uv')],
      edges: [edge('seed', 'gen'), edge('gen', 'uv')],
    }
    expect(validateGraph(graph)).toEqual([])
  })
})

describe('validateGraph — every rule', () => {
  const seeded = (...rest: PipelineNode[]): PipelineGraph => ({ version: 1, nodes: [withSettings('seed', 'seed_picture'), ...rest], edges: [] })

  it('GRAPH_TOO_LARGE: at most 200 steps', () => {
    const many = Array.from({ length: 200 }, (_, index) => withSettings(`n${index}`, 'remove_background'))
    expect(codes(seeded(...many))).toContain('GRAPH_TOO_LARGE')
  })

  it('UNKNOWN_KIND: a step Zetta does not run', () => {
    const graph = seeded({ id: 'odd', kind: 'teleport' as PipelineNode['kind'], position: { x: 0, y: 0 } })
    expect(validateGraph(graph)).toContainEqual({ code: 'UNKNOWN_KIND', nodeId: 'odd', message: 'This step is not one Zetta runs.' })
  })

  it('DUPLICATE_ID: two steps share one id', () => {
    expect(codes(seeded(withSettings('a', 'remove_background'), withSettings('a', 'remove_background')))).toContain('DUPLICATE_ID')
  })

  it('EDGE_DANGLING: a connection to a step that is gone', () => {
    const graph = { ...seeded(), edges: [edge('seed', 'ghost')] }
    expect(validateGraph(graph)).toContainEqual({ code: 'EDGE_DANGLING', message: 'A connection points at a step that is gone.' })
  })

  it('UNKNOWN_HANDLE: a socket the step does not have', () => {
    const graph = { ...seeded(withSettings('cut', 'remove_background')), edges: [edge('seed', 'cut', 'each')] }
    expect(codes(graph)).toContain('UNKNOWN_HANDLE')
    const intoNowhere = { ...seeded(withSettings('cut', 'remove_background')), edges: [edge('seed', 'cut', 'out', 'side')] }
    expect(codes(intoNowhere)).toContain('UNKNOWN_HANDLE')
  })

  it('PROMPT_MISSING: AI edit needs its instruction, unless it is set on each run', () => {
    const graph = { ...seeded(withSettings('edit', 'ai_edit')), edges: [edge('seed', 'edit')] }
    expect(validateGraph(graph)).toEqual([
      { code: 'PROMPT_MISSING', nodeId: 'edit', field: 'prompt', message: 'Say how to change the picture — or set it on each run.' },
    ])
    const asked = { ...seeded(withSettings('edit', 'ai_edit', { ...defaultSettings('ai_edit'), askAtRun: true })), edges: [edge('seed', 'edit')] }
    expect(validateGraph(asked)).toEqual([])
  })

  it('FORMAT_MISSING: an export without a format', () => {
    const graph: PipelineGraph = {
      version: 1,
      nodes: [node('seed', 'seed_model'), node('fbx', 'export')],
      edges: [edge('seed', 'fbx')],
    }
    expect(codes(graph)).toEqual(['FORMAT_MISSING'])
  })

  it('SEED_NOT_CHOSEN: a model seed without its model, when the graph’s own seed is used', () => {
    const graph: PipelineGraph = { version: 1, nodes: [node('seed', 'seed_model')], edges: [] }
    expect(validateGraph(graph, { requireSeedAsset: true })).toEqual([
      { code: 'SEED_NOT_CHOSEN', nodeId: 'seed', message: 'Choose the model this pipeline starts from.' },
    ])
  })

  it('SETTING_INVALID: what the Studio’s form would refuse', () => {
    const graph = {
      ...seeded(withSettings('gen', 'generate_smart_3d', { ...defaultSettings('generate_smart_3d'), polygonCount: '90000' })),
      edges: [edge('seed', 'gen')],
    }
    expect(validateGraph(graph)).toEqual([
      { code: 'SETTING_INVALID', nodeId: 'gen', field: 'polygonCount', message: 'The polygon count must be between 48 and 20,000.' },
    ])
  })

  it('rebuilds requests from settings before judging them', () => {
    const graph = { ...seeded(withSettings('gen', 'generate_3d')), edges: [edge('seed', 'gen')] }
    graph.nodes[1]!.request = {}
    expect(validateGraph(graph)).toEqual([])
  })

  it('takes a picture in Texture’s legacy Reference input, as the server does', () => {
    const graph: PipelineGraph = {
      version: 1,
      nodes: [withSettings('seed', 'seed_picture'), withSettings('gen', 'generate_3d'), withSettings('tex', 'texture')],
      edges: [edge('seed', 'gen'), edge('gen', 'tex'), edge('seed', 'tex', 'out', 'reference')],
    }
    expect(validateGraph(graph)).toEqual([])
    expect(graphWarnings(graph).map((warning) => warning.code)).toContain('LEGACY_INPUT')
  })
})

describe('runInputProblems — what a run needs before it can start', () => {
  const graph = (texture: Record<string, unknown>, edit = 'Make it bronze'): PipelineGraph => ({
    ...LINEAR,
    nodes: [...LINEAR.nodes, node('edit', 'ai_edit', { prompt: edit }), node('tex', 'texture', texture)],
  })

  it('asks AI texturing for a description or a picture, and AI edit for its instruction', () => {
    expect(runInputProblems(graph({}, ' '))).toEqual([
      { code: 'AI_EDIT_PROMPT_MISSING', nodeId: 'edit', field: 'prompt', message: 'AI edit: say how to change the picture.' },
      { code: 'TEXTURE_INPUT_MISSING', nodeId: 'tex', field: 'prompt', message: 'AI texturing: describe the texture or add a reference picture.' },
    ])
  })

  it('is content with either a description or a picture', () => {
    expect(runInputProblems(graph({ prompt: 'rusty iron' }))).toEqual([])
    expect(runInputProblems(graph({ referenceImageId: 4 }))).toEqual([])
    expect(runInputProblems(graph({ referenceUploadKey: 'inputImg/7/r.png' }))).toEqual([])
  })

  it('names a step by its label', () => {
    const labelled = graph({}, '')
    labelled.nodes = labelled.nodes.map((candidate) => (candidate.id === 'edit' ? { ...candidate, label: 'Gild it' } : candidate))
    expect(runInputProblems(labelled)[0]!.message).toBe('Gild it: say how to change the picture.')
  })

  it('is not part of what makes a pipeline runnable — a draft is made without them', () => {
    expect(messages(graph({}, '')).join(' ')).not.toMatch(/describe the texture/)
  })

  it('reads a step’s settings when it has them', () => {
    const fromSettings: PipelineGraph = {
      version: 1,
      nodes: [withSettings('tex', 'texture', { ...defaultSettings('texture'), prompt: 'oak' })],
      edges: [],
    }
    expect(runInputProblems(fromSettings)).toEqual([])
  })
})

describe('graph helpers', () => {
  it('numbers the steps in the canvas’s order, the seed uncounted', () => {
    expect([...stepPositions(LINEAR)]).toEqual([
      ['gen', 1],
      ['retopo', 2],
      ['uv', 3],
      ['fbx', 4],
    ])
  })

  it('orders a chain from the seed, and is null for a loop', () => {
    expect(topologicalOrder(LINEAR)).toEqual(['seed', 'gen', 'retopo', 'uv', 'fbx'])
    expect(topologicalOrder({ ...LINEAR, edges: [...LINEAR.edges, edge('fbx', 'gen')] })).toBeNull()
  })

  it('gives Isolate Parts a picture output per part', () => {
    expect(outputType('isolate_parts', 'part:shield')).toBe('picture')
    expect(outputType('isolate_parts', 'each')).toBe('picture')
    expect(outputType('retopology', 'part:shield')).toBeNull()
  })

  it('lets a picture into a generation and a model into a refinement, and nothing crosswise or looping', () => {
    expect(canConnect(LINEAR, { source: 'seed', sourceHandle: 'out', target: 'gen', targetHandle: 'in' })).toBe(true)
    expect(canConnect(LINEAR, { source: 'seed', sourceHandle: 'out', target: 'uv', targetHandle: 'in' })).toBe(false)
    expect(canConnect(LINEAR, { source: 'uv', sourceHandle: 'out', target: 'retopo', targetHandle: 'in' })).toBe(false)
  })

  it('knows the steps that run once per part, and what arrives where', () => {
    const graph: PipelineGraph = {
      version: 1,
      nodes: [
        node('seed', 'seed_picture'),
        node('iso', 'isolate_parts'),
        node('views', 'draw_views'),
        node('body', 'generate_smart_3d'),
        node('each', 'generate_3d'),
        node('uv', 'smart_uv'),
      ],
      edges: [edge('seed', 'iso'), edge('iso', 'views', 'character'), edge('views', 'body'), edge('iso', 'each', 'each'), edge('each', 'uv')],
    }
    expect([...fanOutNodes(graph)].sort()).toEqual(['each', 'uv'])
    expect(incomingType(graph, 'body')).toBe('views')
    expect(incomingType(graph, 'each')).toBe('picture')
  })
})

describe('graphWarnings', () => {
  it('names the steps the editor no longer offers', () => {
    expect(graphWarnings(LINEAR)).toEqual([
      { code: 'LEGACY_KIND', nodeId: 'fbx', message: 'Export is no longer offered by the editor; the step still runs.' },
    ])
  })

  it('treats an unknown bone naming as standard, without repeating it', () => {
    const graph: PipelineGraph = { version: 1, nodes: [withSettings('rig', 'rigging', { rigType: 'biped', spec: 'legacy-x', outFormat: 'glb' })], edges: [] }
    const warnings = graphWarnings(graph)
    expect(warnings).toEqual([
      { code: 'RIG_SPEC_REPLACED', nodeId: 'rig', field: 'rigSpec', message: 'Unknown bone-naming value replaced with standard.' },
    ])
    expect(JSON.stringify(warnings)).not.toContain('legacy-x')
    const raw: PipelineGraph = { version: 1, nodes: [node('rig', 'rigging', { rigSpec: 'legacy-x' })], edges: [] }
    expect(graphWarnings(raw).map((warning) => warning.code)).toEqual(['RIG_SPEC_REPLACED'])
  })

  it('reports values it does not know, and never refuses them', () => {
    const graph: PipelineGraph = {
      version: 1,
      nodes: [
        withSettings('seed', 'seed_picture'),
        withSettings('gen', 'generate_3d'),
        withSettings('rig', 'rigging', { rigType: 'centaur', spec: 'standard', outFormat: 'usdz' }),
      ],
      edges: [edge('seed', 'gen'), edge('gen', 'rig')],
    }
    const warnings = graphWarnings(graph)
    expect(warnings.map((warning) => [warning.code, warning.field])).toEqual([
      ['UNKNOWN_VALUE', 'rigType'],
      ['UNKNOWN_VALUE', 'format'],
    ])
    expect(JSON.stringify(warnings)).not.toMatch(/centaur|usdz/)
    expect(validateGraph(graph)).toEqual([])
  })

  it('says when Smart UV follows more triangles than it takes, and when Draw views draws none', () => {
    const graph: PipelineGraph = {
      version: 1,
      nodes: [
        withSettings('seed', 'seed_picture'),
        withSettings('views', 'draw_views', { views: [] }),
        withSettings('gen', 'generate_3d', { ...defaultSettings('generate_3d'), polygonCount: '100000' }),
        withSettings('uv', 'smart_uv'),
      ],
      edges: [edge('seed', 'views'), edge('views', 'gen'), edge('gen', 'uv')],
    }
    const { problems, warnings } = checkGraph(graph)
    expect(problems).toEqual([])
    expect(warnings.map((warning) => warning.code)).toEqual(['NO_VIEWS', 'SMART_UV_TRIANGLES'])
    expect(warnings[1]!.message).toBe(
      'Generate 3d can make about 100,000 triangles — over Smart UV’s 80,000. Add Retopology before it, or lower the polygon count.',
    )
  })
})

describe('seeds', () => {
  const picture: PipelineGraph = { version: 1, nodes: [withSettings('seed', 'seed_picture')], edges: [] }
  const model: PipelineGraph = { version: 1, nodes: [withSettings('seed', 'seed_model')], edges: [] }

  it('knows what a pipeline starts from', () => {
    expect(seedType(picture)).toBe('picture')
    expect(seedType(model)).toBe('model')
    expect(seedType({ version: 1, nodes: [], edges: [] })).toBeNull()
  })

  it('takes 1 to 20 seeds of the kind the seed step takes', () => {
    expect(validateSeeds(picture, [{ uploadKey: 'inputImg/7/a.png', name: 'a.png' }, { gen2dPostId: 4 }])).toEqual([])
    expect(validateSeeds(model, [{ gen3dPostId: 9 }])).toEqual([])
    expect(validateSeeds(picture, [{ gen3dPostId: 9 }])).toEqual([
      { code: 'SEED_INVALID', field: 'seeds[0]', message: 'Seed 1: a picture pipeline takes { uploadKey, name? } or { gen2dPostId }.' },
    ])
    expect(validateSeeds(model, [])[0]!.code).toBe('SEEDS_COUNT')
    expect(validateSeeds(model, Array.from({ length: 21 }, () => ({ gen3dPostId: 1 })))[0]!.code).toBe('SEEDS_COUNT')
  })

  it('splits a long list into batches of 20', () => {
    expect(batchesOf(Array.from({ length: 45 }, (_, index) => index)).map((batch) => batch.length)).toEqual([20, 20, 5])
  })
})

describe('problemFromServer', () => {
  it.each([
    ['Add a seed — the picture or model the pipeline starts from.', 'NO_SEED'],
    ['This input takes a mesh, not a picture.', 'PORT_MISMATCH'],
    ['The pipeline loops back on itself.', 'CYCLE'],
    ['Choose the picture this pipeline starts from.', 'SEED_NOT_CHOSEN'],
    ['Gild it: say how to change the picture.', 'AI_EDIT_PROMPT_MISSING'],
    ['AI texturing: describe the texture or add a reference picture.', 'TEXTURE_INPUT_MISSING'],
    ['Something new.', 'SERVER_PROBLEM'],
  ])('reads %p as %s', (message, code) => {
    expect(problemFromServer({ nodeId: 'x', message })).toEqual({ code, nodeId: 'x', message })
  })

  it('agrees with every message validateGraph writes', () => {
    const graph: PipelineGraph = {
      version: 1,
      nodes: [node('a', 'retopology'), node('a', 'export'), { id: 'z', kind: 'nope' as PipelineNode['kind'], position: { x: 0, y: 0 } }],
      edges: [edge('a', 'a'), edge('a', 'ghost'), edge('a', 'a', 'odd')],
    }
    for (const problem of validateGraph(graph, { requireSeedAsset: true })) {
      expect(problemFromServer({ nodeId: problem.nodeId ?? null, message: problem.message }).code).toBe(problem.code)
    }
  })
})

describe('parseGraph — as the server reads untrusted JSON', () => {
  it('keeps what a graph is and drops what it is not', () => {
    const parsed = parseGraph({
      nodes: [{ id: 'a', kind: 'export', position: { x: '3', y: null }, request: { format: 'glb' }, extra: 1 }, null],
      edges: [{ source: 'a', target: 'b' }, 'nonsense'],
    })
    expect(parsed.nodes).toEqual([{ id: 'a', kind: 'export', position: { x: 3, y: 0 }, request: { format: 'glb' } }])
    expect(parsed.edges).toEqual([{ id: 'e0', source: 'a', sourceHandle: 'out', target: 'b', targetHandle: 'in' }])
  })

  it('cuts ids and labels to length', () => {
    const parsed = parseGraph({ nodes: [{ id: 'x'.repeat(100), kind: 'seed_picture', label: 'y'.repeat(100) }] })
    expect(parsed.nodes[0]!.id).toHaveLength(64)
    expect(parsed.nodes[0]!.label).toHaveLength(80)
    expect(parseGraph(undefined)).toEqual({ version: 1, nodes: [], edges: [] })
  })
})
