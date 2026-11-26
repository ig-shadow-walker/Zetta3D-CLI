import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline as P } from '@zetta3d/sdk'
import { describe, expect, it } from 'vitest'
import { fakeFetch } from './fake-fetch'
import { tokenFor, zetta } from './harness'

const API = 'https://api.zetta3d.ai/api'
const RECIPE = `version: 1
title: Picture to rigged character
steps:
  photo: { kind: seed_picture }
  clean: { kind: remove_background, from: photo }
  model: { kind: generate_3d, from: clean, engine: n25, quality: high }
  rig:   { kind: rigging, from: model, rigType: biped, rigSpec: standard, format: fbx }
`

function png(path: string) {
  const bytes = new Uint8Array(64)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(bytes.buffer).setUint32(16, 512)
  new DataView(bytes.buffer).setUint32(20, 512)
  writeFileSync(path, bytes)
}

function compiledGraph() {
  const result = P.compilePipeline(require('yaml').parse(RECIPE))
  if (!result.ok) throw new Error('recipe did not compile')
  return result.graph
}

const record = (graph = compiledGraph()) => ({ id: 12, title: 'Picture to rigged character', graph, problems: [], createdAt: 'x', updatedAt: 'x' })
const env = { ZETTA_TEST_SIGN_IN: tokenFor() }

describe('zetta pipeline', () => {
  it('creates a pipeline from a YAML recipe', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zp-'))
    writeFileSync(join(dir, 'recipe.yaml'), RECIPE)
    const { fetch, calls } = fakeFetch([[`POST ${API}/pipelines`, { json: record() }]])
    const run = await zetta(['pipeline', 'create', '--file', join(dir, 'recipe.yaml')], { fetch, env })
    expect(run.code).toBe(0)
    const body = calls[0]!.body as { title: string; graph: { nodes: Array<{ kind: string; request?: Record<string, unknown> }> } }
    expect(body.title).toBe('Picture to rigged character')
    expect(body.graph.nodes.map((n) => n.kind)).toEqual(['seed_picture', 'remove_background', 'generate_3d', 'rigging'])
    expect(body.graph.nodes.find((n) => n.kind === 'rigging')!.request).toMatchObject({ rigOutFormat: 'fbx' })
    expect(run.json().doc.steps.rig).toMatchObject({ kind: 'rigging', format: 'fbx' })
  })

  it('rejects a recipe with an unknown step kind before calling the API', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zp-'))
    writeFileSync(join(dir, 'bad.yaml'), 'steps:\n  a: { kind: seed_picture }\n  b: { kind: teleport, from: a }\n')
    const run = await zetta(['pipeline', 'create', '--file', join(dir, 'bad.yaml')], { env })
    expect(run.code).toBe(2)
    expect(run.errorJson().error.code).toBe('PIPELINE_NOT_RUNNABLE')
  })

  it('batches a folder of pictures under one spend check', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zp-'))
    mkdirSync(join(dir, 'photos'))
    for (const name of ['a.png', 'b.png', 'c.png']) png(join(dir, 'photos', name))
    const { fetch, calls } = fakeFetch([
      [`GET ${API}/pipelines/12`, { json: record() }],
      [`POST ${API}/pipelines/estimate`, { json: { credits: 120, lines: [{ nodeId: 'model', credits: 70, count: 1 }, { nodeId: 'rig', credits: 50, count: 1 }], perPart: null, problems: [] } }],
      [/^POST https:\/\/api\.zetta3d\.ai\/api\/3d\/uploads$/, { json: { uploadUrl: `${API}/3d/uploads/relay?ticket=t`, method: 'PUT', headers: { 'Content-Type': 'image/png' }, key: 'inputImg/1/x.png', fileUrl: 'https://files.example/x.png' } }],
      [`PUT ${API}/3d/uploads/relay`, { json: {} }],
      [`POST ${API}/pipelines/12/batch`, { json: { runs: [{ id: 1, mode: 'auto', status: 'running' }, { id: 2, mode: 'auto', status: 'running' }, { id: 3, mode: 'auto', status: 'running' }] } }],
    ])
    const over = await zetta(['pipeline', 'batch', '12', join(dir, 'photos'), '--max-credits', '300'], { fetch, env })
    expect(over.code).toBe(5)
    expect(over.errorJson().error.details.credits).toBe(360)

    const ok = await zetta(['pipeline', 'batch', '12', join(dir, 'photos'), '--max-credits', '400'], { fetch, env })
    expect(ok.code).toBe(0)
    expect(ok.json().runs.map((r: { id: number }) => r.id)).toEqual([1, 2, 3])
    const batch = calls.find((c) => c.url.endsWith('/pipelines/12/batch'))!.body as { seeds: Array<{ uploadKey: string; name: string }>; mode: string }
    expect(batch.seeds).toHaveLength(3)
    expect(batch.seeds[0]).toMatchObject({ uploadKey: 'inputImg/1/x.png', name: 'a.png' })
    // The saved recipe is what the runs copy: no graph is sent (an API key may not send one).
    expect(batch).not.toHaveProperty('graph')
  })

  it('validates and estimates for free', async () => {
    const { fetch } = fakeFetch([
      [`GET ${API}/pipelines/12`, { json: record() }],
      [`POST ${API}/pipelines/estimate`, { json: { credits: 120, lines: [], perPart: null, problems: [] } }],
    ])
    const run = await zetta(['pipeline', 'validate', '12'], { fetch, env })
    expect(run.code).toBe(0)
    expect(run.json()).toMatchObject({ valid: true, creditsPerRun: 120 })
    const est = await zetta(['pipeline', 'estimate', '12', '--seeds', '5'], { fetch, env })
    expect(est.json()).toMatchObject({ creditsPerRun: 120, totalCredits: 600 })
  })
})

