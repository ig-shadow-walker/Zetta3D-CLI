/**
 * Releases zetta as a GitHub release, in one command:
 *
 *   bun run release              # next patch version: 0.1.0 → 0.1.1
 *   bun run release minor        # or major, or an exact version (0.3.0-beta.1 for a prerelease)
 *   bun run release --dry-run    # run the pre-flight checks and show the plan; change nothing
 *   bun run release --publish    # publish what is already built (after a failed upload, or after signing)
 *   bun run release --verify     # check the live release the way installs see it
 *
 * Steps, stopping at the first failure:
 *   1. Pre-flight: a GitHub token that can publish, a clean working tree on the default branch that is
 *      not behind origin, a new tag, and a version newer than the published one.
 *   2. Set packages/cli/package.json to the version; regenerate the docs and the agent skill.
 *   3. `bun run build --release`: typecheck, tests, lint, the three builds (macOS as one universal file,
 *      Linux x64, Windows x64), the vendor-name scan, and the installer end to end.
 *      If anything fails, the version change is undone.
 *   4. Commit "Release v<version>", tag v<version>, push both.
 *   5. Create the GitHub release as a draft, upload every file, then publish it. A stable release
 *      becomes "latest": the one-line installers install it, and installed copies offer it within the hour.
 *   6. Read the release back the way installs and installed copies will.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { binaryName, compareVersions, keyFromBinaryName, latestUrl, normalizeVersion, RELEASE_REPO, versionUrl } from '../packages/cli/src/upgrade/manifest'
import { RELEASE_KEYS } from './build-binaries'
import { GitHub, githubToken, TOKEN_HELP, type GitHubRelease, type ReleaseAsset } from './github-release'
import { buildMatchers, cleanWords, extractArrayStrings, parseWordText, scanText } from './scan-vendor-names'

const ROOT = resolve(import.meta.dirname, '..')
const PACKAGE = join(ROOT, 'packages', 'cli', 'package.json')
const DIST = join(ROOT, 'dist')

const USAGE = `Usage: bun run release [version] [options]

  version        patch (the default), minor, major, or an exact x.y.z (x.y.z-beta.1: a prerelease,
                 which installs and upgrades are not offered)
  --dry-run      run the pre-flight checks and show the plan; change nothing
  --yes          do not ask before starting
  --publish      publish what is already built in dist/ for the current version (after a failed
                 upload, or after signing the binaries); no build, commit or tag
  --verify       check the live release the way installs and installed copies see it
  --repo <o/n>   the GitHub repository (default: ${RELEASE_REPO})
  --base <url>   where releases are downloaded from (default: https://github.com/<repo>/releases)
  -h, --help     show this help

Needs ZETTA_VENDOR_WORDS_FILE (the vendor-name list) and a GitHub token (GITHUB_TOKEN, or \`gh auth login\`).
See docs/releasing.md.`

function fail(message: string, code = 1): never {
  console.error(`\nrelease: ${message}`)
  process.exit(code)
}

/** patch / minor / major from the current x.y.z, or a given version as it is. Default: patch. */
export function nextVersion(current: string, wanted: string | undefined): string {
  const [major = 0, minor = 0, patch = 0] = normalizeVersion(current).split(/[-+]/)[0]!.split('.').map(Number)
  if (!wanted || wanted === 'patch') return `${major}.${minor}.${patch + 1}`
  if (wanted === 'minor') return `${major}.${minor + 1}.0`
  if (wanted === 'major') return `${major + 1}.0.0`
  return normalizeVersion(wanted)
}

function git(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' })
  return { ok: r.status === 0, out: `${r.stdout ?? ''}`.trim() || `${r.stderr ?? ''}`.trim() }
}

function run(title: string, cmd: string[], onFail?: () => void): void {
  console.log(`\n▸ ${title}`)
  const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd: ROOT, stdio: 'inherit', env: process.env })
  if (r.status !== 0) {
    onFail?.()
    fail(`"${title}" failed (exit ${r.status ?? r.signal}). Nothing after it ran.`)
  }
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim())
  } finally {
    rl.close()
  }
}

/**
 * An installer with its default download address replaced, so `curl … | sh` downloads from where
 * this release lives. Fails loudly if the line it replaces is ever renamed.
 */
