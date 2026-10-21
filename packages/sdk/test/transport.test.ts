import { describe, expect, it } from 'vitest'
import { Transport, toQuery } from '../src/transport'
import { ZettaError, errorFromResponse } from '../src/errors'
import { fakeFetch, noSleep } from './fake-fetch'

describe('toQuery', () => {
  it('repeats array keys and drops empty values', () => {
    expect(toQuery({ status: ['queued', 'processing'], page: 2, search: '', x: undefined })).toBe('?status=queued&status=processing&page=2')
    expect(toQuery({})).toBe('')
  })
})

describe('errorFromResponse', () => {
  it('keeps the service code and extra fields', () => {
    const error = errorFromResponse(400, { message: 'Not enough credits.', code: 'INSUFFICIENT_CREDITS', required: 50, available: 10 })
    expect(error.code).toBe('INSUFFICIENT_CREDITS')
    expect(error.details).toEqual({ required: 50, available: 10 })
    expect(error.status).toBe(400)
  })
  it('turns validation arrays into VALIDATION_FAILED', () => {
    const error = errorFromResponse(400, { statusCode: 400, message: ['prompt must be a string', 'model must be one of'], error: 'Bad Request' })
    expect(error.code).toBe('VALIDATION_FAILED')
    expect(error.message).toBe('prompt must be a string; model must be one of')
    expect(error.details.problems).toHaveLength(2)
  })
  it('falls back to a status code for plain-string exceptions', () => {
    expect(errorFromResponse(404, { statusCode: 404, message: 'Not found', error: 'Not Found' }).code).toBe('NOT_FOUND')
    expect(errorFromResponse(503, 'upstream down').code).toBe('SERVER_ERROR')
    expect(errorFromResponse(429, { statusCode: 429, message: 'ThrottlerException: Too Many Requests' }).code).toBe('RATE_LIMITED')
  })
})

describe('Transport', () => {
  it('sends the bearer token and attribution headers, and no JSON type on body-less POSTs', async () => {
    const { fetch, calls } = fakeFetch([['POST https://api.test/api/x', { json: { ok: true } }]])
    const t = new Transport({ baseUrl: 'https://api.test/api/', token: () => 'tok', clientName: 'cli', userAgent: 'zetta-cli/1', fetch, sleep: noSleep })
    await t.request('POST', '/x')
    expect(calls[0]!.headers.authorization).toBe('Bearer tok')
    expect(calls[0]!.headers['x-zetta-client']).toBe('cli')
    expect(calls[0]!.headers['user-agent']).toBe('zetta-cli/1')
    expect(calls[0]!.headers['content-type']).toBeUndefined()
  })

  it('retries reads on 5xx but not unkeyed writes', async () => {
    const { fetch, calls } = fakeFetch([
      ['GET https://api.test/api/a', [{ status: 503, json: {} }, { json: { n: 1 } }]],
      ['POST https://api.test/api/b', [{ status: 502, json: {} }, { json: {} }]],
    ])
    const t = new Transport({ baseUrl: 'https://api.test/api', fetch, sleep: noSleep })
    expect(await t.request('GET', '/a')).toEqual({ n: 1 })
    await expect(t.request('POST', '/b', { body: {} })).rejects.toBeInstanceOf(ZettaError)
    expect(calls.filter((c) => c.url.endsWith('/b'))).toHaveLength(1)
  })

  it('retries keyed writes and always retries 429', async () => {
    const { fetch, calls } = fakeFetch([
      ['POST https://api.test/api/c', [{ status: 500, json: {} }, { json: { done: true } }]],
      ['POST https://api.test/api/d', [{ status: 429, json: {}, headers: { 'retry-after': '0' } }, { json: { done: true } }]],
    ])
    const t = new Transport({ baseUrl: 'https://api.test/api', fetch, sleep: noSleep })
    await t.request('POST', '/c', { body: {}, idempotencyKey: 'k1' })
    await t.request('POST', '/d', { body: {} })
    expect(calls.filter((c) => c.url.endsWith('/c'))).toHaveLength(2)
    expect(calls[0]!.headers['idempotency-key']).toBe('k1')
    expect(calls.filter((c) => c.url.endsWith('/d'))).toHaveLength(2)
  })

  it('reports network failures as NETWORK_ERROR', async () => {
    const fetch = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof globalThis.fetch
    const t = new Transport({ baseUrl: 'https://api.test/api', fetch, sleep: noSleep, retries: 0 })
    await expect(t.request('GET', '/x')).rejects.toMatchObject({ code: 'NETWORK_ERROR', status: 0 })
  })
})
