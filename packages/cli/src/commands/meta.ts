import { join } from 'node:path'
import { z } from 'zod'
import { tokenExpiry } from '@zetta3d/sdk'
import { USER_AGENT, type Context } from '../core/context'
import { defineCommand, fieldsOf, inputJsonSchema, kebab, type AnyCommand } from '../core/define'
import { usageError } from '../core/errors'
import { EXIT_CODE_TABLE } from '../core/exit-codes'
import { table } from '../core/output'
import { homeDir } from '../core/paths'
import { guideText, guideTopic, SKILL_NAME } from '../guide'
import { skillFiles } from '../skill/bundle'
import { AGENT_LABEL, detectAgents, installedVersion, servedBy, skillsFolder } from '../skill/install'
import { SKILL_REFERENCES } from '../skill/sources'
import { compareVersions, fetchLatest, upgradeCommand } from '../upgrade'
import { rememberLatest } from '../update-notice'
import { VERSION } from '../version'

/** Filled in by the registry, so these commands can describe all the others. */
export const registry: { commands: AnyCommand[] } = { commands: [] }

export function commandName(command: AnyCommand): string {
  return command.path.join(' ')
}

function describeCommand(command: AnyCommand) {
  return {
    command: `zetta ${commandName(command)}`,
    summary: command.summary,
    kind: command.kind,
    needsSignIn: command.auth ?? command.kind !== 'local',
    spendsCredits: command.kind === 'spend',
    positionals: (command.positionals ?? []).map((p) => ({ name: kebab(p.name), required: Boolean(p.required), variadic: Boolean(p.variadic) })),
    flags: fieldsOf(command)
      .filter((f) => !(command.positionals ?? []).some((p) => p.name === f.key))
      .map((f) => ({
        flag: `--${kebab(f.key)}`,
        type: f.type,
        ...(f.values ? { values: f.values } : {}),
        required: !f.optional,
        ...(f.defaultValue !== undefined ? { default: f.defaultValue } : {}),
        description: f.description ?? '',
      })),
  }
}

export const commandsCommand = defineCommand({
  path: ['commands'],
  summary: 'List every command with its flags (use --json for a machine-readable map).',
  kind: 'local',
  input: z.object({
    group: z.string().optional().describe('Only this group, e.g. asset.'),
  }),
  async run(_ctx, input) {
    const list = registry.commands.filter((c) => !input.group || c.path[0] === input.group)
    return {
      version: VERSION,
      globalFlags: ['--output text|json|ndjson', '--json', '--profile <name>', '--api-url <url>', '--verbose', '--quiet', '--no-color', '--non-interactive', '--input <json|@file|->'],
      exitCodes: EXIT_CODE_TABLE,
      commands: list.map(describeCommand),
    }
  },
  text: (r: { commands: Array<{ command: string; summary: string; kind: string }> }) =>
    table(r.commands.map((c) => ({ command: c.command, kind: c.kind === 'spend' ? 'spends credits' : c.kind, summary: c.summary }))),
})

export const schemaCommand = defineCommand({
  path: ['schema'],
  summary: 'JSON Schema of a command’s input (what --input accepts and MCP tools take).',
  kind: 'local',
  positionals: [{ name: 'command', required: true, variadic: true }],
  input: z.object({ command: z.array(z.string()).min(1).describe('The command, e.g. generate, or asset list.') }),
  examples: ['zetta schema generate', 'zetta schema refine rig'],
  async run(_ctx, input) {
    const wanted = input.command.join(' ').replace(/^zetta\s+/, '')
    const command = registry.commands.find((c) => commandName(c) === wanted)
    if (!command) throw usageError(`Unknown command "${wanted}". See \`zetta commands\`.`)
    return { ...describeCommand(command), description: command.description ?? null, examples: command.examples ?? [], inputSchema: inputJsonSchema(command) }
  },
  text: (r: { inputSchema: unknown }) => JSON.stringify(r.inputSchema, null, 2),
})

const GUIDE_TOPICS = SKILL_REFERENCES.map((r) => guideTopic(r.file)) as [string, ...string[]]

