/**
 * Installing the agent skill where each coding agent looks for it (Agent Skills format, a folder with
 * SKILL.md and references/):
 *
 *   ~/.claude/skills/zetta3d   Claude Code (Cursor reads it too)
 *   ~/.agents/skills/zetta3d   Codex and Cursor (the shared Agent Skills location)
 *
 * The folder is ours: every file is rewritten on update, files an older version wrote are removed,
 * and a marker records the version so a newer zetta can refresh it.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { homeDir } from '../core/paths'
import { SKILL_NAME } from '../guide'

export type Agent = 'claude' | 'codex' | 'cursor'
export type SkillTarget = 'claude' | 'agents'

export const AGENT_LABEL: Record<Agent, string> = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor' }

/** The skills folder each target means, under a home folder or a project. */
export const TARGET_FOLDER: Record<SkillTarget, string[]> = { claude: ['.claude', 'skills'], agents: ['.agents', 'skills'] }
const TARGET_OF: Record<Agent, SkillTarget> = { claude: 'claude', codex: 'agents', cursor: 'agents' }
const AGENTS_OF: Record<SkillTarget, Agent[]> = { claude: ['claude'], agents: ['codex', 'cursor'] }

export const MARKER = '.zetta-skill.json'

/** The agents on this machine, from the folders they keep in the home folder. */
export function detectAgents(env: NodeJS.ProcessEnv): Agent[] {
  const home = homeDir(env)
  return (['claude', 'codex', 'cursor'] as const).filter((agent) => existsSync(join(home, `.${agent}`)))
}

/** The folders that serve these agents, without duplicates (Codex and Cursor share one). */
export function targetsFor(agents: Agent[]): SkillTarget[] {
  return [...new Set(agents.map((agent) => TARGET_OF[agent]))]
}

/** Which of the given agents a target serves, as words: "Codex and Cursor". */
export function servedBy(target: SkillTarget, among?: Agent[]): string {
  const agents = AGENTS_OF[target].filter((agent) => !among || among.includes(agent))
  return (agents.length ? agents : AGENTS_OF[target]).map((agent) => AGENT_LABEL[agent]).join(' and ')
}

export function skillsFolder(root: string, target: SkillTarget): string {
  return join(root, ...TARGET_FOLDER[target])
}

/** The version recorded in an installed skill; null for one an older zetta wrote without a marker. */
export function installedVersion(dir: string): string | null | undefined {
  try {
    return (JSON.parse(readFileSync(join(dir, MARKER), 'utf8')) as { version?: string }).version ?? null
  } catch {
    return isOurs(dir) ? null : undefined
  }
}

/** True when a folder holds our skill (a marker, or a SKILL.md named zetta3d from before markers). */
export function isOurs(dir: string): boolean {
  if (existsSync(join(dir, MARKER))) return true
  try {
    return new RegExp(`^name:\\s*${SKILL_NAME}\\s*$`, 'm').test(readFileSync(join(dir, 'SKILL.md'), 'utf8'))
  } catch {
    return false
  }
}

function filesUnder(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? filesUnder(path, base) : [relative(base, path).split('\\').join('/')]
  })
}

export type WriteResult = 'created' | 'updated' | 'unchanged'

/** Writes the skill into <skillsFolder>/zetta3d and records the version. */
export function writeSkill(folder: string, files: Record<string, string>, version: string): { dir: string; result: WriteResult } {
  const dir = join(folder, SKILL_NAME)
  const existed = existsSync(join(dir, 'SKILL.md'))
  const managed = existsSync(join(dir, MARKER))
  let changed = false
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel)
    if (existsSync(path) && readFileSync(path, 'utf8') === content) continue
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
    changed = true
  }
  // Files an older version wrote that this one no longer has. Only in a folder that is provably ours.
  if (managed) {
    for (const rel of filesUnder(dir)) {
      if (rel === MARKER || rel in files) continue
      rmSync(join(dir, rel), { force: true })
      changed = true
    }
  }
  const marker = `${JSON.stringify({ version, installedBy: 'zetta' }, null, 2)}\n`
  if (!managed || readFileSync(join(dir, MARKER), 'utf8') !== marker) writeFileSync(join(dir, MARKER), marker)
  return { dir, result: !existed ? 'created' : changed ? 'updated' : 'unchanged' }
}

/** Removes our skill folder; leaves anything that is not ours alone. */
export function removeSkill(folder: string): { dir: string; removed: boolean; notOurs?: boolean } {
  const dir = join(folder, SKILL_NAME)
  if (!existsSync(dir)) return { dir, removed: false }
  if (!isOurs(dir)) return { dir, removed: false, notOurs: true }
  rmSync(dir, { recursive: true, force: true })
  return { dir, removed: true }
}
