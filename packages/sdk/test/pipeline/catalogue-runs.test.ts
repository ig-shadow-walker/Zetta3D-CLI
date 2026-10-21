import { describe, expect, it } from 'vitest'
import {
  ALL_NODE_KINDS,
  LEGACY_NODE_KINDS,
  NODE_KINDS,
  OFFERED_NODE_KINDS,
  defaultSettings,
  forNewRun,
  inputPort,
  isFinished,
  isLive,
  newRunGraph,
  normalizeGraph,
  outputType,
  setOnEachRun,
  settingsWithDefaults,
  toFriendlyValue,
  toRawValue,
  type PipelineGraph,
} from '../../src/pipeline'

describe('NODE_KINDS — the catalogue', () => {
  it('offers the editor’s palette and keeps the legacy kinds loadable', () => {
    expect(OFFERED_NODE_KINDS).toEqual([
      'seed_picture',
      'seed_model',
      'remove_background',
      'ai_edit',
      'draw_views',
      'isolate_parts',
      'generate_3d',
      'generate_smart_3d',
      'retopology',
      'segmentation',
      'texture',
      'smart_uv',
      'rigging',
    ])
    expect(LEGACY_NODE_KINDS).toEqual(['generate_splat', 'smart_segmentation', 'export'])
    expect(Object.keys(NODE_KINDS).sort()).toEqual([...ALL_NODE_KINDS].sort())
  })

  it('mirrors the server’s ports', () => {
    const ports = Object.fromEntries(
      ALL_NODE_KINDS.map((kind) => [
        kind,
        [
          NODE_KINDS[kind].inputs.map((input) => `${input.handle}:${input.accepts.join('|')}${input.required ? '' : '?'}`).join(','),
          NODE_KINDS[kind].outputs.map((output) => `${output.handle}:${output.type}`).join(','),
        ],
      ]),
    )
    expect(ports).toEqual({
      seed_picture: ['', 'out:picture'],
      seed_model: ['', 'out:mesh'],
      remove_background: ['in:picture', 'out:picture'],
      ai_edit: ['in:picture', 'out:picture'],
      draw_views: ['in:picture', 'out:views'],
      isolate_parts: ['in:picture', 'character:picture,each:picture'],
      generate_3d: ['in:picture|views', 'out:mesh'],
      generate_smart_3d: ['in:picture|views', 'out:mesh'],
      generate_splat: ['in:picture', 'out:splat'],
      retopology: ['in:mesh', 'out:mesh'],
      segmentation: ['in:mesh', 'out:mesh'],
      smart_segmentation: ['in:mesh', 'out:mesh'],
      texture: ['in:mesh,reference:picture?', 'out:mesh'],
      smart_uv: ['in:mesh', 'out:mesh'],
      rigging: ['in:mesh', 'out:mesh'],
      export: ['in:mesh', 'out:file'],
    })
    expect(inputPort('texture', 'reference')?.legacy).toBe(true)
    expect(outputType('isolate_parts', 'part:kite-shield')).toBe('picture')
  })

  it('asks for an engine where the server does', () => {
    expect(ALL_NODE_KINDS.filter((kind) => NODE_KINDS[kind].engineChoice)).toEqual(['generate_3d', 'generate_smart_3d', 'generate_splat', 'retopology'])
  })

  it('says how each step gets what a run gives it', () => {
    expect(Object.fromEntries(ALL_NODE_KINDS.map((kind) => [kind, NODE_KINDS[kind].runInput.kind])).seed_picture).toBe('seed')
    expect(NODE_KINDS.texture.runInput.kind).toBe('always')
    expect(NODE_KINDS.ai_edit.runInput.kind).toBe('when-asked')
    expect(NODE_KINDS.retopology.runInput.kind).toBe('none')
  })

  it('stores every setting’s default as the editor’s defaults do', () => {
    for (const kind of ALL_NODE_KINDS) {
      const defaults = defaultSettings(kind)
      for (const setting of NODE_KINDS[kind].settings) {
        if (setting.derived || setting.default === undefined) continue
        const raw = toRawValue(setting, setting.default)
        expect(raw.ok, `${kind}.${setting.name}`).toBe(true)
        if (raw.ok && setting.key in defaults) expect(defaults[setting.key], `${kind}.${setting.name}`).toEqual(raw.value)
      }
    }
  })

  it('maps friendly values to stored ones and back', () => {
    const quality = NODE_KINDS.generate_3d.settings.find((setting) => setting.name === 'quality')!
    expect(toRawValue(quality, 'high')).toEqual({ ok: true, value: 'high-res' })
    expect(toRawValue(quality, 'LOW-POLY')).toEqual({ ok: true, value: 'low-poly' })
    expect(toFriendlyValue(quality, 'ultra')).toEqual({ value: 'ultra' })
    expect(toFriendlyValue(quality, 'medium')).toBeNull()
    const count = NODE_KINDS.generate_3d.settings.find((setting) => setting.name === 'polygonCount')!
    expect(toRawValue(count, 9000)).toEqual({ ok: true, value: '9000' })
    expect(toFriendlyValue(count, '9000')).toEqual({ value: 9000 })
    expect(toFriendlyValue(count, '1e5')).toBeNull()
  })
})