/** Whether a newer zetta is out (one small request; remembered for the update notice). */
async function updateCheck(ctx: Context): Promise<Check> {
  try {
    const latest = await Promise.race([fetchLatest(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), 5000))])
    rememberLatest(ctx.env, latest.version)
    return compareVersions(latest.version, VERSION) > 0
      ? { check: 'update', ok: false, detail: `zetta ${latest.version} is out (this is ${VERSION}). Update with: ${upgradeCommand()}` }
      : { check: 'update', ok: true, detail: `up to date (${VERSION} is the latest)` }
  } catch (error) {
    return { check: 'update', ok: true, detail: `could not check for a newer version (${error instanceof Error ? error.message : String(error)})` }
  }
}

/** Whether the agent skill is installed for the agents on this machine, and current. */
function skillCheck(ctx: Context): Check {
  const home = homeDir(ctx.env)
  const found = detectAgents(ctx.env)
  const installed = (['claude', 'agents'] as const)
    .map((target) => ({ target, version: installedVersion(join(skillsFolder(home, target), SKILL_NAME)) }))
    .filter((place) => place.version !== undefined)
  const stale = installed.filter((place) => place.version !== VERSION)
  if (stale.length) return { check: 'agent skill', ok: false, detail: `An older version is installed for ${stale.map((p) => servedBy(p.target)).join(', ')}. Run \`zetta skill install\`.` }
  if (installed.length) return { check: 'agent skill', ok: true, detail: `installed for ${installed.map((p) => servedBy(p.target, found.length ? found : undefined)).join(', ')} (${VERSION})` }
  return { check: 'agent skill', ok: true, detail: found.length ? `not installed; \`zetta skill install\` teaches ${found.map((a) => AGENT_LABEL[a]).join(', ')} to use zetta` : 'not installed (no Claude Code, Codex or Cursor found)' }
}

export const guideCommand = defineCommand({
  path: ['guide'],
  summary: 'How to use this CLI well — written for AI agents (and handy for people).',
  description: `With a topic, prints that part of the documentation: ${GUIDE_TOPICS.join(', ')}. The agent skill carries the same files (zetta skill install).`,
  kind: 'local',
  positionals: [{ name: 'topic' }],
  input: z.object({ topic: z.enum(GUIDE_TOPICS).optional().describe('One area in depth.') }),
  examples: ['zetta guide', 'zetta guide pipelines', 'zetta guide errors'],
  async run(_ctx, input) {
    if (!input.topic) return { guide: guideText() }
    const files = await skillFiles()
    return { topic: input.topic, guide: files[`references/${input.topic}.md`]! }
  },
  text: (r: { guide: string }) => r.guide,
})

export const exitCodesCommand = defineCommand({
  path: ['exit-codes'],
  summary: 'What each exit code means.',
  kind: 'local',
  input: z.object({}),
  async run() {
    return { exitCodes: EXIT_CODE_TABLE }
  },
  text: (r: { exitCodes: Array<{ code: number; meaning: string }> }) => table(r.exitCodes),
})

interface Check {
  check: string
  ok: boolean
  detail: string
}

