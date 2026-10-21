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
| `defaults.engine` | `n1`, `n25`, `np1`, `np15` | Default engine for `zetta generate` |
| `spend.maxPerCommand` | a number | Credits one command may spend without `--yes`; anything pricier is refused. Lets scripts and agents spend without confirming each command |
| `spend.requireConfirm` | `true` / `false` | Ask before spending in a terminal (default `true`) |
| `currentProfile` | a profile name | The profile used when `--profile` isn't given |

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
| `ZETTA_TOKEN` | Use this token; it wins over saved sign-ins and is never stored |
| `ZETTA_PROFILE` | Profile to use |
| `ZETTA_API_URL`, `ZETTA_SITE_URL` | Override the profile's addresses |
| `ZETTA_OUTPUT` | `text`, `json` or `ndjson` |
| `ZETTA_CONFIG_DIR` | Where settings and the token file live |
| `ZETTA_NO_KEYCHAIN=1` | Keep the token in the `0600` file, not the system keychain |
| `ZETTA_NON_INTERACTIVE=1` | Never prompt |
| `ZETTA_NO_UPDATE_CHECK=1` | No daily update notice |
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
