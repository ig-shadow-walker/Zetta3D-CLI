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

## Publishing to the storage bucket

`--upload` publishes the builds to the Zetta storage bucket (DigitalOcean Spaces) under `zcli/`, which `https://downloads.zetta3d.ai/zcli` serves:

```
zcli/macosx/zetta-darwin-arm64        zcli/macosx/zetta-darwin-x64          the newest build, one folder per OS,
zcli/windows/zetta-windows-x64.exe                                          each with a .sha256 beside it
zcli/linux/zetta-linux-x64            zcli/linux/zetta-linux-arm64
zcli/linux/zetta-linux-x64-musl       zcli/linux/zetta-linux-arm64-musl
zcli/v<version>/…                     every binary, its .gz copy and SHA256SUMS
zcli/install.sh  zcli/install.ps1     the installers
zcli/latest.json                      what the installers and `zetta upgrade` install
```

```bash
bun run build --release --upload           # the normal release: upload only after every check passed
bun run build all --upload                 # every platform, without the release checks
bun run build windows --upload             # one platform: updates zcli/windows/ only
bun run build --collect --upload           # upload what's in dist/ again (after signing, or a failed upload)
```

What gets uploaded:
- **Public files:** every file is public, because the one-line installers and `zetta upgrade` download them without keys. Each upload replaces what was there.
- **Upload order:** the version folder goes first, then the per-OS copies, then the installers, and `latest.json` last. Installs never see a `latest.json` pointing at files that aren't there yet.
- **Partial builds:** when not every platform is built (`bun run build windows --upload`), only that OS folder is updated. The installers and `latest.json` keep the release they had, so Mac and Linux installs never break.
- **Prereleases** (`0.3.0-beta.1`): only `zcli/v<version>/` is uploaded. Install one with `ZETTA_VERSION=0.3.0-beta.1`.

The bucket and its keys come from the environment, under the names the backend uses. Set them in your shell, or in a file you `source` that is never committed. The values are never printed.

| Variable | Example |
|---|---|
| `SPACES_KEY`, `SPACES_SECRET` | a Spaces access key; best a separate one limited to this bucket |
| `SPACES_BUCKET` | the bucket's name |
| `SPACES_ENDPOINT` | `https://sfo3.digitaloceanspaces.com` (with or without the bucket in front) |
| `SPACES_REGION` | optional; default `us-east-1`, which Spaces accepts |
| `SPACES_CDN_ENDPOINT` | optional; the links printed after uploading use it |

If any are unset, the command stops before building and names the missing ones.

## One-time setup (owner)

This makes `curl -fsSL https://zetta3d.ai/install.sh | sh` (and `irm https://zetta3d.ai/install.ps1 | iex` on Windows) install the right build on any machine. Here is how a request travels:

```
zetta3d.ai/install.sh  ──302──▶  downloads.zetta3d.ai/zcli/install.sh  ──▶  the bucket's CDN: zcli/install.sh
   (the website)                    (a Cloudflare redirect)                   (uploaded by --upload)
```

1. **Bucket CDN:** in DigitalOcean, open the bucket (Spaces Object Storage → the bucket → Settings) and enable its CDN. Note the CDN endpoint, `https://<bucket>.<region>.cdn.digitaloceanspaces.com`.
2. **`downloads.zetta3d.ai`:** in Cloudflare (the `zetta3d.ai` zone), point it at the bucket's CDN. Either:
   - **Option A, simplest (no certificate):** add a proxied DNS record for `downloads` (for example `AAAA` `100::`). Then add a redirect rule: when the hostname is `downloads.zetta3d.ai`, do a dynamic `302` redirect to `concat("https://<bucket>.<region>.cdn.digitaloceanspaces.com", http.request.uri.path)`, preserving the query string. The installers and `zetta upgrade` all follow redirects.
   - **Option B:** add `downloads.zetta3d.ai` as the CDN's custom subdomain in DigitalOcean (this needs a certificate for it), then a DNS-only `CNAME` `downloads` → `<bucket>.<region>.cdn.digitaloceanspaces.com` in Cloudflare.
3. **The website:** `server.mjs` in `Zetta3D-Frontend` redirects `/install.sh` and `/install.ps1` to `https://downloads.zetta3d.ai/zcli/…` (`CLI_DOWNLOAD_BASE` overrides that). Deploy it, and make sure no Cloudflare rule answers those two paths first.
4. **Release machine:** set the `SPACES_*` settings above, plus the vendor word list in your shell profile:

   ```bash
   export ZETTA_VENDOR_WORDS_FILE=/path/to/vendor-words.ts
   ```

   The release build checks that no model vendor's name is in the code or the binaries. `ZETTA_VENDOR_WORDS` (comma-separated) works too. Never commit the list.
5. **First release:** run `bun run build --release --upload`.
6. **Check it:**

   ```bash
   curl -fsSL https://zetta3d.ai/install.sh | sh
   zetta --version
   ```

Optional extras:
- **npm:** create the `@zetta3d` organisation and run `npm login`.
- **Homebrew:** create the tap repository, e.g. `zetta3d/homebrew-tap`.
- **Signing:** a Developer ID Application certificate in your login keychain for macOS, and a code-signing certificate for Windows (`brew install jsign`). Unsigned builds are fine for `curl` and `irm` installs; browser downloads would hit Gatekeeper and SmartScreen.

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
bun run build --collect --version $V                       # copy the signed binaries into release/ again
```

Some notes on signing:
- **Notarisation profile:** create `zetta-notary` once with `xcrun notarytool store-credentials`.
- **Stapling:** a bare executable can't be stapled. Gatekeeper checks the notarisation online.
- **Hardware or cloud certificates:** for example Azure Trusted Signing. These need other `jsign` `--storetype` options.

**3. Publish.**

```bash
bun run build --collect --upload --version 0.2.0   # if you didn't pass --upload in step 1, or you signed
git tag v0.2.0 && git push origin v0.2.0           # optional: mark the released commit

# npm and Homebrew (optional)
bun run package:channels                           # dist/npm/ and dist/homebrew/zetta.rb
for d in dist/npm/cli-*/ dist/npm/cli/; do (cd "$d" && npm publish --access public); done
cp dist/homebrew/zetta.rb ../homebrew-tap/Formula/zetta.rb    # then commit and push the tap
```

**CDN cache:** `latest.json`, the installers and the `zcli/<os>/` files keep their names between releases. If installs still get the previous version, purge the bucket CDN's cache for `zcli/` (DigitalOcean: the bucket → Settings → CDN → Purge cache).

**Prereleases** (`0.3.0-beta.1`): `--upload` uploads only `zcli/v<version>/`. Publish to npm with `--tag next`, and leave the Homebrew formula alone.

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
