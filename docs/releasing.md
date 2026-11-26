# Building and releasing

Everything is built on your own machine. There are no GitHub workflows.

## Building

```bash
bun run build                      # this machine → release/macos-arm64/zetta
bun run build windows              # release/windows-x64/zetta.exe
bun run build macos linux-arm64    # several at once
bun run build all                  # every release target
bun run build --list               # every target, where it's built and where it uploads
bun run build all --upload         # build, then upload to the storage bucket (below)
```

The binaries land in `release/`, one folder per platform:

```
release/
  macos-arm64/zetta        macos-x64/zetta
  linux-x64/zetta          linux-arm64/zetta
  linux-x64-musl/zetta     linux-arm64-musl/zetta      (Alpine and other musl systems)
  windows-x64/zetta.exe
  *-baseline/…             (x64 CPUs without AVX2, when built)
  SHA256SUMS               (a checksum for every binary in release/)
```

Building one platform replaces only that platform's folder. `release/` is ignored by git, so the binaries (65–90 MB each) never end up in a commit.

| Target | Builds |
|---|---|
| `macos` | `darwin-arm64` and `darwin-x64`; `macos-arm64` or `macos-x64` for one |
| `linux` | `linux-x64` and `linux-arm64` (glibc); `linux-x64` or `linux-arm64` for one |
| `alpine` | `linux-x64-musl` and `linux-arm64-musl`; also `linux-arm64-musl` and so on |
| `windows` | `windows-x64` |
| `all` | the 7 release targets |
| `current` | this machine (the default) |
| `…-baseline` | x64 builds for CPUs without AVX2, e.g. `linux-x64-baseline`. `--baseline` adds one for every x64 target |

How builds work:
- **Cross-compiling:** every target builds from any machine. Bun downloads each target's runtime once.
- **macOS builds:** build them on a Mac. Elsewhere they keep a broken code signature and won't start.
- **Test run:** this machine's binary is run with `--version` after the build. `--skip-smoke` skips that.
- **Version:** `--version 1.2.3` stamps another version in; the default comes from `packages/cli/package.json`. Check a binary with `release/<platform>/zetta --version`.
- **Download-host files:** the build also writes `dist/v<version>/` (the binaries under their full names, `.gz` copies, `SHA256SUMS`) and `dist/latest.json`. That is the layout the installers and `zetta upgrade` download from, and what you upload when you publish.

## How users get zetta

```
curl -fsSL https://zetta3d.ai/install.sh | sh        # macOS, Linux
irm https://zetta3d.ai/install.ps1 | iex             # Windows
```

How that one line works:
1. **The website:** zetta3d.ai answers `/install.sh` and `/install.ps1` with a redirect to the installers in your bucket.
2. **The installer:** picks the build for that computer, checks it and installs it. It installs the agent skill, then starts the browser sign-in, so the CLI is connected to the user's account straight away.
3. **Updates:** from then on, `zetta` checks the bucket for new versions and offers `zetta upgrade`.

Releases live in one folder of the Zetta storage bucket (DigitalOcean Spaces), by default `zcli/`:

```
zcli/latest.json                      which version installs and upgrades get (upload this last)
zcli/v<version>/…                     every build, its .gz copy and SHA256SUMS
zcli/install.sh  zcli/install.ps1     the installers
zcli/macosx/  zcli/windows/  zcli/linux/   the newest build per OS, for direct download links (optional)
```

## One-time setup (owner)

1. **Your download address:** the bucket's address plus the folder. Find it in DigitalOcean: the bucket → Settings → Origin endpoint, or CDN endpoint if the CDN is on. It looks like `https://<bucket>.<region>.digitaloceanspaces.com/zcli`. Put it, and the vendor-name list, in your shell profile:

   ```bash
   export ZETTA_PUBLIC_BASE=https://<bucket>.<region>.digitaloceanspaces.com/zcli
   export ZETTA_VENDOR_WORDS_FILE=/path/to/vendor-words.ts   # never commit it
   ```

   `bun run release --base <address>` works too. No access keys are needed: you upload the files yourself.
2. **The website:** set `CLI_DOWNLOAD_BASE` on the website's web service to the same address. Then `https://zetta3d.ai/install.sh` and `/install.ps1` redirect there, and the one-line install works.
3. **Optional: the bucket's CDN.** Turn it on in the bucket's settings, with a short cache time (for example 5 minutes), and use the CDN endpoint as the address.

Each build records the download address, and checks it for new versions. If you ever move the releases (say, to `https://downloads.zetta3d.ai/zcli`), keep the old address serving the same files: copies installed before the move keep checking there.

## Cutting a release

```bash
bun run release patch          # 0.1.0 → 0.1.1; or minor, major, or an exact version like 0.2.0
bun run release minor --dry-run   # show the plan; change nothing
```

`bun run release` builds and checks everything, then gets the files ready for you to upload. It stops at the first failure:

1. **Checks the address:** works out the download address. Then it checks the new version is newer than the one online; otherwise installed copies would never be offered it.
2. **Asks first:** shows the version and the address. `--yes` skips the question.
3. **Version:** sets `packages/cli/package.json`, and regenerates the docs and the agent skill.
4. **Builds and checks:** the tests, typecheck and lint, every platform plus the baseline builds, the vendor-name scan, and the real installer end to end. Each binary records the download address.
5. **Stages the files:** puts every file to upload in `release/upload/`, in the bucket's layout, with the installers pointing at the address. It prints the steps, and writes them to `release/upload/README.md`.

