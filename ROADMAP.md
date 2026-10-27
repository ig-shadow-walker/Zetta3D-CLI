# Zetta 3D CLI — Roadmap

Status: 2026-10-21. Phases 0–5 are built and tested against a simulated API; Phase 6 is prepared but not published. See "Build status".

## Goal

`zetta` is one CLI that lets you do everything a signed-in Zetta 3D user can do in the web app. It is built first for LLM agents (Claude Code, Codex, Cursor, CI scripts) and second for people in a terminal. It uses the same account, credits and library as the web app.

v1 is done when:
- installing it is one command on macOS, Linux or Windows, with nothing else needed (no Node, no Python, no package manager), and it works straight away with no configuration (see "Installation");
- the CLI talks only to the Zetta 3D backend, and neither its code nor its output reveals our model vendors (see "Vendor isolation");
- every row of the coverage matrix below has a command, tests and a docs entry;
- an agent that knows nothing in advance can find the commands, choose options, run a paid job within a spending limit, wait for it and end up with files on disk, using only what `zetta` prints;
- login works on a laptop (browser), over SSH or in a container (no browser), and in CI (a secret, no prompts).

## Build status (2026-10-21)

All six phases are built. Only the parts that need the owner are left: a real account, hosting, secrets, certificates and publishing. Everything is tested against simulated APIs and real local runs. Against production, only the public routes have been exercised.

**Built and tested:**

- **SDK** (`packages/sdk`, no runtime dependencies):
  - typed client for every endpoint in the coverage matrix, and one error type;
  - ticketed uploads (single and multipart, ticket refresh) and job/run polling;
  - the ported 3D request rules (`builders/`) and the pipeline graph model with a YAML recipe format (`pipeline/`);
  - the local GLB parser and the OBJ and STL writers.
- **CLI** (`packages/cli`): 96 commands, following every design principle below:
  - JSON when piped, one error envelope, exit codes;
  - the spend guard and idempotency keys;
  - `--input` JSON, `zetta commands` and `zetta schema`.
- **Local export:** GLB → OBJ, STL and FBX (verified by reading four sample models back with three.js).
- **Sign-in:** browser hand-off (`client=cli`), emailed link, token on stdin, and `ZETTA_TOKEN`. The keychain is used where one exists and probed by `doctor`; otherwise a `0600` file.
- **Agents:**
  - `zetta mcp`, tested through the official MCP client over stdio: budget, read-only, dry runs and errors;
  - `zetta skill install|uninstall|show` and `zetta setup claude-code|claude-desktop|cursor|codex|agents-md`;
  - `zetta guide`, `skill/SKILL.md`, and `docs/COMMANDS.md` generated from the definitions;
  - the agent-eval harness (`bun run evals`, `evals/tasks.yaml`).
- **Distribution:**
  - single binaries for 7 platforms (plus `-baseline` for CPUs without AVX2), compiled to bytecode: about 16 ms to start, down from 37 ms;
  - gzip copies that the installers and `zetta upgrade` prefer (27–41 MB, down from 66–89 MB), each checksum-checked twice;
  - `install.sh` and `install.ps1` (27 end-to-end checks), `zetta upgrade`, and a daily update notice;
  - npm packages and the Homebrew formula (`bun run package:channels`; npm verified with a local install);
  - a local build command for any target (`bun run build <target>`) and a local release build (`bun run build --release`). The GitHub workflows were removed on 2026-10-21 at the owner's request; signing and publishing are documented steps in `docs/releasing.md`;
  - the vendor-name scan of sources, the bundled code and the binaries.
- **Verified for real:**
  - all four Linux builds run in Debian and Alpine containers (x64 and arm64), including FBX export and reaching the API;
  - the live smoke test passes its public checks against production;
  - the API refuses a fake token correctly, which confirms the sign-in header reaches it.
- **Docs:** README plus 14 guides in `docs/`: installation, getting started, authentication, generating, refining, library, images, pipelines, AI agents, configuration, troubleshooting, development, releasing, and the generated command reference.
- **Tests:** 1,052 in the repo, plus the installer end-to-end script.
- **B1** is done in `Zetta3D-Frontend`: the sign-in page names the CLI and says "ran `zetta auth login`", with the Blender and Unity wording unchanged and pinned by tests. It is uncommitted, waiting for review.

**Not done — needs the owner:**
- **A run with a real account:** `ZETTA_TOKEN=… bun run smoke:live`, then `--paid --budget 200`, then `bun run evals`.
- **Hosting:** `downloads.zetta3d.ai/zcli`, plus serving `zetta3d.ai/install.sh` and `install.ps1` (see `install/README.md`).
- **Release setup:** the vendor word list on the release machine, the download-host keys, code-signing certificates, the `@zetta3d` npm organisation and the Homebrew tap repository (see `docs/releasing.md`).
- **Ship B1:** commit and deploy the frontend change.
- **Backend items** below: B3–B5 before a public launch, and B15–B26 from the audit.

**Deliberately left out of v1:**
- `agent chat`: the calling AI is the agent, and those routes still return model ids and token counts (B15).
- `admin` commands: internal build only.
- The browser-only geometry and material editors.
- Headless rendering of model views: `auto-tag` and `rig-check` use the thumbnail, or pictures passed with `--frame`.

