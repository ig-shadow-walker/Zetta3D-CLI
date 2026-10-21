# Installing zetta

One command, nothing else installed first:

```sh
curl -fsSL https://zetta3d.ai/install.sh | sh        # macOS, Linux (wget -qO- ... | sh works too)
```

```powershell
irm https://zetta3d.ai/install.ps1 | iex             # Windows (PowerShell 5.1 or 7+)
```

The installer detects the OS and CPU, downloads the matching self-contained binary from the download host, checks its SHA-256, test-runs it, and moves it into place atomically. It needs no sudo or admin rights. It then adds the folder to `PATH` and prints `Next: zetta auth login`. Running it again upgrades in place. `zetta upgrade` does the same from inside the CLI.

| | macOS / Linux | Windows |
|---|---|---|
| Binary | `~/.zetta/bin/zetta` | `%LOCALAPPDATA%\zetta\bin\zetta.exe` |
| PATH | appends one line to `~/.zshrc`, `~/.bashrc` (+ `~/.bash_profile` on macOS), `~/.config/fish/config.fish` or `~/.profile`, picked from `$SHELL`; never twice | user `Path` in the registry (`%VAR%` entries are kept), plus the current window |
| CI | also appends to `$GITHUB_PATH` when set | same |

Uninstall: delete `~/.zetta` (Windows: `%LOCALAPPDATA%\zetta`) and the `# zetta` line from your shell rc file (Windows: the entry in the user `Path`).

## Environment overrides

| Variable | Effect |
|---|---|
| `ZETTA_VERSION=1.2.3` | install this version instead of `latest.json`'s (a leading `v` is fine) |
| `ZETTA_INSTALL_DIR=/path` | install there instead of the default folder |
| `ZETTA_DOWNLOAD_BASE=https://…` | download host; default `https://downloads.zetta3d.ai/cli`. `zetta upgrade` reads it too |
| `ZETTA_NO_MODIFY_PATH=1` | leave shell rc files, the registry and `$GITHUB_PATH` alone |
| `NO_COLOR=1` | no colour. Colour and progress lines only appear when output is a terminal anyway |

How a build is chosen:
- **CPU and OS:** `darwin|linux|windows` × `x64|arm64`.
- **Apple Silicon:** gets arm64 even from a Rosetta shell.
- **Linux libc:** Alpine and other musl systems get the `-musl` build. Those builds need `libstdc++`. When the installer runs as root with `apk`, it installs `libstdc++` itself and says so. Otherwise it stops and prints the `apk add libstdc++` command to run.
- **Old x64 CPUs:** an x64 CPU without AVX2 gets the `-baseline` build when the release has one; otherwise it gets a clear error.
- **Windows on Arm:** gets the x64 build, which runs under emulation, unless the release has a native `windows-arm64` build.
- **Unsupported systems:** anything else (FreeBSD, 32-bit, Git Bash on Windows) gets a clear message.

## Handover checklist for the owner

### 1. Download host: `https://downloads.zetta3d.ai/cli/`

Serve these files over HTTPS. Upload them in the order given in [docs/releasing.md](../docs/releasing.md): the version folder, the installers, then `latest.json` last.

| Path under the base | What | Content-Type | Cache-Control |
|---|---|---|---|
| `v<version>/zetta-darwin-arm64` | binary | `application/octet-stream` | `public, max-age=31536000, immutable` |
| `v<version>/zetta-darwin-x64` | binary | 〃 | 〃 |
| `v<version>/zetta-linux-x64`, `zetta-linux-arm64` | glibc binaries | 〃 | 〃 |
| `v<version>/zetta-linux-x64-musl`, `zetta-linux-arm64-musl` | musl (Alpine) binaries | 〃 | 〃 |
| `v<version>/zetta-windows-x64.exe` | binary | 〃 | 〃 |
| `v<version>/zetta-*-baseline[.exe]` | x64 builds for CPUs without AVX2 (release builds include them) | 〃 | 〃 |
| `v<version>/<binary>.gz` | gzip copy of each binary (about 40% of the size); the installers and `zetta upgrade` prefer it | `application/octet-stream` (no `Content-Encoding`) | 〃 |
| `v<version>/SHA256SUMS` | `<sha256>  <file>` per line (`sha256sum -c` format) | `text/plain; charset=utf-8` | immutable |
| `latest.json` | pointer to the newest **stable** release (format below) | `application/json` | short, e.g. `public, max-age=60` |
| `install.sh`, `install.ps1` | copies of this folder's scripts | `text/plain; charset=utf-8` | short, e.g. `max-age=300` |

Rules:
- A `v<version>/` folder never changes after it is published. Only `latest.json` moves, and it is uploaded last.
- Prereleases (`v1.2.0-beta.1`) get their folder but do not move `latest.json`. Install one with `ZETTA_VERSION=1.2.0-beta.1`.
- Each binary is 65–90 MB uncompressed (the Bun runtime is inside); the `.gz` copies the installers download are 27–41 MB. Serve the `.gz` files as plain bytes: the installers unpack them themselves, so the host must not add `Content-Encoding: gzip`.

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

Keys are `<os>-<arch>[-musl][-baseline]`. `gz` is optional; without it clients download the plain binary. Both the `.gz` and the unpacked binary are checked against `SHA256SUMS`. The shell and PowerShell installers read only `version` from this file and take checksums from `v<version>/SHA256SUMS`, so a pinned `ZETTA_VERSION` works the same way.

### 2. `zetta3d.ai/install.sh` and `zetta3d.ai/install.ps1`

- `https://zetta3d.ai/install.sh` must serve this folder's `install.sh`. `https://zetta3d.ai/install.ps1` must serve `install.ps1`.
- Either serve them directly (for example, as static files of the web app), or proxy or redirect (301/302) to `https://downloads.zetta3d.ai/cli/install.sh` and `/install.ps1`. `curl -L` and `irm` both follow redirects.
- Serve both as **`text/plain; charset=utf-8`**. With a binary content type, `irm … | iex` gets bytes instead of a script and fails.
- Serve them over HTTPS only, and never behind a login, cookie wall or bot check, because agents and CI fetch them too.

### 3. Building and publishing a release

Releases are built and published from your own machine; see [docs/releasing.md](../docs/releasing.md):
- `bun run build --release` runs the checks, builds every target, runs the vendor scan and tests the installer against the result;
- signing is optional, and the commands are in that guide;
- publishing uploads to the download host and, optionally, npm and Homebrew.

Until signing is set up, release binaries are unsigned, apart from the ad-hoc signature the macOS builds get. That is fine for `curl`/`irm` installs, because neither marks the download as quarantined. Browser downloads would hit Gatekeeper and SmartScreen.

## Developing

```sh
bun run build                            # this machine only -> dist/v<version>/, dist/latest.json, dist/bundle/zetta.js
bun run build windows alpine             # the targets you name; `bun run build all` for every one
bun run build all --baseline --version 1.2.3
bun run scripts/test-install.ts          # real installer against a local 127.0.0.1 host, temp HOME
bun run scripts/test-install.ts --from-dist
ZETTA_VENDOR_WORDS_FILE=/path/to/list bun run scan:vendor --require-list --require-bundle
```

- **Bundle:** `dist/bundle/zetta.js` is the minified JavaScript the binaries embed. It exists only for the vendor scan and is never published.
- **Runtime matches:** the Bun runtime inside each binary already contains a few of the list's substrings (in its MIME table and compression dictionary). The scanner ignores matches that also appear in an empty program compiled for the same target, so it reports only what our code adds.
