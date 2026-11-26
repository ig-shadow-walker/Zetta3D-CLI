/** One next step per error code, naming a command where one helps. */
const HINTS: Record<string, string> = {
  NOT_LOGGED_IN: 'Run `zetta auth login` to sign in with your browser. Scripts, CI and agents use an API key: set ZETTA_API_KEY.',
  NO_SESSION: 'Run `zetta auth login` to sign in with your browser. Scripts, CI and agents use an API key: set ZETTA_API_KEY.',
  INVALID_SESSION: 'Your sign-in expired. Run `zetta auth login` again.',
  UNAUTHORIZED: 'Run `zetta auth login` to sign in with your browser, or set ZETTA_API_KEY.',
  INVALID_API_KEY:
    'The API key was refused: it is mistyped or was revoked. Make a new one with `zetta apikey create <name>` (after `zetta auth login`), or on the website under Profile › API keys.',
  API_KEY_NOT_ALLOWED:
    'This needs a browser sign-in, not an API key: run `zetta auth login` (and unset ZETTA_API_KEY). API keys cover generating, pictures, pipeline runs and reading your balance.',
  SPLAT_NOT_IN_API:
    'Gaussian splats, worlds and video uploads are not available with an API key. Sign in with `zetta auth login` to use `zetta splat`, or make them on the website.',
  PIPELINE_EDIT_NOT_ALLOWED:
    'With an API key, pipelines can be listed, estimated and run, but not created or changed, and a run cannot carry its own graph. Run a saved pipeline by id, or sign in with `zetta auth login` to edit it.',
  API_KEY_LIMIT: 'An account can have 10 API keys. Revoke one you no longer use: `zetta apikey list`, then `zetta apikey revoke <id>`.',
  API_KEY_NOT_FOUND: 'See your keys and their ids with `zetta apikey list`.',
  PLAN_REQUIRED:
    'Generating needs a plan. See `zetta billing plans` and subscribe with `zetta billing checkout <plan>`, or redeem a trial code with `zetta account redeem <code>`.',
  INSUFFICIENT_CREDITS: 'Check your balance with `zetta account credits`; top up with `zetta billing checkout`.',
  INSUFFICIENT_AI_TOKENS: 'Your AI tokens for this period are used up. See `zetta account usage --meter ai-tokens`; an Agent plan adds more: `zetta billing plans`.',
  SPEND_LIMIT: 'Raise the limit with --max-credits <n>, or check the price first with --dry-run.',
  SPEND_NOT_CONFIRMED: 'Pass --yes to confirm, or --max-credits <n> to allow up to n credits.',
  PLAN_CAPABILITY_REQUIRED: 'See what your plan allows with `zetta catalog entitlements`, and plans with `zetta billing plans`.',
  EARLY_ACCESS_REQUIRED: 'Ask for access with `zetta account early-access <feature>`.',
  IMAGE_EDITING_REQUIRES_PLAN: 'Image editing and AI texture maps need a paid plan: `zetta billing plans`, or `zetta account redeem <code>` for a trial.',
  IMAGE_GEN_REJECTED: 'The image engine turned this request down. Rephrase the prompt or use a different picture, then try again.',
  IMAGE_GEN_NO_IMAGE: 'No picture came back. Try again; if it keeps happening, change the prompt or the picture.',
  IMAGE_4K_REQUIRES_PLAN: '4K images need a paid plan; use --resolution 2K, or see `zetta billing plans`.',
  IMAGE_PRO_MODEL_REQUIRES_PLAN: 'The Pro image engine needs a paid plan; use the default engine, or see `zetta billing plans`.',
  JOB_LIMIT_REACHED: 'Too many jobs are running for your plan. Wait for one with `zetta asset wait <id>`, or upgrade.',
  GEN3D_NOT_READY: 'The item is still processing. Wait with `zetta asset wait <id>`.',
  MODEL_CAPABILITY_UNSUPPORTED: 'That engine does not support this option. See `zetta catalog engines`.',
  WAIT_TIMEOUT: 'The job is still running. Resume with `zetta asset wait <id>` (or `zetta run wait <id>`).',
  RATE_LIMITED:
    'Wait the number of seconds in `retryAfter`, then try again. API keys allow 300 requests a minute and 5,000 an hour; for many jobs at once, use a pipeline batch.',
  NETWORK_ERROR: 'Check your connection, then try again. `zetta doctor` checks the setup.',
  FEATURE_UNAVAILABLE: 'This feature is switched off right now. Try again later.',
  SUBSCRIPTION_ACTIVE: 'Cancel your subscription and any Agent plan first: `zetta billing portal`. Check both with `zetta billing subscription`.',
  AI_ADD_ON_ACTIVE: 'You already have an Agent plan. Switch its size with `zetta billing agent-plan <name>`; see it with `zetta billing subscription`.',
  AI_ADD_ON_NEEDS_ACCOUNT: 'Confirm your email first (finish signing in once on the website), then try again.',
  NO_AI_ADD_ON: 'There is no Agent plan to change. Buy one with `zetta billing checkout --agent <name>` (see `zetta billing plans`).',
  SAME_AI_ADD_ON: 'That is already your Agent plan. See the sizes with `zetta billing plans`.',
  UNKNOWN_PRICE: 'See what can be bought with `zetta billing plans`.',
  NO_CUSTOMER: 'There is nothing to manage yet. Buy a plan with `zetta billing checkout <plan>`.',
  RUN_NEEDS_INPUT: 'Give the missing per-run settings with `zetta run set-input`, then `zetta run start`.',
  PIPELINE_NOT_RUNNABLE: 'Check the graph with `zetta pipeline validate`.',
  JOB_FAILED: 'Its credits were refunded. Try different settings, or another engine.',
  FILE_NOT_FOUND: 'Check the path.',
  VALIDATION_FAILED: 'Check the flags with `zetta <command> --help`.',
}

export function hintFor(code: string): string | undefined {
  return HINTS[code]
}