describe('zetta run', () => {
  const graph = compiledGraph()
  const runBody = (status: string, steps: Array<Record<string, unknown>>) => ({ id: 1, pipelineId: 12, mode: 'auto', status, paused: false, seed: null, estimatedCredits: 120, spentCredits: 0, graph, steps, createdAt: 'x' })

  it('reports a run waiting on a person, with the next command', async () => {
    const { fetch } = fakeFetch([[`GET ${API}/pipeline-runs/1`, { json: runBody('awaiting', [{ id: 5, nodeId: 'model', partKey: null, status: 'review', attempt: 1, credits: 70, errorMessage: null, gen3dPostId: null, output: null, review: {} }]) }]])
    const run = await zetta(['run', 'wait', '1'], { fetch, env })
    expect(run.code).toBe(0)
    expect(run.json().blocked[0]).toMatchObject({ stepId: 5, next: 'zetta run confirm-parts 1 5 --keys <part,…>' })
  })

  it('exits 9 for a failed run', async () => {
    const { fetch } = fakeFetch([[`GET ${API}/pipeline-runs/1`, { json: runBody('failed', [{ id: 5, nodeId: 'model', partKey: null, status: 'failed', attempt: 1, credits: 70, errorMessage: 'Could not read the picture.', gen3dPostId: null, output: null, review: null }]) }]])
    const run = await zetta(['run', 'wait', '1'], { fetch, env })
    expect(run.code).toBe(9)
    expect(run.errorJson().error.code).toBe('RUN_FAILED')
  })

  it('sets a per-run prompt with friendly fields', async () => {
    const texGraph = P.compilePipeline({ steps: { photo: { kind: 'seed_picture' }, model: { kind: 'generate_3d', from: 'photo' }, paint: { kind: 'texture', from: 'model' } } }, { validate: false })
    if (!texGraph.ok) throw new Error('no graph')
    const { fetch, calls } = fakeFetch([
      [`GET ${API}/pipeline-runs/1`, { json: { ...runBody('draft', []), graph: texGraph.graph } }],
      [`PATCH ${API}/pipeline-runs/1/nodes/paint`, { json: { ...runBody('draft', []), graph: texGraph.graph } }],
    ])
    const run = await zetta(['run', 'set-input', '1', 'paint', '--prompt', 'matte black ceramic'], { fetch, env })
    expect(run.code).toBe(0)
    const patch = calls.find((c) => c.method === 'PATCH')!.body as { request: Record<string, unknown>; settings: Record<string, unknown> }
    expect(JSON.stringify(patch)).toContain('matte black ceramic')
  })
})