## What exists today (survey, 2026-10-20)

These facts come from `Zetta3D-Backend`, `Zetta3D-Frontend` and `zetta-UnityPlugin`, and they shape the plan.

- **API.** NestJS on Fastify at `https://api.zetta3d.ai/api` (dev: `http://localhost:4000/api`). No versioning and no OpenAPI. DTO validation is strict: an unknown field gets a 400.
- **Auth.** There is one kind of credential, a 30-day HS256 JWT. It is accepted as the `zetta_session` cookie or as `Authorization: Bearer`. There are no API keys, no refresh tokens, no device flow and no revocation (logout only clears the cookie).
- **Non-browser login already exists.** The Blender/Unity loopback flow works like this:
  1. The client listens on `127.0.0.1:<port>`.
  2. It opens `zetta3d.ai/plugin-auth?port&state&client=`.
  3. The user clicks Connect.
  4. The page posts a `kind:'plugin'` JWT back to the client.

  `client=cli` works today, but the page shows Blender wording.
- **Headless login is possible but awkward.** The CLI calls `POST /auth/magic-link`. The user copies the emailed link without clicking it, because the link works only once. The CLI then calls `POST /auth/verify`, and the JWT arrives in `Set-Cookie`.
- **Jobs.** `POST /3d/generations`, with an `Idempotency-Key` header, handles every generation and every finishing tool. Clients poll `GET /3d/generations/:id`; nothing is pushed.
  - Statuses: `pending → queued → processing → saving → success | failed | cancelled`.
  - Failed jobs are refunded automatically. They carry only a human-readable `errorMessage`.
- **Files.** Uploads go through a ticketed relay: one PUT up to 8 MiB, multipart above that, and the edge cuts requests off at 100 s. Downloads are short-lived `/api/files?key&ticket` URLs.
- **Logic that exists only in the browser:**
  - request building and cross-field rules (`gen3d-request.ts`);
  - background removal before upload;
  - the prompts that draw missing views and world views;
  - mapping a pipeline node to a request (`node-config.ts`);
  - image checks and downscaling;
  - removing vendor names from downloaded files;
  - exporting GLB to OBJ, STL or FBX.
- **Errors and limits.** Error bodies come in three shapes, and many 400s have no `code`. Throttling is per IP; creating a generation is limited to 10 per minute.
- **Prior art.** The Unity plugin (v0.3.0) already calls most of these endpoints, has its own copy of the request builders, and handles uploads, polling and downloads in C#.
- **Policy rules** from the backend and frontend `CLAUDE.md` files:
  - Never show vendor names anywhere a user or an agent can see them: CLI output, tool schemas, and the contents of downloaded files.
  - The in-app 3D Agent never spends credits without a person clicking.
- **Testing hazard.** The backend's local `.env` points at the production database, and there is no staging environment.

## Design principles (all phases, starting in Phase 1)

1. **Machine-readable output when a machine is reading.**
   - `--output text|json|ndjson`. The flag wins, then `ZETTA_OUTPUT`, then the terminal check: text in a terminal, JSON when piped. Agents therefore get JSON without having to know about the flag.
   - Data goes to stdout. Progress, warnings and errors go to stderr.
2. **One error envelope.**
   - The backend's three shapes become `{"error":{"code","message","status","details","hint"}}`.
   - Every error has a `code`. Local failures get CLI codes such as `NOT_LOGGED_IN` or `FILE_TOO_LARGE`.
   - `hint` names the command to run next.
3. **Exit codes that mean something** (table below).
4. **No prompts without a terminal.** Missing input is a usage error with a hint. The CLI never hangs waiting for an answer.
5. **Spending is explicit.**
   - Every paid command gets a quote first.
   - `--dry-run` prints the quote and exits.
   - In a terminal, the CLI asks before spending.
   - Without a terminal, it needs `--yes`, `--max-credits N` or a configured budget. Otherwise it refuses with `SPEND_LIMIT`. (Open decision 1.)
6. **Long jobs don't block the shell.** Agent shells time out; Claude Code's default is 2 minutes.
   - Paid commands return the job straight away.
   - `--wait [--timeout]` blocks until the job finishes.
   - If the wait times out, the CLI exits with code 10 and the job keeps running. `zetta asset wait <id>` picks it up again.
   - `--out <dir>` implies waiting, then downloading.
7. **Safe retries.** Paid POSTs send an `Idempotency-Key`. It is generated automatically, and `--idempotency-key` overrides it, so an agent can retry a command that timed out without paying twice.
8. **Local files in, files out.**
   - Any input that takes a URL also takes a local file. The CLI checks the file, removes the background if asked, uploads it and passes the signed URL.
   - Downloaded files have vendor names removed.
9. **Self-describing.**
   - `zetta commands --json` lists every command.
   - `zetta schema <command>` prints the JSON Schema of its inputs and outputs.
   - Both are generated from the definitions the parser uses, and so is the MCP server in Phase 5.
10. **Attribution.** Requests carry `User-Agent: zetta-cli/<version>` and `X-Zetta-Client: cli`, and 3D creates carry `origin: "cli"`.
11. **No vendor names** in any output, help text, schema or file, and none in the CLI's own code (see "Vendor isolation").

