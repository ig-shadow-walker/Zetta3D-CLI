import { z } from 'zod'
import { defineCommand } from '../core/define'
import { registry } from './meta'

export const mcpCommand = defineCommand({
  path: ['mcp'],
  summary: 'Run Zetta 3D as an MCP server over stdio, for AI assistants.',
  description: [
    'Every command becomes a tool with the same inputs, checks and spend guard.',
    'Paid tools need yes/maxCredits per call, or a --budget for the whole session.',
    '',
    'Add it to an MCP client, e.g.:',
    '  claude mcp add zetta3d -- zetta mcp --budget 500',
    '  { "mcpServers": { "zetta3d": { "command": "zetta", "args": ["mcp", "--budget", "500"] } } }',
  ].join('\n'),
  kind: 'local',
  mcp: false,
  input: z.object({
    budget: z.number().int().min(0).optional().describe('Credits the session may spend in total without per-call confirmation.'),
    readOnly: z.boolean().optional().describe('Offer only tools that look and never change anything.'),
  }),
  examples: ['zetta mcp --budget 500', 'zetta mcp --read-only'],
  async run(ctx, input) {
    // Loaded only here: the MCP library is the heaviest dependency and no other command needs it.
    const { runMcpServer } = await import('../mcp/server')
    await runMcpServer({
      commands: registry.commands,
      globals: { profile: ctx.profileName, apiUrl: ctx.profile.apiUrl },
      ...(input.budget !== undefined ? { budget: input.budget } : {}),
      readOnly: Boolean(input.readOnly),
    })
    return undefined
  },
})
