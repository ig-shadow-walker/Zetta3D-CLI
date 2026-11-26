import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { saveSignIn, tokenFor } from './harness'

/**
 * End to end over real stdio: the official MCP client starts `zetta mcp` as a child process,
 * against a small fake API on 127.0.0.1.
 */
const MAIN = join(import.meta.dirname, '..', 'src', 'main.ts')
const created: unknown[] = []
let api: Server
let apiUrl = ''

const generation = (status: string) => ({ id: 42, status, selectedFeature: 'txt23d', selectedModel: 'n1', title: null, tags: [], availability: 'private', result: null, errorMessage: null, createdAt: 'x', updatedAt: 'x' })

beforeAll(async () => {
  api = createServer((req, res) => {
    const send = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const url = req.url ?? ''
      if (url.startsWith('/api/3d/entitlements')) return send(404, {})
      if (url === '/api/3d/quote') return send(200, { credits: 28, lines: [{ code: 'textured', label: 'Textured', credits: 28 }] })
      if (url === '/api/3d/generations' && req.method === 'POST') {
        created.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        return send(201, { generation: generation('queued'), quote: { credits: 28, lines: [] }, charged: true })
      }
      if (url.startsWith('/api/auth/me')) return send(401, { code: 'INVALID_SESSION', message: 'Session expired' })
      send(404, { message: 'not found' })
    })
  })
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve))
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}/api`
})

afterAll(() => api.close())

/** A config folder holding a browser sign-in, for the server process. */
function signedInConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zmcp-'))
  saveSignIn(dir, tokenFor())
  return dir
}

async function connect(args: string[] = []): Promise<Client> {
  const transport = new StdioClientTransport({
    command: 'bun',
    args: ['run', MAIN, 'mcp', ...args],
    env: { ...(process.env as Record<string, string>), ZETTA_API_URL: apiUrl, ZETTA_API_KEY: '', ZETTA_TOKEN: '', ZETTA_CONFIG_DIR: signedInConfig(), ZETTA_NO_KEYCHAIN: '1' },
    stderr: 'ignore',
  })
  const client = new Client({ name: 'zetta-test-client', version: '1.0.0' })
  await client.connect(transport)
  return client
}

const text = (result: unknown) => JSON.parse(((result as { content: Array<{ text: string }> }).content[0]!).text)

describe('zetta mcp, through a real MCP client', () => {
  it('lists tools with schemas and server instructions', async () => {
    const client = await connect()
    try {
      const { tools } = await client.listTools()
      const names = tools.map((t) => t.name)
      expect(names).toEqual(expect.arrayContaining(['generate', 'asset_list', 'asset_wait', 'refine_rig', 'pipeline_batch']))
      expect(names).not.toContain('auth_login')
      const generate = tools.find((t) => t.name === 'generate')!
      expect(generate.inputSchema.properties).toHaveProperty('maxCredits')
      expect(generate.annotations?.readOnlyHint).toBe(false)
      expect(client.getInstructions()).toContain('asset_wait')
    } finally {
      await client.close()
    }
  }, 30_000)

  it('quotes with dryRun, refuses unconfirmed spending, and spends with maxCredits', async () => {
    const client = await connect()
    try {
      const dry = await client.callTool({ name: 'generate', arguments: { image: 'https://files.example/stool.png', dryRun: true } })
      expect(dry.isError).toBeFalsy()
      expect(text(dry)).toMatchObject({ dryRun: true, credits: 28 })

      const refused = await client.callTool({ name: 'generate', arguments: { image: 'https://files.example/stool.png' } })
      expect(refused.isError).toBe(true)
      expect(text(refused).error.code).toBe('SPEND_NOT_CONFIRMED')
      expect(created).toHaveLength(0)

      const spent = await client.callTool({ name: 'generate', arguments: { image: 'https://files.example/stool.png', maxCredits: 50 } })
      expect(spent.isError).toBeFalsy()
      expect(text(spent)).toMatchObject({ id: 42, status: 'queued', credits: 28 })
      expect(created).toHaveLength(1)
      expect(created[0]).toMatchObject({ imageUrl: 'https://files.example/stool.png', origin: 'cli' })
    } finally {
      await client.close()
    }
  }, 30_000)

  it('enforces the session budget', async () => {
    const client = await connect(['--budget', '30'])
    try {
      const first = await client.callTool({ name: 'generate', arguments: { image: 'https://files.example/cup.png' } })
      expect(first.isError).toBeFalsy()
      const second = await client.callTool({ name: 'generate', arguments: { image: 'https://files.example/cup.png' } })
      expect(second.isError).toBe(true)
      expect(text(second).error).toMatchObject({ code: 'SPEND_LIMIT' })
    } finally {
      await client.close()
    }
  }, 30_000)

  it('validates arguments and reports API errors as JSON', async () => {
    const client = await connect(['--read-only'])
    try {
      const bad = await client.callTool({ name: 'asset_get', arguments: { id: 'abc' } })
      expect(bad.isError).toBe(true)
      expect(text(bad).error.code).toBe('USAGE')
      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name)).not.toContain('generate')
    } finally {
      await client.close()
    }
  }, 30_000)
})
