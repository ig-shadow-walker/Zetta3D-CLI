# Command reference

_Generated from the command definitions by `bun run docs:commands`. Do not edit by hand._

Global flags: `--output text|json|ndjson`, `--json`, `--profile <name>`, `--api-url <url>`, `--verbose`, `--quiet`, `--no-color`, `--non-interactive`. Every command also takes `--input <json|@file|->`.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Unexpected error |
| 2 | Bad usage or failed local check (fix the input) |
| 3 | Not signed in, the token expired or the API key was refused, or the command needs a browser sign-in (run `zetta auth login`) |
| 4 | Your plan or access does not allow this (no plan yet, a missing feature, or an API key limit) |
| 5 | Not enough credits, or over the spend limit |
| 6 | Not found |
| 7 | Conflict, or a concurrency limit was reached |
| 8 | Rate limited (after retries) |
| 9 | The remote job failed or was cancelled |
| 10 | Stopped waiting; the job is still running |
| 11 | Network or server error |

## auth

Sign in and out; see who you are signed in as.

### `zetta auth login`

Sign in to your Zetta 3D account in the browser (or with an API key).

Ways to sign in:
    (default)        Opens zetta3d.ai in your browser; sign in there and click Connect.
    --api-key        An API key (zk_live_…), piped on stdin or typed at a hidden prompt. For CI, scripts, servers and
    machines without a browser. Make one on the website (Profile › API keys) or with `zetta apikey create`.
Instead of signing in, a script can also set ZETTA_API_KEY.
An API key generates, makes pictures, runs pipelines and reads your balance; managing keys, billing and the account needs the browser sign-in.

```
zetta auth login [flags]
```

Kind: changes something (free) · not an MCP tool

| Argument / flag | Type | Description |
|---|---|---|
| `--api-key` | boolean | Sign in with an API key, read from stdin when piped, else from a hidden prompt. Never pass the key as an argument. |
| `--print-url` | boolean | Print the sign-in address instead of opening the browser (open it in a browser on this computer). |

Examples:

```bash
zetta auth login
zetta auth login --api-key
echo "$ZETTA_API_KEY" | zetta auth login --api-key
```

### `zetta auth logout`

Forget the saved sign-in (token or API key) for this profile.

Only the local copy is deleted. A session token keeps working until it expires; an API key keeps working until it is revoked (`zetta apikey revoke <id>`, or on the website).

```
zetta auth logout [flags]
```

Kind: changes something (free) · not an MCP tool

### `zetta auth status`

Show who you are signed in as, with what kind of credential, and where it comes from.

The credential is the browser sign-in (30 days) or an API key (zk_live_…, until revoked). ZETTA_API_KEY wins over the saved sign-in. Keys are shown as a hint (zk_live_Ab3x…wxyz), never in full.

```
zetta auth status [flags]
```

Kind: reads only · MCP tool `auth_status`

## account

Your account, credits, usage history, trial codes and connected apps.

### `zetta account show`

Your account: email, plan, trial, Agent plan, credits and access.

```
zetta account show [flags]
```

Kind: reads only · MCP tool `account_show`

### `zetta account credits`

Your credit balances, per pool.

3D credits pay for generations and finishing tools (1 credit = €0.01). AI tokens pay for the agents and AI helpers such as auto-tagging. Spending needs a plan (or a running trial); without one, balances cannot be used.

```
zetta account credits [flags]
```

Kind: reads only · MCP tool `account_credits`

### `zetta account usage`

Your usage history (what was charged and refunded, and where), or this period’s totals with --breakdown.

Entries are newest first, each with where it was spent (web, unity, blender, unreal, pipeline, cli or api) and, for AI turns, the tier.
--breakdown sums this billing period (the last 30 days without a subscription) by feature, and AI tokens also by tier.

```
zetta account usage [flags]
```

Kind: reads only · MCP tool `account_usage`

| Argument / flag | Type | Description |
|---|---|---|
| `--meter` | `credits` \| `ai-tokens` | One balance only: 3D credits or AI tokens (default: both; with --breakdown, credits). |
| `--breakdown` | boolean | Totals for this billing period by feature (and AI tier) instead of the entry list. |
| `--limit` | number | Entries per page (max 100). |
| `--before` | string | Show entries older than this cursor (the `nextCursor` of the previous page). |
| `--all` | boolean | Fetch every page. |

Examples:

```bash
zetta account usage --meter ai-tokens
zetta account usage --breakdown --meter ai-tokens
```

### `zetta account redeem`

Redeem a trial code: 10 days of the Basic plan, free.

For accounts without a plan that have not had a trial. Any shape works: ZETTA-7KQ2-M9XD, lower case, without dashes, or the whole link with ?trial=. Needs a browser sign-in.

```
zetta account redeem <code> [flags]
```

Kind: changes something (free) · MCP tool `account_redeem`

| Argument / flag | Type | Description |
|---|---|---|
| `<code>` | string | The trial code (e.g. ZETTA-7KQ2-M9XD) or the link that carries it. (**required**) |

Examples:

```bash
zetta account redeem ZETTA-7KQ2-M9XD
```

### `zetta account connections`

Plugins and CLIs connected to your account, with versions and when each was last seen.

Needs a browser sign-in.

```
zetta account connections [flags]
```

Kind: reads only · MCP tool `account_connections`

### `zetta account onboarding`

Answer the five onboarding questions (pays a one-time credit bonus on plans that have one).

Answers use the ids the web onboarding uses. `zetta account show` says whether a bonus is waiting. Calling it again is harmless; a bonus is paid once. Needs a browser sign-in.

```
zetta account onboarding [flags]
```

Kind: changes something (free) · MCP tool `account_onboarding`

| Argument / flag | Type | Description |
|---|---|---|
| `--user-type` | `company` \| `startup` \| `personal` | Who you are. (**required**) |
| `--industry` | `gaming` \| `film` \| `ecommerce` \| `printing` \| `architecture` \| `interior` \| `fashion` \| `xr` \| `other` | Your industry. (**required**) |
| `--industry-other` | string | Your industry, when --industry is other. |
| `--tools` | string (repeatable) | 3D tools you use (ids as in the web onboarding, e.g. blender, max, c4d, zbrush, houdini, or none). (**required**) |
| `--engines` | string (repeatable) | Game engines you use (e.g. unity, unreal, godot, or none). (**required**) |
| `--heard-from` | `google` \| `word-of-mouth` \| `linkedin` \| `youtube` \| `x` \| `friend` \| `other` | Where you heard about Zetta 3D. |

### `zetta account early-access`

Ask for access to an early-access feature (e.g. splat).

Needs a browser sign-in.

```
zetta account early-access <feature> [flags]
```

Kind: changes something (free) · MCP tool `account_early_access`

| Argument / flag | Type | Description |
|---|---|---|
| `<feature>` | string | The feature to ask for, e.g. "Zetta Splat". (**required**) |
| `--email` | string | Where to reach you, if not your account email. |

### `zetta account delete`

Delete your account and everything in it. Cannot be undone.

Only works in a terminal, after typing your email to confirm, with a browser sign-in. Cancel any subscription and any Agent plan first (`zetta billing portal`).

```
zetta account delete [flags]
```

Kind: **destructive** · not an MCP tool

## apikey

API keys for scripts, CI and servers: create, list, revoke; usage and request logs.

### `zetta apikey list`

Your API keys: name, hint and when each was last used. Never the keys themselves.

Needs a browser sign-in (`zetta auth login`); API keys cannot list keys.

```
zetta apikey list [flags]
```

Kind: reads only · MCP tool `apikey_list`

### `zetta apikey create`

Make an API key for scripts, CI or a server. The key is shown once.

Needs a paid plan and a browser sign-in. An account can have 10 keys.
The whole key is printed once and never again: copy it into your secret store, then use it as ZETTA_API_KEY or with `zetta auth login --api-key`.
--save stores it as this profile's sign-in instead (in the system keychain) and does not print it. That replaces the browser sign-in, so managing keys and billing will need `zetta auth login` again.
Not offered as an MCP tool: a new key must not land in an agent’s context.

```
zetta apikey create <name> [flags]
```

Kind: changes something (free) · not an MCP tool

| Argument / flag | Type | Description |
|---|---|---|
| `<name>` | string | What the key is for, so you can tell keys apart (at most 60 characters), e.g. "ci" or "build server". (**required**) |
| `--save` | boolean | Save the key as this profile's sign-in (keychain) instead of printing it. |

Examples:

```bash
zetta apikey create ci
zetta apikey create laptop --save
```

### `zetta apikey revoke`

Revoke an API key. Anything using it stops working at once.

Needs a browser sign-in. In a terminal you are asked first; otherwise pass --yes.

```
zetta apikey revoke <id> [flags]
```

Kind: **destructive** · MCP tool `apikey_revoke`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | The key id (see `zetta apikey list`). (**required**) |
| `--yes` | boolean | Revoke without asking. |

### `zetta apikey usage`

What your API keys did: requests, errors, jobs, credits and AI tokens over recent days.

Needs a browser sign-in. Covers every key unless --key names one.

```
zetta apikey usage [flags]
```

Kind: reads only · MCP tool `apikey_usage`

| Argument / flag | Type | Description |
|---|---|---|
| `--key` | string | One key only: its id (see `zetta apikey list`) or its name. Default: every key. |
| `--days` | number | How many days back (1–90, default 30). |

Examples:

```bash
zetta apikey usage
zetta apikey usage --key ci --days 7
```

### `zetta apikey logs`

Requests made with your API keys, newest first (kept 90 days).

Needs a browser sign-in. Each row: when, which key, the call, its status and what it made.

```
zetta apikey logs [flags]
```

Kind: reads only · MCP tool `apikey_logs`

| Argument / flag | Type | Description |
|---|---|---|
| `--key` | string | One key only: its id (see `zetta apikey list`) or its name. Default: every key. |
| `--errors` | boolean | Only failed requests (status 400 and up). |
| `--before` | number | Older than this request id (the `nextCursor` of the previous page). |
| `--limit` | number | Requests per page (1–100, default 50). |

Examples:

```bash
zetta apikey logs --errors
zetta apikey logs --key ci --limit 100
```

## billing

Plans, Agent plans, subscription, checkout and billing portal links.

### `zetta billing plans`

3D plans, credit packs and Agent plans, with what each includes.

There is no free tier: generating needs a 3D plan (or a trial code). Agent plans add AI time for the agents every month, on their own or beside a 3D plan, billed monthly.

```
zetta billing plans [flags]
```

Kind: reads only · MCP tool `billing_plans`

