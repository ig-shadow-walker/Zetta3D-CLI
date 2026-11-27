import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mergeMcpJson, withMarkedBlock, withoutMarkedBlock, withoutMcpJson } from '../src/commands/integrations'
import { homeEnv, zetta } from './harness'

describe('skill', () => {
  it('installs for Claude Code, stays idempotent, and uninstalls', async () => {
    const home = mkdtempSync(join(tmpdir(), 'zh-'))
    const first = await zetta(['skill', 'install', '--agent', 'claude'], { env: homeEnv(home) })
    expect(first.code).toBe(0)
    const dir = join(home, '.claude', 'skills', 'zetta3d')
    expect(first.json().installed).toMatchObject([{ agents: 'Claude Code', dir, result: 'created' }])
    const text = readFileSync(join(dir, 'SKILL.md'), 'utf8')
    expect(text.startsWith('---\nname: zetta3d\ndescription: ')).toBe(true)
    expect(text).toContain('zetta asset wait')
    expect((await zetta(['skill', 'install', '--agent', 'claude'], { env: homeEnv(home) })).json().installed[0].result).toBe('unchanged')
    expect((await zetta(['skill', 'uninstall'], { env: homeEnv(home) })).json().removed).toEqual([dir])
    expect(existsSync(dir)).toBe(false)
  })

  it('installs into a custom skills folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zs-'))
    const run = await zetta(['skill', 'install', '--dir', dir])
    expect(existsSync(join(dir, 'zetta3d', 'SKILL.md'))).toBe(true)
    expect(run.code).toBe(0)
  })
})

/*
 * `setup claude-code` IS ONLY EVER RUN WITH --print HERE. Without it, the command calls the real `claude`
 * on PATH, which edits the Claude Code config of whoever runs the tests.
 */
describe('setup', () => {
  /* The skill, not MCP, for a coding agent: its tool list would load into every session for nothing. */
  it('gives a coding agent the skill and no MCP server by default', async () => {
    const home = mkdtempSync(join(tmpdir(), 'zh-'))
    const run = await zetta(['setup', 'cursor'], { env: homeEnv(home) })
    expect(run.code).toBe(0)
    expect(run.json().mcp).toBe(false)
    expect(run.json().mcpCommand).toBeUndefined()
    expect(existsSync(join(home, '.agents', 'skills', 'zetta3d', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(home, '.cursor', 'mcp.json'))).toBe(false)
    expect(run.json().steps.at(-1).result).toMatch(/^none: the skill is all a coding agent needs/)
  })

  it('adds the MCP server to an existing Cursor config with --mcp, without touching other servers', async () => {
    const home = mkdtempSync(join(tmpdir(), 'zh-'))
    mkdirSync(join(home, '.cursor'))
    writeFileSync(join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }))
    const run = await zetta(['setup', 'cursor', '--mcp', '--budget', '300'], { env: homeEnv(home) })
    expect(run.code).toBe(0)
    const config = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8'))
    expect(config.mcpServers.other).toEqual({ command: 'x' })
    expect(config.mcpServers.zetta3d.args).toEqual(['mcp', '--budget', '300'])
    expect(existsSync(join(home, '.cursor', 'mcp.json.bak'))).toBe(true)
  })

  /* Someone who ran an earlier setup stops paying for the tool list the next time they run it. */
  it('takes out the server an earlier setup added when re-run without --mcp, and nothing else', async () => {
    const home = mkdtempSync(join(tmpdir(), 'zh-'))
    mkdirSync(join(home, '.cursor'))
    writeFileSync(join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }))
    await zetta(['setup', 'cursor', '--mcp'], { env: homeEnv(home) })
    const again = await zetta(['setup', 'cursor'], { env: homeEnv(home) })
    expect(again.code).toBe(0)
    expect(again.json().steps.at(-1).result).toMatch(/^removed the one an earlier setup added/)
    expect(JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')).mcpServers).toEqual({ other: { command: 'x' } })
  })

  it('refuses MCP settings without --mcp, rather than drop them', async () => {
    const home = mkdtempSync(join(tmpdir(), 'zh-'))
    const run = await zetta(['setup', 'codex', '--budget', '500'], { env: homeEnv(home) })
    expect(run.code).toBe(2)
    expect(run.stderr).toMatch(/Add --mcp/)
    expect(existsSync(join(home, '.agents'))).toBe(false)
  })

  it('writes the Codex config as a replaceable block with --mcp, and installs the skill where Codex reads it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'zh-'))
    mkdirSync(join(home, '.codex'))
    writeFileSync(join(home, '.codex', 'config.toml'), 'model = "x"\n')
    await zetta(['setup', 'codex', '--mcp'], { env: homeEnv(home) })
    await zetta(['setup', 'codex', '--mcp', '--read-only'], { env: homeEnv(home) })
    const toml = readFileSync(join(home, '.codex', 'config.toml'), 'utf8')
    expect(toml.startsWith('model = "x"')).toBe(true)
    expect(toml.match(/\[mcp_servers\.zetta3d\]/g)).toHaveLength(1)
    expect(toml).toContain('"--read-only"')
    expect(readFileSync(join(home, '.agents', 'skills', 'zetta3d', 'SKILL.md'), 'utf8')).toContain('zetta asset wait')
    expect(existsSync(join(home, '.codex', 'AGENTS.md'))).toBe(false)

    await zetta(['setup', 'codex'], { env: homeEnv(home) })
    expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).not.toContain('mcp_servers')
  })

  it('--print changes nothing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'zh-'))
    const plain = await zetta(['setup', 'claude-code', '--print'], { env: homeEnv(home) })
    expect(plain.code).toBe(0)
    expect(plain.json().steps.map((s: { result: string }) => s.result)).toEqual([
      'would write',
      'none: the skill is all a coding agent needs (add --mcp for one); would remove one an earlier setup added',
    ])
    const withMcp = await zetta(['setup', 'claude-code', '--mcp', '--print'], { env: homeEnv(home) })
    expect(withMcp.json().steps.map((s: { result: string }) => s.result)).toEqual(['would write', 'would run'])
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
  it('only tidies when taking our server out: other servers stay, invalid JSON is left alone', () => {
    const both = JSON.stringify({ mcpServers: { zetta3d: { command: 'zetta' }, other: { command: 'x' } } })
    expect(JSON.parse(withoutMcpJson(both).text)).toEqual({ mcpServers: { other: { command: 'x' } } })
    expect(withoutMcpJson('{nope')).toEqual({ text: '{nope', removed: false })
    expect(withoutMcpJson(JSON.stringify({ mcpServers: { other: {} } })).removed).toBe(false)
  })
})
