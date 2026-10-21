/**
 * Compiles the CLI into self-contained executables (Bun runtime included) and writes the
 * release layout the installers and `zetta upgrade` read:
 *
 *   dist/v<version>/zetta-<os>-<arch>[-musl][.exe]
 *   dist/v<version>/SHA256SUMS
 *   dist/latest.json
 *
 * plus dist/bundle/zetta.js: the same minified JavaScript the binaries embed, for the vendor-name
 * scan (scripts/scan-vendor-names.ts). It is kept outside v<version>/ so it is never published.
 *
 * Usage:
 *   bun run scripts/build-binaries.ts                 # every release target
 *   bun run scripts/build-binaries.ts --current       # only this machine's target
 *   bun run scripts/build-binaries.ts --version 1.2.3 # override packages/cli/package.json
 *   bun run scripts/build-binaries.ts --baseline      # also build x64 builds for CPUs without AVX2
 *   bun run scripts/build-binaries.ts --rehash        # only recompute SHA256SUMS + latest.json
 *                                                     # (run after signing changed the binaries)
 * Other flags: --target <bun-target> (repeatable), --entry <file>, --outdir <dir>, --skip-smoke.
 *
 * Cross-compiling downloads each target's Bun runtime once into Bun's cache.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  binaryName,
  formatChecksums,
  keyFromBinaryName,
  normalizeVersion,
  type LatestManifest,
  type ManifestFile,
} from '../packages/cli/src/upgrade/manifest'
import { platformKey } from '../packages/cli/src/upgrade/platform'

const ROOT = resolve(import.meta.dirname, '..')

const USAGE = `Usage: bun run scripts/build-binaries.ts [options]

  --current            build only this machine's target
  --version <x.y.z>    version to stamp in (default: packages/cli/package.json)
  --baseline           also build x64 binaries for CPUs without AVX2
  --target <bun-tgt>   build this Bun target instead (repeatable)
  --entry <file>       CLI entry point (default: packages/cli/src/main.ts)
  --outdir <dir>       output folder (default: dist)
  --rehash             only recompute SHA256SUMS and latest.json for --version
  --skip-smoke         do not run the host binary with --version after building`

/** The release targets. Order is the order in latest.json. */
export const TARGETS = [
  'bun-darwin-arm64',
  'bun-darwin-x64',
  'bun-linux-x64',
  'bun-linux-arm64',
  'bun-linux-x64-musl',
  'bun-linux-arm64-musl',
  'bun-windows-x64',
] as const

/** For x64 CPUs without AVX2 (old hardware, some VMs and emulators). Picked automatically by the installers. */
export const BASELINE_TARGETS = [
  'bun-darwin-x64-baseline',
  'bun-linux-x64-baseline',
  'bun-linux-x64-musl-baseline',
  'bun-windows-x64-baseline',
] as const

const KEY_ORDER: string[] = [...TARGETS, ...BASELINE_TARGETS].map((t) => t.replace(/^bun-/, ''))

function fail(msg: string): never {
  console.error(`build-binaries: ${msg}`)
  process.exit(1)
}

export function keyForTarget(target: string): string {
  const key = target.replace(/^bun-/, '')
  if (!keyFromBinaryName(binaryName(key))) fail(`unknown target "${target}" (expected e.g. bun-linux-x64-musl)`)
  return key
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

function releasedAt(): string {
  // Honour SOURCE_DATE_EPOCH for reproducible manifests.
  const epoch = process.env.SOURCE_DATE_EPOCH
  return (epoch && /^\d+$/.test(epoch) ? new Date(Number(epoch) * 1000) : new Date()).toISOString()
}

/** Hashes every zetta-* binary in `versionDir`, then writes SHA256SUMS and `<outdir>/latest.json`. */
export async function writeManifest(outdir: string, version: string): Promise<LatestManifest> {
  const versionDir = join(outdir, `v${version}`)
  if (!existsSync(versionDir)) fail(`${versionDir} does not exist; build first`)
  const found: { key: string; file: ManifestFile }[] = []
  for (const name of readdirSync(versionDir)) {
    const key = keyFromBinaryName(name)
    if (!key) continue
    const path = join(versionDir, name)
    found.push({ key, file: { name, sha256: await sha256File(path), size: statSync(path).size } })
  }
  if (found.length === 0) fail(`no zetta-* binaries in ${versionDir}`)
  const rank = (k: string) => (KEY_ORDER.includes(k) ? KEY_ORDER.indexOf(k) : KEY_ORDER.length)
  found.sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key))

  const manifest: LatestManifest = {
    version,
    released: releasedAt(),
    files: Object.fromEntries(found.map((f) => [f.key, f.file])),
  }
  writeFileSync(join(versionDir, 'SHA256SUMS'), formatChecksums(found.map((f) => f.file)))
  writeFileSync(join(outdir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

function run(cmd: string, args: string[], opts: { quiet?: boolean } = {}): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: opts.quiet ? 'pipe' : ['ignore', 'inherit', 'inherit'] })
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}` }
}

/**
 * Cross-compiled macOS binaries keep the signature of the downloaded runtime, which the appended
 * code invalidates; macOS kills such binaries on launch. Re-sign them ad hoc (real Developer ID
 * signing happens later in the release workflow).
 */
function fixMacSignature(file: string): void {
  if (process.platform !== 'darwin') return
  if (run('codesign', ['--verify', file], { quiet: true }).ok) return
  const r = run('codesign', ['--force', '--sign', '-', file], { quiet: true })
  if (!r.ok) fail(`could not ad-hoc sign ${file}:\n${r.out}`)
}

function windowsMetadata(version: string): string[] {
  // Bun can only embed Windows file properties when compiling on Windows.
  if (process.platform !== 'win32') return []
  const numeric = version.split(/[-+]/)[0]
  return [
    '--windows-title=Zetta 3D CLI',
    '--windows-publisher=Zetta 3D',
    `--windows-version=${numeric}.0`,
    '--windows-description=Zetta 3D command-line interface',
  ]
}

function build(entry: string, target: string, outfile: string, version: string): void {
  const key = keyForTarget(target)
  const args = [
    'build',
    entry,
    '--compile',
    '--minify',
    // No source maps: they would carry the original sources, comments included.
    '--sourcemap=none',
    `--target=${target}`,
    `--outfile=${outfile}`,
    '--define',
    `__ZETTA_VERSION__=${JSON.stringify(version)}`,
    '--define',
    `__ZETTA_TARGET__=${JSON.stringify(key)}`,
    // A compiled CLI must not pick up .env or bunfig.toml (which can preload code) from whatever
    // directory the user runs it in.
    '--no-compile-autoload-dotenv',
    '--no-compile-autoload-bunfig',
    ...(target.startsWith('bun-windows-') ? windowsMetadata(version) : []),
  ]
  const r = run(process.execPath, args, { quiet: true })
  if (!r.ok || !existsSync(outfile)) fail(`bun build failed for ${target}:\n${r.out}`)
  if (target.startsWith('bun-darwin-')) fixMacSignature(outfile)
}

/** The minified bundle the binaries embed, as plain JavaScript, for scanning. */
function buildBundle(entry: string, outfile: string, version: string): void {
  const r = run(
    process.execPath,
    [
      'build',
      entry,
      '--target=bun',
      '--minify',
      '--sourcemap=none',
      `--outfile=${outfile}`,
      '--define',
      `__ZETTA_VERSION__=${JSON.stringify(version)}`,
    ],
    { quiet: true },
  )
  if (!r.ok || !existsSync(outfile)) fail(`bun build of the JavaScript bundle failed:\n${r.out}`)
}

function smokeTest(file: string, version: string): void {
  const r = spawnSync(file, ['--version'], { encoding: 'utf8', timeout: 30_000 })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  if (r.status !== 0 || !out.includes(version)) {
    fail(
      `smoke test failed: \`${display(file)} --version\` exited ${r.status ?? r.signal} ` +
        `and printed ${JSON.stringify(out.trim().slice(0, 300))} (expected it to contain ${version}). ` +
        'Pass --skip-smoke to skip this check.',
    )
  }
}

