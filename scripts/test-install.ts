/**
 * End-to-end test of the real installers (install/install.sh, install/install.ps1) against a local
 * download host: builds this platform's binary, lays out latest.json + v<version>/ in a temp dir,
 * serves it with Bun.serve on 127.0.0.1, runs the installer exactly as users do
 * (`curl -fsSL .../install.sh | sh`, `irm .../install.ps1 | iex`) into a temp install dir, and runs
 * the installed `zetta --version`. Also checks that bad checksums, corrupted downloads, unknown
 * versions and no network are refused without touching the installed binary, (macOS/Linux) that
 * PATH setup edits each shell's rc file exactly once, and, with the real CLI entry, that an older
 * build's `zetta upgrade` replaces itself with the served release.
 *
 *   bun run scripts/test-install.ts               # build with packages/cli/src/main.ts (or a stub if missing)
 *   bun run scripts/test-install.ts --stub        # always build a stub entry that prints the version
 *   bun run scripts/test-install.ts --from-dist   # use dist/ from a previous `bun run build`
 *   bun run scripts/test-install.ts --keep        # keep the temp dir for inspection
 *   bun run scripts/test-install.ts --docker alpine:3.20 --docker debian:12
 *       # Linux + Docker only: also run install.sh inside these images (host networking), e.g. to
 *       # prove musl detection and the busybox wget path on Alpine
 *
 * Nothing outside the temp dir is modified: HOME, the install dir and PATH edits are all redirected.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, normalize, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { binaryName, parseManifest } from '../packages/cli/src/upgrade/manifest'
import { platformKey } from '../packages/cli/src/upgrade/platform'

const ROOT = resolve(import.meta.dirname, '..')
const IS_WINDOWS = process.platform === 'win32'
const ENTRY = join(ROOT, 'packages/cli/src/main.ts')

const { values } = parseArgs({
  options: {
    'from-dist': { type: 'boolean', default: false },
    stub: { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
    docker: { type: 'string', multiple: true, default: [] },
  },
  strict: true,
})

const tmp = mkdtempSync(join(tmpdir(), 'zetta-install-test-'))
const results: { name: string; ok: boolean; detail?: string }[] = []

function check(name: string, ok: boolean, detail?: string): boolean {
  results.push({ name, ok, ...(ok ? {} : { detail }) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail.replace(/\n/g, '\n      ')}`}`)
  return ok
}

function has(cmd: string): boolean {
  const r = spawnSync(IS_WINDOWS ? 'where' : 'sh', IS_WINDOWS ? [cmd] : ['-c', `command -v ${cmd}`], { stdio: 'ignore' })
  return r.status === 0
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

interface Run {
  status: number | null
  stdout: string
  stderr: string
  error?: unknown
}

function output(r: Run): string {
  return `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n${String(r.error)}` : ''}`
}

/**
 * Runs a command without blocking the event loop (spawnSync would freeze the Bun.serve host the
 * installer is downloading from).
 */
async function exec(argv: string[], env: Record<string, string>, input?: string): Promise<Run> {
  try {
    const proc = Bun.spawn(argv, {
      env,
      stdin: input === undefined ? 'ignore' : new Blob([input]),
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 180_000,
    })
    const [stdout, stderr, status] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { status, stdout, stderr }
  } catch (error) {
    return { status: null, stdout: '', stderr: '', error }
  }
}

// ---- 1. the release tree to serve ---------------------------------------------------------------

let srvRoot: string
let version: string
let entry = ENTRY
const realCli = existsSync(ENTRY) && !values.stub
const key = platformKey()

