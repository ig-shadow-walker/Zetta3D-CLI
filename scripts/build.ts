/**
 * Builds zetta on this machine for the targets you name.
 *
 *   bun run build                      # this machine
 *   bun run build windows              # zetta-windows-x64.exe
 *   bun run build macos linux-arm64    # several at once
 *   bun run build all                  # every release target
 *   bun run build --release            # a release: checks, every target + baseline, vendor scan, installer test
 *   bun run build --list               # every target name
 *
 * Output: release/<platform>/zetta[.exe], one folder per platform (macos-arm64, linux-x64-musl,
 * windows-x64, …), plus release/SHA256SUMS. Building one platform leaves the other folders alone.
 *
 * The download-host layout the installers and `zetta upgrade` read (dist/v<version>/ with .gz
 * copies and SHA256SUMS, and dist/latest.json) is written by scripts/build-binaries.ts as before.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { binaryName, keyFromBinaryName, normalizeVersion } from '../packages/cli/src/upgrade/manifest'
import { platformKey } from '../packages/cli/src/upgrade/platform'
import { BASELINE_TARGETS, TARGETS } from './build-binaries'

const ROOT = resolve(import.meta.dirname, '..')
const RELEASE = join(ROOT, 'release')

/** Every buildable key, e.g. darwin-arm64, linux-x64-musl, windows-x64-baseline. */
const KEYS = [...TARGETS, ...BASELINE_TARGETS].map((t) => t.replace(/^bun-/, ''))
const RELEASE_KEYS = TARGETS.map((t) => t.replace(/^bun-/, ''))

const OS_WORDS: Record<string, string> = { mac: 'darwin', macos: 'darwin', osx: 'darwin', darwin: 'darwin', linux: 'linux', alpine: 'linux', musl: 'linux', windows: 'windows', win: 'windows' }
const ARCH_WORDS: Record<string, string> = { arm64: 'arm64', aarch64: 'arm64', x64: 'x64', amd64: 'x64' }
const HOST_WORDS = new Set(['current', 'host', 'this', 'local'])

const USAGE = `Usage: bun run build [target …] [options]

Targets (default: this machine, ${platformKey()}):
  macos               both Macs (arm64 and x64); macos-arm64 or macos-x64 for one
  linux               glibc Linux (x64 and arm64); linux-x64 or linux-arm64 for one
  alpine              musl Linux, e.g. Alpine (x64 and arm64); also linux-arm64-musl
  windows             zetta-windows-x64.exe
  all                 every release target
  current             this machine
  Add -baseline to an x64 target for CPUs without AVX2, e.g. linux-x64-baseline.

Options:
  --release           a release build: runs the checks, builds every target (or the ones named)
                      plus the baseline builds, then the vendor scan and the installer test
  --baseline          also build the baseline variant of each x64 target
  --version <x.y.z>   version to stamp in (default: packages/cli/package.json)
  --outdir <dir>      output folder (default: dist)
  --skip-smoke        do not test-run this machine's binary after building
  --collect           only copy the binaries in dist/v<version>/ into release/ again (after signing them)
  --list              list every target and where it goes
  -h, --help          show this help`

/** Turns names such as `windows`, `macos-arm64` or `alpine` into build keys. Throws on an unknown name. */
export function resolveTargets(names: string[], host: string = platformKey()): string[] {
  const keys: string[] = []
  for (const raw of names) {
    const name = raw.trim().toLowerCase().replace(/^bun-/, '')
    if (name === 'all') {
      keys.push(...RELEASE_KEYS)
      continue
    }
    if (HOST_WORDS.has(name)) {
      keys.push(host)
      continue
    }
    const [osWord = '', ...words] = name.split('-')
    const os = OS_WORDS[osWord]
    if (!os) throw new Error(`Unknown target "${raw}". Try macos, linux, alpine, windows or all (bun run build --list).`)
    let arch: string | undefined
    let musl = osWord === 'alpine' || osWord === 'musl'
    let baseline = false
    for (const word of words) {
      if (ARCH_WORDS[word]) arch = ARCH_WORDS[word]
      else if (word === 'musl') musl = true
      else if (word === 'baseline') baseline = true
      else throw new Error(`Unknown target "${raw}": "${word}" is not an architecture (arm64, x64) or musl/baseline.`)
    }
    const matches = KEYS.filter((key) => {
      const [keyOs, keyArch, ...flags] = key.split('-')
      return keyOs === os && (!arch || keyArch === arch) && flags.includes('musl') === musl && flags.includes('baseline') === baseline
    })
    if (!matches.length) throw new Error(`There is no "${raw}" build. Targets: ${KEYS.join(', ')}.`)
    keys.push(...matches)
  }
  return [...new Set(keys)]
}

/** The release/ folder for a build key: macos-arm64, linux-x64-musl, windows-x64-baseline, … */
export function platformFolder(key: string): string {
  return key.replace(/^darwin-/, 'macos-')
}

/** What a binary is called inside its platform folder. */
function shortName(key: string): string {
  return key.startsWith('windows-') ? 'zetta.exe' : 'zetta'
}

/**
 * Copies each built binary into release/<platform>/ (a copy-on-write clone where the disk allows,
 * so it takes no extra space), then rewrites release/SHA256SUMS for every platform folder there.
 */
