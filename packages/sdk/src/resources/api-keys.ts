import type { Transport } from '../transport'

/**
 * API keys: `zk_live_` and 43 URL-safe characters. Sent as `Authorization: Bearer zk_live_…` (or
 * `X-API-Key`), they open a subset of the API — reads, generations, pictures, pipeline runs, the
 * balance — and never key management, billing changes or the account itself.
 */
export const API_KEY_PREFIX = 'zk_live_'
const API_KEY_PATTERN = /^zk_live_[A-Za-z0-9_-]{43}$/

/** Whether a credential is meant as an API key (the server treats anything starting `zk_` as one). */
export function isApiKey(credential: string | undefined | null): boolean {
  return typeof credential === 'string' && credential.trim().startsWith('zk_')
}

/** Whether a string has the exact shape of an API key. */
export function isWellFormedApiKey(credential: string): boolean {
  return API_KEY_PATTERN.test(credential.trim())
}

/**
 * `zk_live_Ab3x…wxyz`: enough to tell keys apart, not enough to use one. The same shape the server
 * shows in its key list (first 12 characters, last 4), so the two can be matched by eye.
 */
export function apiKeyHint(key: string): string {
  const trimmed = key.trim()
  if (trimmed.length <= 16) return `${trimmed.slice(0, 3)}…`
  return `${trimmed.slice(0, 12)}…${trimmed.slice(-4)}`
}

/** A key as its owner sees it. Never the secret. */
export interface ApiKeySummary {
  id: number
  name: string
  /** `zk_live_Ab3x…wxyz`. */
  hint: string
  createdAt: string
  lastUsedAt: string | null
}

/** What creating a key returns: the only time the whole key is ever available. */
export interface CreatedApiKey {
  key: string
  apiKey: ApiKeySummary
}

export type ApiSubject = { type: 'gen3d_post'; id: number } | { type: 'gen2d_post'; id: number } | { type: 'pipeline_run'; id: number }

/** One request made with an API key. */
export interface ApiRequestEntry {
  id: number
  apiKeyId: number
  method: string
  /** The endpoint as declared, e.g. `/3d/generations/:id`. */
  route: string
  /** The path as called, without the query string. */
  path: string
  statusCode: number
  durationMs: number
  errorCode: string | null
  subjects: ApiSubject[]
  aiTokens: number | null
  createdAt: string
}

export interface ApiLogsPage {
  items: ApiRequestEntry[]
  /** Pass back as `before` for the next page; null on the last one. */
  nextCursor: number | null
  /** Every key the account has had, revoked ones too, to name rows by. */
  keys: Array<ApiKeySummary & { revoked: boolean }>
}

/** What one key (or all of them) did over a window of days. */
export interface ApiKeyUsage {
  since: string
  days: number
  requests: number
  errors: number
  jobs: number
  pictures: number
  pipelineRuns: number
  credits: { charged: number; refunded: number; net: number }
  byOperation: Array<{ operationType: string; credits: number; count: number }>
  aiTokens: number
  daily: Array<{ date: string; requests: number; errors: number }>
  truncated: boolean
}

/**
 * Key management. Browser sign-in only: every call here is refused with `API_KEY_NOT_ALLOWED` when
 * the client itself uses an API key, so a leaked key cannot mint a successor or revoke its siblings.
 */
export class ApiKeys {
  constructor(private readonly transport: Transport) {}

  /** The account's live keys, newest first. */
  async list(): Promise<ApiKeySummary[]> {
    const result = await this.transport.request<{ apiKeys: ApiKeySummary[] }>('GET', '/api-keys')
    return result.apiKeys ?? []
  }

  /** Makes a key (paid plans; at most 10 live). The whole key is in this response and nowhere else. */
  create(name: string): Promise<CreatedApiKey> {
    return this.transport.request('POST', '/api-keys', { body: { name }, retry: 'never' })
  }

  /** Revokes a key; it stops working on the next request. */
  async revoke(id: number): Promise<void> {
    await this.transport.request('DELETE', `/api-keys/${id}`)
  }

  /** Requests, jobs, credits and AI tokens over the last `days` (1–90), for one key or all. */
  usage(query: { keyId?: number; days?: number } = {}): Promise<ApiKeyUsage> {
    return this.transport.request('GET', '/api-keys/usage', { query })
  }

  /** A page of requests, newest first. */
  logs(query: { keyId?: number; before?: number; limit?: number; errors?: boolean } = {}): Promise<ApiLogsPage> {
    return this.transport.request('GET', '/api-keys/logs', { query: { ...query, errors: query.errors ? 'true' : undefined } })
  }
}
