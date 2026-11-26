import { describe, expect, it } from 'vitest'
import {
  NODE_KINDS,
  PIPELINE_DOC_EXAMPLES,
  PIPELINE_DOC_JSON_SCHEMA,
  applyFormPatch,
  compilePipeline,
  decompilePipeline,
  defaultSettings,
  runNodeChange,
  settingsWithDefaults,
  withRequests,
  type CompileResult,
  type GenerateForm,
  type PipelineDoc,
  type PipelineGraph,
  type PipelineNode,
} from '../../src/pipeline'
import { ALL_NODE_KINDS } from '../../src/pipeline/types'

function compiled(doc: unknown, options = {}): Extract<CompileResult, { ok: true }> {
  const result = compilePipeline(doc, options)
  if (!result.ok) throw new Error(`expected a graph, got: ${JSON.stringify(result.problems)}`)
  return result
}

function refused(doc: unknown, options = {}) {
  const result = compilePipeline(doc, options)
  if (result.ok) throw new Error('expected problems')
  return result.problems
}

const nodeOf = (graph: PipelineGraph, id: string) => graph.nodes.find((node) => node.id === id)!
const wiresOf = (graph: PipelineGraph) => graph.edges.map((edge) => `${edge.source}.${edge.sourceHandle}->${edge.target}.${edge.targetHandle}`)

/** The task's own example. */
const RIGGED: PipelineDoc = {
  version: 1,
  title: 'Picture to rigged character',
  steps: {
    photo: { kind: 'seed_picture' },
    clean: { kind: 'remove_background', from: 'photo' },
    model: { kind: 'generate_3d', from: 'clean', engine: 'n25', quality: 'high', output: 'textured' },
    rig: { kind: 'rigging', from: 'model', rigType: 'biped', rigSpec: 'standard', format: 'fbx' },
  },
}

