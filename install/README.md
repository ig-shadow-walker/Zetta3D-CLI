# Installing zetta

One command, nothing else installed first:

```sh
curl -fsSL https://zetta3d.ai/install.sh | sh        # macOS, Linux (wget -qO- ... | sh works too)
```

```powershell
irm https://zetta3d.ai/install.ps1 | iex             # Windows (PowerShell 5.1 or 7+)
```

The installer detects the OS and CPU, downloads the matching self-contained binary from the newest GitHub release, checks its SHA-256, test-runs it, and moves it into place atomically. It needs no sudo or admin rights. It then adds the folder to `PATH`, installs the agent skill and, in a terminal, starts the browser sign-in (`zetta auth login`). Running it again upgrades in place. `zetta upgrade` does the same from inside the CLI.

| | macOS / Linux | Windows |
|---|---|---|
| Binary | `~/.zetta/bin/zetta` | `%LOCALAPPDATA%\zetta\bin\zetta.exe` |
| PATH | appends one line to `~/.zshrc`, `~/.bashrc` (+ `~/.bash_profile` on macOS), `~/.config/fish/config.fish` or `~/.profile`, picked from `$SHELL`; never twice | user `Path` in the registry (`%VAR%` entries are kept), plus the current window |
| CI | also appends to `$GITHUB_PATH` when set | same |

Uninstall: delete `~/.zetta` (Windows: `%LOCALAPPDATA%\zetta`) and the `# zetta` line from your shell rc file (Windows: the entry in the user `Path`).

## Environment overrides

| Variable | Effect |
|---|---|
| `ZETTA_VERSION=1.2.3` | install this version instead of the latest (a leading `v` is fine) |
| `ZETTA_INSTALL_DIR=/path` | install there instead of the default folder |
| `ZETTA_DOWNLOAD_BASE=https://…` | where releases live; default `https://github.com/ig-shadow-walker/Zetta3D-CLI/releases`. `zetta upgrade` reads it too |
| `ZETTA_NO_MODIFY_PATH=1` | leave shell rc files, the registry and `$GITHUB_PATH` alone |
| `ZETTA_NO_LOGIN=1` | don't start the browser sign-in after installing (otherwise started when a person is at the terminal) |
| `ZETTA_NO_SKILL=1` | don't install the agent skill for Claude Code, Codex and Cursor (otherwise installed for each one found) |
| `NO_COLOR=1` | no colour. Colour and progress lines only appear when output is a terminal anyway |

How a build is chosen:
- **CPU and OS:** `darwin|linux|windows` × `x64|arm64`.
- **Apple Silicon:** gets arm64 even from a Rosetta shell.
- **Linux libc:** Alpine and other musl systems get the `-musl` build. Those builds need `libstdc++`. When the installer runs as root with `apk`, it installs `libstdc++` itself and says so. Otherwise it stops and prints the `apk add libstdc++` command to run.
- **Old x64 CPUs:** an x64 CPU without AVX2 gets the `-baseline` build when the release has one; otherwise it gets a clear error.
- **Windows on Arm:** gets the x64 build, which runs under emulation, unless the release has a native `windows-arm64` build.
- **Unsupported systems:** anything else (FreeBSD, 32-bit, Git Bash on Windows) gets a clear message.

## How releases are hosted

### 1. GitHub releases