/* ---------------------------------------------------------------- multi-view seeds and drafts */

const VIEWS_RECIPE = {
  version: 1,
  title: 'Product from photos of each side',
  steps: {
    photos: { kind: 'seed_views' },
    model: { kind: 'generate_smart_3d_multiview', from: 'photos', engine: 'np15', polygonCount: 12000 },
    paint: { kind: 'texture_multiview', from: { in: 'model', views: 'photos' }, tier: 'detailed' },
  },
}

function viewsGraph() {
  const result = P.compilePipeline(VIEWS_RECIPE)
  if (!result.ok) throw new Error('views recipe did not compile')
  return result.graph
}

const viewsRecord = () => ({ id: 14, title: VIEWS_RECIPE.title, graph: viewsGraph(), problems: [], createdAt: 'x', updatedAt: 'x' })

function viewsRoutes(batchReply: unknown = { json: { runs: [{ id: 7, mode: 'auto', status: 'running' }, { id: 8, mode: 'auto', status: 'running' }] } }) {
  return fakeFetch([
    [`GET ${API}/pipelines/14`, { json: viewsRecord() }],
    [`POST ${API}/pipelines/estimate`, { json: { credits: 90, lines: [{ nodeId: 'model', credits: 60, count: 1 }, { nodeId: 'paint', credits: 30, count: 1 }], perPart: false, problems: [] } }],
    [/^POST https:\/\/api\.zetta3d\.ai\/api\/3d\/uploads$/, { json: { uploadUrl: `${API}/3d/uploads/relay?ticket=t`, method: 'PUT', headers: { 'Content-Type': 'image/png' }, key: 'inputImg/1/x.png', fileUrl: 'https://files.example/x.png' } }],
    [`PUT ${API}/3d/uploads/relay`, { json: {} }],
    [`POST ${API}/pipelines/14/batch`, batchReply as never],
  ])
}

