import { join } from 'node:path'
import { ConfigStore } from '../core/config'
import { configDir, homeDir } from '../core/paths'
import { SKILL_NAME, skillMarkdown } from '../guide'
import { VERSION } from '../version'
import { SKILL_DOCS } from './docs.generated'
import { installedVersion, skillsFolder, writeSkill, type SkillTarget } from './install'
import { commandReference } from './reference'

/** Every file of the skill for this version: SKILL.md and references/. */
export async function skillFiles(version: string = VERSION): Promise<Record<string, string>> {
  // Loaded here: the commands module includes the skill commands, which include this file.
  const { COMMANDS, GROUPS } = await import('../commands')
  return {
    'SKILL.md': skillMarkdown(version),
    ...Object.fromEntries(Object.entries(SKILL_DOCS).map(([file, text]) => [`references/${file}`, text])),
    'references/commands.md': commandReference(COMMANDS, GROUPS),
  }
}

/** Off when the user said so: `skills.auto false` (set by `zetta skill uninstall`) or ZETTA_NO_SKILL=1. */
export function autoSkillsOff(env: NodeJS.ProcessEnv): boolean {
  if (env.ZETTA_NO_SKILL === '1') return true
  try {
    return new ConfigStore(configDir(env)).file.skills?.auto === false
  } catch {
    return false
  }
}

/**
 * Brings installed copies of the skill up to this version, after an upgrade by any route (the
 * installers, `zetta upgrade`, Homebrew, npm). Cheap when nothing is stale: one small file read per
 * location. Never installs anywhere new and never throws.
 */
export async function refreshInstalledSkills(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  try {
    if (autoSkillsOff(env)) return []
    const home = homeDir(env)
    const stale = (['claude', 'agents'] as SkillTarget[])
      .map((target) => skillsFolder(home, target))
      .filter((folder) => {
        const version = installedVersion(join(folder, SKILL_NAME))
        return version !== undefined && version !== VERSION
      })
    if (!stale.length) return []
    const files = await skillFiles()
    return stale.map((folder) => writeSkill(folder, files, VERSION).dir)
  } catch {
    return []
  }
}
