import { Auth } from './resources/auth'
import { Billing } from './resources/billing'
import { Catalog } from './resources/catalog'
import { Generations } from './resources/generations'
import { Images } from './resources/images'
import { Pipelines, Runs } from './resources/pipelines'
import { Tools } from './resources/tools'
import { Transport, type TransportOptions } from './transport'
import { Uploads } from './uploads'

export type ZettaClientOptions = TransportOptions

/**
 * The Zetta 3D API.
 *
 * ```ts
 * const zetta = new ZettaClient({ token: process.env.ZETTA_TOKEN })
 * const { user } = await zetta.auth.me()
 * ```
 */
export class ZettaClient {
  readonly transport: Transport
  readonly auth: Auth
  readonly billing: Billing
  readonly catalog: Catalog
  readonly generations: Generations
  readonly uploads: Uploads
  readonly images: Images
  readonly tools: Tools
  readonly pipelines: Pipelines
  readonly runs: Runs

  constructor(options: ZettaClientOptions = {}) {
    this.transport = new Transport(options)
    const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
    const sleep = options.sleep
    this.auth = new Auth(this.transport)
    this.billing = new Billing(this.transport)
    this.catalog = new Catalog(this.transport)
    this.generations = new Generations(this.transport, sleep)
    this.uploads = new Uploads(this.transport, fetchImpl, sleep)
    this.images = new Images(this.transport)
    this.tools = new Tools(this.transport)
    this.pipelines = new Pipelines(this.transport)
    this.runs = new Runs(this.transport, sleep)
  }
}
