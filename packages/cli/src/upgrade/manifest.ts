/**
 * The release manifest format, shared by `scripts/build-binaries.ts`, the installers
 * (`install/install.sh`, `install/install.ps1`) and `zetta upgrade`.
 *
 * Releases are GitHub releases (default base https://github.com/<RELEASE_REPO>/releases):
 *
 *   latest/download/latest.json              -> LatestManifest for the newest stable release
 *   download/v<version>/zetta-macos          -> every Mac (Apple Silicon and Intel, one universal file)
 *   download/v<version>/zetta-linux-x64      -> Linux (x64, glibc)
 *   download/v<version>/zetta-windows-x64.exe -> Windows (x64; Windows on Arm runs it too)
 *   download/v<version>/SHA256SUMS           -> "<sha256>  <file name>" per line
 *
 * Other keys (`linux-arm64`, `-musl`, `-baseline`) can still be built locally, and clients still
 * understand them and `.gz` copies, but releases ship only the three files above.
 *
 * Any other base is a plain folder (a mirror, or a local stand-in for tests):
 * `<base>/latest.json` and `<base>/v<version>/<file>`.
 *
 * Published versions never change; only "latest" moves.
 *
 * This file must stay free of runtime dependencies so build scripts can import it.
 */

/** The public GitHub repository whose releases hold every zetta build. */
export const RELEASE_REPO = 'ig-shadow-walker/Zetta3D-CLI'

export interface ManifestFile {
  /** File name inside `v<version>/`, e.g. `zetta-linux-x64-musl` or `zetta-windows-x64.exe`. */
  name: string
  /** Lower-case hex SHA-256 of the file. */
  sha256: string
  /** Size in bytes. */
  size: number
  /** A gzip copy (about half the size), when the release has one. */
  gz?: { name: string; sha256: string; size: number }
}

export interface LatestManifest {
  /** Semver without a leading `v`, e.g. `0.2.0`. */
  version: string
  /** ISO 8601 build time. */
  released: string
  /** Platform key (see `platformKey()`) -> file. */
  files: Record<string, ManifestFile>
}

declare const __ZETTA_DOWNLOAD_BASE__: string | undefined

/**
 * Where releases are published. A release build bakes in the address it was published to
 * (`--define __ZETTA_DOWNLOAD_BASE__=…`, see scripts/release.ts), so installed copies find new
 * versions there; anything else uses the GitHub releases of RELEASE_REPO.
 */
export const DEFAULT_DOWNLOAD_BASE: string =
  typeof __ZETTA_DOWNLOAD_BASE__ === 'string' && __ZETTA_DOWNLOAD_BASE__ ? __ZETTA_DOWNLOAD_BASE__ : `https://github.com/${RELEASE_REPO}/releases`

/** The download base without a trailing slash: the argument, else `ZETTA_DOWNLOAD_BASE`, else the default. */
export function downloadBase(base?: string): string {
  const raw = (base ?? process.env.ZETTA_DOWNLOAD_BASE ?? '').trim()
  return (raw || DEFAULT_DOWNLOAD_BASE).replace(/\/+$/, '')
}

/** True for a GitHub releases address (one ending in `/releases`), which lays files out GitHub's way. */
export function isGitHubReleases(base?: string): boolean {
  return downloadBase(base).endsWith('/releases')
}

/** A file of the newest stable release: `<base>/latest/download/<file>` on GitHub, `<base>/<file>` elsewhere. */
export function latestUrl(base: string | undefined, file: string): string {
  const root = downloadBase(base)
  return isGitHubReleases(root) ? `${root}/latest/download/${file}` : `${root}/${file}`
}

/** The one macOS build: Apple Silicon and Intel in a single universal file, `zetta-macos`. */
export const MAC_UNIVERSAL = 'darwin-universal'

/** `linux-x64` -> `zetta-linux-x64`; Windows keys get `.exe`; the universal Mac build is `zetta-macos`. */
export function binaryName(key: string): string {
  if (key === MAC_UNIVERSAL) return 'zetta-macos'
  return `zetta-${key}${key.startsWith('windows-') ? '.exe' : ''}`
}

/** The platform key encoded in a binary's file name, or undefined if it is not one of ours. */
export function keyFromBinaryName(name: string): string | undefined {
  if (name === 'zetta-macos') return MAC_UNIVERSAL
  const m = /^zetta-((?:darwin|linux|windows)-[a-z0-9]+(?:-musl)?(?:-baseline)?)(\.exe)?$/.exec(name)
  if (!m?.[1]) return undefined
  const key = m[1]
  const isWindows = key.startsWith('windows-')
  return isWindows === (m[2] === '.exe') ? key : undefined
}

