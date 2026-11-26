# Authentication

`zetta` uses your Zetta 3D account: the same library, credits and plan as the website. An account is connected through the browser: you sign in on zetta3d.ai and approve the CLI. There are two credentials:

| Credential | Comes from | Lasts | Can do |
|---|---|---|---|
| **Browser sign-in** | `zetta auth login` (the installer starts it for you) | 30 days, then sign in again | Everything |
| **API key** (`zk_live_…`) | `zetta apikey create`, or the website | Until you revoke it | Generating, refining, pictures, your library, pipeline runs and your balance. Not key management, billing or the account itself ([details](#what-an-api-key-can-do)) |

## Signing in

### With the browser (default)

The installer starts this for you right after installing, when you install in a terminal. Any time later:

```bash
zetta auth login
```

How it works:
1. `zetta` starts a one-time listener on `127.0.0.1`.
2. It opens `zetta3d.ai/plugin-auth`. If you aren't signed in to the website, sign in there first.
3. You click **Connect Zetta CLI**.
4. The page hands a token to the listener. Only zetta3d.ai can do this, and only with a random secret that `zetta` generated for this sign-in.
5. The listener closes.

If a browser can't open automatically, `zetta` prints the address. Open it on the same computer. `--print-url` always prints it instead of opening a browser.

### With an API key: CI, scripts, servers, AI agents

The browser hands the sign-in to `127.0.0.1` on the same computer, so it can't finish over SSH, in a container or in CI. There, use an API key. On such a machine, `zetta auth login` says so instead of waiting.

Make a key once, on the website (Profile › API keys) or on a machine where you're signed in with the browser:

```bash
zetta apikey create ci          # prints the key once; store it as a secret
```

Then, wherever zetta runs:

```bash
export ZETTA_API_KEY=zk_live_…                        # nothing is stored; the variable wins over everything else
# or save it as this profile's sign-in:
echo "$ZETTA_API_KEY" | zetta auth login --api-key
zetta auth login --api-key                            # in a terminal: paste it at a hidden prompt
```

`--api-key` never takes the key as an argument, so it stays out of your shell history. A key starts with `zk_live_` and has 51 characters.

## API keys

Managing keys needs the browser sign-in: an API key cannot make, list or revoke keys. Making a key also needs a paid plan.

```bash
zetta apikey create ci                    # the key is shown once, never again
zetta apikey create laptop --save         # saves it as this profile's sign-in instead of printing it
zetta apikey list                         # id, name, hint (zk_live_Ab3x…wxyz), created and last used
zetta apikey revoke 12                    # asks first; --yes without a terminal
zetta apikey usage --key ci --days 7      # requests, errors, jobs, credits and AI tokens
zetta apikey logs --errors --limit 100    # requests made with your keys, newest first
```

| Command | Options |
|---|---|
| `apikey create <name>` | The name says what the key is for, at most 60 characters. `--save` stores the key as this profile's sign-in (in the system keychain) and does not print it |
| `apikey revoke <id>` | `--yes` revokes without asking. Anything using the key stops working at once |
| `apikey usage` | `--key <id or name>` for one key (default: every key), `--days 1–90` (default 30) |
| `apikey logs` | `--key <id or name>`, `--errors` (status 400 and up), `--limit 1–100` (default 50), `--before <id>` for the next page. Requests are kept 90 days |

Some details:
- **Limit:** an account can have 10 keys. Revoke one you no longer use to make room.
- **`--save`** replaces the profile's browser sign-in. After it, managing keys and billing need `zetta auth login` again.
- **Not an MCP tool:** `apikey create` is left out of `zetta mcp`, so a new key never lands in an agent's context.
- **On the website:** keys are also under Profile › API keys.

### What an API key can do

| With an API key | Only with the browser sign-in |
|---|---|
| Check the account and plan: `auth status`, `account show`, `account credits`, `catalog …` | Managing API keys: `apikey …` |
| Generate and refine: `generate`, `refine …` | Buying and billing changes: `billing checkout`, `billing agent-plan`, `billing portal` |
| Your 3D library: `asset …`, including AI tags and rig checks | Trial codes: `account redeem` |
| Pictures and background removal: `image …` | `account connections`, `account onboarding`, `account early-access` |
| Pipelines: `pipeline list`, `get`, `estimate`, `run`, `batch`, and run control (`run …`) | Deleting the account |
| Subscription and usage: `billing subscription`, `account usage` | Creating or changing pipelines: `pipeline create`, `update`, `duplicate`, `delete`, `draft` |
| | Splats and worlds (`splat …`), and video uploads |

What happens with a key:
- **Commands that need a browser sign-in** fail at once, before any request, with `API_KEY_NOT_ALLOWED` (exit code 3). Run `zetta auth login`, and unset `ZETTA_API_KEY`.
- **Pipeline changes** are refused with `PIPELINE_EDIT_NOT_ALLOWED`, and splats with `SPLAT_NOT_IN_API` (both exit code 4).
- **Image engines** go by their public names (`flash`, `pro`, `image-1` …), as they do with a session.
- **Rate limits:** API keys allow 300 requests a minute and 5,000 an hour. When the server asks to wait a minute or less, the CLI waits and tries again on its own. A longer wait fails with `RATE_LIMITED` (exit code 8), with the seconds to wait in `details.retryAfter`.

## Checking and signing out

```bash
zetta auth status
```

```
Signed in as you@example.com (creator plan) · profile default · session token from keychain · expires in 27 days
Signed in as you@example.com (creator plan) · profile default · API key zk_live_Ab3x…wxyz from ZETTA_API_KEY · does not expire
```

What `auth status` tells you:
- **The credential:** the browser sign-in (shown as a session token) or an API key, and where it comes from. A key is shown as a hint, never in full.
- **Expiry:** when fewer than 3 days are left on the browser sign-in, it warns you. Once it expires, commands fail with `INVALID_SESSION` (exit code 3). Run `zetta auth login` again.
- **A refused key:** a revoked or mistyped key fails with `INVALID_API_KEY` (exit code 3).

```bash
zetta auth logout         # forgets the saved sign-in (token or key) for this profile
```

Only the local copy is deleted. An API key keeps working until you revoke it with `zetta apikey revoke <id>` (after `zetta auth login`) or on the website. If `ZETTA_API_KEY` is still set, `logout` says so.

## Where the sign-in is kept

| Order | Source | Notes |
|---|---|---|
| 1 | `ZETTA_API_KEY` environment variable | An API key only; never written anywhere. Anything else there is refused (`INVALID_API_KEY`) |
| 2 | System keychain | macOS Keychain, Windows Credential Manager, or libsecret on Linux desktops |
| 3 | `credentials.json` in the config folder, mode `0600` | Used when there is no keychain, or with `ZETTA_NO_KEYCHAIN=1` |

How it works:
- **One saved sign-in per profile.** Saving an API key replaces a browser sign-in, and signing in with a browser replaces a saved key.
- **`ZETTA_API_KEY` wins** over the saved sign-in, and is never saved. `auth login` warns you when it is set.
- **`ZETTA_TOKEN` is no longer read.** Older versions took a pasted session token from it. If it is set and you aren't signed in, the error says so.

The config folder is `~/.config/zetta3d` (Windows: `%APPDATA%\zetta3d`), or `ZETTA_CONFIG_DIR`. `zetta doctor` tells you which store is in use.

## Security notes

- **Accounts connect only through the browser.** You sign in on zetta3d.ai and approve the CLI there. The CLI never prints its session, and it can't be pasted into another machine; other machines use an API key.
- **API keys come from a signed-in account.** They are made on the website or with `zetta apikey create` after the browser sign-in, and each one can be revoked.
- **An API key works until you revoke it.** If one leaks, revoke it at once with `zetta apikey revoke <id>`. Use one key per machine or job, so you can revoke one without stopping the rest.
- **The CLI never sees card details.** `zetta billing checkout` and `zetta billing portal` give you a link to the hosted payment page.

## Your plan and billing

There is no free tier. Every command that spends needs a plan: 3D models, finishing tools, pictures, AI tags and rig checks, pipeline runs and drafts. Without one, they fail with `PLAN_REQUIRED` (exit code 4) and nothing is spent. A plan comes from a checkout, or from a trial code:

```bash
zetta billing plans                       # 3D plans, credit packs and Agent plans
zetta billing checkout creator            # a link to pay for a plan (--yearly to pay yearly)
zetta account redeem ZETTA-7KQ2-M9XD      # a trial code: 10 days of the Basic plan
```

A trial code works once per account, on an account without a plan. It takes any form: `ZETTA-7KQ2-M9XD`, lower case, without dashes, or the whole link with `?trial=`.

### Your account

```bash
zetta account show                        # email, plan, trial, Agent plan, credits and access
zetta account credits                     # balances per pool
zetta account usage --meter ai-tokens     # what was charged and refunded, and where
zetta account usage --breakdown           # this period's totals by feature
zetta account connections                 # plugins and CLIs connected to the account
```

Some details:
- **`account show`** has `trial` (the plan and end date while a trial runs), `trialAvailable` (a trial code can still be redeemed) and `agentPlan` (an Agent plan is in force).
- **`account credits`** has `canSpend`, which is `false` without a plan.
- **`account usage`** lists entries newest first. Each says where it was spent (`origin`: web, unity, blender, unreal, pipeline, cli or api) and, for AI turns, the tier. `--meter credits|ai-tokens` shows one balance.
- **`--breakdown`** sums this billing period (the last 30 days without a subscription) by feature, and AI tokens also by tier. It takes only `--meter` (default `credits`).
- **`account connections`** lists each plugin and CLI with its version, its host app's version, and when it was first and last seen.
- **`account onboarding`** answers the five onboarding questions. Only some plans pay a bonus for it; `account show` says whether one is waiting.

### Billing

| Command | What it does |
|---|---|
| `billing plans` | 3D plans, credit packs, and Agent plans (AI tokens for the agents, every month) |
| `billing checkout <plan> [--yearly]` | A link to buy a 3D plan |
| `billing checkout --pack <credits>` | A link to buy a credit pack, on top of a plan |
| `billing checkout --agent <name>` | A link to buy an Agent plan. Agent plans are monthly only, so no `--yearly`. An account has one at a time |
| `billing agent-plan <name>` | Switch your Agent plan to another size. The prorated difference is charged to your card at once (a smaller plan is credited). Asks first; `--yes` without a terminal |
| `billing subscription` | Your plan and Agent plan: status and renewal dates |
| `billing portal` | A link to manage your subscription, Agent plan, card and invoices |

Some details:
- **`billing agent-plan`** is not an MCP tool, because it charges a card. A declined card changes nothing.
- **Deleting the account** (`zetta account delete`) is refused with `SUBSCRIPTION_ACTIVE` while a plan or an Agent plan is live. Cancel both first with `zetta billing portal`.

## Profiles: several accounts or servers

Each profile has its own API address and its own sign-in.

```bash
zetta config profiles                                   # default, local, and any you added
zetta --profile local auth login                        # sign in to a local development server
zetta config add-profile staging --api https://staging-api.example.com/api --site https://staging.example.com
zetta config use staging                                # make it the default
ZETTA_PROFILE=staging zetta asset list                  # or pick it per command
```

`local` is built in: it points at `http://localhost:4000/api` and `http://localhost:3000`.
