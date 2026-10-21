# Building and releasing

Everything is built on your own machine. There are no GitHub workflows.

## Building

```bash
bun run build                      # this machine → dist/v<version>/zetta-<os>-<arch>
bun run build windows              # zetta-windows-x64.exe
bun run build macos linux-arm64    # several at once
bun run build all                  # every release target
bun run build --list               # every target and its file name
```

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
- **Output:** each build replaces `dist/v<version>/` and also writes `SHA256SUMS`, the `.gz` copies and `dist/latest.json`, the files the installers and `zetta upgrade` read. `--version 1.2.3` stamps another version in; the default comes from `packages/cli/package.json`.

## One-time setup for releases (owner)

1. **Vendor word list.** The release build checks that no model vendor's name is in the code or the binaries. Keep the list in a file outside this repository, and put this in your shell profile:

   ```bash
   export ZETTA_VENDOR_WORDS_FILE=/path/to/vendor-words.ts
   ```

   `ZETTA_VENDOR_WORDS` (comma-separated) works too. Never commit the list.
2. **Download host:** serve `https://downloads.zetta3d.ai/cli/` from S3-compatible storage (for example Cloudflare R2), and make `https://zetta3d.ai/install.sh` and `install.ps1` serve the installers as `text/plain`. The layout, headers and caching are in [install/README.md](../install/README.md). Install the AWS CLI (`brew install awscli`) and give it the bucket's keys.
3. **Optional channels:** for npm, create the `@zetta3d` organisation and run `npm login`. For Homebrew, create the tap repository, e.g. `zetta3d/homebrew-tap`.
4. **Optional signing:** a Developer ID Application certificate in your login keychain for macOS, and a code-signing certificate for Windows (signed with `jsign`: `brew install jsign`). Unsigned builds are fine for `curl` and `irm` installs; browser downloads would hit Gatekeeper and SmartScreen.

## Cutting a release

**1. Build and check.**

```bash
# bump packages/cli/package.json → "version": "0.2.0"
bun run docs:commands          # keep docs/COMMANDS.md and skill/SKILL.md in step
bun run build --release
```

`--release` does what the release pipeline used to do, stopping at the first failure:
- runs `bun run check` (typecheck, tests, lint);
- builds every target plus the baseline builds;
- runs the vendor-name scan over the sources, the bundled JavaScript and every binary;
- runs the real installer end to end against the files it just built.

Optionally, test against the real API: `ZETTA_TOKEN=… bun run smoke:live --bin dist/v0.2.0/zetta-darwin-arm64`.

**2. Sign (optional).** Signing changes the bytes, so recompute the checksums afterwards.

```bash
V=0.2.0
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
```

Some notes on signing:
- **Notarisation profile:** create `zetta-notary` once with `xcrun notarytool store-credentials`.
- **Stapling:** a bare executable can't be stapled. Gatekeeper checks the notarisation online.
- **Hardware or cloud certificates:** for example Azure Trusted Signing. These need other `jsign` `--storetype` options.

**3. Publish.**

```bash
V=0.2.0
git tag v$V && git push origin v$V

# GitHub release (gh CLI, or upload the same files on the website)
gh release create v$V dist/v$V/* dist/latest.json --title "zetta $V" --generate-notes

# Download host, in this order: the version folder, the installers, then latest.json last
B=s3://<bucket>/cli; E=(--endpoint-url https://<account-id>.r2.cloudflarestorage.com)   # E=() for AWS
aws s3 cp dist/v$V/ $B/v$V/ --recursive --exclude SHA256SUMS "${E[@]}" \
  --content-type application/octet-stream --cache-control "public, max-age=31536000, immutable"
aws s3 cp dist/v$V/SHA256SUMS $B/v$V/SHA256SUMS "${E[@]}" \
  --content-type "text/plain; charset=utf-8" --cache-control "public, max-age=31536000, immutable"
for f in install.sh install.ps1; do
  aws s3 cp install/$f $B/$f "${E[@]}" --content-type "text/plain; charset=utf-8" --cache-control "public, max-age=300"
done
aws s3 cp dist/latest.json $B/latest.json "${E[@]}" --content-type application/json --cache-control "public, max-age=60"

# npm and Homebrew (optional)
bun run package:channels                       # dist/npm/ and dist/homebrew/zetta.rb
for d in dist/npm/cli-*/ dist/npm/cli/; do (cd "$d" && npm publish --access public); done
cp dist/homebrew/zetta.rb ../homebrew-tap/Formula/zetta.rb    # then commit and push the tap
```

Some notes on publishing:
- **R2 checksum errors:** if R2 or another S3-compatible store rejects the uploads with checksum errors, set `AWS_REQUEST_CHECKSUM_CALCULATION=when_required` and `AWS_RESPONSE_CHECKSUM_VALIDATION=when_required`.
- **CDN:** if a CDN sits in front of the bucket, purge `latest.json` after uploading it.

**Prereleases** (`0.3.0-beta.1`):
- upload the version folder but **not** `latest.json`;
- publish to npm with `--tag next`, and leave the Homebrew formula alone;
- install one with `ZETTA_VERSION=0.3.0-beta.1`.

## What's in a release

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

Point `latest.json` at the previous version (re-upload the old one). Version folders never change. Users can also pin a version: `zetta upgrade --to 0.1.0`, or `ZETTA_VERSION=0.1.0` with the installer.