describe('compilePipeline', () => {
  it('turns the friendly document into the graph the editor would make', () => {
    const { graph, title, warnings } = compiled(RIGGED)
    expect(title).toBe('Picture to rigged character')
    expect(warnings).toEqual([])
    expect(graph.version).toBe(1)
    expect(graph.nodes.map((node) => [node.id, node.kind, node.position])).toEqual([
      ['photo', 'seed_picture', { x: 0, y: 0 }],
      ['clean', 'remove_background', { x: 300, y: 0 }],
      ['model', 'generate_3d', { x: 600, y: 0 }],
      ['rig', 'rigging', { x: 900, y: 0 }],
    ])
    expect(graph.edges).toEqual([
      { id: 'e1', source: 'photo', sourceHandle: 'out', target: 'clean', targetHandle: 'in' },
      { id: 'e2', source: 'clean', sourceHandle: 'out', target: 'model', targetHandle: 'in' },
      { id: 'e3', source: 'model', sourceHandle: 'out', target: 'rig', targetHandle: 'in' },
    ])
    expect(nodeOf(graph, 'photo')).toMatchObject({ settings: { source: null }, request: {} })
    expect(nodeOf(graph, 'model').settings).toEqual(defaultSettings('generate_3d'))
    expect(nodeOf(graph, 'rig')).toMatchObject({
      settings: { rigType: 'biped', spec: 'standard', outFormat: 'fbx' },
      request: { spec: { postProcess: ['auto_rigging'] }, rigOutFormat: 'fbx' },
    })
  })

  it('compiles every example, and validates it', () => {
    for (const example of PIPELINE_DOC_EXAMPLES) {
      const result = compilePipeline(example.doc)
      expect(result.ok, example.name).toBe(true)
    }
  })

  it('wires Isolate Parts’ outputs, drawn views and per-part branches', () => {
    const { graph } = compiled(PIPELINE_DOC_EXAMPLES[1]!.doc)
    expect(wiresOf(graph)).toEqual([
      'photo.out->split.in',
      'split.character->views.in',
      'views.out->hero.in',
      'hero.out->heroRig.in',
      'split.each->props.in',
      'props.out->propsUv.in',
    ])
    // Views coming in make the generation multi-view.
    expect((nodeOf(graph, 'hero').request!.spec as { generation: { modifiers: string[] } }).generation.modifiers).toContain('multi_view')
    expect(nodeOf(graph, 'split').settings).toMatchObject({ pose: 'a', maxParts: 4 })
    expect(nodeOf(graph, 'props')).toMatchObject({ settings: { model: 'np15', polygonCount: '8000' }, request: { faceCount: 8000 } })
    // Branches are laid out one row apart.
    expect(nodeOf(graph, 'views').position).toEqual({ x: 600, y: 0 })
    expect(nodeOf(graph, 'props').position).toEqual({ x: 600, y: 200 })
  })

  it('takes one part on its own branch', () => {
    const { graph } = compiled({
      steps: {
        photo: { kind: 'seed_picture' },
        iso: { kind: 'isolate_parts', from: 'photo', extraParts: ['sword'] },
        sword: { kind: 'generate_3d', from: 'iso.part:sword' },
      },
    })
    expect(wiresOf(graph)).toContain('iso.part:sword->sword.in')
  })

  it('takes `from` as a string, a list in input order, or an object by input', () => {
    const steps = (from: unknown) => ({
      steps: {
        photo: { kind: 'seed_picture' },
        model: { kind: 'generate_3d', from: 'photo' },
        tex: { kind: 'texture', from, prompt: 'oak' },
      },
    })
    expect(wiresOf(compiled(steps('model')).graph)).toContain('model.out->tex.in')
    const listed = compiled(steps(['model', 'photo']))
    expect(wiresOf(listed.graph)).toEqual(expect.arrayContaining(['model.out->tex.in', 'photo.out->tex.reference']))
    expect(listed.warnings.join(' ')).toMatch(/no longer has this input/)
    expect(wiresOf(compiled(steps({ in: 'model', reference: 'photo' })).graph)).toContain('photo.out->tex.reference')
  })

  it('accepts other spellings of a value, in any case', () => {
    const { graph } = compiled({
      steps: {
        photo: { kind: 'seed_picture' },
        iso: { kind: 'isolate_parts', from: 'photo', pose: 'A' },
        gen: { kind: 'generate_3d', from: 'iso.character', quality: 'high-res', polygonType: 'quads', textureAlignment: 'original_image' },
        tex: { kind: 'texture', from: 'gen', tier: 'retexture_hd', prompt: 'gold' },
      },
    })
    expect(nodeOf(graph, 'iso').settings!.pose).toBe('a')
    expect(nodeOf(graph, 'gen').settings).toMatchObject({ quality: 'high-res', polygonType: 'quadrilateral', textureAlignment: 'original_image' })
    expect(nodeOf(graph, 'tex').request!.spec).toEqual({ postProcess: ['retexture_hd'] })
  })

  it('settles the generate form as the Studio does: engine, rung, topology, then the count', () => {
    const settingsFor = (fields: Record<string, unknown>, kind = 'generate_3d') =>
      nodeOf(compiled({ steps: { photo: { kind: 'seed_picture' }, gen: { kind, from: 'photo', ...fields } } }).graph, 'gen').settings!
    expect(settingsFor({ engine: 'n1', quality: 'ultra' }).polygonCount).toBe('1000000')
    expect(settingsFor({ quality: 'ultra' }).polygonCount).toBe('2000000')
    expect(settingsFor({ engine: 'np15', polygonType: 'quad' }, 'generate_smart_3d').polygonCount).toBe('25000')
    expect(settingsFor({ quality: 'ultra', polygonCount: 500000 }).polygonCount).toBe('500000')
    expect(settingsFor({ segmentParts: true })).toMatchObject({ output: 'geometry', polygonType: 'triangle' })
  })

  it('says when the Studio’s rules change what was asked', () => {
    const lowOnNp = compiled({ steps: { photo: { kind: 'seed_picture' }, gen: { kind: 'generate_smart_3d', from: 'photo', quality: 'low' } } })
    expect(nodeOf(lowOnNp.graph, 'gen').settings!.quality).toBe('high-res')
    expect(lowOnNp.warnings).toEqual(['Step "gen": quality is high, not low: Zetta Np1\'s rules changed it, as the Studio does.'])
    const countMovesRung = compiled({
      steps: { photo: { kind: 'seed_picture' }, gen: { kind: 'generate_3d', from: 'photo', engine: 'n1', quality: 'high', polygonCount: 9000 } },
    })
    expect(nodeOf(countMovesRung.graph, 'gen').settings!.quality).toBe('low-poly')
    expect(countMovesRung.warnings[0]).toMatch(/quality is low, not high/)
  })

  it('treats any bone naming but standard or mixamo as standard, and never repeats it', () => {
    const result = compiled({ steps: { m: { kind: 'seed_model' }, rig: { kind: 'rigging', from: 'm', rigSpec: 'legacy-x' } } })
    expect(nodeOf(result.graph, 'rig').settings!.spec).toBe('standard')
    expect(result.warnings).toEqual(['Step "rig": Unknown bone-naming value replaced with standard.'])
    const raw = compiled({ steps: { m: { kind: 'seed_model' }, rig: { kind: 'rigging', from: 'm', settings: { spec: 'legacy-x' } } } })
    expect(nodeOf(raw.graph, 'rig').settings!.spec).toBe('standard')
    expect(JSON.stringify(raw)).not.toContain('legacy-x')
  })

  it('applies raw settings after the friendly ones, keeping keys it does not know', () => {
    const { graph } = compiled({
      steps: { photo: { kind: 'seed_picture' }, iso: { kind: 'isolate_parts', from: 'photo', settings: { knownParts: [{ key: 'sword', label: 'sword' }] } } },
    })
    expect(nodeOf(graph, 'iso').settings!.knownParts).toEqual([{ key: 'sword', label: 'sword' }])
  })

  it('uses a raw request as it is', () => {
    const { graph, warnings } = compiled({
      steps: { m: { kind: 'seed_model' }, topo: { kind: 'retopology', from: 'm', request: { model: 'r1', faceCount: 900 } } },
    })
    expect(nodeOf(graph, 'topo')).not.toHaveProperty('settings')
    expect(nodeOf(graph, 'topo').request).toEqual({ model: 'r1', faceCount: 900 })
    expect(warnings).toEqual([])
  })

  it('places steps the layout names, and lays out the rest', () => {
    const { graph, warnings } = compiled({ ...RIGGED, layout: { rig: { x: 5, y: 7 }, ghost: { x: 1, y: 1 } } })
    expect(nodeOf(graph, 'rig').position).toEqual({ x: 5, y: 7 })
    expect(nodeOf(graph, 'clean').position).toEqual({ x: 300, y: 0 })
    expect(warnings).toEqual(['layout names no step "ghost"; it was ignored.'])
  })

  it('names what each run must give', () => {
    const { warnings } = compiled(PIPELINE_DOC_EXAMPLES[2]!.doc)
    expect(warnings).toEqual(['Step "paint": each run must give it — AI texturing: describe the texture or add a reference picture.'])
  })

  it('warns about legacy kinds and ignores unknown top-level keys', () => {
    const { warnings } = compiled({
      description: 'x',
      steps: { m: { kind: 'seed_model' }, out: { kind: 'export', from: 'm', format: 'obj' } },
    })
    expect(warnings).toEqual([
      '"description" is not part of a pipeline document and was ignored.',
      'Step "out": Export is no longer offered by the editor; the step still runs.',
    ])
  })

  it('refuses a graph with problems unless asked not to', () => {
    const draft = { steps: { photo: { kind: 'seed_picture' }, edit: { kind: 'ai_edit', from: 'photo' }, topo: { kind: 'retopology' } } }
    expect(refused(draft).map((problem) => [problem.code, problem.nodeId])).toEqual([
      ['INPUT_NOT_CONNECTED', 'topo'],
      ['PROMPT_MISSING', 'edit'],
    ])
    expect(compilePipeline(draft, { validate: false }).ok).toBe(true)
  })

  it('refuses a type mismatch through validation', () => {
    expect(refused({ steps: { photo: { kind: 'seed_picture' }, topo: { kind: 'retopology', from: 'photo' } } })).toEqual([
      { code: 'PORT_MISMATCH', nodeId: 'topo', message: 'This input takes a mesh, not a picture.' },
    ])
    expect(refused({ steps: { photo: { kind: 'seed_picture' }, gen: { kind: 'generate_smart_3d_multiview', from: 'photo' } } })[0]!.message).toBe(
      'Multi-view - Smart 3D takes pictures of each side — connect a Multi-view seed or Draw views, or use Generate Smart 3D for one picture.',
    )
  })

  it('reads an older recipe — a one-picture generation fed views — as its multi-view step, and says so', () => {
    const { graph, warnings } = compiled({
      steps: {
        photo: { kind: 'seed_picture' },
        views: { kind: 'draw_views', from: 'photo' },
        gen: { kind: 'generate_3d', from: 'views', quality: 'ultra' },
      },
    })
    expect(nodeOf(graph, 'gen')).toMatchObject({ kind: 'generate_3d_multiview', settings: { quality: 'ultra' } })
    expect((nodeOf(graph, 'gen').request!.spec as { generation: { modifiers: string[] } }).generation.modifiers).toContain('multi_view')
    expect(warnings).toEqual([
      'Step "gen": generate_3d takes one picture; fed pictures of each side it is generate_3d_multiview — write that kind.',
    ])
  })

  it('compiles a Multi-view seed into multi-view steps, and asks each run for what it gives', () => {
    const { graph, warnings } = compiled(PIPELINE_DOC_EXAMPLES[3]!.doc)
    expect(wiresOf(graph)).toEqual(['photos.out->model.in', 'model.out->paint.in', 'photos.out->paint.views', 'paint.out->uv.in'])
    expect(nodeOf(graph, 'photos')).toMatchObject({ kind: 'seed_views', settings: {}, request: {} })
    expect(nodeOf(graph, 'model')).toMatchObject({ settings: { model: 'np15', polygonCount: '12000' }, request: { model: 'np15', faceCount: 12000 } })
    expect(nodeOf(graph, 'paint').request).toMatchObject({ spec: { postProcess: ['retexture_hd'] }, referenceViews: [], removeReferenceBackground: true })
    // Views wired in: nothing more for each run to give.
    expect(warnings).toEqual([])
    const unwired = compiled({ steps: { ...PIPELINE_DOC_EXAMPLES[3]!.doc.steps, paint: { kind: 'texture_multiview', from: 'model' } } })
    expect(unwired.warnings).toEqual([
      'Step "paint": each run must give it — Multi-view - AI texturing: add the pictures of each side — a front one at least.',
    ])
  })

  it('takes pictures of each side as { front, back, left, right }, the front required', () => {
    const steps = (views: unknown) => ({
      steps: { m: { kind: 'seed_model' }, paint: { kind: 'texture_multiview', from: 'm', views } },
    })
    const { graph, warnings } = compiled(steps({ back: { gen2dPostId: 4 }, front: { uploadKey: 'inputImg/7/f.png', name: 'f.png' } }))
    expect(nodeOf(graph, 'paint').settings!.referenceViews).toEqual({ front: { uploadKey: 'inputImg/7/f.png', name: 'f.png' }, back: { gen2dPostId: 4 } })
    expect(nodeOf(graph, 'paint').request!.referenceViews).toEqual([
      { viewType: 'front', uploadKey: 'inputImg/7/f.png', name: 'f.png' },
      { viewType: 'back', gen2dPostId: 4 },
    ])
    expect(warnings).toEqual([])
    expect(refused(steps({ back: { gen2dPostId: 4 } }))[0]).toMatchObject({ code: 'SETTING_INVALID', field: 'views', message: 'views needs a front picture.' })
    expect(refused(steps({ front: { gen2dPostId: 4 }, top: { gen2dPostId: 5 } }))[0]!.message).toBe('views names sides front, back, left, right only.')
    expect(refused(steps({ front: 'f.png' }))[0]!.code).toBe('SETTING_INVALID')
  })

  it('gives a Multi-view seed no settings: each run gives its pictures', () => {
    expect(refused({ steps: { photos: { kind: 'seed_views', views: {} } } })[0]!.message).toBe(
      'seed_views has no settings: each run is given its pictures of each side as a seed.',
    )
  })
})

