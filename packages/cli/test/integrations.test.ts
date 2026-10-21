import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mergeMcpJson, withMarkedBlock, withoutMarkedBlock } from '../src/commands/integrations'
import { homeEnv, zetta } from './harness'

describe('skill', () => {
  it('installs, stays idempotent, and uninstalls', async () => {
    const home = mkdtempSync(join(tmpdir(), 'zh-'))
    const first = await zetta(['skill', 'install'], { env: homeEnv(home) })
    expect(first.code).toBe(0)
    const path = join(home, '.claude', 'skills', 'zetta3d', 'SKILL.md')
    expect(first.json()).toMatchObject({ path, result: 'created' })
    const text = readFileSync(path, 'utf8')
    expect(text.startsWith('---\nname: zetta3d\ndescription: ')).toBe(true)
    expect(text).toContain('zetta asset wait')
    expect((await zetta(['skill', 'install'], { env: homeEnv(home) })).json().result).toBe('unchanged')
    expect((await zetta(['skill', 'uninstall'], { env: homeEnv(home) })).json().removed).toBe(true)
    expect(existsSync(path)).toBe(false)
  })

  it('installs into a custom skills folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zs-'))
    const run = await zetta(['skill', 'install', '--dir', dir])
    expect(existsSync(join(dir, 'zetta3d', 'SKILL.md'))).toBe(true)
    expect(run.code).toBe(0)
  })
})

describe('setup', () => {
  it('adds the MCP server to an existing Cursor config without touching other servers', async () => {
    const home = mkdtempSync(join(tmpdir(), 'zh-'))
    mkdirSync(join(home, '.cursor'))
    writeFileSync(join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }))
    const run = await zetta(['setup', 'cursor', '--budget', '300'], { env: homeEnv(home) })
    expect(run.code).toBe(0)
    const config = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8'))
    expect(config.mcpServers.other).toEqual({ command: 'x' })
    expect(config.mcpServers.zetta3d.args).toEqual(['mcp', '--budget', '300'])
    expect(existsSync(join(home, '.cursor', 'mcp.json.bak'))).toBe(true)
  })

  it('writes Codex config and guide as replaceable blocks', async () => {
    const home = mkdtempSync(join(tmpdir(), 'zh-'))
    mkdirSync(join(home, '.codex'))
    writeFileSync(join(home, '.codex', 'config.toml'), 'model = "x"\n')
    await zetta(['setup', 'codex'], { env: homeEnv(home) })
    await zetta(['setup', 'codex', '--read-only'], { env: homeEnv(home) })
    const toml = readFileSync(join(home, '.codex', 'config.toml'), 'utf8')
    expect(toml.startsWith('model = "x"')).toBe(true)
    expect(toml.match(/\[mcp_servers\.zetta3d\]/g)).toHaveLength(1)
    expect(toml).toContain('"--read-only"')
    expect(readFileSync(join(home, '.codex', 'AGENTS.md'), 'utf8')).toContain('zetta asset wait')
  })

  it('--print changes nothing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'zh-'))
    const run = await zetta(['setup', 'claude-code', '--print'], { env: homeEnv(home) })
    expect(run.code).toBe(0)
    expect(run.json().steps.map((s: { result: string }) => s.result)).toEqual(['would write', 'would run'])
    expect(existsSync(join(home, '.claude'))).toBe(false)
  })
})

describe('marked blocks', () => {
  const html = (m: string) => `<!-- ${m} -->`
  it('appends once, replaces after, removes cleanly', () => {
    const once = withMarkedBlock('# Project\n', 'guide v1', html)
    const twice = withMarkedBlock(once, 'guide v2', html)
    expect(twice).toContain('guide v2')
    expect(twice).not.toContain('guide v1')
    expect(twice.match(/zetta3d:start/g)).toHaveLength(1)
    expect(withoutMarkedBlock(twice, html).trim()).toBe('# Project')
  })
  it('refuses to rewrite invalid JSON config', () => {
    expect(() => mergeMcpJson('{nope', 'zetta', ['mcp'])).toThrow(/not valid JSON/)
  })
})