if (values['from-dist']) {
  srvRoot = join(ROOT, 'dist')
  const latest = join(srvRoot, 'latest.json')
  if (!existsSync(latest)) throw new Error('dist/latest.json not found; run `bun run build` first or drop --from-dist')
  version = parseManifest(JSON.parse(readFileSync(latest, 'utf8')), latest).version
  console.log(`Using dist/ (zetta ${version}, ${key})`)
} else {
  srvRoot = join(tmp, 'srv')
  version = `0.0.0-e2e.${process.pid}`
  if (!realCli) {
    // Stand-in CLI that goes through the real version module, so the --define injection is tested.
    entry = join(tmp, 'stub', 'main.ts')
    mkdirSync(join(tmp, 'stub'))
    const versionModule = JSON.stringify(join(ROOT, 'packages/cli/src/version.ts'))
    writeFileSync(entry, `import { VERSION } from ${versionModule}\nconsole.log(\`zetta \${VERSION}\`)\n`)
    console.log(`${existsSync(ENTRY) ? '--stub given' : 'packages/cli/src/main.ts does not exist yet'}: building a stub CLI entry`)
  }
  // Docker tests need both Linux flavours for this CPU.
  const arch = key.includes('arm64') ? 'arm64' : 'x64'
  const targets = new Set([`bun-${key}`])
  if (values.docker.length > 0) targets.add(`bun-linux-${arch}`).add(`bun-linux-${arch}-musl`)
  const build = spawnSync(
    process.execPath,
    [
      'run',
      join(ROOT, 'scripts/build-binaries.ts'),
      ...[...targets].flatMap((t) => ['--target', t]),
      '--version',
      version,
      '--entry',
      entry,
      '--outdir',
      srvRoot,
    ],
    { cwd: ROOT, encoding: 'utf8' },
  )
  if (build.status !== 0) {
    console.error(`${build.stdout}${build.stderr}`)
    throw new Error('building the test binary failed')
  }
  console.log(`Built zetta ${version} for ${key}`)
}
const binName = binaryName(key)
const binPath = join(srvRoot, `v${version}`, binName)
if (!existsSync(binPath)) throw new Error(`${binPath} not found`)

// ---- 2. local download host -------------------------------------------------------------------

/**
 * /cli/...            the release as built
 * /bad-sums/cli/...   SHA256SUMS with every hash altered
 * /bad-bin/cli/...    binaries cut in half (a broken download)
 */
const requests: string[] = []
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(req) {
    const { pathname } = new URL(req.url)
    requests.push(pathname)
    const m = /^\/(?:(bad-sums|bad-bin)\/)?cli\/(.+)$/.exec(pathname)
    if (!m?.[2]) return new Response('not found', { status: 404 })
    const mode = m[1]
    const rel = decodeURIComponent(m[2])
    if (rel === 'install.sh' || rel === 'install.ps1') {
      // Served as text, as the real host must (irm | iex needs a string).
      return new Response(Bun.file(join(ROOT, 'install', rel)), { headers: { 'content-type': 'text/plain; charset=utf-8' } })
    }
    const file = normalize(join(srvRoot, rel))
    if (!file.startsWith(srvRoot + sep) || !existsSync(file)) return new Response('not found', { status: 404 })
    if (mode === 'bad-sums' && rel.endsWith('/SHA256SUMS')) {
      const text = readFileSync(file, 'utf8').replace(/^([0-9a-f])/gm, (c) => (c === '0' ? '1' : '0'))
      return new Response(text)
    }
    if (mode === 'bad-bin' && /\/zetta-[^/]+$/.test(rel)) {
      const bytes = readFileSync(file)
      return new Response(bytes.subarray(0, bytes.length >> 1))
    }
    return new Response(Bun.file(file))
  },
})
const host = `http://127.0.0.1:${server.port}`
const BASE = `${host}/cli`

// ---- 3. running the installer -----------------------------------------------------------------

interface RunOpts {
  base?: string
  dir: string
  home?: string
  version?: string
  modifyPath?: boolean
  shell?: string
  /** Pipe the script from curl like a user would (POSIX) instead of feeding it on stdin. */
  viaCurl?: boolean
  powershell?: string
  /** Let the installer install the agent skill (off by default: on Windows HOME is the real one). */
  skill?: boolean
}

function installerEnv(o: RunOpts): Record<string, string> {
  const home = o.home ?? join(tmp, 'home')
  mkdirSync(home, { recursive: true })
  const env: Record<string, string> = IS_WINDOWS
    ? Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined))
    : { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, TMPDIR: tmp, LANG: 'C', SHELL: '/bin/sh' }
  delete env.GITHUB_PATH
  delete env.ZETTA_VERSION
  delete env.ZDOTDIR
  delete env.XDG_CONFIG_HOME
  env.ZETTA_DOWNLOAD_BASE = o.base ?? BASE
  env.ZETTA_INSTALL_DIR = o.dir
  if (o.version) env.ZETTA_VERSION = o.version
  if (o.modifyPath === false || o.modifyPath === undefined) env.ZETTA_NO_MODIFY_PATH = '1'
  if (o.shell) env.SHELL = o.shell
  env.ZETTA_NO_LOGIN = '1' // never start a browser sign-in from a test
  if (o.skill) {
    // The skill lands in the home folder: point every name for it at the temp one.
    Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), ZETTA_CONFIG_DIR: join(home, '.zetta-config') })
    delete env.ZETTA_NO_SKILL
  } else {
    env.ZETTA_NO_SKILL = '1'
  }
  return env
}

