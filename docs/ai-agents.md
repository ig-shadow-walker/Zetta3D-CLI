# AI agents and MCP

`zetta` is designed to be driven by AI agents (Claude Code, Codex, Cursor, custom agents, CI) as much as by people. There are three ways in:

| Way | Best for | Set up with |
|---|---|---|
| **Shell commands** + the skill | Coding agents that run commands (Claude Code, Codex, Cursor's agent) | Installed with zetta (see [The agent skill](#the-agent-skill)), or `zetta skill install` |
| **MCP server** | Chat apps and agents that speak MCP (Claude Desktop, Cursor, Claude Code) | `zetta setup claude-desktop` / `cursor` / `claude-code` |
| **SDK** | Your own TypeScript programs | `@zetta3d/sdk` (see [packages/sdk/README.md](../packages/sdk/README.md)) |

## Connect your tool

```bash
zetta setup claude-code --budget 500     # skill in ~/.claude/skills + `claude mcp add` (user scope)
zetta setup claude-desktop               # adds zetta to claude_desktop_config.json (restart the app)
zetta setup cursor                       # skill in ~/.agents/skills + zetta in ~/.cursor/mcp.json
zetta setup codex                        # skill in ~/.agents/skills + [mcp_servers.zetta3d] in ~/.codex/config.toml
zetta setup agents-md                    # the guide in ./AGENTS.md, for any agent that reads it
zetta setup cursor --print               # show what would change, change nothing
```

How `setup` behaves:
- **Re-running** replaces its own entry; it never duplicates it.
- **Backups:** existing files are backed up to `.bak`.
- **Spending:** `--budget N` lets an MCP session spend up to N credits in total without per-call confirmation. Without it, every paid tool call must pass `maxCredits` or `yes`.
- **`--read-only`** offers only tools that never change anything.

## The agent skill

The skill teaches a coding agent how to use `zetta`: the ground rules (JSON output, exit codes, the spend guard, waiting on long jobs), the common recipes, and a reference file for each area that the agent opens only when it needs it. It follows the open Agent Skills format: a `zetta3d` folder with `SKILL.md` and `references/`.

**It installs itself.** The one-line installers, Homebrew and npm install it for every agent they find on the machine:

| Agent | Where the skill goes |
|---|---|
| Claude Code | `~/.claude/skills/zetta3d` |
| Codex | `~/.agents/skills/zetta3d` |
| Cursor | `~/.agents/skills/zetta3d` (Cursor also reads Claude Code's folder) |

**It stays current.** The first time a newer `zetta` runs after an upgrade, by any route (`zetta upgrade`, the installer, Homebrew, npm), it updates the installed copies. The folder is zetta's: edits there are replaced on the next update.

```bash
zetta skill status               # where it is installed, and whether it is current
zetta skill install              # install now: for the agents found here (--agent claude|codex|cursor|all)
zetta skill install --project    # into this repository: .claude/skills and .agents/skills
zetta skill install --dir <dir>  # into any skills folder
zetta skill uninstall            # remove it, and stop installers and upgrades putting it back
zetta skill show --list          # its files; --file pipelines prints one
zetta guide                      # the same guide in the terminal; zetta guide <topic> prints a reference
```

**Turning it off:**
- **One install:** `ZETTA_NO_SKILL=1` skips the skill.
- **For good:** `zetta skill uninstall`, or `zetta config set skills.auto false`.
- **Turning it back on:** an explicit `zetta skill install`.

Agents that read neither skills folder can still get the guide: `zetta setup agents-md` puts it in `./AGENTS.md`, and `zetta guide` prints it.

## New versions

Agents learn about new versions in three ways:
- **The skill** tells them to run `zetta upgrade --check` at the start of a session. When `updateAvailable` is true, they tell the user, who updates with the command in `upgradeWith` (usually `zetta upgrade`).
- **The MCP server** adds a line to its instructions when a newer version is known.
- **`zetta doctor`** reports it as the `update` check.

After an upgrade, the skill refreshes itself the next time `zetta` runs.

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
| 3 | Not signed in, expired, a refused API key, or the command needs a browser sign-in | Ask the user to run `zetta auth login`, or to set `ZETTA_API_KEY` |
| 4 | The plan or access does not allow it: no plan yet, a missing feature, or an API key limit | `PLAN_REQUIRED`: ask the user to choose a plan (see below). Otherwise `zetta catalog entitlements`, and choose another option |
| 5 | Not enough credits, or over the spend limit | Check `details.credits`; ask the user before raising `--max-credits` |
| 6 | Not found | Check the id |
| 7 | Conflict or concurrency limit | Wait for a running job (`zetta asset wait`) |
| 8 | Rate limited | Wait the seconds in `details.retryAfter`; use a pipeline batch for many jobs |
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

**No plan.** There is no free tier. Every spending command (3D models, finishing tools, pictures, AI tags and rig checks, pipeline runs and drafts) fails with `PLAN_REQUIRED` (exit code 4) when the account has no plan. Nothing is spent, and retrying won't help. Tell the user, who can choose a plan (`zetta billing plans`, then `zetta billing checkout <plan>`) or redeem a trial code (`zetta account redeem <code>`). Both need the user's browser sign-in. `zetta account credits --json` has `canSpend` to check first.

**Long jobs.** Never block an agent's shell for minutes. Start the job (it returns at once with an `id`), then `zetta asset wait <id> --timeout 90s`, repeated while the exit code is 10. Use `--out <folder>` only when the wait fits your timeout. Pipeline runs work the same way with `zetta run wait`.

**Automatic downloads.** Without a terminal, jobs don't download on their own, so the rule above holds. If the user set `download.auto true`, jobs wait and download into the current folder: pass `--no-wait` to start a job and return at once, and `asset wait --no-download` to only wait. MCP tools never download unless the call passes `download: true` or `out`.

**Prompts.** There are none: without a terminal, `zetta` never prompts. `--non-interactive` (or `ZETTA_NON_INTERACTIVE=1`) enforces that even in a terminal.

**Files.** Commands that take pictures or models accept local paths, and `--out` returns the paths it wrote.

**Signing in.** Agents and CI should use an API key: `ZETTA_API_KEY=zk_live_…`. A key doesn't expire, can be revoked at any time, and can't manage keys, billing or the account. The user makes one with `zetta apikey create <name>` on a machine where they are signed in with a browser. Commands a key can't run fail with `API_KEY_NOT_ALLOWED` (exit code 3); see [what an API key can do](authentication.md#what-an-api-key-can-do). Keys allow 300 requests a minute and 5,000 an hour, and the CLI waits out short `Retry-After` waits (up to a minute) by itself.

## The MCP server

```bash
zetta mcp                       # stdio MCP server
zetta mcp --budget 500          # the session may spend up to 500 credits without per-call confirmation
zetta mcp --read-only           # only tools that never change anything
```

**What it serves:**
- **Tools:** every command except the local, sign-in, token, config and account-deletion ones, about 80 in all. Names are the command path with underscores: `generate`, `asset_list`, `asset_wait`, `refine_rig`, `pipeline_batch`, …
- **Left out on purpose:** `apikey create`, so a new key never lands in an agent's context, and `billing agent-plan`, because it charges a card. The user runs those in a terminal.
- **Inputs:** each tool's input is the command's JSON Schema.
- **Annotations:** each tool is marked as read-only or destructive.
- **Instructions:** the server gives the client a short usage guide.

**How calls behave:**
- **Results:** a JSON text block.
- **Errors:** come back with `isError: true` and the same error object as the CLI.
- **Paid tools:** the description tells the agent how pricing works. A tool needs `maxCredits` or `yes` in its arguments, unless the session has a budget. Past the budget, calls fail with `SPEND_LIMIT`.
- **Progress:** long calls send progress notifications when the client asks for them.

**Sign-in:** the server uses the same sign-in as the CLI, so run `zetta auth login` once first, or set `ZETTA_API_KEY` in the client's server config.

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
# Start of a session: who, which credential, and can the account spend?
zetta auth status && zetta account credits && zetta catalog entitlements

# Picture → textured model, downloaded
zetta generate -i photo.jpg --remove-bg --engine n2.5 --max-credits 150 --out ./out

# Game-ready character
zetta refine retopo 123 --faces 5000 --max-credits 100 --wait --timeout 90s
zetta asset rig-check 124
zetta refine rig 124 --rig-type biped --rig-format fbx --max-credits 60 --out ./out

# Many inputs: one pipeline batch instead of many separate jobs
# (creating a pipeline needs a browser sign-in; an API key runs saved pipelines by id)
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
