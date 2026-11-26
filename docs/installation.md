# Installation

`zetta` is one self-contained program with its runtime built in. Nothing else needs to be installed first.

## The one-line installers

**macOS and Linux**

```bash
curl -fsSL https://zetta3d.ai/install.sh | sh
```

No `curl`? `wget -qO- https://zetta3d.ai/install.sh | sh` works too.

**Windows** (PowerShell 5.1 or 7+)

```powershell
irm https://zetta3d.ai/install.ps1 | iex
```

What the installer does:

1. **Picks your build.** It detects your system and CPU:
   - **Apple Silicon** gets the arm64 build, even from a Rosetta shell.
   - **Alpine and other musl systems** get the `-musl` build.
   - **x64 CPUs without AVX2** get the `-baseline` build.
2. **Downloads it.** It fetches the compressed copy (about 30 MB) and checks its SHA-256. It then unpacks it and checks the unpacked binary against the published checksum too.
3. **Tests it.** It runs the new binary once (`--version`) before replacing anything.
4. **Installs it,** atomically and without sudo or admin rights:
   - macOS and Linux: `~/.zetta/bin/zetta`
   - Windows: `%LOCALAPPDATA%\zetta\bin\zetta.exe`
5. **Adds the folder to your `PATH`:**
   - macOS and Linux: one line in `~/.zshrc`, `~/.bashrc`, `~/.config/fish/config.fish` or `~/.profile`, never twice;
   - Windows: your user `Path`.