const SCRIPT = readFileSync(join(ROOT, 'install/install.sh'), 'utf8')

function runInstaller(o: RunOpts): Promise<Run> {
  const env = installerEnv(o)
  if (IS_WINDOWS) {
    const ps = o.powershell ?? 'pwsh'
    // The script always comes from the working host; ZETTA_DOWNLOAD_BASE (o.base) is what it downloads from.
    const cmd = `irm '${BASE}/install.ps1' | iex`
    return exec([ps, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd], env)
  }
  if (o.viaCurl) return exec(['sh', '-c', `curl -fsSL '${BASE}/install.sh' | sh`], env)
  // Script on stdin, as with `curl ... | sh`: catches any command in it that would eat stdin.
  return exec(['sh', '-s'], env, SCRIPT)
}

function runShell(argv: string[], o: RunOpts): Promise<Run> {
  return exec([...argv, '-s'], installerEnv(o), SCRIPT)
}

function installed(dir: string): string {
  return join(dir, IS_WINDOWS ? 'zetta.exe' : 'zetta')
}

function versionOf(bin: string): { ok: boolean; out: string } {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 30_000 })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}`
  return { ok: r.status === 0 && out.includes(version), out: out.trim() }
}

function strays(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((n) => n !== 'zetta' && n !== 'zetta.exe') : []
}

// ---- 4. the checks ----------------------------------------------------------------------------

async function installerChecks(label: string, run: (o: RunOpts) => Promise<Run>, viaCurl: boolean): Promise<void> {
  const dir = join(tmp, `inst-${label}`, 'bin')
  const bin = installed(dir)

  requests.length = 0
  let r = await run({ dir, viaCurl })
  const fresh = check(`[${label}] fresh install of the latest version exits 0`, r.status === 0, output(r))
  if (!fresh) return
  const v = versionOf(bin)
  check(`[${label}] installed \`zetta --version\` prints ${version}`, v.ok, v.out)
  check(`[${label}] success message points to \`zetta auth login\``, output(r).includes('zetta auth login'), output(r))
  check(`[${label}] no colour codes when not a terminal`, !output(r).includes('\x1b['), JSON.stringify(output(r)))
  check(`[${label}] no temp files left in the install dir`, strays(dir).length === 0, strays(dir).join(', '))
  if (existsSync(`${binPath}.gz`)) {
    check(`[${label}] downloads the gzip copy, not the full binary`, requests.some((p) => p.endsWith(`${binName}.gz`)) && !requests.some((p) => p.endsWith(`/${binName}`)), requests.filter((p) => p.includes('zetta-')).join(', '))
  }

  r = await run({ dir, version })
  check(
    `[${label}] re-running (pinned ZETTA_VERSION) upgrades in place`,
    r.status === 0 && /updated/.test(output(r)) && versionOf(bin).ok && strays(dir).length === 0,
    output(r),
  )

  const before = sha256(bin)
  r = await run({ dir, base: `${host}/bad-sums/cli` })
  check(
    `[${label}] wrong checksum is rejected and the installed binary is untouched`,
    r.status !== 0 && /checksum mismatch/i.test(output(r)) && sha256(bin) === before && strays(dir).length === 0,
    `exit ${r.status}\n${output(r)}`,
  )
  r = await run({ dir, base: `${host}/bad-bin/cli` })
  check(
    `[${label}] corrupted download is rejected`,
    r.status !== 0 && /checksum mismatch/i.test(output(r)) && sha256(bin) === before,
    `exit ${r.status}\n${output(r)}`,
  )
  r = await run({ dir, version: '9.9.9' })
  check(`[${label}] unknown version is reported`, r.status !== 0 && /9\.9\.9 was not found/.test(output(r)), output(r))
  r = await run({ dir, base: 'http://127.0.0.1:9/cli' })
  check(
    `[${label}] no network is reported clearly`,
    r.status !== 0 && /internet connection/i.test(output(r)) && sha256(bin) === before,
    output(r),
  )
}