### `zetta billing subscription`

Your subscription and Agent plan: status and renewal dates.

```
zetta billing subscription [flags]
```

Kind: reads only · MCP tool `billing_subscription`

### `zetta billing checkout`

Get a secure checkout link to buy a 3D plan, a credit pack or an Agent plan.

Payment happens on the hosted checkout page in your browser; this CLI never sees card details. An agent can hand the link to a person.
An account has one Agent plan at a time: to change its size, use `zetta billing agent-plan <name>`. Needs a browser sign-in.

```
zetta billing checkout [plan] [flags]
```

Kind: changes something (free) · MCP tool `billing_checkout`

| Argument / flag | Type | Description |
|---|---|---|
| `<plan>` | string | 3D plan to subscribe to (e.g. basic, creator), or a raw price id. |
| `--yearly` | boolean | Pay a 3D plan yearly instead of monthly. |
| `--pack` | number | Buy the credit pack with this many credits instead of a plan. |
| `--agent` | string | Buy this Agent plan (e.g. plus, or "Agent Plus"); see `zetta billing plans`. |

Examples:

```bash
zetta billing checkout creator
zetta billing checkout --pack 1000
zetta billing checkout --agent plus
```

### `zetta billing agent-plan`

Switch your Agent plan to another size. The prorated difference is charged to your card at once.

Only for an Agent plan you already have; buy the first one with `zetta billing checkout --agent <name>`.
A bigger plan charges the difference for the rest of this billing period to the card on file now (a smaller one is credited); a declined card changes nothing.
In a terminal you are asked first; otherwise pass --yes. Needs a browser sign-in. Not offered as an MCP tool, because it charges a card.

```
zetta billing agent-plan <name> [flags]
```

Kind: changes something (free) · not an MCP tool

| Argument / flag | Type | Description |
|---|---|---|
| `<name>` | string | The Agent plan to switch to: its name (e.g. plus, or "Agent Plus") or price id. See `zetta billing plans`. (**required**) |
| `--yes` | boolean | Switch (and pay the difference) without asking. |

Examples:

```bash
zetta billing agent-plan max
```

### `zetta billing portal`

Get a link to manage your subscription, Agent plan, card and invoices.

Needs a browser sign-in.

```
zetta billing portal [flags]
```

Kind: changes something (free) · MCP tool `billing_portal`

## catalog

Engines, prices and what your plan allows.

### `zetta catalog engines`

The 3D, splat and image engines, and what each supports.

```
zetta catalog engines [flags]
```

Kind: reads only · MCP tool `catalog_engines`

| Argument / flag | Type | Description |
|---|---|---|
| `--images` | boolean | List the image engines available to your account instead (needs sign-in). |

### `zetta catalog pricing`

Credit price of every 3D option (1 credit = €0.01).

```
zetta catalog pricing [flags]
```

Kind: reads only · MCP tool `catalog_pricing`

### `zetta catalog entitlements`

What your plan allows: generating at all, engines, multi-view, low-poly, quads, private models, concurrency.

```
zetta catalog entitlements [flags]
```

Kind: reads only · MCP tool `catalog_entitlements`

## splat

Gaussian-splat worlds from pictures or video (early access).

### `zetta splat create`

Make a Gaussian-splat object or world from pictures, a video, or a prompt (early access).

Engines: splat (Zetta Splat: an object or scene from one picture), splat2 and splat2.1 (Zetta Splat 2 and 2.1: whole worlds; also from a video, or several pictures of the same place).
A prompt is made into a picture first: an object on a plain background, or with --subject environment a whole place in a --aspect-ratio and --resolution frame (16:9 at 1K by default).
More pictures of the same place: --world-view <azimuth>=<picture>, e.g. 90=right.jpg (degrees clockwise from the main picture, 1–359; leave the angle out if unknown). Up to 3, or 7 with --same-space.
Exports from a world: `zetta splat export <id> --as splat|mesh|collider`.

```
zetta splat create [flags]
```

Kind: **spends credits** · MCP tool `splat_create`

| Argument / flag | Type | Description |
|---|---|---|
| `--image` | string | The main picture: a file, URL or image:<id>. |
| `--video` | string | A video of the place (splat2/2.1): MP4, WebM, MOV or AVI up to 100 MB. |
| `--prompt` | string | Describe the scene. Without a picture, a picture is made from it first; beside a picture or video on splat2/2.1, it describes the scene. |
| `--engine` | string | splat (default, id n25), splat2 (zs2) or splat2.1 (zs21). |
| `--subject` | `object` \| `environment` | What a prompt picture shows: an object, or an environment (default environment on splat2/2.1, object on splat). |
| `--aspect-ratio` | `16:9` \| `21:9` \| `3:2` \| `4:3` \| `1:1` | Frame of an environment picture made from --prompt (default 16:9). |
| `--resolution` | `1K` \| `2K` \| `4K` | Size of an environment picture made from --prompt (default 1K). |
| `--remove-bg` | boolean | Cut the object out of its background first (an object on the splat engine only). |
| `--world-view` | string (repeatable) | Extra pictures of the same place as azimuth=picture (splat2/2.1). |
| `--same-space` | boolean | Reconstruct from all pictures together (up to 8). |
| `--seed` | number | Seed (splat engine only). |
| `--title` | string | Title in your library. |
| `--tag` | string (repeatable) | Tags. |
| `--visibility` | `public` \| `private` | Share publicly, or keep private. |
| `--format` | string (repeatable) | When downloading: only these formats (ply, spz, glb …). |
| `--yes` | boolean | Spend without asking. Needed when not in a terminal, unless --max-credits covers the price. |
| `--max-credits` | number | Refuse if this would cost more than this many credits. |
| `--dry-run` | boolean | Show the price and stop. Nothing is spent. |
| `--idempotency-key` | string | Reuse the same key to retry a command without paying twice. |
| `--wait` | boolean | Wait for the job to finish (default: return at once with its id, unless it downloads automatically). |
| `--timeout` | string | Stop waiting after this long, e.g. 90s, 10m. The job keeps running. |
| `--out` | string | Download the results into this folder when done (implies --wait). |
| `--download` | boolean | Wait, then download the results into the current folder (default: the download.auto setting, which is on in a terminal). --no-download returns at once. |

Examples:

```bash
zetta splat create --image room.jpg --engine splat2 --dry-run
zetta splat create --video walkthrough.mp4 --engine splat2.1 --yes --wait
zetta splat create -p "a misty pine forest clearing" --engine splat2 --aspect-ratio 21:9 --resolution 2K --dry-run
```

### `zetta splat export`

Export a splat world as a PLY splat, a mesh, or a collider mesh.

```
zetta splat export <id> [flags]
```

Kind: **spends credits** · MCP tool `splat_export`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | A Zetta Splat 2 / 2.1 world in your library. (**required**) |
| `--as` | `splat` \| `mesh` \| `collider` | What to export. (**required**) |
| `--resolution` | `full_res` \| `500k` \| `150k` \| `100k` | With --as splat: how many splats (default full_res). |
| `--mesh-variant` | `textured` \| `vertex_colored` | With --as mesh: textured (default) or vertex_colored. |
| `--title` | string | Title of the export. |
| `--format` | string (repeatable) | When downloading: only these formats. |
| `--yes` | boolean | Spend without asking. Needed when not in a terminal, unless --max-credits covers the price. |
| `--max-credits` | number | Refuse if this would cost more than this many credits. |
| `--dry-run` | boolean | Show the price and stop. Nothing is spent. |
| `--idempotency-key` | string | Reuse the same key to retry a command without paying twice. |
| `--wait` | boolean | Wait for the job to finish (default: return at once with its id, unless it downloads automatically). |
| `--timeout` | string | Stop waiting after this long, e.g. 90s, 10m. The job keeps running. |
| `--out` | string | Download the results into this folder when done (implies --wait). |
| `--download` | boolean | Wait, then download the results into the current folder (default: the download.auto setting, which is on in a terminal). --no-download returns at once. |

Examples:

```bash
zetta splat export 1234 --as collider --yes --out ./unity/Assets
```

## refine

Finishing tools: retopology, segmentation, UVs, texturing, rigging, conversion.

### `zetta refine retopo`

Rebuild a model’s topology to a clean, lower polygon count.

Runs on Zetta R1 to an exact --faces budget: 500–20,000 triangles, or 500–10,000 with --quads (default 8,000).

```
zetta refine retopo <source> [flags]
```

Kind: **spends credits** · MCP tool `refine_retopo`

| Argument / flag | Type | Description |
|---|---|---|
| `<source>` | string | The model: an asset id, a local .glb file, or a URL to a .glb/.obj/.fbx. (**required**) |
| `--title` | string | Title of the new asset. |
| `--tag` | string (repeatable) | Tags for the new asset. |
| `--visibility` | `public` \| `private` | Share publicly, or keep private. |
| `--format` | string (repeatable) | When downloading: only these formats. |
| `--yes` | boolean | Spend without asking. Needed when not in a terminal, unless --max-credits covers the price. |
| `--max-credits` | number | Refuse if this would cost more than this many credits. |
| `--dry-run` | boolean | Show the price and stop. Nothing is spent. |
| `--idempotency-key` | string | Reuse the same key to retry a command without paying twice. |
| `--wait` | boolean | Wait for the job to finish (default: return at once with its id, unless it downloads automatically). |
| `--timeout` | string | Stop waiting after this long, e.g. 90s, 10m. The job keeps running. |
| `--out` | string | Download the results into this folder when done (implies --wait). |
| `--download` | boolean | Wait, then download the results into the current folder (default: the download.auto setting, which is on in a terminal). --no-download returns at once. |
| `--faces` | number | Target faces: 500–20,000 triangles or 500–10,000 quads. Default 8,000. |
| `--quads` | boolean | Quad topology. |
| `--bake` | boolean | Carry the textures onto the new mesh (default on; --no-bake for bare geometry). |
| `--unwrap-uvs` | boolean | Unwrap fresh UVs in the same job, at no extra cost (replaces the UV layout). |
| `--part` | string (repeatable) | Only these named parts of a segmented model. |

Examples:

```bash
zetta refine retopo 1234 --faces 5000 --quads --yes --wait
zetta refine retopo ./scan.glb --faces 2000 --unwrap-uvs --dry-run
```

### `zetta refine segment`

Split a model into separate parts.

--smart uses the smarter segmentation (optionally guided by --prompt).

```
zetta refine segment <source> [flags]
```

Kind: **spends credits** · MCP tool `refine_segment`

