# Building and releasing

Everything is built on your own machine, and a release is one command. There are no CI workflows.

## Building

```bash
bun run build                      # this computer → release/macos-arm64/zetta
bun run build windows              # release/windows-x64/zetta.exe
bun run build macos windows        # several at once
bun run build all                  # what a release ships: macOS, Linux x64, Windows x64
bun run build --list               # every target and where it is built
```

The binaries land in `release/`, one folder per platform:

```
release/
  macos/zetta              every Mac: the Apple Silicon and Intel builds in one universal file
  linux-x64/zetta          Linux x64 (glibc)
  windows-x64/zetta.exe    Windows x64 (Windows on Arm runs it too)
  SHA256SUMS               a checksum for every binary in release/
```

Building one platform replaces only that platform's folder. `release/` and `dist/` are ignored by git, so the binaries (65–90 MB each) never end up in a commit.

| Target | Builds |
|---|---|
| `all` | what a release ships: `macos`, `linux-x64` and `windows` |
| `macos` | both Mac builds, merged into one universal file (`zetta-macos`); `macos-arm64` or `macos-x64` for one |
| `linux-x64` | Linux x64 (glibc) |
| `windows` | `windows-x64` |
| `current` | this computer (the default) |
| not released | `linux-arm64`, `alpine` (musl) and `…-baseline` (x64 CPUs without AVX2) still build, for local use |

How builds work:
- **Cross-compiling:** every target builds from any machine. Bun downloads each target's runtime once.
- **macOS builds:** build them on a Mac. Merging the Apple Silicon and Intel builds into one file needs `lipo`, which only macOS has; the build then checks both halves run (the Intel half through Rosetta, when it is installed).
- **Test run:** this computer's binary is run with `--version` after the build. `--skip-smoke` skips that.
- **Version:** `--version 1.2.3` stamps another version in; the default comes from `packages/cli/package.json`.
- **Release files:** the build also writes `dist/v<version>/` (`zetta-macos`, `zetta-linux-x64`, `zetta-windows-x64.exe` and `SHA256SUMS`) and `dist/latest.json`. Those are what a release publishes.

## One-time setup

1. **The vendor-name list.** Every release checks the sources, the bundled code and the binaries for vendor names. Point the release at the list, which is kept outside this repository:

   ```bash
   export ZETTA_VENDOR_WORDS_FILE=/path/to/vendor-words.ts   # never commit it
   ```

2. **A GitHub token** that can publish releases on the repository. Either:
   - sign in with the GitHub CLI: `brew install gh && gh auth login` (the release script uses its token), or
   - create a fine-grained token at [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new): only this repository, permission **Contents: Read and write**. Put it in your shell profile as `GITHUB_TOKEN`.

   Pushing the release commit and tag uses your normal git sign-in.

3. **Nothing else.** People install straight from the newest GitHub release, so there is no download host to set up:

   ```bash
   curl -fsSL https://github.com/ig-shadow-walker/Zetta3D-CLI/releases/latest/download/install.sh | sh        # macOS, Linux
   irm https://github.com/ig-shadow-walker/Zetta3D-CLI/releases/latest/download/install.ps1 | iex             # Windows
   ```

## Cutting a release

```bash
bun run release                # next patch version: 0.1.0 → 0.1.1
bun run release minor          # 0.1.0 → 0.2.0; or major, or an exact version like 0.2.0
bun run release --dry-run      # run the checks before it starts; change nothing
```

It asks once, then does everything, stopping at the first failure:

1. **Checks before it starts:**
   - the GitHub token can publish to the repository;
   - you're on the default branch (`main`), with no uncommitted changes, and not behind `origin`;
   - the new tag doesn't exist yet;
   - the new version is newer than the published one (otherwise installed copies would never be offered it).