describe('compilePipeline — every document problem', () => {
  const base = { photo: { kind: 'seed_picture' } }
  const codesOf = (doc: unknown) => refused(doc).map((problem) => problem.code)

  it.each([
    ['DOC_INVALID', 'nope'],
    ['DOC_INVALID', ['steps']],
    ['VERSION_UNSUPPORTED', { version: 2, steps: base }],
    ['TITLE_INVALID', { title: 'x'.repeat(201), steps: base }],
    ['STEPS_INVALID', { steps: {} }],
    ['STEPS_INVALID', { steps: [{ kind: 'seed_picture' }] }],
    ['STEP_ID_INVALID', { steps: { ...base, 'bad id': { kind: 'remove_background', from: 'photo' } } }],
    ['STEP_INVALID', { steps: { ...base, cut: 'remove_background' } }],
    ['UNKNOWN_KIND', { steps: { ...base, cut: { kind: 'teleport', from: 'photo' } } }],
    ['LABEL_INVALID', { steps: { ...base, cut: { kind: 'remove_background', from: 'photo', label: 7 } } }],
    ['SETTINGS_INVALID', { steps: { ...base, cut: { kind: 'remove_background', from: 'photo', settings: [] } } }],
    ['REQUEST_INVALID', { steps: { ...base, cut: { kind: 'remove_background', from: 'photo', request: 'x' } } }],
    ['UNKNOWN_SETTING', { steps: { ...base, cut: { kind: 'remove_background', from: 'photo', strength: 2 } } }],
    ['UNKNOWN_SETTING', { steps: { photo: { kind: 'seed_picture', uploadKey: 'inputImg/7/a.png' } } }],
    ['SETTING_INVALID', { steps: { ...base, gen: { kind: 'generate_3d', from: 'photo', engine: 'np15' } } }],
    ['SETTING_INVALID', { steps: { ...base, iso: { kind: 'isolate_parts', from: 'photo', maxParts: 40 } } }],
    ['SETTING_INVALID', { steps: { ...base, iso: { kind: 'isolate_parts', from: 'photo', identify: 'yes' } } }],
    ['SETTING_INVALID', { steps: { ...base, views: { kind: 'draw_views', from: 'photo', views: ['top'] } } }],
    ['SETTING_INVALID', { steps: { ...base, gen: { kind: 'generate_3d', from: 'photo', polygonCount: 1.5 } } }],
    ['FROM_INVALID', { steps: { photo: { kind: 'seed_picture', from: 'photo' } } }],
    ['FROM_INVALID', { steps: { ...base, cut: { kind: 'remove_background', from: ['photo', 'photo'] } } }],
    ['FROM_INVALID', { steps: { ...base, cut: { kind: 'remove_background', from: 7 } } }],
    ['UNKNOWN_STEP', { steps: { ...base, cut: { kind: 'remove_background', from: 'picture' } } }],
    ['UNKNOWN_OUTPUT', { steps: { ...base, cut: { kind: 'remove_background', from: 'photo.each' } } }],
    ['OUTPUT_AMBIGUOUS', { steps: { ...base, iso: { kind: 'isolate_parts', from: 'photo' }, gen: { kind: 'generate_3d', from: 'iso' } } }],
    ['UNKNOWN_INPUT', { steps: { ...base, cut: { kind: 'remove_background', from: { side: 'photo' } } } }],
    ['LAYOUT_INVALID', { steps: base, layout: { photo: { x: 'left' } } }],
  ])('%s', (code, doc) => {
    expect(codesOf(doc)).toContain(code)
  })

  it('never repeats a refused value, and lists what is allowed', () => {
    const problems = refused({ steps: { ...base, gen: { kind: 'generate_3d', from: 'photo', engine: 'secret-engine' } } })
    expect(problems).toEqual([{ code: 'SETTING_INVALID', nodeId: 'gen', field: 'engine', message: 'engine must be one of: n25.' }])
    expect(refused({ steps: { ...base, cut: { kind: 'remove_background', from: 'photo', strength: 2 } } })[0]!.message).toBe(
      'remove_background has no settings.',
    )
    expect(refused({ steps: { ...base, rig: { kind: 'rigging', from: 'photo', bones: 3 } } })[0]!.message).toBe(
      'rigging has no setting "bones". Its settings: rigType, rigSpec, format.',
    )
  })

  it('says which outputs a step with several has', () => {
    const problems = refused({ steps: { ...base, iso: { kind: 'isolate_parts', from: 'photo' }, gen: { kind: 'generate_3d', from: 'iso' } } })
    expect(problems[0]!.message).toBe('iso (isolate_parts) has several outputs: write iso.character, iso.each, iso.part:<key>.')
  })
})

