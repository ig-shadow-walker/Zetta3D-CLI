# Troubleshooting

Start with:

```bash
zetta doctor          # version, config, connection, clock, sign-in, keychain
zetta --verbose …     # shows every API request on stderr
```

Every error names a code, and most give a hint with the next command to run. As JSON:

```json
{"error":{"code":"…","message":"…","details":{…},"hint":"…","exitCode":N}}
```

## By exit code

### 2: fix the input

| Code | Meaning | Fix |
|---|---|---|
| `USAGE` | A flag or argument is wrong or missing | `zetta <command> --help`; `details.problems` lists each issue |
| `BUILD_PROBLEMS` | These options don't work together, for example `--parts` on np1 | Follow the message; `zetta catalog engines` shows each engine's options |
| `VALIDATION_FAILED` | The server rejected a field | `details.problems` |
| `FILE_NOT_FOUND`, `UNSUPPORTED_FILE_TYPE` | The file is missing, or of a type the command doesn't take (pictures: PNG, JPEG or WebP) | Check the path and type |
| `INVALID_IMAGE`, `FILE_TOO_LARGE` | Pictures must be 128–5000 px and at most 8 MB | Resize or compress the picture |
| `PIPELINE_NOT_RUNNABLE` | The recipe has problems | `zetta pipeline validate <recipe>` |
| `RUN_NEEDS_INPUT` | A run needs a per-run input (for example a texture prompt) | `--draft`, then `zetta run set-input` |
| `MODEL_CAPABILITY_UNSUPPORTED` | That engine can't do that option | Pick another engine |
| `IMAGE_GEN_REJECTED` | The image engine turned the request down | Rephrase the prompt or use another picture, then try again |
| `API_KEY_NAME_REQUIRED`, `API_KEY_NAME_TOO_LONG` | An API key needs a name of at most 60 characters | `zetta apikey create <name>` |
| `UNKNOWN_PRICE` | There is no such plan, pack or price to buy | `zetta billing plans` |

### 3: sign in

