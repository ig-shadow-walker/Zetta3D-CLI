import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { nextVersion, stageUpload } from '../../../scripts/release'
import { publicLocation, releasePlan, spacesConfig, withDownloadBase } from '../../../scripts/upload-spaces'
import { installMethod, upgradeCommand } from '../src/upgrade'
import { binaryName } from '../src/upgrade/manifest'
import { knownUpdate, maybeNotifyUpdate, refreshUpdateCheck } from '../src/update-notice'
import { VERSION } from '../src/version'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const SPACES = { SPACES_KEY: 'k', SPACES_SECRET: 's', SPACES_BUCKET: 'my-bucket', SPACES_ENDPOINT: 'https://sfo3.digitaloceanspaces.com' }

describe('bun run release', () => {
  it('works out the next version', () => {
    expect(nextVersion('0.1.9', 'patch')).toBe('0.1.10')
    expect(nextVersion('0.1.9', 'minor')).toBe('0.2.0')
    expect(nextVersion('0.1.9', 'major')).toBe('1.0.0')
    expect(nextVersion('0.1.9', 'v0.3.0-beta.1')).toBe('0.3.0-beta.1')
    expect(nextVersion('0.1.9', undefined)).toBe('0.1.9')
    expect(() => nextVersion('0.1.9', 'soon')).toThrow()
  })

  it('publishes into SPACES_FOLDER, or to your own domain with ZETTA_PUBLIC_BASE', () => {
    expect(spacesConfig(SPACES)).toMatchObject({ folder: 'zcli', downloadBase: 'https://my-bucket.sfo3.digitaloceanspaces.com/zcli' })
    expect(spacesConfig({ ...SPACES, SPACES_FOLDER: '/tools/zetta-cli/', SPACES_CDN_ENDPOINT: 'https://my-bucket.sfo3.cdn.digitaloceanspaces.com' })).toMatchObject({
      folder: 'tools/zetta-cli',
      downloadBase: 'https://my-bucket.sfo3.cdn.digitaloceanspaces.com/tools/zetta-cli',
    })
    expect(spacesConfig({ ...SPACES, ZETTA_PUBLIC_BASE: 'https://downloads.zetta3d.ai/zcli/' }).downloadBase).toBe('https://downloads.zetta3d.ai/zcli')
    expect(() => spacesConfig({ ...SPACES, SPACES_FOLDER: 'a b' })).toThrow(/not a folder name/)
    expect(() => spacesConfig({ ...SPACES, ZETTA_PUBLIC_BASE: 'http://insecure.example' })).toThrow(/https/)
  })

  it('uploads installers that download from where the release lives', () => {
    const base = 'https://my-bucket.sfo3.cdn.digitaloceanspaces.com/zcli'
    const sh = withDownloadBase(readFileSync(join(ROOT, 'install', 'install.sh'), 'utf8'), base)
    expect(sh).toContain(`DEFAULT_BASE="${base}"`)
    expect(sh).not.toContain('downloads.zetta3d.ai/zcli"')
    const ps1 = withDownloadBase(readFileSync(join(ROOT, 'install', 'install.ps1'), 'utf8'), base)
    expect(ps1).toContain(`$DefaultBase = '${base}'`)
    expect(() => withDownloadBase('#!/bin/sh\necho hi\n', base)).toThrow(/default download address/)

    const dist = mkdtempSync(join(tmpdir(), 'zrel-'))
    const versionDir = join(dist, 'v0.2.0')
    mkdirSync(versionDir)
    const keys = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'linux-x64-musl', 'linux-arm64-musl', 'windows-x64']
    for (const key of keys) writeFileSync(join(versionDir, binaryName(key)), key)
    writeFileSync(join(versionDir, 'SHA256SUMS'), '')
    writeFileSync(join(dist, 'latest.json'), '{}')
    const plan = releasePlan({ version: '0.2.0', versionDir, latestJson: join(dist, 'latest.json'), installDir: join(ROOT, 'install'), keys, releaseKeys: keys, folder: 'tools/zetta-cli', downloadBase: base })
    expect(plan.objects.every((o) => o.key.startsWith('tools/zetta-cli/'))).toBe(true)
    expect(plan.objects.find((o) => o.key === 'tools/zetta-cli/install.sh')?.text).toContain(`DEFAULT_BASE="${base}"`)
    expect(plan.objects.at(-1)?.key).toBe('tools/zetta-cli/latest.json')
  })
})

