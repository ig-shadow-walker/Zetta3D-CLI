import { ZettaError } from '@zetta3d/sdk'
import { exitCodeFor } from './exit-codes'
import { hintFor } from './hints'
import { ownMessage, sanitizeDetails } from './sanitize'

export type OutputFormat = 'text' | 'json' | 'ndjson'

export interface Streams {
  stdout: { write(chunk: string): unknown; isTTY?: boolean }
  stderr: { write(chunk: string): unknown; isTTY?: boolean }
}

export interface ProgressInput {
  stage: string
  message: string
  [key: string]: unknown
}

export interface ProgressEvent extends ProgressInput {
  type: 'progress'
}

export interface ErrorEnvelope {
  error: { code: string; message: string; status: number; details: Record<string, unknown>; hint?: string; exitCode: number }
}

/** Everything the CLI prints goes through here, so text, JSON and NDJSON stay consistent. */
export class Output {
  private lastProgressWasLine = false

  constructor(
    readonly format: OutputFormat,
    private readonly streams: Streams,
    readonly options: { color: boolean; quiet: boolean; verbose: boolean; onProgress?: (event: ProgressEvent) => void },
  ) {}

  get isText(): boolean {
    return this.format === 'text'
  }

  /** The command's result: one JSON document, one NDJSON `result` line, or text. */
  result(data: unknown, render?: (data: never) => string | undefined): void {
    this.clearProgress()
    if (this.format === 'json') {
      this.streams.stdout.write(`${JSON.stringify(data ?? null, null, 2)}\n`)
      return
    }
    if (this.format === 'ndjson') {
      this.streams.stdout.write(`${JSON.stringify({ type: 'result', data: data ?? null })}\n`)
      return
    }
    const text = render ? render(data as never) : defaultText(data)
    if (text) this.streams.stdout.write(text.endsWith('\n') ? text : `${text}\n`)
  }

  /** Progress: an NDJSON event on stdout, a status line on stderr in text mode, nothing in JSON mode. */
  progress(event: ProgressInput): void {
    this.options.onProgress?.({ type: 'progress', ...event })
    if (this.format === 'ndjson') {
      this.streams.stdout.write(`${JSON.stringify({ type: 'progress', ...event })}\n`)
      return
    }
    if (this.format !== 'text' || this.options.quiet) return
    const line = `${this.dim('›')} ${event.message}`
    if (this.streams.stderr.isTTY) {
      this.streams.stderr.write(`\r\x1b[2K${line}`)
      this.lastProgressWasLine = true
    } else {
      this.streams.stderr.write(`${line}\n`)
    }
  }

  /** A note for people (stderr). Suppressed with --quiet and in JSON modes unless it is a warning. */
  info(message: string): void {
    if (this.options.quiet || this.format !== 'text') return
    this.clearProgress()
    this.streams.stderr.write(`${message}\n`)
  }

  warn(message: string): void {
    this.clearProgress()
    if (this.format === 'ndjson') {
      this.streams.stdout.write(`${JSON.stringify({ type: 'warning', message })}\n`)
      return
    }
    if (this.format === 'json') {
      this.streams.stderr.write(`${JSON.stringify({ warning: message })}\n`)
      return
    }
    this.streams.stderr.write(`${this.yellow('warning:')} ${message}\n`)
  }

  debug(message: string): void {
    if (!this.options.verbose) return
    this.clearProgress()
    this.streams.stderr.write(`${this.dim(`debug: ${message}`)}\n`)
  }

  /** Prints an error in the active format and returns the exit code to use. */
  error(error: unknown): number {
    this.clearProgress()
    const envelope = toErrorEnvelope(error)
    if (this.format === 'text') {
      const { message, hint, code } = envelope.error
      this.streams.stderr.write(`${this.red('Error:')} ${message}${this.dim(` (${code})`)}\n`)
      const extra = describeDetails(envelope.error.details)
      if (extra) this.streams.stderr.write(`${extra}\n`)
      if (hint) this.streams.stderr.write(`${this.dim('hint:')} ${hint}\n`)
    } else if (this.format === 'ndjson') {
      this.streams.stdout.write(`${JSON.stringify({ type: 'error', ...envelope })}\n`)
    } else {
      this.streams.stderr.write(`${JSON.stringify(envelope)}\n`)
    }
    return envelope.error.exitCode
  }