| Argument / flag | Type | Description |
|---|---|---|
| `<source>` | string | The model: an asset id, a local .glb file, or a URL to a .glb/.obj/.fbx. (**required**) |
| `--title` | string | Title of the new asset. |
| `--tag` | string (repeatable) | Tags for the new asset. |
| `--visibility` | `public` \| `private` | Share publicly, or keep private. |
| `--format` | string (repeatable) | When downloading: only these formats. |
| `--yes` | boolean | Spend without asking. Needed when not in a terminal, unless --max-credits covers the price. |
| `--max-credits` | number | Refuse if this would cost more than this many credits. |
| `--dry-run` | boolean | Show the price and stop. Nothing is spent. |
| `--idempotency-key` | string | Reuse the same key to retry a command without paying twice. |
| `--wait` | boolean | Wait for the job to finish (default: return at once with its id, unless it downloads automatically). |
| `--timeout` | string | Stop waiting after this long, e.g. 90s, 10m. The job keeps running. |
| `--out` | string | Download the results into this folder when done (implies --wait). |
| `--download` | boolean | Wait, then download the results into the current folder (default: the download.auto setting, which is on in a terminal). --no-download returns at once. |
| `--smart` | boolean | Smart segmentation (better parts, costs more). |
| `--granularity` | `simple` \| `balanced` \| `detailed` | How finely to split. |
| `--split-by-connectivity` | boolean | Split disconnected pieces apart (default on; --no-split-by-connectivity to turn off). |
| `--prompt` | string | With --smart: which parts you want, e.g. "seat, legs, backrest". |

### `zetta refine uv`

Unwrap clean UVs (Smart UV). Max 80,000 triangles.

```
zetta refine uv <source> [flags]
```

Kind: **spends credits** · MCP tool `refine_uv`

| Argument / flag | Type | Description |
|---|---|---|
| `<source>` | string | The model: an asset id, a local .glb file, or a URL to a .glb/.obj/.fbx. (**required**) |
| `--title` | string | Title of the new asset. |
| `--tag` | string (repeatable) | Tags for the new asset. |
| `--visibility` | `public` \| `private` | Share publicly, or keep private. |
| `--format` | string (repeatable) | When downloading: only these formats. |
| `--yes` | boolean | Spend without asking. Needed when not in a terminal, unless --max-credits covers the price. |
| `--max-credits` | number | Refuse if this would cost more than this many credits. |
| `--dry-run` | boolean | Show the price and stop. Nothing is spent. |
| `--idempotency-key` | string | Reuse the same key to retry a command without paying twice. |
| `--wait` | boolean | Wait for the job to finish (default: return at once with its id, unless it downloads automatically). |
| `--timeout` | string | Stop waiting after this long, e.g. 90s, 10m. The job keeps running. |
| `--out` | string | Download the results into this folder when done (implies --wait). |
| `--download` | boolean | Wait, then download the results into the current folder (default: the download.auto setting, which is on in a terminal). --no-download returns at once. |
| `--bake` | boolean | Re-bake the existing texture onto the new UVs (off by default: bare UVs). |
| `--orientation` | `as-is` \| `+x` \| `-x` \| `+y` \| `-y` | Which way the model faces in the export (default as-is). |
| `--compress` | boolean | Compress geometry. |

### `zetta refine texture`

Repaint a model’s texture from a reference picture, several views, or a description.

Give --reference (a picture of the look you want), --prompt (a description), or both; or reference pictures of several sides with --view.
A description is turned into a reference picture first (needs image editing on your plan).

```
zetta refine texture <source> [flags]
```

Kind: **spends credits** · MCP tool `refine_texture`

| Argument / flag | Type | Description |
|---|---|---|
| `<source>` | string | The model: an asset id, a local .glb file, or a URL to a .glb/.obj/.fbx. (**required**) |
| `--title` | string | Title of the new asset. |
| `--tag` | string (repeatable) | Tags for the new asset. |
| `--visibility` | `public` \| `private` | Share publicly, or keep private. |
| `--format` | string (repeatable) | When downloading: only these formats. |
| `--yes` | boolean | Spend without asking. Needed when not in a terminal, unless --max-credits covers the price. |
| `--max-credits` | number | Refuse if this would cost more than this many credits. |
| `--dry-run` | boolean | Show the price and stop. Nothing is spent. |
| `--idempotency-key` | string | Reuse the same key to retry a command without paying twice. |
| `--wait` | boolean | Wait for the job to finish (default: return at once with its id, unless it downloads automatically). |
| `--timeout` | string | Stop waiting after this long, e.g. 90s, 10m. The job keeps running. |
| `--out` | string | Download the results into this folder when done (implies --wait). |
| `--download` | boolean | Wait, then download the results into the current folder (default: the download.auto setting, which is on in a terminal). --no-download returns at once. |
| `--reference` | string | Reference picture: a file, URL or image:<id>. |
| `--view` | string (repeatable) | Reference views as side=picture instead of --reference: front (required), back, left, right. |
| `--prompt` | string | Describe the look, e.g. "weathered bronze with green patina". |
| `--tier` | `standard` \| `hd` \| `8k` | Texture resolution: standard (2K), hd (4K) or 8k. Each has its own price. |
| `--alignment` | `image` \| `geometry` | Follow the picture (default) or the mesh. |
| `--pbr` | boolean | PBR materials (default on; free on a retexture). |
| `--bake` | boolean | Bake material effects into the base texture (default on). |
| `--fast` | boolean | Faster setting of the standard tier. |
| `--delight` | boolean | Remove lighting baked into the reference first (default on). |
| `--remove-bg` | boolean | Remove the reference pictures’ backgrounds first. |
| `--part` | string (repeatable) | Only these named parts. |
| `--seed` | number | Texture seed. |

Examples:

```bash
zetta refine texture 1234 --reference oak.jpg --tier hd --yes
zetta refine texture 1234 --prompt "brushed steel" --dry-run
zetta refine texture 1234 --view front=f.png --view back=b.png --dry-run
```

### `zetta refine rig`

Add a skeleton so the model can be animated.

Not sure which --rig-type? Run `zetta asset rig-check <id>` first; others is for a creature none of the named bodies describe.
A humanoid (biped) can be written in another skeleton naming with --rig-spec: mixamo, unity (Humanoid), unreal (UE5 Mannequin), vrm (VRM 1.0) or actorcore.

```
zetta refine rig <source> [flags]
```

Kind: **spends credits** · MCP tool `refine_rig`

| Argument / flag | Type | Description |
|---|---|---|
| `<source>` | string | The model: an asset id, a local .glb file, or a URL to a .glb/.obj/.fbx. (**required**) |
| `--title` | string | Title of the new asset. |
| `--tag` | string (repeatable) | Tags for the new asset. |
| `--visibility` | `public` \| `private` | Share publicly, or keep private. |
| `--format` | string (repeatable) | When downloading: only these formats. |
| `--yes` | boolean | Spend without asking. Needed when not in a terminal, unless --max-credits covers the price. |
| `--max-credits` | number | Refuse if this would cost more than this many credits. |
| `--dry-run` | boolean | Show the price and stop. Nothing is spent. |
| `--idempotency-key` | string | Reuse the same key to retry a command without paying twice. |
| `--wait` | boolean | Wait for the job to finish (default: return at once with its id, unless it downloads automatically). |
| `--timeout` | string | Stop waiting after this long, e.g. 90s, 10m. The job keeps running. |
| `--out` | string | Download the results into this folder when done (implies --wait). |
| `--download` | boolean | Wait, then download the results into the current folder (default: the download.auto setting, which is on in a terminal). --no-download returns at once. |
| `--rig-type` | `biped` \| `quadruped` \| `hexapod` \| `octopod` \| `avian` \| `serpentine` \| `aquatic` \| `others` | Body plan: biped, quadruped, hexapod, octopod, avian, serpentine, aquatic, others (default biped). |
| `--rig-spec` | `standard` \| `mixamo` \| `unity` \| `unreal` \| `vrm` \| `actorcore` | Skeleton naming for a biped: standard, mixamo, unity, unreal, vrm, actorcore (default standard). |
| `--rig-format` | `glb` \| `fbx` | File format of the rigged model (default glb). |

Examples:

```bash
zetta refine rig 1234 --rig-type quadruped --rig-format fbx --yes --out .
zetta refine rig 1234 --rig-spec unreal --dry-run
```

### `zetta refine convert`

Convert to FBX, USDZ, OBJ, STL, 3MF or glTF on the server, with optional clean-up.

For a quick, free GLB → OBJ/STL on your own machine, use `zetta asset export`. Geometry or texture options switch to the advanced (pricier) tier.

```
zetta refine convert <source> [flags]
```

Kind: **spends credits** · MCP tool `refine_convert`

| Argument / flag | Type | Description |
|---|---|---|
| `<source>` | string | The model: an asset id, a local .glb file, or a URL to a .glb/.obj/.fbx. (**required**) |
| `--title` | string | Title of the new asset. |
| `--tag` | string (repeatable) | Tags for the new asset. |
| `--visibility` | `public` \| `private` | Share publicly, or keep private. |
| `--format` | string (repeatable) | When downloading: only these formats. |
| `--yes` | boolean | Spend without asking. Needed when not in a terminal, unless --max-credits covers the price. |
| `--max-credits` | number | Refuse if this would cost more than this many credits. |
| `--dry-run` | boolean | Show the price and stop. Nothing is spent. |
| `--idempotency-key` | string | Reuse the same key to retry a command without paying twice. |
| `--wait` | boolean | Wait for the job to finish (default: return at once with its id, unless it downloads automatically). |
| `--timeout` | string | Stop waiting after this long, e.g. 90s, 10m. The job keeps running. |
| `--out` | string | Download the results into this folder when done (implies --wait). |
| `--download` | boolean | Wait, then download the results into the current folder (default: the download.auto setting, which is on in a terminal). --no-download returns at once. |
| `--to` | string | Target format: GLTF, FBX, USDZ, OBJ, STL, 3MF (any case). (**required**) |
| `--quad` | boolean | Quad topology. |
| `--symmetry` | boolean | Force symmetry. |
| `--faces` | number | Face limit: 1,000–1,000,000, or up to 150,000 with --quad. |
| `--flatten-bottom` | boolean | Flatten the base (for printing or placing). |
| `--flatten-threshold` | number | How much of the base to flatten. |
| `--texture-size` | number | Texture size in pixels (128–4096). |
| `--texture-format` | string | Texture image format: JPEG, PNG, WEBP, BMP, DPX, HDR, OPEN_EXR, TARGA, TIFF (any case). |
| `--pack-uv` | boolean | Pack UVs. |
| `--vertex-colors` | boolean | Export vertex colours. |
| `--pivot-bottom` | boolean | Put the pivot at the bottom centre. |
| `--scale` | number | Scale factor. |
| `--with-animation` | boolean | Keep animation. |
| `--in-place` | boolean | Animate in place. |
| `--orientation` | `+x` \| `-x` \| `-y` \| `+y` | Forward axis. |
| `--fbx-preset` | `blender` \| `3dsmax` \| `mixamo` | FBX preset for a target app. |