describe('a release you upload yourself', () => {
  it('knows its download address without any keys', () => {
    expect(publicLocation({}, { base: 'https://my-bucket.sfo3.digitaloceanspaces.com/zcli/' })).toEqual({ folder: 'zcli', downloadBase: 'https://my-bucket.sfo3.digitaloceanspaces.com/zcli' })
    expect(publicLocation({ SPACES_BUCKET: 'my-bucket', SPACES_ENDPOINT: 'https://sfo3.digitaloceanspaces.com', SPACES_FOLDER: 'cli' })).toEqual({
      folder: 'cli',
      downloadBase: 'https://my-bucket.sfo3.digitaloceanspaces.com/cli',
    })
    expect(() => publicLocation({})).toThrow(/--base/)
    expect(() => publicLocation({}, { base: 'http://example.com/zcli' })).toThrow(/https/)
    expect(publicLocation({}, { base: 'http://zetta.localhost:4000/zcli' }).downloadBase).toBe('http://zetta.localhost:4000/zcli')
  })

  it('stages everything but latest.json to upload first, and latest.json on its own', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zstage-'))
    writeFileSync(join(dir, 'zetta-linux-x64'), 'binary')
    const stage = join(dir, 'upload')
    const staged = stageUpload(
      [
        { key: 'zcli/v0.2.0/zetta-linux-x64', type: 'application/octet-stream', file: join(dir, 'zetta-linux-x64') },
        { key: 'zcli/install.sh', type: 'text/plain', text: 'DEFAULT_BASE="x"' },
        { key: 'zcli/latest.json', type: 'application/json', text: '{"version":"0.2.0"}' },
      ],
      stage,
      'zcli',
    )
    expect(readFileSync(join(stage, '1-upload-first', 'zcli', 'v0.2.0', 'zetta-linux-x64'), 'utf8')).toBe('binary')
    expect(readFileSync(join(stage, '1-upload-first', 'zcli', 'install.sh'), 'utf8')).toBe('DEFAULT_BASE="x"')
    expect(existsSync(join(stage, '1-upload-first', 'zcli', 'latest.json'))).toBe(false)
    expect(staged.last).toBe(join(stage, '2-upload-last', 'zcli', 'latest.json'))
    expect(readFileSync(staged.last, 'utf8')).toContain('0.2.0')
  })
})

describe('upgrading', () => {
  it('uses the package manager that installed zetta', () => {
    expect(installMethod('/Users/me/.zetta/bin/zetta')).toBe('binary')
    expect(installMethod('/opt/homebrew/Cellar/zetta/0.2.0/bin/zetta')).toBe('homebrew')
    expect(installMethod('/usr/local/lib/node_modules/@zetta3d/cli-darwin-arm64/bin/zetta')).toBe('npm')
    expect(installMethod('/usr/local/bin/bun')).toBe('source')
    expect(upgradeCommand('binary')).toBe('zetta upgrade')
    expect(upgradeCommand('homebrew')).toBe('brew upgrade zetta')
    expect(upgradeCommand('npm')).toBe('npm install -g @zetta3d/cli@latest')
  })
})

describe('the update notice', () => {
  const newer = '99.0.0'
  const manifest = (version: string) => async () => ({ version, released: '2026-11-26T00:00:00.000Z', files: {} })
  const freshEnv = () => ({ ZETTA_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'zupd-')) })

  it('finds a new release, remembers it for an hour, and says how to update', async () => {
    const env = freshEnv()
    let fetched = 0
    const fetchLatest = async () => {
      fetched++
      return manifest(newer)()
    }
    expect(await refreshUpdateCheck(env, fetchLatest, true)).toMatchObject({ current: VERSION, latest: newer, upgradeWith: expect.any(String) })
    expect(await refreshUpdateCheck(env, fetchLatest, true)).toMatchObject({ latest: newer })
    expect(fetched).toBe(1)
    expect(knownUpdate(env, true)?.latest).toBe(newer)
    expect(knownUpdate(env, false)).toBeUndefined() // running from source: no checks
    expect(await refreshUpdateCheck({ ...env, ZETTA_NO_UPDATE_CHECK: '1' }, fetchLatest, true)).toBeUndefined()
  })

  it('tells a person at a terminal once, then not again for a while', async () => {
    const env = freshEnv()
    const lines: string[] = []
    const options = { write: (text: string) => lines.push(text), terminal: true, compiled: true, fetchLatest: manifest(newer) }
    await maybeNotifyUpdate(env, options)
    await maybeNotifyUpdate(env, options)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(`zetta ${newer} is out (you have ${VERSION})`)
    await maybeNotifyUpdate(freshEnv(), { ...options, terminal: false })
    expect(lines).toHaveLength(1)
  })

  it('says nothing when this is the latest version, or when offline', async () => {
    const lines: string[] = []
    await maybeNotifyUpdate(freshEnv(), { write: (t) => lines.push(t), terminal: true, compiled: true, fetchLatest: manifest(VERSION) })
    await maybeNotifyUpdate(freshEnv(), { write: (t) => lines.push(t), terminal: true, compiled: true, fetchLatest: async () => Promise.reject(new Error('offline')) })
    expect(lines).toEqual([])
  })
})
