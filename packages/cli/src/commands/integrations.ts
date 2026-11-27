import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import type { Context } from '../core/context'
import { defineCommand } from '../core/define'
import { usageError } from '../core/errors'
import { appDataDir, homeDir } from '../core/paths'
import { guideText, SKILL_NAME } from '../guide'
import { autoSkillsOff, skillFiles } from '../skill/bundle'
import { AGENT_LABEL, detectAgents, installedVersion, removeSkill, servedBy, skillsFolder, targetsFor, writeSkill, type Agent, type SkillTarget } from '../skill/install'
import { VERSION } from '../version'
import { isCompiledBinary } from '../upgrade'

const START = 'zetta3d:start'
const END = 'zetta3d:end'

/** The command an MCP client should launch: this binary's absolute path (GUI apps don't see the shell's PATH). */
export function zettaExecutable(): string {
  return isCompiledBinary() ? process.execPath : 'zetta'
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

/**
 * Takes our server out of an `mcpServers` JSON config, leaving every other server as it was. `removed` is
 * false when it was not there, and a file that is not valid JSON is left alone: this only ever tidies up.
 */
export function withoutMcpJson(text: string): { text: string; removed: boolean } {
  let config: Record<string, unknown>
  try {
    config = JSON.parse(text) as Record<string, unknown>
  } catch {
    return { text, removed: false }
  }
  const servers = config.mcpServers
  if (!servers || typeof servers !== 'object' || !(SKILL_NAME in servers)) return { text, removed: false }
  const rest = { ...(servers as Record<string, unknown>) }
  delete rest[SKILL_NAME]
  config.mcpServers = rest
  return { text: `${JSON.stringify(config, null, 2)}\n`, removed: true }
}

function desktopConfigPath(env: NodeJS.ProcessEnv): string {
  if (process.platform === 'darwin') return join(homeDir(env), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  if (process.platform === 'win32') return join(appDataDir(env), 'Claude', 'claude_desktop_config.json')
  return join(env.XDG_CONFIG_HOME || join(homeDir(env), '.config'), 'Claude', 'claude_desktop_config.json')
}

const AGENTS = ['claude', 'codex', 'cursor', 'all'] as const
type AgentChoice = (typeof AGENTS)[number]

const agentField = z
  .enum(AGENTS)
  .optional()
  .describe('Which agent: claude (Claude Code), codex, cursor, or all (default: the agents found on this machine).')

interface SkillPlace {
  /** Who reads this folder, e.g. "Codex and Cursor". */
  agents: string
  /** The skills folder; the skill is its zetta3d/ subfolder. */
  folder: string
}

/** The skills folders an install or uninstall acts on. */
function skillPlaces(ctx: Context, input: { agent?: AgentChoice | undefined; project?: boolean | undefined; dir?: string | undefined }, found: Agent[]): SkillPlace[] {
  if (input.dir) return [{ agents: 'a custom folder', folder: resolve(ctx.cwd, input.dir) }]
  const root = input.project ? ctx.cwd : homeDir(ctx.env)
  const agents: Agent[] =
    input.agent === 'all' ? ['claude', 'codex', 'cursor'] : input.agent ? [input.agent] : input.project ? ['claude', 'codex', 'cursor'] : found
  return targetsFor(agents).map((target) => ({ agents: servedBy(target, agents), folder: skillsFolder(root, target) }))
}

/** Records the user's choice, so installers and upgrades follow it. */
function setAutoSkills(ctx: Context, on: boolean): void {
  if ((ctx.config.file.skills?.auto ?? true) === on) return
  try {
    ctx.config.set('skills.auto', String(on))
    ctx.config.save()
  } catch {
    // Not being able to save the preference must not fail the install.
  }
}

export const skillInstall = defineCommand({
  path: ['skill', 'install'],
  summary: 'Install the Zetta 3D skill, so AI coding agents (Claude Code, Codex, Cursor) know how to use this CLI.',
  description: [
    'The skill is a folder (SKILL.md plus reference files) in the place each agent reads skills from:',
    '  ~/.claude/skills/zetta3d   Claude Code (Cursor reads it too)',
    '  ~/.agents/skills/zetta3d   Codex and Cursor',
    'By default it goes to the agents found on this machine; --agent picks one, or all. --project installs into this repository (.claude/skills and .agents/skills) instead.',
    'The installers run this with --auto, and every newer zetta refreshes the installed copies by itself. `zetta skill uninstall` stops that.',
  ].join('\n'),
  kind: 'local',
  mcp: false,
  input: z.object({
    agent: agentField,
    project: z.boolean().optional().describe('Install into this repository instead of your home folder.'),
    dir: z.string().optional().describe('Install into this skills folder instead.'),
    auto: z.boolean().optional().describe('As the installers do: only for agents found here, and not if you turned it off (skills.auto false or ZETTA_NO_SKILL=1).'),
  }),
  examples: ['zetta skill install', 'zetta skill install --agent codex', 'zetta skill install --project'],
  async run(ctx, input) {
    const found = detectAgents(ctx.env)
    if (input.auto) {
      if (autoSkillsOff(ctx.env)) return { skill: SKILL_NAME, version: VERSION, installed: [], note: 'Skipped: automatic skill installs are turned off (`zetta skill install` turns them back on).' }
      if (!found.length) return { skill: SKILL_NAME, version: VERSION, installed: [], note: 'No AI coding agent found (Claude Code, Codex, Cursor). Install the skill later with `zetta skill install`.' }
    }
    let places = skillPlaces(ctx, input, found)
    let note: string | undefined
    if (!places.length) {
      // Nothing found and nothing named: the shared Agent Skills folder, which most agents read.
      places = [{ agents: 'Codex, Cursor and other Agent Skills tools', folder: skillsFolder(homeDir(ctx.env), 'agents') }]
      note = 'No AI coding agent found here, so the skill went to the shared Agent Skills folder. Use --agent claude for Claude Code.'
    }
    const files = await skillFiles()
    const installed = places.map((place) => ({ agents: place.agents, ...writeSkill(place.folder, files, VERSION) }))
    if (!input.auto && !input.project && !input.dir) setAutoSkills(ctx, true)
    return { skill: SKILL_NAME, version: VERSION, installed, ...(note ? { note } : {}) }
  },
  text: (r: { version: string; installed: Array<{ agents: string; dir: string; result: string }>; note?: string }) =>
    [
      ...r.installed.map((i) => `${i.result === 'unchanged' ? 'Up to date' : i.result === 'created' ? 'Installed' : 'Updated'} the Zetta 3D skill (${r.version}) for ${i.agents}: ${i.dir}`),
      ...(r.note ? [r.note] : []),
    ].join('\n'),
})

export const skillUninstall = defineCommand({
  path: ['skill', 'uninstall'],
  summary: 'Remove the Zetta 3D skill, and stop installers and upgrades from putting it back.',
  description: 'Without --agent, it is removed from every agent folder in your home folder. Only folders that hold the Zetta 3D skill are touched.',
  kind: 'local',
  mcp: false,
  input: z.object({
    agent: agentField,
    project: z.boolean().optional().describe('Remove it from this repository instead.'),
    dir: z.string().optional().describe('Remove it from this skills folder.'),
  }),
  async run(ctx, input) {
    const places = skillPlaces(ctx, { ...input, agent: input.agent ?? 'all' }, [])
    const results = places.map((place) => ({ agents: place.agents, ...removeSkill(place.folder) }))
    if (!input.project && !input.dir && !input.agent) setAutoSkills(ctx, false)
    return { removed: results.filter((r) => r.removed).map((r) => r.dir), skipped: results.filter((r) => r.notOurs).map((r) => r.dir) }
  },
  text: (r: { removed: string[]; skipped: string[] }) =>
    [
      ...(r.removed.length ? r.removed.map((dir) => `Removed ${dir}`) : ['The skill was not installed.']),
      ...r.skipped.map((dir) => `Left ${dir} alone: it is not the Zetta 3D skill.`),
    ].join('\n'),
})

export const skillStatus = defineCommand({
  path: ['skill', 'status'],
  summary: 'Where the Zetta 3D skill is installed, and whether it is up to date.',
  kind: 'local',
  mcp: false,
  input: z.object({ project: z.boolean().optional().describe('Look in this repository instead of your home folder.') }),
  async run(ctx, input) {
    const root = input.project ? ctx.cwd : homeDir(ctx.env)
    const found = detectAgents(ctx.env)
    const places = (['claude', 'agents'] as const).map((target) => {
      const dir = join(skillsFolder(root, target), SKILL_NAME)
      const version = installedVersion(dir)
      return { agents: servedBy(target), dir, installed: version !== undefined, version: version ?? null, upToDate: version === VERSION }
    })
    return { version: VERSION, agentsFound: found.map((agent) => AGENT_LABEL[agent]), auto: !autoSkillsOff(ctx.env), places }
  },
  text: (r: { version: string; agentsFound: string[]; auto: boolean; places: Array<{ agents: string; dir: string; installed: boolean; version: string | null; upToDate: boolean }> }) =>
    [
      `Agents found: ${r.agentsFound.length ? r.agentsFound.join(', ') : 'none'} · automatic installs and updates: ${r.auto ? 'on' : 'off'}`,
      ...r.places.map((p) => `  ${p.agents.padEnd(18)} ${p.installed ? (p.upToDate ? `installed (${r.version})` : `installed, ${p.version ?? 'an older version'} → run \`zetta skill install\``) : 'not installed'}  ${p.dir}`),
    ].join('\n'),
})

export const skillShow = defineCommand({
  path: ['skill', 'show'],
  summary: 'Print the skill (SKILL.md, or one of its files), for agents and frameworks that load skills from elsewhere.',
  kind: 'local',
  mcp: false,
  input: z.object({
    file: z.string().optional().describe('Print this file instead, e.g. references/pipelines.md.'),
    list: z.boolean().optional().describe('List the skill’s files.'),
  }),
  async run(ctx, input) {
    const files = await skillFiles()
    if (input.list) return { name: SKILL_NAME, files: Object.keys(files) }
    const file = input.file ?? 'SKILL.md'
    const text = files[file] ?? files[`references/${file}`] ?? files[`references/${file}.md`]
    if (text === undefined) throw usageError(`The skill has no ${file}. Files: ${Object.keys(files).join(', ')}.`)
    return { name: SKILL_NAME, file, markdown: text }
  },
  text: (r: { files?: string[]; markdown?: string }) => (r.files ? r.files.join('\n') : r.markdown!),
})

const CLIENTS = ['claude-code', 'claude-desktop', 'cursor', 'codex', 'agents-md'] as const

/** The agents that can run commands, so the skill is all they need and MCP is opt-in. */
const CODING_AGENTS: ReadonlyArray<(typeof CLIENTS)[number]> = ['claude-code', 'cursor', 'codex']

interface SetupStep {
  what: string
  path?: string
  command?: string
  result: string
}

/*
 * THE SKILL, NOT MCP, FOR CODING AGENTS. An agent with a shell runs `zetta` like any other command, and
 * the skill tells it how: its description is all that sits in the agent's context until a task needs
 * more. The MCP server's tool list (every command's JSON Schema) is far larger and is loaded into every
 * session whether 3D comes up or not, and it gives a coding agent nothing the shell does not. So for
 * claude-code, cursor and codex the server is opt-in (`--mcp`); Claude Desktop cannot run commands, so
 * MCP stays its way in.
 */
const MCP_NOT_ADDED = 'none: the skill is all a coding agent needs (add --mcp for one)'
const MCP_REMOVED = 'removed the one an earlier setup added: the skill replaces it (add --mcp to keep one)'

export const setupCommand = defineCommand({
  path: ['setup'],
  summary: 'Connect an AI tool to Zetta 3D: Claude Code, Codex, Cursor, Claude Desktop, or an AGENTS.md.',
  description: [
    'claude-code     installs the skill (~/.claude/skills).',
    'codex           installs the skill (~/.agents/skills).',
    'cursor          installs the skill (~/.agents/skills).',
    'claude-desktop  adds the MCP server to claude_desktop_config.json: it cannot run commands, so MCP is its way in.',
    'agents-md       adds the guide to ./AGENTS.md (read by many coding agents).',
    'A coding agent runs zetta in its shell and the skill tells it how, at a fraction of the context an MCP server costs: its tool list loads into every session. So for claude-code, codex and cursor the MCP server is opt-in: add --mcp. Re-running without --mcp removes one an earlier setup added.',
    'Existing files are backed up to .bak, and re-running replaces our entry instead of duplicating it.',
    'With MCP and no --budget, paid tools need yes or maxCredits on every call.',
  ].join('\n'),
  kind: 'local',
  mcp: false,
  positionals: [{ name: 'client', required: true }],
  input: z.object({
    client: z.enum(CLIENTS).describe('The AI tool to connect.'),
    mcp: z.boolean().optional().describe('claude-code, codex, cursor: also connect the MCP server. Not needed: the agent runs zetta in its shell.'),
    budget: z.number().int().min(0).optional().describe('With MCP: credits each session may spend without per-call confirmation.'),
    readOnly: z.boolean().optional().describe('With MCP: offer only read-only tools.'),
    print: z.boolean().optional().describe('Show what would change, and change nothing.'),
  }),
  examples: ['zetta setup claude-code', 'zetta setup claude-desktop --budget 500', 'zetta setup cursor --mcp --read-only', 'zetta setup agents-md --print'],
  async run(ctx: Context, input) {
    const coding = CODING_AGENTS.includes(input.client)
    const withMcp = input.client === 'claude-desktop' || (coding && input.mcp === true)
    if (coding && !input.mcp && (input.budget !== undefined || input.readOnly)) {
      throw usageError('--budget and --read-only are settings for the MCP server. Add --mcp to connect one, or leave them out: the skill needs neither.')
    }
    const command = zettaExecutable()
    const args = mcpArgs(input.budget, input.readOnly)
    if (command === 'zetta' && withMcp) {
      ctx.out.warn('Running from source: the config will call `zetta` from PATH. Install the binary for a fixed path.')
    }
    const steps: SetupStep[] = []
    const write = (what: string, path: string, content: string) => {
      steps.push({ what, path, result: input.print ? 'would write' : writeWithBackup(path, content) })
    }
    const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '')
    const installSkill = async (target: SkillTarget) => {
      const folder = skillsFolder(homeDir(ctx.env), target)
      if (input.print) {
        steps.push({ what: 'skill', path: join(folder, SKILL_NAME), result: 'would write' })
        return
      }
      const written = writeSkill(folder, await skillFiles(), VERSION)
      steps.push({ what: 'skill', path: written.dir, result: written.result })
    }

    /** Without --mcp: take out a server an earlier setup added to this config file, or say there is none. */
    const withoutServer = (path: string, before: string, after: string) => {
      if (after === before) {
        steps.push({ what: 'mcp server', result: MCP_NOT_ADDED })
        return
      }
      if (!input.print) writeWithBackup(path, after)
      steps.push({ what: 'mcp server', path, result: input.print ? 'would remove the one an earlier setup added' : MCP_REMOVED })
    }

    switch (input.client) {
      case 'claude-code': {
        await installSkill('claude')
        const add = ['mcp', 'add', '--scope', 'user', SKILL_NAME, '--', command, ...args]
        const shown = `claude ${add.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`
        if (input.print) {
          steps.push(withMcp ? { what: 'mcp server', command: shown, result: 'would run' } : { what: 'mcp server', result: `${MCP_NOT_ADDED}; would remove one an earlier setup added` })
          break
        }
        const found = spawnSync('claude', ['--version'], { stdio: 'ignore' }).status === 0
        if (!withMcp) {
          // `claude mcp remove` fails when there is nothing to remove, which is the usual case.
          const removed = found && spawnSync('claude', ['mcp', 'remove', '--scope', 'user', SKILL_NAME], { stdio: 'ignore' }).status === 0
          steps.push({ what: 'mcp server', result: removed ? MCP_REMOVED : MCP_NOT_ADDED })
          break
        }
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
        await installSkill('agents')
        const path = join(homeDir(ctx.env), '.cursor', 'mcp.json')
        if (withMcp) write('mcp server', path, mergeMcpJson(read(path), command, args))
        else withoutServer(path, read(path), withoutMcpJson(read(path)).text)
        break
      }
      case 'codex': {
        await installSkill('agents')
        const config = join(homeDir(ctx.env), '.codex', 'config.toml')
        const toml = [`[mcp_servers.${SKILL_NAME}]`, `command = ${JSON.stringify(command)}`, `args = [${args.map((a) => JSON.stringify(a)).join(', ')}]`].join('\n')
        if (withMcp) write('mcp server', config, withMarkedBlock(read(config), toml, hash))
        else withoutServer(config, read(config), withoutMarkedBlock(read(config), hash))
        break
      }
      case 'agents-md': {
        const path = join(ctx.cwd, 'AGENTS.md')
        write('guide', path, withMarkedBlock(read(path), guideText(), html))
        break
      }
    }
    return { client: input.client, mcp: withMcp, ...(withMcp ? { mcpCommand: [command, ...args].join(' ') } : {}), steps }
  },
  text: (r: { client: string; steps: SetupStep[] }) =>
    [`Setting up ${r.client}:`, ...r.steps.map((s) => `  ${s.what.padEnd(11)} ${s.result}${s.path ? `  ${s.path}` : ''}${s.command ? `\n              ${s.command}` : ''}`)].join('\n'),
})

export const integrationCommands = [skillInstall, skillUninstall, skillStatus, skillShow, setupCommand]
