import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { COMMANDS, GROUPS } from '../src/commands'
import { runProgram } from '../src/core/program'

export interface Run {
  code: number
  stdout: string
  stderr: string
  json: () => any
  errorJson: () => any
}

/** Runs the CLI in-process with captured output, a temp config dir and a fake fetch. */
export async function zetta(
  args: string[],
  options: { fetch?: typeof fetch; env?: Record<string, string>; tty?: boolean; stdin?: string; configDir?: string; cwd?: string } = {},
): Promise<Run> {
  let stdout = ''
  let stderr = ''
  const configDir = options.configDir ?? mkdtempSync(join(tmpdir(), 'zetta-test-'))
  // The developer's own sign-in variables must never reach a test; a test that wants one passes it.
  const signedOut = { ZETTA_API_KEY: '', ZETTA_TOKEN: '' }
  const { ZETTA_TEST_SIGN_IN: session, ...given } = options.env ?? {}
  // ZETTA_TEST_SIGN_IN stands for "signed in with the browser": saved as the profile's sign-in, the
  // way `zetta auth login` saves it. The CLI itself reads no such variable.
  if (session) saveSignIn(configDir, session, given.ZETTA_PROFILE || 'default')
  const env = { ...homeEnv(mkdtempSync(join(tmpdir(), 'zetta-home-'))), ...signedOut, ZETTA_CONFIG_DIR: configDir, ZETTA_NO_KEYCHAIN: '1', ...given }
  const stdin = Object.assign(Readable.from(options.stdin ? [options.stdin] : []), { isTTY: options.tty ?? false })
  const previous = { ...process.env }
  Object.assign(process.env, env)
  const realFetch = globalThis.fetch
  if (options.fetch) globalThis.fetch = options.fetch
  try {
    const code = await runProgram(args, {
      commands: COMMANDS,
      groups: GROUPS,
      env: { ...process.env, ...env },
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      streams: {
        stdout: { write: (c: string) => (stdout += c), isTTY: options.tty ?? false },
        stderr: { write: (c: string) => (stderr += c), isTTY: options.tty ?? false },
        stdin,
      },
    })
    return {
      code,
      stdout,
      stderr,
      json: () => JSON.parse(stdout),
      errorJson: () => JSON.parse(stderr.trim().split('\n').at(-1)!),
    }
  } finally {
    globalThis.fetch = realFetch
    for (const key of Object.keys(env)) if (!(key in previous)) delete process.env[key]
    Object.assign(process.env, previous)
  }
}

/**
 * Points the home folder and the settings folders at `dir` on every OS. Windows reads USERPROFILE
 * and APPDATA, not HOME, so setting HOME alone would let a test write into the real user folder.
 */
export function homeEnv(dir: string): Record<string, string> {
  return { HOME: dir, USERPROFILE: dir, APPDATA: join(dir, 'AppData', 'Roaming'), XDG_CONFIG_HOME: join(dir, '.config') }
}

/** Saves a session token as a profile's browser sign-in, in the credentials file of `configDir`. */
export function saveSignIn(configDir: string, token: string, profile = 'default'): void {
  const file = join(configDir, 'credentials.json')
  const all = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : {}
  all[profile] = { token, savedAt: new Date().toISOString(), method: 'web' }
  mkdirSync(configDir, { recursive: true })
  writeFileSync(file, JSON.stringify(all), { mode: 0o600 })
}

export function tokenFor(exp = Math.floor(Date.now() / 1000) + 30 * 86400): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256' })}.${b64({ sub: 1, email: 'a@b.c', exp })}.sig`
}

export const user = {
  id: 1,
  email: 'dev@example.com',
  displayName: null,
  profilePicture: null,
  emailVerified: true,
  isBusiness: false,
  googleConnected: false,
  paymentPlan: 'creator',
  subscriptionStatus: 'active',
  isZettaAdmin: false,
  earlyAccess: false,
  onboardingCompletedAt: null,
  credits: { threeD: { monthly: 500, purchased: 100, bonusMonthly: 0, bonus: 50 }, ai: { monthly: 1000, purchased: 0, bonusMonthly: 0, bonus: 0 } },
  createdAt: '2026-10-01T00:00:00.000Z',
}

export function generation(id: number, status = 'success', extra: Record<string, unknown> = {}) {
  return {
    id,
    status,
    selectedFeature: 'img23d',
    selectedModel: 'n25',
    jobSpec: {},
    title: null,
    tags: [],
    pipelineRunId: null,
    availability: 'private',
    inputPrompt: null,
    inputImages: [],
    thumbnailURL: null,
    faceCount: null,
    polygonType: null,
    result: status === 'success' ? { files: [{ type: 'glb', key: `gen3d/1/${id}/model.glb`, url: 'x', bytes: 4 }] } : null,
    errorMessage: status === 'failed' ? 'The picture could not be read.' : null,
    createdAt: '2026-10-20T10:00:00.000Z',
    updatedAt: '2026-10-20T10:01:00.000Z',
    ...extra,
  }
}