describe('zetta pipeline — pictures of each side', () => {
  it('runs a folder of folders, one run per set, named after its folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zv-'))
    mkdirSync(join(dir, 'products', 'chair'), { recursive: true })
    mkdirSync(join(dir, 'products', 'lamp'), { recursive: true })
    for (const name of ['front.png', 'Back.PNG', 'notes.png']) png(join(dir, 'products', 'chair', name))
    png(join(dir, 'products', 'lamp', 'front.png'))
    const { fetch, calls } = viewsRoutes()
    const run = await zetta(['pipeline', 'batch', '14', join(dir, 'products'), '--max-credits', '500'], { fetch, env })
    expect(run.code).toBe(0)
    const batch = calls.find((c) => c.url.endsWith('/pipelines/14/batch'))!.body as { seeds: unknown[] }
    expect(batch.seeds).toEqual([
      {
        views: [
          { viewType: 'front', uploadKey: 'inputImg/1/x.png', name: 'front.png' },
          { viewType: 'back', uploadKey: 'inputImg/1/x.png', name: 'Back.PNG' },
        ],
        name: 'chair',
      },
      { views: [{ viewType: 'front', uploadKey: 'inputImg/1/x.png', name: 'front.png' }], name: 'lamp' },
    ])
    expect(batch).not.toHaveProperty('graph')
    // Two runs priced together, before anything is uploaded.
    expect(calls.findIndex((c) => c.url.endsWith('/pipelines/estimate'))).toBeLessThan(calls.findIndex((c) => c.url.includes('/3d/uploads')))
  })

  it('takes --views sets — each front starts the next — with library pictures too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zv-'))
    for (const name of ['a.png', 'b.png', 'c.png']) png(join(dir, name))
    const { fetch, calls } = viewsRoutes()
    const run = await zetta(
      ['pipeline', 'batch', '14', '--views', `front=${join(dir, 'a.png')},left=image:44`, '--views', `front=${join(dir, 'b.png')},back=${join(dir, 'a.png')}`, '--yes'],
      { fetch, env },
    )
    expect(run.code).toBe(0)
    const batch = calls.find((c) => c.url.endsWith('/pipelines/14/batch'))!.body as { seeds: Array<{ views: unknown[]; name: string }> }
    expect(batch.seeds.map((seed) => seed.views)).toEqual([
      [
        { viewType: 'front', uploadKey: 'inputImg/1/x.png', name: 'a.png' },
        { viewType: 'left', gen2dPostId: 44 },
      ],
      [
        { viewType: 'front', uploadKey: 'inputImg/1/x.png', name: 'b.png' },
        { viewType: 'back', uploadKey: 'inputImg/1/x.png', name: 'a.png' },
      ],
    ])
    expect(batch.seeds.map((seed) => seed.name)).toEqual(['a.png', 'b.png'])
    // a.png is used twice and uploaded once.
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2)
  })

  it('runs one set with `pipeline run`, and refuses a set without its front', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zv-'))
    mkdirSync(join(dir, 'chair'))
    png(join(dir, 'chair', 'front.png'))
    const { fetch, calls } = viewsRoutes({ json: { runs: [{ id: 7, mode: 'auto', status: 'running' }] } })
    const ok = await zetta(['pipeline', 'run', '14', join(dir, 'chair'), '--yes', '--no-download'], { fetch, env })
    expect(ok.code).toBe(0)
    expect((calls.find((c) => c.url.endsWith('/batch'))!.body as { seeds: Array<{ name: string }> }).seeds[0]!.name).toBe('chair')

    const positional = await zetta(['pipeline', 'run', '14', `front=${join(dir, 'chair', 'front.png')},left=image:3`, '--yes', '--no-download'], { fetch, env })
    expect(positional.code).toBe(0)
    expect((calls.filter((c) => c.url.endsWith('/batch')).at(-1)!.body as { seeds: Array<{ views: unknown[] }> }).seeds[0]!.views).toEqual([
      { viewType: 'front', uploadKey: 'inputImg/1/x.png', name: 'front.png' },
      { viewType: 'left', gen2dPostId: 3 },
    ])
    const noFront = await zetta(['pipeline', 'run', '14', '--views', 'back=b.png', '--yes'], { fetch, env })
    expect(noFront.code).toBe(2)
    expect(noFront.errorJson().error.message).toMatch(/Start each set with its front picture/)
    const onePicture = await zetta(['pipeline', 'run', '14', join(dir, 'chair', 'front.png'), '--yes'], { fetch, env })
    expect(onePicture.code).toBe(2)
    expect(onePicture.errorJson().error.message).toMatch(/starts from pictures of each side/)
  })

  it('refuses --views for a pipeline that starts from one picture', async () => {
    const { fetch } = fakeFetch([[`GET ${API}/pipelines/12`, { json: record() }]])
    const run = await zetta(['pipeline', 'batch', '12', '--views', 'front=a.png', '--yes'], { fetch, env })
    expect(run.code).toBe(2)
    expect(run.errorJson().error.message).toMatch(/starts from a picture/)
  })

  it('sends a graph only when the run copy differs, and runs the saved recipe when the sign-in may not change it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zv-'))
    png(join(dir, 'f.png'))
    const stale = viewsRecord()
    // A request stored by an older version: the CLI's copy differs at "model".
    stale.graph = { ...stale.graph, nodes: stale.graph.nodes.map((node) => (node.id === 'model' ? { ...node, request: { model: 'np15' } } : node)) }
    const refusal = { status: 403, json: { code: 'PIPELINE_EDIT_NOT_ALLOWED', message: 'Pipelines cannot be changed through the API, so a run cannot carry a graph.' } }
    const { fetch, calls } = fakeFetch([
      [`GET ${API}/pipelines/14`, { json: stale }],
      [`POST ${API}/pipelines/estimate`, { json: { credits: 90, lines: [], perPart: false, problems: [] } }],
      [/^POST https:\/\/api\.zetta3d\.ai\/api\/3d\/uploads$/, { json: { uploadUrl: `${API}/3d/uploads/relay?ticket=t`, method: 'PUT', headers: {}, key: 'inputImg/1/x.png', fileUrl: 'x' } }],
      [`PUT ${API}/3d/uploads/relay`, { json: {} }],
      [`POST ${API}/pipelines/14/batch`, [refusal, { json: { runs: [{ id: 7, mode: 'auto', status: 'running' }] } }]],
    ])
    const run = await zetta(['pipeline', 'batch', '14', '--views', `front=${join(dir, 'f.png')}`, '--yes'], { fetch, env })
    expect(run.code).toBe(0)
    const batches = calls.filter((c) => c.url.endsWith('/pipelines/14/batch')).map((c) => c.body as Record<string, unknown>)
    expect(batches).toHaveLength(2)
    expect(batches[0]).toHaveProperty('graph')
    expect(batches[1]).not.toHaveProperty('graph')
    expect(run.stderr).toMatch(/exactly as saved/)
  })

  it('says what each run gives when it validates', async () => {
    const { fetch } = fakeFetch([
      [`GET ${API}/pipelines/14`, { json: viewsRecord() }],
      [`POST ${API}/pipelines/estimate`, { json: { credits: 90, lines: [], perPart: false, problems: [] } }],
    ])
    const run = await zetta(['pipeline', 'validate', '14'], { fetch, env })
    expect(run.json()).toMatchObject({ valid: true, startsFrom: 'views', eachRunGives: ['pictures of each side, a front one at least (the seed)'] })
  })
})