function collect(versionDir: string, keys: string[]): string[] {
  const copied: string[] = []
  for (const key of keys) {
    const source = join(versionDir, binaryName(key))
    if (!existsSync(source)) continue
    const folder = join(RELEASE, platformFolder(key))
    rmSync(folder, { recursive: true, force: true })
    mkdirSync(folder, { recursive: true })
    const target = join(folder, shortName(key))
    copyFileSync(source, target, constants.COPYFILE_FICLONE)
    copied.push(target)
  }
  const lines: string[] = []
  for (const folder of readdirSync(RELEASE, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    for (const name of ['zetta', 'zetta.exe']) {
      const file = join(RELEASE, folder, name)
      if (existsSync(file)) lines.push(`${createHash('sha256').update(readFileSync(file)).digest('hex')}  ${folder}/${name}`)
    }
  }
  writeFileSync(join(RELEASE, 'SHA256SUMS'), `${lines.join('\n')}\n`)
  return copied
}

/** Adds the baseline variant of every x64 key that has one. */
export function withBaseline(keys: string[]): string[] {
  return [...new Set(keys.flatMap((key) => (KEYS.includes(`${key}-baseline`) ? [key, `${key}-baseline`] : [key])))]
}

function step(title: string, cmd: string[], env: NodeJS.ProcessEnv = process.env): void {
  console.log(`\n▸ ${title}`)
  const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd: ROOT, stdio: 'inherit', env })
  if (r.status !== 0) {
    console.error(`\nbuild: "${title}" failed (exit ${r.status ?? r.signal}).`)
    process.exit(r.status ?? 1)
  }
}

function main(): void {
  let parsed
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        release: { type: 'boolean', default: false },
        baseline: { type: 'boolean', default: false },
        version: { type: 'string' },
        outdir: { type: 'string', default: 'dist' },
        'skip-smoke': { type: 'boolean', default: false },
        collect: { type: 'boolean', default: false },
        list: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    })
  } catch (error) {
    console.error(`build: ${(error as Error).message}\n\n${USAGE}`)
    process.exit(2)
  }
  const { values, positionals } = parsed
  if (values.help) return console.log(USAGE)
  if (values.list) {
    for (const key of KEYS) console.log(`  ${key.padEnd(26)} release/${platformFolder(key)}/${shortName(key)}${key === platformKey() ? '   (this machine)' : ''}`)
    return
  }

  let keys: string[]
  try {
    keys = resolveTargets(positionals.length ? positionals : [values.release ? 'all' : 'current'])
  } catch (error) {
    console.error(`build: ${(error as Error).message}`)
    process.exit(2)
  }
  if (values.baseline || values.release) keys = withBaseline(keys)

  let version: string
  try {
    version = normalizeVersion(values.version ?? (JSON.parse(readFileSync(join(ROOT, 'packages/cli/package.json'), 'utf8')) as { version: string }).version)
  } catch (error) {
    console.error(`build: ${(error as Error).message}`)
    process.exit(2)
  }
  const bun = process.execPath
  const versionDir = resolve(ROOT, values.outdir, `v${version}`)

  if (values.collect) {
    if (!existsSync(versionDir)) {
      console.error(`build: ${relative(ROOT, versionDir)} does not exist; build first.`)
      process.exit(2)
    }
    const built = readdirSync(versionDir).map((name) => keyFromBinaryName(name)).filter((key): key is string => Boolean(key))
    report(collect(versionDir, built))
    return
  }

  if (values.release) {
    // Fail before the long build, not after it.
    if (!process.env.ZETTA_VENDOR_WORDS && !process.env.ZETTA_VENDOR_WORDS_FILE) {
      console.error('build: --release runs the vendor-name scan, which needs ZETTA_VENDOR_WORDS_FILE (or ZETTA_VENDOR_WORDS). See docs/releasing.md.')
      process.exit(2)
    }
    step('Typecheck, tests, lint', [bun, 'run', 'check'])
  }

  step(
    `Build zetta ${version} for ${keys.join(', ')}`,
    [
      bun,
      'run',
      'scripts/build-binaries.ts',
      ...keys.flatMap((key) => ['--target', `bun-${key}`]),
      '--version',
      version,
      '--outdir',
      values.outdir,
      ...(values['skip-smoke'] ? ['--skip-smoke'] : []),
    ],
  )

  if (values.release) {
    step('Vendor-name scan', [bun, 'run', 'scripts/scan-vendor-names.ts', '--require-list', '--require-bundle'])
    if (keys.includes(platformKey())) step('Installer end to end against these files', [bun, 'run', 'scripts/test-install.ts', '--from-dist'])
    else console.log(`\n(No ${platformKey()} build, so the installer test was skipped.)`)
  }

  report(collect(versionDir, keys))
  if (keys.includes(platformKey())) console.log(`\nTry it: ${relative(ROOT, join(RELEASE, platformFolder(platformKey()), shortName(platformKey())))} --version`)
}

function report(files: string[]): void {
  console.log(`\nRelease files (and checksums in release/SHA256SUMS):`)
  for (const file of files) console.log(`  ${relative(ROOT, file).padEnd(40)} ${(statSync(file).size / 1024 / 1024).toFixed(1).padStart(6)} MB`)
}

if (import.meta.main) main()
