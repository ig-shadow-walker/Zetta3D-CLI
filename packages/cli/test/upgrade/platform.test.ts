import { describe, expect, it } from 'vitest'
import { candidateKeys, platformKey } from '../../src/upgrade/platform'

const plain = { musl: false, rosetta: false, avx2: true }

describe('platformKey', () => {
  it.each([
    [{ platform: 'darwin', arch: 'arm64' }, 'darwin-arm64'],
    [{ platform: 'darwin', arch: 'x64' }, 'darwin-x64'],
    [{ platform: 'darwin', arch: 'x64', rosetta: true }, 'darwin-arm64'],
    [{ platform: 'linux', arch: 'x64' }, 'linux-x64'],
    [{ platform: 'linux', arch: 'aarch64' }, 'linux-arm64'],
    [{ platform: 'linux', arch: 'x64', musl: true }, 'linux-x64-musl'],
    [{ platform: 'linux', arch: 'arm64', musl: true }, 'linux-arm64-musl'],
    [{ platform: 'linux', arch: 'x64', avx2: false }, 'linux-x64-baseline'],
    [{ platform: 'linux', arch: 'x64', musl: true, avx2: false }, 'linux-x64-musl-baseline'],
    [{ platform: 'linux', arch: 'arm64', avx2: false }, 'linux-arm64'],
    [{ platform: 'win32', arch: 'x64' }, 'windows-x64'],
    [{ platform: 'win32', arch: 'arm64' }, 'windows-arm64'],
  ])('%j -> %s', (info, want) => {
    expect(platformKey({ ...plain, ...info })).toBe(want)
  })

  it('refuses unsupported systems with a clear message', () => {
    expect(() => platformKey({ ...plain, platform: 'freebsd', arch: 'x64' })).toThrow(/does not support freebsd/)
    expect(() => platformKey({ ...plain, platform: 'linux', arch: 'ia32' })).toThrow(/ia32 CPU architecture/)
  })

  it('detects something sensible for this machine', () => {
    expect(platformKey()).toMatch(/^(darwin|linux|windows)-(x64|arm64)(-musl)?(-baseline)?$/)
  })

  it('lets Windows on Arm fall back to the x64 build', () => {
    expect(candidateKeys('windows-arm64')).toEqual(['windows-arm64', 'windows-x64'])
    expect(candidateKeys('linux-x64')).toEqual(['linux-x64'])
  })
})
