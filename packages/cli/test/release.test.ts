import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GitHub, githubToken, type GitHubRelease } from '../../../scripts/github-release'
import { nextVersion, releaseAssets, releaseNotes, withDownloadBase } from '../../../scripts/release'
import { buildMatchers } from '../../../scripts/scan-vendor-names'
import { installMethod, upgradeCommand } from '../src/upgrade'
import { binaryName, latestUrl, RELEASE_REPO, versionUrl } from '../src/upgrade/manifest'
import { knownUpdate, maybeNotifyUpdate, refreshUpdateCheck } from '../src/update-notice'
import { VERSION } from '../src/version'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const RELEASE_KEYS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'linux-x64-musl', 'linux-arm64-musl', 'windows-x64']
const GITHUB = `https://github.com/${RELEASE_REPO}/releases`

/** A dist/ folder with tiny stand-in builds for `keys`, as build-binaries.ts lays it out. */
function dist(version: string, keys: string[] = RELEASE_KEYS) {
  const root = mkdtempSync(join(tmpdir(), 'zrel-'))
  const versionDir = join(root, `v${version}`)
  mkdirSync(versionDir)
  for (const key of keys) {
    writeFileSync(join(versionDir, binaryName(key)), key)
    writeFileSync(join(versionDir, `${binaryName(key)}.gz`), key)
  }
  writeFileSync(join(versionDir, 'SHA256SUMS'), '')
  writeFileSync(join(root, 'latest.json'), JSON.stringify({ version }))
  return { version, versionDir, latestJson: join(root, 'latest.json'), installDir: join(ROOT, 'install'), releaseKeys: RELEASE_KEYS }
}

describe('download addresses', () => {
  it('reads GitHub releases by default: latest/download for the newest, download/v<version> for one version', () => {
    expect(latestUrl(undefined, 'latest.json')).toBe(`${GITHUB}/latest/download/latest.json`)
    expect(versionUrl(undefined, '0.2.0', 'SHA256SUMS')).toBe(`${GITHUB}/download/v0.2.0/SHA256SUMS`)
  })

  it('reads any other address as a plain folder (mirrors, local stand-ins)', () => {
    expect(latestUrl('http://127.0.0.1:4000/cli/', 'latest.json')).toBe('http://127.0.0.1:4000/cli/latest.json')
    expect(versionUrl('http://127.0.0.1:4000/cli', '0.2.0', 'zetta-linux-x64')).toBe('http://127.0.0.1:4000/cli/v0.2.0/zetta-linux-x64')
  })
})

describe('bun run release', () => {
  it('bumps the patch version by default', () => {
    expect(nextVersion('0.1.9', undefined)).toBe('0.1.10')
    expect(nextVersion('0.1.9', 'patch')).toBe('0.1.10')
    expect(nextVersion('0.1.9', 'minor')).toBe('0.2.0')
    expect(nextVersion('0.1.9', 'major')).toBe('1.0.0')
    expect(nextVersion('0.1.9', 'v0.3.0-beta.1')).toBe('0.3.0-beta.1')
    expect(() => nextVersion('0.1.9', 'soon')).toThrow()
  })

  it('publishes every build, SHA256SUMS and the installers, with latest.json last', () => {
    const assets = releaseAssets({ ...dist('0.2.0'), base: GITHUB })
    const names = assets.map((a) => a.name)
    expect(names).toContain('zetta-darwin-arm64')
    expect(names).toContain('zetta-windows-x64.exe.gz')
    expect(names.slice(-4)).toEqual(['SHA256SUMS', 'install.sh', 'install.ps1', 'latest.json'])
    // Windows' `irm … | iex` needs the script as text.
    expect(assets.find((a) => a.name === 'install.ps1')?.type).toMatch(/^text\/plain/)
    expect(assets.find((a) => a.name === 'install.sh')?.text).toContain(`DEFAULT_BASE="${GITHUB}"`)
    expect(assets.find((a) => a.name === 'install.ps1')?.text).toContain(`$DefaultBase = '${GITHUB}'`)
  })

  it('refuses a release that is missing a platform, or whose latest.json is for another version', () => {
    expect(() => releaseAssets({ ...dist('0.2.0', ['darwin-arm64', 'windows-x64']), base: GITHUB })).toThrow(/no build for darwin-x64, linux-x64/)
    const other = dist('0.2.0')
    writeFileSync(other.latestJson, JSON.stringify({ version: '0.1.0' }))
    expect(() => releaseAssets({ ...other, base: GITHUB })).toThrow(/for 0\.1\.0, not 0\.2\.0/)
  })

  it('points the installers at the release, and fails loudly if their address line is renamed', () => {
    const base = 'http://zetta.localhost:4000/o/r/releases'
    expect(withDownloadBase(readFileSync(join(ROOT, 'install', 'install.sh'), 'utf8'), base)).toContain(`DEFAULT_BASE="${base}"`)
    expect(withDownloadBase(readFileSync(join(ROOT, 'install', 'install.ps1'), 'utf8'), base)).toContain(`$DefaultBase = '${base}'`)
    expect(() => withDownloadBase('#!/bin/sh\necho hi\n', base)).toThrow(/default download address/)
  })

  it('ships installers that already download from the GitHub releases', () => {
    expect(readFileSync(join(ROOT, 'install', 'install.sh'), 'utf8')).toContain(`DEFAULT_BASE="${GITHUB}"`)
    expect(readFileSync(join(ROOT, 'install', 'install.ps1'), 'utf8')).toContain(`$DefaultBase = '${GITHUB}'`)
  })

  it('writes release notes with the install lines and the changes, leaving out any line naming a vendor', () => {
    const vendor = buildMatchers(['acmevendor']).text
    const notes = releaseNotes('0.2.0', ['Faster uploads', 'Switch to AcmeVendor v3'], vendor)
    expect(notes).toContain('curl -fsSL https://zetta3d.ai/install.sh | sh')
    expect(notes).toContain('irm https://zetta3d.ai/install.ps1 | iex')
    expect(notes).toContain('- Faster uploads')
    expect(notes).not.toMatch(/acmevendor/i)
    expect(releaseNotes('0.1.0', [])).toContain('First release')
  })
})

