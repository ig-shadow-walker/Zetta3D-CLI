import { readFileSync } from 'node:fs'
import { Command, CommanderError, Option } from 'commander'
import { ZettaError } from '@zetta3d/sdk'
import type { z } from 'zod'
import { VERSION } from '../version'
import { Context, type ContextOptions, type GlobalOptions } from './context'
import { fieldsOf, kebab, type AnyCommand, type FieldInfo } from './define'
import { usageError } from './errors'
import { ExitCode } from './exit-codes'
import { Output, resolveFormat } from './output'

export interface GroupInfo {
  name: string
  summary: string
}

export interface ProgramOptions extends Omit<ContextOptions, 'globals'> {
  commands: AnyCommand[]
  groups: GroupInfo[]
  /** Text shown by `zetta` with no arguments. */
  intro?: string
}

const collect = (value: string, previous: string[] = []) => [...previous, value]

/** Keys taken by global flags; a command may not reuse them. */
const GLOBAL_KEYS = new Set(['output', 'json', 'profile', 'apiUrl', 'verbose', 'quiet', 'color', 'nonInteractive', 'version', 'help', 'input'])

/**
 * Builds the commander program from command definitions and runs it.
 * Returns the exit code instead of exiting, so tests can drive it.
 */
export async function runProgram(argv: string[], options: ProgramOptions): Promise<number> {
  const streams = options.streams ?? { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin }
  let exitCode: number = ExitCode.OK
  let globalsSeen: GlobalOptions = {}

  const program = new Command('zetta')
    .description('Zetta 3D from the terminal — generate, refine and manage 3D assets. Built for people and AI agents.')
    .version(VERSION, '-v, --version', 'Print the version.')
    .addOption(new Option('-o, --output <format>', 'Output format. Default: text in a terminal, JSON when piped.').choices(['text', 'json', 'ndjson']))
    .option('--json', 'Shorthand for --output json.')
    .option('--profile <name>', 'Use another saved profile (e.g. local).')
    .option('--api-url <url>', 'Override the API address for this command.')
    .option('--verbose', 'Show each API request on stderr.')
    .option('-q, --quiet', 'Print only the result.')
    .option('--no-color', 'Disable colours.')
    .option('--non-interactive', 'Never prompt; fail instead (implied in CI and with ZETTA_NON_INTERACTIVE=1).')
    .showHelpAfterError(false)
    .exitOverride()
    .configureOutput({
      writeOut: (text) => streams.stdout.write(text),
      writeErr: (text) => streams.stderr.write(text),
      outputError: () => undefined,
    })

  if (options.intro) program.addHelpText('after', `\n${options.intro}`)

  const groups = new Map<string, Command>()
  const groupFor = (name: string): Command => {
    let group = groups.get(name)
    if (!group) {
      const info = options.groups.find((g) => g.name === name)
      group = program.command(name).description(info?.summary ?? '').exitOverride()
      group.configureOutput({ writeOut: (t) => streams.stdout.write(t), writeErr: (t) => streams.stderr.write(t), outputError: () => undefined })
      groups.set(name, group)
    }
    return group
  }

  for (const command of options.commands) {
    const [first, ...rest] = command.path
    const parent = rest.length ? groupFor(first!) : program
    // Nested paths deeper than two levels (`run step retry`) hang off an intermediate group.
    let host = parent
    for (const segment of rest.slice(0, -1)) {
      const key = `${command.path[0]} ${segment}`
      let sub = groups.get(key)
      if (!sub) {
        sub = host.command(segment).description(options.groups.find((g) => g.name === key)?.summary ?? '').exitOverride()
        groups.set(key, sub)
      }
      host = sub
    }
    const name = rest.length ? rest.at(-1)! : first!
    const cmd = host.command(name).description(command.summary).exitOverride()
    cmd.configureOutput({ writeOut: (t) => streams.stdout.write(t), writeErr: (t) => streams.stderr.write(t), outputError: () => undefined })
    if (command.description) cmd.addHelpText('after', `\n${command.description}`)
    if (command.examples?.length) cmd.addHelpText('after', `\nExamples:\n${command.examples.map((e) => `  $ ${e}`).join('\n')}`)

    const fields = fieldsOf(command)
    const clash = fields.find((f) => GLOBAL_KEYS.has(f.key))
    if (clash) throw new Error(`zetta ${command.path.join(' ')}: --${kebab(clash.key)} clashes with a global flag.`)
    const positionalNames = new Set((command.positionals ?? []).map((p) => p.name))
    // Arguments are optional to the parser so `--input '{...}'` can supply them; the schema enforces them.
    const usage: string[] = []
    for (const positional of command.positionals ?? []) {
      const field = fields.find((f) => f.key === positional.name)
      const label = positional.variadic ? `${kebab(positional.name)}...` : kebab(positional.name)
      cmd.argument(`[${label}]`, field?.description ?? '')
      usage.push(positional.required ? `<${label}>` : `[${label}]`)
    }
    cmd.usage([...usage, '[options]'].join(' '))
    for (const field of fields) {
      if (positionalNames.has(field.key)) continue
      for (const option of optionsFor(field, command.short?.[field.key], command.negatable?.includes(field.key) ?? false)) cmd.addOption(option)
    }
    cmd.option('--input <json>', 'All inputs as a JSON object, @file.json, or - for stdin. Flags override it.')

    cmd.action(async (...args: unknown[]) => {
      const self = args.at(-1) as Command
      const opts = self.opts<Record<string, unknown>>()
      const globals = self.optsWithGlobals<GlobalOptions & Record<string, unknown>>()
      globalsSeen = globals
      const ctx = new Context({ ...options, streams, globals })
      try {
        const raw: Record<string, unknown> = {}
        if (typeof opts.input === 'string') Object.assign(raw, await readInputJson(opts.input, ctx))
        ;(command.positionals ?? []).forEach((positional, index) => {
          const value = args[index]
          if (value !== undefined && !(Array.isArray(value) && value.length === 0)) raw[positional.name] = value
        })
        for (const field of fields) {
          if (positionalNames.has(field.key)) continue
          const value = opts[field.key]
          if (value !== undefined) raw[field.key] = value
        }
        const input = parseInput(command, raw, fields)
        const data = await command.run(ctx, input)
        if (data !== undefined) ctx.out.result(data, command.text ? (d) => command.text!(d as never, ctx) : undefined)
        exitCode = (data as { exitCode?: number } | undefined)?.exitCode ?? ExitCode.OK
      } catch (error) {
        exitCode = ctx.out.error(error)
      }
    })
  }

  try {
    if (argv.length === 0) {
      streams.stdout.write(`${program.helpInformation()}${options.intro ? `\n${options.intro}\n` : ''}`)
      return ExitCode.OK
    }
    await program.parseAsync(argv, { from: 'user' })
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version' || error.code === 'commander.help') return ExitCode.OK
      // A group name on its own (`zetta asset`) shows that group's help.
      if (error.code === 'commander.executeSubCommandAsync' || error.exitCode === 0) return ExitCode.OK
      const format = resolveFormat(
        globalsSeen.json ? 'json' : globalsSeen.output ?? flagValue(argv, '--output') ?? flagValue(argv, '-o') ?? (argv.includes('--json') ? 'json' : undefined),
        process.env.ZETTA_OUTPUT,
        undefined,
        Boolean(streams.stdout.isTTY),
      )
      const out = new Output(format, streams, { color: false, quiet: false, verbose: false })
      return out.error(usageError(cleanCommanderMessage(error.message), { hint: 'Run `zetta --help`, or `zetta <command> --help`.' }))
    }
    throw error
  }
  return exitCode
}

