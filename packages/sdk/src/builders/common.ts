/**
 * Shared pieces of the request builders: the result shape, the server's operation codes and the
 * limits every create request is held to.
 *
 * Pure TypeScript with no runtime dependencies, so it runs the same in Node, Bun and browsers.
 */

/** One reason a request cannot be sent. */
export interface Problem {
  /** SCREAMING_SNAKE, stable for scripts to branch on. */
  code: string
  /** The input field the problem is about, when there is one. */
  field?: string
  /** One plain sentence telling the user what to change. */
  message: string
}

/** The body for `POST /api/3d/quote`. */
export interface QuoteSpec {
  generation?: { base: string; modifiers?: string[] }
  postProcess?: string[]
  model?: string
}

export type BuildResult<T> =
  | { ok: true; request: T; quote: QuoteSpec; warnings: string[] }
  | { ok: false; problems: Problem[] }

/** Every engine id the server knows. Ours, never a supplier's. */
export const GEN_MODELS = ['n1', 'n25', 'np1', 'np15', 'r1', 'zs2', 'zs21'] as const
export type GenModel = (typeof GEN_MODELS)[number]

/** What a request that names no model gets on the server. */
export const DEFAULT_GEN_MODEL: GenModel = 'n1'

/** The server's priced operation codes (`ThreeDOperation`). */
export const OPERATIONS = {
  // generation bases: exactly one
  GEOMETRY_ONLY: 'geometry_only',
  TEXTURED: 'textured',
  LOWPOLY: 'lowpoly',
  GAUSSIAN_SPLAT: 'gaussian_splat',
  // generation modifiers
  MULTI_VIEW: 'multi_view',
  PBR: 'pbr',
  CUSTOM_FACE_COUNT: 'custom_face_count',
  DETAILED_GEOMETRY: 'detailed_geometry',
  DETAILED_TEXTURE: 'detailed_texture',
  EXTREME_TEXTURE: 'extreme_texture',
  QUAD_MESH: 'quad_mesh',
  GENERATE_PARTS: 'generate_parts',
  // post-processing: one per job
  SMART_TOPOLOGY: 'smart_topology',
  SMART_SEGMENTATION: 'smart_segmentation',
  SMART_SEGMENTATION_IMAGE: 'smart_segmentation_image',
  AI_SEGMENTATION: 'ai_segmentation',
  SMART_UV: 'smart_uv',
  RETEXTURE: 'retexture',
  RETEXTURE_HD: 'retexture_hd',
  RETEXTURE_8K: 'retexture_8k',
  AUTO_RIGGING: 'auto_rigging',
  CONVERT_FORMAT: 'convert_format',
  CONVERT_FORMAT_ADVANCED: 'convert_format_advanced',
  WORLD_SPLAT_EXPORT: 'world_splat_export',
  WORLD_MESH_EXPORT: 'world_mesh_export',
  WORLD_COLLIDER_EXPORT: 'world_collider_export',
} as const

/** Mesh formats a source can be held in. */
export type MeshFormat = 'GLB' | 'OBJ' | 'FBX'
export const MESH_FORMATS: readonly MeshFormat[] = ['GLB', 'OBJ', 'FBX']

/** Every `viewType` the server accepts on `multiViewImages`. `front` becomes the main picture. */
export const VIEW_TYPES = [
  'front',
  'left',
  'right',
  'back',
  'top',
  'bottom',
  'left_front',
  'right_front',
] as const
export type ViewType = (typeof VIEW_TYPES)[number]

export const RIG_TYPES = ['biped', 'quadruped', 'hexapod', 'octopod', 'avian', 'serpentine', 'aquatic'] as const
export type RigType = (typeof RIG_TYPES)[number]
export const RIG_SPECS = ['standard', 'mixamo'] as const
export type RigSpec = (typeof RIG_SPECS)[number]
export const RIG_OUT_FORMATS = ['glb', 'fbx'] as const
export type RigOutFormat = (typeof RIG_OUT_FORMATS)[number]

export const CONVERT_FORMATS = ['GLTF', 'FBX', 'USDZ', 'OBJ', 'STL', '3MF'] as const
export type ConvertFormat = (typeof CONVERT_FORMATS)[number]
export const CONVERT_TEXTURE_FORMATS = [
  'JPEG',
  'PNG',
  'WEBP',
  'BMP',
  'DPX',
  'HDR',
  'OPEN_EXR',
  'TARGA',
  'TIFF',
] as const
export type ConvertTextureFormat = (typeof CONVERT_TEXTURE_FORMATS)[number]
export const CONVERT_ORIENTATIONS = ['+x', '-x', '-y', '+y'] as const
export type ConvertOrientation = (typeof CONVERT_ORIENTATIONS)[number]
export const FBX_PRESETS = ['blender', '3dsmax', 'mixamo'] as const
export type FbxPreset = (typeof FBX_PRESETS)[number]

export const WORLD_SPLAT_RESOLUTIONS = ['full_res', '500k', '150k', '100k'] as const
export type WorldSplatResolution = (typeof WORLD_SPLAT_RESOLUTIONS)[number]
export const WORLD_MESH_VARIANTS = ['textured', 'vertex_colored'] as const
export type WorldMeshVariant = (typeof WORLD_MESH_VARIANTS)[number]

