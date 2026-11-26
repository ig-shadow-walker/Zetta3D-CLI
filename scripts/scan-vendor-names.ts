/**
 * Fails the build if a third-party model vendor's name appears in anything we ship.
 *
 * The names are NOT in this repo. They come from the environment:
 *   ZETTA_VENDOR_WORDS       comma- or newline-separated words
 *   ZETTA_VENDOR_WORDS_FILE  a text file (one word per line, # comments) or a .ts/.js module whose
 *                            string array(s) hold the words
 *
 * What is scanned (case-insensitively, as substrings; "foo bar" also matches foo-bar, foo_bar, FooBar):
 *   - every file git tracks, plus untracked files that are not ignored, except node_modules/, .git/, dist/
 *   - dist/bundle/zetta.js, the minified JavaScript (our code + every dependency) that the binaries
 *     embed, written by scripts/build-binaries.ts. This is the authoritative check of what ships;
 *     --require-bundle makes its absence an error (release builds).
 *   - every other file under dist/, the compiled binaries byte by byte as UTF-8/Latin-1 and UTF-16LE
 *   - or, if paths are given as arguments, only those files/directories
 *
 * The Bun runtime inside every binary is third-party code that happens to contain some of these
 * substrings. For a file named zetta-<platform key>, the scanner compiles an empty entry for the same
 * Bun target and ignores matches whose surrounding bytes also occur in that runtime-only build, so
 * only what our bundle adds is reported (--raw-binaries turns this off).
 *
 * Hits are printed as file:line:column (byte offset for binaries) and the list entry number. The
 * matched word itself is never printed, so logs do not leak it.
 *
 * Exit codes: 0 clean (or no list and no --require-list), 1 hits found, 2 usage/configuration error.
 */
import { spawnSync } from 'node:child_process'
import { gunzipSync } from 'node:zlib'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { keyFromBinaryName } from '../packages/cli/src/upgrade/manifest'

const ROOT = resolve(import.meta.dirname, '..')
const SKIP_DIRS = new Set(['node_modules', '.git'])
const MAX_HITS_PER_FILE = 20

const USAGE = `Usage: bun run scripts/scan-vendor-names.ts [--require-list] [--require-bundle] [--raw-binaries] [path ...]

Reads the vendor words from ZETTA_VENDOR_WORDS or ZETTA_VENDOR_WORDS_FILE.
  --require-list   fail (exit 2) when no word list is configured (release builds)
  --require-bundle fail (exit 2) when dist/bundle/zetta.js is missing (release builds, after bun run build)
  --raw-binaries   do not subtract matches that come from the Bun runtime itself
  path ...         scan only these files/directories instead of the repo + dist/`

function die(msg: string, code = 2): never {
  console.error(`scan-vendor-names: ${msg}`)
  process.exit(code)
}

// ---------------------------------------------------------------------------------------------
// Loading the word list

/** Removes // and /* *\/ comments from JS/TS source while leaving string literals alone. */
export function stripComments(src: string): string {
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    const next = src[i + 1]
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++
    } else if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2)
      i = end === -1 ? src.length : end + 2
      out += ' '
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1
      out += src.slice(i, j + 1)
      i = j + 1
    } else {
      out += c
      i++
    }
  }
  return out
}

function unquote(lit: string): string {
  return lit.slice(1, -1).replace(/\\(.)/g, (_, ch: string) => (ch === 'n' ? '\n' : ch === 't' ? '\t' : ch))
}

const STRING_LIT = String.raw`'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|\x60(?:\\.|[^\x60\\$])*\x60`

/** The strings inside every array literal that holds only string literals. */
export function extractArrayStrings(src: string): string[] {
  const code = stripComments(src)
  const array = new RegExp(String.raw`\[\s*(?:(?:${STRING_LIT})\s*,?\s*)+\]`, 'g')
  const lit = new RegExp(STRING_LIT, 'g')
  const words: string[] = []
  for (const m of code.matchAll(array)) {
    for (const s of m[0].matchAll(lit)) words.push(unquote(s[0]))
  }
  return words
}

export function parseWordText(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*/, ''))
    .flatMap((line) => line.split(','))
}

export function cleanWords(words: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const w of words.map((x) => x.trim()).filter(Boolean)) {
    const k = w.toLowerCase()
    if (!seen.has(k)) {
      seen.add(k)
      out.push(w)
    }
  }
  return out
}

function loadWords(): { words: string[]; sources: string[] } {
  const words: string[] = []
  const sources: string[] = []
  const fromEnv = process.env.ZETTA_VENDOR_WORDS
  if (fromEnv?.trim()) {
    words.push(...parseWordText(fromEnv))
    sources.push('ZETTA_VENDOR_WORDS')
  }
  const file = process.env.ZETTA_VENDOR_WORDS_FILE?.trim()
  if (file) {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (err) {
      die(`cannot read ZETTA_VENDOR_WORDS_FILE (${file}): ${(err as Error).message}`)
    }
    const fromFile = /\.[cm]?[jt]sx?$/i.test(file) ? extractArrayStrings(text) : parseWordText(text)
    if (cleanWords(fromFile).length === 0) die(`ZETTA_VENDOR_WORDS_FILE (${file}) contains no words`)
    words.push(...fromFile)
    sources.push('ZETTA_VENDOR_WORDS_FILE')
  }
  return { words: cleanWords(words), sources }
}

