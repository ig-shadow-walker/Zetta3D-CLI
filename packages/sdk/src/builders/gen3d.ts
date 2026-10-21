/**
 * Generate 3D: the engine catalogue and the builder that turns CLI-style options into exactly the
 * `POST /api/3d/generations` body the Studio sends for the same choices.
 *
 * Every cross-field rule the server enforces is checked here first, because credits are taken
 * before the job reaches an engine: a refused combination found here costs nothing.
 *
 * Where the Studio silently coerces a control (its form keeps every field across engines), this
 * builder reports a problem instead when the caller set the option explicitly, and applies the
 * Studio's default when the caller left it out.
 */
import {
  DEFAULT_GEN_MODEL,
  OPERATIONS,
  SHARED_FACE_LIMITS,
  VIEW_TYPES,
  buildMetadata,
  checkEnum,
  checkUrl,
  faceLimitsFor,
  formatCount,
  isWholeNumber,
  problem,
  MAX_PROMPT_LENGTH,
  type BuildResult,
  type CreateGenerationRequest,
  type FaceRange,
  type Problem,
  type QuoteSpec,
  type RequestMetadata,
  type ViewType,
} from './common'

export type { CreateGenerationRequest } from './common'

export const GENERATE_ENGINE_IDS = ['n1', 'n25', 'np1', 'np15'] as const
export type GenerateEngineId = (typeof GENERATE_ENGINE_IDS)[number]

/** The Studio's Low-Poly / High-Res / Ultra rungs. */
export const QUALITIES = ['lowpoly', 'high', 'ultra'] as const
export type Quality = (typeof QUALITIES)[number]
export const OUTPUTS = ['textured', 'geometry'] as const
export type Output = (typeof OUTPUTS)[number]
export const POLYGON_TYPES = ['triangle', 'quad'] as const
export type PolygonType = (typeof POLYGON_TYPES)[number]
/** standard is free; detailed (HD) and 8k are paid modifiers. */
export const TEXTURE_QUALITIES = ['standard', 'detailed', '8k'] as const
export type TextureQuality = (typeof TEXTURE_QUALITIES)[number]
export const TEXTURE_ALIGNMENTS = ['original_image', 'geometry'] as const
export type TextureAlignment = (typeof TEXTURE_ALIGNMENTS)[number]

/** A multi-view slot. The Studio offers front, back, left and right. */
export type ViewSlot = ViewType

/** What each generation engine can be asked for. Mirrors the server's capability table. */
interface Capabilities {
  label: string
  description: string
  paidOnly: boolean
  barePrompt: boolean
  multiView: boolean
  viewSlots: readonly ViewSlot[]
  /** The server refuses a set below this, or without a front view, after the charge. */
  minViews: number
  frontViewRequired: boolean
  /** Whether the quality rungs mean anything (the Np line builds to a face budget only). */
  qualityRungs: boolean
  lowPoly: boolean
  geometryOnly: boolean
  /** An untextured low-poly mesh; elsewhere low-poly and untextured are one engine switch. */
  bareLowPoly: boolean
  sketch: boolean
  pbr: boolean
  customFaceCount: boolean
  /** Ultra is a paid `detailed_geometry` level rather than a bigger count. */
  detailLevel: boolean
  hdTexture: boolean
  extremeTexture: boolean
  /** The free tuning options (auto size, texture alignment, autofix, compression, seeds, delight, UVs). */
  imageTuning: boolean
  parts: boolean
  /** Quads at any quality, rather than at low-poly only. */
  quadAnyBase: boolean
  /** Where a rung IS a count (N1): the count each rung fills in. Elsewhere the rung's ceiling is used. */
  rungCounts?: { lowpoly: number; high: number; ultra: number }
}

const FOUR_VIEWS: readonly ViewSlot[] = ['front', 'back', 'left', 'right']