## Installation

Requirement: one command, nothing else installed first, works straight away.

```bash
curl -fsSL https://zetta3d.ai/install.sh | sh          # macOS, Linux
```

```powershell
irm https://zetta3d.ai/install.ps1 | iex                # Windows
```

- **One self-contained binary.** The TypeScript CLI is compiled with `bun build --compile` into a single executable that has its runtime built in, so the user's machine needs nothing. Targets: macOS arm64 and x64, Linux x64 and arm64 (glibc and musl, so Alpine containers work), Windows x64, plus `-baseline` builds for x64 CPUs without AVX2. As built, the binaries are 60–83 MB (about half that compressed), larger than first estimated. A Go binary would be about 10 MB; we give that up in exchange for sharing code with the frontend. The musl builds need `libstdc++`: the installer adds it with `apk` when run as root, and otherwise prints the command (owner to confirm this behaviour).
- **No native add-ons and no runtime dependencies**, so the single binary never breaks on a missing library. Credential storage uses the OS keychain through the runtime's built-in support, and falls back to a `0600` file.
- **What the install script does:** detects the OS and CPU, downloads the matching binary from our own download host, checks its SHA-256, installs to `~/.zetta/bin` without sudo, and adds it to `PATH`. Running it again upgrades. An agent can run the same command to install the CLI itself.
- **Works straight away:** production is the default API, and no config file is needed. The first command that needs an account says to run `zetta auth login`, or uses `ZETTA_TOKEN` if it is set. `zetta` on its own prints a short getting-started guide.
- **Updates:** `zetta upgrade` replaces the binary in place.
- **Other channels** (Phase 6): Homebrew (`brew install zetta3d/tap/zetta`) and npm (`npx @zetta3d/cli`, shipping the same binaries per platform). Neither is required.
- **Signing:** macOS binaries are signed and notarised and Windows binaries are signed, so Gatekeeper and SmartScreen don't block them (Phase 6; unsigned builds are fine for the private beta). macOS binaries cross-built on Linux carry an invalid signature, so releases are built on a macOS runner, which re-signs them ad hoc until real certificates exist.

## Vendor isolation

The CLI talks only to our backend (`api.zetta3d.ai`). It has no vendor API keys, never calls a vendor and never needs to know who the vendors are. The backend already works this way: it sends jobs to vendors itself, takes uploads through our relay, and serves downloads through `/api/files`.

Anything compiled into the CLI should be treated as public, because a binary can be unpacked. So the CLI repo holds no secrets, no vendor names, no admin-only commands, and no URLs other than ours.

On 2026-10-20 a check of the backend's responses found four places where vendor details reached every client, the web app included. All four were fixed and committed on 2026-10-21 (backend `7a82fb4`, `f9b3133`; frontend `370c073`). Confirm they are deployed before relying on them in production.

| What leaked | Where | Fix | Status |
|---|---|---|---|
| What the vendor charges us (`vendorCredits`, total and per line) | `POST /3d/quote`, `GET /3d/operations` | B12 | Fixed: customer fields only |
| The vendor's own asset id and status | `result.vendor` on every generation | B13 | Fixed: kept on the server |
| A vendor name as a request value (the old `rigSpec` default) | `POST /3d/generations` for rigging | B14 | Fixed: `standard` / `mixamo` |
| Vendor names inside downloaded model files (material and node names) | the stored result files | B9 | Fixed: renamed on the server when stored; backfill script for older files |

The web app no longer ships a list of vendor names (`vendor-names.ts` and `fbx-rename.ts` are gone), and the CLI will never need one.

**CI guard.** Every build scans the compiled binary, the test fixtures and the recorded API responses for vendor names, and fails if it finds one. The list of names to look for lives in CI configuration, not in the repo, so it never ships.

### Audit of the fixes (2026-10-21)

A read-only audit of both repos found the four fixes in place. B9 is only partly done, and the audit found more places where upstream detail still reaches clients. Until the backend fixes them, the CLI works around what it can:

| Still reaching clients | Where | CLI today | Backend item |
|---|---|---|---|
| The image engines' real ids; a provider named in a 429 message; the provider's refusal text in `errorMessage` | `/2d/models`, every `/2d/*` response, image errors | Engines chosen and shown by label (`flash` / `pro`); ids never printed; its own message for every `IMAGE_GEN_*` code | B16 |
| Upstream error codes as refund reasons | `GET /billing/usage` (`reason`) | `reason` is not printed | B17 |
| Language-model ids and raw token counts | `/3dAgent/options`, agent SSE `done.tokens`, agent sessions; Unity agent `done.tokens` | Agent routes not exposed | B15 |
| LLM model names and a margin-adjacent field | public `/pricing` (`allowedModels`, `maxDrainMultiplierX100`) | Plans printed from an allow-list | B22 |
| Internal concurrency categories | `JOB_LIMIT_REACHED` (`category`) | Dropped from error details | — |
| The legacy rig value | saved pipeline graphs; now refused with a 400 on run | Treated as `standard` on load, with a warning | B18 |
| Vendor names inside USDZ, PLY/SPZ and image files; GLBs with over 64 MB of JSON; other files over 256 MB; browser saves (`result-upload`) | stored files | Nothing the CLI can do without a vendor list | B19 |
| Older stored files, if the backfill was never applied | stored files | — | B20 |
| Raw `imgUrls` (old rows may hold upstream hosts) | generation responses | Not printed | B21 |