describe('publishing to GitHub', () => {
  const draft: GitHubRelease = {
    id: 7,
    tag_name: 'v0.2.0',
    draft: true,
    prerelease: false,
    html_url: 'https://github.com/o/r/releases/tag/v0.2.0',
    upload_url: 'https://uploads.example/repos/o/r/releases/7/assets{?name,label}',
    assets: [],
  }

  function fakeGitHub(answer: (method: string, url: string) => Response) {
    const calls: Array<{ method: string; url: string; headers: Record<string, string>; body?: unknown }> = []
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET'
      calls.push({ method, url: String(url), headers: init.headers as Record<string, string>, body: init.body })
      return answer(method, String(url))
    }) as typeof fetch
    return { github: new GitHub('o/r', 'secret-token', 'https://api.example', fetchImpl), calls }
  }
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

  it('takes the token from GITHUB_TOKEN or GH_TOKEN, and says where it came from', () => {
    expect(githubToken({ GITHUB_TOKEN: ' abc ' })).toEqual({ token: 'abc', source: 'GITHUB_TOKEN' })
    expect(githubToken({ GH_TOKEN: 'def' })).toEqual({ token: 'def', source: 'GH_TOKEN' })
  })

  it('creates a draft, uploads each file under its name and type, then publishes it as latest', async () => {
    const { github, calls } = fakeGitHub((method, url) => {
      if (method === 'POST' && url.endsWith('/releases')) return json(draft, 201)
      if (method === 'POST' && url.startsWith('https://uploads.example/')) return json({ id: 1 }, 201)
      if (method === 'PATCH') return json({ ...draft, draft: false })
      return json({}, 404)
    })
    const release = await github.createDraft({ tag: 'v0.2.0', name: 'zetta 0.2.0', body: 'notes', prerelease: false })
    expect(await github.upload(release, { name: 'install.ps1', type: 'text/plain; charset=utf-8', text: 'Write-Host hi' })).toBe('uploaded')
    const published = await github.publish(release)
    expect(published.draft).toBe(false)
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://api.example/repos/o/r/releases' })
    expect(JSON.parse(calls[0]!.body as string)).toMatchObject({ tag_name: 'v0.2.0', draft: true, prerelease: false })
    expect(calls[1]).toMatchObject({ method: 'POST', url: 'https://uploads.example/repos/o/r/releases/7/assets?name=install.ps1' })
    expect(calls[1]!.headers).toMatchObject({ 'content-type': 'text/plain; charset=utf-8', 'content-length': '13', authorization: 'Bearer secret-token' })
    expect(JSON.parse(calls[2]!.body as string)).toEqual({ draft: false, make_latest: 'true' })
  })

  it('never makes a prerelease "latest"', async () => {
    const { github, calls } = fakeGitHub(() => json({ ...draft, prerelease: true, draft: false }))
    await github.publish({ ...draft, prerelease: true })
    expect(JSON.parse(calls[0]!.body as string)).toEqual({ draft: false, make_latest: 'false' })
  })

  it('skips a file already uploaded, and replaces a broken one', async () => {
    const { github, calls } = fakeGitHub((method) => (method === 'DELETE' ? new Response(null, { status: 204 }) : json({ id: 2 }, 201)))
    const release = {
      ...draft,
      assets: [
        { id: 5, name: 'SHA256SUMS', size: 3, state: 'uploaded' },
        { id: 6, name: 'latest.json', size: 9, state: 'starter' },
      ],
    }
    expect(await github.upload(release, { name: 'SHA256SUMS', type: 'text/plain', text: 'abc' })).toBe('unchanged')
    expect(calls).toHaveLength(0)
    expect(await github.upload(release, { name: 'latest.json', type: 'application/json', text: '{}' })).toBe('uploaded')
    expect(calls.map((c) => c.method)).toEqual(['DELETE', 'POST'])
    expect(calls[0]!.url).toBe('https://api.example/repos/o/r/releases/assets/6')
  })

  it('explains a token that cannot write, without printing the token', async () => {
    const { github } = fakeGitHub(() => json({ message: 'Resource not accessible by personal access token' }, 403))
    const error = await github.createDraft({ tag: 'v0.2.0', name: 'zetta 0.2.0', body: '', prerelease: false }).catch((e: Error) => e)
    expect((error as Error).message).toMatch(/HTTP 403 Resource not accessible.*cannot write to this repository/)
    expect((error as Error).message).not.toContain('secret-token')
  })

  it('finds the newest published version, and none before the first release', async () => {
    expect(await fakeGitHub(() => json({ tag_name: 'v0.3.1' })).github.latestVersion()).toBe('0.3.1')
    expect(await fakeGitHub(() => json({ message: 'Not Found' }, 404)).github.latestVersion()).toBeUndefined()
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

describe('the update prompt', () => {
  const newer = '99.0.0'
  const manifest = (version: string) => async () => ({ version, released: '2026-11-27T00:00:00.000Z', files: {} })
  const freshEnv = () => ({ ZETTA_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'zupd-')) })
  // Tests run from source; an installed copy upgrades with `zetta upgrade`.
  const installed = { terminal: true, compiled: true, upgradeWith: 'zetta upgrade', fetchLatest: manifest(newer) }

  it('finds a new release, remembers it for an hour, and knows how to update', async () => {
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

  it('asks a person at a terminal, and upgrades on yes (Enter counts as yes)', async () => {
    for (const answer of ['', 'y', 'Yes']) {
      const lines: string[] = []
      const questions: string[] = []
      let upgraded = 0
      await maybeNotifyUpdate(freshEnv(), {
        ...installed,
        interactive: true,
        write: (t) => lines.push(t),
        ask: async (q) => {
          questions.push(q)
          return answer
        },
        upgrade: async (progress) => {
          upgraded++
          progress('Checksum verified.')
          return { to: newer, upgraded: true }
        },
      })
      expect(questions[0]).toContain(`zetta ${newer} is out (you have ${VERSION}). Update now? [Y/n]`)
      expect(upgraded).toBe(1)
      expect(lines.join('')).toContain('Checksum verified.')
      expect(lines.join('')).toContain(`Updated to zetta ${newer}.`)
    }
  })

  it('on no, says how to update later, and does not ask again for a while', async () => {
    const env = freshEnv()
    const lines: string[] = []
    let asked = 0
    const options = {
      ...installed,
      interactive: true,
      write: (t: string) => lines.push(t),
      ask: async () => {
        asked++
        return 'n'
      },
      upgrade: async (): Promise<{ to: string; upgraded: boolean }> => {
        throw new Error('should not upgrade')
      },
    }
    await maybeNotifyUpdate(env, options)
    await maybeNotifyUpdate(env, options)
    expect(asked).toBe(1)
    expect(lines.join('')).toContain('Update any time with: zetta upgrade')
  })

  it('says what went wrong when the upgrade fails, and how to retry', async () => {
    const lines: string[] = []
    await maybeNotifyUpdate(freshEnv(), {
      ...installed,
      interactive: true,
      write: (t) => lines.push(t),
      ask: async () => 'y',
      upgrade: async () => {
        throw new Error('Checksum mismatch')
      },
    })
    expect(lines.join('')).toContain('Could not update: Checksum mismatch')
    expect(lines.join('')).toContain('Try again later with: zetta upgrade')
  })

  it('only prints the command when nobody can answer, or when a package manager owns this copy', async () => {
    const ask = async (): Promise<string> => {
      throw new Error('should not ask')
    }
    for (const [interactive, upgradeWith] of [
      [false, 'zetta upgrade'],
      [true, 'brew upgrade zetta'],
    ] as const) {
      const lines: string[] = []
      await maybeNotifyUpdate(freshEnv(), { ...installed, interactive, upgradeWith, ask, write: (t) => lines.push(t) })
      expect(lines.join('')).toContain(`zetta ${newer} is out (you have ${VERSION}). Update with: ${upgradeWith}`)
    }
  })

  it('says nothing when output is piped, when this is the latest version, or when offline', async () => {
    const lines: string[] = []
    const write = (t: string) => lines.push(t)
    await maybeNotifyUpdate(freshEnv(), { ...installed, terminal: false, write })
    await maybeNotifyUpdate(freshEnv(), { ...installed, fetchLatest: manifest(VERSION), write })
    await maybeNotifyUpdate(freshEnv(), { ...installed, fetchLatest: async () => Promise.reject(new Error('offline')), write })
    expect(lines).toEqual([])
  })
})
