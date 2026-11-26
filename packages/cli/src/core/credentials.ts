import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isApiKey, ZettaError } from '@zetta3d/sdk'
import { configDir } from './paths'

/** A session token (30 days, from the browser sign-in) or an API key (`zk_live_…`, until revoked). */
export type CredentialKind = 'session' | 'api_key'

export interface StoredCredential {
  /** The secret itself: a session token or an API key. */
  token: string
  email?: string
  userId?: number
  /** Session tokens only; an API key does not expire. */
  expiresAt?: string
  savedAt: string
  /** How it was saved. 'email' and 'token' are sign-ins from older versions, still valid until they expire. */
  method?: 'web' | 'email' | 'token' | 'api_key'
  /** Set when the key was made by `zetta apikey create --save`, so it can be named later. */
  apiKeyId?: number
}

export type CredentialSource = 'env' | 'keychain' | 'file'

/** The environment variables a credential can come from, in the order they win. Only API keys. */
export const CREDENTIAL_ENV_VARS = ['ZETTA_API_KEY'] as const
export type CredentialEnvVar = (typeof CREDENTIAL_ENV_VARS)[number]

export interface ResolvedCredential {
  credential: StoredCredential
  source: CredentialSource
  /** Which variable it came from, when `source` is `env`. */
  envVar?: CredentialEnvVar
  kind: CredentialKind
}

/** What a credential is, by its shape: every API key starts `zk_`, a session token never does. */
export function credentialKind(token: string): CredentialKind {
  return isApiKey(token) ? 'api_key' : 'session'
}

const SERVICE = 'zetta3d-cli'

interface SecretsApi {
  get(options: { service: string; name: string }): Promise<string | null>
  set(options: { service: string; name: string; value: string }): Promise<void>
  delete(options: { service: string; name: string }): Promise<boolean>
}

function keychain(env: NodeJS.ProcessEnv): SecretsApi | undefined {
  if (env.ZETTA_NO_KEYCHAIN === '1') return undefined
  const bun = (globalThis as { Bun?: { secrets?: SecretsApi } }).Bun
  return bun?.secrets
}

/**
 * Stores one credential per profile (a session token or an API key): in the OS keychain when the
 * runtime offers it (macOS Keychain, Windows Credential Manager, libsecret), otherwise in a 0600 file.
 *
 * Precedence, first found wins:
 *   1. `ZETTA_API_KEY`  (never written anywhere; must be an API key)
 *   2. the profile's saved credential: keychain, then the file.
 * The variable wins so a script or CI job decides its own identity whatever the machine has saved.
 * Accounts are connected through the browser sign-in; the only other credential is an API key,
 * which is itself made from a signed-in account.
 */
export class CredentialStore {
  private readonly filePath: string

  constructor(
    dir: string = configDir(),
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.filePath = join(dir, 'credentials.json')
  }

  /** The credential for a profile; `ignoreEnv` reads only what is saved. */
  async get(profile: string, options: { ignoreEnv?: boolean } = {}): Promise<ResolvedCredential | undefined> {
    const fromEnv = options.ignoreEnv ? undefined : this.fromEnv()
    if (fromEnv) return fromEnv

    const secrets = keychain(this.env)
    if (secrets) {
      try {
        const raw = await secrets.get({ service: SERVICE, name: profile })
        if (raw) {
          const credential = JSON.parse(raw) as StoredCredential
          return { credential, source: 'keychain', kind: credentialKind(credential.token) }
        }
      } catch {
        // keychain unavailable (e.g. no secret service on a headless Linux box): use the file
      }
    }
    const file = this.readFile()[profile]
    return file ? { credential: file, source: 'file', kind: credentialKind(file.token) } : undefined
  }

  /** The API key from `ZETTA_API_KEY`, if set. Anything else there is refused, never used as a session. */
  fromEnv(): ResolvedCredential | undefined {
    for (const name of CREDENTIAL_ENV_VARS) {
      const value = this.env[name]?.trim()
      if (!value) continue
      if (credentialKind(value) !== 'api_key') {
        throw new ZettaError({
          code: 'INVALID_API_KEY',
          message: `${name} must hold an API key (zk_live_…). To use your account here, sign in with \`zetta auth login\` instead.`,
          status: 401,
        })
      }
      return { credential: { token: value, savedAt: new Date(0).toISOString(), method: 'api_key' }, source: 'env', envVar: name, kind: 'api_key' }
    }
    return undefined
  }

  /** The credential environment variables that are set, in precedence order. */
  envVarsSet(): CredentialEnvVar[] {
    return CREDENTIAL_ENV_VARS.filter((name) => Boolean(this.env[name]?.trim()))
  }

  async set(profile: string, credential: StoredCredential): Promise<CredentialSource> {
    const secrets = keychain(this.env)
    if (secrets) {
      try {
        await secrets.set({ service: SERVICE, name: profile, value: JSON.stringify(credential) })
        this.removeFromFile(profile)
        return 'keychain'
      } catch {
        // fall through to the file
      }
    }
    const all = this.readFile()
    all[profile] = credential
    this.writeFile(all)
    return 'file'
  }

  async delete(profile: string): Promise<boolean> {
    let removed = false
    const secrets = keychain(this.env)
    if (secrets) {
      try {
        removed = (await secrets.delete({ service: SERVICE, name: profile })) || removed
      } catch {
        // ignore
      }
    }
    return this.removeFromFile(profile) || removed
  }

  private removeFromFile(profile: string): boolean {
    const all = this.readFile()
    if (!all[profile]) return false
    delete all[profile]
    this.writeFile(all)
    return true
  }

  private readFile(): Record<string, StoredCredential> {
    if (!existsSync(this.filePath)) return {}
    try {
      return JSON.parse(readFileSync(this.filePath, 'utf8')) as Record<string, StoredCredential>
    } catch {
      return {}
    }
  }

  private writeFile(all: Record<string, StoredCredential>): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 })
    const tmp = `${this.filePath}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, this.filePath)
    try {
      chmodSync(this.filePath, 0o600)
    } catch {
      // not supported on every filesystem
    }
  }
}
