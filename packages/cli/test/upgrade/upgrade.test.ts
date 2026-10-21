import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  cleanupOldBinaries,
  fetchLatest,
  isCompiledBinary,
  replaceExecutable,
  upgradeSelf,
  type LatestManifest,
} from '../../src/upgrade/index'

const BASE = 'https://downloads.example.test/cli'
const KEY = 'linux-x64'
const NAME = 'zetta-linux-x64'
const posix = process.platform !== 'win32'

/** A stand-in "binary": a shell script on POSIX so the --version test-run works. */
function fakeBinary(version: string, exitCode = 0): Buffer {
  return Buffer.from(`#!/bin/sh\necho "zetta ${version}"\nexit ${exitCode}\n`)
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

type Routes = Record<string, () => Response>

function fakeFetch(routes: Routes): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = []
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push(url)
    const route = routes[url]
    return route ? route() : new Response('not found', { status: 404 })
  }) as typeof fetch
  return { fetchImpl, calls }
}

function release(version: string, bin: Buffer, opts: { sha?: string; size?: number } = {}): Routes {
  const manifest: LatestManifest = {
    version,
    released: '2026-10-21T00:00:00.000Z',
    files: { [KEY]: { name: NAME, sha256: opts.sha ?? sha256(bin), size: opts.size ?? bin.length } },
  }
  return {
    [`${BASE}/latest.json`]: () => Response.json(manifest),
    [`${BASE}/v${version}/SHA256SUMS`]: () => new Response(`${opts.sha ?? sha256(bin)}  ${NAME}\n`),
    [`${BASE}/v${version}/${NAME}`]: () => new Response(new Uint8Array(bin)),
  }
}

let dir: string
let exe: string
const OLD = Buffer.from('old binary')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zetta-upgrade-test-'))
  exe = join(dir, 'zetta')
  writeFileSync(exe, OLD, { mode: 0o755 })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function leftovers(): string[] {
  return readdirSync(dir).filter((n) => n !== 'zetta')
}

describe('fetchLatest', () => {
  const saved = process.env.ZETTA_DOWNLOAD_BASE
  afterEach(() => {
    if (saved === undefined) delete process.env.ZETTA_DOWNLOAD_BASE
    else process.env.ZETTA_DOWNLOAD_BASE = saved
  })

  it('reads latest.json from ZETTA_DOWNLOAD_BASE by default', async () => {
    process.env.ZETTA_DOWNLOAD_BASE = `${BASE}/`
    const { fetchImpl, calls } = fakeFetch(release('0.2.0', fakeBinary('0.2.0')))
    const m = await fetchLatest(undefined, fetchImpl)
    expect(m.version).toBe('0.2.0')
    expect(m.files[KEY]?.name).toBe(NAME)
    expect(calls).toEqual([`${BASE}/latest.json`])
  })

  it('explains HTTP errors, network errors and bad JSON', async () => {
    await expect(fetchLatest(BASE, fakeFetch({}).fetchImpl)).rejects.toThrow(/HTTP 404 for .*latest\.json/)
    const offline = (async () => {
      throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND') })
    }) as unknown as typeof fetch
    await expect(fetchLatest(BASE, offline)).rejects.toThrow(/Could not reach .*ENOTFOUND.*internet connection/)
    const notJson = fakeFetch({ [`${BASE}/latest.json`]: () => new Response('<html>') })
    await expect(fetchLatest(BASE, notJson.fetchImpl)).rejects.toThrow(/not valid JSON/)
    const wrongShape = fakeFetch({ [`${BASE}/latest.json`]: () => Response.json({ version: '1.0.0' }) })
    await expect(fetchLatest(BASE, wrongShape.fetchImpl)).rejects.toThrow(/"files" is missing/)
  })
})

