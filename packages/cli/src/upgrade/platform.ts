import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

/**
 * Which build of zetta fits this machine. Mirrors the detection in install/install.sh and
 * install/install.ps1, so the installer and `zetta upgrade` always pick the same file.
 *
 * Keys: `<os>-<arch>[-musl][-baseline]`, e.g. `darwin-arm64`, `linux-x64-musl`, `windows-x64`.
 * `-baseline` builds are for x64 CPUs without AVX2; they are only used when the CPU needs them.
 */

/** Set by scripts/build-binaries.ts (`--define __ZETTA_TARGET__="<key>"`); undefined when running from source. */
declare const __ZETTA_TARGET__: string | undefined

export interface PlatformInfo {
  platform: string
  arch: string
  /** Linux only: the C library is musl (Alpine and friends). */
  musl: boolean
  /** macOS only: this process is an x64 build translated by Rosetta on Apple Silicon. */
  rosetta: boolean
  /** x64 only: the CPU supports AVX2. */
  avx2: boolean
}

/** The key this binary was built for, if it is a release build. */
export function buildTarget(): string | undefined {
  return typeof __ZETTA_TARGET__ === 'string' ? __ZETTA_TARGET__ : undefined
}

function run(cmd: string, args: string[]): string | undefined {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 })
  } catch (err) {
    // `ldd --version` on musl prints to stderr and exits 1; keep that output.
    const e = err as { stdout?: unknown; stderr?: unknown }
    const text = `${typeof e.stdout === 'string' ? e.stdout : ''}${typeof e.stderr === 'string' ? e.stderr : ''}`
    return text || undefined
  }
}

export function detectMusl(): boolean {
  const target = buildTarget()
  // A musl build that is running proves this system has musl.
  if (target?.startsWith('linux-')) return target.includes('-musl')
  if (existsSync('/etc/alpine-release')) return true
  return /musl/i.test(run('ldd', ['--version']) ?? '')
}

export function detectRosetta(): boolean {
  return (run('sysctl', ['-n', 'sysctl.proc_translated']) ?? '').trim() === '1'
}

export function detectAvx2(platform: string): boolean {
  try {
    if (platform === 'linux') return /\bavx2\b/i.test(readFileSync('/proc/cpuinfo', 'utf8'))
    if (platform === 'darwin') {
      const out = run('sysctl', ['-n', 'machdep.cpu.leaf7_features'])
      return out === undefined ? true : /\bAVX2\b/i.test(out)
    }
  } catch {
    return true
  }
  // Windows: no cheap probe without native code. A running baseline build means the CPU needed it.
  const target = buildTarget()
  return !(target?.startsWith('windows-') && target.includes('-baseline'))
}

/**
 * The platform key for this machine, e.g. `darwin-arm64`, `linux-x64-musl`, `windows-x64`.
 * Pass fields to override detection (tests, or a forced choice). Throws for unsupported systems.
 */
export function platformKey(info: Partial<PlatformInfo> = {}): string {
  const platform = info.platform ?? process.platform
  let arch = info.arch ?? process.arch

  let os: string
  if (platform === 'darwin') os = 'darwin'
  else if (platform === 'linux') os = 'linux'
  else if (platform === 'win32' || platform === 'windows') os = 'windows'
  else throw new Error(`zetta does not support ${platform}. Supported systems: macOS, Linux and Windows.`)

  if (arch === 'x86_64' || arch === 'amd64') arch = 'x64'
  if (arch === 'aarch64') arch = 'arm64'
  if (arch !== 'x64' && arch !== 'arm64') {
    throw new Error(`zetta does not support the ${arch} CPU architecture. Supported: x64 and arm64.`)
  }

  // An x64 build under Rosetta should move to the native arm64 build.
  if (os === 'darwin' && arch === 'x64' && (info.rosetta ?? detectRosetta())) arch = 'arm64'

  let key = `${os}-${arch}`
  if (os === 'linux' && (info.musl ?? detectMusl())) key += '-musl'
  if (arch === 'x64' && !(info.avx2 ?? detectAvx2(platform))) key += '-baseline'
  return key
}

/**
 * Keys to try in order: the exact one first, then a build that still runs here. Every Mac runs the
 * universal build (`darwin-universal`, the file zetta-macos); Windows on Arm runs x64.
 */
export function candidateKeys(key: string): string[] {
  if (key.startsWith('darwin-')) return [key, 'darwin-universal']
  if (key === 'windows-arm64') return ['windows-arm64', 'windows-x64']
  return [key]
}
