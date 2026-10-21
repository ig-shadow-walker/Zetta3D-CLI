import { describe, expect, it } from 'vitest'
import { startLoopbackLogin } from '../src/auth/loopback'

describe('browser hand-off', () => {
  it('accepts the token from the site with the right state, and answers the private-network preflight', async () => {
    const session = await startLoopbackLogin('https://zetta3d.ai')
    const url = new URL(session.url)
    expect(url.origin + url.pathname).toBe('https://zetta3d.ai/plugin-auth')
    expect(url.searchParams.get('client')).toBe('cli')
    const port = url.searchParams.get('port')
    const state = url.searchParams.get('state')!

    const preflight = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://zetta3d.ai', 'Access-Control-Request-Private-Network': 'true', 'Access-Control-Request-Method': 'POST' },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-private-network')).toBe('true')
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://zetta3d.ai')

    const wrong = await fetch(`http://127.0.0.1:${port}/callback`, { method: 'POST', headers: { Origin: 'https://zetta3d.ai', 'Content-Type': 'text/plain' }, body: JSON.stringify({ token: 't', state: 'nope' }) })
    expect(wrong.status).toBe(403)
    const evil = await fetch(`http://127.0.0.1:${port}/callback`, { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'text/plain' }, body: JSON.stringify({ token: 't', state }) })
    expect(evil.status).toBe(404)

    const ok = await fetch(`http://127.0.0.1:${port}/callback`, { method: 'POST', headers: { Origin: 'https://zetta3d.ai', 'Content-Type': 'text/plain' }, body: JSON.stringify({ token: 'the-token', state }) })
    expect(ok.status).toBe(200)
    expect(await session.token).toBe('the-token')
  })

  it('times out', async () => {
    const session = await startLoopbackLogin('https://zetta3d.ai', { timeoutMs: 20 })
    await expect(session.token).rejects.toMatchObject({ code: 'LOGIN_TIMEOUT' })
  })
})