Every release is a GitHub release of [ig-shadow-walker/Zetta3D-CLI](https://github.com/ig-shadow-walker/Zetta3D-CLI/releases), tagged `v<version>`. `bun run release` creates it (see [docs/releasing.md](../docs/releasing.md)). Its files:

| File | What | Content-Type |
|---|---|---|
| `zetta-darwin-arm64`, `zetta-darwin-x64` | macOS builds | `application/octet-stream` |
| `zetta-linux-x64`, `zetta-linux-arm64` | glibc Linux builds | 〃 |
| `zetta-linux-x64-musl`, `zetta-linux-arm64-musl` | musl (Alpine) builds | 〃 |
| `zetta-windows-x64.exe` | Windows build | 〃 |
| `zetta-*-baseline[.exe]` | x64 builds for CPUs without AVX2 | 〃 |
| `<build>.gz` | a gzip copy of each build (about 40% of the size); the installers and `zetta upgrade` prefer it | `application/gzip` |
| `SHA256SUMS` | `<sha256>  <file>` per line (`sha256sum -c` format) | `text/plain; charset=utf-8` |
| `latest.json` | the version and the checksum of every build (format below) | `application/json` |
| `install.sh`, `install.ps1` | this folder's installers | `text/plain; charset=utf-8` |

Where clients read them:
- **The newest stable release:** `https://github.com/ig-shadow-walker/Zetta3D-CLI/releases/latest/download/<file>`. The installers and installed copies read `latest.json` from there.
- **One version:** `https://github.com/ig-shadow-walker/Zetta3D-CLI/releases/download/v<version>/<file>`. Pinned installs (`ZETTA_VERSION`) and `zetta upgrade --to` read from there.

GitHub answers each download with a redirect to its file host; `curl`, `wget`, PowerShell and `zetta upgrade` all follow it. Release downloads are not subject to GitHub's API rate limits.

Rules:
- A published version never changes. Only "latest" moves, when a newer stable release is published.
- Prereleases (`v1.2.0-beta.1`) are published but never become "latest". Install one with `ZETTA_VERSION=1.2.0-beta.1`.
- Each build is 65–90 MB (the runtime is inside); the `.gz` copies the installers download are 27–41 MB. The installers unpack them themselves.

`latest.json` (shared by the installers and `zetta upgrade`; produced by `scripts/build-binaries.ts`):

```json
{
  "version": "0.2.0",
  "released": "2026-10-21T09:00:00.000Z",
  "files": {
    "darwin-arm64": { "name": "zetta-darwin-arm64", "sha256": "…64 hex…", "size": 67857522,
                      "gz": { "name": "zetta-darwin-arm64.gz", "sha256": "…", "size": 28265511 } },
    "linux-x64-musl": { "name": "zetta-linux-x64-musl", "sha256": "…", "size": 75286064 },
    "windows-x64": { "name": "zetta-windows-x64.exe", "sha256": "…", "size": 86087168 }
  }
}
```

Keys are `<os>-<arch>[-musl][-baseline]`. `gz` is optional; without it clients download the plain build. Both the `.gz` and the unpacked build are checked against `SHA256SUMS`. The shell and PowerShell installers read only `version` from this file and take checksums from `SHA256SUMS`, so a pinned `ZETTA_VERSION` works the same way.

Any other `ZETTA_DOWNLOAD_BASE` (one that doesn't end in `/releases`) is read as a plain folder: `<base>/latest.json` and `<base>/v<version>/<file>`. That is for mirrors and local tests.

### 2. `zetta3d.ai/install.sh` and `zetta3d.ai/install.ps1`

- The website answers both with a `302` to the newest release's copy: `https://github.com/ig-shadow-walker/Zetta3D-CLI/releases/latest/download/install.sh` (and `install.ps1`). Its `CLI_DOWNLOAD_BASE` setting can send them elsewhere.
- The release uploads both as `text/plain`: with a binary content type, `irm … | iex` could get bytes instead of a script.
- Without the website, the same lines work straight from GitHub: `curl -fsSL https://github.com/ig-shadow-walker/Zetta3D-CLI/releases/latest/download/install.sh | sh`.

### 3. Building and publishing a release

`bun run release` does it all from your own machine: version, checks, every build, the vendor scan, the installer test, the git tag, and the GitHub release. See [docs/releasing.md](../docs/releasing.md).

Until signing is set up, release builds are unsigned, apart from the ad-hoc signature the macOS builds get. That is fine for the one-line installers, because neither `curl` nor `irm` marks the download as quarantined. A build downloaded with a browser hits Gatekeeper (`xattr -d com.apple.quarantine zetta` clears it) or SmartScreen.

## Developing

```sh
bun run build                            # this machine -> release/<platform>/zetta, plus dist/v<version>/, dist/latest.json, dist/bundle/zetta.js
bun run build windows alpine             # the targets you name; `bun run build all` for every one
bun run build all --baseline --version 1.2.3
bun run scripts/test-install.ts          # real installer against a local stand-in for GitHub releases, temp HOME
bun run scripts/test-install.ts --from-dist
ZETTA_VENDOR_WORDS_FILE=/path/to/list bun run scan:vendor --require-list --require-bundle
```

- **Bundle:** `dist/bundle/zetta.js` is the minified JavaScript the binaries embed. It exists only for the vendor scan and is never published.
- **Runtime matches:** the Bun runtime inside each binary already contains a few of the list's substrings (in its MIME table and compression dictionary). The scanner ignores matches that also appear in an empty program compiled for the same target, so it reports only what our code adds.
