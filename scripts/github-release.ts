/**
 * Publishes a zetta release as a GitHub release, through GitHub's REST API (no `gh` needed).
 *
 * The token needs write access to the repository's contents:
 *   GITHUB_TOKEN (or GH_TOKEN), else `gh auth token` when the GitHub CLI is signed in.
 * A fine-grained token limited to this one repository, with "Contents: Read and write", is enough.
 *
 * ZETTA_GITHUB_API points it at another API address (a stand-in, for rehearsals).
 */
import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'

export interface ReleaseAsset {
  /** The file name on the release, e.g. zetta-darwin-arm64.gz. */
  name: string
  /** Content type GitHub serves it with: text for the installers (`irm … | iex` needs a string). */
  type: string
  /** A local file to upload, or… */
  file?: string
  /** …text to upload. */
  text?: string
}

export interface GitHubRelease {
  id: number
  tag_name: string
  draft: boolean
  prerelease: boolean
  html_url: string
  upload_url: string
  assets: Array<{ id: number; name: string; size: number; state: string }>
}

/** The token to publish with, and where it came from (never the token itself in messages). */
export function githubToken(env: NodeJS.ProcessEnv = process.env): { token: string; source: string } | undefined {
  for (const name of ['GITHUB_TOKEN', 'GH_TOKEN']) {
    const value = env[name]?.trim()
    if (value) return { token: value, source: name }
  }
  const gh = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const token = gh.status === 0 ? gh.stdout.trim() : ''
  return token ? { token, source: '`gh auth token`' } : undefined
}

export const TOKEN_HELP =
  'Publishing needs a GitHub token that can write to the repository. Either sign in with the GitHub CLI (`brew install gh && gh auth login`), ' +
  'or create a fine-grained token at https://github.com/settings/personal-access-tokens/new (this repository only, "Contents: Read and write") ' +
  'and set it as GITHUB_TOKEN in your shell profile.'

export class GitHub {
  readonly api: string

  constructor(
    readonly repo: string,
    private readonly token: string,
    api: string = process.env.ZETTA_GITHUB_API?.trim() || 'https://api.github.com',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.api = api.replace(/\/+$/, '')
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${this.token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'zetta-release',
      ...extra,
    }
  }

  /** One API call; throws with GitHub's own message on failure. 404 returns undefined when `allow404`. */
  async call<T>(method: string, path: string, body?: unknown, options: { allow404?: boolean } = {}): Promise<T | undefined> {
    const url = path.startsWith('http') ? path : `${this.api}${path}`
    const response = await this.fetchImpl(url, {
      method,
      headers: this.headers(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (response.status === 404 && options.allow404) return undefined
    if (!response.ok) {
      let detail = ''
      try {
        const data = (await response.json()) as { message?: string; errors?: Array<{ code?: string; message?: string }> }
        detail = [data.message, ...(data.errors ?? []).map((e) => e.message ?? e.code)].filter(Boolean).join('; ')
      } catch {
        // no JSON body
      }
      const hint = response.status === 401 ? ' (the token is invalid or expired)' : response.status === 403 || response.status === 404 ? ' (the token cannot write to this repository)' : ''
      throw new Error(`GitHub ${method} ${path} failed: HTTP ${response.status}${detail ? ` ${detail}` : ''}${hint}`)
    }
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T)
  }

  /** The repository, and whether this token may publish to it. */
  async repository(): Promise<{ defaultBranch: string; canPush: boolean | undefined; visibility: string }> {
    const repo = await this.call<{ default_branch: string; visibility?: string; private?: boolean; permissions?: { push?: boolean } }>('GET', `/repos/${this.repo}`, undefined, { allow404: true })
    if (!repo) throw new Error(`GitHub repository ${this.repo} was not found, or the token cannot see it.`)
    return { defaultBranch: repo.default_branch, canPush: repo.permissions?.push, visibility: repo.visibility ?? (repo.private ? 'private' : 'public') }
  }

  /** The newest published, non-prerelease release's version, if any. */
  async latestVersion(): Promise<string | undefined> {
    const latest = await this.call<{ tag_name: string }>('GET', `/repos/${this.repo}/releases/latest`, undefined, { allow404: true })
    return latest?.tag_name.replace(/^v/, '')
  }

  /** The release for a tag, drafts included (the tag endpoint does not return drafts). */
  async releaseFor(tag: string): Promise<GitHubRelease | undefined> {
    for (let page = 1; page <= 10; page++) {
      const releases = (await this.call<GitHubRelease[]>('GET', `/repos/${this.repo}/releases?per_page=100&page=${page}`)) ?? []
      const found = releases.find((r) => r.tag_name === tag)
      if (found || releases.length < 100) return found
    }
    return undefined
  }

  createDraft(input: { tag: string; name: string; body: string; prerelease: boolean }): Promise<GitHubRelease> {
    return this.call<GitHubRelease>('POST', `/repos/${this.repo}/releases`, {
      tag_name: input.tag,
      name: input.name,
      body: input.body,
      draft: true,
      prerelease: input.prerelease,
    }) as Promise<GitHubRelease>
  }

  /** Uploads one asset, replacing a broken or different copy of it; retries a failed upload. */
  async upload(release: GitHubRelease, asset: ReleaseAsset): Promise<'uploaded' | 'unchanged'> {
    const size = asset.file ? statSync(asset.file).size : Buffer.byteLength(asset.text ?? '')
    const existing = release.assets.find((a) => a.name === asset.name)
    if (existing && existing.state === 'uploaded' && existing.size === size) return 'unchanged'
    if (existing) await this.call('DELETE', `/repos/${this.repo}/releases/assets/${existing.id}`)
    const target = `${release.upload_url.replace(/\{[^}]*\}$/, '')}?name=${encodeURIComponent(asset.name)}`
    let lastError: unknown
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const body = asset.file ? Bun.file(asset.file) : (asset.text ?? '')
        const response = await this.fetchImpl(target, {
          method: 'POST',
          headers: this.headers({ 'content-type': asset.type, 'content-length': String(size) }),
          body,
        })
        if (response.ok) return 'uploaded'
        lastError = new Error(`HTTP ${response.status} ${(await response.text()).slice(0, 200)}`)
        if (response.status === 422) {
          // A half-finished earlier attempt left an asset with this name: remove it and try again.
          const fresh = await this.call<GitHubRelease>('GET', `/repos/${this.repo}/releases/${release.id}`)
          const stale = fresh?.assets.find((a) => a.name === asset.name)
          if (stale) await this.call('DELETE', `/repos/${this.repo}/releases/assets/${stale.id}`)
        }
      } catch (error) {
        lastError = error
      }
    }
    throw new Error(`Uploading ${asset.name} failed: ${(lastError as Error)?.message ?? lastError}`)
  }

  /** Makes a draft public; a stable release also becomes "latest" (what installs and upgrades get). */
  publish(release: GitHubRelease): Promise<GitHubRelease> {
    return this.call<GitHubRelease>('PATCH', `/repos/${this.repo}/releases/${release.id}`, {
      draft: false,
      make_latest: release.prerelease ? 'false' : 'true',
    }) as Promise<GitHubRelease>
  }
}
