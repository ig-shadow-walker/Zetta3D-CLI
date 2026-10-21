export interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

type Reply = { status?: number; json?: unknown; text?: string; headers?: Record<string, string> } | (() => never)

/** A scripted `fetch`: each request takes the next reply whose matcher fits. */
export function fakeFetch(routes: Array<[match: string | RegExp, reply: Reply | Reply[]]>) {
  const calls: Call[] = []
  const queues = routes.map(([match, reply]) => ({ match, replies: Array.isArray(reply) ? [...reply] : [reply], sticky: !Array.isArray(reply) }))
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
    let body: unknown = init?.body
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body)
      } catch {
        // leave as text
      }
    }
    calls.push({ url, method, headers, body })
    const key = `${method} ${url}`
    const route = queues.find((q) => (typeof q.match === 'string' ? key.includes(q.match) : q.match.test(key)) && q.replies.length)
    if (!route) throw new Error(`fakeFetch: no route for ${key}`)
    const reply = route.sticky ? route.replies[0]! : route.replies.shift()!
    if (typeof reply === 'function') reply()
    const r = reply as Exclude<Reply, () => never>
    const text = r.text ?? (r.json === undefined ? '' : JSON.stringify(r.json))
    return new Response(r.status === 204 ? null : text, {
      status: r.status ?? 200,
      headers: { 'content-type': r.json === undefined ? 'text/plain' : 'application/json', ...r.headers },
    })
  }) as typeof fetch
  return { fetch: impl, calls }
}

export const noSleep = async () => {}
