import { z } from 'zod'
import { defineCommand } from '../core/define'
import { compareVersions, fetchLatest, isCompiledBinary, upgradeSelf } from '../upgrade'
import { VERSION } from '../version'

export const upgradeCommand = defineCommand({
  path: ['upgrade'],
  summary: 'Update zetta to the latest release (or a given version).',
  description: 'Downloads the binary for this machine, checks its SHA-256 and replaces this one. Use --check to only look.',
  kind: 'local',
  mcp: false,
  input: z.object({
    check: z.boolean().optional().describe('Only report whether a newer version exists.'),
    to: z.string().optional().describe('Install exactly this version, e.g. 0.2.0.'),
    force: z.boolean().optional().describe('Reinstall even if already on that version.'),
  }),
  async run(ctx, input) {
    if (input.check) {
      const latest = await fetchLatest()
      const newer = compareVersions(latest.version, VERSION) > 0
      return { current: VERSION, latest: latest.version, updateAvailable: newer }
    }
    if (!isCompiledBinary()) {
      return { current: VERSION, upgraded: false, note: 'Running from source; update with git pull (or reinstall: curl -fsSL https://zetta3d.ai/install.sh | sh).' }
    }
    const result = await upgradeSelf({
      ...(input.to ? { version: input.to } : {}),
      ...(input.force ? { force: true } : {}),
      onProgress: (message) => ctx.out.progress({ stage: 'upgrade', message }),
    })
    return result
  },
  text: (r: { current?: string; latest?: string; updateAvailable?: boolean; upgraded?: boolean; from?: string; to?: string; note?: string }) => {
    if (r.note) return r.note
    if (r.latest !== undefined) return r.updateAvailable ? `Update available: ${r.current} → ${r.latest}. Run \`zetta upgrade\`.` : `Up to date (${r.current}).`
    return r.upgraded ? `Updated ${r.from} → ${r.to}.` : `Already on ${r.to}.`
  },
})
