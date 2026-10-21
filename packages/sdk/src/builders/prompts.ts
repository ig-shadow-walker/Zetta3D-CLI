/**
 * The picture prompts the Studio writes on the client, and the `/2d` request bodies it sends with
 * them: a picture made from a prompt for text-to-3D, missing multi-view angles, more directions
 * of a world, and PBR texture maps.
 *
 * Paths are relative to the API base (which ends in `/api`), so `/2d/generate` is
 * `POST /api/2d/generate`.
 */
import { FORWARD_AZIMUTH } from './splat'

export const IMAGE_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'] as const
export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIOS)[number]
export const IMAGE_RESOLUTIONS = ['1K', '2K', '4K'] as const
export type ImageResolution = (typeof IMAGE_RESOLUTIONS)[number]
export type ImageContentType = 'image/png' | 'image/jpeg' | 'image/webp'

/** A picture sent inline: base64 without a `data:` prefix. */
export interface InlineImageData {
  data: string
  contentType?: ImageContentType
}

/** Bytes (a base64 string, a data URL, or `InlineImageData`), or one of your own image posts. */
export type ImageSource = string | InlineImageData | { sourcePostId: number }

export interface ImageGenerateBody {
  prompt: string
  for3D: true
  subject?: 'environment'
  aspectRatio?: ImageAspectRatio
  resolution?: ImageResolution
}

export interface ImageEditBody {
  prompt: string
  image?: InlineImageData
  sourcePostId?: number
  for3D?: true
  subject?: 'environment'
  aspectRatio?: ImageAspectRatio
  resolution?: ImageResolution
  /** A step inside a 3D job, already paid for in 3D credits. */
  pipelineStep?: true
  /** An AI texture map, a paid image feature. */
  textureMap?: true
}

export interface ImageRequest<B> {
  method: 'POST'
  path: '/2d/generate' | '/2d/img-edit'
  body: B
}

function inlineImage(source: string | InlineImageData): InlineImageData {
  const raw = typeof source === 'string' ? { data: source } : { ...source }
  // The server wants bare base64; accept a data URL and keep its type.
  const match = /^data:(image\/(?:png|jpeg|webp));base64,(.*)$/s.exec(raw.data)
  if (match) return { data: match[2] ?? '', contentType: match[1] as ImageContentType }
  return raw.contentType ? { data: raw.data, contentType: raw.contentType } : { data: raw.data }
}

function sourceFields(source: ImageSource): Pick<ImageEditBody, 'image' | 'sourcePostId'> {
  if (typeof source === 'object' && 'sourcePostId' in source) return { sourcePostId: source.sourcePostId }
  return { image: inlineImage(source) }
}

// ----------------------------------------------------------------- a picture made from a prompt

/**
 * The picture a prompt becomes before a 3D job (text-to-3D, and splats from a prompt). `for3D`
 * makes the server frame it for reconstruction. An environment (a splat world) also carries its
 * frame; the Studio defaults it to 16:9 at 1K.
 */
export function imageForPromptRequest(
  prompt: string,
  options: { subject?: 'object' | 'environment'; aspectRatio?: ImageAspectRatio; resolution?: ImageResolution } = {},
): ImageRequest<ImageGenerateBody> {
  const body: ImageGenerateBody = { prompt: prompt.trim(), for3D: true }
  if (options.subject === 'environment') {
    body.subject = 'environment'
    body.aspectRatio = options.aspectRatio ?? '16:9'
    body.resolution = options.resolution ?? '1K'
  }
  return { method: 'POST', path: '/2d/generate', body }
}

// ------------------------------------------------------------------------- multi-view angles

/** The four views the Studio draws and offers. */
export const DRAW_VIEWS = ['front', 'back', 'left', 'right'] as const
export type DrawView = (typeof DRAW_VIEWS)[number]

/** Where the camera stands for each view. The side views say which way the object faces in the frame. */
export const VIEW_ANGLES: Readonly<Record<DrawView, string>> = {
  front: 'directly in front of the object at its own eye level, looking straight at it head-on.',
  back:
    'directly behind the object at its own eye level. The face that pointed at the camera ' +
    'in the reference is now hidden, and what was hidden is now facing us.',
  left:
    "directly beside the object's left flank at its own eye level, looking horizontally at it. " +
    'A flat side-on profile: the front and the back are both hidden, and the opposite flank is ' +
    "entirely behind the object. In the frame the object's FRONT points to the LEFT edge and " +
    'its BACK to the RIGHT edge.',
  right:
    "directly beside the object's right flank at its own eye level, looking horizontally at it. " +
    'A flat side-on profile: the front and the back are both hidden, and the opposite flank is ' +
    "entirely behind the object. In the frame the object's FRONT points to the RIGHT edge and " +
    'its BACK to the LEFT edge — this is the mirror image of the left-hand view, not a repeat ' +
    'of it.',
}