describe('upgradeSelf', () => {
  const common = { base: BASE, platform: KEY, currentVersion: '0.1.0' }

  it('downloads, verifies and swaps in the latest release', async () => {
    const bin = fakeBinary('0.2.0')
    const { fetchImpl } = fakeFetch(release('0.2.0', bin))
    const progress: string[] = []
    const result = await upgradeSelf({
      ...common,
      execPath: exe,
      fetchImpl,
      verifyRun: posix,
      onProgress: (m) => progress.push(m),
    })
    expect(result).toMatchObject({ from: '0.1.0', to: '0.2.0', upgraded: true })
    expect(readFileSync(exe)).toEqual(bin)
    if (posix) expect(statSync(exe).mode & 0o111).not.toBe(0)
    expect(leftovers()).toEqual([])
    expect(progress.join('\n')).toMatch(/Checksum verified/)
  })

  it('does nothing when already on the latest version', async () => {
    const { fetchImpl, calls } = fakeFetch(release('0.1.0', fakeBinary('0.1.0')))
    const result = await upgradeSelf({ ...common, execPath: exe, fetchImpl })
    expect(result).toMatchObject({ from: '0.1.0', to: '0.1.0', upgraded: false })
    expect(calls).toEqual([`${BASE}/latest.json`])
    expect(readFileSync(exe)).toEqual(OLD)
  })

  it('does not downgrade to an older "latest"', async () => {
    const { fetchImpl } = fakeFetch(release('0.0.9', fakeBinary('0.0.9')))
    const result = await upgradeSelf({ ...common, execPath: exe, fetchImpl })
    expect(result.upgraded).toBe(false)
    expect(readFileSync(exe)).toEqual(OLD)
  })

  it('rejects a checksum mismatch and leaves the old binary alone', async () => {
    const bin = fakeBinary('0.2.0')
    const { fetchImpl } = fakeFetch(release('0.2.0', bin, { sha: 'f'.repeat(64) }))
    await expect(upgradeSelf({ ...common, execPath: exe, fetchImpl, verifyRun: false })).rejects.toThrow(
      /Checksum mismatch for zetta-linux-x64.*Nothing was changed/,
    )
    expect(readFileSync(exe)).toEqual(OLD)
    expect(leftovers()).toEqual([])
  })

  it('rejects a truncated download', async () => {
    const bin = fakeBinary('0.2.0')
    const { fetchImpl } = fakeFetch(release('0.2.0', bin, { size: bin.length + 10 }))
    await expect(upgradeSelf({ ...common, execPath: exe, fetchImpl, verifyRun: false })).rejects.toThrow(/expected \d+/)
    expect(readFileSync(exe)).toEqual(OLD)
    expect(leftovers()).toEqual([])
  })

  it.skipIf(!posix)('keeps the old binary when the new one does not run', async () => {
    const bin = fakeBinary('0.2.0', 3)
    const { fetchImpl } = fakeFetch(release('0.2.0', bin))
    await expect(upgradeSelf({ ...common, execPath: exe, fetchImpl })).rejects.toThrow(/does not run on this system/)
    expect(readFileSync(exe)).toEqual(OLD)
    expect(leftovers()).toEqual([])
  })

  it('installs a pinned version using its SHA256SUMS, even an older one', async () => {
    const bin = fakeBinary('0.0.5')
    const { fetchImpl, calls } = fakeFetch(release('0.0.5', bin))
    const result = await upgradeSelf({ ...common, version: 'v0.0.5', execPath: exe, fetchImpl, verifyRun: false })
    expect(result).toMatchObject({ from: '0.1.0', to: '0.0.5', upgraded: true })
    expect(readFileSync(exe)).toEqual(bin)
    expect(calls).not.toContain(`${BASE}/latest.json`)
  })

  it('says so when a pinned version does not exist', async () => {
    const { fetchImpl } = fakeFetch({})
    await expect(upgradeSelf({ ...common, version: '9.9.9', execPath: exe, fetchImpl })).rejects.toThrow(
      /zetta 9\.9\.9 was not found on https:\/\/downloads\.example\.test\/cli/,
    )
  })

  it('says so when the release has no build for this platform', async () => {
    const { fetchImpl } = fakeFetch(release('0.2.0', fakeBinary('0.2.0')))
    await expect(upgradeSelf({ ...common, platform: 'linux-arm64-musl', execPath: exe, fetchImpl })).rejects.toThrow(
      /no build for linux-arm64-musl/,
    )
  })

  it('refuses to run from source under bun or node', async () => {
    for (const runner of ['/home/me/.bun/bin/bun', 'C:\\Program Files\\nodejs\\node.exe', '/usr/bin/node']) {
      expect(isCompiledBinary(runner)).toBe(false)
      await expect(upgradeSelf({ ...common, execPath: runner, fetchImpl: fakeFetch({}).fetchImpl })).rejects.toThrow(
        /only works on an installed zetta binary/,
      )
    }
    expect(isCompiledBinary('/home/me/.zetta/bin/zetta')).toBe(true)
    expect(isCompiledBinary('C:\\Users\\me\\AppData\\Local\\zetta\\bin\\zetta.exe')).toBe(true)
  })
})

describe('replaceExecutable (Windows strategy)', () => {
  it('parks the running exe as .old, swaps in the new one, and cleanup removes the .old', () => {
    const target = join(dir, 'zetta.exe')
    const next = join(dir, 'next.exe')
    writeFileSync(target, 'v1')
    writeFileSync(next, 'v2')
    writeFileSync(`${target}.old`, 'stale')
    replaceExecutable(next, target, true)
    expect(readFileSync(target, 'utf8')).toBe('v2')
    expect(existsSync(next)).toBe(false)
    // Not running here, so the .old is removed straight away.
    expect(existsSync(`${target}.old`)).toBe(false)

    writeFileSync(`${target}.123.old`, 'left behind')
    cleanupOldBinaries(target)
    expect(readdirSync(dir).sort()).toEqual(['zetta', 'zetta.exe'])
  })

  it('works when there is no existing binary', () => {
    const target = join(dir, 'fresh.exe')
    const next = join(dir, 'next.exe')
    writeFileSync(next, 'v2')
    replaceExecutable(next, target, true)
    expect(readFileSync(target, 'utf8')).toBe('v2')
  })
})
