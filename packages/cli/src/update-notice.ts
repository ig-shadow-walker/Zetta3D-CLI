import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { configDir } from './core/paths'
import { compareVersions, fetchLatest, isCompiledBinary } from './upgrade'
import { VERSION } from './version'

const DAY = 24 * 60 * 60 * 1000

/**
 * A once-a-day "update available" line on stderr, for people only: never when output is piped,
 * in CI, from source, or with ZETTA_NO_UPDATE_CHECK=1. It never delays a command by more than 1.5 s.
 */
export async function maybeNotifyUpdate(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!process.stderr.isTTY || !process.stdout.isTTY || env.CI || env.ZETTA_NO_UPDATE_CHECK === '1' || !isCompiledBinary()) return
  const file = join(configDir(env), 'update-check.json')
  try {
    const last = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { checkedAt?: number; latest?: string }) : {}
    let latest = last.latest
    if (!last.checkedAt || Date.now() - last.checkedAt > DAY) {
      const manifest = await Promise.race([fetchLatest(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('slow')), 1500))])
      latest = manifest.version
      mkdirSync(configDir(env), { recursive: true })
      writeFileSync(file, JSON.stringify({ checkedAt: Date.now(), latest }))
    }
    if (latest && compareVersions(latest, VERSION) > 0) {
      process.stderr.write(`\nA new version of zetta is available: ${VERSION} → ${latest}. Run \`zetta upgrade\`.\n`)
    }
  } catch {
    // Never let the update check get in the way.
  }
}
