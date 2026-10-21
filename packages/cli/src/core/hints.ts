/** One next step per error code, naming a command where one helps. */
const HINTS: Record<string, string> = {
  NOT_LOGGED_IN: 'Run `zetta auth login` (or set ZETTA_TOKEN).',
  NO_SESSION: 'Run `zetta auth login` (or set ZETTA_TOKEN).',
  INVALID_SESSION: 'Your sign-in expired. Run `zetta auth login` again.',
  UNAUTHORIZED: 'Run `zetta auth login` (or set ZETTA_TOKEN).',
  INVALID_LINK: 'Request a new link with `zetta auth login --email <address>`.',
  EXPIRED_LINK: 'The link expired after 15 minutes. Request a new one with `zetta auth login --email <address>`.',
  INSUFFICIENT_CREDITS: 'Check your balance with `zetta account credits`; top up with `zetta billing checkout`.',
  SPEND_LIMIT: 'Raise the limit with --max-credits <n>, or check the price first with --dry-run.',
  SPEND_NOT_CONFIRMED: 'Pass --yes to confirm, or --max-credits <n> to allow up to n credits.',
  PLAN_CAPABILITY_REQUIRED: 'See what your plan allows with `zetta catalog entitlements`, and plans with `zetta billing plans`.',
  EARLY_ACCESS_REQUIRED: 'Ask for access with `zetta account early-access <feature>`.',
  IMAGE_EDITING_REQUIRES_PLAN: 'Image editing needs a paid plan: `zetta billing plans`.',
  IMAGE_4K_REQUIRES_PLAN: '4K images need a paid plan; use --resolution 2K, or see `zetta billing plans`.',
  IMAGE_PRO_MODEL_REQUIRES_PLAN: 'The Pro image engine needs a paid plan; use the default engine, or see `zetta billing plans`.',
  JOB_LIMIT_REACHED: 'Too many jobs are running for your plan. Wait for one with `zetta asset wait <id>`, or upgrade.',
  GEN3D_NOT_READY: 'The item is still processing. Wait with `zetta asset wait <id>`.',
  MODEL_CAPABILITY_UNSUPPORTED: 'That engine does not support this option. See `zetta catalog engines`.',
  WAIT_TIMEOUT: 'The job is still running. Resume with `zetta asset wait <id>` (or `zetta run wait <id>`).',
  RATE_LIMITED: 'Wait a minute and try again. For many jobs at once, use a pipeline batch.',
  NETWORK_ERROR: 'Check your connection, then try again. `zetta doctor` checks the setup.',
  FEATURE_UNAVAILABLE: 'This feature is switched off right now. Try again later.',
  SUBSCRIPTION_ACTIVE: 'Cancel the subscription first: `zetta billing portal`.',
  RUN_NEEDS_INPUT: 'Give the missing per-run settings with `zetta run set-input`, then `zetta run start`.',
  PIPELINE_NOT_RUNNABLE: 'Check the graph with `zetta pipeline validate`.',
  JOB_FAILED: 'Its credits were refunded. Try different settings, or another engine.',
  FILE_NOT_FOUND: 'Check the path.',
  VALIDATION_FAILED: 'Check the flags with `zetta <command> --help`.',
}

export function hintFor(code: string): string | undefined {
  return HINTS[code]
}
