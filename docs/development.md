# Development

## Setup

```bash
bun install                    # Bun 1.4+ (the only tool needed)
bun run zetta -- --help        # run the CLI from source
bun run zetta -- --profile local auth login     # against a local backend (see the warning below)
```

| Script | What it does |
|---|---|
| `bun run check` | Typecheck, every test, lint: run before every change you hand over |
| `bun run test` | Vitest: SDK, request rules, pipelines, every CLI command group |
| `bun run build [target]` | A binary for this machine, or for the targets you name (`windows`, `macos`, `alpine`, `all`, …) → `release/<platform>/`. `--release` builds and checks a full release ([releasing.md](releasing.md)) |
| `bun run docs:commands` | Regenerates `docs/COMMANDS.md` and `skill/SKILL.md` from the command definitions |
| `bun run scan:vendor` | The vendor-name scan (needs the word list; see below) |
| `bun run smoke:live` | The live smoke test against the real API |
| `bun run evals` | Agent evals |
| `bun run package:channels` | npm packages and the Homebrew formula from `dist/` |

**Warning:** the backend's local `.env` points at the production database. Don't run the backend locally for CLI testing. Use the fake APIs in the tests, or the live smoke test with a test account.

## Layout

```
packages/
  sdk/                    @zetta3d/sdk — no runtime dependencies, no Node/Bun/browser-only APIs
    src/transport.ts        fetch wrapper: auth, retries, timeouts, error normalisation
    src/errors.ts           ZettaError and the three server error shapes → one
    src/uploads.ts          ticketed relay uploads (single PUT ≤ 8 MiB, multipart above)
    src/resources/          one class per API area (auth, billing, catalog, generations, …)
    src/builders/           the web Studio's request rules: generate, refine, splat, prompts
    src/pipeline/           pipeline graph model, catalogue, validation, YAML recipe compiler
    src/export.ts           GLB parser; OBJ and STL writers
    src/files.ts            file detection and engine input checks
  cli/                    the zetta program
    src/main.ts             entry point (no top-level await: release builds are bytecode)
    src/core/               the command framework (see below)
    src/commands/           one file per group; index.ts registers them
    src/auth/               browser hand-off (loopback) and opening the browser
    src/mcp/                the MCP server, generated from the same command definitions
    src/export/fbx.ts       GLB → FBX (three.js, loaded only for this)
    src/upgrade/            self-update and the release manifest
    src/guide.ts            the agent guide; also SKILL.md
install/                  install.sh, install.ps1 and the hosting checklist
scripts/                  builds, scans, docs, smoke tests, evals, packaging
evals/tasks.yaml          agent eval tasks
```

## The command framework

One definition per command drives everything: the parser, `--help`, `--input`, `zetta schema`, `zetta commands`, the MCP tool and `docs/COMMANDS.md`.

