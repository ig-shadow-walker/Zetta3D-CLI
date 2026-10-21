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
const env = { ZETTA_TOKEN: tokenFor() }

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
