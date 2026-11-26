/**
 * Publishes builds to the Zetta storage bucket (DigitalOcean Spaces, through the S3 API) under one
 * folder (SPACES_FOLDER, default zcli/). Every file is public: the one-line installers and
 * `zetta upgrade` download them without keys.
 *
 *   zcli/macosx/zetta-darwin-arm64 (+ .sha256)     the newest build, one folder per OS
 *   zcli/windows/zetta-windows-x64.exe              zcli/linux/zetta-linux-x64-musl   …
 *   zcli/v<version>/…                               every binary, its .gz copy and SHA256SUMS
 *   zcli/install.sh, zcli/install.ps1               the installers
 *   zcli/latest.json                                what the installers and `zetta upgrade` install
 *
 * The settings are read from the environment, under the names the backend uses (SPACES_KEY,
 * SPACES_SECRET, SPACES_BUCKET, SPACES_ENDPOINT, SPACES_REGION, SPACES_CDN_ENDPOINT); their values
 * are never printed.
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { binaryName, keyFromBinaryName } from '../packages/cli/src/upgrade/manifest'

export const STORAGE_PREFIX = 'zcli'
const OS_FOLDERS: Record<string, string> = { darwin: 'macosx', windows: 'windows', linux: 'linux' }
const BINARY = 'application/octet-stream'
const TEXT = 'text/plain; charset=utf-8'

/** Where a build key's newest binary goes, e.g. zcli/macosx/zetta-darwin-arm64. */
export function storageKey(key: string, folder: string = STORAGE_PREFIX): string {
  const os = OS_FOLDERS[key.split('-')[0] ?? '']
  if (!os) throw new Error(`There is no storage folder for "${key}".`)
  return `${folder}/${os}/${binaryName(key)}`
}

export interface SpacesConfig {
  bucket: string
  endpoint: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  /** Spaces wants the bucket in the hostname. False only for local S3 stand-ins (tests). */
  virtualHostedStyle: boolean
  /** Where uploaded files can be fetched from (the CDN when SPACES_CDN_ENDPOINT is set). */
  publicBase: string
  /** The folder in the bucket that holds the releases (SPACES_FOLDER, default zcli). */
  folder: string
  /** The address installed copies and the installers download releases from: ZETTA_PUBLIC_BASE, else <publicBase>/<folder>. */
  downloadBase: string
}

const REQUIRED = ['SPACES_KEY', 'SPACES_SECRET', 'SPACES_BUCKET', 'SPACES_ENDPOINT'] as const

/** The bucket's own address, https://<bucket>.<region>.digitaloceanspaces.com (the endpoint may already name the bucket). */
function bucketAddress(bucket: string, endpoint: string): string {
  const url = new URL(/^https?:\/\//i.test(endpoint) ? endpoint : `https://${endpoint}`)
  const host = url.host.startsWith(`${bucket}.`) ? url.host.slice(bucket.length + 1) : url.host
  return `${url.protocol}//${bucket}.${host}`
}

export interface PublicLocation {
  /** The folder in the bucket (SPACES_FOLDER, default zcli). */
  folder: string
  /** Where installers and installed copies download releases from. */
  downloadBase: string
}

/**
 * Where a release will be downloaded from. Needs no keys: `base` (or ZETTA_PUBLIC_BASE) when given,
 * else built from SPACES_BUCKET and SPACES_ENDPOINT (through SPACES_CDN_ENDPOINT when set) plus the folder.
 */
export function publicLocation(env: NodeJS.ProcessEnv = process.env, options: { base?: string | undefined; folder?: string | undefined } = {}): PublicLocation {
  const folder = (options.folder?.trim() || env.SPACES_FOLDER?.trim() || STORAGE_PREFIX).replace(/^\/+|\/+$/g, '')
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(folder)) throw new Error(`"${folder}" is not a folder name (letters, digits, . _ - and /).`)
  const base = (options.base ?? env.ZETTA_PUBLIC_BASE)?.trim().replace(/\/+$/, '')
  if (base) {
    // https, except for a stand-in on this machine (tests and rehearsals).
    if (!base.startsWith('https://') && !/^http:\/\/([a-z0-9-]+\.)?localhost(:\d+)?(\/|$)/.test(base)) throw new Error(`The download address must be https://, not "${base}".`)
    return { folder, downloadBase: base }
  }
  const bucket = env.SPACES_BUCKET?.trim()
  const endpoint = env.SPACES_ENDPOINT?.trim()
  if (!bucket || !endpoint) {
    throw new Error(
      'Say where the release will be downloaded from: --base https://<bucket>.<region>.digitaloceanspaces.com/<folder> (the bucket’s Origin or CDN endpoint, plus the folder), or set SPACES_BUCKET and SPACES_ENDPOINT.',
    )
  }
  const cdn = env.SPACES_CDN_ENDPOINT?.trim().replace(/\/+$/, '')
  return { folder, downloadBase: `${cdn || bucketAddress(bucket, endpoint)}/${folder}` }
}