The CLI never repeats these fields (tested in `packages/cli/test/isolation.test.ts`). Job error messages are rewritten into our own wording before they are saved (`failAndRefund(post, userMessage, …)`), but upstream refusal text in image errors is not, hence the CLI's own messages.

### Exit codes

| Code | Meaning | Backend codes / examples |
|---|---|---|
| 0 | Success | |
| 1 | Unexpected error | |
| 2 | Bad usage or failed local check | bad flag, `FILE_TOO_LARGE`, 400 validation errors |
| 3 | Not signed in | `NO_SESSION`, `INVALID_SESSION`, expired token |
| 4 | Plan or access | `PLAN_CAPABILITY_REQUIRED`, `EARLY_ACCESS_REQUIRED`, `IMAGE_*_REQUIRES_PLAN` |
| 5 | Not enough credits, or over the spend limit | `INSUFFICIENT_CREDITS`, `SPEND_LIMIT` |
| 6 | Not found | 404 |
| 7 | Conflict or concurrency limit | `JOB_LIMIT_REACHED`, `GEN3D_NOT_READY`, `GEN3D_ALREADY_*` |
| 8 | Rate limited, after retries | 429 |
| 9 | Remote job failed or was cancelled | status `failed` / `cancelled` |
| 10 | Wait timed out; the job is still running | |
| 11 | Network or server error | 5xx, `FEATURE_UNAVAILABLE` |

## Command tree (as built)

An *asset* is a 3D library item (the backend calls it a "generation"). An *engine* is Zetta N1, N2.5, Np1, Np1.5, R1 or Splat. Full reference: `docs/COMMANDS.md`.

```
zetta auth      login [--email <addr> [--link <url>] | --with-token | --print-url] | logout | status | token
zetta account   show | credits | usage | onboarding | early-access <feature> | delete
zetta billing   plans | subscription | checkout <plan> [--yearly] | checkout --pack <credits> | portal
zetta catalog   engines [--images] | pricing | entitlements
zetta quote     --base … --modifier … | --post-process …     # or --dry-run on any paid command

zetta generate  --prompt <text> | --image <file|url|image:id> | --view slot=<picture> …
                --engine n1|n2.5|np1|np1.5 --quality --no-texture --pbr --faces --quads --parts …
zetta splat     create --image … | --video … | --prompt … [--world-view <azimuth>=<picture>] | export <id> --as splat|mesh|collider
zetta refine    retopo | segment | uv | texture | rig | convert   <asset-id|file.glb|url> [tool options]

zetta asset     list | get | wait | download | rename | tag | share | unshare | cancel | delete
                import <file.glb> | export <asset|file.glb> --format obj|fbx|stl | auto-tag | rig-check | featured
zetta image     generate | edit | compose | list | get | download | delete | remove-bg

zetta pipeline  list | get | schema | validate | estimate | create | update | duplicate | delete | runs | run | batch
zetta run       get | wait | outputs | start | pause | resume | continue | cancel | mode | set-input
                step-run | step-retry | confirm-parts | delete

zetta config    list | get | set | unset | profiles | add-profile | remove-profile | use
zetta skill     install | uninstall | show
zetta setup     claude-code | claude-desktop | cursor | codex | agents-md
zetta commands | schema <cmd> | guide | exit-codes | doctor | completion <shell> | mcp | upgrade
```

Every paid command (`generate`, `splat *`, `refine *`, `pipeline run|batch`, and `run start|resume|continue|step-run|step-retry`) takes the following flags. Job commands also take `--wait`, `--timeout` and `--out`:
- `--dry-run`
- `--max-credits`
- `--yes`
- `--idempotency-key`

## Feature coverage matrix

Each web-app feature, the backend call behind it, the command that exposes it and the phase it lands in. This table is the checklist for "every feature is exposed".

