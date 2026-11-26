/**
 * Gaussian splats: `gaussian_splat` generations on Zetta Splat (n25) and the Zetta Splat 2 / 2.1
 * world engines (zs2, zs21), and the exports of a finished world.
 */
import {
  MAX_PROMPT_LENGTH,
  OPERATIONS,
  WORLD_MESH_VARIANTS,
  WORLD_SPLAT_RESOLUTIONS,
  buildMetadata,
  checkEnum,
  checkUrl,
  formatCount,
  isWholeNumber,
  problem,
  type BuildResult,
  type CreateGenerationRequest,
  type Problem,
  type QuoteSpec,
  type RequestMetadata,
  type WorldMeshVariant,
  type WorldSplatResolution,
} from './common'
import type { ImageAspectRatio, ImageResolution } from './prompts'

export const SPLAT_ENGINE_IDS = ['n25', 'zs2', 'zs21'] as const
export type SplatEngineId = (typeof SPLAT_ENGINE_IDS)[number]

export interface SplatEngineInfo {
  id: SplatEngineId
  label: string
  description: string
  /** Builds from a video as well as a picture. */
  video: boolean
  /** Takes more pictures of the same place (`worldViews`). */
  worldViews: boolean
  /** Reads a prompt as a description of the scene beside the picture. */
  promptAsDescription: boolean
  /** Takes a seed. */
  seed: boolean
}

export const SPLAT_ENGINES: Readonly<Record<SplatEngineId, SplatEngineInfo>> = {
  n25: {
    id: 'n25',
    label: 'Zetta Splat',
    description: 'A Gaussian splat of what is in one picture.',
    video: false,
    worldViews: false,
    promptAsDescription: false,
    seed: true,
  },
  zs2: {
    id: 'zs2',
    label: 'Zetta Splat 2',
    description: 'A whole navigable world from one picture, a video or several directions.',
    video: true,
    worldViews: true,
    promptAsDescription: true,
    seed: false,
  },
  zs21: {
    id: 'zs21',
    label: 'Zetta Splat 2.1',
    description: 'The same as Zetta Splat 2, built larger.',
    video: true,
    worldViews: true,
    promptAsDescription: true,
    seed: false,
  },
}

/** The forward picture faces 0°; other directions are 1–359. */
export const FORWARD_AZIMUTH = 0
/** Pictures in a world, the main one included: four, or eight as "pictures of the same space". */
export const MAX_WORLD_PICTURES = 4
export const MAX_WORLD_PICTURES_SAME_SPACE = 8

export function maxWorldPictures(sameSpace: boolean): number {
  return sameSpace ? MAX_WORLD_PICTURES_SAME_SPACE : MAX_WORLD_PICTURES
}

export const SPLAT_SUBJECTS = ['object', 'environment'] as const
export type SplatSubject = (typeof SPLAT_SUBJECTS)[number]

/** The frames an environment's picture can be made in, and its sizes. The Studio opens on 16:9 at 1K. */
export const SPLAT_ASPECT_RATIOS = ['16:9', '21:9', '3:2', '4:3', '1:1'] as const satisfies readonly ImageAspectRatio[]
export type SplatAspectRatio = (typeof SPLAT_ASPECT_RATIOS)[number]
export const SPLAT_RESOLUTIONS = ['1K', '2K', '4K'] as const satisfies readonly ImageResolution[]
export type SplatResolution = (typeof SPLAT_RESOLUTIONS)[number]

/**
 * The subject a prompt's picture is made for when none is named: an environment on the world
 * engines, an object on Zetta Splat. (The Studio opens on object; it shows the choice.)
 */
export function defaultSplatSubject(engine: SplatEngineId): SplatSubject {
  return SPLAT_ENGINES[engine].worldViews ? 'environment' : 'object'
}

/**
 * Checks the frame for a picture made from a prompt: an environment takes a ratio and a size, an
 * object is always the square frame the converter reads. Returns the problems, empty when fine.
 */
export function splatPictureProblems(options: {
  subject: SplatSubject
  aspectRatio?: string
  resolution?: string
}): Problem[] {
  const problems: Problem[] = []
  if (options.aspectRatio !== undefined) {
    if (options.subject !== 'environment') {
      problems.push(problem('OPTION_NOT_APPLICABLE', 'aspectRatio applies to an environment’s picture only. Remove it, or choose subject environment.', 'aspectRatio'))
    } else {
      checkEnum(problems, 'aspectRatio', options.aspectRatio, SPLAT_ASPECT_RATIOS)
    }
  }
  if (options.resolution !== undefined) {
    if (options.subject !== 'environment') {
      problems.push(problem('OPTION_NOT_APPLICABLE', 'resolution applies to an environment’s picture only. Remove it, or choose subject environment.', 'resolution'))
    } else {
      checkEnum(problems, 'resolution', options.resolution, SPLAT_RESOLUTIONS)
    }
  }
  return problems
}

