import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The user's home folder: USERPROFILE on Windows, HOME elsewhere, then the system's answer.
 * Read from `env` so tests and sandboxes can move it (os.homedir() ignores HOME on Windows).
 */
export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  return (process.platform === 'win32' ? env.USERPROFILE : env.HOME) || homedir()
}

/** Windows' per-user settings folder (%APPDATA%). */
export function appDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.APPDATA || join(homeDir(env), 'AppData', 'Roaming')
}

/** Where config and the fallback credential file live. `ZETTA_CONFIG_DIR` overrides it (tests, CI). */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ZETTA_CONFIG_DIR) return env.ZETTA_CONFIG_DIR
  if (process.platform === 'win32') return join(appDataDir(env), 'zetta3d')
  return join(env.XDG_CONFIG_HOME || join(homeDir(env), '.config'), 'zetta3d')
}
