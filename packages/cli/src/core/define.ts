import { z } from 'zod'
import type { Context } from './context'

/**
 * What a command does to the account. It drives confirmation, MCP tool annotations and docs:
 * - `read`: looks only. - `write`: changes something, free. - `spend`: costs credits.
 * - `destructive`: deletes or cancels. - `local`: never talks to the API.
 */
export type CommandKind = 'read' | 'write' | 'spend' | 'destructive' | 'local'

export interface Positional {
  /** Must be a key of `input`. */
  name: string
  required?: boolean
  variadic?: boolean
}

export interface CommandDef<S extends z.ZodObject = z.ZodObject> {
  /** e.g. ['asset', 'list'] → `zetta asset list`, MCP tool `asset_list`. */
  path: string[]
  summary: string
  description?: string
  positionals?: Positional[]
  input: S
  /** Single-letter aliases: `{ prompt: 'p' }`. */
  short?: Record<string, string>
  /** Boolean flags that also get a `--no-…` form (flags defaulting to true get one automatically). */
  negatable?: string[]
  kind: CommandKind
  /** Needs a signed-in account (default: true unless `local`). */
  auth?: boolean
  /** Offer it as an MCP tool (default true). */
  mcp?: boolean
  examples?: string[]
  run: (ctx: Context, input: z.output<S>) => Promise<unknown>
  /** Human rendering of the result; JSON output ignores it. */
  text?: (data: never, ctx: Context) => string | undefined
}

// The registry is heterogeneous; inputs are validated by each command's own schema at run time.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyCommand = CommandDef<any>

export function defineCommand<S extends z.ZodObject>(def: CommandDef<S>): CommandDef<S> {
  return def
}

/** Flags every paid command accepts. */
export const spendShape = {
  yes: z.boolean().optional().describe('Spend without asking. Needed when not in a terminal, unless --max-credits covers the price.'),
  maxCredits: z.number().int().min(0).optional().describe('Refuse if this would cost more than this many credits.'),
  dryRun: z.boolean().optional().describe('Show the price and stop. Nothing is spent.'),
  idempotencyKey: z.string().min(8).max(128).optional().describe('Reuse the same key to retry a command without paying twice.'),
}

/** Flags of commands that start remote jobs. */
export const waitShape = {
  wait: z.boolean().optional().describe('Wait for the job to finish (default: return at once with its id).'),
  timeout: z.string().optional().describe('With --wait, stop waiting after this long, e.g. 90s, 10m. The job keeps running.'),
  out: z.string().optional().describe('Download the results into this folder when done (implies --wait).'),
}

export const pageShape = {
  page: z.number().int().min(1).optional().describe('Page number (starts at 1).'),
  limit: z.number().int().min(1).max(100).optional().describe('Items per page (max 100).'),
}

/** Parses 90, 90s, 10m, 1h, 1h30m into milliseconds. */
export function parseDuration(text: string | undefined): number | undefined {
  if (text === undefined || text === '') return undefined
  const trimmed = text.trim().toLowerCase()
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed) * 1000
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/g
  let total = 0
  let matched = ''
  for (const match of trimmed.matchAll(re)) {
    const value = Number(match[1])
    total += value * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const)[match[2] as 'ms' | 's' | 'm' | 'h']
    matched += match[0]
  }
  if (!matched || matched !== trimmed) return Number.NaN
  return total
}

export interface FieldInfo {
  key: string
  type: 'boolean' | 'number' | 'string' | 'enum' | 'array'
  itemType?: 'string' | 'number'
  values?: string[]
  optional: boolean
  defaultValue?: unknown
  description?: string
}

type ZodInternal = { _zod: { def: { type: string; innerType?: ZodInternal; element?: ZodInternal; defaultValue?: unknown; entries?: Record<string, string> } }; description?: string }

/** Reads what the CLI needs to know about one input field from its zod schema. */
export function fieldInfo(key: string, schema: z.ZodType): FieldInfo {
  let node = schema as unknown as ZodInternal
  let optional = false
  let defaultValue: unknown
  const description = node.description
  for (;;) {
    const def = node._zod.def
    if (def.type === 'optional' || def.type === 'nullable') {
      optional = true
      node = def.innerType!
    } else if (def.type === 'default' || def.type === 'prefault') {
      optional = true
      defaultValue = typeof def.defaultValue === 'function' ? (def.defaultValue as () => unknown)() : def.defaultValue
      node = def.innerType!
    } else break
  }
  const def = node._zod.def
  const info: FieldInfo = { key, type: 'string', optional, defaultValue, description: description ?? node.description }
  if (def.type === 'boolean') info.type = 'boolean'
  else if (def.type === 'number' || def.type === 'int') info.type = 'number'
  else if (def.type === 'enum') {
    info.type = 'enum'
    info.values = Object.values(def.entries ?? {})
  } else if (def.type === 'array') {
    info.type = 'array'
    info.itemType = def.element?._zod.def.type === 'number' ? 'number' : 'string'
  }
  return info
}

export function fieldsOf(command: AnyCommand): FieldInfo[] {
  return Object.entries(command.input.shape as Record<string, z.ZodType>).map(([key, schema]) => fieldInfo(key, schema))
}

export function kebab(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z])([A-Z][a-z])/g, '$1-$2').toLowerCase()
}

/** JSON Schema of a command's input, as agents and MCP clients see it. */
export function inputJsonSchema(command: AnyCommand): Record<string, unknown> {
  const schema = z.toJSONSchema(command.input, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>
  delete schema.$schema
  return schema
}