/**
 * The body of `POST /api/3d/generations`, field for field as the server's DTO accepts it. The
 * server rejects unknown fields, so nothing outside this list may be sent.
 */
export interface CreateGenerationRequest {
  spec: {
    generation?: { base: string; modifiers?: string[] }
    postProcess?: string[]
  }
  // inputs
  prompt?: string
  imageUrl?: string
  videoUrl?: string
  worldViews?: Array<{ azimuth?: number; imageUrl: string }>
  reconstructImages?: boolean
  multiViewImages?: Array<{ viewType: ViewType; imageUrl: string }>
  imageFromPrompt?: boolean
  // geometry
  faceCount?: number
  polygonType?: 'triangle' | 'quadrilateral'
  generationType?: 'Normal' | 'LowPoly' | 'Geometry' | 'Sketch'
  // engine tuning
  autoSize?: boolean
  textureAlignment?: 'original_image' | 'geometry'
  textureFast?: boolean
  delight?: boolean
  autofixImage?: boolean
  compressGeometry?: boolean
  exportUv?: boolean
  modelSeed?: number
  textureSeed?: number
  // post-processing
  sourceFileUrl?: string
  sourcePostId?: number
  bake?: boolean
  enablePBR?: boolean
  partNames?: string[]
  faceLevel?: 'low' | 'medium' | 'high'
  segmentGranularity?: 'simple' | 'balanced' | 'detailed'
  splitByConnectivity?: boolean
  rigType?: RigType
  rigSpec?: RigSpec
  rigOutFormat?: RigOutFormat
  outputFormat?: ConvertFormat
  splatResolution?: WorldSplatResolution
  meshVariant?: WorldMeshVariant
  forceSymmetry?: boolean
  flattenBottom?: boolean
  flattenBottomThreshold?: number
  textureSize?: number
  textureFormat?: ConvertTextureFormat
  packUv?: boolean
  exportVertexColors?: boolean
  pivotToCenterBottom?: boolean
  scaleFactor?: number
  withAnimation?: boolean
  animateInPlace?: boolean
  exportOrientation?: ConvertOrientation
  fbxPreset?: FbxPreset
  // metadata
  title?: string
  tags?: string[]
  availability?: 'private' | 'public'
  origin?: string
  advanceControl?: boolean
  model?: GenModel
}

export const MAX_URL_LENGTH = 2048
export const MAX_PROMPT_LENGTH = 1024
export const MAX_TITLE_LENGTH = 255
export const MAX_TAGS = 20
export const MAX_TAG_LENGTH = 64
export const MAX_ORIGIN_LENGTH = 64
/** Where a CLI request says it came from, unless the caller names something else. */
export const DEFAULT_ORIGIN = 'cli'

/** Numbers as the server prints them in its messages: `1,000,000`. */
export function formatCount(value: number): string {
  return value.toLocaleString('en-US')
}

export function problem(code: string, message: string, field?: string): Problem {
  return field === undefined ? { code, message } : { code, field, message }
}

/** The server takes http(s) only and needs the scheme: `cdn.example.com/a.png` is refused. */
export function isHttpUrl(value: string): boolean {
  return /^https?:\/\/[^\s/?#]+/i.test(value)
}

/** Pushes a problem for a URL the server would refuse; returns the trimmed URL either way. */
export function checkUrl(
  problems: Problem[],
  field: string,
  raw: string,
  what: string,
): string {
  const url = raw.trim()
  if (!isHttpUrl(url)) {
    problems.push(problem('INVALID_URL', `${what} must start with http:// or https://.`, field))
  } else if (url.length > MAX_URL_LENGTH) {
    problems.push(
      problem('URL_TOO_LONG', `${what} is longer than ${formatCount(MAX_URL_LENGTH)} characters.`, field),
    )
  }
  return url
}

export function isWholeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

/** The metadata every create request may carry. */
export interface RequestMetadata {
  /** Omitted when blank, so the server can name the asset itself. */
  title?: string
  tags?: string[]
  /** Omitted means the server's plan-aware default: private where the plan allows it. */
  availability?: 'public' | 'private'
  /** Where the request came from. Defaults to `cli`. */
  origin?: string
}

/** Validates and normalises the metadata fields, in the shape they travel. */
export function buildMetadata(
  input: RequestMetadata,
  problems: Problem[],
): { title?: string; tags?: string[]; availability?: 'public' | 'private'; origin: string } {
  const out: { title?: string; tags?: string[]; availability?: 'public' | 'private'; origin: string } = {
    origin: DEFAULT_ORIGIN,
  }

  const title = input.title?.trim() ?? ''
  if (title.length > MAX_TITLE_LENGTH) {
    problems.push(
      problem('TITLE_TOO_LONG', `The title must be ${MAX_TITLE_LENGTH} characters or fewer.`, 'title'),
    )
  } else if (title !== '') {
    out.title = title
  }

  if (input.tags !== undefined) {
    const tags = input.tags.map((tag) => String(tag).trim()).filter((tag) => tag !== '')
    if (tags.length > MAX_TAGS) {
      problems.push(problem('TOO_MANY_TAGS', `Use at most ${MAX_TAGS} tags.`, 'tags'))
    } else if (tags.some((tag) => tag.length > MAX_TAG_LENGTH)) {
      problems.push(
        problem('TAG_TOO_LONG', `Each tag must be ${MAX_TAG_LENGTH} characters or fewer.`, 'tags'),
      )
    } else if (tags.length > 0) {
      out.tags = tags
    }
  }

  if (input.availability !== undefined) {
    if (input.availability !== 'public' && input.availability !== 'private') {
      problems.push(
        problem('INVALID_AVAILABILITY', 'availability must be public or private.', 'availability'),
      )
    } else {
      out.availability = input.availability
    }
  }

  const origin = input.origin?.trim() ?? ''
  if (origin.length > MAX_ORIGIN_LENGTH) {
    problems.push(
      problem('ORIGIN_TOO_LONG', `origin must be ${MAX_ORIGIN_LENGTH} characters or fewer.`, 'origin'),
    )
  } else if (origin !== '') {
    out.origin = origin
  }

  return out
}

/** Checks an enum-valued option, pushing a problem naming the allowed values. */
export function checkEnum<T extends string>(
  problems: Problem[],
  field: string,
  value: unknown,
  allowed: readonly T[],
): value is T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return true
  problems.push(
    problem('INVALID_OPTION', `${field} must be one of: ${allowed.join(', ')}.`, field),
  )
  return false
}

