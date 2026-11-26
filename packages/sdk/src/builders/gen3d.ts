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
  VIEW_TYPES,
  buildMetadata,
  checkEnum,
  checkUrl,
  faceLimitsFor,
  formatCount,
  isWholeNumber,
  problem,
  retiredModelMessage,
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

export const GENERATE_ENGINE_IDS = ['n25', 'np1', 'np15'] as const
export type GenerateEngineId = (typeof GENERATE_ENGINE_IDS)[number]

/** The Studio's Low-Poly / High-Res / Ultra rungs (Zetta N2.5 only). */
export const QUALITIES = ['lowpoly', 'high', 'ultra'] as const
export type Quality = (typeof QUALITIES)[number]
export const OUTPUTS = ['textured', 'geometry'] as const
export type Output = (typeof OUTPUTS)[number]
export const POLYGON_TYPES = ['triangle', 'quad'] as const
export type PolygonType = (typeof POLYGON_TYPES)[number]
/** standard is free; detailed (HD) and extreme (8K, the Np line only) are paid modifiers. */
export const TEXTURE_QUALITIES = ['standard', 'detailed', 'extreme'] as const
export type TextureQuality = (typeof TEXTURE_QUALITIES)[number]
/** Earlier spellings that are still read: `8k` is `extreme`. */
export const TEXTURE_QUALITY_ALIASES: Readonly<Record<string, TextureQuality>> = { '8k': 'extreme' }
export const TEXTURE_ALIGNMENTS = ['original_image', 'geometry'] as const
export type TextureAlignment = (typeof TEXTURE_ALIGNMENTS)[number]

/** A multi-view slot. Every engine takes front, back, left and right. */
export type ViewSlot = ViewType

/** Which Studio tab offers an engine: Generate 3D (N2.5) or Generate Smart 3D (the Np line). */
export type StudioTab = 'generate' | 'smart'

/** What each generation engine can be asked for. Mirrors the server's capability table. */
interface Capabilities {
  label: string
  description: string
  tab: StudioTab
  paidOnly: boolean
  viewSlots: readonly ViewSlot[]
  /** The server refuses a set below this, or without a front view. */
  minViews: number
  frontViewRequired: boolean
  /** Whether the quality rungs mean anything (the Np line builds to a face budget only). */
  qualityRungs: boolean
  lowPoly: boolean
  geometryOnly: boolean
  /** An untextured low-poly mesh (`generationType: Geometry`). */
  bareLowPoly: boolean
  pbr: boolean
  customFaceCount: boolean
  /** Ultra is a paid `detailed_geometry` level. */
  detailLevel: boolean
  hdTexture: boolean
  extremeTexture: boolean
  parts: boolean
  /** Quads at any quality. */
  quadAnyBase: boolean
}

const FOUR_VIEWS: readonly ViewSlot[] = ['front', 'back', 'left', 'right']

