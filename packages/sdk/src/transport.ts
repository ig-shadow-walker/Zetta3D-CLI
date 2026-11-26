import { LocalErrorCodes, ZettaError, errorFromResponse } from './errors'

export const DEFAULT_API_URL = 'https://api.zetta3d.ai/api'

export type QueryValue = string | number | boolean | null | undefined
export type QueryInput = Record<string, QueryValue | QueryValue[]>

/**
 * Builds a query string the API accepts.
 *
 * Arrays repeat the key (`status=a&status=b`) — the server rejects `status[]=`. Empty values
 * are dropped rather than sent, because unknown or empty keys can fail validation.
 */
export function toQuery(query: QueryInput | undefined): string {
  if (!query) return ''
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    const values = Array.isArray(value) ? value : [value]
    for (const v of values) {
      if (v === undefined || v === null || v === '') continue
      params.append(key, String(v))
    }
  }
  const text = params.toString()
  return text ? `?${text}` : ''
}

/**
 * A session token (from the browser hand-off or an emailed link) or an API key (`zk_live_…`).
 * Both are sent as `Authorization: Bearer …`; the server tells them apart by the `zk_` prefix.
 */
export type TokenSource = string | undefined | (() => string | undefined | Promise<string | undefined>)

export interface RetryInfo {
  method: string
  url: string
  /** The attempt that failed. */
  attempt: number
  status: number
  /** How long the transport waits before the next attempt. */
  waitMs: number
}

export interface TransportOptions {
  baseUrl?: string
  /** A session token or an API key. */
  token?: TokenSource
  /** Sent as `X-Zetta-Client`, so usage can be attributed per client. */
  clientName?: string
  userAgent?: string
  fetch?: typeof fetch
  /** Extra attempts for retryable failures. */
  retries?: number
  /** Per-request timeout. */
  timeoutMs?: number
  /** Called for every attempt; useful for `--verbose`. Never receives the token. */
  onRequest?: (info: { method: string; url: string; attempt: number }) => void
  /** Called before waiting to retry a failed attempt (a 429 after its Retry-After, a 5xx, a dropped connection). */
  onRetry?: (info: RetryInfo) => void
  /** Wait function, replaceable in tests. */
  sleep?: (ms: number) => Promise<void>
}

export interface RequestOptions {
  query?: QueryInput
  body?: unknown
  headers?: Record<string, string>
  idempotencyKey?: string
  /** Send the Bearer token (default true). */
  auth?: boolean
  signal?: AbortSignal
  timeoutMs?: number
  /**
   * `auto` (default): retry reads, and writes only when they carry an idempotency key.
   * 429 is always retried, because the server did not process the request.
   */
  retry?: 'auto' | 'never'
}

const BACKOFF_MS = [600, 1800, 4000]
/**
 * The longest Retry-After the transport waits out by itself. A per-minute limit asks for at most a
 * minute; anything longer (an hourly limit) fails at once, with the wait in `details.retryAfter`,
 * rather than leaving a command hanging silently.
 */
const MAX_RETRY_AFTER_MS = 60_000

/** Retry-After as milliseconds (seconds or an HTTP date), uncapped. */
function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(header)
  if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  return undefined
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}

export class Transport {
  readonly baseUrl: string
  private readonly token: TokenSource
  private readonly clientName: string
  private readonly userAgent: string | undefined
  private readonly fetchImpl: typeof fetch
  private readonly retries: number
  private readonly timeoutMs: number
  private readonly onRequest: TransportOptions['onRequest']
  private readonly onRetry: TransportOptions['onRetry']
  private readonly sleep: (ms: number) => Promise<void>

  constructor(options: TransportOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_API_URL).replace(/\/+$/, '')
    this.token = options.token
    this.clientName = options.clientName ?? 'sdk'
    this.userAgent = options.userAgent
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.retries = options.retries ?? 2
    this.timeoutMs = options.timeoutMs ?? 60_000
    this.onRequest = options.onRequest
    this.onRetry = options.onRetry
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  async resolveToken(): Promise<string | undefined> {
    const source = this.token
    const value = typeof source === 'function' ? await source() : source
    return value && value.trim() ? value.trim() : undefined
  }

