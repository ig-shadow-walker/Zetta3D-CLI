import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where config and the fallback credential file live. `ZETTA_CONFIG_DIR` overrides it (tests, CI). */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ZETTA_CONFIG_DIR) return env.ZETTA_CONFIG_DIR
  if (process.platform === 'win32') return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'zetta3d')
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'zetta3d')
}