| Web feature | Backend | CLI | Phase |
|---|---|---|---|
| Sign in (magic link, Google) | `/auth/magic-link`, `/auth/verify`, `/auth/plugin-token` | `auth login` | 1 |
| Check session, sign out | `/auth/me`, `/auth/logout` | `auth status`, `auth logout` | 1 |
| Account and credits (3D and AI pools) | `/auth/me` | `account show`, `account credits` | 1 |
| Usage ledger | `/billing/usage` | `account usage` | 1 |
| Plans and credit packs | `/pricing` | `billing plans` | 1 |
| Subscription status | `/billing/subscription` | `billing subscription` | 1 |
| Checkout, manage subscription | `/billing/checkout`, `/billing/portal` | `billing checkout`, `billing portal` (opens or prints the Stripe URL; the CLI never sees card details) | 1 |
| Engines, prices, plan limits | `/3d/pricing`, `/3d/entitlements`, `/2d/models`, `/2d/entitlements` | `catalog *` | 1 |
| Cost preview | `/3d/quote`, `/pipelines/estimate` | `quote`, `--dry-run` | 1–2 |
| Browse, search, filter the 3D library | `GET /3d/generations` | `asset list` | 1 |
| Asset details, queue position | `GET /3d/generations/:id` | `asset get`, `asset wait` | 1 |
| Download results | `/3d/generations/:id/download` | `asset download` | 1 |
| Image → 3D | upload + create | `generate --image` | 2 |
| Text → 3D | N1 directly; other engines via `/2d/generate` with `for3D` | `generate --prompt` | 2 |
| Multi-view → 3D | N uploads + create | `generate --views` | 2 |
| Smart 3D (Np1, Np1.5) | create | `generate --engine np1` | 2 |
| Remove background | `/tools/rembg` | `--remove-bg`, `image remove-bg` | 2 |
| Rename, tag, share / unshare, cancel, delete | PATCH, cancel, DELETE | `asset *` | 2 |
| Upload your own GLB | `/3d/uploads` + `/3d/uploads/post` | `asset import` | 2 |
| Retopology (N1, R1) | create `smart_topology` | `refine retopo` | 3 |
| Segmentation, Smart segmentation | `ai_segmentation`, `smart_segmentation` | `refine segment [--smart]` | 3 |
| Smart UV | `smart_uv` | `refine uv` | 3 |
| AI texturing (standard, HD, 8K) | `retexture*` | `refine texture` | 3 |
| Auto rig, body-type precheck | `auto_rigging`, `/ai/rigging-precheck` | `refine rig`, `asset rig-check` | 3 |
| Format conversion | `convert_format*`, browser export | `refine convert` (server, paid), `asset export` (local, free) | 3 |
| AI tags | `/ai/tags` | `asset auto-tag` | 3 |
| Image Studio: generate, edit, compose | `/2d/*` | `image generate`, `image edit`, `image compose` | 3 |
| Image library | `GET /2d`, `DELETE /2d/:id` | `image list`, `get`, `download`, `delete` | 3 |
| AI-drawn missing views | `/2d/img-edit` + frontend prompts | `generate --views ... --draw-missing` | 3 |
| Zetta Splat (early access) | create `gaussian_splat`, `zs2`, `zs21` | `splat create` | 3 |
| World exports (PLY, mesh, collider) | `world_*_export` | `splat export` | 3 |
| Create and edit pipelines | `/pipelines*` | `pipeline *` (graph as a JSON or YAML file) | 4 |
| Pipeline runs, batches, drafts, manual mode | `/pipelines/:id/runs`, `/pipelines/:id/batch`, `/pipeline-runs/*` | `pipeline run`, `pipeline batch`, `run *` | 4 |
| Isolate Parts review | `steps/:id/parts` | `run parts confirm` | 4 |
| Onboarding bonus | `/auth/onboarding/complete` | `account onboarding` | 4 |
| Early-access request | `/early-access/requests` | `account early-access <feature>` | 4 |
| Delete account | `DELETE /auth/account` | `account delete` (terminal only, typed confirmation, never offered over MCP) | 4 |
| Public share page, featured | `/3d/public/*` | `asset get --public <id>` | 4 |
| 3D Agent chat | `/3dAgent/*` (SSE) | `agent chat` (optional; the calling LLM is usually the agent) | 6 |
| Admin console | `/admin/*` | `admin *` (internal build only) | 6 |
| Geometry and material editor | browser only (three.js) | not planned for v1 | — |

## Phases

The estimates assume one engineer working with coding agents. They set the order of work, not deadlines; the total is about 12–14 weeks.

### Phase 0 — Decisions and scaffold (about 1 week)

- Settle the open decisions at the end of this file.
- **Repo:** a workspace with two packages.
  - `packages/sdk`: typed HTTP client, error normalisation, upload engine, request builders. It has no CLI code, so the frontend or the MCP server can reuse it later.
  - `packages/cli`: commands, output, config, credential storage.
- **Recommended stack:** TypeScript, `commander` for parsing, `zod` for input and output schemas (these become JSON Schema for `zetta schema` and MCP), plain `fetch`, `vitest`. TypeScript because the backend, the frontend and all the browser logic we have to port are already TypeScript.
- **Toolchain:** Bun for workspaces, installs and the single-binary build (`bun build --compile`). It replaces pnpm and tsup, so one tool covers everything. The SDK stays plain, portable TypeScript that also runs under Node and in browsers.
- **CI:** lint, typecheck and unit tests on macOS, Linux and Windows; build the binaries for every target; run the vendor-name scan (see "Vendor isolation").
- **Install path from day one:** a first `install.sh` / `install.ps1` that installs the CI-built binary, so we test the real install path from the first build.
- **API contract:** type every endpoint in the matrix from the backend DTOs (until B6 gives us OpenAPI), and save scrubbed real responses as fixtures.
- **Safe test target** (see B11): a dedicated test account with a small credit balance, and an agreed list of the live calls tests may make.
- **Exit:** on a clean machine, one install command gives a working `zetta --version` from a CI-built binary, and the decisions are written into this file.

### Phase 1 — Core shell, auth, read-only commands (about 2 weeks)

- **HTTP client:**
  - Profiles: `prod`, `local`, later `staging`; selected with `--profile` or `ZETTA_API_URL`.
  - Bearer auth and the attribution headers.
  - Error normalisation, and retry with backoff for GETs and for 429/5xx.
  - The Fastify quirks: no JSON content type on POSTs without a body, and arrays sent as repeated query keys.