  url(path: string, query?: QueryInput): string {
    if (/^https?:\/\//.test(path)) return path + toQuery(query)
    return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}${toQuery(query)}`
  }

  /** Performs the request and parses the JSON body; throws `ZettaError` on any failure. */
  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.send(method, path, options)
    return (await parseBody(response)) as T
  }

  /** Like `request`, but hands back the raw `Response` (headers, cookies) after checking the status. */
  async send(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    const url = this.url(path, options.query)
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-Zetta-Client': this.clientName,
      ...options.headers,
    }
    if (this.userAgent) headers['User-Agent'] = this.userAgent
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey

    let body: string | undefined
    // A body-less POST must not declare JSON: the server answers 400 to an empty JSON body.
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(options.body)
    }

    // Credentials go to the API's own origin only, never to an absolute URL elsewhere.
    if (options.auth !== false && sameOrigin(url, this.baseUrl)) {
      const token = await this.resolveToken()
      if (token) headers.Authorization = `Bearer ${token}`
    }

    const upper = method.toUpperCase()
    const safe = upper === 'GET' || upper === 'HEAD' || upper === 'DELETE' || upper === 'PUT' || upper === 'PATCH'
    const replayable = options.retry !== 'never' && (safe || Boolean(options.idempotencyKey))
    const maxAttempts = options.retry === 'never' ? 1 : this.retries + 1

    let lastError: ZettaError | undefined
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      this.onRequest?.({ method: upper, url, attempt })
      const timeout = AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs)
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
      let response: Response
      try {
        response = await this.fetchImpl(url, { method: upper, headers, body, signal })
      } catch (cause) {
        if (options.signal?.aborted) throw cause
        const timedOut = timeout.aborted
        lastError = new ZettaError({
          code: timedOut ? LocalErrorCodes.REQUEST_TIMEOUT : LocalErrorCodes.NETWORK_ERROR,
          message: timedOut
            ? `The request to ${new URL(url).host} timed out.`
            : `Could not reach ${new URL(url).host}. Check your connection.`,
          cause,
        })
        if (replayable && attempt < maxAttempts) {
          const waitMs = BACKOFF_MS[attempt - 1] ?? 4000
          this.onRetry?.({ method: upper, url, attempt, status: 0, waitMs })
          await this.sleep(waitMs)
          continue
        }
        throw lastError
      }

      if (response.ok) return response

      const parsed = await parseBody(response).catch(() => undefined)
      const retryAfter = response.headers.get('retry-after')
      lastError = errorFromResponse(response.status, parsed, retryAfter)
      // 429 means the server did not process the request, so it is safe to repeat even a plain POST.
      const retryable = response.status === 429 || (response.status >= 500 && replayable)
      const askedWait = retryAfterMs(retryAfter)
      const tooLong = askedWait !== undefined && askedWait > MAX_RETRY_AFTER_MS
      if (retryable && !tooLong && attempt < maxAttempts) {
        const waitMs = askedWait ?? BACKOFF_MS[attempt - 1] ?? 4000
        this.onRetry?.({ method: upper, url, attempt, status: response.status, waitMs })
        await this.sleep(waitMs)
        continue
      }
      throw lastError
    }
    throw lastError ?? new ZettaError({ code: LocalErrorCodes.NETWORK_ERROR, message: 'Request failed.' })
  }
}

async function parseBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined
  const text = await response.text()
  if (!text) return undefined
  const type = response.headers.get('content-type') ?? ''
  if (type.includes('json') || /^[[{]/.test(text.trim())) {
    try {
      return JSON.parse(text)
    } catch {
      if (response.ok) {
        throw new ZettaError({
          code: LocalErrorCodes.INVALID_RESPONSE,
          message: 'The server sent a response that could not be read.',
          status: response.status,
        })
      }
      return text
    }
  }
  return text
}
