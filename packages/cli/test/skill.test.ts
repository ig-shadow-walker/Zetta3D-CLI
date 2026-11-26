import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { refreshInstalledSkills, skillFiles } from '../src/skill/bundle'
import { SKILL_DOCS } from '../src/skill/docs.generated'
import { MARKER } from '../src/skill/install'
import { buildReferenceDocs } from '../src/skill/sources'
import { VERSION } from '../src/version'
import { homeEnv, zetta } from './harness'

const ROOT = join(import.meta.dirname, '..', '..', '..')

/** A home folder where the given agents look installed. */
function homeWith(...agents: string[]): string {
  const home = mkdtempSync(join(tmpdir(), 'zsk-'))
  for (const agent of agents) mkdirSync(join(home, `.${agent}`))
  return home
}
const claudeSkill = (home: string) => join(home, '.claude', 'skills', 'zetta3d')
const sharedSkill = (home: string) => join(home, '.agents', 'skills', 'zetta3d')
const version = (dir: string) => JSON.parse(readFileSync(join(dir, MARKER), 'utf8')).version

describe('the skill bundle', () => {
  it('is a valid Agent Skills folder: front matter, size and links', async () => {
    const files = await skillFiles()
    const skill = files['SKILL.md']!
    const front = /^---\n([\s\S]*?)\n---\n/.exec(skill)![1]!
    expect(front).toMatch(/^name: zetta3d$/m)
    const description = /^description: (.*)$/m.exec(front)![1]!
    expect(description.length).toBeGreaterThan(50)
    expect(description.length).toBeLessThanOrEqual(1024)
    expect(description).not.toContain(': ') // a plain YAML scalar must not contain ": "
    expect(front).toContain(`version: "${VERSION}"`)
    expect(skill.split('\n').length).toBeLessThan(500)
    for (const [file, text] of Object.entries(files)) {
      for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        if (/^(https?:|#|mailto:)/.test(target!)) continue
        const path = target!.split('#')[0]!
        const resolved = file.startsWith('references/') ? `references/${path}` : path
        expect(files, `${file} links to ${target}`).toHaveProperty([resolved])
      }
    }
    expect(Object.keys(files).sort()).toEqual(['SKILL.md', ...readdirSync(join(ROOT, 'skill', 'zetta3d', 'references')).map((f) => `references/${f}`)].sort())
  })

  it('is up to date with docs/ and the repository copy (run `bun run docs:commands`)', async () => {
    expect(SKILL_DOCS).toEqual(buildReferenceDocs((doc) => readFileSync(join(ROOT, 'docs', doc), 'utf8')))
    for (const [file, text] of Object.entries(await skillFiles())) {
      expect(readFileSync(join(ROOT, 'skill', 'zetta3d', file), 'utf8'), file).toBe(text)
    }
  })
})

describe('zetta skill install', () => {
  it('--auto installs for the agents it finds, once per folder', async () => {
    const home = homeWith('claude', 'codex', 'cursor')
    const run = await zetta(['skill', 'install', '--auto'], { env: homeEnv(home) })
    expect(run.code).toBe(0)
    expect(run.json().installed.map((i: { agents: string }) => i.agents)).toEqual(['Claude Code', 'Codex and Cursor'])
    for (const dir of [claudeSkill(home), sharedSkill(home)]) {
      expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toContain('name: zetta3d')
      expect(existsSync(join(dir, 'references', 'pipelines.md'))).toBe(true)
      expect(readFileSync(join(dir, 'references', 'commands.md'), 'utf8')).toContain('### `zetta refine retopo`')
      expect(version(dir)).toBe(VERSION)
    }
    const again = await zetta(['skill', 'install', '--auto'], { env: homeEnv(home) })
    expect(again.json().installed.map((i: { result: string }) => i.result)).toEqual(['unchanged', 'unchanged'])
  })

  it('--auto does nothing when no agent is found, or when turned off', async () => {
    const none = homeWith()
    const run = await zetta(['skill', 'install', '--auto'], { env: homeEnv(none) })
    expect(run.json()).toMatchObject({ installed: [] })
    expect(existsSync(join(none, '.agents'))).toBe(false)

    const home = homeWith('codex')
    const off = await zetta(['skill', 'install', '--auto'], { env: { ...homeEnv(home), ZETTA_NO_SKILL: '1' } })
    expect(off.json().installed).toEqual([])
    expect(existsSync(sharedSkill(home))).toBe(false)
  })

  it('uninstall removes it and keeps installers and upgrades from putting it back', async () => {
    const home = homeWith('claude')
    const configDir = mkdtempSync(join(tmpdir(), 'zskc-'))
    await zetta(['skill', 'install', '--auto'], { env: homeEnv(home), configDir })
    expect((await zetta(['skill', 'uninstall'], { env: homeEnv(home), configDir })).json().removed).toEqual([claudeSkill(home)])
    const auto = await zetta(['skill', 'install', '--auto'], { env: homeEnv(home), configDir })
    expect(auto.json().installed).toEqual([])
    expect(existsSync(claudeSkill(home))).toBe(false)
    // An explicit install turns it back on.
    await zetta(['skill', 'install'], { env: homeEnv(home), configDir })
    expect((await zetta(['config', 'get', 'skills.auto'], { configDir })).json().value).toBe(true)
    expect(existsSync(claudeSkill(home))).toBe(true)
  })

  it('removes files an older version left behind, but only in its own folder', async () => {
    const home = homeWith('codex')
    await zetta(['skill', 'install', '--auto'], { env: homeEnv(home) })
    writeFileSync(join(sharedSkill(home), 'references', 'retired-topic.md'), 'old')
    await zetta(['skill', 'install', '--auto'], { env: homeEnv(home) })
    expect(existsSync(join(sharedSkill(home), 'references', 'retired-topic.md'))).toBe(false)

    // A zetta3d folder that is not ours (no marker, another name) is never removed.
    const other = homeWith('codex')
    mkdirSync(sharedSkill(other), { recursive: true })
    writeFileSync(join(sharedSkill(other), 'SKILL.md'), '---\nname: something-else\n---\n')
    const run = await zetta(['skill', 'uninstall'], { env: homeEnv(other) })
    expect(run.json().skipped).toEqual([sharedSkill(other)])
    expect(existsSync(join(sharedSkill(other), 'SKILL.md'))).toBe(true)
  })

  it('--agent and --project pick the folders', async () => {
    const home = homeWith('claude', 'codex')
    await zetta(['skill', 'install', '--agent', 'cursor'], { env: homeEnv(home) })
    expect(existsSync(sharedSkill(home))).toBe(true)
    expect(existsSync(claudeSkill(home))).toBe(false)

    const project = mkdtempSync(join(tmpdir(), 'zskp-'))
    await zetta(['skill', 'install', '--project'], { env: homeEnv(home), cwd: project })
    expect(existsSync(join(project, '.claude', 'skills', 'zetta3d', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(project, '.agents', 'skills', 'zetta3d', 'SKILL.md'))).toBe(true)
  })

  it('status says where it is and whether it is current', async () => {
    const home = homeWith('claude', 'cursor')
    await zetta(['skill', 'install', '--auto'], { env: homeEnv(home) })
    const status = await zetta(['skill', 'status'], { env: homeEnv(home) })
    expect(status.json()).toMatchObject({ agentsFound: ['Claude Code', 'Cursor'], auto: true })
    expect(status.json().places.every((p: { installed: boolean; upToDate: boolean }) => p.installed && p.upToDate)).toBe(true)
  })
})

describe('keeping installed copies current', () => {
  it('a newer zetta refreshes stale copies and installs nowhere new', async () => {
    const home = homeWith('claude', 'codex')
    const env = { ...homeEnv(home), ZETTA_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'zskr-')) }
    // An older version's copy: an old marker and a file this version no longer has.
    mkdirSync(join(claudeSkill(home), 'references'), { recursive: true })
    writeFileSync(join(claudeSkill(home), 'SKILL.md'), '---\nname: zetta3d\n---\nold')
    writeFileSync(join(claudeSkill(home), 'references', 'gone.md'), 'old')
    writeFileSync(join(claudeSkill(home), MARKER), JSON.stringify({ version: '0.0.1' }))
    expect(await refreshInstalledSkills(env)).toEqual([claudeSkill(home)])
    expect(version(claudeSkill(home))).toBe(VERSION)
    expect(readFileSync(join(claudeSkill(home), 'SKILL.md'), 'utf8')).toContain('zetta asset wait')
    expect(existsSync(join(claudeSkill(home), 'references', 'gone.md'))).toBe(false)
    expect(existsSync(sharedSkill(home))).toBe(false)
    expect(await refreshInstalledSkills(env)).toEqual([])
  })

  it('a copy from before markers (a bare SKILL.md) counts as stale', async () => {
    const home = homeWith('claude')
    mkdirSync(claudeSkill(home), { recursive: true })
    writeFileSync(join(claudeSkill(home), 'SKILL.md'), '---\nname: zetta3d\ndescription: old\n---\n')
    expect(await refreshInstalledSkills({ ...homeEnv(home), ZETTA_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'zskr-')) })).toEqual([claudeSkill(home)])
    expect(existsSync(join(claudeSkill(home), 'references', 'commands.md'))).toBe(true)
  })
})

describe('reading the skill without installing it', () => {
  it('zetta skill show and zetta guide <topic> print its files', async () => {
    const list = await zetta(['skill', 'show', '--list'])
    expect(list.json().files).toContain('references/pipelines.md')
    const file = await zetta(['skill', 'show', '--file', 'pipelines'])
    expect(file.json().markdown).toContain('seed_views')
    const topic = await zetta(['guide', 'errors'])
    expect(topic.json().guide).toContain('PLAN_REQUIRED')
    const guide = await zetta(['guide'])
    expect(guide.json().guide).toContain('zetta guide pipelines')
    expect(guide.json().guide).not.toContain('references/')
  })
})
