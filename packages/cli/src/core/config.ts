import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEFAULT_API_URL } from '@zetta3d/sdk'
import { configDir } from './paths'
import { usageError } from './errors'

export const DEFAULT_SITE_URL = 'https://zetta3d.ai'

export interface Profile {
  apiUrl: string
  siteUrl: string
}

export interface ConfigFile {
  currentProfile?: string
  profiles?: Record<string, Partial<Profile>>
  output?: 'text' | 'json' | 'ndjson'
  defaults?: { wait?: boolean; engine?: string }
  download?: { auto?: boolean; dir?: string; formats?: string[] }
  skills?: { auto?: boolean }
  spend?: { maxPerCommand?: number | null; requireConfirm?: boolean }
}

export const BUILT_IN_PROFILES: Record<string, Profile> = {
  default: { apiUrl: DEFAULT_API_URL, siteUrl: DEFAULT_SITE_URL },
  local: { apiUrl: 'http://localhost:4000/api', siteUrl: 'http://localhost:3000' },
}

/** Settable keys, their types and what they do (used by `zetta config`). */
export const CONFIG_KEYS: Record<string, { type: 'string' | 'number' | 'boolean' | 'enum' | 'list'; values?: string[]; description: string }> = {
  output: { type: 'enum', values: ['text', 'json', 'ndjson'], description: 'Default output format (otherwise text in a terminal, JSON when piped).' },
  'defaults.wait': { type: 'boolean', description: 'Wait for paid jobs to finish unless --no-wait is given.' },
  'defaults.engine': { type: 'string', description: 'Default engine for `zetta generate` (n2.5, np1, np1.5; n2.5 when unset).' },
  'download.auto': {
    type: 'boolean',
    description: 'Download finished jobs into the folder you run zetta in. Unset: on in a terminal, off for scripts and agents. --download / --no-download override it per command.',
  },
  'download.dir': { type: 'string', description: 'Folder for automatic downloads instead of the current one (relative paths start from the current folder).' },
  'skills.auto': {
    type: 'boolean',
    description: 'Install the AI-agent skill for Claude Code, Codex and Cursor automatically, and keep it up to date (default true; `zetta skill uninstall` sets it to false).',
  },
  'download.formats': { type: 'list', description: 'Only these formats in automatic downloads, comma-separated, e.g. glb,fbx (default: every result file).' },
  'spend.maxPerCommand': { type: 'number', description: 'Credits a single command may spend without --yes or --max-credits.' },
  'spend.requireConfirm': { type: 'boolean', description: 'Ask before spending in a terminal (default true).' },
  currentProfile: { type: 'string', description: 'The profile used when --profile is not given.' },
}

export class ConfigStore {
  readonly path: string
  private data: ConfigFile

  constructor(dir: string = configDir()) {
    this.path = join(dir, 'config.json')
    this.data = this.load()
  }

  private load(): ConfigFile {
    if (!existsSync(this.path)) return {}
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as ConfigFile
    } catch {
      throw usageError(`The config file at ${this.path} is not valid JSON. Fix or delete it.`)
    }
  }

  get file(): Readonly<ConfigFile> {
    return this.data
  }

  save(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, this.path)
    try {
      chmodSync(this.path, 0o600)
    } catch {
      // not supported on every filesystem
    }
  }

  profileNames(): string[] {
    return [...new Set([...Object.keys(BUILT_IN_PROFILES), ...Object.keys(this.data.profiles ?? {})])]
  }

  /** Resolves the active profile, letting environment variables override its URLs. */
  resolveProfile(name: string | undefined, env: NodeJS.ProcessEnv = process.env): { name: string; profile: Profile } {
    const chosen = name ?? env.ZETTA_PROFILE ?? this.data.currentProfile ?? 'default'
    const base = BUILT_IN_PROFILES[chosen]
    const custom = this.data.profiles?.[chosen]
    if (!base && !custom) throw usageError(`There is no profile called "${chosen}". Known: ${this.profileNames().join(', ')}.`)
    const merged: Profile = { ...(base ?? BUILT_IN_PROFILES.default!), ...stripUndefined(custom ?? {}) }
    if (env.ZETTA_API_URL) merged.apiUrl = env.ZETTA_API_URL
    if (env.ZETTA_SITE_URL) merged.siteUrl = env.ZETTA_SITE_URL
    return { name: chosen, profile: merged }
  }

  setProfile(name: string, profile: Partial<Profile>): void {
    this.data.profiles = { ...this.data.profiles, [name]: { ...this.data.profiles?.[name], ...stripUndefined(profile) } }
  }

  removeProfile(name: string): boolean {
    if (!this.data.profiles?.[name]) return false
    delete this.data.profiles[name]
    if (this.data.currentProfile === name) delete this.data.currentProfile
    return true
  }

  get(key: string): unknown {
    return key.split('.').reduce<unknown>((value, part) => (value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined), this.data)
  }

  set(key: string, raw: string | undefined): unknown {
    const spec = CONFIG_KEYS[key]
    if (!spec) throw usageError(`Unknown setting "${key}". Settings: ${Object.keys(CONFIG_KEYS).join(', ')}.`)
    let value: unknown = raw
    if (raw !== undefined) {
      if (spec.type === 'number') {
        value = Number(raw)
        if (!Number.isFinite(value)) throw usageError(`${key} must be a number.`)
      } else if (spec.type === 'boolean') {
        if (!['true', 'false', '1', '0', 'yes', 'no'].includes(raw.toLowerCase())) throw usageError(`${key} must be true or false.`)
        value = ['true', '1', 'yes'].includes(raw.toLowerCase())
      } else if (spec.type === 'enum' && !spec.values!.includes(raw)) {
        throw usageError(`${key} must be one of: ${spec.values!.join(', ')}.`)
      } else if (spec.type === 'list') {
        value = raw.split(',').map((item) => item.trim().toLowerCase().replace(/^\./, '')).filter(Boolean)
        if (!(value as string[]).length) throw usageError(`${key} needs at least one value, e.g. glb,fbx.`)
      }
    }
    const parts = key.split('.')
    let node = this.data as Record<string, unknown>
    for (const part of parts.slice(0, -1)) {
      node[part] = node[part] && typeof node[part] === 'object' ? node[part] : {}
      node = node[part] as Record<string, unknown>
    }
    const last = parts.at(-1)!
    if (value === undefined) delete node[last]
    else node[last] = value
    return value
  }
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>
}
