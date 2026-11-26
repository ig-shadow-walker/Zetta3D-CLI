# Configuration

`zetta` works with no configuration. Everything below is optional.

## Settings

```bash
zetta config list                  # every setting, its value and what it does
zetta config get output
zetta config set <key> <value>
zetta config unset <key>
```

| Key | Values | Effect |
|---|---|---|
| `output` | `text`, `json`, `ndjson` | Default output format. Otherwise: text in a terminal, JSON when piped |
| `defaults.wait` | `true` / `false` | Paid commands wait for their job unless `--no-wait` is given |
| `defaults.engine` | `n2.5`, `np1`, `np1.5` | Default engine for `zetta generate` (`n2.5` when unset). N1 is retired: a saved `n1` fails with a message saying so; set another engine or unset it |
| `download.auto` | `true` / `false` | Download finished jobs into the folder you run `zetta` in. Unset: on in a terminal, off for scripts and agents. See [Automatic downloads](#automatic-downloads) |
| `skills.auto` | `true` / `false` | Install the agent skill for Claude Code, Codex and Cursor automatically, and keep it current (default `true`). `zetta skill uninstall` sets it to `false`; `zetta skill install` back to `true` |
| `download.dir` | a folder | Where downloads go instead of the current folder. A relative path starts from the current folder, e.g. `models` |
| `download.formats` | formats, comma-separated | Only these formats in automatic downloads, e.g. `glb,fbx` (default: every result file) |
| `spend.maxPerCommand` | a number | Credits one command may spend without `--yes`; anything pricier is refused. Lets scripts and agents spend without confirming each command |
| `spend.requireConfirm` | `true` / `false` | Ask before spending in a terminal (default `true`) |
| `currentProfile` | a profile name | The profile used when `--profile` isn't given |

## Automatic downloads

When a generation, a finishing job or a pipeline run is done, `zetta` downloads the results into the folder you ran it in. You don't need `--out`.

```bash
cd ~/projects/game/assets
zetta generate -i chair.png --engine n2.5 --max-credits 60   # waits, then saves 1234-model.glb here
```

**Turning it on or off:**

```bash
zetta config set download.auto false   # off: jobs return at once with their id
zetta config set download.auto true    # on everywhere, scripts and agents too
zetta config unset download.auto       # back to the default: on in a terminal only
```

For one command, `--download` turns it on and `--no-download` turns it off. `--no-wait` also skips it, because the command returns before the job is done.

**What gets downloaded:**

| Command | Downloads |
|---|---|
| `generate`, `refine …`, `splat …` | Every result file of the new asset |
| `asset wait <id>` | Every result file of that asset |
| `pipeline run`, `pipeline batch`, `run wait` | The final models of each run, the last step of every branch (`run outputs <id>` gets every step) |
| `image generate`, `image edit`, `image compose` | The pictures. They come back with the reply, so they save even for scripts. Only `download.auto false` or `--no-download` keeps them in your image library alone |

**Details:**
- **Where:** files go into the current folder, or `download.dir`. They are named `<id>-<file>`, e.g. `1234-model.glb`, and existing files are never overwritten.
- **Formats:** `download.formats glb,fbx` keeps only those. A command's own `--format` wins over it.
- **Failures:** an automatic download never fails a finished job. If a file can't be downloaded, or none matches your formats, you get a warning and the command to download it later.
- **`--out <folder>`** works as before: it waits and downloads into that folder, whatever the setting.
- **Scripts and agents** get the same JSON as with `--out`. The saved paths are in `files` (or `saved`).
- **MCP tools** never download on their own, because the server's folder isn't yours. A tool call downloads only when it passes `download: true` or `out`.

Settings live in `config.json` in the config folder: `~/.config/zetta3d` (or `$XDG_CONFIG_HOME/zetta3d`). On Windows it is `%APPDATA%\zetta3d`. `ZETTA_CONFIG_DIR` overrides it.

## Profiles

A profile is an API address plus its own sign-in.

```bash
zetta config profiles
zetta config add-profile staging --api https://staging-api.example.com/api --site https://staging.example.com --use
zetta config use default
zetta config remove-profile staging
zetta --profile staging asset list
```

`zetta config profiles` shows the account each profile's saved sign-in is for. It shows saved sign-ins only: `ZETTA_API_KEY` belongs to no single profile.

| Built-in | API | Website |
|---|---|---|
| `default` | `https://api.zetta3d.ai/api` | `https://zetta3d.ai` |
| `local` | `http://localhost:4000/api` | `http://localhost:3000` |

## Global flags

These work with every command:

| Flag | Effect |
|---|---|
| `--json`, `-o, --output text\|json\|ndjson` | Output format |
| `--profile <name>` | Use another profile |
| `--api-url <url>` | Override the API address for this command |
| `--verbose` | Show each API request on stderr |
| `-q, --quiet` | Print only the result |
| `--no-color` | No colours |
| `--non-interactive` | Never prompt; fail instead (implied in CI) |
| `--input <json\|@file\|->` | Give the command's inputs as one JSON object |
| `-v, --version`, `-h, --help` | |

## Environment variables

| Variable | Effect |
|---|---|
| `ZETTA_API_KEY` | Use this API key. It wins over everything else and is never stored |
| `ZETTA_PROFILE` | Profile to use |
| `ZETTA_API_URL`, `ZETTA_SITE_URL` | Override the profile's addresses |
| `ZETTA_OUTPUT` | `text`, `json` or `ndjson` |
| `ZETTA_CONFIG_DIR` | Where settings and the saved token or key live |
| `ZETTA_NO_KEYCHAIN=1` | Keep the saved token or key in the `0600` file, not the system keychain |
| `ZETTA_NON_INTERACTIVE=1` | Never prompt |
| `ZETTA_NO_UPDATE_CHECK=1` | No new-version check or notice (normally at most once an hour, at a terminal) |
| `ZETTA_NO_LOGIN=1` | The installers don't start the browser sign-in after installing |
| `ZETTA_NO_SKILL=1` | Don't install or refresh the agent skill automatically (installers, upgrades) |
| `ZETTA_DOWNLOAD_BASE` | Download host for `zetta upgrade` (and the installers) |
| `NO_COLOR` | No colours |
| `CI=true` | Implies no prompts |

## Output formats

| Format | Result | Progress | Errors |
|---|---|---|---|
| `text` (terminals) | Readable text on stdout | One status line on stderr | `Error: …` and a hint on stderr |
| `json` (when piped) | One JSON document on stdout | None | One JSON line on stderr |
| `ndjson` | `{"type":"result","data":…}` on stdout | `{"type":"progress",…}` lines on stdout | `{"type":"error",…}` on stdout |

## Shell completion

```bash
zetta completion zsh  > ~/.zfunc/_zetta        # then: fpath+=~/.zfunc; autoload -U compinit; compinit
zetta completion bash > ~/.local/share/bash-completion/completions/zetta
zetta completion fish > ~/.config/fish/completions/zetta.fish
```
