/**
 * Live smoke test against the real Zetta 3D API.
 *
 *   bun run smoke:live                         # free checks only (signed out: public routes only)
 *   ZETTA_TOKEN=… bun run smoke:live           # every free check, signed in
 *   ZETTA_TOKEN=… bun run smoke:live --paid --budget 200   # plus a few of the cheapest paid jobs
 *
 * Options: --bin <path> (test a built binary instead of the sources), --profile <name>, --keep
 * (keep the assets it creates), --report <file.json>.
 *
 * Everything it creates is deleted at the end unless --keep. Paid steps never exceed --budget:
 * each one passes the remaining budget as --max-credits, so the CLI's own guard enforces it.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { stringify as toYaml } from 'yaml'
import { pipeline as P } from '../packages/sdk/src'

const { values } = parseArgs({
  options: {
    bin: { type: 'string' },
    profile: { type: 'string' },
    paid: { type: 'boolean', default: false },
    budget: { type: 'string', default: '0' },
    keep: { type: 'boolean', default: false },
    report: { type: 'string' },
  },
})

const ROOT = join(import.meta.dir, '..')
const budget = Number(values.budget)
if (values.paid && !(budget > 0)) {
  console.error('--paid needs --budget <credits> (the most the paid steps may spend in total).')
  process.exit(2)
}
const work = mkdtempSync(join(tmpdir(), 'zetta-live-'))
const base = values.bin ? [values.bin] : [process.execPath, 'run', join(ROOT, 'packages/cli/src/main.ts')]
const globalArgs = ['--json', '--non-interactive', ...(values.profile ? ['--profile', values.profile] : [])]

interface Result {
  step: string
  status: 'pass' | 'fail' | 'skip'
  ms: number
  detail?: string
}
const results: Result[] = []
const createdAssets: number[] = []
let spentByPaidSteps = 0

function zetta(args: string[], timeoutMs = 120_000): { code: number; json: any; stderr: string } {
  const r = spawnSync(base[0]!, [...base.slice(1), ...globalArgs, ...args], {
    cwd: work,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, ZETTA_NO_UPDATE_CHECK: '1' },
  })
  let json: any
  try {
    json = r.stdout?.trim() ? JSON.parse(r.stdout) : undefined
  } catch {
    json = undefined
  }
  if (json === undefined && r.stderr) {
    try {
      json = JSON.parse(r.stderr.trim().split('\n').at(-1) ?? '')
    } catch {
      // not JSON
    }
  }
  return { code: r.status ?? 1, json, stderr: r.stderr ?? '' }
}

function step(name: string, fn: () => string | void, opts: { skip?: string } = {}): void {
  if (opts.skip) {
    results.push({ step: name, status: 'skip', ms: 0, detail: opts.skip })
    console.log(`SKIP  ${name} — ${opts.skip}`)
    return
  }
  const started = performance.now()
  try {
    const detail = fn() ?? undefined
    const ms = Math.round(performance.now() - started)
    results.push({ step: name, status: 'pass', ms, ...(detail ? { detail } : {}) })
    console.log(`PASS  ${name} (${ms} ms)${detail ? ` — ${detail}` : ''}`)
  } catch (error) {
    const ms = Math.round(performance.now() - started)
    const detail = error instanceof Error ? error.message : String(error)
    results.push({ step: name, status: 'fail', ms, detail })
    console.log(`FAIL  ${name} (${ms} ms) — ${detail}`)
  }
}

function expectOk(r: ReturnType<typeof zetta>, what: string): any {
  if (r.code !== 0) throw new Error(`${what} exited ${r.code}: ${JSON.stringify(r.json?.error ?? r.stderr.slice(-300))}`)
  return r.json
}

/** A GLB of `triangles` random triangles; big ones exercise the multipart upload. */
function glb(triangles: number): Uint8Array {
  const positions = new Float32Array(triangles * 9).map(() => Math.random())
  const bin = new Uint8Array(positions.buffer)
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: triangles * 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 1] }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.byteLength }],
    buffers: [{ byteLength: bin.byteLength }],
  }
  let text = JSON.stringify(json)
  while (text.length % 4) text += ' '
  const jsonBytes = new TextEncoder().encode(text)
  const total = 12 + 8 + jsonBytes.length + 8 + bin.length
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint32(0, 0x46546c67, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, total, true)
  view.setUint32(12, jsonBytes.length, true)
  view.setUint32(16, 0x4e4f534a, true)
  out.set(jsonBytes, 20)
  view.setUint32(20 + jsonBytes.length, bin.length, true)
  view.setUint32(24 + jsonBytes.length, 0x004e4942, true)
  out.set(bin, 28 + jsonBytes.length)
  return out
}

