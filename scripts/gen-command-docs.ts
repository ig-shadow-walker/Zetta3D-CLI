/**
 * Writes docs/COMMANDS.md from the command definitions, so the reference never drifts from the code.
 * Run with `bun run docs:commands`.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { COMMANDS, GROUPS } from '../packages/cli/src/commands'
import { fieldsOf, kebab, type AnyCommand } from '../packages/cli/src/core/define'
import { EXIT_CODE_TABLE } from '../packages/cli/src/core/exit-codes'
import { toolName } from '../packages/cli/src/mcp/server'
import { AGENT_GUIDE } from '../packages/cli/src/guide'

const KIND: Record<string, string> = {
  read: 'reads only',
  write: 'changes something (free)',
  spend: '**spends credits**',
  destructive: '**destructive**',
  local: 'local only',
}

function usage(command: AnyCommand): string {
  const args = (command.positionals ?? []).map((p) => (p.required ? `<${kebab(p.name)}${p.variadic ? '...' : ''}>` : `[${kebab(p.name)}${p.variadic ? '...' : ''}]`))
  return ['zetta', ...command.path, ...args, '[flags]'].join(' ')
}

function section(command: AnyCommand): string {
  const lines = [`### \`zetta ${command.path.join(' ')}\``, '', command.summary, '']
  if (command.description) lines.push(command.description.split('\n').map((l) => (l.startsWith('  ') ? `    ${l.trim()}` : l)).join('\n'), '')
  lines.push('```', usage(command), '```', '')
  lines.push(`Kind: ${KIND[command.kind]}${command.mcp === false || command.kind === 'local' ? ' · not an MCP tool' : ` · MCP tool \`${toolName(command)}\``}`, '')
  const positional = new Set((command.positionals ?? []).map((p) => p.name))
  const fields = fieldsOf(command)
  if (fields.length) {
    lines.push('| Argument / flag | Type | Description |', '|---|---|---|')
    for (const field of fields) {
      const name = positional.has(field.key) ? `\`<${kebab(field.key)}>\`` : `\`--${kebab(field.key)}\``
      const type = field.type === 'enum' ? field.values!.map((v) => `\`${v}\``).join(' \\| ') : field.type === 'array' ? `${field.itemType} (repeatable)` : field.type
      const extra = [field.optional ? '' : '**required**', field.defaultValue !== undefined ? `default \`${String(field.defaultValue)}\`` : ''].filter(Boolean).join(', ')
      lines.push(`| ${name} | ${type} | ${(field.description ?? '').replace(/\|/g, '\\|')}${extra ? ` (${extra})` : ''} |`)
    }
    lines.push('')
  }
  if (command.examples?.length) lines.push('Examples:', '', '```bash', ...command.examples, '```', '')
  return lines.join('\n')
}

const out: string[] = [
  '# Command reference',
  '',
  '_Generated from the command definitions by `bun run docs:commands`. Do not edit by hand._',
  '',
  'Global flags: `--output text|json|ndjson`, `--json`, `--profile <name>`, `--api-url <url>`, `--verbose`, `--quiet`, `--no-color`, `--non-interactive`. Every command also takes `--input <json|@file|->`.',
  '',
  '## Exit codes',
  '',
  '| Code | Meaning |',
  '|---|---|',
  ...EXIT_CODE_TABLE.map((e) => `| ${e.code} | ${e.meaning} |`),
  '',
]

const topLevel = COMMANDS.filter((c) => c.path.length === 1)
for (const group of GROUPS) {
  const members = COMMANDS.filter((c) => c.path[0] === group.name && c.path.length > 1)
  if (!members.length) continue
  out.push(`## ${group.name}`, '', group.summary, '', ...members.map(section))
}
out.push('## Other commands', '', ...topLevel.map(section))

mkdirSync(join(import.meta.dir, '..', 'docs'), { recursive: true })
writeFileSync(join(import.meta.dir, '..', 'docs', 'COMMANDS.md'), `${out.join('\n').replace(/\n{3,}/g, '\n\n')}\n`)

const skill = [
  '---',
  'name: zetta3d',
  'description: Make and edit 3D models with the Zetta 3D CLI — text or pictures to 3D, retopology, segmentation, UVs, texturing, rigging, format conversion, splat worlds, image generation and pipelines. Use when the user wants a 3D asset made, changed, downloaded or exported, or asks about their Zetta 3D account, credits or library.',
  '---',
  '',
  AGENT_GUIDE.trim(),
  '',
  'Full command reference: run `zetta commands --json`, or see docs/COMMANDS.md.',
  '',
].join('\n')
mkdirSync(join(import.meta.dir, '..', 'skill'), { recursive: true })
writeFileSync(join(import.meta.dir, '..', 'skill', 'SKILL.md'), skill)
console.log(`Wrote docs/COMMANDS.md (${COMMANDS.length} commands) and skill/SKILL.md.`)