```ts
export const assetRename = defineCommand({
  path: ['asset', 'rename'],                      // `zetta asset rename`, MCP tool `asset_rename`
  summary: 'Give an asset a title.',
  kind: 'write',                                   // read | write | spend | destructive | local
  positionals: [{ name: 'id', required: true }, { name: 'title', required: true }],
  input: z.object({ id: z.number().int().positive().describe('…'), title: z.string().min(1).describe('…') }),
  async run(ctx, input) { … return data },         // data → JSON, or `text` for people
  text: (data) => `Renamed #${data.id}.`,
})
```

Rules the framework enforces, so commands don't have to:
- **Flags** come from the zod schema; `describe()` text becomes the help text.
- **Input validation:** unknown keys and bad values give exit code 2.
- **Name clashes:** a field may not reuse a global flag name. A startup check fails otherwise.
- **Paid commands** (`kind: 'spend'`) include `...spendShape`, and run their job through `runPaidJob` (`core/jobs.ts`): quote → spend guard → prepare (uploads) → create → wait → download. Uploads happen only after the spend is approved.
- **Errors:** throw a `ZettaError` (or use `usageError` / `cliError`). The output layer turns it into the JSON envelope, picks the exit code (`core/exit-codes.ts`) and adds a hint (`core/hints.ts`).
- **Upstream detail never reaches output:** `core/sanitize.ts` drops fields such as `category` and `vendor*` and rewords image-engine errors. The CLI must never print a model vendor's name.

## Tests

| Where | What |
|---|---|
| `packages/sdk/test/` | Transport retries, error shapes, uploads (single, multipart, expired ticket), polling, file checks |
| `packages/sdk/test/builders/` | The request rules, with parity vectors from the web app's own tests |
| `packages/sdk/test/pipeline/` | Graph rules, recipe compile/decompile round trips |
| `packages/cli/test/` | Every command group end to end, in-process, with a fake `fetch` (`harness.ts`) |
| `packages/cli/test/mcp-client.test.ts` | `zetta mcp` through the official MCP client over real stdio |
| `packages/cli/test/isolation.test.ts` | Upstream identifiers never reach output |
| `scripts/test-install.ts` | The real installers end to end against a local download host |

`harness.ts` points the home and settings folders at a temp folder for every run, so no test can touch your real ones. When a test needs a known home folder, pass `env: homeEnv(dir)`: Windows reads `USERPROFILE` and `APPDATA`, not `HOME`. In the CLI, use `homeDir(ctx.env)` from `core/paths.ts`, never `os.homedir()`.

## Live smoke test

Runs the real CLI against the real API. It creates only what it deletes again.

```bash
bun run smoke:live                                         # public checks only
ZETTA_TOKEN=… bun run smoke:live                           # every free check, signed in
ZETTA_TOKEN=… bun run smoke:live --paid --budget 200       # plus the cheapest paid jobs, capped at 200 credits
bun run smoke:live --bin dist/v0.1.0/zetta-darwin-arm64    # test a built binary
```

What the free checks cover:
- account, plan and catalog;
- dry-run prices for every engine your plan allows, and for the finishing tools;
- pipeline validation;
- uploads of a small GLB and a 12 MB GLB (multipart);
- rename, tag and delete.

The paid steps make the cheapest N1 model, export it locally, and retopologise it. It reports the 3D credits spent.

## Agent evals

Measures whether AI agents can finish real tasks with `zetta` alone.

```bash
bun run evals --list
ZETTA_TOKEN=… bun run evals                       # free tasks, Claude Code (`claude -p`) as the agent
ZETTA_TOKEN=… bun run evals --paid                # tasks that spend credits, each capped
bun run evals --no-skill                          # baseline without the skill
bun run evals --agent 'my-agent --task {prompt}' --report evals.json
```

How it runs:
- **Fresh folder:** each task runs in a new folder, with the skill installed there.
- **Checks:** answers, files written, `zetta` commands that must pass, and credits spent, read from the account balance.
- **Tasks** live in `evals/tasks.yaml`. Add one whenever an agent gets something wrong in real use.

## Vendor isolation

The CLI must never contain or print the name of a model vendor. `bun run scan:vendor --require-list --require-bundle` scans:
- every file in the repository;
- the bundled JavaScript (our code plus dependencies);
- the compiled binaries, ignoring matches that are part of the Bun runtime itself.

The word list comes from `ZETTA_VENDOR_WORDS` (comma-separated) or `ZETTA_VENDOR_WORDS_FILE`, never from the repository. Keep it in a file outside the repository and set `ZETTA_VENDOR_WORDS_FILE` in your shell profile; `bun run build --release` refuses to start without it.

## Keeping in step with the web app

The request rules in `packages/sdk/src/builders` and `packages/sdk/src/pipeline` are ports of the web Studio's TypeScript. When the Studio's rules change, update the port and its parity tests together. The long-term fix is for the backend to own those rules (ROADMAP B6/B9).
