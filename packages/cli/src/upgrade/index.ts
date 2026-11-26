import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { open, readFile, writeFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { basename, dirname, join } from 'node:path'
import { VERSION } from '../version'
import {
  binaryName,
  compareVersions,
  downloadBase,
  normalizeVersion,
  parseChecksums,
  parseManifest,
  versionUrl,
  type LatestManifest,
  type ManifestFile,
} from './manifest'
import { candidateKeys, platformKey } from './platform'

export type { LatestManifest, ManifestFile } from './manifest'
export { compareVersions, DEFAULT_DOWNLOAD_BASE, downloadBase } from './manifest'
export { platformKey } from './platform'

/** How to (re)install from where this build's releases live. */
function installHint(): string {
  const base = downloadBase()
  return `curl -fsSL ${base}/install.sh | sh   (Windows: irm ${base}/install.ps1 | iex)`
}

export type InstallMethod = 'binary' | 'homebrew' | 'npm' | 'source'

/** How this copy of zetta was installed, which decides how it is upgraded. */
export function installMethod(execPath: string = process.execPath): InstallMethod {
  if (!isCompiledBinary(execPath)) return 'source'
  let real = execPath
  try {
    real = realpathSync(execPath)
  } catch {
    // Not resolvable: judge by the path as given.
  }
  if (/[\\/]Cellar[\\/]/.test(real)) return 'homebrew'
  if (/[\\/]node_modules[\\/]@zetta3d[\\/]/.test(real)) return 'npm'
  return 'binary'
}

/** The command that upgrades this copy. */
export function upgradeCommand(method: InstallMethod = installMethod()): string {
  if (method === 'homebrew') return 'brew upgrade zetta'
  if (method === 'npm') return 'npm install -g @zetta3d/cli@latest'
  if (method === 'source') return 'git pull'
  return 'zetta upgrade'
}

function errMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause
    return cause instanceof Error && cause.message && !err.message.includes(cause.message)
      ? `${err.message} (${cause.message})`
      : err.message
  }
  return String(err)
}

async function get(url: string, fetchImpl: typeof fetch, accept: string): Promise<Response> {
  let res: Response
  try {
    res = await fetchImpl(url, {
      headers: { accept, 'cache-control': 'no-cache', 'user-agent': `zetta-cli/${VERSION}` },
      redirect: 'follow',
    })
  } catch (err) {
    throw new Error(
      `Could not reach the zetta download server (${url}): ${errMessage(err)}. ` +
        'Check your internet connection, or ZETTA_DOWNLOAD_BASE if you set it.',
    )
  }
  if (!res.ok) {
    throw new Error(`The zetta download server answered HTTP ${res.status} for ${url}.`)
  }
  return res
}

/** Fetches and validates `<base>/latest.json`. `base` defaults to `ZETTA_DOWNLOAD_BASE` or the production host. */
export async function fetchLatest(base?: string, fetchImpl: typeof fetch = fetch): Promise<LatestManifest> {
  const url = `${downloadBase(base)}/latest.json`
  const res = await get(url, fetchImpl, 'application/json')
  let data: unknown
  try {
    data = await res.json()
  } catch {
    throw new Error(`The release manifest at ${url} is not valid JSON.`)
  }
  return parseManifest(data, url)
}

/** Fetches `<base>/v<version>/SHA256SUMS` as file name -> sha256. A 404 means the version does not exist. */
export async function fetchChecksums(base: string, version: string, fetchImpl: typeof fetch = fetch): Promise<Map<string, string>> {
  const url = versionUrl(base, version, 'SHA256SUMS')
  let res: Response
  try {
    res = await get(url, fetchImpl, 'text/plain')
  } catch (err) {
    if (/HTTP 404/.test(errMessage(err))) throw new Error(`zetta ${version} was not found on ${downloadBase(base)}.`)
    throw err
  }
  return parseChecksums(await res.text())
}

/** True when `execPath` is a compiled zetta binary rather than bun/node running the sources. */
export function isCompiledBinary(execPath: string = process.execPath): boolean {
  const name = (execPath.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.exe$/, '')
  return !['bun', 'bun-debug', 'bunx', 'node', 'nodejs'].includes(name)
}

export interface UpgradeOptions {
  /** Download base; defaults to `ZETTA_DOWNLOAD_BASE` or https://downloads.zetta3d.ai/zcli. */
  base?: string
  /** Install exactly this version (may be older). Default: the latest release, only if newer. */
  version?: string
  /** The executable to replace. Default: `process.execPath`. */
  execPath?: string
  fetchImpl?: typeof fetch
  onProgress?: (msg: string) => void
  /** The running version. Default: the CLI's own VERSION. */
  currentVersion?: string
  /** Override the detected platform key (see `platformKey()`). */
  platform?: string
  /** Reinstall even when already on that version. */
  force?: boolean
  /** Run the new binary with `--version` before swapping it in. Default: true. */
  verifyRun?: boolean
}

