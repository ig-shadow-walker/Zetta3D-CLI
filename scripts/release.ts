/**
 * Builds a release of zetta for you to upload to the Zetta storage bucket (DigitalOcean Spaces) yourself.
 *
 *   bun run release patch --base https://<bucket>.<region>.digitaloceanspaces.com/zcli
 *   bun run release 0.2.0 --dry-run     # show the plan, change nothing
 *   bun run release --verify            # after uploading: is it live and correct?
 *
 * `--base` is where the release will be downloaded from: the bucket's Origin (or CDN) endpoint plus
 * the folder. It can also come from ZETTA_PUBLIC_BASE, or from SPACES_BUCKET + SPACES_ENDPOINT
 * (+ SPACES_FOLDER, SPACES_CDN_ENDPOINT). No access keys are needed: nothing is uploaded from here.
 *
 * Steps, stopping at the first failure:
 *   1. Set packages/cli/package.json to the version; regenerate the docs and the agent skill.
 *   2. `bun run build --release`: tests, every platform, vendor scan, installer test. The binaries
 *      record the download address, so installed copies look there for the next version.
 *   3. Stage every file to upload under release/upload/, in the bucket's layout, with the installers
 *      pointing at the download address, and print what to upload in which order.
 *
 * It never uploads, commits, tags or pushes.
 */
import { spawnSync } from 'node:child_process'
import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { compareVersions } from '../packages/cli/src/upgrade'
import { keyFromBinaryName, normalizeVersion } from '../packages/cli/src/upgrade/manifest'
import { TARGETS } from './build-binaries'
import { publicLocation, releasePlan, type PublicLocation, type UploadObject } from './upload-spaces'

const ROOT = resolve(import.meta.dirname, '..')
const PACKAGE = join(ROOT, 'packages', 'cli', 'package.json')
const STAGE = join(ROOT, 'release', 'upload')
const FIRST = '1-upload-first'
const LAST = '2-upload-last'

const USAGE = `Usage: bun run release [version] [options]

  version          x.y.z (or x.y.z-beta.1), patch, minor, major; default: the current version
  --base <url>     where the release is downloaded from: the bucket's Origin or CDN endpoint plus the
                   folder, e.g. https://<bucket>.<region>.digitaloceanspaces.com/zcli (or ZETTA_PUBLIC_BASE,
                   or SPACES_BUCKET + SPACES_ENDPOINT + SPACES_FOLDER)
  --folder <name>  the bucket folder (default: SPACES_FOLDER, else zcli)
  --verify         after uploading: check the release is live and correct
  --no-build       only stage what is already built in dist/ (e.g. after signing the binaries)
  --dry-run        show the plan, change nothing
  --yes            do not ask before building
  -h, --help       show this help

Needs ZETTA_VENDOR_WORDS_FILE (the vendor-name list). See docs/releasing.md.`

function fail(message: string, code = 1): never {
  console.error(`release: ${message}`)
  process.exit(code)
}

/** patch / minor / major from a current x.y.z, or a given version as it is. */
export function nextVersion(current: string, wanted: string | undefined): string {
  if (!wanted) return normalizeVersion(current)
  const [major = 0, minor = 0, patch = 0] = normalizeVersion(current).split(/[-+]/)[0]!.split('.').map(Number)
  if (wanted === 'patch') return `${major}.${minor}.${patch + 1}`
  if (wanted === 'minor') return `${major}.${minor + 1}.0`
  if (wanted === 'major') return `${major + 1}.0.0`
  return normalizeVersion(wanted)
}

function run(title: string, cmd: string[]): void {
  console.log(`\n▸ ${title}`)
  const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd: ROOT, stdio: 'inherit', env: process.env })
  if (r.status !== 0) fail(`"${title}" failed (exit ${r.status ?? r.signal}). Nothing after it ran.`)
}

