import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { cliError } from '../core/errors'

export interface LoopbackSession {
  /** The page to open: `<site>/plugin-auth?port=…&state=…&client=cli`. */
  url: string
  port: number
  /** Resolves with the token once the page posts it back. */
  token: Promise<string>
  close(): void
}

/**
 * The browser hand-off used by the desktop plugins.
 *
 * Listens on 127.0.0.1, opens the site's connect page with a random `state`, and waits for the
 * page to POST `{token, state}` (as text/plain, so no CORS preflight) to `/callback`. Only the
 * site's own origin is answered, and a wrong `state` is refused.
 */
export async function startLoopbackLogin(siteUrl: string, options: { timeoutMs?: number } = {}): Promise<LoopbackSession> {
  const state = randomBytes(24).toString('hex')
  const siteOrigin = new URL(siteUrl).origin
  let settle!: { resolve: (token: string) => void; reject: (error: Error) => void }
  const token = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject }
  })

  const server = createServer((req, res) => {
    void handle(req, res)
  })

  const cors = (req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin
    if (origin === siteOrigin) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
    }
    // Chrome's private-network rule: a public page may reach 127.0.0.1 only if we say so.
    if (req.headers['access-control-request-private-network']) res.setHeader('Access-Control-Allow-Private-Network', 'true')
    return origin === undefined || origin === siteOrigin
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const allowed = cors(req, res)
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      res.writeHead(allowed ? 204 : 403).end()
      return
    }
    if (req.method !== 'POST' || path !== '/callback' || !allowed) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found')
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    let body: { token?: unknown; state?: unknown }
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Bad request')
      return
    }
    if (body.state !== state || typeof body.token !== 'string' || !body.token) {
      res.writeHead(403, { 'Content-Type': 'text/plain' }).end('State mismatch')
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('Connected. You can close this tab.')
    settle.resolve(body.token)
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  const timer = setTimeout(
    () => settle.reject(cliError('LOGIN_TIMEOUT', 'Gave up waiting for the browser after 10 minutes.')),
    options.timeoutMs ?? 10 * 60_000,
  )
  const close = () => {
    clearTimeout(timer)
    server.close()
    server.closeAllConnections?.()
  }
  void token.then(close, close)

  const url = new URL('/plugin-auth', siteUrl)
  url.searchParams.set('port', String(port))
  url.searchParams.set('state', state)
  url.searchParams.set('client', 'cli')
  return {
    url: url.toString(),
    port,
    token,
    close: () => {
      settle.reject(cliError('LOGIN_CANCELLED', 'Sign-in was cancelled.'))
      close()
    },
  }
}