- **Output layer:** text tables, `json` and `ndjson`; quiet and verbose modes; no colour when there is no terminal or `NO_COLOR` is set.
- **Auth:**
  - `auth login` (the default) uses the loopback flow through `/plugin-auth?client=cli`. That includes the private-network preflight the Unity plugin answers. It works without B1; B1 only fixes the page wording.
  - `auth login --email <addr>` is the headless magic-link flow. The CLI requests the link. The user pastes the link or token back; they must not click it, because it works only once. The CLI calls `/auth/verify` and reads the JWT from `Set-Cookie`.
  - `auth login --with-token` reads a token from stdin, and the `ZETTA_TOKEN` environment variable is honoured, for CI and agents. `auth token` prints the current token so it can be copied to a machine without a browser.
  - Storage: the OS keychain (macOS Keychain, Windows Credential Manager, libsecret). The fallback is a `0600` file under `~/.config/zetta3d/`.
  - `auth status` shows the account, plan and token expiry, and warns when less than 3 days are left.
  - Document that tokens cannot be revoked yet (B5).
- **Read-only commands:**
  - `account show`, `account credits`, `account usage`
  - `billing plans`, `subscription`, `checkout`, `portal`
  - `catalog *` and `quote`
  - `asset list`, `get`, `wait`, `download`
  - `image list`, `get`, `download`
  - `pipeline list`, `pipeline get`, `run list`, `run get`
  - `doctor`: checks config, connectivity, token, clock skew and versions.
- **Exit:** an agent can log in, inspect the account, read the whole library and download any existing file without spending a credit.

### Phase 2 — Uploads and 3D generation (about 2–3 weeks)

This is where credits get spent, and it holds most of the hard porting work.

- **Upload engine** (in the SDK):
  - Content-type detection.
  - Local checks: images PNG, JPEG or WebP, 128–5000 px, at most 8 MB; video at most 100 MB; GLB at most 512 MB.
  - One PUT up to 8 MiB; multipart above that, in 8 MiB parts, aborted on failure.
  - Retries after 600 ms and 1800 ms, a fresh ticket on 410, and progress events.
  - Prefer pure-JS image handling so the standalone binary stays simple.
- **Request builder:** port `gen3d-request.ts` (`deriveSpec`, `applyFormPatch`, `buildCreateRequest`) and the limits in `model-capabilities.ts`, tested for parity against the frontend's own test vectors. Bad combinations are rejected locally, before any credits move.
- **`generate`:**
  - From text: N1 directly; other engines go through `/2d/generate` with `for3D`.
  - From one image, or from multiple views.
  - Every option the Studio offers, plus seeds.
  - `--remove-bg` runs `/tools/rembg` before uploading.
- **Around every paid command:** the spend guard (principle 5), idempotency keys, `--wait`, `--timeout`, `--out`, and queue-position progress.
- **Downloads:**
  - Choose formats the way the Unity importer does: GLB or FBX first, then glTF, then the OBJ zip.
  - The server already removes vendor names from stored files (B9), so the CLI downloads files as they are.
- **Asset management:** `asset rename`, `tag`, `share`, `unshare`, `cancel`, `delete`, `import`.
- **Exit:** "make a textured N2.5 model from ./chair.png and save the GLB to ./out" works end to end, for a person and for an agent, within a spend limit, and the file has no vendor names in it.

### Phase 3 — Finishing tools, images, splats (about 2 weeks)

- **`refine retopo`, `segment`, `uv`, `texture`, `rig`, `convert`**, on an asset id or a local file (`sourceFileUrl`). Port:
  - each tool's defaults and limits (`*-settings-value.ts`, `post-process.ts`);
  - the source-format rules and the conversion surcharge (`needsConversion`, `costOf`).
- **Texture references** work as the panel does: prompt → `/2d/img-edit` → background removal → upload.
- **`image generate`, `edit`, `compose`, `remove-bg`:** the CLI handles the base64 in and out, writes results to files, and explains plan-locked options.
- **`asset export --format obj|stl|fbx`:** local, free conversion from GLB, ported from the frontend exporters. The paid server-side route stays available as `refine convert`.
- **`asset auto-tag`, `asset rig-check`:** both need frames from the viewer. v1 uses the thumbnail and/or `--frame` files; rendering frames headlessly comes later.
- **`generate --draw-missing` and splat world views:** port the prompts in `multi-view.ts` and `world-views.ts`, or read them from the backend once B9 lands.
- **`splat create`** (images, video, world views, early-access gate) and **`splat export`**.
- **Exit:** every Studio tab has a command, and the parity tests pass.

### Phase 4 — Pipelines (about 2 weeks)

- **Graph files:**
  - `pipeline create` / `update --file graph.json|yaml`, and `pipeline get --format yaml`.
  - A friendlier YAML form written in terms of node `settings`. The CLI compiles it to `request` with a port of `requestFor` from `node-config.ts`, so agents don't write raw requests by hand.
