/**
 * One error type for everything the SDK can fail with.
 *
 * The API answers errors in three shapes (an object thrown by the service, a plain-string
 * HttpException, and the validation pipe's `message: string[]`). Callers should never have
 * to know that, so every failure — HTTP, network, local validation, a job that ended badly —
 * becomes a `ZettaError` with a stable `code`.
 */
export interface ZettaErrorInit {
  code: string
  message: string
  status?: number
  details?: Record<string, unknown>
  cause?: unknown
}

export class ZettaError extends Error {
  readonly code: string
  /** HTTP status, or 0 when the failure never reached the server (network, local checks). */
  readonly status: number
  readonly details: Record<string, unknown>

  constructor(init: ZettaErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause })
    this.name = 'ZettaError'
    this.code = init.code
    this.status = init.status ?? 0
    this.details = init.details ?? {}
  }

  toJSON(): { code: string; message: string; status: number; details: Record<string, unknown> } {
    return { code: this.code, message: this.message, status: this.status, details: this.details }
  }
}

export function isZettaError(value: unknown): value is ZettaError {
  return value instanceof ZettaError
}

/** Codes the SDK itself produces, in addition to whatever `code` the API sends. */
export const LocalErrorCodes = {
  NETWORK_ERROR: 'NETWORK_ERROR',
  REQUEST_TIMEOUT: 'REQUEST_TIMEOUT',
  INVALID_RESPONSE: 'INVALID_RESPONSE',
  NOT_LOGGED_IN: 'NOT_LOGGED_IN',
  UPLOAD_FAILED: 'UPLOAD_FAILED',
  UPLOAD_TICKET_EXPIRED: 'UPLOAD_TICKET_EXPIRED',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  UNSUPPORTED_FILE_TYPE: 'UNSUPPORTED_FILE_TYPE',
  INVALID_IMAGE: 'INVALID_IMAGE',
  INVALID_INPUT: 'INVALID_INPUT',
  JOB_FAILED: 'JOB_FAILED',
  JOB_CANCELLED: 'JOB_CANCELLED',
  WAIT_TIMEOUT: 'WAIT_TIMEOUT',
  DOWNLOAD_FAILED: 'DOWNLOAD_FAILED',
  /** The command needs a browser sign-in, and the client holds an API key. Also the server's code. */
  API_KEY_NOT_ALLOWED: 'API_KEY_NOT_ALLOWED',
} as const

const STATUS_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  402: 'PAYMENT_REQUIRED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  410: 'GONE',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE',
  429: 'RATE_LIMITED',
}

function codeForStatus(status: number): string {
  if (STATUS_CODES[status]) return STATUS_CODES[status]
  if (status >= 500) return 'SERVER_ERROR'
  return 'HTTP_ERROR'
}

function joinMessage(message: unknown): string | undefined {
  if (typeof message === 'string') return message
  if (Array.isArray(message)) {
    const parts = message.filter((m): m is string => typeof m === 'string')
    return parts.length ? parts.join('; ') : undefined
  }
  return undefined
}

function retryAfterSeconds(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.ceil(value) : undefined
  if (typeof value !== 'string' || !value.trim()) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.ceil(seconds) : undefined
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : undefined
}

/**
 * Turns an error response into a `ZettaError`.
 *
 * `body` is the parsed JSON (or the raw text when the body was not JSON).
 */
export function errorFromResponse(status: number, body: unknown, retryAfter?: string | null): ZettaError {
  const details: Record<string, unknown> = {}
  let code: string | undefined
  let message: string | undefined

  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const record = body as Record<string, unknown>
    for (const [key, value] of Object.entries(record)) {
      if (key === 'message' || key === 'code' || key === 'statusCode' || key === 'error') continue
      details[key] = value
    }
    if (typeof record.code === 'string' && record.code) code = record.code
    message = joinMessage(record.message) ?? (typeof record.error === 'string' ? record.error : undefined)
    // The validation pipe answers `message: string[]` without a code.
    if (!code && status === 400 && Array.isArray(record.message)) {
      code = 'VALIDATION_FAILED'
      details.problems = record.message
    }
  } else if (typeof body === 'string' && body.trim()) {
    message = body.trim().slice(0, 500)
  }

  if (!code && status === 429) code = 'RATE_LIMITED'
  // `retryAfter` is always whole seconds: from the header (seconds or a date), else the body's own field.
  const wait = retryAfterSeconds(retryAfter) ?? retryAfterSeconds(details.retryAfter)
  if (wait !== undefined) details.retryAfter = wait
  else if (retryAfter) details.retryAfter = retryAfter
  if (status === 429) {
    message =
      wait !== undefined && wait > 0
        ? `Too many requests. Try again in ${wait} second${wait === 1 ? '' : 's'}.`
        : 'Too many requests. Slow down and try again shortly.'
  }

  return new ZettaError({
    code: code ?? codeForStatus(status),
    message: message ?? `The server answered ${status}.`,
    status,
    details,
  })
}