  private clearProgress(): void {
    if (this.lastProgressWasLine) {
      this.streams.stderr.write('\r\x1b[2K')
      this.lastProgressWasLine = false
    }
  }

  bold(text: string): string {
    return this.options.color ? `\x1b[1m${text}\x1b[22m` : text
  }
  dim(text: string): string {
    return this.options.color ? `\x1b[2m${text}\x1b[22m` : text
  }
  red(text: string): string {
    return this.options.color ? `\x1b[31m${text}\x1b[39m` : text
  }
  green(text: string): string {
    return this.options.color ? `\x1b[32m${text}\x1b[39m` : text
  }
  yellow(text: string): string {
    return this.options.color ? `\x1b[33m${text}\x1b[39m` : text
  }
}

export function toErrorEnvelope(error: unknown): ErrorEnvelope {
  if (error instanceof ZettaError) {
    const hint = (error.details.hint as string | undefined) ?? hintFor(error.code)
    const details = sanitizeDetails(error.details)
    delete details.hint
    return {
      error: {
        code: error.code,
        message: ownMessage(error.code) ?? error.message,
        status: error.status,
        details,
        ...(hint ? { hint } : {}),
        exitCode: exitCodeFor(error.code, error.status),
      },
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { error: { code: 'UNEXPECTED', message, status: 0, details: {}, exitCode: 1 } }
}

function describeDetails(details: Record<string, unknown>): string | undefined {
  const lines: string[] = []
  if (typeof details.required === 'number' && typeof details.available === 'number') {
    lines.push(`  needs ${details.required} credits, ${details.available} available`)
  }
  const problems = (details.problems ?? details.violations) as unknown
  if (Array.isArray(problems)) {
    for (const p of problems.slice(0, 10)) {
      if (typeof p === 'string') lines.push(`  - ${p}`)
      else if (p && typeof p === 'object') {
        const r = p as Record<string, unknown>
        const where = r.field ? `${String(r.field)}: ` : r.nodeId ? `${String(r.nodeId)}: ` : ''
        lines.push(`  - ${where}${String(r.message ?? r.code ?? '')}`)
      }
    }
  }
  return lines.length ? lines.join('\n') : undefined
}

/** A readable fallback for results without their own renderer. */
export function defaultText(data: unknown, indent = ''): string {
  if (data === undefined || data === null) return ''
  if (typeof data !== 'object') return `${indent}${String(data)}`
  if (Array.isArray(data)) {
    if (!data.length) return `${indent}(none)`
    if (data.every((row) => row && typeof row === 'object' && !Array.isArray(row))) return table(data as Array<Record<string, unknown>>)
    return data.map((item) => `${indent}- ${scalar(item)}`).join('\n')
  }
  return Object.entries(data as Record<string, unknown>)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) return `${indent}${key}:\n${defaultText(value, `${indent}  `)}`
      return `${indent}${key}: ${scalar(value)}`
    })
    .join('\n')
}

function scalar(value: unknown): string {
  if (value === null || value === undefined) return '-'
  if (Array.isArray(value)) return value.map(scalar).join(', ')
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** A plain aligned table. `columns` picks and orders keys; values are stringified. */
export function table(rows: Array<Record<string, unknown>>, columns?: Array<string | [key: string, header: string]>): string {
  if (!rows.length) return '(none)'
  const cols = (columns ?? Object.keys(rows[0]!)).map((c) => (Array.isArray(c) ? c : [c, c] as [string, string]))
  const cells = rows.map((row) => cols.map(([key]) => truncate(scalar(row[key]), 60)))
  const widths = cols.map(([, header], i) => Math.max(header.length, ...cells.map((r) => r[i]!.length)))
  const line = (values: string[]) => values.map((v, i) => v.padEnd(widths[i]!)).join('  ').trimEnd()
  return [line(cols.map(([, h]) => h.toUpperCase())), ...cells.map(line)].join('\n')
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export function resolveFormat(flag: string | undefined, env: string | undefined, config: string | undefined, stdoutIsTTY: boolean): OutputFormat {
  const pick = flag ?? env ?? config
  if (pick === 'text' || pick === 'json' || pick === 'ndjson') return pick
  return stdoutIsTTY ? 'text' : 'json'
}