/* ------------------------------------------------------------------------------ round trips */

let counter = 0
const webId = (kind: string) => `${kind.replace(/_/g, '-')}-${(++counter).toString(36).padStart(7, 'k')}`

/** A graph as the web editor saves one: nodes added from the palette, edited through the forms, autosaved with requests. */
function editorGraph(): PipelineGraph {
  const add = (kind: PipelineNode['kind'], settings: Record<string, unknown>, position: { x: number; y: number }, label?: string): PipelineNode => ({
    id: webId(kind),
    kind,
    position,
    settings,
    ...(label ? { label } : {}),
  })
  const form = (kind: 'generate_3d' | 'generate_smart_3d', ...patches: Array<Partial<GenerateForm>>) =>
    patches.reduce<GenerateForm>((current, patch) => applyFormPatch(current, patch), defaultSettings(kind) as unknown as GenerateForm)
  const seed = add('seed_picture', defaultSettings('seed_picture'), { x: 40, y: 80 })
  const iso = add('isolate_parts', { ...defaultSettings('isolate_parts'), sensitivity: 'medium', knownParts: [{ key: 'sword', label: 'Sword' }] }, { x: 320, y: 90 })
  const views = add('draw_views', { views: ['back', 'left'] }, { x: 610, y: 12 })
  const hero = add('generate_3d_multiview', { ...form('generate_3d', { quality: 'ultra' }, { polygonCount: '500000', polygonCountTyped: true }) }, { x: 900, y: 0 }, 'Hero')
  const rig = add('rigging', { ...defaultSettings('rigging'), rigType: 'quadruped', spec: 'mixamo' }, { x: 1200, y: 0 })
  const sword = add('generate_smart_3d', { ...form('generate_smart_3d', { model: 'np15' }, { polygonType: 'quadrilateral' }) }, { x: 620, y: 300 })
  const topo = add('retopology', { ...defaultSettings('retopology'), faces: 6000, bake: false }, { x: 910, y: 310 })
  const tex = add('texture', { ...defaultSettings('texture'), tier: 'retexture_8k', alignment: 'geometry', reference: null }, { x: 1210, y: 300 })
  const uv = add('smart_uv', { ...defaultSettings('smart_uv'), orientation: '-x' }, { x: 1500, y: 300 })
  const edit = add('ai_edit', { ...defaultSettings('ai_edit'), askAtRun: true, model: 'image-x' }, { x: 620, y: 600 })
  const edge = (source: PipelineNode, target: PipelineNode, sourceHandle = 'out', targetHandle = 'in') => ({
    id: `e-${Math.random().toString(36).slice(2, 9)}`,
    source: source.id,
    sourceHandle,
    target: target.id,
    targetHandle,
  })
  return withRequests({
    version: 1,
    nodes: [seed, iso, views, hero, rig, sword, topo, tex, uv, edit],
    // In the order they were drawn, not the order of the steps.
    edges: [
      edge(iso, edit, 'each'),
      edge(tex, uv),
      edge(seed, iso),
      edge(iso, sword, 'part:sword'),
      edge(views, hero),
      edge(iso, views, 'character'),
      edge(sword, topo),
      edge(hero, rig),
      edge(topo, tex),
    ],
  })
}

