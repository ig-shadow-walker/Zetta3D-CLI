import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { configDir } from './core/paths'
import { compareVersions, fetchLatest, isCompiledBinary, upgradeCommand, upgradeSelf } from './upgrade'
import { VERSION } from './version'

/** How often to look for a new release: soon after one is published, at most one request an hour. */
const CHECK_EVERY = 60 * 60 * 1000
/** How often to ask again (or repeat the notice) for the same version. */
const REMIND_EVERY = 12 * 60 * 60 * 1000
/** The check never holds up a command for longer than this (GitHub answers with one redirect). */
const CHECK_TIMEOUT = 2000

interface UpdateCache {
  checkedAt?: number
  latest?: string
  notifiedAt?: number
  notifiedVersion?: string
}

export interface KnownUpdate {
  current: string
  latest: string
  /** The command that upgrades this copy: `zetta upgrade`, or the package manager's. */
  upgradeWith: string
}

const cacheFile = (env: NodeJS.ProcessEnv) => join(configDir(env), 'update-check.json')

function readCache(env: NodeJS.ProcessEnv): UpdateCache {
  try {
    const file = cacheFile(env)
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as UpdateCache) : {}
  } catch {
    return {}
  }
}

function writeCache(env: NodeJS.ProcessEnv, cache: UpdateCache): void {
  try {
    mkdirSync(configDir(env), { recursive: true })
    writeFileSync(cacheFile(env), JSON.stringify(cache))
  } catch {
    // A read-only config folder only means checking again next time.
  }
}

/** Checks only run in an installed copy (`compiled`), and not with ZETTA_NO_UPDATE_CHECK=1. */
const checksOff = (env: NodeJS.ProcessEnv, compiled: boolean) => env.ZETTA_NO_UPDATE_CHECK === '1' || !compiled

/** Records a version learned elsewhere (`zetta upgrade --check`), so notices agree with it. */
export function rememberLatest(env: NodeJS.ProcessEnv, latest: string): void {
  writeCache(env, { ...readCache(env), checkedAt: Date.now(), latest })
}

/** A newer release this copy already knows about (no network). */
export function knownUpdate(env: NodeJS.ProcessEnv = process.env, compiled: boolean = isCompiledBinary()): KnownUpdate | undefined {
  if (checksOff(env, compiled)) return undefined
  const { latest } = readCache(env)
  return latest && compareVersions(latest, VERSION) > 0 ? { current: VERSION, latest, upgradeWith: upgradeCommand() } : undefined
}

/**
 * Looks for a new release when the last look is over an hour old, and remembers the answer.
 * One small request (latest.json); never waits more than 1.5 s, never throws.
 */
export async function refreshUpdateCheck(
  env: NodeJS.ProcessEnv = process.env,
  fetchLatestImpl: typeof fetchLatest = fetchLatest,
  compiled: boolean = isCompiledBinary(),
): Promise<KnownUpdate | undefined> {
  if (checksOff(env, compiled)) return undefined
  const cache = readCache(env)
  if (!cache.checkedAt || Date.now() - cache.checkedAt > CHECK_EVERY) {
    try {
      const manifest = await Promise.race([fetchLatestImpl(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('slow')), CHECK_TIMEOUT))])
      writeCache(env, { ...cache, checkedAt: Date.now(), latest: manifest.version })
    } catch {
      // Offline or slow: try again next time.
    }
  }
  return knownUpdate(env, compiled)
}

export interface NotifyOptions {
  write?: (text: string) => void
  /** stdout and stderr are a terminal (default: detected). */
  terminal?: boolean
  /** Someone can answer a question: stdin is a terminal and prompts are allowed (default: detected). */
  interactive?: boolean
  /** Asks a question and returns the answer (default: reads a line from the terminal). */
  ask?: (question: string) => Promise<string>
  /** Upgrades this copy (default: `zetta upgrade`'s own upgrade). */
  upgrade?: (onProgress: (message: string) => void) => Promise<{ to: string; upgraded: boolean }>
  /** The command that upgrades this copy (default: detected from how it was installed). */
  upgradeWith?: string
  fetchLatest?: typeof fetchLatest
  compiled?: boolean
}

async function askTerminal(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  rl.on('SIGINT', () => rl.close())
  try {
    return await rl.question(question)
  } catch {
    return 'n' // closed (Ctrl-C or Ctrl-D): treat as "not now"
  } finally {
    rl.close()
  }
}

/**
 * After a command, for people at a terminal, when a newer release is out: asks "Update now?" and
 * upgrades on yes, or, when nobody can answer (or a package manager owns this copy), prints how to
 * update. At most once every 12 hours per version. Never when output is piped, in CI, from source,
 * or with ZETTA_NO_UPDATE_CHECK=1. Agents learn about updates from `zetta upgrade --check` (the skill
 * tells them to run it) and from the MCP server's instructions.
 */
export async function maybeNotifyUpdate(env: NodeJS.ProcessEnv = process.env, options: NotifyOptions = {}): Promise<void> {
  const terminal = options.terminal ?? Boolean(process.stderr.isTTY && process.stdout.isTTY)
  if (!terminal || env.CI) return
  const update = await refreshUpdateCheck(env, options.fetchLatest, options.compiled)
  if (!update) return
  const cache = readCache(env)
  if (cache.notifiedVersion === update.latest && cache.notifiedAt && Date.now() - cache.notifiedAt < REMIND_EVERY) return
  writeCache(env, { ...cache, notifiedAt: Date.now(), notifiedVersion: update.latest })

  const write = options.write ?? ((text) => process.stderr.write(text))
  const interactive = options.interactive ?? (Boolean(process.stdin.isTTY) && env.ZETTA_NON_INTERACTIVE !== '1')
  const news = `zetta ${update.latest} is out (you have ${update.current}).`
  const upgradeWith = options.upgradeWith ?? update.upgradeWith
  // Homebrew and npm own their copies, so those get the package manager's command instead.
  if (!interactive || upgradeWith !== 'zetta upgrade') {
    write(`\n${news} Update with: ${upgradeWith}\n`)
    return
  }
  const answer = (await (options.ask ?? askTerminal)(`\n${news} Update now? [Y/n] `)).trim()
  if (answer && !/^y(es)?$/i.test(answer)) {
    write(`Not now. Update any time with: zetta upgrade\n`)
    return
  }
  try {
    const result = await (options.upgrade ?? ((onProgress) => upgradeSelf({ onProgress })))((message) => write(`  ${message}\n`))
    write(result.upgraded ? `Updated to zetta ${result.to}.\n` : `zetta is already up to date.\n`)
  } catch (error) {
    write(`Could not update: ${(error as Error).message}\nTry again later with: zetta upgrade\n`)
  }
}
