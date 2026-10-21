/**
 * Keeps upstream detail out of what the CLI prints.
 *
 * The CLI cannot hold a list of vendor names (it would ship in the binary), so instead it
 * drops fields known to carry upstream identifiers or costs, and replaces server messages for
 * error codes whose text can quote an upstream provider.
 */
const DROPPED_DETAIL_KEYS = new Set(['category', 'scope', 'vendor', 'vendorCredits', 'vendorAmount', 'model', 'allowedModels', 'maxDrainMultiplierX100', 'reason'])

const OWN_MESSAGES: Record<string, string> = {
  IMAGE_GEN_QUOTA: 'The image engine is over capacity right now. Try again later.',
  IMAGE_GEN_FAILED: 'The image engine could not make that picture. Try again, or change the prompt.',
  IMAGE_GEN_TIMEOUT: 'The image engine took too long. Try again.',
  IMAGE_GEN_UNREACHABLE: 'The image engine could not be reached. Try again shortly.',
  IMAGE_GEN_REJECTED: 'The image engine declined this request. Change the prompt or the picture and try again.',
  IMAGE_GEN_NO_IMAGE: 'The image engine returned no picture. Try again, or change the prompt.',
  IMAGE_GEN_DISABLED: 'Image generation is switched off right now. Try again later.',
}

export function sanitizeDetails(details: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(details)) {
    if (DROPPED_DETAIL_KEYS.has(key) || key.toLowerCase().startsWith('vendor')) continue
    clean[key] = value
  }
  return clean
}

export function ownMessage(code: string): string | undefined {
  return OWN_MESSAGES[code]
}
