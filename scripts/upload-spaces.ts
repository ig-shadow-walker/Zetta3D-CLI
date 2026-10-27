/**
 * Publishes builds to the Zetta storage bucket (DigitalOcean Spaces, through the S3 API) under zcli/,
 * which https://downloads.zetta3d.ai/zcli serves. Every file is public: the one-line installers
 * and `zetta upgrade` download them without keys.
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
export function storageKey(key: string): string {
  const folder = OS_FOLDERS[key.split('-')[0] ?? '']
  if (!folder) throw new Error(`There is no storage folder for "${key}".`)
  return `${STORAGE_PREFIX}/${folder}/${binaryName(key)}`
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
}

const REQUIRED = ['SPACES_KEY', 'SPACES_SECRET', 'SPACES_BUCKET', 'SPACES_ENDPOINT'] as const

/** Reads the SPACES_* settings. Throws, naming only what is missing, when any are unset. */
export function spacesConfig(env: NodeJS.ProcessEnv = process.env): SpacesConfig {
  const missing = REQUIRED.filter((name) => !env[name]?.trim())
  if (missing.length) throw new Error(`Uploading needs ${missing.join(', ')} in the environment (the same settings the backend uses). See docs/releasing.md.`)
  const bucket = env.SPACES_BUCKET!.trim()
  const raw = env.SPACES_ENDPOINT!.trim()
  const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
  // Spaces is virtual-hosted (https://<bucket>.<region>.digitaloceanspaces.com). Accept the
  // endpoint with or without the bucket in front, as the backend does.
  const host = url.host.startsWith(`${bucket}.`) ? url.host.slice(bucket.length + 1) : url.host
  const endpoint = `${url.protocol}//${bucket}.${host}`
  const cdn = env.SPACES_CDN_ENDPOINT?.trim().replace(/\/+$/, '')
  return {
    bucket,
    endpoint,
    region: env.SPACES_REGION?.trim() || 'us-east-1',
    accessKeyId: env.SPACES_KEY!.trim(),
    secretAccessKey: env.SPACES_SECRET!.trim(),
    virtualHostedStyle: true,
    publicBase: cdn || endpoint,
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
export function releasePlan(input: { version: string; versionDir: string; latestJson: string; installDir: string; keys: string[]; releaseKeys: string[] }): ReleasePlan {
  const prerelease = input.version.includes('-')
  const missing = input.releaseKeys.filter((key) => !existsSync(join(input.versionDir, binaryName(key))))
  const complete = missing.length === 0
  const objects: UploadObject[] = []

  if (complete) {
    const names = readdirSync(input.versionDir)
      .filter((name) => keyFromBinaryName(name.replace(/\.gz$/, '')))
      .sort()
    for (const name of names) objects.push({ key: `${STORAGE_PREFIX}/v${input.version}/${name}`, type: BINARY, file: join(input.versionDir, name) })
    objects.push({ key: `${STORAGE_PREFIX}/v${input.version}/SHA256SUMS`, type: TEXT, file: join(input.versionDir, 'SHA256SUMS') })
  }
  if (!prerelease) {
    for (const key of input.keys) {
      const file = join(input.versionDir, binaryName(key))
      if (!existsSync(file)) continue
      const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex')
      objects.push({ key: storageKey(key), type: BINARY, file })
      objects.push({ key: `${storageKey(key)}.sha256`, type: TEXT, text: `${sha256}  ${binaryName(key)}\n` })
    }
  }
  if (complete && !prerelease) {
    objects.push({ key: `${STORAGE_PREFIX}/install.sh`, type: TEXT, file: join(input.installDir, 'install.sh') })
    objects.push({ key: `${STORAGE_PREFIX}/install.ps1`, type: TEXT, file: join(input.installDir, 'install.ps1') })
    objects.push({ key: `${STORAGE_PREFIX}/latest.json`, type: 'application/json', file: input.latestJson })
  }

  const note = !complete
    ? `Not every platform is built (missing ${missing.join(', ')}), so the one-line installers and \`zetta upgrade\` keep the release they had. Build them all with \`bun run build all --upload\`.`
    : prerelease
      ? `${input.version} is a prerelease: it is uploaded to ${STORAGE_PREFIX}/v${input.version}/ only. Install it with ZETTA_VERSION=${input.version}.`
      : undefined
  return { objects, installers: complete && !prerelease, ...(note ? { note } : {}) }
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