Then upload by hand, in the DigitalOcean console (the bucket → Upload). Make every file **Public**:
1. **First:** the folder `release/upload/1-upload-first/zcli`. Drag it onto the bucket's top level; it merges with what is there. It holds the version folder, the installers and the per-OS copies. Then set `zcli/install.ps1`'s Content-Type to `text/plain` (the file's … menu), because Windows' `irm … | iex` needs text.
2. **Last:** `release/upload/2-upload-last/zcli/latest.json`, into `zcli/`. This is the switch: once it's there, installs get the new version and installed copies are told about it.
3. **Check it:** if the bucket has a CDN, purge `zcli/latest.json`, `zcli/install.sh` and `zcli/install.ps1`. Then run:

   ```bash
   bun run release --verify
   ```

   It reads the release back the way installs will see it. It checks that `latest.json` names the new version, that both installers point at the address, that `install.ps1` is served as text, and that every file of the version is there. Fix any ✗ line and run it again.

**Who hears about it:**
- **People at a terminal:** installed copies check for a new release at most once an hour, and say "zetta 0.2.0 is out (you have 0.1.0). Update with: zetta upgrade".
- **Agents:**
  - the skill tells them to run `zetta upgrade --check` at the start of a session and tell the user;
  - the MCP server mentions a newer version in its instructions;
  - `zetta doctor` reports it.

**Prereleases** (`bun run release 0.3.0-beta.1`): only the version folder is staged. `latest.json` doesn't move, so nobody is offered it; install one with `ZETTA_VERSION=0.3.0-beta.1`.

**Before a big release,** try the new version against the real API with a paid account: `ZETTA_API_KEY=… bun run smoke:live`.

**Uploading from the command line instead** (optional): `bun run build --release --upload` uploads everything itself through the Spaces S3 API. It needs a Spaces access key in `SPACES_KEY`, `SPACES_SECRET`, `SPACES_BUCKET` and `SPACES_ENDPOINT` (and optionally `SPACES_FOLDER` and `SPACES_CDN_ENDPOINT`).

### Signing (optional)

Signing changes the bytes, so sign between building and uploading. Build with the download address, so the builds still record it:

```bash
V=0.2.0
bun run build --release --version $V --download-base <download address>
# macOS: sign with the hardened runtime, then notarise
for f in dist/v$V/zetta-darwin-*; do
  case "$f" in *.gz) continue ;; esac
  codesign --force --timestamp --options runtime --entitlements scripts/macos-entitlements.plist \
    --sign "Developer ID Application: <Company> (<TEAMID>)" "$f"
  ditto -c -k --keepParent "$f" "$f.zip"
  xcrun notarytool submit "$f.zip" --keychain-profile zetta-notary --wait && rm "$f.zip"
done
# Windows
for f in dist/v$V/zetta-windows-*.exe; do
  jsign --storetype PKCS12 --keystore cert.pfx --storepass "$PFX_PASSWORD" \
    --tsaurl http://timestamp.digicert.com --name "Zetta 3D CLI" --url https://zetta3d.ai "$f"
done
bun run scripts/build-binaries.ts --version $V --rehash    # new SHA256SUMS, .gz copies and latest.json
bun run release $V --no-build                               # stage the signed builds, then upload as above
```

Some notes on signing:
- **Notarisation profile:** create `zetta-notary` once with `xcrun notarytool store-credentials`.
- **Stapling:** a bare executable can't be stapled. Gatekeeper checks the notarisation online.

### npm and Homebrew (optional)

```bash
bun run package:channels                           # dist/npm/ and dist/homebrew/zetta.rb
for d in dist/npm/cli-*/ dist/npm/cli/; do (cd "$d" && npm publish --access public); done
cp dist/homebrew/zetta.rb ../homebrew-tap/Formula/zetta.rb    # then commit and push the tap
```

Copies installed this way are upgraded with `brew upgrade zetta` or `npm install -g @zetta3d/cli@latest`. Their update notice says so, and `zetta upgrade` points there instead of replacing a file the package manager owns.

## The release files

What `dist/` holds after a full build, and what `--upload` puts in `zcli/v<version>/` and `zcli/latest.json`:

```
v0.2.0/
  zetta-darwin-arm64            zetta-darwin-arm64.gz
  zetta-darwin-x64              zetta-darwin-x64.gz
  zetta-linux-x64               zetta-linux-x64.gz
  zetta-linux-arm64             …
  zetta-linux-x64-musl          zetta-linux-arm64-musl
  zetta-windows-x64.exe         zetta-*-baseline[.exe]
  SHA256SUMS                    (every file above, `sha256sum -c` format)
latest.json                     (version, files, sizes, checksums, gzip copies)
```

How these files are used:
- **The installers** take the version from `latest.json` and the checksums from `SHA256SUMS`. They download the `.gz` copy and verify both the `.gz` and the unpacked binary.
- **`zetta upgrade`** does the same, then test-runs the new binary before swapping it in.
- **`dist/bundle/zetta.js`** is only for the vendor scan. Never upload it.

## Rolling back

Build the previous version again and upload it (`bun run build --release --upload --version 0.1.0` from that version's commit), or re-upload its `latest.json`. Version folders never change. Users can also pin a version: `zetta upgrade --to 0.1.0`, or `ZETTA_VERSION=0.1.0` with the installer.