const CAPS: Record<GenerateEngineId, Capabilities> = {
  n1: {
    label: 'Zetta N1',
    description: 'Base model. Takes a prompt, a picture or several views, on every plan.',
    paidOnly: false,
    barePrompt: true,
    multiView: true,
    viewSlots: VIEW_TYPES,
    minViews: 1,
    frontViewRequired: false,
    qualityRungs: true,
    lowPoly: true,
    geometryOnly: true,
    bareLowPoly: false,
    sketch: true,
    pbr: true,
    customFaceCount: true,
    detailLevel: false,
    hdTexture: false,
    extremeTexture: false,
    imageTuning: false,
    parts: false,
    quadAnyBase: false,
    rungCounts: { lowpoly: 9_000, high: 200_000, ultra: 1_000_000 },
  },
  n25: {
    label: 'Zetta N2.5',
    description: 'Highest quality of mesh and texture.',
    paidOnly: true,
    barePrompt: false,
    multiView: true,
    viewSlots: FOUR_VIEWS,
    minViews: 2,
    frontViewRequired: true,
    qualityRungs: true,
    lowPoly: true,
    geometryOnly: true,
    bareLowPoly: true,
    sketch: false,
    pbr: true,
    customFaceCount: true,
    detailLevel: true,
    hdTexture: true,
    extremeTexture: false,
    imageTuning: true,
    parts: true,
    quadAnyBase: true,
  },
  np1: {
    label: 'Zetta Np1',
    description: 'Clean low-poly topology, balanced quality.',
    paidOnly: true,
    barePrompt: false,
    multiView: true,
    viewSlots: FOUR_VIEWS,
    minViews: 2,
    frontViewRequired: true,
    qualityRungs: false,
    lowPoly: false,
    geometryOnly: true,
    bareLowPoly: false,
    sketch: false,
    pbr: true,
    customFaceCount: true,
    detailLevel: false,
    hdTexture: true,
    extremeTexture: true,
    imageTuning: true,
    parts: false,
    quadAnyBase: false,
  },
  np15: {
    label: 'Zetta Np1.5',
    description: 'Clean topology, quad native.',
    paidOnly: true,
    barePrompt: false,
    multiView: true,
    viewSlots: FOUR_VIEWS,
    minViews: 2,
    frontViewRequired: true,
    qualityRungs: false,
    lowPoly: false,
    geometryOnly: true,
    bareLowPoly: false,
    sketch: false,
    pbr: true,
    customFaceCount: true,
    detailLevel: false,
    hdTexture: true,
    extremeTexture: true,
    imageTuning: true,
    parts: false,
    quadAnyBase: true,
  },
}

/** One face-count band: the legal range and the count filled in when none is given. */
export interface FaceCountBand {
  /** `null` on an engine without quality levels. */
  quality: Quality | null
  polygonType: PolygonType
  min: number
  max: number
  default: number
}

export interface EngineInfo {
  id: GenerateEngineId
  label: string
  description: string
  /** Needs a paid plan (see `checkEntitlements`). */
  paidOnly: boolean
  inputs: {
    /** A bare text prompt. When false, make a picture from the prompt first (`needsImageForPrompt`). */
    prompt: boolean
    image: boolean
    multiView: boolean
    viewSlots: readonly ViewSlot[]
    minViews: number
    frontViewRequired: boolean
  }
  /** Empty on an engine that builds to a face budget only. */
  qualities: readonly Quality[]
  outputs: readonly Output[]
  /** Low-poly can also be untextured. */
  untexturedLowpoly: boolean
  pbr: boolean
  textureQualities: readonly TextureQuality[]
  polygonTypes: readonly PolygonType[]
  /** Quads only at quality lowpoly. */
  quadsOnlyAtLowpoly: boolean
  parts: boolean
  sketch: boolean
  /** Takes the free tuning options. */
  tuning: boolean
  customFaceCount: boolean
  faceCounts: readonly FaceCountBand[]
  defaults: {
    quality: Quality
    output: Output
    pbr: boolean
    textureQuality: TextureQuality
    polygonType: PolygonType
    /** `null` where the engine has no alignment option. */
    textureAlignment: TextureAlignment | null
    exportUv: boolean
  }
}

function wirePolygonType(polygonType: PolygonType): 'triangle' | 'quadrilateral' {
  return polygonType === 'quad' ? 'quadrilateral' : 'triangle'
}

/** The base a rung resolves to on an engine, for the face-limit lookup. */
function baseForQuality(caps: Capabilities, quality: Quality, output: Output): string {
  if (quality === 'lowpoly' && caps.lowPoly) return OPERATIONS.LOWPOLY
  return output === 'geometry' ? OPERATIONS.GEOMETRY_ONLY : OPERATIONS.TEXTURED
}

function rungModifiers(caps: Capabilities, quality: Quality): string[] {
  return quality === 'ultra' && caps.detailLevel ? [OPERATIONS.DETAILED_GEOMETRY] : []
}

/** The legal polygon count for an engine, rung and topology. */
export function faceCountRange(
  engine: GenerateEngineId,
  quality: Quality = 'high',
  polygonType: PolygonType = 'triangle',
): FaceRange {
  const caps = CAPS[engine]
  return faceLimitsFor(
    engine,
    baseForQuality(caps, quality, 'textured'),
    rungModifiers(caps, quality),
    wirePolygonType(polygonType),
  )
}

/**
 * The count the Studio fills in for a rung — and so the count that is not "custom" and carries no
 * `custom_face_count` charge.
 */
export function defaultFaceCount(
  engine: GenerateEngineId,
  quality: Quality = 'high',
  polygonType: PolygonType = 'triangle',
): number {
  // On N1 a rung is a fixed count; elsewhere the field opens on the most the rung allows.
  const counts = CAPS[engine].rungCounts
  return counts ? counts[quality] : faceCountRange(engine, quality, polygonType).max
}

