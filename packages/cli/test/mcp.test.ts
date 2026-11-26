import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COMMANDS } from '../src/commands'
import { Context } from '../src/core/context'
import { authorizeSpend } from '../src/core/spend'
import { mcpTools, toolDefinition, toolName } from '../src/mcp/server'

const quiet = { write: () => true, isTTY: false }
const mcpContext = (budget?: number) =>
  new Context({ mode: 'mcp', env: { ZETTA_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'zm-')), ZETTA_NO_KEYCHAIN: '1' }, streams: { stdout: quiet, stderr: quiet }, ...(budget !== undefined ? { budget: { remaining: budget } } : {}) })

describe('MCP tools', () => {
  it('exposes API commands but not local, sign-in or account-deletion ones', () => {
    const names = mcpTools(COMMANDS).map(toolName)
    expect(names).toContain('generate')
    expect(names).toContain('asset_list')
    expect(names).toContain('refine_rig')
    expect(names).not.toContain('auth_login')
    expect(names).not.toContain('auth_token')
    expect(names).not.toContain('account_delete')
    expect(names).not.toContain('config_set')
    expect(names).not.toContain('mcp')
  })

  it('never offers a tool that returns a new API key or charges a card', () => {
    const names = mcpTools(COMMANDS).map(toolName)
    expect(names).toContain('apikey_list')
    expect(names).toContain('account_redeem')
    expect(names).toContain('billing_checkout')
    expect(names).not.toContain('apikey_create')
    expect(names).not.toContain('billing_agent_plan')
  })

  it('offers only read tools in read-only mode', () => {
    const tools = mcpTools(COMMANDS, true)
    expect(tools.every((t) => t.kind === 'read')).toBe(true)
    expect(tools.map(toolName)).not.toContain('generate')
  })

  it('describes tools with JSON Schema and honest annotations', () => {
    const generate = toolDefinition(COMMANDS.find((c) => toolName(c) === 'generate')!)
    expect(generate.inputSchema.type).toBe('object')
    expect(generate.description).toContain('Spends credits')
    expect(generate.annotations.readOnlyHint).toBe(false)
    const del = toolDefinition(COMMANDS.find((c) => toolName(c) === 'asset_delete')!)
    expect(del.annotations.destructiveHint).toBe(true)
  })
})

describe('spend guard in MCP sessions', () => {
  const quote = { credits: 50, lines: [] }
  it('needs yes or maxCredits without a budget', async () => {
    await expect(authorizeSpend(mcpContext(), quote, {}, 'x')).rejects.toMatchObject({ code: 'SPEND_NOT_CONFIRMED' })
    await expect(authorizeSpend(mcpContext(), quote, { maxCredits: 60 }, 'x')).resolves.toEqual({ go: true })
  })
  it('spends from the session budget and refuses past it', async () => {
    const ctx = mcpContext(80)
    await expect(authorizeSpend(ctx, quote, {}, 'x')).resolves.toEqual({ go: true })
    expect(ctx.budget!.remaining).toBe(30)
    await expect(authorizeSpend(ctx, quote, { yes: true }, 'x')).rejects.toMatchObject({ code: 'SPEND_LIMIT' })
  })
  it('never spends on a dry run', async () => {
    const ctx = mcpContext(80)
    await expect(authorizeSpend(ctx, quote, { dryRun: true, yes: true }, 'x')).resolves.toEqual({ go: false, dryRun: true })
    expect(ctx.budget!.remaining).toBe(80)
  })
})