export function withDownloadBase(script: string, base: string): string {
  const sh = /^DEFAULT_BASE="[^"]*"$/m
  const ps1 = /^(\s*)\$DefaultBase = '[^']*'$/m
  if (sh.test(script)) return script.replace(sh, `DEFAULT_BASE="${base}"`)
  if (ps1.test(script)) return script.replace(ps1, `$1$DefaultBase = '${base}'`)
  throw new Error('The installer has no default download address to set (DEFAULT_BASE / $DefaultBase).')
}

/**
 * Every file of a release: each build and its .gz copy, SHA256SUMS, latest.json and the two
 * installers (as text, pointing at `base`). Throws when a platform is missing, so a release never
 * ships without Mac, Linux or Windows.
 */
export function releaseAssets(input: { version: string; versionDir: string; latestJson: string; installDir: string; base: string; releaseKeys?: string[] }): ReleaseAsset[] {
  const missing = (input.releaseKeys ?? [...RELEASE_KEYS]).filter((key) => !existsSync(join(input.versionDir, binaryName(key))))
  if (missing.length) throw new Error(`dist/v${input.version} has no build for ${missing.join(', ')}. Build them all: bun run build --release --version ${input.version}`)
  const manifest = JSON.parse(readFileSync(input.latestJson, 'utf8')) as { version?: string }
  if (manifest.version !== input.version) throw new Error(`${input.latestJson} is for ${manifest.version ?? 'no version'}, not ${input.version}.`)
  const builds = readdirSync(input.versionDir)
    .filter((name) => keyFromBinaryName(name.replace(/\.gz$/, '')))
    .sort()
    .map((name): ReleaseAsset => ({ name, type: name.endsWith('.gz') ? 'application/gzip' : 'application/octet-stream', file: join(input.versionDir, name) }))
  const text = 'text/plain; charset=utf-8'
  return [
    ...builds,
    { name: 'SHA256SUMS', type: text, file: join(input.versionDir, 'SHA256SUMS') },
    ...['install.sh', 'install.ps1'].map((name): ReleaseAsset => ({ name, type: text, text: withDownloadBase(readFileSync(join(input.installDir, name), 'utf8'), input.base) })),
    // Last, so "latest" never names files that are not there yet.
    { name: 'latest.json', type: 'application/json', file: input.latestJson },
  ]
}

function vendorMatcher(): RegExp | undefined {
  const words: string[] = []
  if (process.env.ZETTA_VENDOR_WORDS) words.push(...parseWordText(process.env.ZETTA_VENDOR_WORDS))
  const file = process.env.ZETTA_VENDOR_WORDS_FILE?.trim()
  if (file && existsSync(file)) {
    const src = readFileSync(file, 'utf8')
    words.push(...(/\.(ts|js|mjs|cjs)$/.test(file) ? extractArrayStrings(src) : parseWordText(src)))
  }
  const clean = cleanWords(words)
  return clean.length ? buildMatchers(clean).text : undefined
}

/** The release page's text: how to install or update, and what changed since the last release. */
export function releaseNotes(version: string, changes: string[], vendor?: RegExp, base: string = `https://github.com/${RELEASE_REPO}/releases`): string {
  const safe = vendor ? changes.filter((line) => scanText(line, vendor).length === 0) : changes
  const sh = `curl -fsSL ${latestUrl(base, 'install.sh')} | sh`
  return [
    '## Install',
    '',
    'One command for your system installs zetta **and** its skill for AI coding agents (Claude Code, Codex, Cursor), then signs you in with your browser.',
    '',
    '**macOS**',
    '',
    '```sh',
    sh,
    '```',
    '',
    '**Linux**',
    '',
    '```sh',
    sh,
    '```',
    '',
    '**Windows** (PowerShell)',
    '',
    '```powershell',
    `irm ${latestUrl(base, 'install.ps1')} | iex`,
    '```',
    '',
    `Already installed? Run \`zetta upgrade\`, or answer "yes" when zetta offers ${version}.`,
    '',
    '## Changes',
    '',
    ...(safe.length ? safe.map((line) => `- ${line}`) : ['- First release of the Zetta 3D CLI.']),
    '',
    '## Files',
    '',
    'You don\'t need to download these yourself: the command above picks the right one.',
    '',
    '- `zetta-macos`, `zetta-linux-x64`, `zetta-windows-x64.exe`: zetta itself, one file per system (the Mac file runs on Apple Silicon and Intel).',
    '- `install.sh`, `install.ps1`: the installers the commands above run.',
    '- `latest.json`: how installed copies learn that a new version is out.',
    '- `SHA256SUMS`: the checksums every download is verified against.',
    '',
  ].join('\n')
}

