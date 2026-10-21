/** Exit codes, as documented in `zetta help exit-codes` and ROADMAP.md. */
export const ExitCode = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  AUTH: 3,
  ACCESS: 4,
  CREDITS: 5,
  NOT_FOUND: 6,
  CONFLICT: 7,
  RATE_LIMITED: 8,
  JOB_FAILED: 9,
  WAIT_TIMEOUT: 10,
  NETWORK: 11,
} as const

const BY_CODE: Record<string, number> = {
  USAGE: ExitCode.USAGE,
  VALIDATION_FAILED: ExitCode.USAGE,
  BAD_REQUEST: ExitCode.USAGE,
  INVALID_INPUT: ExitCode.USAGE,
  BUILD_PROBLEMS: ExitCode.USAGE,
  FILE_TOO_LARGE: ExitCode.USAGE,
  UNSUPPORTED_FILE_TYPE: ExitCode.USAGE,
  INVALID_IMAGE: ExitCode.USAGE,
  FILE_NOT_FOUND: ExitCode.USAGE,
  MODEL_CAPABILITY_UNSUPPORTED: ExitCode.USAGE,
  PIPELINE_NOT_RUNNABLE: ExitCode.USAGE,
  RUN_NEEDS_INPUT: ExitCode.USAGE,
  UNKNOWN_PRICE: ExitCode.USAGE,
  NOT_LOGGED_IN: ExitCode.AUTH,
  NO_SESSION: ExitCode.AUTH,
  INVALID_SESSION: ExitCode.AUTH,
  UNAUTHORIZED: ExitCode.AUTH,
  INVALID_LINK: ExitCode.AUTH,
  EXPIRED_LINK: ExitCode.AUTH,
  LOGIN_TIMEOUT: ExitCode.AUTH,
  LOGIN_CANCELLED: ExitCode.AUTH,
  PLAN_CAPABILITY_REQUIRED: ExitCode.ACCESS,
  EARLY_ACCESS_REQUIRED: ExitCode.ACCESS,
  IMAGE_EDITING_REQUIRES_PLAN: ExitCode.ACCESS,
  IMAGE_4K_REQUIRES_PLAN: ExitCode.ACCESS,
  IMAGE_PRO_MODEL_REQUIRES_PLAN: ExitCode.ACCESS,
  FORBIDDEN: ExitCode.ACCESS,
  INSUFFICIENT_CREDITS: ExitCode.CREDITS,
  SPEND_LIMIT: ExitCode.CREDITS,
  SPEND_NOT_CONFIRMED: ExitCode.CREDITS,
  NOT_FOUND: ExitCode.NOT_FOUND,
  JOB_LIMIT_REACHED: ExitCode.CONFLICT,
  GEN3D_NOT_READY: ExitCode.CONFLICT,
  GEN3D_ALREADY_SUBMITTED: ExitCode.CONFLICT,
  GEN3D_ALREADY_FINISHED: ExitCode.CONFLICT,
  GEN3D_NO_FILES: ExitCode.CONFLICT,
  SUBSCRIPTION_ACTIVE: ExitCode.CONFLICT,
  CONFLICT: ExitCode.CONFLICT,
  RATE_LIMITED: ExitCode.RATE_LIMITED,
  JOB_FAILED: ExitCode.JOB_FAILED,
  JOB_CANCELLED: ExitCode.JOB_FAILED,
  RUN_FAILED: ExitCode.JOB_FAILED,
  WAIT_TIMEOUT: ExitCode.WAIT_TIMEOUT,
  NETWORK_ERROR: ExitCode.NETWORK,
  REQUEST_TIMEOUT: ExitCode.NETWORK,
  SERVER_ERROR: ExitCode.NETWORK,
  FEATURE_UNAVAILABLE: ExitCode.NETWORK,
  STRIPE_DISABLED: ExitCode.NETWORK,
  IMAGE_GEN_DISABLED: ExitCode.NETWORK,
  IMAGE_GEN_FAILED: ExitCode.NETWORK,
  IMAGE_GEN_TIMEOUT: ExitCode.NETWORK,
  IMAGE_GEN_UNREACHABLE: ExitCode.NETWORK,
  IMAGE_GEN_QUOTA: ExitCode.NETWORK,
  UPLOAD_FAILED: ExitCode.NETWORK,
  DOWNLOAD_FAILED: ExitCode.NETWORK,
}

export function exitCodeFor(code: string, status = 0): number {
  if (BY_CODE[code] !== undefined) return BY_CODE[code]
  if (status === 401) return ExitCode.AUTH
  if (status === 403) return ExitCode.ACCESS
  if (status === 404) return ExitCode.NOT_FOUND
  if (status === 409) return ExitCode.CONFLICT
  if (status === 429) return ExitCode.RATE_LIMITED
  if (status >= 500) return ExitCode.NETWORK
  if (status >= 400) return ExitCode.USAGE
  return ExitCode.ERROR
}

export const EXIT_CODE_TABLE: Array<{ code: number; meaning: string }> = [
  { code: 0, meaning: 'Success' },
  { code: 1, meaning: 'Unexpected error' },
  { code: 2, meaning: 'Bad usage or failed local check (fix the input)' },
  { code: 3, meaning: 'Not signed in, or the token expired (run `zetta auth login`)' },
  { code: 4, meaning: 'Your plan or access does not allow this' },
  { code: 5, meaning: 'Not enough credits, or over the spend limit' },
  { code: 6, meaning: 'Not found' },
  { code: 7, meaning: 'Conflict, or a concurrency limit was reached' },
  { code: 8, meaning: 'Rate limited (after retries)' },
  { code: 9, meaning: 'The remote job failed or was cancelled' },
  { code: 10, meaning: 'Stopped waiting; the job is still running' },
  { code: 11, meaning: 'Network or server error' },
]