function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag)
  return index >= 0 ? argv[index + 1] : argv.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1)
}

function cleanCommanderMessage(message: string): string {
  return message.replace(/^error:\s*/i, '').replace(/\.$/, '') + '.'
}

function optionsFor(field: FieldInfo, short: string | undefined, negatable: boolean): Option[] {
  const flag = kebab(field.key)
  const describe = (text: string | undefined) => {
    const parts = [text ?? '']
    if (field.type === 'enum' && field.values) parts.push(`One of: ${field.values.join(', ')}.`)
    if (field.defaultValue !== undefined && field.type !== 'boolean') parts.push(`Default: ${String(field.defaultValue)}.`)
    if (field.type === 'array') parts.push('Repeat the flag or separate values with commas.')
    return parts.filter(Boolean).join(' ')
  }
  const prefix = short ? `-${short}, ` : ''
  if (field.type === 'boolean') {
    const options = [new Option(`${prefix}--${flag}`, describe(field.description))]
    if (field.defaultValue === true || field.key === 'wait' || negatable) {
      options.push(new Option(`--no-${flag}`, field.key === 'wait' ? 'Do not wait (overrides the configured default).' : `Turn off --${flag}.`))
    }
    return options
  }
  const placeholder = field.type === 'number' ? 'n' : field.type === 'array' ? 'value' : field.type === 'enum' ? 'choice' : 'value'
  const option = new Option(`${prefix}--${flag} <${placeholder}>`, describe(field.description))
  if (field.type === 'array') option.argParser(collect)
  return [option]
}

async function readInputJson(value: string, ctx: Context): Promise<Record<string, unknown>> {
  let text = value
  if (value === '-') text = await ctx.readStdin()
  else if (value.startsWith('@')) {
    try {
      text = readFileSync(value.slice(1), 'utf8')
    } catch {
      throw usageError(`Could not read ${value.slice(1)}.`)
    }
  }
  try {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    return parsed as Record<string, unknown>
  } catch {
    throw usageError('--input must be a JSON object (or @file.json, or - for stdin).')
  }
}

/** Coerces flag strings to the schema's types, then validates with the command's zod schema. */
export function parseInput(command: AnyCommand, raw: Record<string, unknown>, fields: FieldInfo[] = fieldsOf(command)): Record<string, unknown> {
  const coerced: Record<string, unknown> = { ...raw }
  for (const field of fields) {
    const value = raw[field.key]
    if (value === undefined) continue
    coerced[field.key] = coerce(field, value)
  }
  const result = (command.input as z.ZodObject).strict().safeParse(coerced)
  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const key = String(issue.path[0] ?? '')
      const isPositional = command.positionals?.some((p) => p.name === key)
      const where = key ? (isPositional ? `<${kebab(key)}>` : `--${kebab(key)}`) : 'input'
      if (issue.code === 'unrecognized_keys') return `${where}: unknown ${issue.keys.map((k) => `"${k}"`).join(', ')}`
      return `${where}: ${issue.message}`
    })
    throw new ZettaError({ code: 'USAGE', message: problems.join('; '), details: { problems } })
  }
  return result.data as Record<string, unknown>
}

function coerce(field: FieldInfo, value: unknown): unknown {
  if (field.type === 'number' && typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : value
  }
  if (field.type === 'boolean' && typeof value === 'string') {
    if (['true', '1', 'yes'].includes(value.toLowerCase())) return true
    if (['false', '0', 'no'].includes(value.toLowerCase())) return false
  }
  if (field.type === 'array') {
    const list = (Array.isArray(value) ? value : [value]).flatMap((v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : [v]))
    return field.itemType === 'number' ? list.map((v) => (typeof v === 'string' ? Number(v) : v)) : list
  }
  return value
}