const CAPS: Record<GenerateEngineId, Capabilities> = {
  n25: {
    label: 'Zetta N2.5',
    description: 'Highest quality of mesh and texture.',
    tab: 'generate',
    paidOnly: true,
    viewSlots: FOUR_VIEWS,
    minViews: 2,
    frontViewRequired: true,
    qualityRungs: true,
    lowPoly: true,
    geometryOnly: true,
    bareLowPoly: true,
    pbr: true,
    customFaceCount: true,
    detailLevel: true,
    hdTexture: true,
    extremeTexture: false,
    parts: true,
    quadAnyBase: true,
  },
  np1: {
    label: 'Zetta Np1',
    description: 'Clean topology, balanced quality. Triangles only.',
    tab: 'smart',
    paidOnly: true,
    viewSlots: FOUR_VIEWS,
    minViews: 2,
    frontViewRequired: true,
    qualityRungs: false,
    lowPoly: false,
    geometryOnly: true,
    bareLowPoly: false,
    pbr: true,
    customFaceCount: true,
    detailLevel: false,
    hdTexture: true,
    extremeTexture: true,
    parts: false,
    quadAnyBase: false,
  },
  np15: {
    label: 'Zetta Np1.5',
    description: 'Clean topology, quad native.',
    tab: 'smart',
    paidOnly: true,
    viewSlots: FOUR_VIEWS,
    minViews: 2,
    frontViewRequired: true,
    qualityRungs: false,
    lowPoly: false,
    geometryOnly: true,
    bareLowPoly: false,
    pbr: true,
    customFaceCount: true,
    detailLevel: false,
    hdTexture: true,
    extremeTexture: true,
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
  /** The Studio tab that offers it: Generate 3D or Generate Smart 3D. */
  tab: StudioTab
  /** Needs a paid plan (see `checkEntitlements`). Every generation does now. */
  paidOnly: boolean
  inputs: {
    /** A text prompt: it always becomes a picture first (`needsImageForPrompt`). */
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
  parts: boolean
  /** Takes the free tuning options (auto size, alignment, delight, autofix, compression, UVs, seeds). */
  tuning: boolean
  customFaceCount: boolean
  faceCounts: readonly FaceCountBand[]
  defaults: {
    /** `null` on an engine without quality levels. */
    quality: Quality | null
    output: Output
    pbr: boolean
    textureQuality: TextureQuality
    polygonType: PolygonType
    textureAlignment: TextureAlignment
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
 * The count the Studio fills in for a rung — the most it allows — and so the count that is not
 * "custom" and carries no `custom_face_count` charge.
 */
export function defaultFaceCount(
  engine: GenerateEngineId,
  quality: Quality = 'high',
  polygonType: PolygonType = 'triangle',
): number {
  return faceCountRange(engine, quality, polygonType).max
}

function polygonTypesOf(caps: Capabilities): PolygonType[] {
  return caps.quadAnyBase ? ['triangle', 'quad'] : ['triangle']
}

function bandsFor(engine: GenerateEngineId): FaceCountBand[] {
  const caps = CAPS[engine]
  const qualities: Array<Quality | null> = caps.qualityRungs ? [...QUALITIES] : [null]
  const bands: FaceCountBand[] = []
  for (const quality of qualities) {
    for (const polygonType of polygonTypesOf(caps)) {
      const rung = quality ?? 'high'
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
    tab: caps.tab,
    paidOnly: caps.paidOnly,
    inputs: {
      prompt: true,
      image: true,
      multiView: caps.viewSlots.length > 0,
      viewSlots: caps.viewSlots,
      minViews: caps.minViews,
      frontViewRequired: caps.frontViewRequired,
    },
    qualities: caps.qualityRungs ? QUALITIES.filter((q) => q !== 'lowpoly' || caps.lowPoly) : [],
    outputs: caps.geometryOnly ? ['textured', 'geometry'] : ['textured'],
    untexturedLowpoly: caps.bareLowPoly,
    pbr: caps.pbr,
    textureQualities: TEXTURE_QUALITIES.filter(
      (t) => t === 'standard' || (t === 'detailed' && caps.hdTexture) || (t === 'extreme' && caps.extremeTexture),
    ),
    polygonTypes: polygonTypesOf(caps),
    parts: caps.parts,
    tuning: true,
    customFaceCount: caps.customFaceCount,
    faceCounts: bandsFor(id),
    defaults: {
      quality: caps.qualityRungs ? 'high' : null,
      output: 'textured',
      pbr: true,
      textureQuality: 'standard',
      polygonType: 'triangle',
      // The Studio fits the texture to the mesh by default, on both tabs.
      textureAlignment: 'geometry',
      exportUv: true,
    },
  }
}

/** The generation engines, in the order the Studio offers them. */
export const ENGINES: Readonly<Record<GenerateEngineId, EngineInfo>> = {
  n25: engineInfo('n25'),
  np1: engineInfo('np1'),
  np15: engineInfo('np15'),
}

export function isGenerateEngine(value: unknown): value is GenerateEngineId {
  return typeof value === 'string' && (GENERATE_ENGINE_IDS as readonly string[]).includes(value)
}

/**
 * True for every engine: no engine takes a bare text prompt, so the Studio makes a picture first
 * (`imageForPromptRequest` in `prompts.ts`) and sends it as `imageUrl` with `imageFromPrompt: true`.
 * (A bare prompt is still accepted: the server then draws the picture itself, unseen.)
 */
export function needsImageForPrompt(_engine: string): boolean {
  return true
}

/** CLI-friendly options for one generation. Anything left out takes the Studio's default. */
export interface GenerateInput extends RequestMetadata {
  /** Defaults to `n25`. */
  engine?: GenerateEngineId
  /** Text to 3D: sent beside the picture made from it (`imageFromPrompt`), or alone. */
  prompt?: string
  imageUrl?: string
  /** The image was made from `prompt` by our own image model: both are sent, the row is text-to-3D. */
  imageFromPrompt?: boolean
  /** Multi-view: slot → image URL. Excludes `prompt` and `imageUrl`; put the main picture in `front`. */
  views?: Partial<Record<ViewSlot, string>>
  /** lowpoly | high | ultra (N2.5). Defaults to high. The Np line takes high only. */
  quality?: Quality
  /** textured | geometry. Defaults to textured (geometry when `parts` is on). */
  output?: Output
  /** PBR materials (a paid modifier). Defaults on for a textured output. */
  pbr?: boolean
  /** The polygon budget. Defaults to the most the rung allows, which carries no custom-count charge. */
  faceCount?: number
  /** triangle | quad. Defaults to triangle. */
  polygonType?: PolygonType
  /** standard | detailed | extreme (`8k` is read as extreme). Defaults to standard. */
  textureQuality?: TextureQuality | '8k'
  /** Split the mesh into editable parts (N2.5, untextured, triangles, not low-poly). */
  parts?: boolean
  /** Fit the texture to the picture or to the mesh. Defaults to geometry, as the Studio does. */
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
  /** Records that the picture was reviewed before it became a mesh (the Studio's Control Mode). */
  advanceControl?: boolean
  /**
   * The plan's `allowsCustomFaceCount`. When false, no count is sent (the engine uses its own),
   * exactly as the Studio does on such plans. Defaults to true.
   */
  allowsCustomFaceCount?: boolean
}

/** The order views are listed in on the wire, as the Studio sends them: front last. */
const VIEW_SUBMIT_ORDER: readonly ViewSlot[] = ['left', 'right', 'back', 'front']

function normaliseTextureQuality(value: unknown): unknown {
  return typeof value === 'string' ? (TEXTURE_QUALITY_ALIASES[value.toLowerCase()] ?? value) : value
}

export function buildGenerateRequest(input: GenerateInput): BuildResult<CreateGenerationRequest> {
  const problems: Problem[] = []
  const warnings: string[] = []

  const engine = input.engine ?? DEFAULT_GEN_MODEL
  if (!isGenerateEngine(engine)) {
    const id = String(engine)
    const retired = retiredModelMessage(id)
    if (retired) return { ok: false, problems: [problem('ENGINE_RETIRED', retired, 'engine')] }
    const message =
      id === 'r1'
        ? 'Zetta R1 only rebuilds topology. Use it with refine retopo, and generate with n25, np1 or np15.'
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
  if (input.quality !== undefined && checkEnum(problems, 'quality', input.quality, QUALITIES)) {
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
  const askedTexture = normaliseTextureQuality(input.textureQuality)
  if (askedTexture !== undefined && checkEnum(problems, 'textureQuality', askedTexture, TEXTURE_QUALITIES)) {
    textureQuality = askedTexture
  }

  const base =
    quality === 'lowpoly' && caps.lowPoly
      ? OPERATIONS.LOWPOLY
      : output === 'geometry'
        ? OPERATIONS.GEOMETRY_ONLY
        : OPERATIONS.TEXTURED

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
  if (polygonType === 'quad' && !caps.quadAnyBase) {
    problems.push(
      problem('QUADS_NOT_SUPPORTED', `${label} builds triangles only. Use Zetta Np1.5 or N2.5 for quads.`, 'polygonType'),
    )
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
        problem('TEXTURE_QUALITY_NOT_SUPPORTED', `${label} has no detailed texture option.`, 'textureQuality'),
      )
    } else if (textureQuality === 'extreme' && !caps.extremeTexture) {
      problems.push(
        problem(
          'TEXTURE_QUALITY_NOT_SUPPORTED',
          `${label} has no extreme (8K) texture option. Use Zetta Np1 or Np1.5, or textureQuality detailed.`,
          'textureQuality',
        ),
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
    // One texture field: extreme and detailed are alternatives, never both.
    if (textureQuality === 'extreme' && caps.extremeTexture) modifiers.push(OPERATIONS.EXTREME_TEXTURE)
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
    if (hasPrompt && !hasImage) {
      warnings.push(
        `${label} builds from a picture, so the server draws one from the prompt first, unseen. To see or choose it, make the picture yourself and send it as imageUrl with imageFromPrompt.`,
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
  // Quads ride on any base where the engine takes them; never beside parts.
  if (caps.quadAnyBase && !(partsBilled && polygonType === 'quad')) {
    request.polygonType = wirePolygonType(polygonType)
  }
  if (base === OPERATIONS.LOWPOLY && output === 'geometry' && caps.bareLowPoly) {
    request.generationType = 'Geometry'
  }

  const metadata = buildMetadata(input, problems)
  if (metadata.availability) request.availability = metadata.availability

  // The free tuning options: sent only when they change something. Every engine takes them.
  if (input.autoSize === true) request.autoSize = true
  if (input.textureAlignment !== undefined) {
    if (checkEnum(problems, 'textureAlignment', input.textureAlignment, TEXTURE_ALIGNMENTS) && input.textureAlignment !== 'original_image') {
      request.textureAlignment = input.textureAlignment
    }
  } else {
    // The Studio's default (fit to mesh) differs from the engine's, so it is sent.
    request.textureAlignment = 'geometry'
  }
  if (input.autofixImage === true) request.autofixImage = true
  if (input.compressGeometry === true) request.compressGeometry = true
  if (input.delight === true) request.delight = true
  // Inverted: UVs are on unless turned off, so only `false` travels.
  if (input.exportUv === false) request.exportUv = false
  if (input.textureFast === true) {
    request.textureFast = true
    if (textureQuality !== 'standard') warnings.push('textureFast only speeds up the standard texture tier, so it is ignored here.')
  }
  for (const seed of ['modelSeed', 'textureSeed'] as const) {
    const value = input[seed]
    if (value === undefined) continue
    if (!isWholeNumber(value)) {
      problems.push(problem('SEED_NOT_WHOLE', `${seed} must be a whole number.`, seed))
    } else {
      request[seed] = value
    }
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
  /** False exactly on an account with no paid plan, which cannot generate anything at all. */
  allowsPrivateGenerations: boolean
  /** Absent on older responses, where `allowsPrivateGenerations` answers the same question. */
  allowsSplat?: boolean
  maxConcurrentJobs: number | null
  concurrency?: { total: number | null; perCategory: Record<string, number> }
}

/** The count from which a request is asking for Ultra. */
export const ULTRA_FACE_COUNT = 1_000_000

/** What the server says to an account with no plan (403 `PLAN_REQUIRED`). */
export const PLAN_REQUIRED_MESSAGE = 'Choose a plan to start generating.'

/** Whether the plan may generate at all: every 3D and image job needs a paid plan. */
export function hasPaidPlan(ent: ThreeDEntitlements): boolean {
  return ent.allowsPrivateGenerations
}

/**
 * Every plan rule a request breaks, as the server checks them before any credits move. An account
 * with no paid plan gets one answer, `PLAN_REQUIRED` (403), whatever it asked for; a paid plan that
 * lacks a feature gets the list the server answers 403 `PLAN_CAPABILITY_REQUIRED` with. Empty when
 * the plan allows the request.
 */
export function checkEntitlements(request: CreateGenerationRequest, ent: ThreeDEntitlements): Problem[] {
  // No plan, no job: the server refuses before it looks at anything else.
  if (!hasPaidPlan(ent)) return [problem('PLAN_REQUIRED', PLAN_REQUIRED_MESSAGE, 'plan')]

  const problems: Problem[] = []
  const base = request.spec.generation?.base
  const modifiers = request.spec.generation?.modifiers ?? []
  const postProcess = request.spec.postProcess ?? []
  // A retopology always runs on Zetta R1, whatever it names.
  const model =
    !request.spec.generation && postProcess.includes(OPERATIONS.SMART_TOPOLOGY)
      ? 'r1'
      : (request.model ?? DEFAULT_GEN_MODEL).trim().toLowerCase()

  // The model first: the broadest refusal.
  if (model === 'n25' && !ent.allowsZettaN25) {
    problems.push(problem('MODEL_NOT_AVAILABLE', `Zetta N2.5 is available on paid plans. ${PLAN_REQUIRED_MESSAGE}`, 'engine'))
  }
  if ((model === 'np1' || model === 'np15') && !ent.allowsZettaNp1) {
    problems.push(
      problem(
        'MODEL_NOT_AVAILABLE',
        `Generate Smart 3D runs on ${model === 'np1' ? 'Zetta Np1' : 'the Zetta Np line'}, which is available on paid plans. ${PLAN_REQUIRED_MESSAGE}`,
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
          `Your plan takes up to ${ent.maxMultiViewImages} multi-view images and this request has ${views}. Four views — front, back, left and right — is the most a generation takes.`,
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
      problem(
        'QUAD_MESH_NOT_AVAILABLE',
        'Quad meshes are available on paid plans, on both low-poly generation and retopology. Your plan outputs triangles.',
        'polygonType',
      ),
    )
  }

  if (modifiers.includes(OPERATIONS.CUSTOM_FACE_COUNT) && !ent.allowsCustomFaceCount) {
    problems.push(
      problem(
        'CUSTOM_FACE_COUNT_NOT_AVAILABLE',
        'Choosing your own polygon count is available on paid plans. Your plan generates at the density its quality setting implies.',
        'faceCount',
      ),
    )
  }

  // The server's rule: Ultra is locked by plan, and a count of 1,000,000 or more asks for it too.
  const asksForUltra =
    modifiers.includes(OPERATIONS.DETAILED_GEOMETRY) ||
    (typeof request.faceCount === 'number' && request.faceCount >= ULTRA_FACE_COUNT)
  if (asksForUltra && ent.maxFaceCount < ULTRA_FACE_COUNT) {
    problems.push(
      problem('ULTRA_DETAIL_NOT_AVAILABLE', 'Ultra detail is available on paid plans. Your plan can generate at every other quality level.', 'quality'),
    )
  }

  return problems
}