/** A graph without its edge ids or edge order, which a document does not carry. */
const comparable = (graph: PipelineGraph) => ({
  version: graph.version,
  nodes: graph.nodes,
  edges: graph.edges.map((edge) => `${edge.source}.${edge.sourceHandle}->${edge.target}.${edge.targetHandle}`).sort(),
})

describe('decompilePipeline', () => {
  it('round-trips a graph made by the web editor', () => {
    const graph = editorGraph()
    const { doc, warnings } = decompilePipeline(graph)
    expect(warnings).toEqual([])
    const back = compiled(doc)
    expect(comparable(back.graph)).toEqual(comparable(graph))
  })

  it('writes settings in friendly names, only where they differ from the defaults', () => {
    const graph = editorGraph()
    const { doc } = decompilePipeline({ title: 'Knight', graph })
    expect(doc.title).toBe('Knight')
    const steps = Object.values(doc.steps)
    const byKind = (kind: string) => steps.find((step) => step.kind === kind)!
    expect(byKind('seed_picture')).toEqual({ kind: 'seed_picture' })
    expect(byKind('rigging')).toMatchObject({ rigType: 'quadruped', rigSpec: 'mixamo' })
    expect(byKind('rigging')).not.toHaveProperty('format')
    expect(byKind('generate_smart_3d')).toMatchObject({ engine: 'np15', polygonType: 'quad' })
    expect(byKind('texture')).toMatchObject({ tier: '8k', alignment: 'mesh' })
    expect(byKind('ai_edit')).toEqual({ kind: 'ai_edit', from: expect.stringMatching(/\.each$/), askAtRun: true, imageEngine: 'image-x' })
    expect(byKind('generate_3d_multiview')).toMatchObject({ label: 'Hero', quality: 'ultra', polygonCount: 500000 })
    // What friendly names cannot say is kept raw.
    expect(byKind('isolate_parts').settings).toEqual({ knownParts: [{ key: 'sword', label: 'Sword' }] })
    expect(byKind('generate_3d_multiview').settings).toEqual({ polygonCountTyped: true })
    expect(doc.layout).toBeDefined()
  })

  it('gives the same document back for a document written in friendly names', () => {
    const doc: PipelineDoc = {
      version: 1,
      title: 'Canonical',
      steps: {
        photo: { kind: 'seed_picture' },
        clean: { kind: 'remove_background', from: 'photo' },
        model: { kind: 'generate_3d', from: 'clean', quality: 'ultra', pbr: false },
        topo: { kind: 'retopology', from: 'model', faces: 12000 },
        rig: { kind: 'rigging', from: 'topo', format: 'fbx' },
      },
    }
    expect(decompilePipeline({ title: 'Canonical', graph: compiled(doc).graph }).doc).toEqual(doc)
  })

  it('writes the examples back concisely, with nothing raw and nothing implied', () => {
    for (const example of PIPELINE_DOC_EXAMPLES) {
      const { doc, warnings } = decompilePipeline(compiled(example.doc).graph)
      expect(warnings).toEqual([])
      for (const [id, step] of Object.entries(doc.steps)) {
        expect(step, `${example.name}.${id}`).not.toHaveProperty('settings')
        for (const [field, value] of Object.entries(step)) expect(example.doc.steps[id]![field], `${example.name}.${id}.${field}`).toEqual(value)
      }
    }
    // On an Np engine a typed count also moves the stored rung, as in the Studio; the count alone says it.
    const props = decompilePipeline(compiled(PIPELINE_DOC_EXAMPLES[1]!.doc).graph).doc.steps.props
    expect(props).toEqual({ kind: 'generate_smart_3d', from: 'split.each', engine: 'np15', polygonCount: 8000 })
  })

  it('reads a graph the in-app agent drafted — partial settings, no requests — as the editor opens it', () => {
    const drafted: PipelineGraph = {
      version: 1,
      nodes: [
        { id: 'seed', kind: 'seed_picture', position: { x: 0, y: 0 }, settings: { source: null }, request: {} },
        { id: 's0', kind: 'generate_smart_3d', position: { x: 300, y: 0 }, settings: { model: 'np15' } },
        { id: 's1', kind: 'rigging', position: { x: 600, y: 0 }, settings: { rigType: 'quadruped' } },
      ],
      edges: [
        { id: 'e0', source: 'seed', sourceHandle: 'out', target: 's0', targetHandle: 'in' },
        { id: 'e1', source: 's0', sourceHandle: 'out', target: 's1', targetHandle: 'in' },
      ],
    }
    const { doc } = decompilePipeline(drafted)
    expect(doc.steps.s0).toEqual({ kind: 'generate_smart_3d', from: 'seed', engine: 'np15' })
    const back = compiled(doc).graph
    expect(nodeOf(back, 's0').settings).toEqual(settingsWithDefaults('generate_smart_3d', { model: 'np15' }))
    // Np1's 20,000 is still inside Np1.5's range, so the editor keeps it.
    expect(nodeOf(back, 's0').settings!.polygonCount).toBe('20000')
    expect(nodeOf(back, 's1').request).toEqual({ spec: { postProcess: ['auto_rigging'] }, rigType: 'quadruped' })
  })

  it('is stable: decompiling what it compiled gives the same document', () => {
    for (const example of PIPELINE_DOC_EXAMPLES) {
      const first = decompilePipeline(compiled(example.doc).graph).doc
      const second = decompilePipeline(compiled(first).graph).doc
      expect(second).toEqual(first)
    }
  })

  it('keeps a raw request for a step with no settings, and round-trips it', () => {
    const graph: PipelineGraph = {
      version: 1,
      nodes: [
        { id: 'seed', kind: 'seed_picture', position: { x: 0, y: 0 }, request: { uploadKey: 'inputImg/7/a.png' } },
        { id: 'gen', kind: 'generate_smart_3d', position: { x: 300, y: 0 }, request: { model: 'np15', spec: { generation: { base: 'textured' } } } },
        { id: 'iso', kind: 'isolate_parts', position: { x: 600, y: 0 } },
      ],
      edges: [{ id: 'a', source: 'seed', sourceHandle: 'out', target: 'gen', targetHandle: 'in' }],
    }
    const { doc, warnings } = decompilePipeline(graph)
    expect(doc.steps.gen).toEqual({ kind: 'generate_smart_3d', from: 'seed', request: { model: 'np15', spec: { generation: { base: 'textured' } } } })
    expect(warnings).toHaveLength(3)
    const back = compiled(doc, { validate: false })
    expect(back.graph.nodes).toEqual(graph.nodes.map((node) => ({ ...node, request: node.request ?? {} })))
  })

  it('replaces an unknown bone naming with standard, and never writes it out', () => {
    const graph: PipelineGraph = {
      version: 1,
      nodes: [
        { id: 'm', kind: 'seed_model', position: { x: 0, y: 0 }, settings: {} },
        { id: 'rig', kind: 'rigging', position: { x: 300, y: 0 }, settings: { rigType: 'biped', spec: 'legacy-x', outFormat: 'fbx' }, request: { rigSpec: 'legacy-x' } },
        { id: 'old', kind: 'rigging', position: { x: 600, y: 0 }, request: { spec: { postProcess: ['auto_rigging'] }, rigSpec: 'legacy-x' } },
      ],
      edges: [
        { id: 'a', source: 'm', sourceHandle: 'out', target: 'rig', targetHandle: 'in' },
        { id: 'b', source: 'rig', sourceHandle: 'out', target: 'old', targetHandle: 'in' },
      ],
    }
    const { doc, warnings } = decompilePipeline(graph)
    expect(JSON.stringify(doc)).not.toContain('legacy-x')
    expect(JSON.stringify(warnings)).not.toContain('legacy-x')
    expect(warnings).toContain('Step "rig": Unknown bone-naming value replaced with standard.')
    expect(warnings).toContain('Step "old": Unknown bone-naming value replaced with standard.')
    expect(doc.steps.rig).toEqual({ kind: 'rigging', from: 'm', format: 'fbx' })
    const back = compiled(doc)
    expect(nodeOf(back.graph, 'rig').settings!.spec).toBe('standard')
    expect(nodeOf(back.graph, 'old').request).toEqual({ spec: { postProcess: ['auto_rigging'] } })
  })

  it('keeps a value it does not know raw, warns, and compiles it back unchanged', () => {
    const graph = withRequests({
      version: 1,
      nodes: [
        { id: 'm', kind: 'seed_model', position: { x: 0, y: 0 }, settings: {} },
        { id: 'rig', kind: 'rigging', position: { x: 300, y: 0 }, settings: { rigType: 'centaur', spec: 'standard', outFormat: 'glb' } },
      ],
      edges: [{ id: 'a', source: 'm', sourceHandle: 'out', target: 'rig', targetHandle: 'in' }],
    })
    const { doc, warnings } = decompilePipeline(graph)
    expect(warnings).toEqual(['Step "rig": rigType holds a value this version does not know; it is kept as it is.'])
    expect(doc.steps.rig).toEqual({ kind: 'rigging', from: 'm', settings: { rigType: 'centaur' } })
    const back = compiled(doc)
    expect(comparable(back.graph)).toEqual(comparable(graph))
    expect(back.warnings).toEqual(['Step "rig": rigType holds a value this version does not know; it is kept as it is.'])
  })

  it('writes a texture’s legacy Reference wire by input', () => {
    const graph = compiled(
      { steps: { photo: { kind: 'seed_picture' }, gen: { kind: 'generate_3d', from: 'photo' }, tex: { kind: 'texture', from: { in: 'gen', reference: 'photo' } } } },
    ).graph
    const { doc } = decompilePipeline(graph)
    expect(doc.steps.tex!.from).toEqual({ in: 'gen', reference: 'photo' })
  })

  it('leaves out wires that point nowhere, and says so', () => {
    const graph: PipelineGraph = {
      version: 1,
      nodes: [
        { id: 'photo', kind: 'seed_picture', position: { x: 0, y: 0 }, settings: { source: null } },
        { id: 'cut', kind: 'remove_background', position: { x: 300, y: 0 }, settings: {} },
      ],
      edges: [
        { id: 'a', source: 'ghost', sourceHandle: 'out', target: 'cut', targetHandle: 'in' },
        { id: 'b', source: 'photo', sourceHandle: 'out', target: 'cut', targetHandle: 'side' },
      ],
    }
    const { doc, warnings } = decompilePipeline(graph)
    expect(doc.steps.cut).toEqual({ kind: 'remove_background' })
    expect(warnings).toHaveLength(2)
    // Positions come back as they were, laid out without the wires that were left out.
    const back = compiled(doc, { validate: false }).graph
    expect(back.nodes.map((node) => node.position)).toEqual(graph.nodes.map((node) => node.position))
  })

  it('can leave positions out', () => {
    expect(decompilePipeline(editorGraph(), { positions: false }).doc).not.toHaveProperty('layout')
  })
})