/** Reads the SPACES_* settings. Throws, naming only what is missing, when any are unset. */
export function spacesConfig(env: NodeJS.ProcessEnv = process.env): SpacesConfig {
  const missing = REQUIRED.filter((name) => !env[name]?.trim())
  if (missing.length) throw new Error(`Uploading needs ${missing.join(', ')} in the environment (the same settings the backend uses). See docs/releasing.md.`)
  const bucket = env.SPACES_BUCKET!.trim()
  const endpoint = bucketAddress(bucket, env.SPACES_ENDPOINT!.trim())
  const cdn = env.SPACES_CDN_ENDPOINT?.trim().replace(/\/+$/, '')
  const publicBase = cdn || endpoint
  const override = env.ZETTA_PUBLIC_BASE?.trim()
  if (override && !override.startsWith('https://')) throw new Error('ZETTA_PUBLIC_BASE must be an https:// address.')
  const { folder, downloadBase } = publicLocation(env)
  return {
    bucket,
    endpoint,
    region: env.SPACES_REGION?.trim() || 'us-east-1',
    accessKeyId: env.SPACES_KEY!.trim(),
    secretAccessKey: env.SPACES_SECRET!.trim(),
    virtualHostedStyle: true,
    publicBase,
    folder,
    downloadBase,
  }
}

export interface UploadObject {
  key: string
  type: string
  /** A local file to send, or… */
  file?: string
  /** …text to send. */
  text?: string
}

export interface ReleasePlan {
  objects: UploadObject[]
  /** True when the installers' files (latest.json and the version folder) are part of this upload. */
  installers: boolean
  /** Why the installers' files are left as they are, when they are. */
  note?: string
}

/**
 * What one upload sends, in a safe order: the version folder first, then the per-OS copies, then
 * the installers, and latest.json last, so it never points at files that are not there yet.
 *
 * - The installers' files go up only when dist/v<version>/ holds every release target. A partial
 *   build (say, only Windows) would otherwise publish a latest.json that Mac and Linux installs
 *   cannot use.
 * - A prerelease (1.2.0-beta.1) gets its version folder only: it never becomes the newest build.
 */
export function releasePlan(input: {
  version: string
  versionDir: string
  latestJson: string
  installDir: string
  keys: string[]
  releaseKeys: string[]
  /** The bucket folder (default zcli). */
  folder?: string
  /** Written into the uploaded installers as their default download address. */
  downloadBase?: string
}): ReleasePlan {
  const folder = input.folder ?? STORAGE_PREFIX
  const prerelease = input.version.includes('-')
  const missing = input.releaseKeys.filter((key) => !existsSync(join(input.versionDir, binaryName(key))))
  const complete = missing.length === 0
  const objects: UploadObject[] = []

  if (complete) {
    const names = readdirSync(input.versionDir)
      .filter((name) => keyFromBinaryName(name.replace(/\.gz$/, '')))
      .sort()
    for (const name of names) objects.push({ key: `${folder}/v${input.version}/${name}`, type: BINARY, file: join(input.versionDir, name) })
    objects.push({ key: `${folder}/v${input.version}/SHA256SUMS`, type: TEXT, file: join(input.versionDir, 'SHA256SUMS') })
  }
  if (!prerelease) {
    for (const key of input.keys) {
      const file = join(input.versionDir, binaryName(key))
      if (!existsSync(file)) continue
      const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex')
      objects.push({ key: storageKey(key, folder), type: BINARY, file })
      objects.push({ key: `${storageKey(key, folder)}.sha256`, type: TEXT, text: `${sha256}  ${binaryName(key)}\n` })
    }
  }
  if (complete && !prerelease) {
    for (const script of ['install.sh', 'install.ps1']) {
      const text = readFileSync(join(input.installDir, script), 'utf8')
      objects.push({ key: `${folder}/${script}`, type: TEXT, text: input.downloadBase ? withDownloadBase(text, input.downloadBase) : text })
    }
    objects.push({ key: `${folder}/latest.json`, type: 'application/json', file: input.latestJson })
  }

  const note = !complete
    ? `Not every platform is built (missing ${missing.join(', ')}), so the one-line installers and \`zetta upgrade\` keep the release they had. Build them all with \`bun run build all --upload\`.`
    : prerelease
      ? `${input.version} is a prerelease: it is uploaded to ${folder}/v${input.version}/ only. Install it with ZETTA_VERSION=${input.version}.`
      : undefined
  return { objects, installers: complete && !prerelease, ...(note ? { note } : {}) }
}

/**
 * An installer with its default download address replaced, so `curl … | sh` downloads from where
 * this release lives. Fails loudly if the line it replaces is ever renamed.
 */
export function withDownloadBase(script: string, base: string): string {
  const sh = /^DEFAULT_BASE="[^"]*"$/m
  const ps1 = /^(\s*)\$DefaultBase = '[^']*'$/m
  if (sh.test(script)) return script.replace(sh, `DEFAULT_BASE="${base}"`)
  if (ps1.test(script)) return script.replace(ps1, `$1$DefaultBase = '${base}'`)
  throw new Error('The installer has no default download address to set (DEFAULT_BASE / $DefaultBase).')
}

/** Uploads the objects in order, each readable by anyone (the installers fetch them without keys). */
export async function uploadObjects(objects: UploadObject[], config: SpacesConfig, log: (line: string) => void = () => {}): Promise<void> {
  // Loaded here, not at the top: the test runner (Node) imports this file for releasePlan().
  const { S3Client } = await import('bun')
  const client = new S3Client({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    endpoint: config.endpoint,
    region: config.region,
    virtualHostedStyle: config.virtualHostedStyle,
    ...(config.virtualHostedStyle ? {} : { bucket: config.bucket }),
  })
  for (const object of objects) {
    log(`  ${object.key}`)
    const body = object.file ? Bun.file(object.file) : (object.text ?? '')
    await client.write(object.key, body, { acl: 'public-read', type: object.type, partSize: 16 * 1024 * 1024, queueSize: 4, retry: 3 })
  }
}