export const doctorCommand = defineCommand({
  path: ['doctor'],
  summary: 'Check the setup: version, config, connection, sign-in, clock.',
  kind: 'read',
  auth: false,
  input: z.object({}),
  async run(ctx) {
    const checks: Check[] = []
    checks.push({ check: 'version', ok: true, detail: `${VERSION} (${USER_AGENT})` })
    checks.push({ check: 'config', ok: true, detail: `${ctx.config.path}${ctx.config.file.currentProfile ? '' : ' (defaults)'}` })
    checks.push({ check: 'profile', ok: true, detail: `${ctx.profileName} → ${ctx.profile.apiUrl}` })

    let serverDate: Date | undefined
    try {
      const started = Date.now()
      const response = await fetch(`${ctx.profile.apiUrl.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(10_000) })
      const ms = Date.now() - started
      const header = response.headers.get('date')
      if (header) serverDate = new Date(header)
      checks.push({ check: 'connection', ok: response.ok, detail: response.ok ? `API reachable (${ms} ms)` : `API answered ${response.status}` })
    } catch (error) {
      checks.push({ check: 'connection', ok: false, detail: `Cannot reach ${new URL(ctx.profile.apiUrl).host}: ${error instanceof Error ? error.message : String(error)}` })
    }
    if (serverDate) {
      const skew = Math.round((Date.now() - serverDate.getTime()) / 1000)
      checks.push({ check: 'clock', ok: Math.abs(skew) < 300, detail: Math.abs(skew) < 300 ? 'in sync' : `${skew}s off the server — fix the system clock` })
    }

    const stored = await ctx.storedCredential()
    if (!stored) checks.push({ check: 'sign-in', ok: false, detail: 'Not signed in. Run `zetta auth login` (browser), or set ZETTA_API_KEY for scripts and CI.' })
    else {
      const expiry = stored.credential.expiresAt ? new Date(stored.credential.expiresAt) : tokenExpiry(stored.credential.token)
      try {
        const { user } = await ctx.makeClient(stored.credential.token).auth.me()
        checks.push({
          check: 'sign-in',
          ok: true,
          detail: `${user.email} (${user.paymentPlan}) via ${stored.source}${expiry ? `, expires ${expiry.toISOString().slice(0, 10)}` : ''}`,
        })
      } catch (error) {
        checks.push({ check: 'sign-in', ok: false, detail: `Token from ${stored.source} was refused: ${error instanceof Error ? error.message : String(error)}` })
      }
    }
    const secrets = (globalThis as { Bun?: { secrets?: { get(o: { service: string; name: string }): Promise<string | null> } } }).Bun?.secrets
    let keychain = false
    if (secrets && ctx.env.ZETTA_NO_KEYCHAIN !== '1') {
      try {
        await secrets.get({ service: 'zetta3d-cli', name: '__doctor_probe__' })
        keychain = true
      } catch {
        // no secret service here (e.g. a container or a headless Linux box)
      }
    }
    checks.push({ check: 'keychain', ok: true, detail: keychain ? 'system keychain available' : 'no system keychain here; tokens go to the credentials file (0600)' })
    checks.push(skillCheck(ctx))
    checks.push(await updateCheck(ctx))
    const failing = checks.filter((c) => !c.ok)
    return { ok: failing.length === 0, checks, ...(failing.length ? { exitCode: 1 } : {}) }
  },
  text: (r: { checks: Check[] }) => r.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.check.padEnd(11)} ${c.detail}`).join('\n'),
})

export const completionCommand = defineCommand({
  path: ['completion'],
  summary: 'Print a shell completion script (bash, zsh or fish).',
  description: 'Add to your shell, e.g.: zetta completion zsh > ~/.zsh/completions/_zetta',
  kind: 'local',
  mcp: false,
  positionals: [{ name: 'shell', required: true }],
  input: z.object({ shell: z.enum(['bash', 'zsh', 'fish']).describe('Your shell.') }),
  async run(_ctx, input) {
    const tree = new Map<string, Set<string>>()
    for (const command of registry.commands) {
      const [first, second] = command.path
      if (!tree.has(first!)) tree.set(first!, new Set())
      if (second) tree.get(first!)!.add(second)
    }
    const top = [...tree.keys()].join(' ')
    if (input.shell === 'fish') {
      const lines = [`complete -c zetta -f -n '__fish_use_subcommand' -a '${top}'`]
      for (const [group, subs] of tree) if (subs.size) lines.push(`complete -c zetta -f -n '__fish_seen_subcommand_from ${group}' -a '${[...subs].join(' ')}'`)
      return { script: lines.join('\n') }
    }
    const cases = [...tree].filter(([, subs]) => subs.size).map(([group, subs]) => `    ${group}) words="${[...subs].join(' ')}" ;;`).join('\n')
    const bash = `_zetta() {\n  local cur=\${COMP_WORDS[COMP_CWORD]} words="${top}"\n  if [ "$COMP_CWORD" -ge 2 ]; then\n  case "\${COMP_WORDS[1]}" in\n${cases}\n    *) words="" ;;\n  esac\n  fi\n  COMPREPLY=( $(compgen -W "$words" -- "$cur") )\n}\ncomplete -F _zetta zetta`
    return { script: input.shell === 'zsh' ? `#compdef zetta\nautoload -U bashcompinit && bashcompinit\n${bash}` : bash }
  },
  text: (r: { script: string }) => r.script,
})

export const metaCommands = [commandsCommand, schemaCommand, guideCommand, exitCodesCommand, doctorCommand, completionCommand]