function bandsFor(engine: GenerateEngineId): FaceCountBand[] {
  const caps = CAPS[engine]
  const polygonTypes: PolygonType[] = caps.quadAnyBase || caps.lowPoly ? ['triangle', 'quad'] : ['triangle']
  const qualities: Array<Quality | null> = caps.qualityRungs ? [...QUALITIES] : [null]
  const bands: FaceCountBand[] = []
  for (const quality of qualities) {
    for (const polygonType of polygonTypes) {
      const rung = quality ?? 'high'
      if (polygonType === 'quad' && !caps.quadAnyBase && rung !== 'lowpoly') continue
      const range = faceCountRange(engine, rung, polygonType)
      bands.push({ quality, polygonType, ...range, default: defaultFaceCount(engine, rung, polygonType) })
    }
  }
  return bands
}

function engineInfo(id: GenerateEngineId): EngineInfo {
  const caps = CAPS[id]
  return {
    id,
    label: caps.label,
    description: caps.description,
    paidOnly: caps.paidOnly,
    inputs: {
      prompt: caps.barePrompt,
      image: true,
      multiView: caps.multiView,
      viewSlots: caps.viewSlots,
      minViews: caps.minViews,
      frontViewRequired: caps.frontViewRequired,
    },
    qualities: caps.qualityRungs ? QUALITIES.filter((q) => q !== 'lowpoly' || caps.lowPoly) : [],
    outputs: caps.geometryOnly ? ['textured', 'geometry'] : ['textured'],
    untexturedLowpoly: caps.bareLowPoly,
    pbr: caps.pbr,
    textureQualities: TEXTURE_QUALITIES.filter(
      (t) => t === 'standard' || (t === 'detailed' && caps.hdTexture) || (t === '8k' && caps.extremeTexture),
    ),
    polygonTypes: caps.quadAnyBase || caps.lowPoly ? ['triangle', 'quad'] : ['triangle'],
    quadsOnlyAtLowpoly: !caps.quadAnyBase && caps.lowPoly,
    parts: caps.parts,
    sketch: caps.sketch,
    tuning: caps.imageTuning,
    customFaceCount: caps.customFaceCount,
    faceCounts: bandsFor(id),
    defaults: {
      quality: 'high',
      output: 'textured',
      pbr: true,
      textureQuality: 'standard',
      polygonType: 'triangle',
      // The Studio fits the texture to the mesh by default.
      textureAlignment: caps.imageTuning ? 'geometry' : null,
      exportUv: true,
    },
  }
}

/** The generation engines, in the order the Studio offers them. */
export const ENGINES: Readonly<Record<GenerateEngineId, EngineInfo>> = {
  n1: engineInfo('n1'),
  n25: engineInfo('n25'),
  np1: engineInfo('np1'),
  np15: engineInfo('np15'),
}

export function isGenerateEngine(value: unknown): value is GenerateEngineId {
  return typeof value === 'string' && (GENERATE_ENGINE_IDS as readonly string[]).includes(value)
}

/**
 * True for engines that cannot take a bare text prompt. For those, make a picture first
 * (`imageForPromptRequest` in `prompts.ts`) and send it as `imageUrl` with `imageFromPrompt: true`.
 */
export function needsImageForPrompt(engine: string): boolean {
  return !(isGenerateEngine(engine) && CAPS[engine].barePrompt)
}

/** CLI-friendly options for one generation. Anything left out takes the Studio's default. */
export interface GenerateInput extends RequestMetadata {
  /** Defaults to `n1`, the engine every plan has. */
  engine?: GenerateEngineId
  /** Text-to-3D on N1; on the other engines only beside the picture made from it. */
  prompt?: string
  imageUrl?: string
  /** The image was made from `prompt` by our own image model: both are sent, the row is text-to-3D. */
  imageFromPrompt?: boolean
  /** Multi-view: slot → image URL. Excludes `prompt` and `imageUrl`; put the main picture in `front`. */
  views?: Partial<Record<ViewSlot, string>>
  /** lowpoly | high | ultra. Defaults to high. Engines without levels take high only. */
  quality?: Quality
  /** textured | geometry. Defaults to textured (geometry when `parts` is on). */
  output?: Output
  /** PBR materials (a paid modifier). Defaults on for a textured output. */
  pbr?: boolean
  /** The polygon budget. Defaults to the rung's own count, which carries no custom-count charge. */
  faceCount?: number
  /** triangle | quad. Defaults to triangle. */
  polygonType?: PolygonType
  /** standard | detailed | 8k. Defaults to standard. */
  textureQuality?: TextureQuality
  /** Split the mesh into editable parts (N2.5, untextured, triangles). */
  parts?: boolean
  /** Fit the texture to the picture or to the mesh. Defaults to geometry where the engine has it. */
  textureAlignment?: TextureAlignment
  /** Scale to real-world size. */
  autoSize?: boolean
  /** Strip baked-in lighting from the reference before texturing. */
  delight?: boolean
  /** Clean the reference picture before reconstructing. Slower. */
  autofixImage?: boolean
  /** Geometry compression for a smaller file. */
  compressGeometry?: boolean
  /** Unwrap UVs. On by default; only `false` is sent. */
  exportUv?: boolean
  /** The faster setting of the standard texture tier. */
  textureFast?: boolean
  modelSeed?: number
  textureSeed?: number
  /** Build from a line drawing (N1, textured, high or ultra). */
  sketch?: boolean
  /** Records that advanced controls were used. */
  advanceControl?: boolean
  /**
   * The plan's `allowsCustomFaceCount`. When false, no count is sent (the engine uses its own),
   * exactly as the Studio does on such plans. Defaults to true.
   */
  allowsCustomFaceCount?: boolean
}