describe('zetta pipeline draft', () => {
  const drafted = {
    title: 'Game-ready character',
    summary: 'Cut out, Smart 3D at 8,000 polygons, rigged for Unity.',
    graph: {
      version: 1,
      nodes: [
        { id: 'seed', kind: 'seed_picture', position: { x: 0, y: 0 } },
        { id: 'step-1', kind: 'remove_background', position: { x: 300, y: 0 }, settings: {} },
        { id: 'step-2', kind: 'generate_smart_3d', position: { x: 600, y: 0 }, settings: { model: 'np1', polygonCount: '8000' } },
        { id: 'step-3', kind: 'rigging', position: { x: 900, y: 0 }, settings: { rigType: 'biped', spec: 'unity' } },
      ],
      edges: [
        { id: 'e-seed-step-1', source: 'seed', sourceHandle: 'out', target: 'step-1', targetHandle: 'in' },
        { id: 'e-step-1-step-2', source: 'step-1', sourceHandle: 'out', target: 'step-2', targetHandle: 'in' },
        { id: 'e-step-2-step-3', source: 'step-2', sourceHandle: 'out', target: 'step-3', targetHandle: 'in' },
      ],
    },
  }

  it('prints the drafted recipe, and saves nothing', async () => {
    const { fetch, calls } = fakeFetch([[`POST ${API}/pipelines/draft`, { json: drafted }]])
    const run = await zetta(['pipeline', 'draft', 'a game-ready character from a photo, rigged for Unity'], { fetch, env })
    expect(run.code).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.body).toEqual({ description: 'a game-ready character from a photo, rigged for Unity' })
    const out = run.json()
    expect(out).toMatchObject({ title: 'Game-ready character', summary: drafted.summary, problems: [] })
    expect(out.recipe.steps).toEqual({
      seed: { kind: 'seed_picture' },
      'step-1': { kind: 'remove_background', from: 'seed' },
      'step-2': { kind: 'generate_smart_3d', from: 'step-1', polygonCount: 8000 },
      'step-3': { kind: 'rigging', from: 'step-2', rigSpec: 'unity' },
    })
    expect(out).not.toHaveProperty('pipeline')
  })

  it('prints YAML a recipe file can hold', async () => {
    const { fetch } = fakeFetch([[`POST ${API}/pipelines/draft`, { json: drafted }]])
    const run = await zetta(['pipeline', 'draft', 'a rigged character', '--output', 'text'], { fetch, env })
    const doc = require('yaml').parse(run.stdout)
    expect(P.compilePipeline(doc).ok).toBe(true)
    expect(run.stdout).toMatch(/^# Game-ready character/)
  })

  it('changes a saved pipeline as asked, keeping its title, and saves it with every request built', async () => {
    const { fetch, calls } = fakeFetch([
      [`GET ${API}/pipelines/12`, { json: record() }],
      [`POST ${API}/pipelines/draft`, { json: drafted }],
      [`PATCH ${API}/pipelines/12`, { json: { ...record(), graph: drafted.graph } }],
    ])
    const run = await zetta(['pipeline', 'draft', 'rig it for Unity instead', '--update', '12'], { fetch, env })
    expect(run.code).toBe(0)
    const sent = calls.find((c) => c.url.endsWith('/pipelines/draft'))!.body as { graph: { nodes: unknown[] } }
    expect(sent.graph.nodes).toHaveLength(4)
    const saved = calls.find((c) => c.method === 'PATCH')!.body as { title?: string; graph: { nodes: Array<{ id: string; request?: Record<string, unknown> }> } }
    expect(saved).not.toHaveProperty('title')
    expect(saved.graph.nodes.find((node) => node.id === 'step-3')!.request).toEqual({ spec: { postProcess: ['auto_rigging'] }, rigSpec: 'unity' })
    expect(saved.graph.nodes.find((node) => node.id === 'step-2')!.request).toMatchObject({ model: 'np1', faceCount: 8000 })
    expect(run.json()).toMatchObject({ editedFrom: 'pipeline #12', pipeline: { id: 12, action: 'updated' } })
  })

  it('saves a new pipeline under the drafted title, and refuses what makes no sense', async () => {
    const { fetch, calls } = fakeFetch([
      [`POST ${API}/pipelines/draft`, { json: drafted }],
      [`POST ${API}/pipelines`, { json: { ...record(), id: 31, title: drafted.title } }],
    ])
    const run = await zetta(['pipeline', 'draft', 'a rigged character', '--create'], { fetch, env })
    expect(run.code).toBe(0)
    expect(calls.find((c) => c.url.endsWith('/api/pipelines'))!.body).toMatchObject({ title: 'Game-ready character' })
    expect(run.json().pipeline).toEqual({ id: 31, title: 'Game-ready character', action: 'created' })
    expect((await zetta(['pipeline', 'draft', 'x'], { env })).code).toBe(2)
    expect((await zetta(['pipeline', 'draft', 'a recipe', '--create', '--update', '3'], { env })).code).toBe(2)
  })
})

