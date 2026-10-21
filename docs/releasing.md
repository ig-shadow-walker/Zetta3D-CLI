# Releasing

## One-time setup (owner)

1. **Download host.**
   - Serve `https://downloads.zetta3d.ai/cli/` from S3-compatible storage (for example Cloudflare R2), and make `https://zetta3d.ai/install.sh` and `install.ps1` serve the installers as `text/plain`.
   - The layout, headers and caching are in [install/README.md](../install/README.md).
   - Serve the `.gz` files as plain bytes, without `Content-Encoding`.
2. **CI secrets and variables** (repository settings → Secrets and variables → Actions):

   | Name | Kind | Purpose |
   |---|---|---|
   | `ZETTA_VENDOR_WORDS` | secret | Comma-separated vendor names for the scan. CI fails on purpose without it |
   | `ZETTA_S3_ACCESS_KEY_ID`, `ZETTA_S3_SECRET_ACCESS_KEY`, `ZETTA_S3_ENDPOINT`, `ZETTA_S3_BUCKET` | secrets | Upload to the download host |
   | `ZETTA_SYNC_DOWNLOADS=true` | variable | Turns the upload on |
   | `NPM_TOKEN` + `ZETTA_PUBLISH_NPM=true` | secret + variable | Publish `@zetta3d/cli` and its platform packages |
   | `ZETTA_TAP_TOKEN` + `ZETTA_HOMEBREW_TAP=owner/homebrew-tap` | secret + variable | Update the Homebrew formula |
   | `APPLE_*`, `WINDOWS_*` | secrets | Code signing; uncomment the steps in `release.yml` |

3. **npm:** create the `@zetta3d` organisation. **Homebrew:** create the tap repository, e.g. `zetta3d/homebrew-tap`.

## Cutting a release

```bash
# 1. Bump the version
#    packages/cli/package.json → "version": "0.2.0"
bun run check
bun run docs:commands            # keep docs/COMMANDS.md and skill/SKILL.md in step

# 2. Optional: test the real thing first
bun run build:local
ZETTA_TOKEN=… bun run smoke:live --bin dist/v0.2.0/zetta-darwin-arm64

# 3. Tag and push
git tag v0.2.0 && git push origin v0.2.0
```

The `Release` workflow (`.github/workflows/release.yml`) then:
1. **Builds** every target on macOS, including the `-baseline` builds and the gzip copies, and re-signs the macOS binaries.
2. **Checks** them: runs the tests, the installer end to end against those exact files, and the vendor scan.
3. **Publishes** them:
   - creates the GitHub release with the binaries, `SHA256SUMS` and `latest.json`;
   - if enabled, uploads to the download host: the version folder first, the installers, then `latest.json` last;
   - if enabled, publishes to npm (platform packages first);
   - if enabled, commits the Homebrew formula.

**Prereleases** (`v0.3.0-beta.1`) get their own folder and npm's `next` tag. They never move `latest.json` or the Homebrew formula. Install one with `ZETTA_VERSION=0.3.0-beta.1`.

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

## Rolling back

Point `latest.json` at the previous version (re-upload the old one). Version folders never change. Users can also pin a version: `zetta upgrade --to 0.1.0`, or `ZETTA_VERSION=0.1.0` with the installer.