/** The order views are listed in on the wire. Cosmetic since nothing folds, but kept stable. */
const VIEW_SUBMIT_ORDER: readonly ViewSlot[] = [
  'left',
  'right',
  'back',
  'top',
  'bottom',
  'left_front',
  'right_front',
  'front',
]

/** N1 runs low-poly and sketch jobs on an older engine that has only these side slots. */
const N1_LEGACY_SLOTS: readonly ViewSlot[] = ['left', 'right', 'back']

/** Above 15,000 a count is High-Res; from 1,000,000 it is Ultra (inclusive, so Ultra's own default is Ultra). */
function qualityForCount(count: number): Quality | null {
  if (!Number.isInteger(count) || count < SHARED_FACE_LIMITS.min || count > SHARED_FACE_LIMITS.max) return null
  if (count >= 1_000_000) return 'ultra'
  if (count > 15_000) return 'high'
  return 'lowpoly'
}

export function buildGenerateRequest(input: GenerateInput): BuildResult<CreateGenerationRequest> {
  const problems: Problem[] = []
  const warnings: string[] = []

  const engine = input.engine ?? DEFAULT_GEN_MODEL
  if (!isGenerateEngine(engine)) {
    const id = String(engine)
    const message =
      id === 'r1'
        ? 'Zetta R1 only rebuilds topology. Use it with refine retopo, and generate with n1, n25, np1 or np15.'
        : id === 'zs2' || id === 'zs21'
          ? 'Zetta Splat 2 and 2.1 build splat worlds. Use the splat builder for them.'
          : `engine must be one of: ${GENERATE_ENGINE_IDS.join(', ')}.`
    const code = id === 'r1' || id === 'zs2' || id === 'zs21' ? 'ENGINE_NOT_FOR_GENERATION' : 'INVALID_OPTION'
    return { ok: false, problems: [problem(code, message, 'engine')] }
  }
  const caps = CAPS[engine]
  const label = caps.label

  // ---------------------------------------------------------------------------- the inputs
  const prompt = input.prompt?.trim() ?? ''
  const imageUrl = input.imageUrl?.trim() ?? ''
  const viewEntries = Object.entries(input.views ?? {}).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim() !== '',
  )
  const multiView = viewEntries.length > 0

  if (prompt.length > MAX_PROMPT_LENGTH) {
    problems.push(
      problem('PROMPT_TOO_LONG', `The prompt must be ${formatCount(MAX_PROMPT_LENGTH)} characters or fewer.`, 'prompt'),
    )
  }

  // ---------------------------------------------------------------------------- the rung
  let quality: Quality = 'high'
  if (input.quality !== undefined) {
    if (checkEnum(problems, 'quality', input.quality, QUALITIES)) {
      if (!caps.qualityRungs && input.quality !== 'high') {
        const range = faceCountRange(engine)
        problems.push(
          problem(
            'QUALITY_NOT_SUPPORTED',
            `${label} has no quality levels. Set faceCount (${formatCount(range.min)}–${formatCount(range.max)}) instead.`,
            'quality',
          ),
        )
      } else {
        quality = input.quality
      }
    }
  } else if (engine === 'n1' && input.faceCount !== undefined && input.allowsCustomFaceCount !== false) {
    // Typing a count moves the rung on N1, where a rung is a count.
    const implied = qualityForCount(input.faceCount)
    if (implied !== null && implied !== 'high') {
      quality = implied
      warnings.push(`A polygon count of ${formatCount(input.faceCount)} means quality ${implied} on ${label}.`)
    }
  }

  const parts = input.parts === true
  let output: Output = parts ? 'geometry' : 'textured'
  if (input.output !== undefined) {
    if (checkEnum(problems, 'output', input.output, OUTPUTS)) output = input.output
  } else if (parts) {
    warnings.push('A mesh in parts comes out untextured, so output is geometry.')
  }
  if (output === 'geometry' && !caps.geometryOnly) {
    problems.push(problem('OUTPUT_NOT_SUPPORTED', `${label} always generates a textured mesh.`, 'output'))
  }

  let polygonType: PolygonType = 'triangle'
  if (input.polygonType !== undefined && checkEnum(problems, 'polygonType', input.polygonType, POLYGON_TYPES)) {
    polygonType = input.polygonType
  }

  let textureQuality: TextureQuality = 'standard'
  if (input.textureQuality !== undefined && checkEnum(problems, 'textureQuality', input.textureQuality, TEXTURE_QUALITIES)) {
    textureQuality = input.textureQuality
  }

  const base =
    quality === 'lowpoly' && caps.lowPoly
      ? OPERATIONS.LOWPOLY
      : output === 'geometry'
        ? OPERATIONS.GEOMETRY_ONLY
        : OPERATIONS.TEXTURED

  if (base === OPERATIONS.LOWPOLY && output === 'geometry' && !caps.bareLowPoly) {
    problems.push(
      problem(
        'LOWPOLY_IS_TEXTURED',
        `${label} always textures a low-poly mesh. Choose output textured, or quality high.`,
        'output',
      ),
    )
  }

  // ---------------------------------------------------------------------------- parts
  if (parts) {
    if (!caps.parts) {
      problems.push(
        problem(
          'PARTS_NOT_SUPPORTED',
          `${label} cannot generate a mesh in parts. Use Zetta N2.5, or split the finished mesh with refine segment.`,
          'parts',
        ),
      )
    } else {
      if (quality === 'lowpoly') {
        problems.push(
          problem('PARTS_NOT_AT_LOWPOLY', 'A mesh in parts cannot be low-poly. Choose quality high or ultra, or turn off parts.', 'parts'),
        )
      }
      if (output !== 'geometry') {
        problems.push(
          problem('PARTS_NEED_GEOMETRY', 'A mesh in parts comes out untextured. Choose output geometry, or turn off parts.', 'output'),
        )
      }
      if (polygonType === 'quad') {
        problems.push(
          problem('PARTS_NEED_TRIANGLES', 'A mesh in parts comes out as triangles. Choose polygonType triangle, or turn off parts.', 'polygonType'),
        )
      }
    }
  }

  // ---------------------------------------------------------------------------- topology
  if (polygonType === 'quad') {
    if (!caps.quadAnyBase && !caps.lowPoly) {
      problems.push(problem('QUADS_NOT_SUPPORTED', `${label} builds triangles only. Use Zetta Np1.5 for quads.`, 'polygonType'))
    } else if (!caps.quadAnyBase && base !== OPERATIONS.LOWPOLY) {
      problems.push(
        problem('QUADS_NEED_LOWPOLY', `${label} builds quads only at quality lowpoly. Choose lowpoly, or use Zetta N2.5 for quads at any quality.`, 'polygonType'),
      )
    }
  }

  // ---------------------------------------------------------------------------- texture options
  if (input.pbr === true && output === 'geometry') {
    problems.push(
      problem('PBR_NEEDS_TEXTURE', 'PBR materials describe a texture, and the geometry output has none. Choose output textured, or turn off pbr.', 'pbr'),
    )
  }
  const pbr = (input.pbr ?? true) && output === 'textured' && caps.pbr

  if (textureQuality !== 'standard') {
    if (output === 'geometry') {
      problems.push(
        problem('TEXTURE_QUALITY_NEEDS_TEXTURE', 'A texture quality needs a textured output. Choose output textured, or textureQuality standard.', 'textureQuality'),
      )
    } else if (textureQuality === 'detailed' && !caps.hdTexture) {
      problems.push(
        problem('TEXTURE_QUALITY_NOT_SUPPORTED', `${label} has no detailed texture option. Use Zetta N2.5, Np1 or Np1.5.`, 'textureQuality'),
      )
    } else if (textureQuality === '8k' && !caps.extremeTexture) {
      problems.push(
        problem('TEXTURE_QUALITY_NOT_SUPPORTED', `${label} has no 8K texture option. Use Zetta Np1 or Np1.5.`, 'textureQuality'),
      )
    }
  }

  // ---------------------------------------------------------------------------- the spec
  const modifiers: string[] = []
  if (multiView) modifiers.push(OPERATIONS.MULTI_VIEW)
  if (pbr) modifiers.push(OPERATIONS.PBR)
  modifiers.push(...rungModifiers(caps, quality))
  const partsBilled = parts && caps.parts && output === 'geometry' && quality !== 'lowpoly'
  if (partsBilled) modifiers.push(OPERATIONS.GENERATE_PARTS)
  if (output === 'textured') {
    // One texture field: 8K and HD are alternatives, never both.
    if (textureQuality === '8k' && caps.extremeTexture) modifiers.push(OPERATIONS.EXTREME_TEXTURE)
    else if (textureQuality === 'detailed' && caps.hdTexture) modifiers.push(OPERATIONS.DETAILED_TEXTURE)
  }

  // ---------------------------------------------------------------------------- face count
  const allowsCustom = input.allowsCustomFaceCount !== false
  let faceCount: number | undefined
  if (!allowsCustom) {
    if (input.faceCount !== undefined) {
      problems.push(
        problem('CUSTOM_FACE_COUNT_NOT_AVAILABLE', 'Your plan cannot choose a polygon count. Remove faceCount.', 'faceCount'),
      )
    }
  } else {
    const fallback = defaultFaceCount(engine, quality, polygonType)
    if (input.faceCount !== undefined && !isWholeNumber(input.faceCount)) {
      problems.push(problem('FACE_COUNT_NOT_WHOLE', 'faceCount must be a whole number.', 'faceCount'))
    } else {
      const count = input.faceCount ?? fallback
      const range = faceLimitsFor(engine, base, modifiers, wirePolygonType(polygonType))
      if (count < range.min || count > range.max) {
        problems.push(
          problem(
            'FACE_COUNT_OUT_OF_RANGE',
            `faceCount must be between ${formatCount(range.min)} and ${formatCount(range.max)} for ${label} at this quality and topology.`,
            'faceCount',
          ),
        )
      }
      faceCount = count
      // Only a count that differs from the rung's own default is billed as custom.
      if (input.faceCount !== undefined && input.faceCount !== fallback) {
        modifiers.push(OPERATIONS.CUSTOM_FACE_COUNT)
      }
    }
  }

  // ---------------------------------------------------------------------------- where it starts from
  const request: CreateGenerationRequest = { spec: { generation: { base, modifiers } } }

  if (multiView) {
    if (prompt !== '') {
      problems.push(
        problem('PROMPT_WITH_VIEWS', 'Send views or a prompt, not both. A prompt makes one picture, not several views.', 'prompt'),
      )
    }
    if (imageUrl !== '') {
      problems.push(
        problem('IMAGE_WITH_VIEWS', 'Send views or imageUrl, not both. Put the main picture in views.front.', 'imageUrl'),
      )
    }
    if (input.imageFromPrompt === true && prompt === '') {
      warnings.push('imageFromPrompt was ignored: it describes a single picture made from a prompt.')
    }

    const legacy = engine === 'n1' && (base === OPERATIONS.LOWPOLY || input.sketch === true)
    const byType = new Map<ViewSlot, string>()
    for (const [slot, raw] of viewEntries) {
      if (!(VIEW_TYPES as readonly string[]).includes(slot)) {
        problems.push(problem('INVALID_VIEW', `views.${slot} is not a view. Use ${caps.viewSlots.join(', ')}.`, `views.${slot}`))
        continue
      }
      const viewSlot = slot as ViewSlot
      if (!caps.viewSlots.includes(viewSlot)) {
        problems.push(
          problem('VIEW_NOT_SUPPORTED', `${label} takes ${caps.viewSlots.join(', ')} views, not ${slot}.`, `views.${slot}`),
        )
        continue
      }
      byType.set(viewSlot, checkUrl(problems, `views.${slot}`, raw, `The ${slot} view address`))
    }

    if (caps.frontViewRequired && !byType.has('front')) {
      problems.push(problem('FRONT_VIEW_REQUIRED', `A multi-view generation on ${label} needs the front view.`, 'views.front'))
    }
    if (byType.size > 0 && byType.size < caps.minViews) {
      problems.push(
        problem('TOO_FEW_VIEWS', `${label} needs at least ${caps.minViews} views. Use imageUrl for a single picture.`, 'views'),
      )
    }
    if (legacy) {
      // The older engine has no top, bottom or three-quarter slots.
      const dropped = [...byType.keys()].filter((slot) => slot === 'top' || slot === 'bottom')
      const folded = [...byType.keys()].filter((slot) => slot === 'left_front' || slot === 'right_front')
      if (dropped.length > 0) warnings.push(`${label} ignores the ${dropped.join(' and ')} views on a low-poly or sketch job.`)
      if (folded.length > 0) warnings.push(`${label} uses the ${folded.join(' and ')} views as plain side views on a low-poly or sketch job.`)
      const usable = [...byType.keys()].filter(
        (slot) => slot === 'front' || N1_LEGACY_SLOTS.includes(slot) || slot === 'left_front' || slot === 'right_front',
      )
      if (byType.size > 0 && usable.length === 0) {
        problems.push(problem('NO_USABLE_VIEWS', 'None of these views can be used on a low-poly or sketch job. Add a front, back, left or right view.', 'views'))
      }
    }

    request.multiViewImages = VIEW_SUBMIT_ORDER.filter((slot) => byType.has(slot)).map((slot) => ({
      viewType: slot,
      imageUrl: byType.get(slot) as string,
    }))
  } else {
    const hasImage = imageUrl !== ''
    const hasPrompt = prompt !== ''
    const fromPrompt = input.imageFromPrompt === true && hasImage && hasPrompt

    if (hasImage && hasPrompt && !fromPrompt) {
      problems.push(
        problem('PROMPT_AND_IMAGE', 'Use either a prompt or an image, not both. Set imageFromPrompt when the image was made from this prompt.', 'prompt'),
      )
    }
    if (!hasImage && !hasPrompt) {
      problems.push(problem('NO_INPUT', 'Give a prompt, an imageUrl or views to generate from.', 'imageUrl'))
    }
    if (hasPrompt && !hasImage && !caps.barePrompt) {
      problems.push(
        problem(
          'PROMPT_NEEDS_IMAGE',
          `${label} generates from a picture. Make one from the prompt first, then send it as imageUrl with imageFromPrompt.`,
          'prompt',
        ),
      )
    }
    if (input.imageFromPrompt === true && !fromPrompt) {
      warnings.push('imageFromPrompt was ignored: it needs both a prompt and an imageUrl.')
    }

    const url = hasImage ? checkUrl(problems, 'imageUrl', imageUrl, 'The image address') : ''
    if (fromPrompt) {
      request.imageUrl = url
      request.prompt = prompt
      request.imageFromPrompt = true
    } else if (hasImage) {
      request.imageUrl = url
    } else if (hasPrompt) {
      request.prompt = prompt
    }
  }

  if (faceCount !== undefined) request.faceCount = faceCount

  // ---------------------------------------------------------------------------- engine fields
  // Quads ride on the low-poly base everywhere, and on any base where the engine takes them; never beside parts.
  if ((base === OPERATIONS.LOWPOLY || caps.quadAnyBase) && !(partsBilled && polygonType === 'quad')) {
    request.polygonType = wirePolygonType(polygonType)
  }
  if (base === OPERATIONS.LOWPOLY && output === 'geometry' && caps.bareLowPoly) {
    request.generationType = 'Geometry'
  }

  if (input.sketch === true) {
    if (!caps.sketch) {
      problems.push(problem('SKETCH_NOT_SUPPORTED', `${label} has no sketch mode. Use Zetta N1.`, 'sketch'))
    } else if (base !== OPERATIONS.TEXTURED) {
      problems.push(problem('SKETCH_NEEDS_TEXTURED', 'Sketch mode needs output textured at quality high or ultra.', 'sketch'))
    } else {
      request.generationType = 'Sketch'
    }
  }

  const metadata = buildMetadata(input, problems)
  if (metadata.availability) request.availability = metadata.availability

  // The free tuning options: sent only when they change something, and only where the engine has them.
  const tuningAsked: string[] = []
  const tune = <K extends keyof CreateGenerationRequest>(name: K, value: CreateGenerationRequest[K]) => {
    tuningAsked.push(name)
    if (caps.imageTuning) request[name] = value
  }
  if (input.autoSize === true) tune('autoSize', true)
  if (input.textureAlignment !== undefined) {
    if (checkEnum(problems, 'textureAlignment', input.textureAlignment, TEXTURE_ALIGNMENTS) && input.textureAlignment !== 'original_image') {
      tune('textureAlignment', input.textureAlignment)
    }
  } else if (caps.imageTuning) {
    // The Studio's default (fit to mesh) differs from the engine's, so it is sent.
    request.textureAlignment = 'geometry'
  }
  if (input.autofixImage === true) tune('autofixImage', true)
  if (input.compressGeometry === true) tune('compressGeometry', true)
  if (input.delight === true) tune('delight', true)
  // Inverted: UVs are on unless turned off, so only `false` travels.
  if (input.exportUv === false) tune('exportUv', false)
  if (input.textureFast === true) {
    tune('textureFast', true)
    if (textureQuality !== 'standard') warnings.push('textureFast only speeds up the standard texture tier, so it is ignored here.')
  }
  for (const seed of ['modelSeed', 'textureSeed'] as const) {
    const value = input[seed]
    if (value === undefined) continue
    if (!isWholeNumber(value)) {
      problems.push(problem('SEED_NOT_WHOLE', `${seed} must be a whole number.`, seed))
    } else {
      tune(seed, value)
    }
  }
  if (tuningAsked.length > 0 && !caps.imageTuning) {
    problems.push(
      problem(
        'TUNING_NOT_SUPPORTED',
        `${label} does not take ${tuningAsked.join(', ')}. Those options need Zetta N2.5, Np1 or Np1.5.`,
        tuningAsked[0],
      ),
    )
  }

  if (metadata.title) request.title = metadata.title
  if (metadata.tags) request.tags = metadata.tags
  if (input.advanceControl === true) request.advanceControl = true
  request.model = engine
  request.origin = metadata.origin

  if (!allowsCustom) {
    warnings.push('Your plan cannot choose a polygon count, so none is sent and the engine uses its own.')
  }

  if (problems.length > 0) return { ok: false, problems }

  const quote: QuoteSpec = { generation: { base, modifiers: [...modifiers] }, model: engine }
  return { ok: true, request, quote, warnings }
}