Examples:

```bash
zetta refine convert 1234 --to usdz --yes --out .
zetta refine convert 1234 --to fbx --fbx-preset blender --dry-run
```

## asset

Your 3D library: list, inspect, wait, download, share, delete, import.

### `zetta asset export`

Convert a GLB to OBJ, FBX (both with materials and textures) or STL, locally and for free.

Works on a library asset or a local .glb file. For USDZ, 3MF or clean-up options, use `zetta refine convert` (server-side). Compressed geometry is refused here; convert those on the server.

```
zetta asset export <source> [flags]
```

Kind: reads only · MCP tool `asset_export`

| Argument / flag | Type | Description |
|---|---|---|
| `<source>` | string | An asset id, or a local .glb file. (**required**) |
| `--format` | `obj` \| `fbx` \| `stl` | Target format. (**required**) |
| `--fbx-preset` | `unity` \| `unreal` \| `blender` \| `maya` \| `threejs` | With --format fbx: axes and units for this app (default unity). |
| `--out` | string | Folder to save into (default: the current folder, or the download.dir setting). |

Examples:

```bash
zetta asset export 1234 --format stl --out ./print
zetta asset export ./chair.glb --format obj
zetta asset export 1234 --format fbx --fbx-preset blender
```

### `zetta asset list`

List your 3D library (newest first).

Filters combine. With --group-runs, each pipeline run is one entry (its newest model) and lists the ids of every model it made.

```
zetta asset list [flags]
```

Kind: reads only · MCP tool `asset_list`

| Argument / flag | Type | Description |
|---|---|---|
| `--page` | number | Page number (starts at 1). |
| `--limit` | number | Items per page (max 100). |
| `--status` | string (repeatable) | Only these statuses (repeat for several). |
| `--kind` | `img23d` \| `txt23d` \| `multiView23d` \| `retopology` \| `segmentation` \| `smartSegmentation` \| `uvUnwrap` \| `retexture` \| `autoRigging` \| `convertFormat` \| `upload` \| `imageToSplat` \| `worldSplatExport` \| `worldMeshExport` | Only this kind: img23d, txt23d, multiView23d, retopology, segmentation, smartSegmentation, uvUnwrap, retexture, autoRigging, convertFormat, upload, imageToSplat, worldSplatExport, worldMeshExport. |
| `--search` | string | Search ids, titles and tags (e.g. 412 or dragon). |
| `--visibility` | `public` \| `private` | Only shared (public) or private items. |
| `--group-runs` | boolean | Show each pipeline run as one entry, with the ids of the models it made. |
| `--sort` | `created` \| `updated` | Order by when items were created (default) or last changed. |
| `--oldest-first` | boolean | Oldest first. |

Examples:

```bash
zetta asset list --limit 10
zetta asset list --status processing --status queued
zetta asset list --kind autoRigging --search dragon --json
zetta asset list --group-runs --sort updated
```

### `zetta asset get`

Show one asset: status, queue position, files.

```
zetta asset get <id> [flags]
```

Kind: reads only · MCP tool `asset_get`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | The asset id (shown by `zetta asset list`). (**required**) |
| `--public` | boolean | Read a shared asset of anyone (no sign-in needed). |

### `zetta asset wait`

Wait until an asset finishes (success, failed or cancelled).

Exits 0 on success, 9 if the job failed or was cancelled, 10 if --timeout passed first (the job keeps running). With the download.auto setting on (the default in a terminal), the results download into the current folder.

```
zetta asset wait <id> [flags]
```

Kind: reads only · MCP tool `asset_wait`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | The asset id (shown by `zetta asset list`). (**required**) |
| `--timeout` | string | Stop waiting after this long, e.g. 90s, 10m. |
| `--out` | string | Download the results into this folder when done. |
| `--download` | boolean | Download the results into the current folder (default: the download.auto setting). --no-download only waits. |
| `--format` | string (repeatable) | When downloading: only these formats (glb, fbx, obj, usdz, …). |

Examples:

```bash
zetta asset wait 1234 --timeout 9m
zetta asset wait 1234 --out ./models --format glb
```

### `zetta asset download`

Download an asset’s result files.

Without --format, every result file is downloaded. --primary keeps only the best model file (GLB, then FBX, glTF, OBJ).

```
zetta asset download <id> [flags]
```

Kind: reads only · MCP tool `asset_download`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | The asset id (shown by `zetta asset list`). (**required**) |
| `--out` | string | Folder to save into (default: the current folder, or the download.dir setting). |
| `--format` | string (repeatable) | Only these formats, e.g. glb, fbx, obj, usdz, ply. |
| `--primary` | boolean | Only the single best model file. |
| `--overwrite` | boolean | Replace existing files instead of adding -2, -3 … |

Examples:

```bash
zetta asset download 1234 --out ./models
zetta asset download 1234 --format fbx
```

### `zetta asset rename`

Give an asset a title.

```
zetta asset rename <id> <title> [flags]
```

Kind: changes something (free) · MCP tool `asset_rename`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | The asset id (shown by `zetta asset list`). (**required**) |
| `<title>` | string | The new title. (**required**) |

### `zetta asset tag`

Set, add or remove an asset’s tags.

```
zetta asset tag <id> [flags]
```

Kind: changes something (free) · MCP tool `asset_tag`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | The asset id (shown by `zetta asset list`). (**required**) |
| `--set` | string (repeatable) | Replace all tags with these. |
| `--add` | string (repeatable) | Add these tags. |
| `--remove` | string (repeatable) | Remove these tags. |

Examples:

```bash
zetta asset tag 1234 --add chair --add wood
zetta asset tag 1234 --set prop,interior
```

### `zetta asset share`

Make an asset public and get its share link.

```
zetta asset share <id> [flags]
```

Kind: changes something (free) · MCP tool `asset_share`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | The asset id (shown by `zetta asset list`). (**required**) |

### `zetta asset unshare`

Make an asset private again (needs a paid plan).

```
zetta asset unshare <id> [flags]
```

Kind: changes something (free) · MCP tool `asset_unshare`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | The asset id (shown by `zetta asset list`). (**required**) |

### `zetta asset cancel`

Cancel a job that has not started yet (full refund).

```
zetta asset cancel <id> [flags]
```

Kind: **destructive** · MCP tool `asset_cancel`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | The asset id (shown by `zetta asset list`). (**required**) |

### `zetta asset delete`

Delete assets and their files.

A job that is still running is not refunded. In a terminal you are asked first; otherwise pass --yes.

```
zetta asset delete <ids...> [flags]
```

Kind: **destructive** · MCP tool `asset_delete`

| Argument / flag | Type | Description |
|---|---|---|
| `<ids>` | number (repeatable) | Asset ids. (**required**) |
| `--yes` | boolean | Delete without asking. |

### `zetta asset import`

Upload your own 3D model into the library (free): GLB, glTF, FBX, OBJ, STL, PLY, DAE, 3DS, 3MF, AMF, USD/USDZ, VRML, LWO, KMZ or a zip.

One file is stored exactly as it is; nothing is converted. Several files, or a folder (an OBJ with its .mtl and textures, a glTF with its .bin and images), are stored together as one zip, as the Studio does. Up to 512 MB. When several models are given, the most complete format is the model (GLB, then glTF, FBX, OBJ …).

```
zetta asset import <files...> [flags]
```

Kind: changes something (free) · MCP tool `asset_import`