| Code | Fix |
|---|---|
| `NOT_LOGGED_IN` | `zetta auth login`, or set `ZETTA_API_KEY` |
| `INVALID_SESSION` | The session token expired (after 30 days) or was refused. Run `zetta auth login` again |
| `INVALID_API_KEY` | The API key is mistyped or was revoked. Make a new one with `zetta apikey create <name>` (after `zetta auth login`), or on the website under Profile › API keys |
| `API_KEY_NOT_ALLOWED` | The command needs the browser sign-in, and this profile uses an API key. Run `zetta auth login`, and unset `ZETTA_API_KEY`. See [what an API key can do](authentication.md#what-an-api-key-can-do) |
| `LOGIN_TIMEOUT` | The browser sign-in wasn't finished within 10 minutes. Run `zetta auth login` again |

The browser doesn't come back to the terminal?
- **Same computer:** the sign-in page must be opened on the computer running `zetta`.
- **Over SSH, in a container or on a server:** the browser can't reach this computer. Use an API key instead (`ZETTA_API_KEY`).
- **Strict browser settings** can block the page from reaching `127.0.0.1`. Allow it, or use an API key.

### 4: your plan or access

| Code | Fix |
|---|---|
| `PLAN_REQUIRED` | There is no plan, so nothing can be generated. See `zetta billing plans` and subscribe with `zetta billing checkout <plan>`, or redeem a trial code with `zetta account redeem <code>` |
| `PLAN_CAPABILITY_REQUIRED` | `zetta catalog entitlements` shows what your plan allows; `zetta billing plans` |
| `EARLY_ACCESS_REQUIRED` | `zetta account early-access "<feature>"` |
| `IMAGE_EDITING_REQUIRES_PLAN` | Image editing and AI texture maps need a paid plan: `zetta billing plans`, or a trial code with `zetta account redeem <code>` |
| `IMAGE_4K_REQUIRES_PLAN`, `IMAGE_PRO_MODEL_REQUIRES_PLAN` | Use `--resolution 2K`, or the default image engine, or upgrade |
| `SPLAT_NOT_IN_API` | Splats, worlds and video uploads don't work with an API key. Sign in with `zetta auth login`, or make them on the website |
| `PIPELINE_EDIT_NOT_ALLOWED` | With an API key, pipelines can be listed, estimated and run, but not created or changed. Run a saved pipeline by id, or sign in with `zetta auth login` to edit it |
| `AI_ADD_ON_NEEDS_ACCOUNT` | Confirm your email first (finish signing in once on the website), then try again |

### 5: credits and the spend guard

| Code | Meaning | Fix |
|---|---|---|
| `SPEND_NOT_CONFIRMED` | A paid command ran without a terminal and without `--yes` or `--max-credits` | Add `--max-credits N` (or `--yes`); check the price with `--dry-run` |
| `SPEND_LIMIT` | The price is over `--max-credits`, the configured limit, or the MCP session budget | `details.credits` is the price |
| `INSUFFICIENT_CREDITS` | Not enough credits | `zetta account credits`; `zetta billing checkout --pack 1000` |

### 6 to 11

| Exit | Code | Fix |
|---|---|---|
| 6 | `NOT_FOUND` | Wrong id, or it belongs to another account |
| 6 | `API_KEY_NOT_FOUND` | No such API key. `zetta apikey list` shows your keys and their ids |
| 7 | `JOB_LIMIT_REACHED` | Your plan's concurrent-job limit. Wait for a job: `zetta asset wait <id>` |
| 7 | `GEN3D_NOT_READY` | The source asset is still processing. Wait for it first |
| 7 | `SUBSCRIPTION_ACTIVE` | Cancel the subscription and any Agent plan before deleting the account: `zetta billing portal`. Check both with `zetta billing subscription` |
| 7 | `API_KEY_LIMIT` | An account can have 10 API keys. Revoke one you no longer use: `zetta apikey list`, then `zetta apikey revoke <id>` |
| 7 | `AI_ADD_ON_ACTIVE` | You already have an Agent plan. Change its size with `zetta billing agent-plan <name>` |
| 7 | `NO_AI_ADD_ON` | There is no Agent plan to change. Buy one with `zetta billing checkout --agent <name>` |
| 7 | `SAME_AI_ADD_ON` | That is already your Agent plan. `zetta billing plans` shows the sizes |
| 7 | `NO_CUSTOMER` | There is nothing to manage yet. Buy a plan with `zetta billing checkout <plan>` |
| 8 | `RATE_LIMITED` | Too many requests. Wait the seconds in `details.retryAfter`. API keys allow 300 requests a minute and 5,000 an hour. The CLI itself waits out any wait of up to a minute. For many jobs at once, use a pipeline batch |
| 9 | `JOB_FAILED`, `RUN_FAILED` | The job failed and was refunded. The message says why. Try a cleaner picture (`--remove-bg`), other options or another engine |
| 9 | `IMAGE_GEN_NO_IMAGE` | No picture came back. Try again; if it keeps happening, change the prompt or the picture |
| 10 | `WAIT_TIMEOUT` | Not an error: the job is still running. Run `zetta asset wait <id>` (or `zetta run wait <id>`) again |
| 11 | `NETWORK_ERROR`, `REQUEST_TIMEOUT` | Check your connection or proxy; `zetta doctor` |
| 11 | `SERVER_ERROR`, `FEATURE_UNAVAILABLE` | A temporary problem, or the feature is switched off. Try later |

## Other problems

| Problem | Fix |
|---|---|
| `zetta: command not found` | Open a new terminal, or `export PATH="$HOME/.zetta/bin:$PATH"` |
| `doctor` says the clock is off | Fix the system clock (sign-in tokens depend on it) |
| `doctor` says "no system keychain" | Normal on servers and in containers: the saved token or key is kept in a `0600` file instead |
| Downloaded models look wrong in an app | Try another format (`--format fbx`), or convert locally (`zetta asset export --format …`) |
| Local export says the model uses compressed geometry | Convert on the server: `zetta refine convert <id> --to fbx` |
| Alpine: the binary won't start | `apk add libstdc++` |
| Output contains colour codes in logs | `--no-color` or `NO_COLOR=1` (colour is already off when output isn't a terminal) |
| Piping into `head` | Supported: `zetta … \| head` exits quietly |

Still stuck? Run the failing command with `--verbose --json` and send the output to Zetta 3D support. It contains no token or key.
