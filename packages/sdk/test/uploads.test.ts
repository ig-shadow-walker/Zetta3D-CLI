import { describe, expect, it } from 'vitest'
import { Transport } from '../src/transport'
import { UPLOAD_PIECE_BYTES, Uploads } from '../src/uploads'
import { fakeFetch, noSleep } from './fake-fetch'

const ticket = (n: number) => ({
  uploadUrl: `https://api.test/api/3d/uploads/relay?ticket=t${n}`,
  method: 'PUT',
  headers: { 'Content-Type': 'image/png' },
  key: `inputImg/1/k${n}.png`,
  fileUrl: `https://files.test/k${n}.png`,
})

describe('Uploads', () => {
  it('sends small files in one PUT without a bearer token', async () => {
    const { fetch, calls } = fakeFetch([
      [/^POST https:\/\/api\.test\/api\/3d\/uploads$/, { json: ticket(1) }],
      ['PUT https://api.test/api/3d/uploads/relay?ticket=t1', { json: { key: 'k1', bytes: 3 } }],
    ])
    const transport = new Transport({ baseUrl: 'https://api.test/api', token: 'tok', fetch, sleep: noSleep })
    const uploads = new Uploads(transport, fetch, noSleep)
    const result = await uploads.upload(new Blob([new Uint8Array([1, 2, 3])]), { contentType: 'image/png' })
    expect(result).toEqual({ key: 'inputImg/1/k1.png', fileUrl: 'https://files.test/k1.png', bytes: 3, contentType: 'image/png' })
    const put = calls.find((c) => c.method === 'PUT')!
    expect(put.headers.authorization).toBeUndefined()
    expect(put.headers['content-type']).toBe('image/png')
  })

  it('uses multipart above the piece size', async () => {
    const { fetch, calls } = fakeFetch([
      [/^POST https:\/\/api\.test\/api\/3d\/uploads$/, { json: ticket(1) }],
      ['POST https://api.test/api/3d/uploads/relay/multipart?ticket=t1', { json: { uploadId: 'u1' } }],
      ['PUT https://api.test/api/3d/uploads/relay/multipart/part', { json: { part: 1 } }],
      ['POST https://api.test/api/3d/uploads/relay/multipart/complete', { json: { key: 'k1' } }],
    ])
    const uploads = new Uploads(new Transport({ baseUrl: 'https://api.test/api', fetch, sleep: noSleep }), fetch, noSleep)
    const size = UPLOAD_PIECE_BYTES * 2 + 10
    const seen: number[] = []
    await uploads.upload(new Blob([new Uint8Array(size)]), { contentType: 'image/png', onProgress: (p) => seen.push(p.sentBytes) })
    const parts = calls.filter((c) => c.url.includes('/multipart/part'))
    expect(parts.map((c) => new URL(c.url).searchParams.get('part'))).toEqual(['1', '2', '3'])
    const complete = calls.find((c) => c.url.includes('/complete'))!
    expect(new URL(complete.url).searchParams.get('parts')).toBe('3')
    expect(new URL(complete.url).searchParams.get('bytes')).toBe(String(size))
    expect(seen.at(-1)).toBe(size)
  })

  it('replaces an expired ticket once', async () => {
    const { fetch, calls } = fakeFetch([
      [/^POST https:\/\/api\.test\/api\/3d\/uploads$/, [{ json: ticket(1) }, { json: ticket(2) }]],
      ['PUT https://api.test/api/3d/uploads/relay?ticket=t1', { status: 410, json: {} }],
      ['PUT https://api.test/api/3d/uploads/relay?ticket=t2', { json: {} }],
    ])
    const uploads = new Uploads(new Transport({ baseUrl: 'https://api.test/api', fetch, sleep: noSleep }), fetch, noSleep)
    const result = await uploads.upload(new Blob([new Uint8Array(4)]), { contentType: 'image/png' })
    expect(result.key).toBe('inputImg/1/k2.png')
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2)
  })

  it('reports a refused upload with the server message', async () => {
    const { fetch } = fakeFetch([
      [/^POST https:\/\/api\.test\/api\/3d\/uploads$/, { json: ticket(1) }],
      ['PUT https://api.test/api/3d/uploads/relay?ticket=t1', { status: 413, json: { message: 'Too big' } }],
    ])
    const uploads = new Uploads(new Transport({ baseUrl: 'https://api.test/api', fetch, sleep: noSleep }), fetch, noSleep)
    await expect(uploads.upload(new Blob([new Uint8Array(4)]), { contentType: 'image/png' })).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' })
  })
})