/**
 * Whether the Studio cuts the picture out of its background before upload. Only an object on
 * Zetta Splat: an environment is all background, and the world engines rebuild a whole place.
 */
export function splatOffersCutOut(engine: SplatEngineId, subject: SplatSubject): boolean {
  return subject === 'object' && engine === 'n25'
}

/** Notice for every splat: the feature is early access, and a refused account is not charged. */
export const SPLAT_EARLY_ACCESS_NOTE =
  'Generate Splat is in early access. An account without early access is refused (EARLY_ACCESS_REQUIRED) and nothing is charged.'

export interface SplatInput extends RequestMetadata {
  /** Defaults to n25 (Zetta Splat). */
  engine?: SplatEngineId
  /** What the picture shows. Decides the picture made from a prompt and the cut-out; not sent. */
  subject?: SplatSubject
  /** The picture's background is cut out first. Only an object on Zetta Splat; not sent. */
  removeBackground?: boolean
  imageUrl?: string
  /** A world from a video instead of a picture (zs2, zs21). */
  videoUrl?: string
  /** More pictures of the same place beside `imageUrl`, each facing `azimuth` degrees (omit if unknown). */
  worldViews?: Array<{ azimuth?: number | null; imageUrl: string }>
  /** "Pictures of the same space": reconstruct from all the pictures together (up to eight). */
  reconstructImages?: boolean
  /** On the world engines, a description of the scene. On n25, only the prompt the picture was made from. */
  prompt?: string
  /** `imageUrl` was made from `prompt` by our image model. */
  imageFromPrompt?: boolean
  /** n25 only. */
  seed?: number
}

function isSplatEngine(value: unknown): value is SplatEngineId {
  return typeof value === 'string' && (SPLAT_ENGINE_IDS as readonly string[]).includes(value)
}