// ---------------------------------------------------------------------------------------------
// Matching

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** One regex with a capture group per word, so a single pass tells which list entry matched. */
export function buildMatchers(words: string[]): { text: RegExp; utf16: RegExp } {
  const parts = words.map((w) => w.split(/[\s_-]+/).filter(Boolean))
  const text = parts.map((p) => `(${p.map(escapeRe).join(String.raw`[\s_.\-]*`)})`).join('|')
  const utf16 = parts
    .map((p) => `(${p.map((s) => [...s].map((ch) => `${escapeRe(ch)}\\x00`).join('')).join(String.raw`(?:[\s_.\-]\x00)*`)})`)
    .join('|')
  return { text: new RegExp(text, 'gi'), utf16: new RegExp(utf16, 'gi') }
}

export interface Hit {
  entry: number
  /** "12:5" for text, "byte 1234" for binaries. */
  where: string
  /** Binaries: the matched bytes plus 32 bytes either side, to recognise the same string elsewhere. */
  context?: string
}

const CONTEXT = 32

function entryOf(m: RegExpExecArray): number {
  for (let g = 1; g < m.length; g++) if (m[g] !== undefined) return g
  return 0
}

export function scanText(text: string, re: RegExp): Hit[] {
  const hits: Hit[] = []
  const lineStarts = [0]
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lineStarts.push(i + 1)
  re.lastIndex = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid]! <= m.index) lo = mid
      else hi = mid - 1
    }
    hits.push({ entry: entryOf(m), where: `${lo + 1}:${m.index - lineStarts[lo]! + 1}` })
  }
  return hits
}

export function scanBytes(buf: Buffer, matchers: { text: RegExp; utf16: RegExp }): Hit[] {
  // Latin-1 maps each byte to one char, so match offsets are byte offsets.
  const s = buf.toString('latin1')
  const hits: Hit[] = []
  for (const [re, label] of [
    [matchers.text, ''],
    [matchers.utf16, ' (utf-16)'],
  ] as const) {
    re.lastIndex = 0
    for (let m = re.exec(s); m; m = re.exec(s)) {
      const context = s.slice(Math.max(0, m.index - CONTEXT), m.index + m[0].length + CONTEXT)
      hits.push({ entry: entryOf(m), where: `byte ${m.index}${label}`, context })
    }
  }
  return hits
}

// ---------------------------------------------------------------------------------------------
// Choosing files

function walk(dir: string, out: string[]): void {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue
    const p = join(dir, ent.name)
    if (ent.isDirectory()) walk(p, out)
    else if (ent.isFile()) out.push(p)
  }
}

function repoFiles(): string[] {
  const git = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  let files: string[]
  if (git.status === 0) {
    files = git.stdout
      .split('\0')
      .filter(Boolean)
      .map((f) => join(ROOT, f))
  } else {
    console.warn('scan-vendor-names: git is not available; walking the directory instead')
    files = []
    walk(ROOT, files)
  }
  const inSkipped = (f: string) =>
    relative(ROOT, f)
      .split(sep)
      .some((part, i) => SKIP_DIRS.has(part) || (i === 0 && (part === 'dist' || part === 'release')))
  return [...new Set(files)].filter((f) => !inSkipped(f) && existsSync(f) && statSync(f).isFile())
}

function distFiles(): string[] {
  const dist = join(ROOT, 'dist')
  const out: string[] = []
  if (existsSync(dist)) walk(dist, out)
  return out
}

