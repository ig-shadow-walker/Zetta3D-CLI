# AI agents and MCP

`zetta` is designed to be driven by AI agents (Claude Code, Codex, Cursor, custom agents, CI) as much as by people. There are three ways in:

| Way | Best for | Set up with |
|---|---|---|
| **Shell commands** + the skill | Coding agents that run commands (Claude Code, Codex, Cursor's agent) | `zetta setup claude-code` / `codex` / `agents-md`, or `zetta skill install` |
| **MCP server** | Chat apps and agents that speak MCP (Claude Desktop, Cursor, Claude Code) | `zetta setup claude-desktop` / `cursor` / `claude-code` |
| **SDK** | Your own TypeScript programs | `@zetta3d/sdk` (see [packages/sdk/README.md](../packages/sdk/README.md)) |

## Connect your tool

```bash
zetta setup claude-code --budget 500     # skill in ~/.claude/skills + `claude mcp add` (user scope)
zetta setup claude-desktop               # adds zetta to claude_desktop_config.json (restart the app)
zetta setup cursor                       # adds zetta to ~/.cursor/mcp.json
zetta setup codex                        # [mcp_servers.zetta3d] in ~/.codex/config.toml + guide in ~/.codex/AGENTS.md
zetta setup agents-md                    # the guide in ./AGENTS.md, for any agent that reads it
zetta setup cursor --print               # show what would change, change nothing
```

How `setup` behaves:
- **Re-running** replaces its own entry; it never duplicates it.
- **Backups:** existing files are backed up to `.bak`.
- **Spending:** `--budget N` lets an MCP session spend up to N credits in total without per-call confirmation. Without it, every paid tool call must pass `maxCredits` or `yes`.
- **`--read-only`** offers only tools that never change anything.

The skill on its own:

```bash
zetta skill install              # ~/.claude/skills/zetta3d/SKILL.md (all projects)
zetta skill install --project    # ./.claude/skills/zetta3d/SKILL.md (this repository)
zetta skill install --dir <dir>  # any skills folder
zetta skill show                 # print it (for frameworks that load skills from elsewhere)
zetta guide                      # the same guide, without front matter
```

## The contract

Everything an agent needs to rely on:

**Output**
- **Format:** stdout is **JSON** whenever it is not a terminal. Force a format with `--json`, `--output json|ndjson|text` or `ZETTA_OUTPUT`.
- **Separation:** results go to stdout; diagnostics go to stderr.
- **Streaming:** `--output ndjson` streams progress events (`{"type":"progress",…}`) and ends with `{"type":"result","data":…}`.

**Errors** are one JSON object on stderr:

```json
{"error":{"code":"INSUFFICIENT_CREDITS","message":"Not enough credits.","status":400,
  "details":{"required":50,"available":12},
  "hint":"Check your balance with `zetta account credits`; top up with `zetta billing checkout`.","exitCode":5}}
```

Branch on `code` or on the exit code, and follow `hint`.

**Exit codes**

| Code | Meaning | What to do |
|---|---|---|
| 0 | Success | |
| 2 | Bad input or failed local check | Fix the flags (see `details.problems`) |
| 3 | Not signed in, or expired | Ask the user to run `zetta auth login`, or set `ZETTA_TOKEN` |
| 4 | The plan does not allow it | `zetta catalog entitlements`; choose another option |
| 5 | Not enough credits, or over the spend limit | Check `details.credits`; ask the user before raising `--max-credits` |
| 6 | Not found | Check the id |
| 7 | Conflict or concurrency limit | Wait for a running job (`zetta asset wait`) |
| 8 | Rate limited | Wait a minute; use a pipeline batch for many jobs |
| 9 | The job failed or was cancelled (refunded) | Try other settings or another engine |
| 10 | Stopped waiting; the job is still running | Run `zetta asset wait <id>` again |
| 11 | Network or server error | Retry; `zetta doctor` |

**Discovery**
- `zetta commands --json` lists every command, its flags, types, enums, defaults, kind (`read`, `write`, `spend`, `destructive`, `local`) and the exit codes.
- `zetta schema <command>` prints a command's JSON Schema.
- `--input '<json>'` (or `@file.json`, or `-` for stdin) passes every input as one object. Keys are the flag names in camelCase, and flags given as well take precedence.

**Spending**
1. Every paid command prices the job first. `--dry-run` returns `{"dryRun":true,"credits":N,"lines":[…],"request":{…}}` and spends nothing.
2. To spend, pass `--max-credits N` (preferred: it refuses anything pricier) or `--yes`. Without either, and without a terminal, the command exits with code 5 before anything happens.
3. `--idempotency-key <key>` makes retries safe: the same key is never charged twice, and the result says `"charged": false` for a replay.
4. The user can set a standing limit with `zetta config set spend.maxPerCommand N`.

**Long jobs.** Never block an agent's shell for minutes. Start the job (it returns at once with an `id`), then `zetta asset wait <id> --timeout 90s`, repeated while the exit code is 10. Use `--out <folder>` only when the wait fits your timeout. Pipeline runs work the same way with `zetta run wait`.

**Automatic downloads.** Without a terminal, jobs don't download on their own, so the rule above holds. If the user set `download.auto true`, jobs wait and download into the current folder: pass `--no-wait` to start a job and return at once, and `asset wait --no-download` to only wait. MCP tools never download unless the call passes `download: true` or `out`.

**Prompts.** There are none: without a terminal, `zetta` never prompts. `--non-interactive` (or `ZETTA_NON_INTERACTIVE=1`) enforces that even in a terminal.

**Files.** Commands that take pictures or models accept local paths, and `--out` returns the paths it wrote.

## The MCP server

```bash
zetta mcp                       # stdio MCP server
zetta mcp --budget 500          # the session may spend up to 500 credits without per-call confirmation
zetta mcp --read-only           # only tools that never change anything
```

**What it serves:**
- **Tools:** every command except the local, sign-in, token, config and account-deletion ones, about 72 in all. Names are the command path with underscores: `generate`, `asset_list`, `asset_wait`, `refine_rig`, `pipeline_batch`, …
- **Inputs:** each tool's input is the command's JSON Schema.
- **Annotations:** each tool is marked as read-only or destructive.
- **Instructions:** the server gives the client a short usage guide.

**How calls behave:**
- **Results:** a JSON text block.
- **Errors:** come back with `isError: true` and the same error object as the CLI.
- **Paid tools:** the description tells the agent how pricing works. A tool needs `maxCredits` or `yes` in its arguments, unless the session has a budget. Past the budget, calls fail with `SPEND_LIMIT`.
- **Progress:** long calls send progress notifications when the client asks for them.

**Sign-in:** the server uses the same sign-in as the CLI, so run `zetta auth login` once first, or set `ZETTA_TOKEN` in the client's server config.

Manual configuration, if you'd rather not use `zetta setup`:

```json
{
  "mcpServers": {
    "zetta3d": { "command": "/Users/you/.zetta/bin/zetta", "args": ["mcp", "--budget", "500"] }
  }
}
```

Use the absolute path: desktop apps don't see your shell's `PATH`.

## Recipes for agents

```bash
# Start of a session
zetta auth status && zetta account credits && zetta catalog entitlements

# Picture → textured model, downloaded
zetta generate -i photo.jpg --remove-bg --engine n2.5 --max-credits 150 --out ./out

# Game-ready character
zetta refine retopo 123 --faces 5000 --max-credits 100 --wait --timeout 90s
zetta asset rig-check 124
zetta refine rig 124 --rig-type biped --rig-format fbx --max-credits 60 --out ./out

# Many inputs: one pipeline batch instead of many separate jobs
zetta pipeline validate recipe.yaml && zetta pipeline create --file recipe.yaml
zetta pipeline batch <id> ./photos --max-credits 2000
zetta run wait <runId> --timeout 90s
```

## Measuring how well agents do

`bun run evals` gives an agent (Claude Code in print mode by default; any command via `--agent`) plain requests from [evals/tasks.yaml](../evals/tasks.yaml), then checks the result:
- the agent's answers;
- the files it wrote;
- `zetta` commands that should pass;
- how many credits were spent.

Free tasks run by default, and paid tasks only with `--paid`. Compare runs with and without the skill (`--no-skill`). See [development.md](development.md#agent-evals).