export function buildSplatRequest(input: SplatInput): BuildResult<CreateGenerationRequest> {
  const problems: Problem[] = []
  const warnings: string[] = [SPLAT_EARLY_ACCESS_NOTE]

  const engine = input.engine ?? 'n25'
  if (!isSplatEngine(engine)) {
    return {
      ok: false,
      problems: [problem('INVALID_OPTION', `engine must be one of: ${SPLAT_ENGINE_IDS.join(', ')}.`, 'engine')],
    }
  }
  const caps = SPLAT_ENGINES[engine]
  const label = caps.label
  const subjectOk = input.subject === undefined || checkEnum(problems, 'subject', input.subject, SPLAT_SUBJECTS)
  const subject: SplatSubject = subjectOk && input.subject !== undefined ? input.subject : defaultSplatSubject(engine)
  if (input.removeBackground === true && !splatOffersCutOut(engine, subject)) {
    problems.push(
      problem(
        'CUT_OUT_NOT_OFFERED',
        'Only an object on Zetta Splat is cut out of its background: an environment is all background, and a world engine rebuilds the whole place.',
        'removeBackground',
      ),
    )
  }

  const imageUrl = input.imageUrl?.trim() ?? ''
  const videoUrl = input.videoUrl?.trim() ?? ''
  const hasImage = imageUrl !== ''
  const hasVideo = videoUrl !== ''
  const prompt = input.prompt?.trim() ?? ''
  const views = input.worldViews ?? []

  if (hasVideo && !caps.video) {
    problems.push(
      problem('VIDEO_NOT_SUPPORTED', 'A video can only build a Zetta Splat 2 or 2.1 world. Attach a picture instead.', 'videoUrl'),
    )
  } else if (hasVideo && input.subject === 'object') {
    problems.push(
      problem('VIDEO_NEEDS_ENVIRONMENT', 'A video builds a place, not an object. Choose subject environment, or attach a picture.', 'videoUrl'),
    )
  } else if (hasImage === hasVideo) {
    problems.push(
      problem(
        'IMAGE_OR_VIDEO',
        caps.video
          ? 'A world is generated from exactly one picture or one video. Attach one, or make a picture from your prompt first.'
          : 'A Gaussian splat is generated from exactly one picture. Attach one, or make a picture from your prompt first.',
        hasImage ? 'videoUrl' : 'imageUrl',
      ),
    )
  }

  if (input.reconstructImages === true && views.length === 0) {
    problems.push(
      problem('RECONSTRUCT_NEEDS_VIEWS', 'Pictures of the same space need more than one picture. Add worldViews.', 'reconstructImages'),
    )
  }

  const sentViews: Array<{ azimuth?: number; imageUrl: string }> = []
  if (views.length > 0) {
    if (!caps.worldViews) {
      problems.push(
        problem('WORLD_VIEWS_NOT_SUPPORTED', 'More directions can only build a Zetta Splat 2 or 2.1 world.', 'worldViews'),
      )
    } else if (!hasImage || hasVideo) {
      problems.push(
        problem('WORLD_VIEWS_NEED_IMAGE', 'More directions need the main picture, facing forward, beside them, not a video.', 'worldViews'),
      )
    }
    const sameSpace = input.reconstructImages === true
    const most = maxWorldPictures(sameSpace)
    if (views.length + 1 > most) {
      problems.push(
        problem(
          'TOO_MANY_PICTURES',
          sameSpace
            ? `A world takes at most ${most} pictures.`
            : `A world takes at most ${most} pictures, or ${maxWorldPictures(true)} when they are pictures of the same space.`,
          'worldViews',
        ),
      )
    }
    const placed: number[] = []
    views.forEach((view, index) => {
      const field = `worldViews[${index}]`
      const url = checkUrl(problems, `${field}.imageUrl`, view?.imageUrl ?? '', 'Each direction’s picture address')
      const azimuth = view?.azimuth
      if (azimuth === undefined || azimuth === null) {
        sentViews.push({ imageUrl: url })
      } else if (!isWholeNumber(azimuth) || azimuth < 1 || azimuth > 359) {
        problems.push(
          problem('INVALID_AZIMUTH', 'azimuth must be a whole number of degrees from 1 to 359; 0 is the main picture.', `${field}.azimuth`),
        )
      } else {
        placed.push(azimuth)
        sentViews.push({ azimuth, imageUrl: url })
      }
    })
    if (new Set(placed).size !== placed.length) {
      problems.push(problem('SAME_DIRECTION', 'Two pictures face the same direction. Give each one its own angle.', 'worldViews'))
    }
  }

  // The prompt: a scene description on the world engines; on n25 only the sentence a picture came from.
  if (prompt.length > MAX_PROMPT_LENGTH) {
    problems.push(problem('PROMPT_TOO_LONG', `The prompt must be ${formatCount(MAX_PROMPT_LENGTH)} characters or fewer.`, 'prompt'))
  }
  const fromPrompt = input.imageFromPrompt === true && hasImage && prompt !== ''
  if (prompt !== '' && !caps.promptAsDescription) {
    if (!hasImage) {
      problems.push(
        problem('PROMPT_NEEDS_IMAGE', `${label} builds from a picture. Make one from the prompt first, then send it as imageUrl with imageFromPrompt.`, 'prompt'),
      )
    } else if (!fromPrompt) {
      problems.push(
        problem('PROMPT_AND_IMAGE', 'Use either a prompt or an image, not both. Set imageFromPrompt when the image was made from this prompt.', 'prompt'),
      )
    }
  }
  if (input.imageFromPrompt === true && !fromPrompt) {
    warnings.push('imageFromPrompt was ignored: it needs both a prompt and an imageUrl.')
  }

  if (input.seed !== undefined) {
    if (!caps.seed) {
      problems.push(problem('SEED_NOT_SUPPORTED', `${label} does not take a seed.`, 'seed'))
    } else if (!isWholeNumber(input.seed)) {
      problems.push(problem('SEED_NOT_WHOLE', 'seed must be a whole number.', 'seed'))
    }
  }

  const metadata = buildMetadata(input, problems)

  const request: CreateGenerationRequest = { spec: { generation: { base: OPERATIONS.GAUSSIAN_SPLAT, modifiers: [] } } }
  if (hasVideo) request.videoUrl = checkUrl(problems, 'videoUrl', videoUrl, 'The video address')
  else if (hasImage) request.imageUrl = checkUrl(problems, 'imageUrl', imageUrl, 'The picture address')
  if (sentViews.length > 0) request.worldViews = sentViews
  if (sentViews.length > 0 && input.reconstructImages === true) request.reconstructImages = true
  if (prompt !== '') {
    request.prompt = prompt
    if (fromPrompt) request.imageFromPrompt = true
  }
  if (input.seed !== undefined && caps.seed) request.modelSeed = input.seed
  if (metadata.title) request.title = metadata.title
  if (metadata.tags) request.tags = metadata.tags
  if (metadata.availability) request.availability = metadata.availability
  request.model = engine
  request.origin = metadata.origin

  if (problems.length > 0) return { ok: false, problems }
  const quote: QuoteSpec = { generation: { base: OPERATIONS.GAUSSIAN_SPLAT, modifiers: [] }, model: engine }
  return { ok: true, request, quote, warnings }
}