describe('runNodeChange — a step’s settings for one run', () => {
  const run = compiled(PIPELINE_DOC_EXAMPLES[2]!.doc).graph

  it('gives a draft run’s texture its description, with the request rebuilt', () => {
    const change = runNodeChange(run, 'paint', { prompt: 'rusty iron' })
    expect(change.ok).toBe(true)
    if (!change.ok) return
    expect(change.body.settings).toMatchObject({ tier: 'retexture_hd', prompt: 'rusty iron' })
    expect(change.body.request).toMatchObject({ spec: { postProcess: ['retexture_hd'] }, prompt: 'rusty iron' })
  })

  it('takes a reference picture in place of the description', () => {
    const change = runNodeChange(run, 'paint', { prompt: 'rusty iron', reference: { gen2dPostId: 12 } })
    expect(change.ok && change.body.request).toMatchObject({ referenceImageId: 12 })
    expect(change.ok && change.body.request).not.toHaveProperty('prompt')
  })

  it('refuses what a step does not take, and the seed', () => {
    expect(runNodeChange(run, 'paint', { colour: 'red' })).toMatchObject({ ok: false, problems: [{ code: 'UNKNOWN_SETTING', nodeId: 'paint' }] })
    expect(runNodeChange(run, 'source', { prompt: 'x' })).toMatchObject({ ok: false, problems: [{ code: 'STEP_INVALID' }] })
    expect(runNodeChange(run, 'ghost', {})).toMatchObject({ ok: false, problems: [{ code: 'UNKNOWN_STEP' }] })
  })

  it('settles a generation’s coupled options from its current settings', () => {
    const graph = compiled(RIGGED).graph
    const change = runNodeChange(graph, 'model', { engine: 'n1', quality: 'ultra' })
    expect(change.ok && change.body.settings).toMatchObject({ model: 'n1', quality: 'ultra', polygonCount: '1000000' })
  })
})