| Argument / flag | Type | Description |
|---|---|---|
| `<files>` | string (repeatable) | The model file; or the model and its companion files; or a folder; or a .zip of them. (**required**) |
| `--title` | string | Title in the library (default: the model's file name). |
| `--source` | number | The library asset this model was made from, recorded with it. |
| `--rigged` | boolean | It is a rig you made yourself from --source: filed as a rig rather than an upload. |

Examples:

```bash
zetta asset import ./chair.glb --title "Lounge chair"
zetta asset import ./chair.obj ./chair.mtl ./wood.png
zetta asset import ./chair-folder/
zetta asset import ./model.fbx --json
```

### `zetta asset replace`

Save a model file over an asset’s stored GLB or FBX (the Studio’s Save).

Overwrites the stored file in place: the asset keeps its id, title and share link, and the old file cannot be got back. In a terminal you are asked first; otherwise pass --yes. A segmented asset needs --part (1 = the first part). The format follows your file; --format fbx replaces the asset’s one FBX (a rig, a retopology).

```
zetta asset replace <id> <file> [flags]
```

Kind: **destructive** · MCP tool `asset_replace`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | The asset id (shown by `zetta asset list`). (**required**) |
| `<file>` | string | The new model: a .glb (or .fbx) file, up to 512 MB. (**required**) |
| `--part` | number | For a segmented asset: which part to replace (1 = the first). |
| `--format` | `glb` \| `fbx` | Which stored file to replace: glb (default) or fbx. Must match the file. |
| `--yes` | boolean | Replace without asking. |

Examples:

```bash
zetta asset replace 1234 ./chair-fixed.glb
zetta asset replace 1240 ./part-2.glb --part 2 --yes
zetta asset replace 1250 ./rig.fbx --format fbx --yes
```

### `zetta asset auto-tag`

Suggest a category and tags for an asset with AI (paid plans; uses AI tokens).

Looks at the asset’s thumbnail, or at up to 4 pictures you pass with --frame. Add --apply to save the tags.

```
zetta asset auto-tag <id> [flags]
```

Kind: changes something (free) · MCP tool `asset_auto_tag`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | The asset id (shown by `zetta asset list`). (**required**) |
| `--frame` | string (repeatable) | Pictures of the model (1–4) to look at instead of the thumbnail. |
| `--apply` | boolean | Save the suggested tags on the asset. |

### `zetta asset rig-check`

Guess which skeleton an asset needs before rigging it (paid plans).

Looks at the asset’s thumbnail, or at 1–4 pictures of it from different angles that you pass with --frame (the Studio sends up to 4). Answers biped, quadruped, hexapod, octopod, avian, serpentine, aquatic, others, or unknown.

```
zetta asset rig-check <id> [flags]
```

Kind: reads only · MCP tool `asset_rig_check`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | The asset id (shown by `zetta asset list`). (**required**) |
| `--frame` | string (repeatable) | 1–4 pictures of the model (front, side, back …; PNG, JPEG or WebP under 3 MB each) instead of the thumbnail. |

Examples:

```bash
zetta asset rig-check 1234
zetta asset rig-check 1234 --frame front.png --frame side.png --frame back.png --frame top.png
```

### `zetta asset texture-map`

Make PBR maps (normal, roughness, metalness, emissive, AO) from a model’s base-colour texture with AI (paid plans).

What the Studio’s inspector does: each map is an AI image edit of the material’s base-colour texture, square, at the texture’s own size (1K, 2K or 4K). The maps are saved as pictures (and kept in your image library). --apply also puts them on the model and saves it: over the library asset’s GLB (cannot be undone), or as <name>-maps.glb for a local file. Roughness and metalness share one packed texture in a GLB.

```
zetta asset texture-map <source> [flags]
```

Kind: changes something (free) · MCP tool `asset_texture_map`

| Argument / flag | Type | Description |
|---|---|---|
| `<source>` | string | An asset id, a local .glb file, or a base-colour picture (PNG, JPEG or WebP). (**required**) |
| `--map` | string (repeatable) | Which map(s): normal, roughness, metalness, emissive or ao. Repeat, or separate with commas. (**required**) |
| `--material` | string | Only this material: its number (from 0) or its name. Default: every material with a base-colour texture. |
| `--part` | number | For a segmented asset: which part (1 = the first). |
| `--out` | string | Folder to save the maps into (default: the current folder, or the download.dir setting). |
| `--apply` | boolean | Also put the maps on the model and save it (over the asset’s GLB, or as <name>-maps.glb). |

Examples:

```bash
zetta asset texture-map 1234 --map normal --out ./maps
zetta asset texture-map 1234 --map roughness,metalness --apply
zetta asset texture-map ./chair.glb --map normal --map ao --apply --out ./out
zetta asset texture-map ./albedo.png --map normal
```

### `zetta asset featured`

Featured public assets from the community.

```
zetta asset featured [flags]
```

Kind: reads only · MCP tool `asset_featured`

| Argument / flag | Type | Description |
|---|---|---|
| `--limit` | number | How many. |

## image

Image Studio: generate, edit, compose pictures; remove backgrounds.

### `zetta image generate`

Make a picture from a text prompt (paid plans).

Use --for-3d to get a square picture ready for `zetta generate --image`.

```
zetta image generate [flags]
```

Kind: changes something (free) · MCP tool `image_generate`

| Argument / flag | Type | Description |
|---|---|---|
| `--prompt` | string | What to draw. (**required**) |
| `--aspect-ratio` | `9:16` \| `2:3` \| `3:4` \| `4:5` \| `1:1` \| `5:4` \| `4:3` \| `3:2` \| `16:9` \| `21:9` | Aspect ratio: 9:16, 2:3, 3:4, 4:5, 1:1, 5:4, 4:3, 3:2, 16:9 or 21:9. |
| `--resolution` | `1K` \| `2K` \| `4K` | Resolution: 1K, 2K or 4K (4K needs a paid plan and the pro engine). |
| `--engine` | string | Image engine by name: flash or pro (default: the best your plan allows). See `zetta catalog engines --images`. |
| `--for-3d` | boolean | A clean, square 1K picture made to be turned into 3D (overrides aspect ratio, resolution and engine). |
| `--subject` | `object` \| `environment` | With --for-3d: an object on a plain background (default), or a whole environment. |
| `--fast` | boolean | Prefer the faster engine (an explicit --engine wins). |
| `--out` | string | Folder to save the picture(s) into (default: the current folder, or the download.dir setting). |
| `--download` | boolean | Save the picture(s) (default: on, unless the download.auto setting is false). --no-download keeps them in your image library only. |
| `--style` | string (repeatable) | Up to 3 style reference pictures (files). |

Examples:

```bash
zetta image generate -p "a red vintage armchair, studio light" --for-3d --out ./refs
zetta image generate -p "a misty pine forest" --aspect-ratio 21:9 --resolution 4K --engine pro
```

### `zetta image edit`

Change a picture with an instruction (paid plans).

```
zetta image edit <image> [flags]
```

Kind: changes something (free) · MCP tool `image_edit`

| Argument / flag | Type | Description |
|---|---|---|
| `<image>` | string | The picture: a file, a URL, or image:<id> from your image library. (**required**) |
| `--prompt` | string | What to change. (**required**) |
| `--aspect-ratio` | `9:16` \| `2:3` \| `3:4` \| `4:5` \| `1:1` \| `5:4` \| `4:3` \| `3:2` \| `16:9` \| `21:9` | Aspect ratio: 9:16, 2:3, 3:4, 4:5, 1:1, 5:4, 4:3, 3:2, 16:9 or 21:9. |
| `--resolution` | `1K` \| `2K` \| `4K` | Resolution: 1K, 2K or 4K (4K needs a paid plan and the pro engine). |
| `--engine` | string | Image engine by name: flash or pro (default: the best your plan allows). See `zetta catalog engines --images`. |
| `--for-3d` | boolean | A clean, square 1K picture made to be turned into 3D (overrides aspect ratio, resolution and engine). |
| `--subject` | `object` \| `environment` | With --for-3d: an object on a plain background (default), or a whole environment. |
| `--fast` | boolean | Prefer the faster engine (an explicit --engine wins). |
| `--out` | string | Folder to save the picture(s) into (default: the current folder, or the download.dir setting). |
| `--download` | boolean | Save the picture(s) (default: on, unless the download.auto setting is false). --no-download keeps them in your image library only. |

Examples:

```bash
zetta image edit ./chair.png -p "make it dark green velvet"
zetta image edit image:812 -p "remove the cushion" --for-3d
```

### `zetta image compose`

Combine 2–14 pictures into one, following a prompt (paid plans).

Pictures can be files, URLs or image:<id> entries from your image library, in any mix: at least 2 and at most 14 in all.

```
zetta image compose <images...> [flags]
```

Kind: changes something (free) · MCP tool `image_compose`

| Argument / flag | Type | Description |
|---|---|---|
| `<images>` | string (repeatable) | 2–14 pictures: files, URLs or image:<id>. (**required**) |
| `--prompt` | string | How to combine them. (**required**) |
| `--aspect-ratio` | `9:16` \| `2:3` \| `3:4` \| `4:5` \| `1:1` \| `5:4` \| `4:3` \| `3:2` \| `16:9` \| `21:9` | Aspect ratio: 9:16, 2:3, 3:4, 4:5, 1:1, 5:4, 4:3, 3:2, 16:9 or 21:9. |
| `--resolution` | `1K` \| `2K` \| `4K` | Resolution: 1K, 2K or 4K (4K needs a paid plan and the pro engine). |
| `--engine` | string | Image engine by name: flash or pro (default: the best your plan allows). See `zetta catalog engines --images`. |
| `--for-3d` | boolean | A clean, square 1K picture made to be turned into 3D (overrides aspect ratio, resolution and engine). |
| `--subject` | `object` \| `environment` | With --for-3d: an object on a plain background (default), or a whole environment. |
| `--fast` | boolean | Prefer the faster engine (an explicit --engine wins). |
| `--out` | string | Folder to save the picture(s) into (default: the current folder, or the download.dir setting). |
| `--download` | boolean | Save the picture(s) (default: on, unless the download.auto setting is false). --no-download keeps them in your image library only. |

Examples:

```bash
zetta image compose sofa.png lamp.png rug.png -p "a cosy living room with these items"
zetta image compose image:812 image:813 ./logo.png -p "the logo on both mugs" --aspect-ratio 16:9
```

### `zetta image list`

List your image library (newest first).

```
zetta image list [flags]
```

Kind: reads only · MCP tool `image_list`

| Argument / flag | Type | Description |
|---|---|---|
| `--page` | number | Page number (starts at 1). |
| `--limit` | number | Items per page (max 100). |
| `--kind` | `generate` \| `edit` \| `compose` \| `genImg` \| `editImg` \| `composeImg` | Only this kind: generate, edit or compose (or genImg, editImg, composeImg). |
| `--search` | string | Search prompts. |

Examples:

```bash
zetta image list --kind generate --search lamp
zetta image list --kind compose --limit 50 --json
```

### `zetta image get`

Show one picture set from your image library.

```
zetta image get <id> [flags]
```

Kind: reads only · MCP tool `image_get`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | Image id (from `zetta image list`). (**required**) |

### `zetta image download`

Download the pictures of an image-library entry.

```
zetta image download <id> [flags]
```

Kind: reads only · MCP tool `image_download`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | Image id. (**required**) |
| `--out` | string | Folder to save into (default: the current folder, or the download.dir setting). |

### `zetta image delete`

Delete image-library entries.

In a terminal you are asked first; otherwise pass --yes.

```
zetta image delete <ids...> [flags]
```

Kind: **destructive** · MCP tool `image_delete`

| Argument / flag | Type | Description |
|---|---|---|
| `<ids>` | number (repeatable) | Image ids. (**required**) |
| `--yes` | boolean | Delete without asking. |

### `zetta image remove-bg`

Remove the background from a picture (saves a PNG).

```
zetta image remove-bg <file> [flags]
```

Kind: changes something (free) · MCP tool `image_remove_bg`

| Argument / flag | Type | Description |
|---|---|---|
| `<file>` | string | A PNG, JPEG or WebP picture (max 8 MB). (**required**) |
| `--out` | string | Where to save the PNG (default: <name>-nobg.png next to the input). |

## pipeline

Saved multi-step recipes: create, validate, estimate, run, batch.

### `zetta pipeline list`

List your pipelines.

```
zetta pipeline list [flags]
```

Kind: reads only · MCP tool `pipeline_list`

### `zetta pipeline get`

Show a pipeline as an editable recipe (YAML in a terminal).

Save it with `zetta pipeline get <id> --output text > recipe.yaml`, edit, then `zetta pipeline update <id> --file recipe.yaml`. --raw gives the stored graph.

```
zetta pipeline get <id> [flags]
```

Kind: reads only · MCP tool `pipeline_get`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | Pipeline id (from `zetta pipeline list`). (**required**) |
| `--raw` | boolean | The stored graph instead of the recipe. |

### `zetta pipeline schema`

The recipe format: JSON Schema, every step kind with its settings, and examples.

```
zetta pipeline schema [flags]
```

Kind: local only · not an MCP tool

### `zetta pipeline draft`

Describe a recipe in your own words: an AI drafts it (or changes one) and prints it as a recipe.

Uses AI tokens and needs a paid plan (at most 10 a minute). Nothing is saved unless you add --create (a new pipeline) or --update <id>. With --from <pipeline id | recipe file> the AI changes that recipe as asked — keeping its steps and settings — instead of drafting a new one; --update <id> changes that pipeline (unless --from names another). Save the printed recipe with `--output text > recipe.yaml`.

```
zetta pipeline draft <description> [flags]
```

Kind: changes something (free) · MCP tool `pipeline_draft`

| Argument / flag | Type | Description |
|---|---|---|
| `<description>` | string | What the recipe should do, or what to change, in your own words (3–2,000 characters). (**required**) |
| `--from` | string | Change this recipe instead of drafting a new one: a pipeline id or a recipe file (.yaml/.json). |
| `--create` | boolean | Save the drafted recipe as a new pipeline. |
| `--update` | number | Save the drafted recipe over this pipeline (also the recipe changed, unless --from says otherwise). |
| `--title` | string | The title --create or --update saves (default: the drafted title; --update keeps a pipeline’s own title). |

Examples:

```bash
zetta pipeline draft "a game-ready character from a photo, rigged for Unity" --output text > recipe.yaml
zetta pipeline draft "add AI texturing at the end" --update 12
zetta pipeline draft "use quads everywhere" --from recipe.yaml --output text > recipe-quads.yaml
zetta pipeline draft "products from photos of each side, clean low-poly, retextured" --create
```

### `zetta pipeline validate`

Check a recipe file (or a saved pipeline) without saving or spending anything.

```
zetta pipeline validate <target> [flags]
```

Kind: reads only · MCP tool `pipeline_validate`

| Argument / flag | Type | Description |
|---|---|---|
| `<target>` | string | A recipe file (.yaml/.json) or a pipeline id. (**required**) |

### `zetta pipeline estimate`

Price one run of a pipeline (or a recipe file), step by step.

```
zetta pipeline estimate <target> [flags]
```

Kind: reads only · MCP tool `pipeline_estimate`

| Argument / flag | Type | Description |
|---|---|---|
| `<target>` | string | A pipeline id or a recipe file. (**required**) |
| `--seeds` | number | Multiply by this many runs (seeds, or sets of pictures of each side). |

### `zetta pipeline create`

Save a new pipeline from a recipe file (see `zetta pipeline schema`).

```
zetta pipeline create [flags]
```

Kind: changes something (free) · MCP tool `pipeline_create`

| Argument / flag | Type | Description |
|---|---|---|
| `--file` | string | Recipe file (.yaml or .json): the friendly format, or a raw graph. (**required**) |
| `--title` | string | Title (overrides the file’s). |

Examples:

```bash
zetta pipeline create --file product-to-rig.yaml
```

### `zetta pipeline update`

Replace a pipeline’s steps from a recipe file, or rename it.

```
zetta pipeline update <id> [flags]
```

Kind: changes something (free) · MCP tool `pipeline_update`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | Pipeline id (from `zetta pipeline list`). (**required**) |
| `--file` | string | Recipe file with the new steps. |
| `--title` | string | New title. |

### `zetta pipeline duplicate`

Copy a pipeline.

```
zetta pipeline duplicate <id> [flags]
```

Kind: changes something (free) · MCP tool `pipeline_duplicate`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | Pipeline id (from `zetta pipeline list`). (**required**) |

### `zetta pipeline delete`

Delete a pipeline (its finished models stay in your library).

```
zetta pipeline delete <id> [flags]
```

Kind: **destructive** · MCP tool `pipeline_delete`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | Pipeline id (from `zetta pipeline list`). (**required**) |
| `--yes` | boolean | Delete without asking. |

### `zetta pipeline runs`

Recent runs of a pipeline.

```
zetta pipeline runs <id> [flags]
```

Kind: reads only · MCP tool `pipeline_runs`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | Pipeline id (from `zetta pipeline list`). (**required**) |

### `zetta pipeline run`

Run a pipeline on one seed (a picture, a model, or pictures of each side).

Returns at once with the run id, unless the final models download: with the download.auto setting on (the default in a terminal), or with --wait, --out or --download, it waits for the run and saves them. --no-wait returns at once. A pipeline that starts from pictures of each side (a Multi-view seed) takes --views front=a.png,back=b.png, or a folder holding front.png (and back/left/right .png/.jpg/.webp).

```
zetta pipeline run <id> [seed] [flags]
```

Kind: **spends credits** · MCP tool `pipeline_run`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | Pipeline id (from `zetta pipeline list`). (**required**) |
| `<seed>` | string | A picture file, image:<id>, an asset id or a .glb — or, for pictures of each side, a folder holding front.png (back/left/right). |
| `--views` | string (repeatable) | For a pipeline that starts from pictures of each side: front=a.png,back=b.png,left=c.png,right=d.png (front required and first; image:<id> works too). Each front starts another run. |
| `--mode` | `auto` \| `manual` | auto runs every step; manual waits for you to run each step. (default `auto`) |
| `--draft` | boolean | Create the runs as drafts: give per-run inputs (`zetta run set-input`), then `zetta run start`. |
| `--yes` | boolean | Spend without asking. Needed when not in a terminal, unless --max-credits covers the price. |
| `--max-credits` | number | Refuse if this would cost more than this many credits. |
| `--dry-run` | boolean | Show the price and stop. Nothing is spent. |
| `--idempotency-key` | string | Reuse the same key to retry a command without paying twice. |
| `--wait` | boolean | Wait for the job to finish (default: return at once with its id, unless it downloads automatically). |
| `--timeout` | string | Stop waiting after this long, e.g. 90s, 10m. The job keeps running. |
| `--out` | string | Download the results into this folder when done (implies --wait). |
| `--download` | boolean | Wait, then download the results into the current folder (default: the download.auto setting, which is on in a terminal). --no-download returns at once. |

Examples:

```bash
zetta pipeline run 12 ./shoe.jpg --max-credits 300
zetta pipeline run 14 --views front=chair-f.jpg,back=chair-b.jpg --max-credits 300
zetta pipeline run 14 ./chair --max-credits 300
```

### `zetta pipeline batch`

Run a pipeline once per seed: many pictures, a folder, several assets, or sets of pictures of each side.

More than 20 seeds are sent in several batches. The total price is checked against --max-credits first. Downloads work as for `pipeline run`: every run is waited for, then its final models are saved. For a pipeline that starts from pictures of each side, each run is a set: --views front=a.png,back=b.png (repeat, or start the next set with another front=), a folder holding front.png (one run), or a folder of such folders (one run each).

```
zetta pipeline batch <id> [seeds...] [flags]
```

Kind: **spends credits** · MCP tool `pipeline_batch`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | Pipeline id (from `zetta pipeline list`). (**required**) |
| `<seeds>` | string (repeatable) | Pictures, folders, asset ids or image:<id> — or folders of pictures of each side. |
| `--views` | string (repeatable) | For a pipeline that starts from pictures of each side: front=a.png,back=b.png,left=c.png,right=d.png (front required and first; image:<id> works too). Each front starts another run. |
| `--mode` | `auto` \| `manual` | auto runs every step; manual waits for you to run each step. (default `auto`) |
| `--draft` | boolean | Create the runs as drafts: give per-run inputs (`zetta run set-input`), then `zetta run start`. |
| `--yes` | boolean | Spend without asking. Needed when not in a terminal, unless --max-credits covers the price. |
| `--max-credits` | number | Refuse if this would cost more than this many credits. |
| `--dry-run` | boolean | Show the price and stop. Nothing is spent. |
| `--idempotency-key` | string | Reuse the same key to retry a command without paying twice. |
| `--wait` | boolean | Wait for the job to finish (default: return at once with its id, unless it downloads automatically). |
| `--timeout` | string | Stop waiting after this long, e.g. 90s, 10m. The job keeps running. |
| `--out` | string | Download the results into this folder when done (implies --wait). |
| `--download` | boolean | Wait, then download the results into the current folder (default: the download.auto setting, which is on in a terminal). --no-download returns at once. |

Examples:

```bash
zetta pipeline batch 12 ./photos --max-credits 3000
zetta pipeline batch 12 a.jpg b.jpg c.jpg --draft
zetta pipeline batch 14 ./products --max-credits 3000   # one run per folder: products/chair/front.png, products/lamp/front.png …
zetta pipeline batch 14 --views front=a1.png,back=a2.png --views front=b1.png --yes
```

## run

Pipeline runs: watch, start, pause, retry steps, collect outputs.

### `zetta run get`

Show a pipeline run: every step, its status and its asset.

```
zetta run get <id> [flags]
```

Kind: reads only · MCP tool `run_get`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | Run id (from `zetta pipeline runs <id>` or a batch result). (**required**) |

### `zetta run wait`

Wait until a run finishes, or needs you (review, manual step, draft input).

Exits 0 when done or waiting on you (see `blocked`), 9 if it failed or was cancelled, 10 if --timeout passed first. With the download.auto setting on (the default in a terminal), the final models download into the current folder.

```
zetta run wait <id> [flags]
```

Kind: reads only · MCP tool `run_wait`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | Run id (from `zetta pipeline runs <id>` or a batch result). (**required**) |
| `--timeout` | string | Stop waiting after this long, e.g. 90s, 10m. |
| `--out` | string | When done, download every output into this folder. |
| `--download` | boolean | When done, download the final models into the current folder (default: the download.auto setting). --no-download only waits. |

### `zetta run outputs`

Download every model a run produced.

```
zetta run outputs <id> [flags]
```

Kind: reads only · MCP tool `run_outputs`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | Run id (from `zetta pipeline runs <id>` or a batch result). (**required**) |
| `--out` | string | Folder to save into (default: the current folder, or the download.dir setting). |
| `--format` | string (repeatable) | Only these formats (glb, fbx, …). |
| `--final-only` | boolean | Only the last step of each branch. |

### `zetta run start`

Start a draft run (after its per-run inputs are set).

```
zetta run start <id> [flags]
```

Kind: **spends credits** · MCP tool `run_start`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | Run id (from `zetta pipeline runs <id>` or a batch result). (**required**) |
| `--yes` | boolean | Spend without asking. Needed when not in a terminal, unless --max-credits covers the price. |
| `--max-credits` | number | Refuse if this would cost more than this many credits. |
| `--dry-run` | boolean | Show the price and stop. Nothing is spent. |
| `--idempotency-key` | string | Reuse the same key to retry a command without paying twice. |

### `zetta run pause`

Pause a run after the steps already running.

```
zetta run pause <id> [flags]
```

Kind: changes something (free) · MCP tool `run_pause`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | Run id (from `zetta pipeline runs <id>` or a batch result). (**required**) |

### `zetta run resume`

Resume a paused run.

```
zetta run resume <id> [flags]
```

Kind: **spends credits** · MCP tool `run_resume`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | Run id (from `zetta pipeline runs <id>` or a batch result). (**required**) |
| `--yes` | boolean | Spend without asking. Needed when not in a terminal, unless --max-credits covers the price. |
| `--max-credits` | number | Refuse if this would cost more than this many credits. |
| `--dry-run` | boolean | Show the price and stop. Nothing is spent. |
| `--idempotency-key` | string | Reuse the same key to retry a command without paying twice. |

### `zetta run continue`

Manual mode: run every step that is ready.

```
zetta run continue <id> [flags]
```

Kind: **spends credits** · MCP tool `run_continue`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | Run id (from `zetta pipeline runs <id>` or a batch result). (**required**) |
| `--yes` | boolean | Spend without asking. Needed when not in a terminal, unless --max-credits covers the price. |
| `--max-credits` | number | Refuse if this would cost more than this many credits. |
| `--dry-run` | boolean | Show the price and stop. Nothing is spent. |
| `--idempotency-key` | string | Reuse the same key to retry a command without paying twice. |

### `zetta run cancel`

Cancel a run (steps not started are not charged).

```
zetta run cancel <id> [flags]
```

Kind: **destructive** · MCP tool `run_cancel`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | Run id (from `zetta pipeline runs <id>` or a batch result). (**required**) |

### `zetta run mode`

Switch a run between auto and manual.

```
zetta run mode <id> <mode> [flags]
```

Kind: changes something (free) · MCP tool `run_mode`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | Run id (from `zetta pipeline runs <id>` or a batch result). (**required**) |
| `<mode>` | `auto` \| `manual` | auto or manual. (**required**) |

### `zetta run set-input`

Set a step’s per-run input or settings before it runs (e.g. a draft’s texture prompt).

Use friendly setting names as in recipes: --prompt (AI edit, AI texturing), --reference (AI texturing), --views (Multi-view - AI texturing: front=a.png,back=b.png), or --set key=value for anything else.

```
zetta run set-input <id> <step> [flags]
```

Kind: changes something (free) · MCP tool `run_set_input`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | Run id (from `zetta pipeline runs <id>` or a batch result). (**required**) |
| `<step>` | string | The step id (as in the recipe). (**required**) |
| `--prompt` | string | Instruction or description for this run. |
| `--reference` | string | A reference picture for this run: a file or image:<id>. |
| `--views` | string (repeatable) | Pictures of each side for this run (Multi-view - AI texturing): front=a.png,back=b.png,left=c.png,right=d.png — front required; image:<id> works too. |
| `--set` | string (repeatable) | Other settings as key=value (friendly names). |

Examples:

```bash
zetta run set-input 88 paint --prompt "matte black ceramic"
zetta run set-input 88 paint --views front=f.png,back=b.png,left=l.png
zetta run set-input 88 gen --set quality=ultra
```

### `zetta run step-run`

Manual mode: run one ready step.

```
zetta run step-run <id> <step-id> [flags]
```

Kind: **spends credits** · MCP tool `run_step_run`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | Run id (from `zetta pipeline runs <id>` or a batch result). (**required**) |
| `<step-id>` | number | The step’s numeric id (from `zetta run get`). (**required**) |
| `--yes` | boolean | Spend without asking. Needed when not in a terminal, unless --max-credits covers the price. |
| `--max-credits` | number | Refuse if this would cost more than this many credits. |
| `--dry-run` | boolean | Show the price and stop. Nothing is spent. |
| `--idempotency-key` | string | Reuse the same key to retry a command without paying twice. |

### `zetta run step-retry`

Retry a failed step, optionally with changed settings.

```
zetta run step-retry <id> <step-id> [flags]
```

Kind: **spends credits** · MCP tool `run_step_retry`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | Run id (from `zetta pipeline runs <id>` or a batch result). (**required**) |
| `<step-id>` | number | The failed step’s numeric id. (**required**) |
| `--set` | string (repeatable) | Changed settings as key=value (friendly names). |
| `--yes` | boolean | Spend without asking. Needed when not in a terminal, unless --max-credits covers the price. |
| `--max-credits` | number | Refuse if this would cost more than this many credits. |
| `--dry-run` | boolean | Show the price and stop. Nothing is spent. |
| `--idempotency-key` | string | Reuse the same key to retry a command without paying twice. |

### `zetta run confirm-parts`

Choose which isolated parts to keep (Isolate Parts review).

```
zetta run confirm-parts <id> <step-id> [flags]
```

Kind: changes something (free) · MCP tool `run_confirm_parts`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | Run id (from `zetta pipeline runs <id>` or a batch result). (**required**) |
| `<step-id>` | number | The Isolate Parts step’s numeric id. (**required**) |
| `--keys` | string (repeatable) | Part keys to keep (shown in the step’s review), at most 16. |
| `--extra` | string (repeatable) | Extra parts to ask for, by name (at most 16, 80 characters each). |

### `zetta run delete`

Delete a finished, cancelled or draft run (its models stay in your library).

```
zetta run delete <id> [flags]
```

Kind: **destructive** · MCP tool `run_delete`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | Run id (from `zetta pipeline runs <id>` or a batch result). (**required**) |
| `--yes` | boolean | Delete without asking. |

## config

Settings and profiles.

### `zetta config list`

Show every setting and the active profile.

```
zetta config list [flags]
```

Kind: local only · not an MCP tool

### `zetta config get`

Read one setting.

```
zetta config get <key> [flags]
```

Kind: local only · not an MCP tool

| Argument / flag | Type | Description |
|---|---|---|
| `<key>` | `output` \| `defaults.wait` \| `defaults.engine` \| `download.auto` \| `download.dir` \| `skills.auto` \| `download.formats` \| `spend.maxPerCommand` \| `spend.requireConfirm` \| `currentProfile` | The setting. (**required**) |

### `zetta config set`

Change a setting (e.g. spend.maxPerCommand 200).

```
zetta config set <key> <value> [flags]
```

Kind: local only · not an MCP tool

| Argument / flag | Type | Description |
|---|---|---|
| `<key>` | `output` \| `defaults.wait` \| `defaults.engine` \| `download.auto` \| `download.dir` \| `skills.auto` \| `download.formats` \| `spend.maxPerCommand` \| `spend.requireConfirm` \| `currentProfile` | The setting. (**required**) |
| `<value>` | string | The new value. (**required**) |

Examples:

```bash
zetta config set spend.maxPerCommand 200
zetta config set defaults.wait true
zetta config set output json
```

### `zetta config unset`

Reset a setting to its default.

```
zetta config unset <key> [flags]
```

Kind: local only · not an MCP tool

| Argument / flag | Type | Description |
|---|---|---|
| `<key>` | `output` \| `defaults.wait` \| `defaults.engine` \| `download.auto` \| `download.dir` \| `skills.auto` \| `download.formats` \| `spend.maxPerCommand` \| `spend.requireConfirm` \| `currentProfile` | The setting. (**required**) |

### `zetta config profiles`

List profiles (each has its own API address and sign-in).

```
zetta config profiles [flags]
```

Kind: local only · not an MCP tool

### `zetta config add-profile`

Add or change a profile (e.g. a staging server).

```
zetta config add-profile <name> [flags]
```

Kind: local only · not an MCP tool

| Argument / flag | Type | Description |
|---|---|---|
| `<name>` | string | Profile name. (**required**) |
| `--api` | string | API address, ending in /api. (**required**) |
| `--site` | string | Website address used for browser sign-in. |
| `--use` | boolean | Make it the active profile. |

Examples:

```bash
zetta config add-profile staging --api https://staging-api.example.com/api --site https://staging.example.com
```

### `zetta config remove-profile`

Remove a profile you added, and its saved sign-in.

```
zetta config remove-profile <name> [flags]
```

Kind: local only · not an MCP tool

| Argument / flag | Type | Description |
|---|---|---|
| `<name>` | string | Profile name. (**required**) |

### `zetta config use`

Switch the active profile.

```
zetta config use <name> [flags]
```

Kind: local only · not an MCP tool

| Argument / flag | Type | Description |
|---|---|---|
| `<name>` | string | Profile name. (**required**) |

## skill

Install the agent skill that teaches AI tools to use this CLI.

### `zetta skill install`

Install the Zetta 3D skill, so AI coding agents (Claude Code, Codex, Cursor) know how to use this CLI.

The skill is a folder (SKILL.md plus reference files) in the place each agent reads skills from:
    ~/.claude/skills/zetta3d   Claude Code (Cursor reads it too)
    ~/.agents/skills/zetta3d   Codex and Cursor
By default it goes to the agents found on this machine; --agent picks one, or all. --project installs into this repository (.claude/skills and .agents/skills) instead.
The installers run this with --auto, and every newer zetta refreshes the installed copies by itself. `zetta skill uninstall` stops that.

```
zetta skill install [flags]
```

Kind: local only · not an MCP tool

| Argument / flag | Type | Description |
|---|---|---|
| `--agent` | `claude` \| `codex` \| `cursor` \| `all` | Which agent: claude (Claude Code), codex, cursor, or all (default: the agents found on this machine). |
| `--project` | boolean | Install into this repository instead of your home folder. |
| `--dir` | string | Install into this skills folder instead. |
| `--auto` | boolean | As the installers do: only for agents found here, and not if you turned it off (skills.auto false or ZETTA_NO_SKILL=1). |

Examples:

```bash
zetta skill install
zetta skill install --agent codex
zetta skill install --project
```

### `zetta skill uninstall`

Remove the Zetta 3D skill, and stop installers and upgrades from putting it back.

Without --agent, it is removed from every agent folder in your home folder. Only folders that hold the Zetta 3D skill are touched.

```
zetta skill uninstall [flags]
```

Kind: local only · not an MCP tool

| Argument / flag | Type | Description |
|---|---|---|
| `--agent` | `claude` \| `codex` \| `cursor` \| `all` | Which agent: claude (Claude Code), codex, cursor, or all (default: the agents found on this machine). |
| `--project` | boolean | Remove it from this repository instead. |
| `--dir` | string | Remove it from this skills folder. |

### `zetta skill status`

Where the Zetta 3D skill is installed, and whether it is up to date.

```
zetta skill status [flags]
```

Kind: local only · not an MCP tool

| Argument / flag | Type | Description |
|---|---|---|
| `--project` | boolean | Look in this repository instead of your home folder. |

### `zetta skill show`

Print the skill (SKILL.md, or one of its files), for agents and frameworks that load skills from elsewhere.

```
zetta skill show [flags]
```

Kind: local only · not an MCP tool

| Argument / flag | Type | Description |
|---|---|---|
| `--file` | string | Print this file instead, e.g. references/pipelines.md. |
| `--list` | boolean | List the skill’s files. |

## Other commands

### `zetta generate`

Make a 3D model from a text prompt, a picture, or several views.

Pictures can be local files, URLs, or image:<id> from your image library. A prompt is made into a picture first, then into a model.
Engines: n2.5 (the default; quality levels, parts, quads) and the Smart engines np1 and np1.5 (clean topology to a polygon budget, 8K textures). Every generation needs a paid plan. See `zetta catalog engines` for limits and defaults.
The price is checked first: use --dry-run to see it, --yes or --max-credits to spend without a prompt.
In a terminal it waits, then downloads the results into the current folder (the download.auto setting). Scripts and agents get the asset id at once; add --wait to wait, or --out <folder> to wait and download.

```
zetta generate [flags]
```

Kind: **spends credits** · MCP tool `generate`

| Argument / flag | Type | Description |
|---|---|---|
| `--prompt` | string | Describe the object (text to 3D). A picture is made from it first. Not with --image or --view. |
| `--image` | string | One picture of the object: a file, URL, or image:<id>. |
| `--view` | string (repeatable) | Multi-view pictures as slot=source: front (required) plus at least one of back, left, right. |
| `--engine` | `n2.5` \| `n25` \| `np1` \| `np1.5` \| `np15` | Engine: n2.5 (default, or `defaults.engine` from config), np1 or np1.5. |
| `--quality` | `lowpoly` \| `high` \| `ultra` | N2.5 only: low-poly (1,000–20,000 polygons), high (default, up to 1,000,000) or ultra (up to 2,000,000, a paid extra). |
| `--texture` | boolean | Textured model (default). --no-texture gives geometry only. (default `true`) |
| `--pbr` | boolean | PBR materials (on by default for textured models; --no-pbr to skip). |
| `--texture-quality` | `standard` \| `detailed` \| `extreme` \| `8k` | Texture detail: standard (default), detailed (HD), or extreme (8K, np1 and np1.5 only; 8k is the same). |
| `--faces` | number | Polygon budget. Defaults to the most the engine and quality allow; another count is a paid extra. See `zetta catalog engines`. |
| `--quads` | boolean | Quad topology instead of triangles (N2.5 and np1.5). |
| `--parts` | boolean | Split into separate editable parts (N2.5, geometry only, not low-poly). |
| `--texture-alignment` | `image` \| `geometry` | Fit the texture to the picture, or to the mesh (default). |
| `--auto-size` | boolean | Scale to real-world size. |
| `--delight` | boolean | Remove baked-in lighting from the picture before texturing. |
| `--autofix` | boolean | Clean up the picture before building (slower). |
| `--compress` | boolean | Compress geometry for a smaller file. |
| `--uv` | boolean | Unwrap UVs (default). --no-uv is faster and smaller. (default `true`) |
| `--fast-texture` | boolean | Faster standard-quality texturing. |
| `--seed` | number | Model seed, for reproducible results. |
| `--texture-seed` | number | Texture seed. |
| `--remove-bg` | boolean | Remove the background from the picture(s) first. |
| `--draw-missing` | boolean | With --view: draw the missing side views with AI from the front view. |
| `--title` | string | Title in your library. |
| `--tag` | string (repeatable) | Tags. |
| `--visibility` | `public` \| `private` | Share publicly, or keep private. Your plan’s default when left out. |
| `--format` | string (repeatable) | When downloading: only these formats (glb, fbx, obj, usdz …). |
| `--yes` | boolean | Spend without asking. Needed when not in a terminal, unless --max-credits covers the price. |
| `--max-credits` | number | Refuse if this would cost more than this many credits. |
| `--dry-run` | boolean | Show the price and stop. Nothing is spent. |
| `--idempotency-key` | string | Reuse the same key to retry a command without paying twice. |
| `--wait` | boolean | Wait for the job to finish (default: return at once with its id, unless it downloads automatically). |
| `--timeout` | string | Stop waiting after this long, e.g. 90s, 10m. The job keeps running. |
| `--out` | string | Download the results into this folder when done (implies --wait). |
| `--download` | boolean | Wait, then download the results into the current folder (default: the download.auto setting, which is on in a terminal). --no-download returns at once. |

Examples:

```bash
zetta generate --image chair.png --engine n2.5 --out ./models
zetta generate -p "a low-poly treasure chest" --quality lowpoly --dry-run
zetta generate --view front=f.png --view back=b.png --view left=l.png --view right=r.png --yes --wait
zetta generate -i photo.jpg --remove-bg --engine np1.5 --quads --faces 8000 --texture-quality extreme --max-credits 200 --out .
```

### `zetta quote`

Price a raw operation spec (most people use --dry-run on the command instead).

Example: zetta quote --base textured --modifier pbr --engine n25. Codes are listed by `zetta catalog pricing`. With no engine, n25 is priced.

```
zetta quote [flags]
```

Kind: reads only · MCP tool `quote`

| Argument / flag | Type | Description |
|---|---|---|
| `--base` | string | Generation base code: geometry_only, textured, lowpoly, gaussian_splat. |
| `--modifier` | string (repeatable) | Modifier codes, e.g. multi_view, pbr, detailed_texture. |
| `--post-process` | string (repeatable) | Finishing-tool codes, e.g. auto_rigging. |
| `--engine` | string | Engine id (n25, np1, np15, r1, zs2, zs21). |

### `zetta commands`

List every command with its flags (use --json for a machine-readable map).

```
zetta commands [flags]
```

Kind: local only · not an MCP tool

| Argument / flag | Type | Description |
|---|---|---|
| `--group` | string | Only this group, e.g. asset. |

### `zetta schema`

JSON Schema of a command’s input (what --input accepts and MCP tools take).

```
zetta schema <command...> [flags]
```

Kind: local only · not an MCP tool

| Argument / flag | Type | Description |
|---|---|---|
| `<command>` | string (repeatable) | The command, e.g. generate, or asset list. (**required**) |

Examples:

```bash
zetta schema generate
zetta schema refine rig
```

### `zetta guide`

How to use this CLI well — written for AI agents (and handy for people).

With a topic, prints that part of the documentation: generating, refining, pipelines, library, images, account, configuration, errors, commands. The agent skill carries the same files (zetta skill install).

```
zetta guide [topic] [flags]
```

Kind: local only · not an MCP tool

| Argument / flag | Type | Description |
|---|---|---|
| `<topic>` | `generating` \| `refining` \| `pipelines` \| `library` \| `images` \| `account` \| `configuration` \| `errors` \| `commands` | One area in depth. |

Examples:

```bash
zetta guide
zetta guide pipelines
zetta guide errors
```

### `zetta exit-codes`

What each exit code means.

```
zetta exit-codes [flags]
```

Kind: local only · not an MCP tool

### `zetta doctor`

Check the setup: version, config, connection, sign-in, clock.

```
zetta doctor [flags]
```

Kind: reads only · MCP tool `doctor`

### `zetta completion`

Print a shell completion script (bash, zsh or fish).

Add to your shell, e.g.: zetta completion zsh > ~/.zsh/completions/_zetta

```
zetta completion <shell> [flags]
```

Kind: local only · not an MCP tool

| Argument / flag | Type | Description |
|---|---|---|
| `<shell>` | `bash` \| `zsh` \| `fish` | Your shell. (**required**) |

### `zetta mcp`

Run Zetta 3D as an MCP server over stdio, for AI assistants.

Every command becomes a tool with the same inputs, checks and spend guard.
Paid tools need yes/maxCredits per call, or a --budget for the whole session.

Add it to an MCP client, e.g.:
    claude mcp add zetta3d -- zetta mcp --budget 500
    { "mcpServers": { "zetta3d": { "command": "zetta", "args": ["mcp", "--budget", "500"] } } }

```
zetta mcp [flags]
```

Kind: local only · not an MCP tool

| Argument / flag | Type | Description |
|---|---|---|
| `--budget` | number | Credits the session may spend in total without per-call confirmation. |
| `--read-only` | boolean | Offer only tools that look and never change anything. |

Examples:

```bash
zetta mcp --budget 500
zetta mcp --read-only
```

### `zetta setup`

Connect an AI tool to Zetta 3D: Claude Code, Claude Desktop, Cursor, Codex, or an AGENTS.md.

claude-code     installs the skill (~/.claude/skills) and registers the MCP server (`claude mcp add`).
claude-desktop  adds the MCP server to claude_desktop_config.json.
cursor          installs the skill (~/.agents/skills) and adds the MCP server to ~/.cursor/mcp.json.
codex           installs the skill (~/.agents/skills) and adds the MCP server to ~/.codex/config.toml.
agents-md       adds the guide to ./AGENTS.md (read by many coding agents).
Existing files are backed up to .bak, and re-running replaces our entry instead of duplicating it.
Without --budget, paid MCP tools need yes or maxCredits on every call.

```
zetta setup <client> [flags]
```

Kind: local only · not an MCP tool

| Argument / flag | Type | Description |
|---|---|---|
| `<client>` | `claude-code` \| `claude-desktop` \| `cursor` \| `codex` \| `agents-md` | The AI tool to connect. (**required**) |
| `--budget` | number | Credits each MCP session may spend without per-call confirmation. |
| `--read-only` | boolean | Offer only read-only tools over MCP. |
| `--print` | boolean | Show what would change, and change nothing. |

Examples:

```bash
zetta setup claude-code --budget 500
zetta setup claude-desktop --read-only
zetta setup agents-md --print
```

### `zetta upgrade`

Update zetta to the latest release (or a given version).

Downloads the binary for this machine, checks its SHA-256 and replaces this one; the agent skill updates itself on the next run. Use --check to only look. A copy installed with Homebrew or npm is upgraded with that tool instead (the check says which command).

```
zetta upgrade [flags]
```

Kind: local only · not an MCP tool

| Argument / flag | Type | Description |
|---|---|---|
| `--check` | boolean | Only report whether a newer version exists. |
| `--to` | string | Install exactly this version, e.g. 0.2.0. |
| `--force` | boolean | Reinstall even if already on that version. |

