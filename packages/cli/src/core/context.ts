import { createInterface } from 'node:readline/promises'
import { ZettaClient, ZettaError, tokenExpiry } from '@zetta3d/sdk'
import { VERSION } from '../version'
import { ConfigStore, type Profile } from './config'
import { CredentialStore, type CredentialSource, type StoredCredential } from './credentials'
import { cliError } from './errors'
import { Output, resolveFormat, type OutputFormat, type ProgressEvent, type Streams } from './output'
import { configDir } from './paths'

export interface GlobalOptions {
  output?: string
  json?: boolean
  profile?: string
  apiUrl?: string
  verbose?: boolean
  quiet?: boolean
  color?: boolean
  /** `--non-interactive`: never prompt, even in a terminal. */
  nonInteractive?: boolean
}

export interface ContextOptions {
  globals?: GlobalOptions
  env?: NodeJS.ProcessEnv
  streams?: Streams & { stdin?: NodeJS.ReadableStream & { isTTY?: boolean } }
  mode?: 'cli' | 'mcp'
  fetch?: typeof fetch
  signal?: AbortSignal
  /** MCP sessions spend from a budget fixed when the server starts. */
  budget?: { remaining: number }
  /** Receives every progress event (MCP turns them into progress notifications). */
  onProgress?: (event: ProgressEvent) => void
}

export const USER_AGENT = `zetta-cli/${VERSION} (${process.platform}; ${process.arch})`

/** Everything a command needs: config, credentials, output and API clients. */
export class Context {
  readonly env: NodeJS.ProcessEnv
  readonly mode: 'cli' | 'mcp'
  readonly config: ConfigStore
  readonly credentials: CredentialStore
  readonly profileName: string
  readonly profile: Profile
  readonly out: Output
  readonly signal: AbortSignal | undefined
  readonly budget: { remaining: number } | undefined
  private readonly streams: NonNullable<ContextOptions['streams']>
  private readonly fetchImpl: typeof fetch | undefined
  private readonly noInput: boolean
  private clientCache: ZettaClient | undefined

  constructor(options: ContextOptions = {}) {
    this.env = options.env ?? process.env
    this.mode = options.mode ?? 'cli'
    this.streams = options.streams ?? { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin }
    this.fetchImpl = options.fetch
    this.signal = options.signal
    this.budget = options.budget
    const globals = options.globals ?? {}
    const dir = configDir(this.env)
    this.config = new ConfigStore(dir)
    this.credentials = new CredentialStore(dir, this.env)
    const resolved = this.config.resolveProfile(globals.profile, this.env)
    this.profileName = resolved.name
    this.profile = globals.apiUrl ? { ...resolved.profile, apiUrl: globals.apiUrl } : resolved.profile

    const format: OutputFormat =
      this.mode === 'mcp'
        ? 'json'
        : resolveFormat(globals.json ? 'json' : globals.output, this.env.ZETTA_OUTPUT, this.config.file.output, Boolean(this.streams.stdout.isTTY))
    const color = globals.color !== false && !this.env.NO_COLOR && Boolean(this.streams.stderr.isTTY) && format === 'text'
    this.out = new Output(format, this.streams, { color, quiet: Boolean(globals.quiet), verbose: Boolean(globals.verbose), ...(options.onProgress ? { onProgress: options.onProgress } : {}) })
    this.noInput = globals.nonInteractive === true || this.env.ZETTA_NON_INTERACTIVE === '1' || this.env.CI === 'true'
  }

  /** True when a person can answer prompts: a terminal on both ends, and not `--non-interactive`. */
  get interactive(): boolean {
    return this.mode === 'cli' && !this.noInput && Boolean(this.streams.stdin?.isTTY) && Boolean(this.streams.stderr.isTTY)
  }

  get canOpenBrowser(): boolean {
    if (this.mode !== 'cli' || this.noInput) return false
    if (process.platform === 'linux' && !this.env.DISPLAY && !this.env.WAYLAND_DISPLAY) return false
    return !this.env.SSH_CONNECTION && !this.env.SSH_TTY
  }

  async storedCredential(): Promise<{ credential: StoredCredential; source: CredentialSource } | undefined> {
    return this.credentials.get(this.profileName)
  }

  /** An API client signed in as the current profile; throws NOT_LOGGED_IN when there is no token. */
  async client(): Promise<ZettaClient> {
    if (this.clientCache) return this.clientCache
    const stored = await this.storedCredential()
    if (!stored) {
      throw cliError('NOT_LOGGED_IN', `Not signed in${this.profileName === 'default' ? '' : ` (profile "${this.profileName}")`}.`)
    }
    const expiry = stored.credential.expiresAt ? new Date(stored.credential.expiresAt) : tokenExpiry(stored.credential.token)
    if (expiry && expiry.getTime() < Date.now()) {
      throw new ZettaError({ code: 'INVALID_SESSION', message: 'Your sign-in has expired.', status: 401 })
    }
    this.clientCache = this.makeClient(stored.credential.token)
    return this.clientCache
  }

  /** A client without a token, for public routes and signing in. */
  publicClient(): ZettaClient {
    return this.makeClient(undefined)
  }

  makeClient(token: string | undefined): ZettaClient {
    return new ZettaClient({
      baseUrl: this.profile.apiUrl,
      token,
      clientName: this.mode === 'mcp' ? 'cli-mcp' : 'cli',
      userAgent: USER_AGENT,
      ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
      onRequest: ({ method, url, attempt }) => this.out.debug(`${method} ${url}${attempt > 1 ? ` (attempt ${attempt})` : ''}`),
    })
  }

  async confirm(question: string): Promise<boolean> {
    if (!this.interactive) return false
    const answer = (await this.ask(`${question} [y/N] `)).trim().toLowerCase()
    return answer === 'y' || answer === 'yes'
  }

  async ask(question: string): Promise<string> {
    if (!this.interactive || !this.streams.stdin) throw cliError('USAGE', 'Input is needed but there is no terminal to ask in.')
    const rl = createInterface({ input: this.streams.stdin, output: this.streams.stderr as NodeJS.WritableStream, terminal: true })
    try {
      return await rl.question(question)
    } finally {
      rl.close()
    }
  }

  /** Reads all of stdin (for `--with-token`, `--input -`). */
  async readStdin(): Promise<string> {
    const stdin = this.streams.stdin
    if (!stdin) return ''
    const chunks: Buffer[] = []
    for await (const chunk of stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer))
    return Buffer.concat(chunks).toString('utf8')
  }
}
