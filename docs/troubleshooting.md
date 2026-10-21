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
| `BUILD_PROBLEMS` | These options don't work together, for example `--parts` on N1 | Follow the message; `zetta catalog engines` shows each engine's options |
| `VALIDATION_FAILED` | The server rejected a field | `details.problems` |
| `FILE_NOT_FOUND`, `UNSUPPORTED_FILE_TYPE` | The file is missing, or not a PNG, JPEG, WebP, GLB or video | Check the path and type |
| `INVALID_IMAGE`, `FILE_TOO_LARGE` | Pictures must be 128–5000 px and at most 8 MB | Resize or compress the picture |
| `PIPELINE_NOT_RUNNABLE` | The recipe has problems | `zetta pipeline validate <recipe>` |
| `RUN_NEEDS_INPUT` | A run needs a per-run input (for example a texture prompt) | `--draft`, then `zetta run set-input` |
| `MODEL_CAPABILITY_UNSUPPORTED` | That engine can't do that option | Pick another engine |

### 3: sign in

| Code | Fix |
|---|---|
| `NOT_LOGGED_IN` | `zetta auth login`, or set `ZETTA_TOKEN` |
| `INVALID_SESSION` | The token expired (after 30 days) or was refused. Run `zetta auth login` again |
| `EXPIRED_LINK`, `INVALID_LINK` | Email links last 15 minutes and work once. Request a new one |
| `LOGIN_TIMEOUT` | The browser sign-in wasn't finished within 10 minutes. Run it again, or use `--email` |

The browser doesn't come back to the terminal?
- **Same computer:** the sign-in page must be opened on the computer running `zetta`.
- **Over SSH:** use `--email` instead.
- **Strict browser settings** can block the page from reaching `127.0.0.1`. Allow it, or use `--email`.

### 4: your plan

| Code | Fix |
|---|---|
| `PLAN_CAPABILITY_REQUIRED` | `zetta catalog entitlements` shows what your plan allows; `zetta billing plans` |
| `EARLY_ACCESS_REQUIRED` | `zetta account early-access "<feature>"` |
| `IMAGE_*_REQUIRES_PLAN` | Use `--resolution 2K`, or the default image engine, or upgrade |

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
| 7 | `JOB_LIMIT_REACHED` | Your plan's concurrent-job limit. Wait for a job: `zetta asset wait <id>` |
| 7 | `GEN3D_NOT_READY` | The source asset is still processing. Wait for it first |
| 7 | `SUBSCRIPTION_ACTIVE` | Cancel the subscription before deleting the account: `zetta billing portal` |
| 8 | `RATE_LIMITED` | Too many requests. Wait a minute, and use pipeline batches for many jobs |
| 9 | `JOB_FAILED`, `RUN_FAILED` | The job failed and was refunded. The message says why. Try a cleaner picture (`--remove-bg`), other options or another engine |
| 10 | `WAIT_TIMEOUT` | Not an error: the job is still running. Run `zetta asset wait <id>` (or `zetta run wait <id>`) again |
| 11 | `NETWORK_ERROR`, `REQUEST_TIMEOUT` | Check your connection or proxy; `zetta doctor` |
| 11 | `SERVER_ERROR`, `FEATURE_UNAVAILABLE` | A temporary problem, or the feature is switched off. Try later |

## Other problems

| Problem | Fix |
|---|---|
| `zetta: command not found` | Open a new terminal, or `export PATH="$HOME/.zetta/bin:$PATH"` |
| `doctor` says the clock is off | Fix the system clock (sign-in tokens depend on it) |
| `doctor` says "no system keychain" | Normal on servers and in containers: the token is kept in a `0600` file instead |
| Downloaded models look wrong in an app | Try another format (`--format fbx`), or convert locally (`zetta asset export --format …`) |
| Local export says the model uses compressed geometry | Convert on the server: `zetta refine convert <id> --to fbx` |
| Alpine: the binary won't start | `apk add libstdc++` |
| Output contains colour codes in logs | `--no-color` or `NO_COLOR=1` (colour is already off when output isn't a terminal) |
| Piping into `head` | Supported: `zetta … \| head` exits quietly |

Still stuck? Run the failing command with `--verbose --json` and send the output to Zetta 3D support. It contains no token.
