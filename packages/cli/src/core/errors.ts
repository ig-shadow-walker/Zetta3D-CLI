import { ZettaError } from '@zetta3d/sdk'

/** A usage error: bad flags, missing input, a local check that failed. Exit code 2. */
export function usageError(message: string, details: Record<string, unknown> = {}): ZettaError {
  return new ZettaError({ code: 'USAGE', message, details })
}

export function cliError(code: string, message: string, details: Record<string, unknown> = {}): ZettaError {
  return new ZettaError({ code, message, details })
}