/** Commit subjects since the release tag before `ref`, newest first (none for the first release). */
function changesSinceLastRelease(ref: string): string[] {
  const last = git(['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', ref])
  if (!last.ok) return []
  const log = git(['log', '--no-merges', '--format=%s', `${last.out}..${ref}`])
  return log.out
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !/^Release v\d/.test(s))
    .slice(0, 40)
}

async function get(url: string, method: 'GET' | 'HEAD' = 'GET', redirect: RequestRedirect = 'follow'): Promise<Response | undefined> {
  try {
    return await fetch(url, { method, redirect, signal: AbortSignal.timeout(20_000), headers: { 'cache-control': 'no-cache', 'user-agent': 'zetta-release' } })
  } catch {
    return undefined
  }
}

/** Reads the release back the way installs and installed copies see it. */
async function verify(base: string, version: string, files: string[], prerelease: boolean): Promise<boolean> {
  const results: Array<[boolean, string]> = []
  if (!prerelease) {
    const latest = await get(latestUrl(base, 'latest.json'))
    let seen: string | undefined
    try {
      seen = latest?.ok ? ((await latest.json()) as { version?: string }).version : undefined
    } catch {
      // reported below
    }
    results.push([seen === version, `the latest release is ${seen ?? (latest ? `unreadable (HTTP ${latest.status})` : 'unreachable')}${seen === version ? '' : `, not ${version}`}`])
    for (const [script, line] of [
      ['install.sh', `DEFAULT_BASE="${base}"`],
      ['install.ps1', `$DefaultBase = '${base}'`],
    ] as const) {
      const response = await get(latestUrl(base, script))
      const text = response?.ok ? await response.text() : ''
      results.push([text.includes(line), `${script} ${text.includes(line) ? 'downloads from this release' : response?.ok ? 'does not point at this release' : `is missing (HTTP ${response?.status ?? 'unreachable'})`}`])
    }
  }
  const missing: string[] = []
  for (const name of files) if (!(await get(versionUrl(base, version, name), 'HEAD'))?.ok) missing.push(name)
  results.push([missing.length === 0, missing.length ? `v${version} is missing ${missing.join(', ')}` : `v${version} has all ${files.length} files`])
  for (const [ok, line] of results) console.log(`  ${ok ? '✓' : '✗'} ${line}`)

  return results.every(([ok]) => ok)
}