/* ------------------------------------------------------------------------------------ schema */

type Schema = Record<string, unknown>

/** A small JSON Schema checker for the keywords the document schema uses. */
function check(schema: Schema, value: unknown, root: Schema = schema, path = '$'): string[] {
  if (typeof schema.$ref === 'string') {
    const target = (schema.$ref as string).replace('#/$defs/', '')
    return check((root.$defs as Record<string, Schema>)[target]!, value, root, path)
  }
  const errors: string[] = []
  const typeOf = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v)
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string]
    const actual = typeOf(value)
    if (!types.includes(actual) && !(actual === 'integer' && types.includes('number'))) return [`${path}: not ${types.join('|')}`]
  }
  if ('const' in schema && value !== schema.const) errors.push(`${path}: not ${String(schema.const)}`)
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) errors.push(`${path}: not in enum`)
  if (typeof schema.pattern === 'string' && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: pattern`)
  if (typeof schema.maxLength === 'number' && typeof value === 'string' && value.length > schema.maxLength) errors.push(`${path}: too long`)
  if (typeof schema.minimum === 'number' && typeof value === 'number' && value < schema.minimum) errors.push(`${path}: below minimum`)
  if (typeof schema.maximum === 'number' && typeof value === 'number' && value > schema.maximum) errors.push(`${path}: above maximum`)
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((option) => check(option as Schema, value, root, path).length === 0)) errors.push(`${path}: no anyOf`)
  if (Array.isArray(schema.oneOf) && schema.oneOf.filter((option) => check(option as Schema, value, root, path).length === 0).length !== 1) {
    errors.push(`${path}: not exactly one of oneOf`)
  }
  if (Array.isArray(value) && schema.items) value.forEach((item, index) => errors.push(...check(schema.items as Schema, item, root, `${path}[${index}]`)))
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    for (const key of (schema.required as string[] | undefined) ?? []) if (!(key in record)) errors.push(`${path}: missing ${key}`)
    const properties = (schema.properties as Record<string, Schema> | undefined) ?? {}
    for (const [key, item] of Object.entries(record)) {
      if (schema.propertyNames) errors.push(...check(schema.propertyNames as Schema, key, root, `${path}.<${key}>`))
      if (properties[key]) errors.push(...check(properties[key]!, item, root, `${path}.${key}`))
      else if (schema.additionalProperties === false) errors.push(`${path}: unexpected ${key}`)
      else if (typeof schema.additionalProperties === 'object') errors.push(...check(schema.additionalProperties as Schema, item, root, `${path}.${key}`))
    }
  }
  return errors
}

/* -------------------------------------------------------------------- multi-view round trips */

/** A multi-view graph as the web editor saves one: a Multi-view seed into both multi-view steps, and a one-picture branch. */
function multiViewEditorGraph(): PipelineGraph {
  const node = (id: string, kind: PipelineNode['kind'], settings: Record<string, unknown>, position: { x: number; y: number }): PipelineNode => ({
    id,
    kind,
    position,
    settings,
  })
  return withRequests({
    version: 1,
    nodes: [
      node('mv-seed', 'seed_views', defaultSettings('seed_views'), { x: 0, y: 0 }),
      node('smart', 'generate_smart_3d_multiview', settingsWithDefaults('generate_smart_3d_multiview', { model: 'np15', polygonType: 'quadrilateral' }), { x: 310, y: 0 }),
      node('hero', 'generate_3d_multiview', settingsWithDefaults('generate_3d_multiview', { quality: 'ultra', output: 'geometry' }), { x: 310, y: 220 }),
      node('paint', 'texture_multiview', { ...defaultSettings('texture_multiview'), tier: 'retexture_8k', removeBg: false }, { x: 620, y: 0 }),
      // A run's own pictures, with the previews the editor keeps beside them.
      node(
        'paint2',
        'texture_multiview',
        {
          ...defaultSettings('texture_multiview'),
          referenceViews: {
            front: { uploadKey: 'inputImg/7/f.png', name: 'f.png', thumbnail: 'data:image/png;base64,AAAA' },
            left: { gen2dPostId: 12, name: 'Chair side', thumbnail: null },
          },
        },
        { x: 620, y: 220 },
      ),
      node('tex', 'texture', { ...defaultSettings('texture'), prompt: '', reference: null }, { x: 930, y: 0 }),
    ],
    edges: [
      { id: 'a', source: 'mv-seed', sourceHandle: 'out', target: 'smart', targetHandle: 'in' },
      { id: 'b', source: 'mv-seed', sourceHandle: 'out', target: 'hero', targetHandle: 'in' },
      { id: 'c', source: 'smart', sourceHandle: 'out', target: 'paint', targetHandle: 'in' },
      { id: 'd', source: 'mv-seed', sourceHandle: 'out', target: 'paint', targetHandle: 'views' },
      { id: 'e', source: 'hero', sourceHandle: 'out', target: 'paint2', targetHandle: 'in' },
      { id: 'f', source: 'paint', sourceHandle: 'out', target: 'tex', targetHandle: 'in' },
    ],
  })
}

describe('decompilePipeline — multi-view steps', () => {
  it('round-trips a multi-view graph made by the web editor', () => {
    const graph = multiViewEditorGraph()
    const { doc, warnings } = decompilePipeline(graph)
    expect(warnings).toEqual([])
    expect(comparable(compiled(doc, { validate: false }).graph)).toEqual(comparable(graph))
  })

  it('writes the multi-view steps in friendly names, and keeps only the editor’s previews raw', () => {
    const { doc } = decompilePipeline(multiViewEditorGraph())
    expect(doc.steps['mv-seed']).toEqual({ kind: 'seed_views' })
    expect(doc.steps.smart).toEqual({ kind: 'generate_smart_3d_multiview', from: 'mv-seed', engine: 'np15', polygonType: 'quad' })
    expect(doc.steps.paint).toEqual({ kind: 'texture_multiview', from: { in: 'smart', views: 'mv-seed' }, tier: '8k', removeReferenceBackground: false })
    // The editor's previews cannot be said in friendly names, so the set is carried raw — and only raw.
    expect(doc.steps.paint2).toEqual({
      kind: 'texture_multiview',
      from: 'hero',
      settings: { referenceViews: multiViewEditorGraph().nodes[4]!.settings!.referenceViews },
    })
    expect(check(PIPELINE_DOC_JSON_SCHEMA, doc)).toEqual([])
  })

  it('leaves out the empty pictures a new run’s copy gives AI texturing', () => {
    const graph: PipelineGraph = {
      version: 1,
      nodes: [
        { id: 'm', kind: 'seed_model', position: { x: 0, y: 0 }, settings: {} },
        { id: 'tex', kind: 'texture', position: { x: 300, y: 0 }, settings: { ...defaultSettings('texture'), prompt: 'oak', referenceViews: {} } },
      ],
      edges: [{ id: 'e', source: 'm', sourceHandle: 'out', target: 'tex', targetHandle: 'in' }],
    }
    expect(decompilePipeline(graph).doc.steps.tex).toEqual({ kind: 'texture', from: 'm', prompt: 'oak' })
  })

  it('sets a draft run’s pictures of each side from friendly fields', () => {
    const graph = multiViewEditorGraph()
    const change = runNodeChange(graph, 'paint2', { views: { front: { gen2dPostId: 3 }, back: { uploadKey: 'inputImg/7/b.png', name: 'b.png' } } })
    expect(change.ok).toBe(true)
    if (!change.ok) return
    expect(change.body.settings.referenceViews).toEqual({ front: { gen2dPostId: 3 }, back: { uploadKey: 'inputImg/7/b.png', name: 'b.png' } })
    expect(change.body.request.referenceViews).toEqual([
      { viewType: 'front', gen2dPostId: 3 },
      { viewType: 'back', uploadKey: 'inputImg/7/b.png', name: 'b.png' },
    ])
    const refusedChange = runNodeChange(graph, 'paint2', { views: { back: { gen2dPostId: 3 } } })
    expect(refusedChange.ok).toBe(false)
  })
})

describe('PIPELINE_DOC_JSON_SCHEMA', () => {
  it('describes every kind and every setting the catalogue has', () => {
    const defs = PIPELINE_DOC_JSON_SCHEMA.$defs as Record<string, Schema>
    for (const kind of ALL_NODE_KINDS) {
      const properties = defs[kind]!.properties as Record<string, unknown>
      for (const setting of NODE_KINDS[kind].settings) expect(properties, `${kind}.${setting.name}`).toHaveProperty(setting.name)
    }
  })

  it('accepts the examples and what decompiling an editor graph writes', () => {
    for (const example of PIPELINE_DOC_EXAMPLES) expect(check(PIPELINE_DOC_JSON_SCHEMA, example.doc), example.name).toEqual([])
    expect(check(PIPELINE_DOC_JSON_SCHEMA, decompilePipeline({ title: 'Knight', graph: editorGraph() }).doc)).toEqual([])
    expect(check(PIPELINE_DOC_JSON_SCHEMA, RIGGED)).toEqual([])
  })

  it('refuses what the compiler refuses', () => {
    expect(check(PIPELINE_DOC_JSON_SCHEMA, { steps: { photo: { kind: 'seed_picture', engine: 'n25' } } })).not.toEqual([])
    expect(check(PIPELINE_DOC_JSON_SCHEMA, { steps: { photo: { kind: 'seed_picture' }, gen: { kind: 'generate_3d', from: 'photo', engine: 'np15' } } })).not.toEqual([])
    expect(check(PIPELINE_DOC_JSON_SCHEMA, { steps: { photo: { kind: 'seed_picture' }, gen: { kind: 'generate_3d' } } })).not.toEqual([])
  })

  it('is plain JSON', () => {
    expect(JSON.parse(JSON.stringify(PIPELINE_DOC_JSON_SCHEMA))).toEqual(PIPELINE_DOC_JSON_SCHEMA)
  })
})