/**
 * The instruction that redraws a reference picture from another view. Framing is left to the
 * server's `for3D` preset.
 */
export function drawViewPrompt(view: DrawView): string {
  const angle = VIEW_ANGLES[view]
  if (!angle) throw new Error(`Unknown view: ${String(view)}`)
  return (
    'The attached image is a reference photograph of a single object. Re-render that SAME ' +
    'object from a different camera angle. Keep its shape, proportions, colours, materials ' +
    'and surface details identical — this is one object photographed again, not a new ' +
    'design, so do not restyle it and do not add or remove any part of it. ' +
    `Place the camera ${angle}`
  )
}

/** The `/2d/img-edit` body that draws one missing view from the reference. */
export function drawViewRequest(view: DrawView, reference: ImageSource): ImageRequest<ImageEditBody> {
  return {
    method: 'POST',
    path: '/2d/img-edit',
    body: { prompt: drawViewPrompt(view), ...sourceFields(reference), for3D: true, pipelineStep: true },
  }
}

/** The picture other views are drawn from: the front if there is one, else the first filled. */
export function referenceView(views: Partial<Record<DrawView, unknown>>): DrawView | null {
  if (views.front) return 'front'
  return DRAW_VIEWS.find((view) => views[view]) ?? null
}

/** The empty views, which "draw the missing views" would fill. */
export function missingViews(views: Partial<Record<DrawView, unknown>>): DrawView[] {
  return DRAW_VIEWS.filter((view) => !views[view])
}

/**
 * The `/2d/img-edit` body for an edit of AI Texturing's reference picture (or of one of its view
 * pictures), with the caller's own instruction.
 */
export function textureReferenceEditRequest(prompt: string, reference: ImageSource): ImageRequest<ImageEditBody> {
  return {
    method: 'POST',
    path: '/2d/img-edit',
    body: { prompt: prompt.trim(), ...sourceFields(reference), for3D: true, pipelineStep: true },
  }
}

// ------------------------------------------------------------------------- world directions

/** Turning clockwise: 90° is to the viewer's right. */
const TURNS_CLOCKWISE = true

export const WORLD_DIRECTIONS: ReadonlyArray<{ azimuth: number; label: string }> = [
  { azimuth: 90, label: 'Right' },
  { azimuth: 180, label: 'Back' },
  { azimuth: 270, label: 'Left' },
]

export const DIAGONAL_DIRECTIONS: ReadonlyArray<{ azimuth: number; label: string }> = [45, 135, 225, 315].map(
  (azimuth) => ({
    azimuth,
    label: `${azimuth < 90 || azimuth > 270 ? 'Front' : 'Back'}-${azimuth < 180 === TURNS_CLOCKWISE ? 'right' : 'left'}`,
  }),
)

/** A direction's name, when it has one: Forward, Right, Back-left… */
export function directionName(azimuth: number): string | null {
  if (azimuth === FORWARD_AZIMUTH) return 'Forward'
  return [...WORLD_DIRECTIONS, ...DIAGONAL_DIRECTIONS].find((entry) => entry.azimuth === azimuth)?.label ?? null
}

/** "Back · 180°", "Front-right · 45°", "100°". */
export function directionLabel(azimuth: number): string {
  const name = directionName(azimuth)
  return name ? `${name} · ${azimuth}°` : `${azimuth}°`
}

/** A whole number of degrees in 0–359, or null for anything that is not a number. */
export function normalizeAzimuth(value: number | string): number | null {
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(n) || String(value).trim() === '') return null
  return ((Math.round(n) % 360) + 360) % 360
}

function turnOf(azimuth: number): { side: 'right' | 'left' | 'behind'; degrees: number } {
  if (azimuth === 180) return { side: 'behind', degrees: 180 }
  const right = TURNS_CLOCKWISE ? azimuth < 180 : azimuth > 180
  return { side: right ? 'right' : 'left', degrees: azimuth < 180 ? azimuth : 360 - azimuth }
}

/** The instruction that turns the forward picture of a place into another direction of it. */
export function worldDirectionPrompt(azimuth: number): string {
  const turn = turnOf(azimuth)
  const action =
    turn.side === 'behind'
      ? 'turns around to face directly behind them (180°)'
      : `turns ${turn.degrees}° to their ${turn.side}`
  return [
    'This picture shows a place as seen by someone standing in it, looking forward.',
    `Show the same place from exactly the same standing spot after the viewer ${action}.`,
    'Keep the same location, architecture, materials, style, lighting, weather and time of day, and the same camera height and lens, so the pictures could be stitched into one panorama.',
    turn.degrees < 90
      ? 'Part of the original view overlaps the edge of the new one; continue it seamlessly.'
      : 'Invent what lies in that direction so it belongs to the same place.',
    'Do not repeat the original view, do not move the viewer, and add no people or text.',
  ].join(' ')
}