// ── Public (no sign-in) ─────────────────────────────────────────────────────

step('doctor reaches the API', () => {
  const r = zetta(['doctor'])
  const connection = r.json?.checks?.find((c: { check: string }) => c.check === 'connection')
  if (!connection?.ok) throw new Error(connection?.detail ?? 'no connection check')
  return connection.detail
})
step('billing plans (public)', () => {
  const plans = expectOk(zetta(['billing', 'plans']), 'billing plans').plans
  return plans.map((p: { plan: string }) => p.plan).join(', ')
})
step('featured assets (public)', () => `${expectOk(zetta(['asset', 'featured', '--limit', '3']), 'featured').items.length} items`)

// ── Signed in ───────────────────────────────────────────────────────────────

const status = zetta(['auth', 'status']).json
const signedIn = Boolean(status?.signedIn)
const needs = signedIn ? {} : { skip: 'not signed in (set ZETTA_TOKEN or run `zetta auth login`)' }
let creditsBefore = 0
let entitlements: any

step('auth status', () => `${status.email} (${status.plan}), token from ${status.tokenSource}`, needs)
step('account credits', () => {
  creditsBefore = expectOk(zetta(['account', 'credits']), 'credits').threeD.total
  return `${creditsBefore} 3D credits`
}, needs)
step('catalog entitlements', () => {
  entitlements = expectOk(zetta(['catalog', 'entitlements']), 'entitlements')
  return `plan ${entitlements.plan}`
}, needs)
step('catalog pricing', () => `${expectOk(zetta(['catalog', 'pricing']), 'pricing').items.length} price rows`, needs)
step('image engines', () => expectOk(zetta(['catalog', 'engines', '--images']), 'image engines').imageEngines.map((e: { name: string }) => e.name).join(', '), needs)
step('account usage', () => `${expectOk(zetta(['account', 'usage', '--limit', '5']), 'usage').entries.length} entries`, needs)
step('billing subscription', () => expectOk(zetta(['billing', 'subscription']), 'subscription').plan, needs)
step('asset list', () => `${expectOk(zetta(['asset', 'list', '--limit', '5']), 'asset list').total} assets`, needs)
step('image list', () => `${expectOk(zetta(['image', 'list', '--limit', '5']), 'image list').total} pictures`, needs)
step('pipeline list', () => `${expectOk(zetta(['pipeline', 'list']), 'pipeline list').items.length} pipelines`, needs)
step('quote', () => `${expectOk(zetta(['quote', '--base', 'textured', '--engine', 'n1']), 'quote').credits} credits`, needs)

for (const engine of ['n1', 'n2.5', 'np1', 'np1.5']) {
  const allowed =
    engine === 'n1' || (engine === 'n2.5' ? entitlements?.threeD?.engines?.n25 : entitlements?.threeD?.engines?.np1)
  step(`generate --dry-run (${engine})`, () => {
    const r = expectOk(zetta(['generate', '-p', 'a small ceramic mug', '--engine', engine, '--dry-run']), 'generate dry run')
    return `${r.credits} credits`
  }, signedIn ? (allowed ? {} : { skip: 'not on this plan' }) : needs)
}

const newest = signedIn ? zetta(['asset', 'list', '--status', 'success', '--limit', '1']).json?.items?.[0] : undefined
for (const [tool, args] of [
  ['retopo', ['--faces', '2000']],
  ['uv', []],
  ['rig', ['--rig-type', 'biped']],
  ['convert', ['--to', 'fbx']],
] as const) {
  step(`refine ${tool} --dry-run`, () => `${expectOk(zetta(['refine', tool, String(newest.id), ...args, '--dry-run']), `refine ${tool}`).credits} credits`, signedIn ? (newest ? {} : { skip: 'no finished asset to price against' }) : needs)
}

step('pipeline validate (example recipe)', () => {
  const recipe = join(work, 'recipe.yaml')
  writeFileSync(recipe, toYaml(P.PIPELINE_DOC_EXAMPLES[0]!.doc))
  const r = expectOk(zetta(['pipeline', 'validate', recipe]), 'pipeline validate')
  return `${r.valid ? 'valid' : 'invalid'}, ${r.creditsPerRun} credits per run`
}, needs)