export interface UpgradeResult {
  from: string
  to: string
  path: string
  upgraded: boolean
}

interface Target {
  version: string
  file: ManifestFile
}

function pickFile(files: (name: string) => ManifestFile | undefined, key: string, version: string): ManifestFile {
  for (const k of candidateKeys(key)) {
    const f = files(k)
    if (f) return f
  }
  if (key.endsWith('-baseline')) {
    throw new Error(
      `zetta ${version} has no build for this CPU (${key}: an x64 processor without AVX2). ` +
        'Please report this to Zetta 3D support so we can add one.',
    )
  }
  throw new Error(`zetta ${version} has no build for ${key}.`)
}

async function resolveTarget(
  base: string,
  key: string,
  opts: UpgradeOptions,
  from: string,
  fetchImpl: typeof fetch,
  progress: (msg: string) => void,
): Promise<Target | undefined> {
  if (opts.version) {
    const version = normalizeVersion(opts.version)
    if (!opts.force && compareVersions(version, from) === 0) return undefined
    progress(`Looking up zetta ${version}...`)
    const sums = await fetchChecksums(base, version, fetchImpl)
    const file = pickFile(
      (k) => {
        const name = binaryName(k)
        const sha256 = sums.get(name)
        const gz = sums.get(`${name}.gz`)
        return sha256 ? { name, sha256, size: -1, ...(gz ? { gz: { name: `${name}.gz`, sha256: gz, size: -1 } } : {}) } : undefined
      },
      key,
      version,
    )
    return { version, file }
  }
  progress('Checking for the latest version...')
  const latest = await fetchLatest(base, fetchImpl)
  if (!opts.force && compareVersions(latest.version, from) <= 0) return undefined
  return { version: latest.version, file: pickFile((k) => latest.files[k], key, latest.version) }
}

async function download(url: string, dest: string, fetchImpl: typeof fetch): Promise<{ sha256: string; size: number }> {
  const res = await get(url, fetchImpl, 'application/octet-stream')
  if (!res.body) throw new Error(`The download of ${url} was empty.`)
  const hash = createHash('sha256')
  let size = 0
  const fh = await open(dest, 'w', 0o755)
  try {
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      hash.update(value)
      size += value.byteLength
      await fh.write(value)
    }
  } catch (err) {
    throw new Error(`The download of ${url} failed: ${errMessage(err)}`)
  } finally {
    await fh.close()
  }
  return { sha256: hash.digest('hex'), size }
}

/** Downloads the gzip copy, checks its own checksum, and writes the unpacked binary to `dest`. */
async function downloadGzip(url: string, gzSha256: string, dest: string, fetchImpl: typeof fetch): Promise<{ sha256: string; size: number }> {
  const gzPath = `${dest}.gz`
  try {
    const packed = await download(url, gzPath, fetchImpl)
    if (packed.sha256 !== gzSha256.toLowerCase()) {
      throw new Error(`Checksum mismatch for ${url.split('/').pop()}: expected ${gzSha256}, got ${packed.sha256}. Nothing was changed.`)
    }
    const binary = gunzipSync(await readFile(gzPath))
    await writeFile(dest, binary, { mode: 0o755 })
    return { sha256: createHash('sha256').update(binary).digest('hex'), size: binary.byteLength }
  } finally {
    rmSync(gzPath, { force: true })
  }
}

function permissionHint(err: unknown, path: string): Error {
  const code = (err as { code?: string }).code
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return new Error(
      `Cannot replace ${path}: permission denied. Fix the permissions of ${dirname(path)}, or reinstall with: ${installHint()}`,
    )
  }
  return err instanceof Error ? err : new Error(String(err))
}

/**
 * Moves `src` over `target` atomically. On Windows a running .exe cannot be overwritten but can be
 * renamed, so the old file moves to `<target>.old` first (removed by `cleanupOldBinaries()` later).
 * Exported for tests.
 */
export function replaceExecutable(src: string, target: string, windows: boolean = process.platform === 'win32'): void {
  if (!windows) {
    renameSync(src, target)
    return
  }
  let old = `${target}.old`
  try {
    rmSync(old, { force: true })
  } catch {
    // A previous .old is still running; park this one under a unique name.
    old = `${target}.${Date.now()}.old`
  }
  const hadTarget = existsSync(target)
  if (hadTarget) renameSync(target, old)
  try {
    renameSync(src, target)
  } catch (err) {
    if (hadTarget) renameSync(old, target)
    throw err
  }
  try {
    rmSync(old, { force: true })
  } catch {
    // Still running (it is us). cleanupOldBinaries() removes it on a later run.
  }
}

