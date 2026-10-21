import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { configDir } from './paths'

export interface StoredCredential {
  token: string
  email?: string
  userId?: number
  expiresAt?: string
  savedAt: string
  method?: 'web' | 'email' | 'token'
}

export type CredentialSource = 'env' | 'keychain' | 'file'

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
 * Stores the session token per profile: in the OS keychain when the runtime offers it
 * (macOS Keychain, Windows Credential Manager, libsecret), otherwise in a 0600 file.
 * `ZETTA_TOKEN` always wins and is never written anywhere.
 */
export class CredentialStore {
  private readonly filePath: string

  constructor(
    dir: string = configDir(),
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.filePath = join(dir, 'credentials.json')
  }

  async get(profile: string): Promise<{ credential: StoredCredential; source: CredentialSource } | undefined> {
    const fromEnv = this.env.ZETTA_TOKEN?.trim()
    if (fromEnv) return { credential: { token: fromEnv, savedAt: new Date(0).toISOString(), method: 'token' }, source: 'env' }

    const secrets = keychain(this.env)
    if (secrets) {
      try {
        const raw = await secrets.get({ service: SERVICE, name: profile })
        if (raw) return { credential: JSON.parse(raw) as StoredCredential, source: 'keychain' }
      } catch {
        // keychain unavailable (e.g. no secret service on a headless Linux box): use the file
      }
    }
    const file = this.readFile()[profile]
    return file ? { credential: file, source: 'file' } : undefined
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