- **`pipeline validate`** runs the local graph rules plus the problems from `/pipelines/estimate`; **`pipeline estimate`** shows the cost.
- **`pipeline run` and `pipeline batch`:**
  - Seeds come from files, a directory or glob, asset ids or image ids.
  - Batches over 20 seeds are split automatically.
  - `--draft` together with `run set-input`, and `--mode manual`.
- **Run commands:**
  - `run wait` streams step-level NDJSON.
  - `run outputs --out <dir>` downloads every asset the run produced.
  - `run step run`, `run step retry`, `run parts confirm`, and pause, resume, cancel and mode.
- **The rest of the account features:** onboarding, early-access requests, account deletion (terminal only), public assets.
- **Exit:** an agent can write a pipeline from a description, validate it, estimate it, run it on a folder of pictures and collect the outputs.

### Phase 5 — Agent-native layer (about 2 weeks)

- **`zetta commands --json` and `zetta schema <cmd>`**, generated from the zod definitions.
- **`zetta mcp`:** an MCP server over stdio, built from the same definitions.
  - Tool annotations mark each tool as read-only, destructive or spends credits.
  - The same spend guard applies, with the budget set when the server starts.
  - Long jobs send progress notifications, and files come back as paths.
  - Account deletion and billing changes are left out.
  - This fills the empty "MCP & Skills" page.
- **Agent Skill and reference:** a `SKILL.md` plus an `llms.txt`-style reference covering:
  - what to run first (`auth status`, `catalog entitlements`);
  - how to treat costs;
  - recipes: picture → rigged FBX; a batch of product shots → GLBs; a pipeline from YAML.
- **Agent evals:** a fixed set of tasks run by Claude and other agents against the CLI in a test account. Measure success, credits spent, wasted calls and how errors were recovered from, then use the results to improve help text, errors and defaults.
- **Exit:** on the eval set, an agent given only the skill file completes the core recipes without help and within budget.

### Phase 6 — Distribution and v1.0 (about 1–2 weeks)

The one-command installer and the binaries already exist from Phase 0. This phase makes them public-ready.

- **Signing:** macOS binaries signed and notarised, Windows binaries signed.
- **Extra channels:** a Homebrew tap, and npm `@zetta3d/cli` shipping the same per-platform binaries (for `npx`).
- **Releases:** release automation, a changelog, semver, and a stable download host behind `zetta3d.ai/install.sh`.
- **Updates:** a quiet update notice, off when there is no terminal.
- **Docs:** the `/developers` page on zetta3d.ai, `zetta help` pages and shell completions.
- **Coverage audit** against the matrix: every row has a command, tests and docs.
- **Optional, late:** `agent chat` (3D Agent, Ask mode), and `admin` commands in a separate internal build, never in the public binary.
- **Exit:** v1.0 is published.

### Later

- New product areas as they ship:
  - the animation tab;
  - Forge projects (download, run, deploy);
  - U1 understanding tools (the planned U1 MCP tools map directly onto CLI commands);
  - handing assets to Unity or Blender (`asset download --into <unity-project>`).
- Move the frontend and the Unity plugin onto `packages/sdk`, so the request rules live in one place.

## Backend and frontend work (parallel track)

These are changes in the other repos. Some improve the CLI; others are needed before a public release. The backend or frontend owns each one. "Needed by" is the CLI phase that wants it.

