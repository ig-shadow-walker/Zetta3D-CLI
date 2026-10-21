import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import type { Context } from '../core/context'
import { defineCommand } from '../core/define'
import { usageError } from '../core/errors'
import { appDataDir, homeDir } from '../core/paths'
import { SKILL_NAME, skillMarkdown } from '../guide'
import { isCompiledBinary } from '../upgrade'

const START = 'zetta3d:start'
const END = 'zetta3d:end'

/** The command an MCP client should launch: this binary's absolute path (GUI apps don't see the shell's PATH). */
export function zettaExecutable(): string {
  return isCompiledBinary() ? process.execPath : 'zetta'
}

function skillPath(ctx: Context, project: boolean, dir: string | undefined): string {
  if (dir) return join(resolve(ctx.cwd, dir), SKILL_NAME, 'SKILL.md')
  return join(project ? ctx.cwd : homeDir(ctx.env), '.claude', 'skills', SKILL_NAME, 'SKILL.md')
}

/** Writes a file, keeping one `.bak` of whatever was there. Returns whether anything changed. */
function writeWithBackup(path: string, content: string): 'created' | 'updated' | 'unchanged' {
  if (existsSync(path)) {
    const before = readFileSync(path, 'utf8')
    if (before === content) return 'unchanged'
    copyFileSync(path, `${path}.bak`)
    writeFileSync(path, content)
    return 'updated'
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return 'created'
}

/** Replaces (or appends) a marked block in a text file, so re-running never duplicates it. */
export function withMarkedBlock(text: string, block: string, comment: (marker: string) => string): string {
  const start = comment(START)
  const end = comment(END)
  const wrapped = `${start}\n${block.trim()}\n${end}`
  const from = text.indexOf(start)
  const to = text.indexOf(end)
  if (from !== -1 && to > from) return `${text.slice(0, from)}${wrapped}${text.slice(to + end.length)}`
  return `${text.replace(/\s*$/, '')}${text.trim() ? '\n\n' : ''}${wrapped}\n`
}

export function withoutMarkedBlock(text: string, comment: (marker: string) => string): string {
  const start = comment(START)
  const end = comment(END)
  const from = text.indexOf(start)
  const to = text.indexOf(end)
  if (from === -1 || to < from) return text
  return `${text.slice(0, from).replace(/\s*$/, '')}\n${text.slice(to + end.length).replace(/^\s*/, '')}`.replace(/^\n$/, '')
}

const html = (marker: string) => `<!-- ${marker} -->`
const hash = (marker: string) => `# ${marker}`

function mcpArgs(budget: number | undefined, readOnly: boolean | undefined): string[] {
  return ['mcp', ...(budget !== undefined ? ['--budget', String(budget)] : []), ...(readOnly ? ['--read-only'] : [])]
}

/** Merges our server into an `mcpServers` JSON config (Claude Desktop, Cursor). */
export function mergeMcpJson(text: string | undefined, command: string, args: string[]): string {
  let config: Record<string, unknown> = {}
  if (text?.trim()) {
    try {
      config = JSON.parse(text) as Record<string, unknown>
    } catch {
      throw usageError('The existing MCP config is not valid JSON; fix it first (nothing was changed).')
    }
  }
  const servers = (config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers : {}) as Record<string, unknown>
  config.mcpServers = { ...servers, [SKILL_NAME]: { command, args } }
  return `${JSON.stringify(config, null, 2)}\n`
}

function desktopConfigPath(env: NodeJS.ProcessEnv): string {
  if (process.platform === 'darwin') return join(homeDir(env), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  if (process.platform === 'win32') return join(appDataDir(env), 'Claude', 'claude_desktop_config.json')
  return join(env.XDG_CONFIG_HOME || join(homeDir(env), '.config'), 'Claude', 'claude_desktop_config.json')
}

export const skillInstall = defineCommand({
  path: ['skill', 'install'],
  summary: 'Install the Zetta 3D skill so AI agents (e.g. Claude Code) know how to use this CLI.',
  description: 'Default: ~/.claude/skills/zetta3d/SKILL.md (all your projects). --project: ./.claude/skills/ (this repository). --dir: any skills folder.',
  kind: 'local',
  mcp: false,
  input: z.object({
    project: z.boolean().optional().describe('Install for this project only (./.claude/skills).'),
    dir: z.string().optional().describe('Install into this skills folder instead.'),
  }),
  async run(ctx, input) {
    const path = skillPath(ctx, Boolean(input.project), input.dir)
    const result = writeWithBackup(path, skillMarkdown())
    return { skill: SKILL_NAME, path, result }
  },
  text: (r: { path: string; result: string }) => (r.result === 'unchanged' ? `Already up to date: ${r.path}` : `Skill ${r.result}: ${r.path}`),
})

export const skillUninstall = defineCommand({
  path: ['skill', 'uninstall'],
  summary: 'Remove the installed Zetta 3D skill.',
  kind: 'local',
  mcp: false,
  input: z.object({
    project: z.boolean().optional().describe('Remove it from this project (./.claude/skills).'),
    dir: z.string().optional().describe('Remove it from this skills folder.'),
  }),
  async run(ctx, input) {
    const path = skillPath(ctx, Boolean(input.project), input.dir)
    const existed = existsSync(path)
    if (existed) rmSync(dirname(path), { recursive: true, force: true })
    return { path, removed: existed }
  },
  text: (r: { path: string; removed: boolean }) => (r.removed ? `Removed ${r.path}` : 'The skill was not installed there.'),
})

export const skillShow = defineCommand({
  path: ['skill', 'show'],
  summary: 'Print the skill file (SKILL.md) for frameworks that load skills from elsewhere.',
  kind: 'local',
  mcp: false,
  input: z.object({}),
  async run() {
    return { name: SKILL_NAME, markdown: skillMarkdown() }
  },
  text: (r: { markdown: string }) => r.markdown,
})

const CLIENTS = ['claude-code', 'claude-desktop', 'cursor', 'codex', 'agents-md'] as const

interface SetupStep {
  what: string
  path?: string
  command?: string
  result: string
}

export const setupCommand = defineCommand({
  path: ['setup'],
  summary: 'Connect an AI tool to Zetta 3D: Claude Code, Claude Desktop, Cursor, Codex, or an AGENTS.md.',
  description: [
    'claude-code     installs the skill and registers the MCP server (`claude mcp add`).',
    'claude-desktop  adds the MCP server to claude_desktop_config.json.',
    'cursor          adds the MCP server to ~/.cursor/mcp.json.',
    'codex           adds the MCP server to ~/.codex/config.toml and the guide to ~/.codex/AGENTS.md.',
    'agents-md       adds the guide to ./AGENTS.md (read by many coding agents).',
    'Existing files are backed up to .bak, and re-running replaces our entry instead of duplicating it.',
    'Without --budget, paid MCP tools need yes or maxCredits on every call.',
  ].join('\n'),
  kind: 'local',
  mcp: false,
  positionals: [{ name: 'client', required: true }],
  input: z.object({
    client: z.enum(CLIENTS).describe('The AI tool to connect.'),
    budget: z.number().int().min(0).optional().describe('Credits each MCP session may spend without per-call confirmation.'),
    readOnly: z.boolean().optional().describe('Offer only read-only tools over MCP.'),
    print: z.boolean().optional().describe('Show what would change, and change nothing.'),
  }),
  examples: ['zetta setup claude-code --budget 500', 'zetta setup claude-desktop --read-only', 'zetta setup agents-md --print'],
  async run(ctx: Context, input) {
    const command = zettaExecutable()
    const args = mcpArgs(input.budget, input.readOnly)
    if (command === 'zetta' && input.client !== 'agents-md') {
      ctx.out.warn('Running from source: the config will call `zetta` from PATH. Install the binary for a fixed path.')
    }
    const steps: SetupStep[] = []
    const write = (what: string, path: string, content: string) => {
      steps.push({ what, path, result: input.print ? 'would write' : writeWithBackup(path, content) })
    }
    const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '')

    switch (input.client) {
      case 'claude-code': {
        write('skill', skillPath(ctx, false, undefined), skillMarkdown())
        const add = ['mcp', 'add', '--scope', 'user', SKILL_NAME, '--', command, ...args]
        const shown = `claude ${add.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`
        if (input.print) {
          steps.push({ what: 'mcp server', command: shown, result: 'would run' })
          break
        }
        const found = spawnSync('claude', ['--version'], { stdio: 'ignore' }).status === 0
        if (!found) {
          steps.push({ what: 'mcp server', command: shown, result: 'Claude Code not found on PATH — run this command yourself' })
          break
        }
        spawnSync('claude', ['mcp', 'remove', '--scope', 'user', SKILL_NAME], { stdio: 'ignore' })
        const added = spawnSync('claude', add, { encoding: 'utf8' })
        steps.push({ what: 'mcp server', command: shown, result: added.status === 0 ? 'registered' : `failed: ${(added.stderr || added.stdout || '').trim().split('\n').at(-1) ?? ''}` })
        break
      }
      case 'claude-desktop': {
        const path = desktopConfigPath(ctx.env)
        write('mcp server', path, mergeMcpJson(read(path), command, args))
        steps.push({ what: 'next step', result: 'Restart Claude Desktop to load the server.' })
        break
      }
      case 'cursor': {
        const path = join(homeDir(ctx.env), '.cursor', 'mcp.json')
        write('mcp server', path, mergeMcpJson(read(path), command, args))
        break
      }
      case 'codex': {
        const config = join(homeDir(ctx.env), '.codex', 'config.toml')
        const toml = [`[mcp_servers.${SKILL_NAME}]`, `command = ${JSON.stringify(command)}`, `args = [${args.map((a) => JSON.stringify(a)).join(', ')}]`].join('\n')
        write('mcp server', config, withMarkedBlock(read(config), toml, hash))
        const agents = join(homeDir(ctx.env), '.codex', 'AGENTS.md')
        write('guide', agents, withMarkedBlock(read(agents), skillMarkdown().replace(/^---[\s\S]*?---\n/, ''), html))
        break
      }
      case 'agents-md': {
        const path = join(ctx.cwd, 'AGENTS.md')
        write('guide', path, withMarkedBlock(read(path), skillMarkdown().replace(/^---[\s\S]*?---\n/, ''), html))
        break
      }
    }
    return { client: input.client, mcpCommand: [command, ...args].join(' '), steps }
  },
  text: (r: { client: string; steps: SetupStep[] }) =>
    [`Setting up ${r.client}:`, ...r.steps.map((s) => `  ${s.what.padEnd(11)} ${s.result}${s.path ? `  ${s.path}` : ''}${s.command ? `\n              ${s.command}` : ''}`)].join('\n'),
})

export const integrationCommands = [skillInstall, skillUninstall, skillShow, setupCommand]