async function main(): Promise<void> {
  let parsed
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        'dry-run': { type: 'boolean', default: false },
        yes: { type: 'boolean', default: false },
        publish: { type: 'boolean', default: false },
        verify: { type: 'boolean', default: false },
        repo: { type: 'string', default: RELEASE_REPO },
        base: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    })
  } catch (error) {
    fail(`${(error as Error).message}\n\n${USAGE}`, 2)
  }
  const { values, positionals } = parsed
  if (values.help) return console.log(USAGE)
  const repo = values.repo.trim()
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) fail(`--repo must look like owner/name, not "${repo}".`, 2)
  const defaultBase = `https://github.com/${repo}/releases`
  const base = (values.base ?? defaultBase).trim().replace(/\/+$/, '')
  if (!base.startsWith('https://') && !/^http:\/\/([a-z0-9-]+\.)?localhost(:\d+)?(\/|$)/.test(base)) fail(`--base must be an https:// address, not "${base}".`, 2)
  const pkg = JSON.parse(readFileSync(PACKAGE, 'utf8')) as { version: string }

  // ---- --verify -------------------------------------------------------------------------------
  if (values.verify) {
    const version = positionals[0] ? normalizeVersion(positionals[0]) : pkg.version
    const versionDir = join(DIST, `v${version}`)
    const files = existsSync(versionDir) ? [...readdirSync(versionDir).filter((n) => keyFromBinaryName(n.replace(/\.gz$/, ''))), 'SHA256SUMS'] : ['SHA256SUMS']
    console.log(`Checking zetta ${version} at ${base}`)
    const ok = await verify(base, version, files, version.includes('-'))
    console.log(ok ? `\nzetta ${version} is live.` : '\nNot everything is right yet; fix the ✗ lines, then run this again.')
    process.exit(ok ? 0 : 1)
  }

  // ---- pre-flight -----------------------------------------------------------------------------
  const publishOnly = values.publish
  let version: string
  try {
    version = publishOnly ? normalizeVersion(pkg.version) : nextVersion(pkg.version, positionals[0])
  } catch (error) {
    fail((error as Error).message, 2)
  }
  const tag = `v${version}`
  const prerelease = version.includes('-')

  if (!publishOnly && !process.env.ZETTA_VENDOR_WORDS_FILE && !process.env.ZETTA_VENDOR_WORDS) {
    fail('the release checks for vendor names, which needs ZETTA_VENDOR_WORDS_FILE (or ZETTA_VENDOR_WORDS). See docs/releasing.md.', 2)
  }
  const auth = githubToken()
  if (!auth) fail(TOKEN_HELP, 2)
  const github = new GitHub(repo, auth.token)
  let info: Awaited<ReturnType<GitHub['repository']>>
  let published: string | undefined
  try {
    info = await github.repository()
    published = await github.latestVersion()
  } catch (error) {
    fail(`${(error as Error).message}\n${TOKEN_HELP}`, 2)
  }
  if (info.canPush === false) fail(`the token from ${auth.source} cannot publish to ${repo}. ${TOKEN_HELP}`, 2)
  if (!prerelease && published && compareVersions(version, published) <= 0 && !publishOnly) {
    fail(`${version} is not newer than the published ${published}, so installed copies would not be offered it. Try \`bun run release\` (next patch) or name a higher version.`, 2)
  }

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).out
  const origin = git(['remote', 'get-url', 'origin'])
  if (!origin.ok) fail('this repository has no "origin" remote to push the release to.', 2)
  if (!origin.out.toLowerCase().includes(repo.toLowerCase())) console.warn(`Note: origin is ${origin.out}, not ${repo}.`)
  const localTag = git(['rev-parse', '-q', '--verify', `refs/tags/${tag}`]).ok
  const remoteTag = git(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`]).out.includes(tag)
  if (publishOnly) {
    if (!remoteTag) fail(`${tag} is not on origin yet. Run the full release (bun run release ${version}), or push the tag first.`, 2)
    try {
      releaseAssets({ version, versionDir: join(DIST, tag), latestJson: join(DIST, 'latest.json'), installDir: join(ROOT, 'install'), base })
    } catch (error) {
      fail((error as Error).message, 2)
    }
  } else {
    if (branch !== info.defaultBranch) fail(`release from ${info.defaultBranch}; this checkout is on ${branch}.`, 2)
    if (git(['status', '--porcelain']).out) fail('there are uncommitted changes. Commit or stash them first, so the release commit holds only the version change.', 2)
    if (!git(['fetch', '--quiet', 'origin', branch]).ok) fail(`could not fetch ${branch} from origin.`, 2)
    const behind = Number(git(['rev-list', '--count', `HEAD..origin/${branch}`]).out || '0')
    if (behind > 0) fail(`${branch} is ${behind} commit(s) behind origin. Pull first.`, 2)
    if (localTag || remoteTag) fail(`${tag} already exists${remoteTag ? ' on origin' : ' here'}. Pick another version, or finish it with \`bun run release --publish\`.`, 2)
  }

  console.log(
    [
      `Release zetta ${version}${publishOnly || version === pkg.version ? '' : ` (now ${pkg.version})`}${prerelease ? ' — a prerelease: installs and upgrades are not offered it' : ''}`,
      `  GitHub:     ${repo} (${info.visibility}), branch ${publishOnly ? '-' : branch}, token from ${auth.source}`,
      `  Published:  ${published ?? 'nothing yet'}`,
      `  Downloads:  ${base}`,
      publishOnly
        ? `  Steps:      publish the builds in dist/${tag} as the GitHub release ${tag}`
        : `  Steps:      set the version, run every check, build macOS, Linux and Windows, commit "Release ${tag}",\n              tag ${tag}, push, then publish the GitHub release`,
    ].join('\n'),
  )
  if (info.visibility !== 'public') console.warn(`\nNote: ${repo} is ${info.visibility}, so nobody else can download this release until the repository is public.`)
  if (values['dry-run']) return console.log('\nDry run: every check passed; nothing was changed.')
  if (!values.yes && !(await confirm('\nGo ahead?'))) {
    fail(process.stdin.isTTY ? 'cancelled; nothing was changed.' : 'pass --yes to release without a terminal.', process.stdin.isTTY ? 1 : 2)
  }

  // ---- version, build, commit, tag, push -------------------------------------------------------
  const changes = changesSinceLastRelease(publishOnly ? `${tag}^` : 'HEAD')
  if (!publishOnly) {
    // The tree was clean, so undoing means restoring every tracked file.
    const undo = () => {
      git(['checkout', '--', '.'])
      console.error('The version change was undone; nothing was committed or published.')
    }
    if (version !== pkg.version) {
      writeFileSync(PACKAGE, readFileSync(PACKAGE, 'utf8').replace(/"version":\s*"[^"]*"/, `"version": "${version}"`))
      console.log(`\nSet packages/cli/package.json to ${version}.`)
    }
    run('Regenerate the docs and the agent skill', [process.execPath, 'run', 'scripts/gen-command-docs.ts'], undo)
    // Earlier versions' builds in dist/ would only slow the vendor scan down; they can be rebuilt any time.
    if (existsSync(DIST)) for (const name of readdirSync(DIST)) if (/^v\d/.test(name) && name !== tag) rmSync(join(DIST, name), { recursive: true, force: true })
    run(`Check and build ${version} for every platform`, [process.execPath, 'run', 'scripts/build.ts', '--release', '--version', version, '--download-base', base], undo)

    console.log(`\n▸ Commit, tag and push ${tag}`)
    if (git(['status', '--porcelain']).out) {
      const added = git(['add', '-A'])
      const committed = added.ok && git(['commit', '--quiet', '-m', `Release ${tag}`])
      if (!added.ok || !committed || !committed.ok) fail(`could not commit the release: ${(committed && committed.out) || added.out}`)
    }
    const tagged = git(['tag', '-a', tag, '-m', `zetta ${version}`])
    if (!tagged.ok) fail(`could not tag ${tag}: ${tagged.out}`)
    for (const ref of [branch, tag]) {
      const pushed = git(['push', '--quiet', 'origin', ref])
      if (!pushed.ok) fail(`pushing ${ref} failed: ${pushed.out}\nFix it, then: git push origin ${branch} && git push origin ${tag} && bun run release --publish`)
    }
    console.log(`  Committed, tagged and pushed ${tag}.`)
  }

  // ---- the GitHub release ----------------------------------------------------------------------
  let assets: ReleaseAsset[]
  try {
    assets = releaseAssets({ version, versionDir: join(DIST, tag), latestJson: join(DIST, 'latest.json'), installDir: join(ROOT, 'install'), base })
  } catch (error) {
    fail((error as Error).message)
  }
  console.log(`\n▸ Publish the GitHub release ${tag} (${assets.length} files)`)
  let release: GitHubRelease
  try {
    release = (await github.releaseFor(tag)) ?? (await github.createDraft({ tag, name: `zetta ${version}`, body: releaseNotes(version, changes, vendorMatcher(), base), prerelease }))
    for (const asset of assets) {
      const size = asset.file ? statSync(asset.file).size : Buffer.byteLength(asset.text ?? '')
      const result = await github.upload(release, asset)
      console.log(`  ${result === 'uploaded' ? '↑' : '='} ${asset.name.padEnd(34)} ${(size / 1024 / 1024).toFixed(1).padStart(6)} MB`)
    }
    if (release.draft) release = await github.publish(release)
  } catch (error) {
    fail(`${(error as Error).message}\nThe tag is pushed; finish with: bun run release --publish`)
  }
  console.log(`  Published: ${release.html_url}`)

  // ---- read it back ----------------------------------------------------------------------------
  console.log(`\n▸ Check the live release`)
  const files = assets.filter((a) => a.name !== 'latest.json' && !a.name.startsWith('install.')).map((a) => a.name)
  let ok = false
  for (let attempt = 1; attempt <= 5 && !ok; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, 3000))
    ok = await verify(base, version, files, prerelease)
  }
  if (!ok) fail(`the release is published, but not everything reads back right yet. Check again in a minute: bun run release --verify ${version}`)
  console.log(
    [
      '',
      `zetta ${version} is live.`,
      prerelease
        ? `  It is a prerelease: install it with ZETTA_VERSION=${version}, or zetta upgrade --to ${version}.`
        : '  New installs get it now, and installed copies offer it within the hour.',
      '',
      `  macOS, Linux:  curl -fsSL ${latestUrl(base, 'install.sh')} | sh`,
      `  Windows:       irm ${latestUrl(base, 'install.ps1')} | iex`,
    ].join('\n'),
  )
}

if (import.meta.main) await main()