async function get(url: string, method: 'GET' | 'HEAD' = 'GET'): Promise<Response | undefined> {
  try {
    return await fetch(url, { method, signal: AbortSignal.timeout(15_000), headers: { 'Cache-Control': 'no-cache' } })
  } catch {
    return undefined
  }
}

/** What is online now, if anything (for "is this newer?"). */
async function publishedVersion(base: string): Promise<string | undefined> {
  const response = await get(`${base}/latest.json`)
  if (!response?.ok) return undefined
  try {
    return ((await response.json()) as { version?: string }).version
  } catch {
    return undefined
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

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

/** Writes the upload into release/upload/: everything but latest.json first, latest.json on its own. */
export function stageUpload(objects: UploadObject[], stage: string, folder: string): { first: string; last: string; files: number; bytes: number } {
  rmSync(stage, { recursive: true, force: true })
  let bytes = 0
  for (const object of objects) {
    const isLast = object.key === `${folder}/latest.json`
    const target = join(stage, isLast ? LAST : FIRST, object.key)
    mkdirSync(dirname(target), { recursive: true })
    if (object.file) copyFileSync(object.file, target, constants.COPYFILE_FICLONE)
    else writeFileSync(target, object.text ?? '')
    bytes += statSync(target).size
  }
  return { first: join(stage, FIRST, folder), last: join(stage, LAST, folder, 'latest.json'), files: objects.length, bytes }
}

function instructions(version: string, location: PublicLocation, staged: ReturnType<typeof stageUpload>, objects: UploadObject[], verifyCommand: string): string {
  const { folder, downloadBase } = location
  const count = (prefix: string) => objects.filter((o) => o.key.startsWith(prefix)).length
  const osCopies = ['macosx', 'windows', 'linux'].reduce((sum, os) => sum + count(`${folder}/${os}/`), 0)
  return [
    `# Upload zetta ${version}`,
    '',
    `Everything below goes into the bucket folder \`${folder}/\`, so that it is downloaded from:`,
    '',
    `    ${downloadBase}`,
    '',
    `Make every file **Public** when you upload it (in the DigitalOcean console: File privacy → Public).`,
    '',
    `## 1. Upload this folder first: \`${relative(ROOT, staged.first)}\``,
    '',
    `Drag the \`${folder}\` folder onto the bucket's top level (it merges with what is there):`,
    '',
    `- \`${folder}/v${version}/\`: ${count(`${folder}/v${version}/`)} files, every build, its .gz copy and SHA256SUMS. This is what installs and upgrades download.`,
    `- \`${folder}/install.sh\` and \`${folder}/install.ps1\`: the installers, already pointing at the address above.`,
    ...(osCopies ? [`- \`${folder}/macosx/\`, \`${folder}/windows/\`, \`${folder}/linux/\`: the newest build per OS, for direct download links (${osCopies} files). Optional; installs don't need them.`] : []),
    '',
    `Then open \`${folder}/install.ps1\` in the console (… → Settings or Metadata) and set its Content-Type to \`text/plain\`: Windows' \`irm … | iex\` needs text. (\`install.sh\` works with any type.)`,
    '',
    `## 2. Then upload \`${relative(ROOT, staged.last)}\` into \`${folder}/\``,
    '',
    'This is the switch: once it is there, installs get the new version and installed copies are told about it. Upload it last, so it never points at files that are not there yet.',
    '',
    '## 3. Check it',
    '',
    `If the bucket has a CDN, purge \`${folder}/latest.json\`, \`${folder}/install.sh\` and \`${folder}/install.ps1\` first. Then:`,
    '',
    `    ${verifyCommand}`,
    '',
    'People install it with one line, then sign in with the browser (the installer starts it):',
    '',
    '    curl -fsSL https://zetta3d.ai/install.sh | sh        # macOS, Linux',
    '    irm https://zetta3d.ai/install.ps1 | iex             # Windows',
    '',
    `zetta3d.ai sends these to your bucket once the website's CLI_DOWNLOAD_BASE is ${downloadBase}. Straight from the bucket: curl -fsSL ${downloadBase}/install.sh | sh`,
    '',
    'And record it in git:',
    '',
    `    git add -A && git commit -m "Release ${version}" && git tag v${version} && git push && git push origin v${version}`,
    '',
  ].join('\n')
}

/** Checks the uploaded release the way installs and installed copies will see it. */
async function verify(location: PublicLocation, expected: string): Promise<boolean> {
  const { downloadBase } = location
  const results: Array<[boolean, string]> = []
  const latest = await get(`${downloadBase}/latest.json`)
  let manifest: { version?: string; files?: Record<string, { name: string; gz?: { name: string } }> } = {}
  try {
    manifest = latest?.ok ? ((await latest.json()) as typeof manifest) : {}
  } catch {
    // reported below
  }
  results.push([manifest.version === expected, `latest.json says ${manifest.version ?? (latest ? `nothing (HTTP ${latest.status})` : 'nothing (unreachable)')}${manifest.version === expected ? '' : `, not ${expected}`}`])
  for (const [script, line] of [
    ['install.sh', `DEFAULT_BASE="${downloadBase}"`],
    ['install.ps1', `$DefaultBase = '${downloadBase}'`],
  ] as const) {
    const response = await get(`${downloadBase}/${script}`)
    const text = response?.ok ? await response.text() : ''
    const type = response?.headers.get('content-type') ?? ''
    results.push([text.includes(line), `${script} ${text.includes(line) ? 'downloads from this address' : response?.ok ? 'is the wrong file (it does not point here)' : `is missing (HTTP ${response?.status ?? 'unreachable'})`}`])
    // Windows' `irm … | iex` needs text; `curl … | sh` takes whatever it gets.
    if (text && script === 'install.ps1') results.push([type.startsWith('text/'), `${script} is served as ${type || 'no type'}${type.startsWith('text/') ? '' : ' (set its Content-Type to text/plain)'}`])
  }
  const names = Object.values(manifest.files ?? {}).flatMap((f) => [f.name, ...(f.gz ? [f.gz.name] : [])])
  if (names.length) {
    const missing: string[] = []
    for (const name of [...names, 'SHA256SUMS']) {
      const response = await get(`${downloadBase}/v${expected}/${name}`, 'HEAD')
      if (!response?.ok) missing.push(name)
    }
    results.push([missing.length === 0, missing.length ? `v${expected}/ is missing ${missing.join(', ')}` : `v${expected}/ has all ${names.length + 1} files`])
  }
  for (const [ok, line] of results) console.log(`  ${ok ? '✓' : '✗'} ${line}`)
  return results.every(([ok]) => ok)
}

async function main(): Promise<void> {
  let parsed
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        base: { type: 'string' },
        folder: { type: 'string' },
        verify: { type: 'boolean', default: false },
        'no-build': { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        yes: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    })
  } catch (error) {
    fail(`${(error as Error).message}\n\n${USAGE}`, 2)
  }
  const { values, positionals } = parsed
  if (values.help) return console.log(USAGE)

  let location: PublicLocation
  try {
    location = publicLocation(process.env, { base: values.base, folder: values.folder })
  } catch (error) {
    fail((error as Error).message, 2)
  }
  const pkg = JSON.parse(readFileSync(PACKAGE, 'utf8')) as { version: string }

  if (values.verify) {
    const version = nextVersion(pkg.version, positionals[0])
    console.log(`Checking zetta ${version} at ${location.downloadBase}`)
    const ok = await verify(location, version)
    console.log(ok ? `\nzetta ${version} is live.` : '\nNot everything is right yet; fix the ✗ lines, then run this again.')
    process.exit(ok ? 0 : 1)
  }

  if (!process.env.ZETTA_VENDOR_WORDS_FILE && !process.env.ZETTA_VENDOR_WORDS) {
    fail('the release checks for vendor names, which needs ZETTA_VENDOR_WORDS_FILE (or ZETTA_VENDOR_WORDS). See docs/releasing.md.', 2)
  }
  let version: string
  try {
    version = nextVersion(pkg.version, positionals[0])
  } catch (error) {
    fail((error as Error).message, 2)
  }
  const prerelease = version.includes('-')
  const published = await publishedVersion(location.downloadBase)
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).stdout?.trim()

  console.log(
    [
      `Release zetta ${version}${version === pkg.version ? '' : ` (now ${pkg.version})`}${prerelease ? ' — a prerelease: nobody is offered it' : ''}`,
      `  downloaded from ${location.downloadBase}  (bucket folder ${location.folder}/)`,
      `  online now:     ${published ?? 'nothing yet'}`,
    ].join('\n'),
  )
  if (published && !prerelease && compareVersions(version, published) <= 0) {
    fail(`${version} is not newer than the ${published} online, so installed copies would not be offered it. Give a higher version (e.g. \`bun run release patch\`).`, 2)
  }
  if (dirty) console.warn('\nNote: there are uncommitted changes; this release includes them. Commit before or right after releasing.')
  if (values['dry-run']) return console.log('\nDry run: nothing was changed or built.')
  if (!values.yes && !(await confirm(`\nBuild zetta ${version} for ${location.downloadBase}?`))) {
    fail(process.stdin.isTTY ? 'cancelled; nothing was changed.' : 'pass --yes to build without a terminal.', process.stdin.isTTY ? 1 : 2)
  }

  if (values['no-build']) {
    if (!existsSync(join(ROOT, 'dist', `v${version}`))) fail(`dist/v${version} does not exist: build it first (bun run release ${version}).`, 2)
  } else {
    // 1. The version, then everything generated from it (the skill records the version it belongs to).
    if (version !== pkg.version) {
      writeFileSync(PACKAGE, readFileSync(PACKAGE, 'utf8').replace(/"version":\s*"[^"]*"/, `"version": "${version}"`))
      console.log(`\nSet packages/cli/package.json to ${version}.`)
    }
    run('Regenerate the docs and the agent skill', [process.execPath, 'run', 'scripts/gen-command-docs.ts'])

    // 2. Build and check everything; the binaries record where they are downloaded from.
    run(`Build and check ${version}`, [process.execPath, 'run', 'scripts/build.ts', '--release', '--version', version, '--download-base', location.downloadBase])
  }

  // 3. Stage the upload.
  const versionDir = join(ROOT, 'dist', `v${version}`)
  const keys = readdirSync(versionDir).map((name) => keyFromBinaryName(name)).filter((key): key is string => Boolean(key))
  const plan = releasePlan({
    version,
    versionDir,
    latestJson: join(ROOT, 'dist', 'latest.json'),
    installDir: join(ROOT, 'install'),
    keys,
    releaseKeys: TARGETS.map((t) => t.replace(/^bun-/, '')),
    folder: location.folder,
    downloadBase: location.downloadBase,
  })
  const staged = stageUpload(plan.objects, STAGE, location.folder)
  const verifyCommand = `bun run release --verify${values.base ? ` --base ${location.downloadBase}` : ''}${values.folder ? ` --folder ${location.folder}` : ''}`
  const steps = instructions(version, location, staged, plan.objects, verifyCommand)
  writeFileSync(join(STAGE, 'README.md'), steps)
  console.log(`\n▸ Ready to upload: ${staged.files} files, ${mb(staged.bytes)}, in ${relative(ROOT, STAGE)}/ (these steps are also in ${relative(ROOT, join(STAGE, 'README.md'))})\n`)
  console.log(steps.replace(/^#+ /gm, '').replace(/\*\*/g, '').replace(/`/g, ''))
  if (plan.note) console.log(`Note: ${plan.note}`)
}

if (import.meta.main) await main()