let importedId: number | undefined
step('upload: import a small GLB (single PUT)', () => {
  const file = join(work, 'small.glb')
  writeFileSync(file, glb(200))
  const r = expectOk(zetta(['asset', 'import', file, '--title', 'zetta-live-smoke small']), 'import')
  importedId = r.id
  createdAssets.push(r.id)
  return `#${r.id}`
}, needs)
step('asset rename, tag and get', () => {
  expectOk(zetta(['asset', 'rename', String(importedId), 'zetta-live-smoke renamed']), 'rename')
  expectOk(zetta(['asset', 'tag', String(importedId), '--add', 'smoke-test']), 'tag')
  const got = expectOk(zetta(['asset', 'get', String(importedId)]), 'get')
  if (!got.tags.includes('smoke-test')) throw new Error('tag did not stick')
  return got.title
}, signedIn && importedId ? {} : needs.skip ? needs : { skip: 'import failed' })
step('upload: import a 12 MB GLB (multipart)', () => {
  const file = join(work, 'large.glb')
  writeFileSync(file, glb(350_000))
  const r = expectOk(zetta(['asset', 'import', file, '--title', 'zetta-live-smoke large'], 300_000), 'multipart import')
  createdAssets.push(r.id)
  return `#${r.id}`
}, needs)

// ── Paid (opt-in) ───────────────────────────────────────────────────────────

const paidSkip = !signedIn ? needs : values.paid ? {} : { skip: 'pass --paid --budget <credits> to run' }
let generatedId: number | undefined
step('paid: cheapest generation, waited and downloaded', () => {
  const out = join(work, 'out')
  const r = expectOk(
    zetta(['generate', '-p', 'a simple ceramic coffee mug', '--engine', 'n1', '--no-texture', '--max-credits', String(budget - spentByPaidSteps), '--out', out, '--timeout', '15m'], 20 * 60_000),
    'generate',
  )
  generatedId = r.id
  createdAssets.push(r.id)
  spentByPaidSteps += r.credits
  if (!readdirSync(out).length) throw new Error('nothing was downloaded')
  return `#${r.id}, ${r.credits} credits, ${readdirSync(out).join(', ')}`
}, paidSkip)
step('local export of the generated model (obj, stl, fbx)', () => {
  for (const format of ['obj', 'stl', 'fbx']) expectOk(zetta(['asset', 'export', String(generatedId), '--format', format, '--out', join(work, 'export')]), `export ${format}`)
  return readdirSync(join(work, 'export')).join(', ')
}, values.paid && signedIn ? (generatedId ? {} : { skip: 'generation failed' }) : paidSkip)
step('paid: retopology of the generated model', () => {
  const r = expectOk(zetta(['refine', 'retopo', String(generatedId), '--faces', '1000', '--max-credits', String(budget - spentByPaidSteps), '--wait', '--timeout', '15m'], 20 * 60_000), 'retopo')
  createdAssets.push(r.id)
  spentByPaidSteps += r.credits
  return `#${r.id}, ${r.credits} credits`
}, values.paid && signedIn ? (generatedId ? {} : { skip: 'generation failed' }) : paidSkip)

// ── Clean up and report ─────────────────────────────────────────────────────

if (createdAssets.length && !values.keep) {
  step('clean up created assets', () => {
    expectOk(zetta(['asset', 'delete', ...createdAssets.map(String), '--yes']), 'delete')
    return createdAssets.map((id) => `#${id}`).join(', ')
  })
}
let creditsAfter = creditsBefore
if (signedIn) creditsAfter = zetta(['account', 'credits']).json?.threeD?.total ?? creditsBefore

const failed = results.filter((r) => r.status === 'fail')
console.log(`\n${results.filter((r) => r.status === 'pass').length} passed, ${failed.length} failed, ${results.filter((r) => r.status === 'skip').length} skipped.`)
if (signedIn) console.log(`3D credits: ${creditsBefore} → ${creditsAfter} (spent ${creditsBefore - creditsAfter}).`)
if (values.report) writeFileSync(values.report, JSON.stringify({ at: new Date().toISOString(), signedIn, creditsBefore, creditsAfter, results }, null, 2))
if (existsSync(work)) console.log(`Work folder: ${work}`)
process.exit(failed.length ? 1 : 0)