2. **Sets the version** in `packages/cli/package.json`, and regenerates the docs and the agent skill.
3. **Checks and builds everything:** typecheck, tests and lint; the three builds (macOS as one universal file, Linux x64, Windows x64); the vendor-name scan; and the real installer, end to end. If anything fails, the version change is undone.
4. **Commits** "Release v0.2.0", **tags** `v0.2.0`, and **pushes** both.
5. **Publishes the GitHub release.** It creates a draft, uploads its 7 files (the three builds, `SHA256SUMS`, `latest.json`, and the two installers), then publishes it. The release page gets the install lines and the commits since the last release.
6. **Reads it back** the way installs see it: the latest release is the new version, both installers point at it, and every file is there.

**Who hears about it:**
- **New installs** get the new version straight away.
- **People at a terminal:** installed copies look for a new release at most once an hour. They then ask "zetta 0.2.0 is out (you have 0.1.0). Update now? [Y/n]" after a command, and update on Enter.
- **Agents:**
  - the skill tells them to run `zetta upgrade --check` at the start of a session, and to tell the user;
  - the MCP server mentions a newer version in its instructions;
  - `zetta doctor` reports it.

**Prereleases** (`bun run release 0.3.0-beta.1`) are published as GitHub prereleases. They never become "latest", so nobody is offered one. Install one with `ZETTA_VERSION=0.3.0-beta.1`, or `zetta upgrade --to 0.3.0-beta.1`.

**If the upload fails** (a dropped connection, say), the tag is already pushed. Run `bun run release --publish` to finish: it uploads what is missing and publishes.

**Check a live release** at any time: `bun run release --verify` (or `--verify 0.2.0`).

**Before a big release,** try the new version against the real API with a paid account: `ZETTA_API_KEY=… bun run smoke:live`.

## Signing (optional)

Signing changes the bytes, so sign between building and publishing:

```bash
V=0.2.0
# 1. Set the version, then commit, tag and push it yourself.
# 2. Build every platform:
bun run build --release --version $V
# 3. macOS: sign the universal file (both halves) with the hardened runtime, then notarise.
f=dist/v$V/zetta-macos
codesign --force --timestamp --options runtime --entitlements scripts/macos-entitlements.plist \
  --sign "Developer ID Application: <Company> (<TEAMID>)" "$f"
ditto -c -k --keepParent "$f" "$f.zip"
xcrun notarytool submit "$f.zip" --keychain-profile zetta-notary --wait && rm "$f.zip"
# 4. Windows:
for f in dist/v$V/zetta-windows-x64.exe; do
  jsign --storetype PKCS12 --keystore cert.pfx --storepass "$PFX_PASSWORD" \
    --tsaurl http://timestamp.digicert.com --name "Zetta 3D CLI" --url https://zetta3d.ai "$f"
done
# 5. New checksums, then publish:
bun run scripts/build-binaries.ts --version $V --rehash
bun run release --publish
```

Some notes on signing:
- **Notarisation profile:** create `zetta-notary` once with `xcrun notarytool store-credentials`.
- **Stapling:** a bare executable can't be stapled. Gatekeeper checks the notarisation online.
- **Unsigned builds** are fine for the one-line installers, because neither `curl` nor `irm` marks the download as quarantined.

## npm and Homebrew (optional)

```bash
bun run package:channels                           # dist/npm/ and dist/homebrew/zetta.rb
for d in dist/npm/cli-*/ dist/npm/cli/; do (cd "$d" && npm publish --access public); done
cp dist/homebrew/zetta.rb ../homebrew-tap/Formula/zetta.rb    # then commit and push the tap
```

Copies installed this way are upgraded with `brew upgrade zetta` or `npm install -g @zetta3d/cli@latest`. Their update notice says so, and `zetta upgrade` points there instead of replacing a file the package manager owns.

## Rolling back

A published release never changes. To take one back, publish a newer version with the fix (`bun run release`), or mark the bad release as a draft on GitHub: "latest" then moves back to the previous release, and new installs get that one. Users can also pin a version: `zetta upgrade --to 0.1.0`, or `ZETTA_VERSION=0.1.0` with the installer.