describe('a new run’s copy — AI texturing starts empty in every new run', () => {
  const graphWith = (settings: Record<string, unknown>): PipelineGraph => ({
    version: 1,
    nodes: [{ id: 'tex', kind: 'texture', position: { x: 0, y: 0 }, settings: settingsWithDefaults('texture', settings) }],
    edges: [],
  })

  it('empties the picture an old pipeline held — even one saved as not set on each run', () => {
    const copy = forNewRun(graphWith({ askAtRun: false, reference: { uploadKey: 'inputImg/7/01.png', name: '01.png' } }))
    expect(copy.nodes[0]!.settings).toMatchObject({ reference: null, prompt: '' })
  })

  it('empties a description too, and is always a step set on each run', () => {
    const copy = forNewRun(graphWith({ prompt: 'rusty iron' }))
    expect(copy.nodes[0]!.settings!.prompt).toBe('')
    expect(setOnEachRun(copy.nodes[0]!)).toBe(true)
  })

  it('empties AI edit only when it is set on each run, and rebuilds the requests', () => {
    const graph: PipelineGraph = {
      version: 1,
      nodes: [
        { id: 'a', kind: 'ai_edit', position: { x: 0, y: 0 }, settings: { prompt: 'gold', askAtRun: true } },
        { id: 'b', kind: 'ai_edit', position: { x: 0, y: 0 }, settings: { prompt: 'gold' } },
      ],
      edges: [],
    }
    const copy = newRunGraph(graph)
    expect(copy.nodes.map((node) => node.request!.prompt)).toEqual(['', 'gold'])
  })
})

describe('normalizeGraph — a saved graph as the editor opens it', () => {
  it('fills defaults, lets the seed go, drops wires into inputs a step no longer has, and replaces an unknown bone naming', () => {
    const saved: PipelineGraph = {
      version: 1,
      nodes: [
        { id: 'seed', kind: 'seed_picture', position: { x: 0, y: 0 }, settings: { source: 'upload', uploadKey: 'inputImg/7/a.png' }, request: { uploadKey: 'inputImg/7/a.png' } },
        { id: 'gen', kind: 'generate_3d', position: { x: 0, y: 0 }, settings: { model: 'n1' } },
        { id: 'tex', kind: 'texture', position: { x: 0, y: 0 }, settings: { prompt: 'oak' } },
        { id: 'rig', kind: 'rigging', position: { x: 0, y: 0 }, settings: { spec: 'legacy-x' } },
      ],
      edges: [
        { id: 'a', source: 'seed', sourceHandle: 'out', target: 'gen', targetHandle: 'in' },
        { id: 'b', source: 'gen', sourceHandle: 'out', target: 'tex', targetHandle: 'in' },
        { id: 'c', source: 'seed', sourceHandle: 'out', target: 'tex', targetHandle: 'reference' },
        { id: 'd', source: 'tex', sourceHandle: 'out', target: 'rig', targetHandle: 'in' },
      ],
    }
    const { graph, warnings } = normalizeGraph(saved)
    expect(graph.nodes[0]).toMatchObject({ settings: { source: null }, request: {} })
    expect(graph.nodes[1]!.settings).toEqual(settingsWithDefaults('generate_3d', { model: 'n1' }))
    expect(graph.nodes[2]!.settings).toMatchObject({ prompt: '', reference: null })
    expect(graph.nodes[3]!.settings!.spec).toBe('standard')
    expect(graph.edges.map((edge) => edge.id)).toEqual(['a', 'b', 'd'])
    expect(warnings).toHaveLength(2)
    expect(JSON.stringify(warnings)).not.toContain('legacy-x')
  })
})

describe('run statuses', () => {
  it('knows which runs are still moving and which are over', () => {
    expect(['running', 'paused', 'awaiting'].every((status) => isLive(status as never))).toBe(true)
    expect(isLive('draft')).toBe(false)
    expect(['done', 'failed', 'cancelled'].every((status) => isFinished(status as never))).toBe(true)
    expect(isFinished('awaiting')).toBe(false)
  })
})

describe('a loaded graph with values of the wrong type', () => {
  const odd: PipelineGraph = {
    version: 1,
    nodes: [
      { id: 'seed', kind: 'seed_picture', position: { x: 0, y: 0 }, settings: { source: 3 } },
      { id: 'gen', kind: 'generate_3d', position: { x: 0, y: 0 }, settings: { model: 'z9', quality: 7, polygonCount: 5000, polygonType: null } },
      { id: 'gen1', kind: 'generate_3d', position: { x: 0, y: 0 }, settings: { model: 'n1', polygonCount: 5000 } },
      { id: 'views', kind: 'draw_views', position: { x: 0, y: 0 }, settings: { views: 'back' } },
      { id: 'iso', kind: 'isolate_parts', position: { x: 0, y: 0 }, settings: { maxParts: 'many', extraParts: 4, pose: 'x' } },
      { id: 'topo', kind: 'retopology', position: { x: 0, y: 0 }, settings: { engine: 'r1', faces: 'lots' } },
      { id: 'seg', kind: 'segmentation', position: { x: 0, y: 0 }, settings: { mode: 'other', hint: 9 } },
      { id: 'tex', kind: 'texture', position: { x: 0, y: 0 }, settings: { tier: null, reference: 'x', prompt: 4 } },
      { id: 'rig', kind: 'rigging', position: { x: 0, y: 0 }, settings: { rigType: 1, spec: 2, outFormat: [] } },
    ],
    edges: [],
  }

  it('never throws, and reports instead', async () => {
    const pipeline = await import('../../src/pipeline')
    expect(() => pipeline.normalizeGraph(odd)).not.toThrow()
    expect(() => pipeline.validateGraph(odd)).not.toThrow()
    expect(() => pipeline.runInputProblems(odd)).not.toThrow()
    expect(pipeline.graphWarnings(odd).filter((warning) => warning.code === 'UNKNOWN_VALUE').length).toBeGreaterThan(8)
    const { doc } = pipeline.decompilePipeline(odd)
    const back = pipeline.compilePipeline(doc, { validate: false })
    expect(back.ok).toBe(true)
    if (back.ok) expect(back.graph.nodes.find((node) => node.id === 'rig')!.settings!.spec).toBe('standard')
  })
})