function explicitFiles(paths: string[]): string[] {
  const out: string[] = []
  for (const p of paths) {
    const abs = resolve(p)
    if (!existsSync(abs)) die(`no such file or directory: ${p}`)
    if (statSync(abs).isDirectory()) walk(abs, out)
    else out.push(abs)
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Runtime baseline

const baselines = new Map<string, Set<string> | undefined>()
let baselineDir: string | undefined

/**
 * Contexts of every match inside an empty program compiled for the same Bun target: what the
 * runtime alone contains. Undefined (with a warning) if that build is not possible here.
 */
/**
 * The build key of a compiled zetta: from its release name (zetta-darwin-arm64), or from the npm
 * platform package that carries it (npm/cli-darwin-arm64/bin/zetta), so both get the runtime baseline.
 */
export function binaryKey(file: string): string | undefined {
  const fromName = keyFromBinaryName(basename(file))
  if (fromName) return fromName
  const npm = /[\\/]cli-([a-z0-9-]+)[\\/]bin[\\/]zetta(\.exe)?$/.exec(file)
  return npm ? keyFromBinaryName(`zetta-${npm[1]}${npm[2] ?? ''}`) : undefined
}

function runtimeBaseline(key: string, matchers: { text: RegExp; utf16: RegExp }): Set<string> | undefined {
  if (baselines.has(key)) return baselines.get(key)
  baselineDir ??= mkdtempSync(join(tmpdir(), 'zetta-scan-'))
  const entry = join(baselineDir, 'empty.ts')
  writeFileSync(entry, 'export {}\n')
  const out = join(baselineDir, `runtime-${key}`)
  const r = spawnSync(process.execPath, ['build', entry, '--compile', `--target=bun-${key}`, `--outfile=${out}`], {
    cwd: baselineDir,
    encoding: 'utf8',
  })
  const file = [out, `${out}.exe`].find((f) => existsSync(f))
  let set: Set<string> | undefined
  if (r.status === 0 && file) {
    set = new Set(scanBytes(readFileSync(file), matchers).map((h) => h.context ?? ''))
    rmSync(file, { force: true })
  } else {
    console.warn(`scan-vendor-names: warning: could not build a runtime baseline for ${key}; reporting raw matches.\n${r.stderr ?? ''}`)
  }
  baselines.set(key, set)
  return set
}

// ---------------------------------------------------------------------------------------------

function display(f: string): string {
  const r = relative(ROOT, f)
  return r.startsWith('..') ? f : r
}

function main(): void {
  const { values, positionals } = parseArgs({
    options: {
      'require-list': { type: 'boolean', default: false },
      'raw-binaries': { type: 'boolean', default: false },
      'require-bundle': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
    strict: true,
  })
  if (values.help) {
    console.log(USAGE)
    return
  }

  const { words, sources } = loadWords()
  if (words.length === 0) {
    const msg = 'no vendor word list configured (set ZETTA_VENDOR_WORDS or ZETTA_VENDOR_WORDS_FILE)'
    if (values['require-list']) die(msg)
    console.warn(`scan-vendor-names: warning: ${msg}; skipping the scan.`)
    return
  }
  const short = words.filter((w) => w.replace(/[\s_-]/g, '').length < 3).length
  if (short) die(`${short} list entr${short === 1 ? 'y is' : 'ies are'} shorter than 3 characters; that would match almost anything`)

  const bundle = join(ROOT, 'dist', 'bundle', 'zetta.js')
  if (values['require-bundle'] && !existsSync(bundle)) {
    die('dist/bundle/zetta.js is missing; run `bun run build` before scanning')
  }

  const matchers = buildMatchers(words)
  // Text vs binary is decided per file (NUL bytes), so the bundle gets line:column positions.
  const targets = positionals.length ? explicitFiles(positionals) : [...repoFiles(), ...distFiles()]
  if (!positionals.length) {
    console.log(existsSync(bundle) ? `scan-vendor-names: scanning the shipped bundle ${display(bundle)}` : 'scan-vendor-names: note: no dist/bundle/zetta.js (not built); scanning sources only')
  }

  let hitFiles = 0
  let hitCount = 0
  let ignored = 0
  let bytes = 0
  for (const file of targets) {
    let buf = readFileSync(file)
    // A gzip copy of a release binary is scanned as what it unpacks to: compressed bytes are close
    // to random, so short words turn up in them by chance, and the unpacked bytes are what people run.
    const packed = file.endsWith('.gz') && binaryKey(file.slice(0, -3)) !== undefined
    if (packed) buf = gunzipSync(buf)
    bytes += buf.length
    const binary = buf.subarray(0, 8192).includes(0)
    let hits = binary ? scanBytes(buf, matchers) : scanText(buf.toString('utf8'), matchers.text)
    const key = binaryKey(packed ? file.slice(0, -3) : file)
    if (binary && key && hits.length > 0 && !values['raw-binaries']) {
      const runtime = runtimeBaseline(key, matchers)
      if (runtime) {
        const before = hits.length
        hits = hits.filter((h) => !runtime.has(h.context ?? ''))
        ignored += before - hits.length
      }
    }
    if (hits.length === 0) continue
    hitFiles++
    hitCount += hits.length
    const name = display(file)
    for (const h of hits.slice(0, MAX_HITS_PER_FILE)) {
      console.error(binary ? `${name} @ ${h.where}: vendor name (list entry #${h.entry})` : `${name}:${h.where}: vendor name (list entry #${h.entry})`)
    }
    if (hits.length > MAX_HITS_PER_FILE) console.error(`${name}: ... and ${hits.length - MAX_HITS_PER_FILE} more`)
  }

  if (baselineDir) rmSync(baselineDir, { recursive: true, force: true })
  const summary =
    `${targets.length} files (${(bytes / 1024 / 1024).toFixed(1)} MB) against ${words.length} words from ${sources.join(' + ')}` +
    (ignored ? `; ignored ${ignored} match(es) that are part of the Bun runtime itself` : '')
  if (hitCount > 0) {
    console.error(`\nscan-vendor-names: FAILED: ${hitCount} vendor-name hit(s) in ${hitFiles} file(s). Scanned ${summary}.`)
    process.exit(1)
  }
  console.log(`scan-vendor-names: clean. Scanned ${summary}.`)
}

if (import.meta.main) main()
