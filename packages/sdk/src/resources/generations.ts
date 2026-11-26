import { LocalErrorCodes, ZettaError } from '../errors'
import type { Transport } from '../transport'
import {
  TERMINAL_STATUSES,
  type CreateGenerationResponse,
  type DownloadLink,
  type Generation,
  type GenerationDetail,
  type ListGenerationsQuery,
  type Page,
  type ResultFile,
  type ResultUploadTicket,
  type UpdateGenerationInput,
} from '../types'

export interface WaitOptions {
  /** Poll interval; the web app uses 2.5 s. */
  intervalMs?: number
  /** Give up after this long and throw WAIT_TIMEOUT (the job keeps running). */
  timeoutMs?: number
  signal?: AbortSignal
  onUpdate?: (detail: GenerationDetail) => void
}

export class Generations {
  constructor(
    private readonly transport: Transport,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  list(query: ListGenerationsQuery = {}): Promise<Page<Generation>> {
    return this.transport.request('GET', '/3d/generations', { query: query as Record<string, never> })
  }

  get(id: number): Promise<GenerationDetail> {
    return this.transport.request('GET', `/3d/generations/${id}`)
  }

  /**
   * Creates and charges a job: a generation, a finishing tool or a world export.
   *
   * Always sends an idempotency key, so a retried request is never charged twice; reuse the
   * same key to retry safely. `charged: false` in the answer means it was a replay.
   */
  create(body: object, idempotencyKey: string = crypto.randomUUID()): Promise<CreateGenerationResponse> {
    return this.transport.request('POST', '/3d/generations', { body, idempotencyKey, timeoutMs: 120_000 })
  }

  update(id: number, input: UpdateGenerationInput): Promise<Generation> {
    return this.transport
      .request<{ generation: Generation }>('PATCH', `/3d/generations/${id}`, { body: input })
      .then((r) => r.generation)
  }

  /** Cancels a job that has not started yet (full refund). */
  cancel(id: number): Promise<Generation> {
    return this.transport
      .request<{ generation: Generation }>('POST', `/3d/generations/${id}/cancel`, { retry: 'never' })
      .then((r) => r.generation)
  }

  /** Deletes an item and its files. A job that is already running is not refunded. */
  delete(id: number): Promise<void> {
    return this.transport.request('DELETE', `/3d/generations/${id}`)
  }

  /** A fresh signed URL (about 15 minutes) for one result file; without `key`, the main model. */
  downloadLink(id: number, key?: string): Promise<DownloadLink> {
    return this.transport.request('GET', `/3d/generations/${id}/download`, { query: { key } })
  }

  /**
   * A ticket to overwrite one of this item's own result files: its GLB, part `part` of a
   * segmentation (counting from 0), or its one FBX with `format: 'fbx'`. Send the bytes with
   * `uploads.send`, or use `uploads.replaceResult`, which does both.
   */
  resultUpload(id: number, input: { part?: number; format?: 'glb' | 'fbx' } = {}): Promise<ResultUploadTicket> {
    return this.transport.request('POST', `/3d/generations/${id}/result-upload`, { body: input, retry: 'never' })
  }

  /** A shared (public) item, readable without signing in. */
  async getPublic(id: number): Promise<Generation> {
    const result = await this.transport.request<{ generation: Generation }>('GET', `/3d/public/generations/${id}`, { auth: false })
    return result.generation
  }

  async featured(limit?: number): Promise<Generation[]> {
    const result = await this.transport.request<{ generations: Generation[] }>('GET', '/3d/public/featured', {
      auth: false,
      query: { limit },
    })
    return result.generations
  }

  /**
   * Polls until the job reaches success, failed or cancelled, and returns the final detail.
   * It does not throw on failure — check `generation.status` (or use `assertSucceeded`).
   */
  async wait(id: number, options: WaitOptions = {}): Promise<GenerationDetail> {
    const interval = options.intervalMs ?? 2500
    const deadline = options.timeoutMs === undefined ? Infinity : Date.now() + options.timeoutMs
    for (;;) {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error('Aborted')
      let detail: GenerationDetail | undefined
      try {
        detail = await this.get(id)
      } catch (error) {
        // A transient failure is retried on the next round; a missing job is final.
        if (error instanceof ZettaError && (error.status === 404 || error.status === 401 || error.status === 403)) throw error
      }
      if (detail) {
        options.onUpdate?.(detail)
        if (isTerminal(detail.generation)) return detail
      }
      if (Date.now() + interval > deadline) {
        throw new ZettaError({
          code: LocalErrorCodes.WAIT_TIMEOUT,
          message: `Stopped waiting for #${id}; it is still running.`,
          details: { id, status: detail?.generation.status ?? null },
        })
      }
      await this.sleep(interval)
    }
  }
}

export function isTerminal(generation: Pick<Generation, 'status'>): boolean {
  return TERMINAL_STATUSES.includes(generation.status)
}

/** Throws JOB_FAILED / JOB_CANCELLED unless the job succeeded. */
export function assertSucceeded(generation: Generation): Generation {
  if (generation.status === 'success') return generation
  if (generation.status === 'cancelled') {
    throw new ZettaError({ code: LocalErrorCodes.JOB_CANCELLED, message: `#${generation.id} was cancelled.`, details: { id: generation.id } })
  }
  throw new ZettaError({
    code: LocalErrorCodes.JOB_FAILED,
    message: generation.errorMessage
      ? `#${generation.id} failed: ${generation.errorMessage}`
      : `#${generation.id} failed. Its credits were refunded.`,
    details: { id: generation.id, status: generation.status },
  })
}

/** Features whose result is one GLB per part (`part` in `resultUpload` counts these). */
export const SEGMENTED_FEATURES: readonly string[] = ['segmentation', 'smartSegmentation']

/**
 * A segmented item's GLB parts in part order — the order `resultUpload`'s `part` counts in (the
 * server sorts parts by the number at the end of their file name, `…-3.glb`).
 */
export function resultParts(generation: Pick<Generation, 'result'>): ResultFile[] {
  const number = (key: string) => Number(/-(\d+)\.glb$/i.exec(key)?.[1] ?? -1)
  return (generation.result?.files ?? []).filter((file) => fileFormat(file) === 'glb').sort((a, b) => number(a.key) - number(b.key))
}

const FORMAT_ORDER = ['glb', 'fbx', 'gltf', 'obj', 'zip', 'usdz', 'stl', '3mf', 'ply', 'spz', 'splat']

/** File extension of a result file, lower case, from its key. */
export function fileFormat(file: Pick<ResultFile, 'key' | 'type'>): string {
  const name = file.key.split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  return (dot >= 0 ? name.slice(dot + 1) : file.type || '').toLowerCase()
}

/**
 * The result files to download.
 *
 * `formats` keeps only those extensions; `primary` keeps the single best model file
 * (GLB, then FBX, glTF, the OBJ zip …), which is what an importer usually wants.
 */
export function selectResultFiles(
  generation: Pick<Generation, 'result'>,
  options: { formats?: string[]; primary?: boolean } = {},
): ResultFile[] {
  const files = generation.result?.files ?? []
  let chosen = files
  if (options.formats?.length) {
    const wanted = new Set(options.formats.map((f) => f.toLowerCase().replace(/^\./, '')))
    chosen = files.filter((f) => wanted.has(fileFormat(f)))
  }
  if (options.primary) {
    const ranked = [...chosen].sort((a, b) => rank(fileFormat(a)) - rank(fileFormat(b)))
    return ranked.slice(0, 1)
  }
  return chosen
}

function rank(format: string): number {
  const index = FORMAT_ORDER.indexOf(format)
  return index === -1 ? FORMAT_ORDER.length : index
}
