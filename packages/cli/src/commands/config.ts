import { z } from 'zod'
import { BUILT_IN_PROFILES, CONFIG_KEYS } from '../core/config'
import { defineCommand } from '../core/define'
import { usageError } from '../core/errors'
import { table } from '../core/output'

export const configList = defineCommand({
  path: ['config', 'list'],
  summary: 'Show every setting and the active profile.',
  kind: 'local',
  input: z.object({}),
  async run(ctx) {
    return {
      path: ctx.config.path,
      profile: ctx.profileName,
      apiUrl: ctx.profile.apiUrl,
      siteUrl: ctx.profile.siteUrl,
      settings: Object.fromEntries(Object.keys(CONFIG_KEYS).map((key) => [key, ctx.config.get(key) ?? null])),
    }
  },
  text: (r: { path: string; profile: string; apiUrl: string; settings: Record<string, unknown> }) =>
    [
      `Config: ${r.path}`,
      `Profile: ${r.profile} (${r.apiUrl})`,
      table(Object.entries(r.settings).map(([key, value]) => ({ key, value: value ?? '(default)', meaning: CONFIG_KEYS[key]?.description }))),
    ].join('\n'),
})

export const configGet = defineCommand({
  path: ['config', 'get'],
  summary: 'Read one setting.',
  kind: 'local',
  positionals: [{ name: 'key', required: true }],
  input: z.object({ key: z.enum(Object.keys(CONFIG_KEYS) as [string, ...string[]]).describe('The setting.') }),
  async run(ctx, input) {
    return { key: input.key, value: ctx.config.get(input.key) ?? null }
  },
  text: (r: { value: unknown }) => (r.value === null ? '(default)' : String(r.value)),
})

export const configSet = defineCommand({
  path: ['config', 'set'],
  summary: 'Change a setting (e.g. spend.maxPerCommand 200).',
  kind: 'local',
  mcp: false,
  positionals: [
    { name: 'key', required: true },
    { name: 'value', required: true },
  ],
  input: z.object({
    key: z.enum(Object.keys(CONFIG_KEYS) as [string, ...string[]]).describe('The setting.'),
    value: z.string().describe('The new value.'),
  }),
  examples: ['zetta config set spend.maxPerCommand 200', 'zetta config set defaults.wait true', 'zetta config set output json'],
  async run(ctx, input) {
    if (input.key === 'currentProfile' && !ctx.config.profileNames().includes(input.value)) {
      throw usageError(`There is no profile called "${input.value}".`)
    }
    const value = ctx.config.set(input.key, input.value)
    ctx.config.save()
    return { key: input.key, value }
  },
  text: (r: { key: string; value: unknown }) => `${r.key} = ${String(r.value)}`,
})

export const configUnset = defineCommand({
  path: ['config', 'unset'],
  summary: 'Reset a setting to its default.',
  kind: 'local',
  mcp: false,
  positionals: [{ name: 'key', required: true }],
  input: z.object({ key: z.enum(Object.keys(CONFIG_KEYS) as [string, ...string[]]).describe('The setting.') }),
  async run(ctx, input) {
    ctx.config.set(input.key, undefined)
    ctx.config.save()
    return { key: input.key, value: null }
  },
  text: (r: { key: string }) => `${r.key} reset to its default.`,
})

export const configProfiles = defineCommand({
  path: ['config', 'profiles'],
  summary: 'List profiles (each has its own API address and sign-in).',
  kind: 'local',
  input: z.object({}),
  async run(ctx) {
    const profiles = await Promise.all(
      ctx.config.profileNames().map(async (name) => {
        const { profile } = ctx.config.resolveProfile(name, {})
        // Saved sign-ins only: a ZETTA_API_KEY in the environment belongs to no one profile.
        const stored = await ctx.credentials.get(name, { ignoreEnv: true }).catch(() => undefined)
        return {
          name,
          active: name === ctx.profileName,
          apiUrl: profile.apiUrl,
          siteUrl: profile.siteUrl,
          builtIn: name in BUILT_IN_PROFILES,
          signedInAs: stored ? (stored.credential.email ?? 'yes') : null,
        }
      }),
    )
    return { profiles }
  },
  text: (r: { profiles: Array<Record<string, unknown>> }) =>
    table(r.profiles.map((p) => ({ ...p, active: p.active ? '*' : '' })), [['active', ''], 'name', 'apiUrl', ['signedInAs', 'signed in as']]),
})

export const configAddProfile = defineCommand({
  path: ['config', 'add-profile'],
  summary: 'Add or change a profile (e.g. a staging server).',
  kind: 'local',
  mcp: false,
  positionals: [{ name: 'name', required: true }],
  input: z.object({
    name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, 'use lower-case letters, digits, - and _').describe('Profile name.'),
    api: z.string().url().describe('API address, ending in /api.'),
    site: z.string().url().optional().describe('Website address used for browser sign-in.'),
    use: z.boolean().optional().describe('Make it the active profile.'),
  }),
  examples: ['zetta config add-profile staging --api https://staging-api.example.com/api --site https://staging.example.com'],
  async run(ctx, input) {
    ctx.config.setProfile(input.name, { apiUrl: input.api.replace(/\/+$/, ''), ...(input.site ? { siteUrl: input.site.replace(/\/+$/, '') } : {}) })
    if (input.use) ctx.config.set('currentProfile', input.name)
    ctx.config.save()
    return { profile: input.name, active: Boolean(input.use) }
  },
  text: (r: { profile: string; active: boolean }) => `Saved profile "${r.profile}"${r.active ? ' and made it active' : ''}.`,
})

export const configRemoveProfile = defineCommand({
  path: ['config', 'remove-profile'],
  summary: 'Remove a profile you added, and its saved sign-in.',
  kind: 'local',
  mcp: false,
  positionals: [{ name: 'name', required: true }],
  input: z.object({ name: z.string().describe('Profile name.') }),
  async run(ctx, input) {
    if (input.name in BUILT_IN_PROFILES) throw usageError(`"${input.name}" is built in and cannot be removed.`)
    const removed = ctx.config.removeProfile(input.name)
    ctx.config.save()
    await ctx.credentials.delete(input.name)
    return { profile: input.name, removed }
  },
  text: (r: { profile: string; removed: boolean }) => (r.removed ? `Removed "${r.profile}".` : `No profile called "${r.profile}".`),
})

export const configUse = defineCommand({
  path: ['config', 'use'],
  summary: 'Switch the active profile.',
  kind: 'local',
  mcp: false,
  positionals: [{ name: 'name', required: true }],
  input: z.object({ name: z.string().describe('Profile name.') }),
  async run(ctx, input) {
    if (!ctx.config.profileNames().includes(input.name)) throw usageError(`There is no profile called "${input.name}".`)
    ctx.config.set('currentProfile', input.name)
    ctx.config.save()
    return { profile: input.name }
  },
  text: (r: { profile: string }) => `Now using profile "${r.profile}".`,
})

export const configCommands = [configList, configGet, configSet, configUnset, configProfiles, configAddProfile, configRemoveProfile, configUse]