// ------------------------------------------------------------------------------- entitlements

/** The body of `GET /api/3d/entitlements` (its `entitlements` object). */
export interface ThreeDEntitlements {
  /** 0 means multi-view is unavailable. */
  maxMultiViewImages: number
  allowsLowPoly: boolean
  allowsQuadMesh: boolean
  allowsCustomFaceCount: boolean
  /** Read as a flag: at or above 1,000,000 the plan has Ultra. */
  maxFaceCount: number
  allowsZettaN25: boolean
  /** Covers Np1 and Np1.5. */
  allowsZettaNp1: boolean
  /** The refine tools. */
  allowsPostProcess: boolean
  allowsPrivateGenerations: boolean
  /** Absent on older responses, where `allowsPrivateGenerations` answers the same question. */
  allowsSplat?: boolean
  maxConcurrentJobs: number | null
  concurrency?: { total: number | null; perCategory: Record<string, number> }
}

/** The count from which a request is asking for Ultra. */
export const ULTRA_FACE_COUNT = 1_000_000

/**
 * Every plan rule a request breaks, as the server checks them before any credits move (it answers
 * 403 `PLAN_CAPABILITY_REQUIRED` with the same list). Empty when the plan allows the request.
 */
export function checkEntitlements(request: CreateGenerationRequest, ent: ThreeDEntitlements): Problem[] {
  const problems: Problem[] = []
  const base = request.spec.generation?.base
  const modifiers = request.spec.generation?.modifiers ?? []
  const postProcess = request.spec.postProcess ?? []
  const model = (request.model ?? DEFAULT_GEN_MODEL).trim().toLowerCase()

  // The model first: the broadest refusal.
  if (model === 'n25' && !ent.allowsZettaN25) {
    problems.push(
      problem('MODEL_NOT_AVAILABLE', 'Zetta N2.5 is available on paid plans. Zetta N1 generates from text and images on every plan.', 'engine'),
    )
  }
  if ((model === 'np1' || model === 'np15') && !ent.allowsZettaNp1) {
    problems.push(
      problem(
        'MODEL_NOT_AVAILABLE',
        `${model === 'np1' ? 'Zetta Np1' : 'Zetta Np1.5'} is available on paid plans. Zetta N1 generates from text and images on every plan.`,
        'engine',
      ),
    )
  }

  if (base === OPERATIONS.GAUSSIAN_SPLAT && !(ent.allowsSplat ?? ent.allowsPrivateGenerations)) {
    problems.push(problem('SPLAT_NOT_AVAILABLE', 'Gaussian splats are available on paid plans.', 'engine'))
  }

  if (postProcess.length > 0 && !ent.allowsPostProcess) {
    problems.push(
      problem(
        'TOOLS_NOT_AVAILABLE',
        'Retopology, segmentation, texturing, rigging and format conversion are available on paid plans. Your plan generates models from text and images.',
        'tool',
      ),
    )
  }

  // Only an explicit `private` is refused; an omitted one resolves to the plan's default.
  if ((request.availability ?? '').trim().toLowerCase() === 'private' && !ent.allowsPrivateGenerations) {
    problems.push(
      problem('PRIVATE_NOT_AVAILABLE', 'Keeping a model private is available on paid plans. Models made on your plan are public.', 'availability'),
    )
  }

  const views = request.multiViewImages?.length ?? 0
  if (views > 0) {
    if (ent.maxMultiViewImages <= 0) {
      problems.push(
        problem('MULTI_VIEW_NOT_AVAILABLE', 'Multi-view input is available on paid plans. Your plan generates from a single reference image.', 'views'),
      )
    } else if (views > ent.maxMultiViewImages) {
      problems.push(
        problem(
          'MULTI_VIEW_TOO_MANY_IMAGES',
          `Your plan takes up to ${ent.maxMultiViewImages} multi-view images and this request has ${views}. All 4 views are available from Basic.`,
          'views',
        ),
      )
    }
  }
  // The modifier is what is billed, so it counts even with no images.
  if (modifiers.includes(OPERATIONS.MULTI_VIEW) && views === 0 && ent.maxMultiViewImages <= 0) {
    problems.push(
      problem('MULTI_VIEW_NOT_AVAILABLE', 'Multi-view input is available on paid plans. Your plan generates from a single reference image.', 'views'),
    )
  }

  if (base === OPERATIONS.LOWPOLY && !ent.allowsLowPoly) {
    problems.push(
      problem('LOWPOLY_NOT_AVAILABLE', 'Low-poly generation is available on paid plans. Your plan generates at standard density.', 'quality'),
    )
  }

  // Quads are gated wherever they appear: generation, retopology or conversion.
  if (request.polygonType === 'quadrilateral' && !ent.allowsQuadMesh) {
    problems.push(
      problem('QUAD_MESH_NOT_AVAILABLE', 'Quad meshes are available from Basic. Your plan outputs triangles.', 'polygonType'),
    )
  }

  if (modifiers.includes(OPERATIONS.CUSTOM_FACE_COUNT) && !ent.allowsCustomFaceCount) {
    problems.push(
      problem(
        'CUSTOM_FACE_COUNT_NOT_AVAILABLE',
        'Choosing your own polygon count is available on paid plans. Your plan generates at the density its quality implies.',
        'faceCount',
      ),
    )
  }

  // The server's rule: Ultra is locked by plan, but a count below 1,000,000 is never clipped by plan
  // (the Studio's lock also refuses counts above `maxFaceCount`; the server does not, and wins).
  const asksForUltra =
    modifiers.includes(OPERATIONS.DETAILED_GEOMETRY) ||
    (typeof request.faceCount === 'number' && request.faceCount >= ULTRA_FACE_COUNT)
  if (asksForUltra && ent.maxFaceCount < ULTRA_FACE_COUNT) {
    problems.push(
      problem('ULTRA_DETAIL_NOT_AVAILABLE', 'Ultra detail is available from Basic. Your plan can generate at every other quality level.', 'quality'),
    )
  }

  return problems
}