/** A file of one version: `<base>/download/v<version>/<file>` on GitHub, `<base>/v<version>/<file>` elsewhere. */
export function versionUrl(base: string | undefined, version: string, file: string): string {
  const root = downloadBase(base)
  return isGitHubReleases(root) ? `${root}/download/v${version}/${file}` : `${root}/v${version}/${file}`
}

const SEMVER =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

interface ParsedVersion {
  core: [number, number, number]
  pre: string[]
}

function parseVersion(v: string): ParsedVersion {
  const m = SEMVER.exec(v.trim())
  if (!m) throw new Error(`Not a valid version: "${v}" (expected something like 1.2.3 or 1.2.3-beta.1).`)
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split('.') : [],
  }
}

/** Strips a leading `v` and checks the version is semver. Throws otherwise. */
export function normalizeVersion(v: string): string {
  parseVersion(v)
  return v.trim().replace(/^v/, '')
}

/**
 * Semver ordering (build metadata ignored): negative if a < b, 0 if equal, positive if a > b.
 * A leading `v` is allowed. Throws on anything that is not semver.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  for (let i = 0; i < 3; i++) {
    const d = pa.core[i]! - pb.core[i]!
    if (d !== 0) return Math.sign(d)
  }
  // A release sorts after its prereleases.
  if (pa.pre.length === 0 || pb.pre.length === 0) {
    return pa.pre.length === pb.pre.length ? 0 : pa.pre.length === 0 ? 1 : -1
  }
  const n = Math.max(pa.pre.length, pb.pre.length)
  for (let i = 0; i < n; i++) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNum = /^\d+$/.test(x)
    const yNum = /^\d+$/.test(y)
    if (xNum && yNum) {
      const d = Number(x) - Number(y)
      if (d !== 0) return Math.sign(d)
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

/** Validates parsed JSON as a LatestManifest. `source` names where it came from, for error messages. */
export function parseManifest(data: unknown, source: string): LatestManifest {
  const bad = (why: string) => new Error(`The release manifest at ${source} is invalid: ${why}.`)
  if (!data || typeof data !== 'object') throw bad('not a JSON object')
  const obj = data as Record<string, unknown>
  if (typeof obj.version !== 'string') throw bad('"version" is missing')
  let version: string
  try {
    version = normalizeVersion(obj.version)
  } catch {
    throw bad(`"version" is not semver (${JSON.stringify(obj.version)})`)
  }
  if (!obj.files || typeof obj.files !== 'object') throw bad('"files" is missing')
  const files: Record<string, ManifestFile> = {}
  for (const [key, value] of Object.entries(obj.files as Record<string, unknown>)) {
    const f = value as Partial<ManifestFile> | null
    if (!f || typeof f.name !== 'string' || typeof f.sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(f.sha256)) {
      throw bad(`entry "${key}" needs a "name" and a 64-character "sha256"`)
    }
    if (f.name.includes('/') || f.name.includes('\\') || f.name.startsWith('.')) {
      throw bad(`entry "${key}" has an unsafe file name`)
    }
    files[key] = { name: f.name, sha256: f.sha256.toLowerCase(), size: typeof f.size === 'number' ? f.size : -1 }
    const gz = f.gz as Partial<ManifestFile> | undefined
    if (gz && typeof gz.name === 'string' && gz.name === `${f.name}.gz` && typeof gz.sha256 === 'string' && /^[0-9a-fA-F]{64}$/.test(gz.sha256)) {
      files[key]!.gz = { name: gz.name, sha256: gz.sha256.toLowerCase(), size: typeof gz.size === 'number' ? gz.size : -1 }
    }
  }
  return { version, released: typeof obj.released === 'string' ? obj.released : '', files }
}

/** Parses `sha256sum` output ("<hash>  <name>" or "<hash> *<name>") into name -> lower-case hash. */
export function parseChecksums(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line)
    if (m?.[1] && m[2]) out.set(m[2], m[1].toLowerCase())
  }
  return out
}

/** Formats checksums the way `sha256sum` does, sorted by file name, so `sha256sum -c` accepts them. */
export function formatChecksums(entries: Iterable<{ name: string; sha256: string }>): string {
  return [...entries]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((e) => `${e.sha256}  ${e.name}\n`)
    .join('')
}