/** A fresh install teaches the agents it finds (here Claude Code and Codex) to use zetta. */
async function skillCheck(label: string, run: (o: RunOpts) => Promise<Run>): Promise<void> {
  const home = join(tmp, `home-skill-${label}`)
  mkdirSync(join(home, '.claude'), { recursive: true })
  mkdirSync(join(home, '.codex'), { recursive: true })
  const r = await run({ dir: join(tmp, `inst-skill-${label}`, 'bin'), home, skill: true })
  const claude = join(home, '.claude', 'skills', 'zetta3d', 'SKILL.md')
  const agents = join(home, '.agents', 'skills', 'zetta3d', 'references', 'commands.md')
  check(
    `[${label}] installs the agent skill for Claude Code and Codex, and says so`,
    r.status === 0 && existsSync(claude) && existsSync(agents) && /Installed the Zetta 3D skill/.test(output(r)),
    `exit ${r.status}\n${output(r)}\nclaude: ${existsSync(claude)} · agents: ${existsSync(agents)}`,
  )
}

/** An older build of the real CLI upgrades itself to the served release with `zetta upgrade`. */
async function upgradeCheck(): Promise<void> {
  const oldVersion = '0.0.0-e2e.0'
  const oldOut = join(tmp, 'old-build')
  const build = spawnSync(
    process.execPath,
    ['run', join(ROOT, 'scripts/build-binaries.ts'), '--current', '--version', oldVersion, '--entry', entry, '--outdir', oldOut],
    { cwd: ROOT, encoding: 'utf8' },
  )
  if (!check('[upgrade] build an older zetta to upgrade from', build.status === 0, `${build.stdout}${build.stderr}`)) return
  const dir = join(tmp, 'inst-upgrade', 'bin')
  mkdirSync(dir, { recursive: true })
  const bin = installed(dir)
  writeFileSync(bin, readFileSync(join(oldOut, `v${oldVersion}`, binName)), { mode: 0o755 })
  const env = installerEnv({ dir })
  delete env.ZETTA_INSTALL_DIR
  let r = await exec([bin, 'upgrade'], env)
  check(`[upgrade] \`zetta upgrade\` (${oldVersion}) installs ${version} over itself`, r.status === 0 && versionOf(bin).ok, `exit ${r.status}\n${output(r)}\n--version: ${versionOf(bin).out}`)
  r = await exec([bin, 'upgrade'], env)
  check('[upgrade] a second `zetta upgrade` is a no-op', r.status === 0 && versionOf(bin).ok, `exit ${r.status}\n${output(r)}`)
}

async function pathChecks(): Promise<void> {
  const cases: { shell: string; files: string[]; line: RegExp; verify?: string }[] = [
    { shell: '/bin/zsh', files: ['.zshrc'], line: /^export PATH="\$HOME\/\.zetta\/bin:\$PATH"$/m, verify: 'zsh' },
    {
      shell: '/bin/bash',
      files: process.platform === 'darwin' ? ['.bashrc', '.bash_profile'] : ['.bashrc'],
      line: /^export PATH="\$HOME\/\.zetta\/bin:\$PATH"$/m,
      verify: 'bash',
    },
    { shell: '/usr/bin/fish', files: ['.config/fish/config.fish'], line: /^contains -- "\$HOME\/\.zetta\/bin" \$PATH; or set -gx PATH "\$HOME\/\.zetta\/bin" \$PATH$/m },
    { shell: '/bin/sh', files: ['.profile'], line: /^export PATH="\$HOME\/\.zetta\/bin:\$PATH"$/m, verify: 'sh' },
  ]
  for (const c of cases) {
    const name = c.shell.split('/').pop()!
    const home = join(tmp, `home-${name}`)
    const dir = join(home, '.zetta', 'bin')
    mkdirSync(home, { recursive: true })
    // An rc file without a trailing newline must not get its last line glued to ours.
    const first = join(home, c.files[0]!)
    mkdirSync(join(first, '..'), { recursive: true })
    writeFileSync(first, '# existing config, no trailing newline')
    const r1 = await runInstaller({ dir, home, shell: c.shell, modifyPath: true })
    const r2 = await runInstaller({ dir, home, shell: c.shell, modifyPath: true })
    const ok = r1.status === 0 && r2.status === 0
    for (const f of c.files) {
      const p = join(home, f)
      const text = existsSync(p) ? readFileSync(p, 'utf8') : ''
      const count = (text.match(new RegExp(c.line.source, 'gm')) ?? []).length
      check(
        `[path] SHELL=${name}: ~/${f} gets the PATH line exactly once over two runs`,
        ok && count === 1 && !text.includes('newline#'),
        `exit ${r1.status}/${r2.status}, ${count} occurrences\n--- ~/${f} ---\n${text}\n--- installer ---\n${output(r1)}`,
      )
    }
    if (c.verify && has(c.verify)) {
      const rc = join(home, c.files[0]!)
      const r = await exec([c.verify, '-c', `. "${rc}" && zetta --version`], { PATH: '/usr/bin:/bin', HOME: home })
      check(`[path] a new ${c.verify} shell finds zetta through ~/${c.files[0]}`, r.status === 0 && output(r).includes(version), output(r))
    }
  }
  // Already on PATH: nothing is written.
  const home = join(tmp, 'home-onpath')
  const dir = join(home, '.zetta', 'bin')
  mkdirSync(dir, { recursive: true })
  const env = { ...installerEnv({ dir, home, shell: '/bin/zsh', modifyPath: true }), PATH: `${dir}:${process.env.PATH ?? ''}` }
  const r = await exec(['sh', '-s'], env, SCRIPT)
  check('[path] nothing is written when the install dir is already on PATH', r.status === 0 && !existsSync(join(home, '.zshrc')), output(r))
}

