import { describe, expect, it } from 'vitest'
import { platformFolder, resolveTargets, withBaseline } from '../../../scripts/build'

describe('bun run build target names', () => {
  it('expands an OS to its builds', () => {
    expect(resolveTargets(['macos'])).toEqual(['darwin-arm64', 'darwin-x64'])
    expect(resolveTargets(['linux'])).toEqual(['linux-x64', 'linux-arm64'])
    expect(resolveTargets(['alpine'])).toEqual(['linux-x64-musl', 'linux-arm64-musl'])
    expect(resolveTargets(['windows'])).toEqual(['windows-x64'])
  })

  it('takes an architecture, musl and baseline, and the names Bun uses', () => {
    expect(resolveTargets(['mac-arm64', 'linux-aarch64-musl', 'win-x64-baseline', 'bun-linux-x64'])).toEqual([
      'darwin-arm64',
      'linux-arm64-musl',
      'windows-x64-baseline',
      'linux-x64',
    ])
  })

  it('knows all and this machine, without duplicates', () => {
    expect(resolveTargets(['all'])).toHaveLength(7)
    expect(resolveTargets(['current', 'macos-arm64'], 'darwin-arm64')).toEqual(['darwin-arm64'])
  })

  it('adds baseline builds only where they exist', () => {
    expect(withBaseline(['darwin-arm64', 'linux-x64'])).toEqual(['darwin-arm64', 'linux-x64', 'linux-x64-baseline'])
  })

  it('names release folders by platform', () => {
    expect(['darwin-arm64', 'darwin-x64-baseline', 'linux-arm64-musl', 'windows-x64'].map(platformFolder)).toEqual(['macos-arm64', 'macos-x64-baseline', 'linux-arm64-musl', 'windows-x64'])
  })

  it('rejects names it does not know', () => {
    expect(() => resolveTargets(['freebsd'])).toThrow(/Unknown target "freebsd"/)
    expect(() => resolveTargets(['linux-riscv'])).toThrow(/not an architecture/)
    expect(() => resolveTargets(['macos-arm64-baseline'])).toThrow(/There is no/)
  })
})