/** Best-effort removal of `<exe>.old` files left by a Windows upgrade. Safe to call at every start-up. */
export function cleanupOldBinaries(execPath: string = process.execPath): void {
  if (!isCompiledBinary(execPath)) return
  try {
    const dir = dirname(execPath)
    const base = basename(execPath)
    for (const name of readdirSync(dir)) {
      if (name.startsWith(`${base}.`) && name.endsWith('.old')) rmSync(join(dir, name), { force: true })
    }
  } catch {
    // Ignore: a file still in use is retried next time.
  }
}

/**
 * Replaces the running zetta binary with the latest release (or `opts.version`): downloads the build
 * for this platform, checks its SHA-256, test-runs it, then swaps it in atomically. Returns
 * `upgraded: false` when already up to date. Throws with a readable message on any failure, leaving
 * the current binary untouched.
 */
export async function upgradeSelf(opts: UpgradeOptions = {}): Promise<UpgradeResult> {
  const execPath = opts.execPath ?? process.execPath
  if (!isCompiledBinary(execPath)) {
    const runner = (execPath.split(/[\\/]/).pop() ?? 'bun').replace(/\.exe$/i, '')
    throw new Error(
      `zetta upgrade only works on an installed zetta binary, but this zetta is running from source under ${runner}. ` +
        `Update the sources with git instead, or install the binary with: ${installHint()}`,
    )
  }
  const method = opts.execPath ? 'binary' : installMethod(execPath)
  if (method === 'homebrew' || method === 'npm') {
    // Replacing a file the package manager owns would leave it confused about what is installed.
    throw new Error(`This zetta was installed with ${method === 'homebrew' ? 'Homebrew' : 'npm'}; upgrade it with: ${upgradeCommand(method)}`)
  }
  const progress = opts.onProgress ?? (() => {})
  const fetchImpl = opts.fetchImpl ?? fetch
  const from = opts.currentVersion ?? VERSION
  const base = downloadBase(opts.base)
  const key = opts.platform ?? platformKey()

  let target: string
  try {
    target = realpathSync(execPath)
  } catch {
    throw new Error(`Cannot find the zetta binary at ${execPath}. Reinstall with: ${installHint()}`)
  }

  const next = await resolveTarget(base, key, opts, from, fetchImpl, progress)
  if (!next) return { from, to: opts.version ? normalizeVersion(opts.version) : from, path: target, upgraded: false }

  const isWindows = key.startsWith('windows-')
  const tmp = join(dirname(target), `.zetta-upgrade-${process.pid}-${randomBytes(4).toString('hex')}${isWindows ? '.exe' : ''}`)
  const url = versionUrl(base, next.version, next.file.name)
  try {
    progress(`Downloading zetta ${next.version} (${key})...`)
    let got: { sha256: string; size: number }
    try {
      got = next.file.gz ? await downloadGzip(versionUrl(base, next.version, next.file.gz.name), next.file.gz.sha256, tmp, fetchImpl) : await download(url, tmp, fetchImpl)
    } catch (err) {
      throw permissionHint(err, target)
    }
    if (next.file.size >= 0 && got.size !== next.file.size) {
      throw new Error(
        `The download of ${next.file.name} is ${got.size} bytes, expected ${next.file.size}. Nothing was changed; try again.`,
      )
    }
    if (got.sha256 !== next.file.sha256.toLowerCase()) {
      throw new Error(
        `Checksum mismatch for ${next.file.name}: expected ${next.file.sha256}, got ${got.sha256}. ` +
          'The download is corrupted or was tampered with. Nothing was changed.',
      )
    }
    progress('Checksum verified.')
    if (!isWindows) chmodSync(tmp, 0o755)
    if (opts.verifyRun ?? true) {
      try {
        execFileSync(tmp, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 })
      } catch (err) {
        throw new Error(`The new zetta ${next.version} binary does not run on this system (${errMessage(err)}). Nothing was changed.`)
      }
    }
    try {
      replaceExecutable(tmp, target, isWindows)
    } catch (err) {
      throw permissionHint(err, target)
    }
    progress(`Installed zetta ${next.version} at ${target}.`)
    return { from, to: next.version, path: target, upgraded: true }
  } finally {
    rmSync(tmp, { force: true })
  }
}