| # | Change | Why | Needed by |
|---|---|---|---|
| B1 | Add `cli` to the `/plugin-auth` client wording (`plugin-client.ts`) (**done 2026-10-21 in the frontend working tree; commit and deploy**) | Otherwise the page says "Blender" | Phase 1 (cosmetic) |
| B2 | Optional: let `/auth/verify` return a plugin token in the response body | Saves reading `Set-Cookie` in the headless flow | Phase 1 (nice to have) |
| B3 | API keys: hashed, named, scoped (read / generate / billing), revocable, with last-used time and per-key rate limits; a page under `/developers` | CI and long-running agents. `content/legal.ts` already mentions per-key logging and limits. | GA |
| B4 | OAuth device-code flow, with short-lived access tokens and refresh tokens (as `ENGINE_DESKTOP.md` §3 plans) | Clean login over SSH, in containers and for remote agents | GA |
| B5 | Token revocation (a `jti` or a per-user token version) and a list of sessions | Today a leaked 30-day token can't be stopped, and logout doesn't invalidate it | GA |
| B6 | OpenAPI generated from the DTOs (`@nestjs/swagger`) | Generated types, contract tests in CI, less drift | Phase 2 onward |
| B7 | One error envelope with a `code` on every 4xx, and a machine-readable failure code on failed jobs | Agents branch on codes, not on English text | Phase 2 onward |
| B8 | Rate limits per user or key instead of per IP; `Retry-After` on 429 | Agents share IPs; batch scripts | Phase 2 onward |
| B9 | Move browser-only logic to the server: vendor-name removal on stored result files (**done 2026-10-21**), background removal as a create option, the view-drawing prompts, and quotes that match charges for conversion and smart-segmentation tiers | One source of truth for every client; no vendor list in any client; the quote must equal the charge | Phase 3 (what's left) |
| B10 | Push job and run status (an SSE stream or webhooks) | Less polling, faster agents | Later |
| B11 | A staging environment with its own database | The local backend uses the production database; CLI end-to-end tests need a safe target | Phase 2 |
| B12 | Stop returning `vendorCredits` from `/3d/quote` and `/3d/operations` to non-admins (**done 2026-10-21**) | It shows what the vendor charges us, to every client | Phase 1 |
| B13 | Drop `result.vendor` (the vendor's asset id and status) from client responses (**done 2026-10-21**) | Vendor detail with no use to a client | Phase 1 |
| B14 | Accept a neutral value for `rigSpec` (`standard` / `mixamo`) instead of the vendor's name (**done 2026-10-21**) | Otherwise a vendor name has to be compiled into the CLI and shown as an option | Phase 3 |
| B15 | Strip language-model ids and raw token counts from the 3D Agent and Unity agent routes (`options.tiers[].model`, SSE `done.tokens`, sessions' `aiTokensSpent`) | Model id plus token count gives our cost per turn | Before exposing agent chat |
| B16 | Neutral image-engine ids on `/2d/models` and in every `/2d/*` response; our own wording for image-provider errors and refusals; neither stored in `errorMessage` | The provider is named today | Now |
| B17 | Store our own refund reason, not the upstream error code, in the credit ledger (or leave `reason` out of `/billing/usage`) | The code's format identifies the provider | Now |
| B18 | Accept the legacy `rigSpec` value as an alias of `standard`, and migrate `settings.spec` / `request.rigSpec` in saved pipeline graphs | Old pipelines now fail at the rig step after earlier steps were charged; the old value is stored and served | Now |
| B19 | Finish file cleaning: USDZ, PLY/SPZ headers, image metadata, ASCII FBX comments, GLBs with over 64 MB of JSON, other files over 256 MB, browser saves through `result-upload`, missing spellings in the word list; share one name map between a standalone OBJ and its MTL; keep base64 texture data out of the ASCII FBX rewrite | Vendor names still ship inside some files | Now |
| B20 | Confirm `npm run backfill:vendor-names -- --apply` has run on production (after a backup; it rewrites in place and does not update stored sizes) | Older downloads still name the vendor otherwise | Now |
| B21 | Stop returning raw `imgUrls` (rows from before mirroring can hold upstream hosts) | Upstream hosts | Soon |
| B22 | Leave `allowedModels` and `maxDrainMultiplierX100` out of the public `/pricing` | LLM names and a margin-adjacent number, unauthenticated | Soon |
| B23 | Frontend analytics: stop sending raw image-engine ids (`image_generated.model`) and concurrency categories (`paywall_shown.feature`) to GA4/PostHog; owner to review the competitor comparison page and the "open-weight" copy | Third parties receive them | Soon |
| B24 | Texture with reference views: the Studio sends `multiViewImages` on a retexture, but the server refuses views without the `multi_view` modifier | Looks like a backend bug; the CLI refuses this combination locally | Soon |
| B25 | Product decisions: the default Generate 3D pipeline node bills `custom_face_count`; Tester accounts hit `ULTRA_DETAIL_NOT_AVAILABLE` with N2.5's default count | Surprising charges or refusals | Decide |
| B26 | Remove the committed debug script `test/_tmp-walk.ts` | Leftover with a local path | Trivial |

## Testing strategy

- **Unit tests:** request builders and graph compilation, with parity vectors taken from the frontend's tests; error normalisation; exit-code mapping.
- **Contract tests:** a mock server (undici MockAgent) replays scrubbed real responses for every endpoint.
- **Live smoke tests** (opt-in, `ZETTA_LIVE=1`):
  - against staging once B11 exists;
  - until then, against a dedicated test account on production, limited to free calls plus a short list of the cheapest paid jobs, with a credit cap per run.
- **No local backend for CLI tests** while the backend's `.env` points at the production database.
- **Agent evals** (Phase 5) run as a regression suite before each release.

## Decisions

Decisions 1–4 were taken as recommended on 2026-10-21 (Bun replaced pnpm as the toolchain). Decision 5 is still open.

**Rust rewrite: rejected (2026-10-21).** Measured: start-up is about 16 ms after the bytecode build, against 150–280 ms per API call and minutes per job. A Rust port would only win on download size, and would add a third hand-kept copy of the web Studio's request rules. Revisit after the backend owns those rules (B6/B9): the client then becomes thin, and a small native client becomes cheap.

1. **Spend policy for agents.** The in-app 3D Agent never spends credits without a click; the CLI will.
   - Recommended: quote first. Without a terminal, require `--yes` or a budget (`--max-credits`, `spend.maxPerCommand`). Give `zetta mcp` its own budget.
2. **Language and packaging.**
   - Recommended: TypeScript, compiled with Bun into one self-contained binary per platform. It shares code and tests with the frontend and backend, and still needs nothing installed.
   - Alternative: Go, for a binary about half the size. The cost is porting all the request logic a third time, after the frontend and Unity.
3. **Command and package names.** Recommended: a `zetta` bin with a `zetta3d` alias, published on npm as `@zetta3d/cli`.
4. **Default wait behaviour.** Recommended: return straight away unless `--wait` or `--out` is given. People can set `defaults.wait=true`.
5. **Launch scope.** Should Phases 1–4 ship as a private beta on the plugin token, with the public v1.0 waiting for B3–B5 (API keys, device flow, revocation)?