function display(path: string): string {
  const r = relative(ROOT, path)
  return r.startsWith('..') ? path : r
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      current: { type: 'boolean', default: false },
      baseline: { type: 'boolean', default: false },
      rehash: { type: 'boolean', default: false },
      'skip-smoke': { type: 'boolean', default: false },
      version: { type: 'string' },
      target: { type: 'string', multiple: true },
      entry: { type: 'string', default: 'packages/cli/src/main.ts' },
      outdir: { type: 'string', default: 'dist' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  })
  if (values.help) {
    console.log(USAGE)
    return
  }

  const pkg = JSON.parse(readFileSync(join(ROOT, 'packages/cli/package.json'), 'utf8')) as { version: string }
  let version: string
  try {
    version = normalizeVersion(values.version ?? pkg.version)
  } catch (err) {
    fail((err as Error).message)
  }
  const outdir = resolve(ROOT, values.outdir)
  const versionDir = join(outdir, `v${version}`)

  if (values.rehash) {
    const m = await writeManifest(outdir, version)
    console.log(`Rehashed ${Object.keys(m.files).length} binaries for ${version}; wrote ${display(join(outdir, 'latest.json'))}`)
    return
  }

  const hostKey = platformKey()
  const targets: string[] = values.current
    ? [`bun-${hostKey}`]
    : values.target?.length
      ? values.target
      : [...TARGETS, ...(values.baseline ? BASELINE_TARGETS : [])]

  const entry = resolve(ROOT, values.entry)
  if (!existsSync(entry)) fail(`CLI entry point not found: ${display(entry)}`)

  rmSync(versionDir, { recursive: true, force: true })
  mkdirSync(versionDir, { recursive: true })

  console.log(`Building zetta ${version} for ${targets.length} target(s) from ${display(entry)}`)
  for (const target of targets) {
    const key = keyForTarget(target)
    const outfile = join(versionDir, binaryName(key))
    const started = Date.now()
    build(entry, target, outfile, version)
    console.log(`  ${key.padEnd(26)} ${mb(statSync(outfile).size).padStart(9)}  ${((Date.now() - started) / 1000).toFixed(1)}s`)
    if (key === hostKey && !values['skip-smoke']) smokeTest(outfile, version)
  }
  if (process.platform !== 'darwin' && targets.some((t) => t.startsWith('bun-darwin-'))) {
    console.warn(
      'Note: macOS binaries built on a non-macOS host keep an invalid code signature and will not launch on a Mac. ' +
        'Build releases on macOS (as .github/workflows/release.yml does).',
    )
  }

  const bundleDir = join(outdir, 'bundle')
  rmSync(bundleDir, { recursive: true, force: true })
  mkdirSync(bundleDir, { recursive: true })
  const bundle = join(bundleDir, 'zetta.js')
  buildBundle(entry, bundle, version)
  console.log(`  ${'bundle (scan only)'.padEnd(26)} ${mb(statSync(bundle).size).padStart(9)}  ${display(bundle)}`)

  const manifest = await writeManifest(outdir, version)
  console.log(
    `Wrote ${display(join(versionDir, 'SHA256SUMS'))} and ${display(join(outdir, 'latest.json'))} ` +
      `(${Object.keys(manifest.files).length} files)`,
  )
}

if (import.meta.main) await main()
