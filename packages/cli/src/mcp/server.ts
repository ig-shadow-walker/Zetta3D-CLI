import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { Context, type GlobalOptions } from '../core/context'
import { inputJsonSchema, toolName, type AnyCommand } from '../core/define'
import { toErrorEnvelope } from '../core/output'
import { parseInput } from '../core/program'
import { knownUpdate, refreshUpdateCheck } from '../update-notice'
import { VERSION } from '../version'

export interface McpOptions {
  commands: AnyCommand[]
  globals: GlobalOptions
  /** Credits this session may spend in total. Without it, each paid call needs `yes` or `maxCredits`. */
  budget?: number
  readOnly?: boolean
  env?: NodeJS.ProcessEnv
}

export const MCP_INSTRUCTIONS = `Zetta 3D tools: generate 3D models from text or pictures, refine them (retopology, segmentation, UVs, texturing, rigging, conversion), make pictures, and run pipelines.

- Start with account_show (credits) and catalog_entitlements (what the plan allows).
- Paid tools quote first. Pass dryRun: true to see the price; pass yes: true or maxCredits: <n> to spend. Every call returns the asset id.
- Jobs take minutes. Do not wait in one call: start the job, then call asset_wait with timeout "50s" until status is success (or failed). Use out: "<folder>" to download files; tools return file paths.
- Local files: pass paths (pictures, GLB, video). Library pictures: "image:<id>". Library models: their numeric id.
- Errors are JSON with a code, a message and a hint naming the next step.`

/** Tool name for a command: path joined with underscores (`asset list` → `asset_list`). */
export { toolName }

export function mcpTools(commands: AnyCommand[], readOnly = false): AnyCommand[] {
  return commands.filter((c) => c.mcp !== false && c.kind !== 'local' && (!readOnly || c.kind === 'read'))
}

export function toolDefinition(command: AnyCommand) {
  const notes: string[] = []
  if (command.kind === 'spend') notes.push('Spends credits: returns a quote with dryRun: true; needs yes: true or maxCredits (or the session budget).')
  if (command.kind === 'destructive') notes.push('Destructive: cannot be undone.')
  return {
    name: toolName(command),
    title: `zetta ${command.path.join(' ')}`,
    description: [command.summary, command.description, ...notes].filter(Boolean).join('\n\n'),
    inputSchema: inputJsonSchema(command) as { type: 'object'; [key: string]: unknown },
    annotations: {
      title: command.summary,
      readOnlyHint: command.kind === 'read',
      destructiveHint: command.kind === 'destructive',
      idempotentHint: command.kind === 'read',
      openWorldHint: true,
    },
  }
}

export async function runMcpServer(options: McpOptions): Promise<void> {
  const tools = mcpTools(options.commands, options.readOnly)
  const byName = new Map(tools.map((tool) => [toolName(tool), tool]))
  const budget = options.budget !== undefined ? { remaining: options.budget } : undefined
  // stdout belongs to the protocol; anything a command prints goes to stderr.
  const streams = { stdout: process.stderr, stderr: process.stderr }

  // A newer zetta the last check found goes into the instructions, so the agent can tell the user.
  // The check itself runs in the background, for the next session.
  const update = knownUpdate(options.env ?? process.env)
  void refreshUpdateCheck(options.env ?? process.env)
  const instructions = update
    ? `${MCP_INSTRUCTIONS}\n- zetta ${update.latest} is available (this server runs ${update.current}). Tell the user once; they update with: ${update.upgradeWith}`
    : MCP_INSTRUCTIONS
  const server = new Server({ name: 'zetta3d', version: VERSION, title: 'Zetta 3D' }, { capabilities: { tools: {} }, instructions })

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(toolDefinition) }))

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const command = byName.get(request.params.name)
    if (!command) {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: { code: 'UNKNOWN_TOOL', message: `No tool called ${request.params.name}.` } }) }] }
    }
    const progressToken = request.params._meta?.progressToken
    let step = 0
    const ctx = new Context({
      globals: options.globals,
      env: options.env ?? process.env,
      streams,
      mode: 'mcp',
      signal: extra.signal,
      ...(budget ? { budget } : {}),
      onProgress: (event) => {
        if (progressToken === undefined) return
        step += 1
        void extra.sendNotification({ method: 'notifications/progress', params: { progressToken, progress: step, message: event.message } }).catch(() => undefined)
      },
    })
    try {
      const input = parseInput(command, (request.params.arguments ?? {}) as Record<string, unknown>)
      const data = await command.run(ctx, input)
      const result = data ?? { ok: true }
      const exitCode = (result as { exitCode?: number }).exitCode
      return {
        ...(exitCode && exitCode !== 0 ? { isError: true } : {}),
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      }
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(toErrorEnvelope(error), null, 2) }] }
    }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve()
    process.stdin.on('end', () => resolve())
  })
}
