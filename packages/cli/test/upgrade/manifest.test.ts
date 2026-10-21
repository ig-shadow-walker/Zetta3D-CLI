import { afterEach, describe, expect, it } from 'vitest'
import {
  binaryName,
  compareVersions,
  DEFAULT_DOWNLOAD_BASE,
  downloadBase,
  formatChecksums,
  keyFromBinaryName,
  normalizeVersion,
  parseChecksums,
  parseManifest,
} from '../../src/upgrade/manifest'

const SHA = 'a'.repeat(64)

describe('compareVersions', () => {
  it.each([
    ['1.0.0', '1.0.0', 0],
    ['1.0.1', '1.0.0', 1],
    ['1.0.0', '1.0.1', -1],
    ['v1.2.3', '1.2.3', 0],
    ['1.10.0', '1.9.9', 1],
    ['2.0.0', '1.99.99', 1],
    ['1.0.0-beta', '1.0.0', -1],
    ['1.0.0', '1.0.0-rc.1', 1],
    ['1.0.0-alpha', '1.0.0-alpha.1', -1],
    ['1.0.0-alpha.1', '1.0.0-alpha.beta', -1],
    ['1.0.0-beta.2', '1.0.0-beta.11', -1],
    ['1.0.0-beta.11', '1.0.0-rc.1', -1],
    ['1.0.0+build.7', '1.0.0', 0],
  ])('%s vs %s -> %d', (a, b, want) => {
    expect(compareVersions(a, b)).toBe(want)
  })

  it('rejects things that are not versions', () => {
    expect(() => compareVersions('latest', '1.0.0')).toThrow(/Not a valid version/)
    expect(() => compareVersions('1.0', '1.0.0')).toThrow(/Not a valid version/)
  })

  it('normalizes a leading v', () => {
    expect(normalizeVersion('v0.3.0-beta.1')).toBe('0.3.0-beta.1')
  })
})

describe('file names', () => {
  it('maps keys to file names and back', () => {
    expect(binaryName('darwin-arm64')).toBe('zetta-darwin-arm64')
    expect(binaryName('linux-x64-musl')).toBe('zetta-linux-x64-musl')
    expect(binaryName('windows-x64')).toBe('zetta-windows-x64.exe')
    expect(keyFromBinaryName('zetta-linux-arm64-musl')).toBe('linux-arm64-musl')
    expect(keyFromBinaryName('zetta-linux-x64-musl-baseline')).toBe('linux-x64-musl-baseline')
    expect(keyFromBinaryName('zetta-windows-x64.exe')).toBe('windows-x64')
    expect(keyFromBinaryName('zetta-windows-x64')).toBeUndefined()
    expect(keyFromBinaryName('zetta-linux-x64.exe')).toBeUndefined()
    expect(keyFromBinaryName('SHA256SUMS')).toBeUndefined()
  })
})

describe('downloadBase', () => {
  const saved = process.env.ZETTA_DOWNLOAD_BASE
  afterEach(() => {
    if (saved === undefined) delete process.env.ZETTA_DOWNLOAD_BASE
    else process.env.ZETTA_DOWNLOAD_BASE = saved
  })

  it('prefers the argument, then the env var, then the default, without trailing slashes', () => {
    delete process.env.ZETTA_DOWNLOAD_BASE
    expect(downloadBase()).toBe(DEFAULT_DOWNLOAD_BASE)
    process.env.ZETTA_DOWNLOAD_BASE = 'http://127.0.0.1:9/cli/'
    expect(downloadBase()).toBe('http://127.0.0.1:9/cli')
    expect(downloadBase('https://mirror.test/x//')).toBe('https://mirror.test/x')
    process.env.ZETTA_DOWNLOAD_BASE = '  '
    expect(downloadBase()).toBe(DEFAULT_DOWNLOAD_BASE)
  })
})

describe('parseManifest', () => {
  it('accepts the build script format', () => {
    const m = parseManifest(
      {
        version: '0.2.0',
        released: '2026-10-21T00:00:00.000Z',
        files: { 'darwin-arm64': { name: 'zetta-darwin-arm64', sha256: SHA.toUpperCase(), size: 12 } },
      },
      'test',
    )
    expect(m.version).toBe('0.2.0')
    expect(m.files['darwin-arm64']).toEqual({ name: 'zetta-darwin-arm64', sha256: SHA, size: 12 })
  })

  it.each([
    [null, /not a JSON object/],
    [{ files: {} }, /"version" is missing/],
    [{ version: 'next', files: {} }, /not semver/],
    [{ version: '1.0.0' }, /"files" is missing/],
    [{ version: '1.0.0', files: { k: { name: 'zetta-k', sha256: 'abc' } } }, /64-character/],
    [{ version: '1.0.0', files: { k: { name: '../zetta', sha256: SHA } } }, /unsafe file name/],
  ])('rejects %j', (data, err) => {
    expect(() => parseManifest(data, 'https://x.test/latest.json')).toThrow(err)
  })
})

describe('checksums', () => {
  it('round-trips the sha256sum format, including binary-mode and CRLF lines', () => {
    const text = formatChecksums([
      { name: 'zetta-linux-x64', sha256: SHA },
      { name: 'zetta-darwin-arm64', sha256: 'b'.repeat(64) },
    ])
    expect(text).toBe(`${'b'.repeat(64)}  zetta-darwin-arm64\n${SHA}  zetta-linux-x64\n`)
    const parsed = parseChecksums(`${text}${'C'.repeat(64)} *zetta-windows-x64.exe\r\ngarbage line\n`)
    expect(parsed.get('zetta-linux-x64')).toBe(SHA)
    expect(parsed.get('zetta-windows-x64.exe')).toBe('c'.repeat(64))
    expect(parsed.size).toBe(3)
  })
})