// ------------------------------------------------------------------------------- face limits

export interface FaceRange {
  min: number
  max: number
}

/** Zetta N1's range, and the fallback for an engine with no table of its own. */
export const SHARED_FACE_LIMITS: FaceRange = { min: 3_100, max: 1_500_000 }
export const R1_FACE_LIMITS = {
  triangle: { min: 500, max: 20_000 },
  quad: { min: 500, max: 10_000 },
} as const
export const NP1_FACE_LIMITS: FaceRange = { min: 48, max: 20_000 }
export const NP15_FACE_LIMITS = {
  triangle: { min: 48, max: 50_000 },
  quad: { min: 48, max: 25_000 },
} as const
/** Zetta N2.5's ranges by rung. High stops at 1,000,000 by our choice, below the engine's own. */
export const N25_FACE_LIMITS = {
  lowpoly: { triangle: { min: 1_000, max: 20_000 }, quad: { min: 500, max: 10_000 } },
  high: { triangle: { min: 1_000, max: 1_000_000 }, quad: { min: 1_000, max: 150_000 } },
  ultra: { triangle: { min: 1_000, max: 2_000_000 }, quad: { min: 1_000, max: 150_000 } },
} as const

/**
 * The polygon count the server accepts for a job, read the way the server reads it: from the
 * model, the paid base and modifiers, and the topology.
 */
export function faceLimitsFor(
  model: string,
  base: string | undefined,
  modifiers: readonly string[] = [],
  polygonType?: 'triangle' | 'quadrilateral',
): FaceRange {
  const quad = polygonType === 'quadrilateral'
  if (model === 'np1') return NP1_FACE_LIMITS
  if (model === 'np15') return quad ? NP15_FACE_LIMITS.quad : NP15_FACE_LIMITS.triangle
  if (model === 'r1') return quad ? R1_FACE_LIMITS.quad : R1_FACE_LIMITS.triangle
  if (model !== 'n25') return SHARED_FACE_LIMITS
  const rung =
    base === OPERATIONS.LOWPOLY
      ? N25_FACE_LIMITS.lowpoly
      : modifiers.includes(OPERATIONS.DETAILED_GEOMETRY)
        ? N25_FACE_LIMITS.ultra
        : N25_FACE_LIMITS.high
  return quad ? rung.quad : rung.triangle
}

// ------------------------------------------------------------------------------------ prices

/** The subset of `GET /api/3d/pricing` the builders read. */
export interface PriceListLike {
  items: ReadonlyArray<{ code: string; credits: number; model?: string | null }>
}

/**
 * One option's price for one model; the most specific row wins, as on the server. `null` when the
 * list has no row for it.
 */
export function priceOf(prices: PriceListLike | undefined, code: string, model?: string | null): number | null {
  if (!prices) return null
  const wanted = (model ?? '').trim().toLowerCase()
  if (wanted !== '') {
    const specific = prices.items.find(
      (item) => item.code === code && (item.model ?? '').trim().toLowerCase() === wanted,
    )
    if (specific) return specific.credits
  }
  return prices.items.find((item) => item.code === code && !item.model)?.credits ?? null
}

/** The total for a quote spec from the price list, or `null` when any line is unknown. */
export function totalFor(prices: PriceListLike | undefined, quote: QuoteSpec): number | null {
  const codes = [
    ...(quote.generation ? [quote.generation.base, ...(quote.generation.modifiers ?? [])] : []),
    ...(quote.postProcess ?? []),
  ]
  let total = 0
  for (const code of codes) {
    const credits = priceOf(prices, code, quote.model)
    if (credits === null) return null
    total += credits
  }
  return total
}