6. **Teaches your AI coding agents.** For each of Claude Code, Codex and Cursor it finds, it installs the Zetta 3D skill: `~/.claude/skills/zetta3d` and `~/.agents/skills/zetta3d`. See [the agent skill](ai-agents.md#the-agent-skill). `ZETTA_NO_SKILL=1` skips this step. Homebrew and npm installs do the same.
7. **Signs you in.** In a terminal, it opens your browser so you can sign in to your Zetta 3D account and connect the CLI; then everything is available. If you're already signed in, it says so. It skips this in CI, without a terminal, when `ZETTA_API_KEY` is set, or with `ZETTA_NO_LOGIN=1`; then run `zetta auth login` yourself. On a server or over SSH, use an API key instead (see [authentication.md](authentication.md)).

Open a new terminal (or `source` your shell's rc file), then check:

```bash
zetta --version
zetta doctor
```

### Installer options

Set these in front of the command, e.g. `curl -fsSL https://zetta3d.ai/install.sh | ZETTA_VERSION=0.2.0 sh`.

| Variable | Effect |
|---|---|
| `ZETTA_VERSION=0.2.0` | Install that version instead of the latest (prereleases like `0.3.0-beta.1` too) |
| `ZETTA_INSTALL_DIR=/opt/zetta/bin` | Install into this folder |
| `ZETTA_NO_MODIFY_PATH=1` | Don't touch shell rc files, the Windows `Path` or `$GITHUB_PATH` |
| `ZETTA_DOWNLOAD_BASE=https://…` | Download from somewhere other than the GitHub releases (mirrors, testing) |
| `NO_COLOR=1` | No colour |

On Windows, set them first: `$env:ZETTA_VERSION = '0.2.0'; irm https://zetta3d.ai/install.ps1 | iex`.

## Downloading a build yourself

Every [GitHub release](https://github.com/ig-shadow-walker/Zetta3D-CLI/releases/latest) has one file per platform: `zetta-darwin-arm64`, `zetta-darwin-x64`, `zetta-linux-x64`, `zetta-linux-arm64`, the `-musl` builds for Alpine, `zetta-windows-x64.exe`, and `-baseline` builds for x64 CPUs without AVX2. Download yours, `chmod +x` it, and put it on your `PATH`:

```bash
curl -fLo zetta https://github.com/ig-shadow-walker/Zetta3D-CLI/releases/latest/download/zetta-linux-x64
chmod +x zetta && mv zetta ~/.local/bin/
```

Check it against the release's `SHA256SUMS` (`shasum -a 256 -c SHA256SUMS --ignore-missing`). On macOS, a build downloaded with a browser is quarantined: clear that with `xattr -d com.apple.quarantine zetta`, or use the one-line installer, which avoids it.

## Updating

```bash
zetta upgrade              # latest release
zetta upgrade --check      # only check
zetta upgrade --to 0.2.0   # a specific version (also to go back)
```

`zetta upgrade` downloads and verifies the new binary the same way the installer does, test-runs it, then swaps it in place. Re-running the installer does the same. The agent skill updates itself the next time the new version runs.

**Knowing when there's a new version:**
- **At a terminal:** zetta checks for a new release at most once an hour (one small request). When there is one, it asks after your command: "zetta 0.2.0 is out (you have 0.1.0). Update now? [Y/n]". Enter updates it on the spot; anything else leaves it, and it asks again at most twice a day. With `--non-interactive` or `ZETTA_NON_INTERACTIVE=1` it only says how to update. It never checks when output is piped, in CI, or with `ZETTA_NO_UPDATE_CHECK=1`.
- **For agents:** the skill tells them to run `zetta upgrade --check` and tell you. The MCP server mentions a newer version in its instructions, and `zetta doctor` reports it.
- **Homebrew and npm installs** are upgraded with `brew upgrade zetta` or `npm install -g @zetta3d/cli@latest`. The notice and `zetta upgrade` say so.

## Uninstalling

macOS and Linux:

```bash
rm -rf ~/.zetta                          # the program
rm -rf ~/.config/zetta3d                 # settings and the token file (if one was used)
```

Then remove the `# zetta` line the installer added to your shell rc file.

Windows:
- Delete `%LOCALAPPDATA%\zetta` and `%APPDATA%\zetta3d`.
- Remove the zetta entry from your user `Path` (System Properties → Environment Variables).

Remove the agent skill too, before deleting the program: `zetta skill uninstall`. If you set up an MCP client, also remove the `zetta3d` entry from its config.

## In CI

```yaml
# GitHub Actions
- run: curl -fsSL https://zetta3d.ai/install.sh | sh     # also adds zetta to $GITHUB_PATH
- run: zetta asset list
  env:
    ZETTA_API_KEY: ${{ secrets.ZETTA_API_KEY }}   # make one with `zetta apikey create ci`
```

Without a terminal the CLI never prompts. A paid command needs `--yes` or `--max-credits` (or a `spend.maxPerCommand` setting), or it exits with code 5 without spending anything.

In a Dockerfile:

```dockerfile
RUN curl -fsSL https://zetta3d.ai/install.sh | ZETTA_INSTALL_DIR=/usr/local/bin ZETTA_NO_MODIFY_PATH=1 sh
```

## Platform notes

- **Supported:** macOS 13 or later (Apple Silicon and Intel); Linux on x64 and arm64, glibc or musl (kernel 5.1+ recommended); Windows 10 or later (x64; Windows on Arm runs the x64 build).
- **Alpine:** the musl build needs `libstdc++`. When the installer runs as root it adds it with `apk`; otherwise it tells you to run `apk add libstdc++`.
- **Old x64 CPUs** without AVX2 (some VMs and emulators) get the `-baseline` build automatically.
- **macOS Gatekeeper and Windows SmartScreen** don't block binaries installed with `curl` or `irm`. A binary downloaded with a browser may need to be allowed once until releases are signed.
- **Size:** about 30 MB to download, 65–90 MB on disk, because the JavaScript runtime is inside.

## Troubleshooting the install

| Symptom | Fix |
|---|---|
| `zetta: command not found` | Open a new terminal, or run `export PATH="$HOME/.zetta/bin:$PATH"` |
| `checksum mismatch` | The download was corrupted or tampered with; nothing was installed. Try again; if it persists, report it |
| `does not run on this system` | Your platform is unsupported, or on Alpine `libstdc++` is missing (`apk add libstdc++`) |
| `could not download` | Check your connection and any proxy (`HTTPS_PROXY` is honoured by curl and PowerShell) |
| Windows: `running scripts is disabled` | Use `powershell -ExecutionPolicy Bypass -c "irm https://zetta3d.ai/install.ps1 \| iex"` |

For hosting the installers and binaries, see [releasing.md](releasing.md) and [install/README.md](../install/README.md).
