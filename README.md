# Zetta 3D CLI

`zetta` puts the whole Zetta 3D account in your terminal: make 3D models from text or pictures,
refine them (retopology, segmentation, UVs, texturing, rigging, conversion), make pictures, build
splat worlds, and run pipelines. It is built first for AI agents — JSON when piped, one error
format, meaningful exit codes, a spend guard — and works just as well by hand.

## Install

One command, nothing else needed (the binary carries its own runtime):

```bash
curl -fsSL https://zetta3d.ai/install.sh | sh
```

```powershell
irm https://zetta3d.ai/install.ps1 | iex
```

Then sign in:

```bash
zetta auth login
```

No browser on this machine (SSH, containers)? `zetta auth login --email you@example.com`, or set
`ZETTA_TOKEN` (copy it with `zetta auth token` from a machine where you are signed in).

## Use it

```bash
zetta generate --image chair.png --engine n2.5 --dry-run        # price it
zetta generate --image chair.png --engine n2.5 --max-credits 100 --out ./models
zetta refine rig 1234 --rig-type biped --rig-format fbx --yes --out ./models
zetta asset list
zetta asset export 1234 --format stl --out ./print              # free, local
zetta image generate -p "a brass desk lamp" --for-3d --out ./refs
```

- `zetta --help` and `zetta <command> --help` for flags.
- `zetta guide` — how agents should use the CLI.
- `zetta commands --json` — every command and flag, machine-readable; `zetta schema <command>` for one command's JSON Schema.
- Full reference: [docs/COMMANDS.md](docs/COMMANDS.md).

## For AI agents

- Output is JSON whenever stdout is not a terminal. Errors are JSON on stderr with a `code`, a `hint` naming the next step, and an `exitCode`.
- Paid commands quote first. `--dry-run` shows the price; `--max-credits N` or `--yes` spends. Without either, nothing is spent (exit 5).
- Jobs return at once with an id. `zetta asset wait <id> --timeout 90s` waits in short steps (exit 10 = still running).
- `--idempotency-key` makes retries free of double charges. `--input '<json>'` passes all inputs as JSON.
- Skill file for agent frameworks: [skill/SKILL.md](skill/SKILL.md).

### MCP

```bash
claude mcp add zetta3d -- zetta mcp --budget 500
```

Every command becomes an MCP tool with the same checks. `--budget` caps the session's spend;
`--read-only` offers only tools that never change anything.

## Exit codes

0 ok · 1 unexpected · 2 bad input · 3 not signed in · 4 plan/access · 5 credits/spend limit ·
6 not found · 7 conflict/concurrency · 8 rate limited · 9 job failed · 10 still running · 11 network/server

## Configuration

`zetta config list` shows everything. Useful settings:

```bash
zetta config set spend.maxPerCommand 200    # agents may spend up to 200 credits per command without --yes
zetta config set defaults.wait true         # wait for jobs unless --no-wait
zetta config add-profile staging --api https://staging-api.example.com/api --site https://staging.example.com
zetta --profile local asset list            # built-in profile for a local backend
```

Environment: `ZETTA_TOKEN`, `ZETTA_PROFILE`, `ZETTA_API_URL`, `ZETTA_SITE_URL`, `ZETTA_OUTPUT`,
`ZETTA_CONFIG_DIR`, `ZETTA_NO_KEYCHAIN=1`, `ZETTA_NON_INTERACTIVE=1`, `NO_COLOR`.

Tokens are stored in the system keychain where available, otherwise in a `0600` file in the
config folder. Tokens cannot be revoked server-side yet: treat them like passwords.

## Development

```bash
bun install
bun run zetta -- --help        # run from source
bun run check                  # typecheck, tests, lint
bun run build:local            # single binary for this machine → dist/
bun run build                  # every platform
bun run docs:commands          # regenerate docs/COMMANDS.md and skill/SKILL.md
```

Layout:

- `packages/sdk` — typed API client, uploads, request builders, pipeline graph logic, local GLB export. No terminal or file-system code; no runtime dependencies.
- `packages/cli` — commands (`src/commands`), the command framework (`src/core`), sign-in (`src/auth`), the MCP server (`src/mcp`), self-update (`src/upgrade`).
- `install/` — the one-line installers. `scripts/` — builds, the vendor-name scan, docs.

The CLI talks only to the Zetta 3D API and must never name a model vendor anywhere — code, output,
docs or files. CI runs `bun run scan:vendor --require-list` with the word list kept in CI secrets.

See [ROADMAP.md](ROADMAP.md) for the plan and status.
