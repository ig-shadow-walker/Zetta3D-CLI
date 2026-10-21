import { LocalErrorCodes, ZettaError, errorFromResponse } from './errors'
import type { Transport } from './transport'
import type { Generation, UploadTicket } from './types'

/** Files up to this size go up in one PUT; larger ones use the relay's multipart routes. */
export const UPLOAD_PIECE_BYTES = 8 * 1024 * 1024
const RETRY_DELAYS_MS = [600, 1800]

/** Content types the upload relay accepts. */
export const UPLOAD_CONTENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'model/gltf-binary',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-msvideo',
] as const

/** Relay limits per kind of file, in bytes. */
export const UPLOAD_LIMITS = {
  image: 32 * 1024 * 1024,
  video: 100 * 1024 * 1024,
  model: 512 * 1024 * 1024,
} as const

export interface UploadProgress {
  sentBytes: number
  totalBytes: number
}

export interface UploadOptions {
  contentType: string
  signal?: AbortSignal
  onProgress?: (progress: UploadProgress) => void
}

export interface UploadedFile {
  /** Durable storage key; pipeline seeds and library imports refer to this. */
  key: string
  /** Signed URL the engines can read for 24 hours; pass it as `imageUrl`, `videoUrl`, … */
  fileUrl: string
  bytes: number
  contentType: string
}

export interface RegisterUploadInput {
  key: string
  bytes: number
  title?: string
  feature?: 'upload' | 'autoRigging'
  sourcePostId?: number
}

type Sent = { status: number; body: string; retryAfter: string | null }