/** Runs install.sh inside a container that shares the host network, then the installed zetta. */
async function dockerCheck(image: string): Promise<void> {
  if (process.platform !== 'linux' || !has('docker')) {
    check(`[docker ${image}] needs Linux with docker (host networking)`, false, 'skipped: not available here')
    return
  }
  const seen = requests.length
  const script = join(ROOT, 'install/install.sh')
  const r = await exec(
    [
      'docker', 'run', '--rm', '--network', 'host',
      '-e', `ZETTA_DOWNLOAD_BASE=${BASE}`, '-e', 'ZETTA_NO_MODIFY_PATH=1',
      '-v', `${script}:/tmp/zetta-install.sh:ro`,
      image, 'sh', '-c', 'sh /tmp/zetta-install.sh && "$HOME/.zetta/bin/zetta" --version',
    ],
    { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? tmp },
  )
  const fetched = requests.slice(seen).find((p) => /\/zetta-linux-[^/]+$/.test(p)) ?? '(none)'
  check(
    `[docker ${image}] install.sh works in the container (fetched ${fetched.split('/').pop()})`,
    r.status === 0 && output(r).includes(version),
    output(r),
  )
  // Alpine and other musl systems must get the musl build.
  const musl = await exec(['docker', 'run', '--rm', image, 'sh', '-c', 'test -f /etc/alpine-release || (ldd --version 2>&1 | grep -qi musl)'], {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
  })
  const wantMusl = musl.status === 0
  check(
    `[docker ${image}] picked the ${wantMusl ? 'musl' : 'glibc'} build`,
    wantMusl === /-musl(\.gz)?$/.test(fetched),
    `fetched ${fetched}`,
  )
}

try {
  if (IS_WINDOWS) {
    const shells = ['pwsh', 'powershell'].filter(has)
    if (shells.length === 0) check('PowerShell is available', false, 'neither pwsh nor powershell found')
    for (const ps of shells) await installerChecks(ps, (o) => runInstaller({ ...o, powershell: ps }), false)
    if (realCli && shells[0]) await skillCheck(shells[0], (o) => runInstaller({ ...o, powershell: shells[0] }))
    if (realCli) await upgradeCheck()
  } else {
    if (has('curl')) {
      const dir = join(tmp, 'inst-curl', 'bin')
      const r = await runInstaller({ dir, viaCurl: true })
      check('[curl | sh] `curl -fsSL <host>/install.sh | sh` installs a working zetta', r.status === 0 && versionOf(installed(dir)).ok, output(r))
    }
    await installerChecks('sh', runInstaller, false)
    if (realCli) await skillCheck('sh', runInstaller)
    for (const sh of ['dash', 'bash', 'ksh', 'busybox']) {
      if (!has(sh)) continue
      const dir = join(tmp, `inst-${sh}`, 'bin')
      const r = await runShell(sh === 'busybox' ? ['busybox', 'sh'] : [sh], { dir })
      check(`[${sh}] installer works under ${sh}`, r.status === 0 && versionOf(installed(dir)).ok, output(r))
    }
    await pathChecks()
    if (realCli) await upgradeCheck()
    for (const image of values.docker) await dockerCheck(image)
  }
} finally {
  void server.stop(true)
  if (values.keep) console.log(`\nKept ${tmp}`)
  else rmSync(tmp, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} installer checks passed.`)
if (failed.length > 0) process.exit(1)