const FRAMES = ['21:9', '16:9', '3:2', '4:3', '5:4', '1:1', '4:5', '3:4', '2:3', '9:16'] as const

/** The frame closest to a picture's own shape, so a direction comes back shaped like the forward one. */
export function nearestFrame(width: number, height: number): ImageAspectRatio {
  if (!(width > 0 && height > 0)) return '16:9'
  const ratio = Math.log(width / height)
  let best: ImageAspectRatio = FRAMES[0]
  let distance = Infinity
  for (const frame of FRAMES) {
    const [w, h] = frame.split(':').map(Number) as [number, number]
    const d = Math.abs(Math.log(w / h) - ratio)
    if (d < distance) {
      distance = d
      best = frame
    }
  }
  return best
}

/**
 * The `/2d/img-edit` body that draws one more direction of a world from its forward picture, in
 * the forward picture's frame (see `nearestFrame`).
 */
export function worldDirectionRequest(
  azimuth: number,
  forward: ImageSource,
  frame: { aspectRatio?: ImageAspectRatio; resolution?: ImageResolution } = {},
): ImageRequest<ImageEditBody> {
  return {
    method: 'POST',
    path: '/2d/img-edit',
    body: {
      prompt: worldDirectionPrompt(azimuth),
      ...sourceFields(forward),
      for3D: true,
      subject: 'environment',
      aspectRatio: frame.aspectRatio ?? '16:9',
      resolution: frame.resolution ?? '1K',
      pipelineStep: true,
    },
  }
}

// ------------------------------------------------------------------------------ texture maps

export const TEXTURE_MAP_CHANNELS = ['normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap'] as const
export type TextureMapChannel = (typeof TEXTURE_MAP_CHANNELS)[number]

/** One instruction per PBR channel, describing how the output looks rather than naming a format. */
export const TEXTURE_MAP_PROMPTS: Readonly<Record<TextureMapChannel, string>> = {
  normalMap:
    'Convert this texture into a tangent-space normal map. Output must be flat lavender-blue ' +
    '(RGB 128,128,255) wherever the surface is flat, with red and green deviating only to encode ' +
    'the slope of the surface detail visible here. Keep the same layout and scale. No shading, ' +
    'no colour from the original, no lighting.',
  roughnessMap:
    'Convert this texture into a greyscale roughness map. Black is mirror-smooth, white is ' +
    'fully matte. Base the values on the material each area appears to be — polished metal dark, ' +
    'raw wood or cloth light. Keep the same layout. Greyscale only, no colour, no shading.',
  metalnessMap:
    'Convert this texture into a greyscale metalness mask. Pure white where the surface is ' +
    'metal, pure black everywhere else, with no midtones except at a genuine boundary. Keep the ' +
    'same layout. Greyscale only.',
  emissiveMap:
    'Convert this texture into an emissive map. Pure black everywhere the surface does not emit ' +
    'light, and the emitted colour only where it genuinely glows — screens, lamps, hot metal, ' +
    'runes. If nothing in this texture would emit light, return solid black. Keep the same layout.',
  aoMap:
    'Convert this texture into a greyscale ambient occlusion map. White where light reaches ' +
    'freely, darkening only inside crevices, seams and contact areas implied by the detail here. ' +
    'Keep the same layout. Greyscale only, no colour, no directional shading.',
}

export function textureMapPrompt(channel: TextureMapChannel): string {
  const prompt = TEXTURE_MAP_PROMPTS[channel]
  if (!prompt) throw new Error(`Unknown texture channel: ${String(channel)}`)
  return prompt
}

/** The frame size at or above the base colour's longest edge: a map must match it texel for texel. */
export function textureMapResolution(longestEdge: number): ImageResolution {
  if (longestEdge > 2048) return '4K'
  if (longestEdge > 1024) return '2K'
  return '1K'
}

/**
 * The `/2d/img-edit` body that derives one PBR channel from the base colour map. Pad a
 * non-square map to a square (mid-grey bars) before sending, and crop the result back after.
 */
export function textureMapRequest(
  channel: TextureMapChannel,
  baseColour: string | InlineImageData,
  longestEdge: number,
): ImageRequest<ImageEditBody> {
  return {
    method: 'POST',
    path: '/2d/img-edit',
    body: {
      prompt: textureMapPrompt(channel),
      image: inlineImage(baseColour),
      textureMap: true,
      aspectRatio: '1:1',
      resolution: textureMapResolution(longestEdge),
    },
  }
}
