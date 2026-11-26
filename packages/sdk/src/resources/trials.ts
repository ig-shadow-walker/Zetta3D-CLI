import type { Transport } from '../transport'

export interface TrialRedeemed {
  /** When the trial ends (ISO date). */
  trialEndsAt: string
  /** The plan the trial unlocks (`basic`). */
  plan: string
}

export class Trials {
  constructor(private readonly transport: Transport) {}

  /**
   * Redeems a trial code: 10 days of the Basic plan. The server is forgiving about the shape:
   * `ZETTA-7KQ2-M9XD`, lower case, missing dashes, or a whole pasted `?trial=` link all work.
   * Browser sign-in only.
   */
  redeem(code: string): Promise<TrialRedeemed> {
    return this.transport.request('POST', '/trials/redeem', { body: { code }, retry: 'never' })
  }
}
