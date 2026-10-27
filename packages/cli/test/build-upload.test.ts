import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { binaryName } from '../src/upgrade/manifest'
import { releasePlan, spacesConfig, storageKey } from '../../../scripts/upload-spaces'

const RELEASE_KEYS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'linux-x64-musl', 'linux-arm64-musl', 'windows-x64']

/** A dist/ folder with tiny stand-in binaries for `keys`, as build-binaries.ts lays it out. */
function dist(version: string, keys: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'zup-'))
  const versionDir = join(root, `v${version}`)
  mkdirSync(versionDir)
  for (const key of keys) {
    writeFileSync(join(versionDir, binaryName(key)), key)
    writeFileSync(join(versionDir, `${binaryName(key)}.gz`), key)
  }
  writeFileSync(join(versionDir, 'SHA256SUMS'), '')
  writeFileSync(join(root, 'latest.json'), '{}')
  return { version, versionDir, latestJson: join(root, 'latest.json'), installDir: join(root, 'install'), releaseKeys: RELEASE_KEYS }
}

describe('bun run build --upload', () => {
  it('puts each build in its OS folder under zcli/', () => {
    expect(['darwin-arm64', 'darwin-x64-baseline', 'windows-x64', 'linux-x64', 'linux-arm64-musl'].map(storageKey)).toEqual([
      'zcli/macosx/zetta-darwin-arm64',
      'zcli/macosx/zetta-darwin-x64-baseline',
      'zcli/windows/zetta-windows-x64.exe',
      'zcli/linux/zetta-linux-x64',
      'zcli/linux/zetta-linux-arm64-musl',
    ])
  })

  it('reads the backend’s SPACES_* settings, with the bucket in the hostname', () => {
    const env = { SPACES_KEY: 'k', SPACES_SECRET: 's', SPACES_BUCKET: 'zetta-prod', SPACES_ENDPOINT: 'https://sfo3.digitaloceanspaces.com' }
    expect(spacesConfig(env)).toMatchObject({ bucket: 'zetta-prod', endpoint: 'https://zetta-prod.sfo3.digitaloceanspaces.com', region: 'us-east-1', virtualHostedStyle: true, publicBase: 'https://zetta-prod.sfo3.digitaloceanspaces.com' })
    expect(spacesConfig({ ...env, SPACES_ENDPOINT: 'zetta-prod.sfo3.digitaloceanspaces.com' }).endpoint).toBe('https://zetta-prod.sfo3.digitaloceanspaces.com')
    expect(spacesConfig({ ...env, SPACES_REGION: 'sfo3', SPACES_CDN_ENDPOINT: 'https://cdn.example.com/' })).toMatchObject({ region: 'sfo3', publicBase: 'https://cdn.example.com' })
  })

  it('names what is missing, never the values it has', () => {
    let message = ''
    try {
      spacesConfig({ SPACES_KEY: 'key-value-123', SPACES_ENDPOINT: 'https://sfo3.digitaloceanspaces.com' })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('SPACES_SECRET, SPACES_BUCKET')
    expect(message).not.toContain('key-value-123')
  })

  it('publishes a full build in a safe order, with latest.json last', () => {
    const plan = releasePlan({ ...dist('0.2.0', RELEASE_KEYS), keys: RELEASE_KEYS })
    const keys = plan.objects.map((o) => o.key)
    expect(plan.installers).toBe(true)
    expect(keys[0]).toMatch(/^zcli\/v0\.2\.0\//)
    expect(keys).toContain('zcli/v0.2.0/zetta-windows-x64.exe.gz')
    expect(keys).toContain('zcli/v0.2.0/SHA256SUMS')
    expect(keys).toContain('zcli/macosx/zetta-darwin-arm64')
    expect(keys).toContain('zcli/macosx/zetta-darwin-arm64.sha256')
    expect(keys.slice(-3)).toEqual(['zcli/install.sh', 'zcli/install.ps1', 'zcli/latest.json'])
    expect(keys.indexOf('zcli/v0.2.0/SHA256SUMS')).toBeLessThan(keys.indexOf('zcli/macosx/zetta-darwin-arm64'))
  })

  it('never touches the installers’ files for a partial build', () => {
    const plan = releasePlan({ ...dist('0.2.0', ['windows-x64']), keys: ['windows-x64'] })
    expect(plan.installers).toBe(false)
    expect(plan.objects.map((o) => o.key)).toEqual(['zcli/windows/zetta-windows-x64.exe', 'zcli/windows/zetta-windows-x64.exe.sha256'])
    expect(plan.note).toContain('missing darwin-arm64')
  })

  it('keeps a prerelease out of latest.json and the per-OS folders', () => {
    const plan = releasePlan({ ...dist('0.3.0-beta.1', RELEASE_KEYS), keys: RELEASE_KEYS })
    expect(plan.installers).toBe(false)
    expect(plan.objects.every((o) => o.key.startsWith('zcli/v0.3.0-beta.1/'))).toBe(true)
    expect(plan.note).toContain('ZETTA_VERSION=0.3.0-beta.1')
  })
})