describe('zetta run — routes and multi-view inputs', () => {
  const graph = viewsGraph()
  const unwired = (() => {
    const result = P.compilePipeline({ steps: { photos: { kind: 'seed_views' }, model: { kind: 'generate_3d_multiview', from: 'photos' }, paint: { kind: 'texture_multiview', from: 'model' } } })
    if (!result.ok) throw new Error('no graph')
    return result.graph
  })()
  const runBody = (status: string, steps: Array<Record<string, unknown>>, g = graph) => ({ id: 3, pipelineId: 14, mode: 'manual', status, paused: false, seed: { type: 'views', name: 'chair', views: [{ viewType: 'front', uploadKey: 'k' }] }, estimatedCredits: 90, spentCredits: 0, graph: g, steps, createdAt: 'x' })
  const step = (id: number, nodeId: string, status: string) => ({ id, nodeId, partKey: '', status, attempt: 1, credits: 30, errorMessage: null, gen3dPostId: null, output: null, review: null })

  it('names a manual step waiting for its Run, and a draft’s per-run pictures', async () => {
    const { fetch } = fakeFetch([[`GET ${API}/pipeline-runs/3`, { json: runBody('awaiting', [step(5, 'model', 'waiting')]) }]])
    const waiting = await zetta(['run', 'get', '3'], { fetch, env })
    expect(waiting.json().blocked).toEqual([{ stepId: 5, step: 'model', reason: 'Manual mode: waiting for you to run it.', next: 'zetta run step-run 3 5' }])
    expect(waiting.json().seed).toEqual({ type: 'views', name: 'chair', views: ['front'] })

    const draft = fakeFetch([[`GET ${API}/pipeline-runs/3`, { json: runBody('draft', [], P.forNewRun(unwired)) }]])
    const blocked = (await zetta(['run', 'get', '3'], { fetch: draft.fetch, env })).json()
    expect(blocked.blocked[0]).toMatchObject({ stepId: null, step: 'paint', next: 'zetta run set-input 3 paint --views front=a.png,back=b.png' })
    expect(blocked.next).toBe('zetta run set-input 3 paint --views front=a.png,back=b.png, then zetta run start 3')
  })

  it('sets a draft’s pictures of each side', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zr-'))
    png(join(dir, 'f.png'))
    const { fetch, calls } = fakeFetch([
      [`GET ${API}/pipeline-runs/3`, { json: runBody('draft', [], P.forNewRun(unwired)) }],
      [/^POST https:\/\/api\.zetta3d\.ai\/api\/3d\/uploads$/, { json: { uploadUrl: `${API}/3d/uploads/relay?ticket=t`, method: 'PUT', headers: {}, key: 'inputImg/1/f.png', fileUrl: 'x' } }],
      [`PUT ${API}/3d/uploads/relay`, { json: {} }],
      [`PATCH ${API}/pipeline-runs/3/nodes/paint`, { json: runBody('draft', [], P.forNewRun(unwired)) }],
    ])
    const run = await zetta(['run', 'set-input', '3', 'paint', '--views', `front=${join(dir, 'f.png')},right=image:9`], { fetch, env })
    expect(run.code).toBe(0)
    const patch = calls.find((c) => c.method === 'PATCH')!.body as { settings: Record<string, unknown>; request: Record<string, unknown> }
    expect(patch.settings.referenceViews).toEqual({ front: { uploadKey: 'inputImg/1/f.png', name: 'f.png' }, right: { gen2dPostId: 9 } })
    expect(patch.request.referenceViews).toEqual([
      { viewType: 'front', uploadKey: 'inputImg/1/f.png', name: 'f.png' },
      { viewType: 'right', gen2dPostId: 9 },
    ])
  })

  it('retries a failed step with numeric settings, and only a failed one', async () => {
    const failed = runBody('failed', [step(5, 'model', 'failed')])
    const { fetch, calls } = fakeFetch([
      [`GET ${API}/pipeline-runs/3`, { json: failed }],
      [`POST ${API}/pipeline-runs/3/steps/5/retry`, { json: runBody('running', [step(5, 'model', 'ready')]) }],
    ])
    const run = await zetta(['run', 'step-retry', '3', '5', '--set', 'polygonCount=9000', '--yes'], { fetch, env })
    expect(run.code).toBe(0)
    const body = calls.find((c) => c.url.endsWith('/retry'))!.body as { settings: Record<string, unknown>; request: Record<string, unknown> }
    expect(body.settings.polygonCount).toBe('9000')
    expect(body.request).toMatchObject({ faceCount: 9000 })

    const running = fakeFetch([[`GET ${API}/pipeline-runs/3`, { json: runBody('running', [step(5, 'model', 'running')]) }]])
    expect((await zetta(['run', 'step-retry', '3', '5', '--yes'], { fetch: running.fetch, env })).code).toBe(2)
  })

  it('confirms parts with keys or typed parts, and deletes only a run that is over', async () => {
    const { fetch, calls } = fakeFetch([
      [`POST ${API}/pipeline-runs/3/steps/5/parts`, { json: runBody('running', []) }],
      [`GET ${API}/pipeline-runs/3`, { json: runBody('running', []) }],
    ])
    expect((await zetta(['run', 'confirm-parts', '3', '5'], { fetch, env })).code).toBe(2)
    expect((await zetta(['run', 'confirm-parts', '3', '5', '--extra', 'shield'], { fetch, env })).code).toBe(0)
    expect(calls.at(-1)!.body).toEqual({ keys: [], extraParts: ['shield'] })
    const del = await zetta(['run', 'delete', '3', '--yes'], { fetch, env })
    expect(del.code).toBe(2)
    expect(del.errorJson().error.message).toMatch(/cancel it first/)
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
  })
})