export class Uploads {
  constructor(
    private readonly transport: Transport,
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  /** Asks for an upload ticket: where to send the bytes, and the URL engines will read them from. */
  createTicket(contentType: string): Promise<UploadTicket> {
    return this.transport.request<UploadTicket>('POST', '/3d/uploads', { body: { contentType } })
  }

  /** Registers an uploaded GLB as a library item (free). */
  async register(input: RegisterUploadInput): Promise<Generation> {
    const result = await this.transport.request<{ generation: Generation }>('POST', '/3d/uploads/post', {
      body: input,
    })
    return result.generation
  }

  /**
   * Uploads a file through the relay and returns its key and readable URL.
   *
   * Accepts any `Blob` (in Bun and Node, `Bun.file(path)` or `fs.openAsBlob(path)` stream from disk).
   * An expired ticket is replaced once; network errors and 5xx are retried per request.
   */
  async upload(blob: Blob, options: UploadOptions): Promise<UploadedFile> {
    let ticket = await this.createTicket(options.contentType)
    try {
      await this.send(ticket, blob, options)
    } catch (error) {
      if (!(error instanceof ZettaError) || error.code !== LocalErrorCodes.UPLOAD_TICKET_EXPIRED) throw error
      ticket = await this.createTicket(options.contentType)
      await this.send(ticket, blob, options)
    }
    return { key: ticket.key, fileUrl: ticket.fileUrl, bytes: blob.size, contentType: options.contentType }
  }

  /** Sends bytes to a ticket's `uploadUrl`; exported for callers that manage tickets themselves. */
  async send(ticket: Pick<UploadTicket, 'uploadUrl' | 'method' | 'headers'>, blob: Blob, options: UploadOptions): Promise<void> {
    const total = blob.size
    const report = (sent: number) => options.onProgress?.({ sentBytes: sent, totalBytes: total })
    const relay = relayOf(ticket.uploadUrl)

    if (!relay || blob.size <= UPLOAD_PIECE_BYTES) {
      await this.attempt({ url: ticket.uploadUrl, method: ticket.method || 'PUT', headers: ticket.headers, body: blob }, options.signal)
      report(total)
      return
    }

    const query = (extra = '') => `?ticket=${encodeURIComponent(relay.ticket)}${extra}`
    const opened = await this.attempt({ url: `${relay.base}/multipart${query()}`, method: 'POST', headers: {} }, options.signal)
    const uploadId = parseUploadId(opened.body)
    if (!uploadId) {
      throw new ZettaError({ code: LocalErrorCodes.UPLOAD_FAILED, message: 'The upload could not be started.', status: 502 })
    }
    const upload = `&uploadId=${encodeURIComponent(uploadId)}`
    try {
      let sent = 0
      let part = 0
      for (let offset = 0; offset < blob.size; offset += UPLOAD_PIECE_BYTES) {
        part += 1
        const piece = blob.slice(offset, offset + UPLOAD_PIECE_BYTES)
        await this.attempt(
          { url: `${relay.base}/multipart/part${query(`${upload}&part=${part}`)}`, method: 'PUT', headers: ticket.headers, body: piece },
          options.signal,
        )
        sent += piece.size
        report(sent)
      }
      await this.attempt(
        { url: `${relay.base}/multipart/complete${query(`${upload}&parts=${part}&bytes=${blob.size}`)}`, method: 'POST', headers: {} },
        options.signal,
      )
    } catch (error) {
      void this.fetchImpl(`${relay.base}/multipart${query(upload)}`, { method: 'DELETE' }).catch(() => undefined)
      throw error
    }
  }

  private async attempt(
    request: { url: string; method: string; headers: Record<string, string>; body?: Blob },
    signal: AbortSignal | undefined,
  ): Promise<Sent> {
    for (let attempt = 0; ; attempt++) {
      const outcome = await this.raw(request, signal)
      if (outcome.status >= 200 && outcome.status < 300) return outcome
      if (outcome.status === 410) {
        throw new ZettaError({ code: LocalErrorCodes.UPLOAD_TICKET_EXPIRED, message: 'The upload ticket expired.', status: 410 })
      }
      const delay = RETRY_DELAYS_MS[attempt]
      if ((outcome.status === 0 || outcome.status >= 500 || outcome.status === 429) && delay !== undefined) {
        await this.sleep(delay)
        continue
      }
      if (outcome.status === 0) {
        throw new ZettaError({
          code: LocalErrorCodes.NETWORK_ERROR,
          message: 'The upload could not reach Zetta 3D. Check your connection and try again.',
        })
      }
      const parsed = safeJson(outcome.body)
      const error = errorFromResponse(outcome.status, parsed ?? outcome.body, outcome.retryAfter)
      throw new ZettaError({
        code: error.code === 'PAYLOAD_TOO_LARGE' ? LocalErrorCodes.FILE_TOO_LARGE : error.code,
        message: `The file could not be uploaded: ${error.message}`,
        status: outcome.status,
        details: error.details,
      })
    }
  }

  private async raw(
    request: { url: string; method: string; headers: Record<string, string>; body?: Blob },
    signal: AbortSignal | undefined,
  ): Promise<Sent> {
    try {
      // The ticket is the authorisation; no Bearer token goes to the relay.
      const response = await this.fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body ? { body: request.body } : {}),
        ...(signal ? { signal } : {}),
      })
      return { status: response.status, body: await response.text().catch(() => ''), retryAfter: response.headers.get('retry-after') }
    } catch (cause) {
      if (signal?.aborted) throw cause
      return { status: 0, body: '', retryAfter: null }
    }
  }
}

function relayOf(uploadUrl: string): { base: string; ticket: string } | null {
  try {
    const url = new URL(uploadUrl)
    const ticket = url.searchParams.get('ticket')
    if (!ticket || !url.pathname.endsWith('/3d/uploads/relay')) return null
    return { base: `${url.origin}${url.pathname}`, ticket }
  } catch {
    return null
  }
}

function parseUploadId(body: string): string | null {
  const parsed = safeJson(body) as { uploadId?: unknown } | undefined
  return typeof parsed?.uploadId === 'string' && parsed.uploadId ? parsed.uploadId : null
}

function safeJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : undefined
  } catch {
    return undefined
  }
}