// ------------------------------------------------------------------------------ world exports

export const WORLD_EXPORT_KINDS = ['splat', 'mesh', 'collider'] as const
export type WorldExportKind = (typeof WORLD_EXPORT_KINDS)[number]

const WORLD_EXPORT_CODES: Record<WorldExportKind, string> = {
  splat: OPERATIONS.WORLD_SPLAT_EXPORT,
  mesh: OPERATIONS.WORLD_MESH_EXPORT,
  collider: OPERATIONS.WORLD_COLLIDER_EXPORT,
}

export interface WorldExportInput extends RequestMetadata {
  /** A Zetta Splat 2 or 2.1 world of yours. */
  sourcePostId: number
  /** splat (PLY), mesh (GLB) or collider (a light mesh for physics). */
  kind: WorldExportKind
  /** splat only. Defaults to full_res. */
  splatResolution?: WorldSplatResolution
  /** mesh only: which of the two meshes comes first. Defaults to textured. */
  meshVariant?: WorldMeshVariant
  /** The engine the world was made on. Sent as `model` so the quote prices the right engine. */
  engine?: 'zs2' | 'zs21'
}

export function buildWorldExportRequest(input: WorldExportInput): BuildResult<CreateGenerationRequest> {
  const problems: Problem[] = []
  const warnings: string[] = []

  if (!isWholeNumber(input.sourcePostId) || input.sourcePostId < 1) {
    problems.push(
      problem('SOURCE_REQUIRED', 'A world export needs sourcePostId naming one of your Zetta Splat 2 or 2.1 worlds.', 'sourcePostId'),
    )
  }
  const kindOk = checkEnum(problems, 'kind', input.kind, WORLD_EXPORT_KINDS)
  const kind: WorldExportKind = kindOk ? input.kind : 'splat'

  if (input.engine !== undefined) checkEnum(problems, 'engine', input.engine, ['zs2', 'zs21'] as const)
  else warnings.push('Pass engine (zs2 or zs21) so the quote prices the engine the world was made on.')

  if (input.splatResolution !== undefined && kind !== 'splat') {
    problems.push(problem('OPTION_NOT_APPLICABLE', 'splatResolution applies to a splat export only. Remove it.', 'splatResolution'))
  }
  if (input.meshVariant !== undefined && kind !== 'mesh') {
    problems.push(problem('OPTION_NOT_APPLICABLE', 'meshVariant applies to a mesh export only. Remove it.', 'meshVariant'))
  }

  const request: CreateGenerationRequest = {
    spec: { postProcess: [WORLD_EXPORT_CODES[kind]] },
    sourcePostId: input.sourcePostId,
  }
  if (input.engine !== undefined) request.model = input.engine
  // The Studio always names the resolution and the mesh, defaults included.
  if (kind === 'splat') {
    const resolution = input.splatResolution ?? 'full_res'
    if (checkEnum(problems, 'splatResolution', resolution, WORLD_SPLAT_RESOLUTIONS)) request.splatResolution = resolution
  }
  if (kind === 'mesh') {
    const variant = input.meshVariant ?? 'textured'
    if (checkEnum(problems, 'meshVariant', variant, WORLD_MESH_VARIANTS)) request.meshVariant = variant
  }

  const metadata = buildMetadata(input, problems)
  if (metadata.title) request.title = metadata.title
  if (metadata.tags) request.tags = metadata.tags
  if (metadata.availability) request.availability = metadata.availability
  request.origin = metadata.origin

  if (problems.length > 0) return { ok: false, problems }
  const quote: QuoteSpec = { postProcess: [WORLD_EXPORT_CODES[kind]], ...(input.engine ? { model: input.engine } : {}) }
  return { ok: true, request, quote, warnings }
}
