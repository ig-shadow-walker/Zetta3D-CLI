/**
 * The refine tools: one post-processing step against an existing mesh, as a
 * `POST /api/3d/generations` body with `spec.postProcess` holding exactly one code.
 *
 * The bodies match what the Studio's tool panels send for the same settings; the source checks
 * (format, size, density) are the server's own, run here so a refusal costs nothing.
 */
import {
  CONVERT_FORMATS,
  CONVERT_ORIENTATIONS,
  CONVERT_TEXTURE_FORMATS,
  FBX_PRESETS,
  MAX_PROMPT_LENGTH,
  MESH_FORMATS,
  N25_FACE_LIMITS,
  OPERATIONS,
  R1_FACE_LIMITS,
  RIG_OUT_FORMATS,
  RIG_SPECS,
  RIG_TYPES,
  SHARED_FACE_LIMITS,
  buildMetadata,
  checkEnum,
  checkUrl,
  formatCount,
  isWholeNumber,
  priceOf,
  problem,
  type BuildResult,
  type ConvertFormat,
  type ConvertOrientation,
  type ConvertTextureFormat,
  type CreateGenerationRequest,
  type FaceRange,
  type FbxPreset,
  type MeshFormat,
  type PriceListLike,
  type Problem,
  type QuoteSpec,
  type RequestMetadata,
  type RigOutFormat,
  type RigSpec,
  type RigType,
} from './common'

export const REFINE_TOOL_IDS = ['retopo', 'segment', 'uv', 'texture', 'rig', 'convert'] as const
export type RefineToolId = (typeof REFINE_TOOL_IDS)[number]

/** One option of a tool, described for help text and schema generation. */
export interface RefineOptionInfo {
  /** The key on `RefineInput`. */
  name: string
  type: 'enum' | 'boolean' | 'integer' | 'number' | 'string' | 'string[]'
  values?: readonly string[]
  default?: string | number | boolean
  min?: number
  max?: number
  required?: boolean
  description: string
  /** Set when the option applies only to some settings of the tool. */
  only?: string
}

export interface RefineToolInfo {
  id: RefineToolId
  label: string
  description: string
  /** The operation codes this tool can bill. */
  codes: readonly string[]
  /** Source formats it reads, by engine or mode (`any` when there is one answer). */
  accepts: Readonly<Record<string, readonly MeshFormat[]>>
  /** The largest source in bytes, by engine or mode; `null` is no ceiling. */
  maxSourceBytes: Readonly<Record<string, number | null>>
  /** The densest source, in triangles (a quad counts as two). */
  maxSourceTriangles?: number
  options: readonly RefineOptionInfo[]
}

const MB = 1024 * 1024
const ALL_FORMATS: readonly MeshFormat[] = ['GLB', 'OBJ', 'FBX']

/** Smart UV refuses a source over this many equivalent triangles. */
export const SMART_UV_MAX_TRIANGLES = 80_000
/** Where an R1 retopology's polygon budget starts: under both ceilings. */
export const DEFAULT_RETOPO_FACES = 8_000

export const RETOPO_ENGINES = ['r1', 'n1'] as const
export type RetopoEngine = (typeof RETOPO_ENGINES)[number]
export const FACE_LEVELS = ['low', 'medium', 'high'] as const
export type FaceLevel = (typeof FACE_LEVELS)[number]
export const SEGMENT_MODES = ['ai', 'smart'] as const
export type SegmentMode = (typeof SEGMENT_MODES)[number]
export const SEGMENT_GRANULARITIES = ['simple', 'balanced', 'detailed'] as const
export type SegmentGranularity = (typeof SEGMENT_GRANULARITIES)[number]
export const UV_ORIENTATIONS = ['as-is', '+x', '-x', '+y', '-y'] as const
export type UvOrientation = (typeof UV_ORIENTATIONS)[number]
export const TEXTURE_TIERS = ['standard', 'hd', '8k'] as const
export type TextureTier = (typeof TEXTURE_TIERS)[number]
const TEXTURE_TIER_CODES: Record<TextureTier, string> = {
  standard: OPERATIONS.RETEXTURE,
  hd: OPERATIONS.RETEXTURE_HD,
  '8k': OPERATIONS.RETEXTURE_8K,
}
const REFINE_POLYGON_TYPES = ['triangle', 'quad'] as const

export const REFINE_TOOLS: Readonly<Record<RefineToolId, RefineToolInfo>> = {
  retopo: {
    id: 'retopo',
    label: 'Retopology',
    description: 'Rebuilds the mesh with cleaner, more even geometry.',
    codes: [OPERATIONS.SMART_TOPOLOGY],
    accepts: { r1: ALL_FORMATS, n1: ['GLB', 'OBJ'] },
    maxSourceBytes: { r1: 150 * MB, n1: null },
    options: [
      {
        name: 'engine',
        type: 'enum',
        values: RETOPO_ENGINES,
        default: 'r1',
        description: 'r1: up to 20,000 polygons and less than half the price. n1: no polygon ceiling, for a dense mesh.',
      },
      {
        name: 'faces',
        type: 'integer',
        min: R1_FACE_LIMITS.triangle.min,
        max: R1_FACE_LIMITS.triangle.max,
        default: DEFAULT_RETOPO_FACES,
        description: 'The exact polygon budget (10,000 at most with quads).',
        only: 'engine r1',
      },
      {
        name: 'faceLevel',
        type: 'enum',
        values: FACE_LEVELS,
        default: 'medium',
        description: 'How much geometry to keep: low is game-ready, high keeps the most detail. On r1, use instead of faces.',
      },
      { name: 'polygonType', type: 'enum', values: REFINE_POLYGON_TYPES, default: 'triangle', description: 'How the rebuilt surface is divided.' },
      { name: 'bake', type: 'boolean', default: true, description: 'Carry the textures onto the rebuilt mesh. false returns bare geometry.', only: 'engine r1' },
      { name: 'partNames', type: 'string[]', description: 'Rebuild only these parts of a segmented mesh.', only: 'engine r1' },
    ],
  },
  segment: {
    id: 'segment',
    label: 'Segmentation',
    description: 'Splits the model into separately named parts.',
    codes: [OPERATIONS.AI_SEGMENTATION, OPERATIONS.SMART_SEGMENTATION],
    accepts: { ai: ALL_FORMATS, smart: ['GLB'] },
    maxSourceBytes: { ai: 150 * MB, smart: 150 * MB },
    options: [
      {
        name: 'mode',
        type: 'enum',
        values: SEGMENT_MODES,
        default: 'ai',
        description: 'ai splits the mesh you have. smart rebuilds as it splits, for cleaner parts on a rough mesh, and costs more.',
      },
      {
        name: 'granularity',
        type: 'enum',
        values: SEGMENT_GRANULARITIES,
        default: 'balanced',
        description: 'How finely to divide: simple is a few broad parts, detailed is the most parts.',
      },
      { name: 'splitByConnectivity', type: 'boolean', default: true, description: 'Split disconnected pieces apart.', only: 'mode ai' },
      { name: 'prompt', type: 'string', description: 'What the object is, so the parts can be named.', only: 'mode smart' },
    ],
  },
  uv: {
    id: 'uv',
    label: 'Smart UV',
    description: 'Lays the UVs out again as a clean new layout, carrying textures, rig and animation across.',
    codes: [OPERATIONS.SMART_UV],
    accepts: { any: ALL_FORMATS },
    maxSourceBytes: { any: 150 * MB },
    maxSourceTriangles: SMART_UV_MAX_TRIANGLES,
    options: [
      { name: 'bake', type: 'boolean', default: true, description: 'Re-bake the textures onto the new layout. false returns bare UVs.' },
      { name: 'exportOrientation', type: 'enum', values: UV_ORIENTATIONS, default: 'as-is', description: 'Which way the model faces in the file.' },
      { name: 'compressGeometry', type: 'boolean', default: false, description: 'Compress the mesh for a smaller file.' },
    ],
  },
  texture: {
    id: 'texture',
    label: 'AI Texturing',
    description: 'Repaints the surface from a reference picture, keeping the shape.',
    codes: [OPERATIONS.RETEXTURE, OPERATIONS.RETEXTURE_HD, OPERATIONS.RETEXTURE_8K],
    accepts: { any: ALL_FORMATS },
    maxSourceBytes: { any: 150 * MB },
    options: [
      { name: 'tier', type: 'enum', values: TEXTURE_TIERS, default: 'standard', description: 'Texture resolution: standard is 2K, hd 4K, 8k 8K. Each tier has its own price.' },
      { name: 'imageUrl', type: 'string', required: true, description: 'The reference picture to paint from.' },
      {
        name: 'textureAlignment',
        type: 'enum',
        values: ['original_image', 'geometry'],
        default: 'original_image',
        description: 'When picture and mesh disagree: stay true to the picture, or fit the mesh.',
      },
      { name: 'enablePBR', type: 'boolean', default: true, description: 'PBR materials. Free on a retexture.' },
      { name: 'bake', type: 'boolean', default: true, description: 'Bake material effects into the base textures.' },
      { name: 'textureFast', type: 'boolean', default: false, description: 'The faster setting of the standard tier.', only: 'tier standard' },
      { name: 'delight', type: 'boolean', default: true, description: 'Strip the lighting baked into the reference.' },
      { name: 'partNames', type: 'string[]', description: 'Repaint only these parts of a segmented mesh. All of them when omitted.' },
      { name: 'textureSeed', type: 'integer', description: 'Same mesh, a different texture.' },
    ],
  },
  rig: {
    id: 'rig',
    label: 'Auto Rig',
    description: 'Fits a skeleton automatically. Comes back rigged and posable.',
    codes: [OPERATIONS.AUTO_RIGGING],
    accepts: { any: ALL_FORMATS },
    maxSourceBytes: { any: 150 * MB },
    options: [
      { name: 'rigType', type: 'enum', values: RIG_TYPES, default: 'biped', description: 'The body: biped (humanoid), quadruped, hexapod, octopod, avian, serpentine or aquatic.' },
      { name: 'rigSpec', type: 'enum', values: RIG_SPECS, default: 'standard', description: 'Bone naming: standard, or mixamo for libraries that follow it.' },
      { name: 'rigOutFormat', type: 'enum', values: RIG_OUT_FORMATS, default: 'glb', description: 'What the rigged mesh comes back as.' },
    ],
  },
  convert: {
    id: 'convert',
    label: 'Format conversion',
    description: 'Exports the model in another format. Any non-default geometry or texture setting bills the advanced tier.',
    codes: [OPERATIONS.CONVERT_FORMAT, OPERATIONS.CONVERT_FORMAT_ADVANCED],
    accepts: { any: ALL_FORMATS },
    maxSourceBytes: { any: 150 * MB },
    options: [
      { name: 'outputFormat', type: 'enum', values: CONVERT_FORMATS, required: true, description: 'The format to write.' },
      { name: 'quad', type: 'boolean', default: false, description: 'Write quads instead of triangles (FBX only). Advanced tier.' },
      { name: 'forceSymmetry', type: 'boolean', default: false, description: 'Mirror the mesh about its axis.', only: 'quad' },
      {
        name: 'faceLimit',
        type: 'integer',
        min: SHARED_FACE_LIMITS.min,
        max: SHARED_FACE_LIMITS.max,
        description: 'A polygon limit (1,000–150,000 with quads). Advanced tier.',
      },
      { name: 'flattenBottom', type: 'boolean', default: false, description: 'Cut a flat base so the model stands level. Advanced tier.' },
      { name: 'flattenBottomThreshold', type: 'number', min: 0, max: 1, default: 0.01, description: 'How deep the flattening cuts, as a fraction of the model.', only: 'flattenBottom' },
      { name: 'textureSize', type: 'integer', min: 128, max: 4096, default: 4096, description: 'Texture size in pixels. Advanced tier when not 4096.' },
      { name: 'textureFormat', type: 'enum', values: CONVERT_TEXTURE_FORMATS, default: 'JPEG', description: 'Texture image format. Advanced tier when not JPEG.' },
      { name: 'packUv', type: 'boolean', default: false, description: 'Repack every UV island into one layout.' },
      { name: 'exportVertexColors', type: 'boolean', default: false, description: 'Keep vertex colours.', only: 'outputFormat OBJ or GLTF' },
      { name: 'pivotToCenterBottom', type: 'boolean', default: false, description: 'Move the pivot to the bottom centre. Advanced tier.' },
      { name: 'scaleFactor', type: 'number', min: 0.001, max: 1000, default: 1, description: 'Uniform scale on export. Advanced tier when not 1.' },
      { name: 'withAnimation', type: 'boolean', default: true, description: 'Keep skeleton and animation data.' },
      { name: 'animateInPlace', type: 'boolean', default: false, description: 'Play the animation without root movement.', only: 'withAnimation' },
      { name: 'exportOrientation', type: 'enum', values: CONVERT_ORIENTATIONS, default: '+x', description: 'Which way the exported mesh faces.' },
      { name: 'fbxPreset', type: 'enum', values: FBX_PRESETS, default: 'blender', description: 'Which application’s FBX conventions to write.', only: 'outputFormat FBX' },
    ],
  },
}

// ------------------------------------------------------------------------------------- inputs

export interface RefineSourceInput extends RequestMetadata {
  /** One of your own assets. Exactly one of this and `sourceFileUrl`. */
  sourcePostId?: number
  /** A mesh by address; its format is read from the `.glb`, `.obj` or `.fbx` extension. */
  sourceFileUrl?: string
  /** The formats the source holds, when known, to check them before sending. */
  sourceFormat?: MeshFormat | readonly MeshFormat[]
  /** The source's size, when known. */
  sourceBytes?: number
  /** The source's triangle count (a quad counts as two), when known. */
  sourceTriangles?: number
}

export interface RetopoOptions {
  engine?: RetopoEngine
  faces?: number
  faceLevel?: FaceLevel
  polygonType?: 'triangle' | 'quad'
  bake?: boolean
  partNames?: string[]
}
export interface SegmentOptions {
  mode?: SegmentMode
  granularity?: SegmentGranularity
  splitByConnectivity?: boolean
  prompt?: string
}
export interface UvOptions {
  bake?: boolean
  exportOrientation?: UvOrientation
  compressGeometry?: boolean
}
export interface TextureOptions {
  tier?: TextureTier
  imageUrl?: string
  /** Not accepted by the server yet; see `buildRefineRequest`. */
  views?: Partial<Record<'front' | 'back' | 'left' | 'right', string>>
  textureAlignment?: 'original_image' | 'geometry'
  enablePBR?: boolean
  bake?: boolean
  textureFast?: boolean
  delight?: boolean
  partNames?: string[]
  textureSeed?: number
}
export interface RigOptions {
  rigType?: RigType
  rigSpec?: RigSpec
  rigOutFormat?: RigOutFormat
}
export interface ConvertOptions {
  outputFormat?: ConvertFormat
  quad?: boolean
  forceSymmetry?: boolean
  faceLimit?: number
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
}

export interface RefineOptionsByTool {
  retopo: RetopoOptions
  segment: SegmentOptions
  uv: UvOptions
  texture: TextureOptions
  rig: RigOptions
  convert: ConvertOptions
}

export type RefineInput<T extends RefineToolId = RefineToolId> = RefineSourceInput & RefineOptionsByTool[T]

const SOURCE_KEYS = ['sourcePostId', 'sourceFileUrl', 'sourceFormat', 'sourceBytes', 'sourceTriangles']
const METADATA_KEYS = ['title', 'tags', 'availability', 'origin']

// --------------------------------------------------------------------------------- the rules

/** Which billed code a tool's settings resolve to. */
export function refineOperation(tool: RefineToolId, options: Record<string, unknown> = {}): string {
  switch (tool) {
    case 'retopo':
      return OPERATIONS.SMART_TOPOLOGY
    case 'segment':
      return options.mode === 'smart' ? OPERATIONS.SMART_SEGMENTATION : OPERATIONS.AI_SEGMENTATION
    case 'uv':
      return OPERATIONS.SMART_UV
    case 'texture':
      return TEXTURE_TIER_CODES[(options.tier as TextureTier) ?? 'standard'] ?? OPERATIONS.RETEXTURE
    case 'rig':
      return OPERATIONS.AUTO_RIGGING
    case 'convert':
      return convertTier(options as ConvertOptions)
  }
}

/**
 * The convert tier the server charges: the advanced one as soon as any geometry or texture
 * setting leaves its default. The server recomputes this and is the authority.
 */
export function convertTier(options: ConvertOptions): string {
  const advanced =
    options.quad === true ||
    options.faceLimit !== undefined ||
    options.flattenBottom === true ||
    (options.textureSize !== undefined && options.textureSize !== 4096) ||
    (options.textureFormat !== undefined && options.textureFormat !== 'JPEG') ||
    options.pivotToCenterBottom === true ||
    (options.scaleFactor !== undefined && options.scaleFactor !== 1)
  return advanced ? OPERATIONS.CONVERT_FORMAT_ADVANCED : OPERATIONS.CONVERT_FORMAT
}

/** The engine or mode a tool's formats and size limit depend on. */
function variantOf(tool: RefineToolId, options: Record<string, unknown>): string {
  if (tool === 'retopo') return options.engine === 'n1' ? 'n1' : 'r1'
  if (tool === 'segment') return options.mode === 'smart' ? 'smart' : 'ai'
  return 'any'
}

/** The source formats a tool reads with these settings. */
export function acceptedFormats(tool: RefineToolId, options: Record<string, unknown> = {}): readonly MeshFormat[] {
  const info = REFINE_TOOLS[tool]
  return info.accepts[variantOf(tool, options)] ?? info.accepts.any ?? ALL_FORMATS
}

function asFormats(value: MeshFormat | readonly MeshFormat[] | undefined): MeshFormat[] {
  if (value === undefined) return []
  const list = typeof value === 'string' ? [value] : [...value]
  return list.map((format) => String(format).toUpperCase() as MeshFormat)
}

/**
 * Whether a source in these formats has to be converted before this tool can read it. The server
 * refuses such a source rather than converting it, so a conversion is its own `convert` job first.
 */
export function needsConversion(
  tool: RefineToolId,
  sourceFormats: MeshFormat | readonly MeshFormat[],
  options: Record<string, unknown> = {},
): boolean {
  const have = asFormats(sourceFormats)
  if (have.length === 0) return false
  const accepted = acceptedFormats(tool, options)
  return !have.some((format) => accepted.includes(format))
}

/**
 * What the tool costs against this source, with the conversion job's price added when one is
 * needed first. `null` while a price is unknown.
 */
export function costOf(
  tool: RefineToolId,
  prices: PriceListLike | undefined,
  options: Record<string, unknown> = {},
  sourceFormats: MeshFormat | readonly MeshFormat[] = [],
): number | null {
  const code = refineOperation(tool, options)
  // Retopology is priced per engine.
  const model = tool === 'retopo' ? variantOf(tool, options) : undefined
  const base = priceOf(prices, code, model)
  if (base === null) return null
  if (!needsConversion(tool, sourceFormats, options)) return base
  // A missing conversion price makes the total unknown rather than equal to the base.
  const convert = priceOf(prices, OPERATIONS.CONVERT_FORMAT)
  return convert === null ? null : base + convert
}

/** The format a URL's extension names, or `null`. Signed URLs carry a query string. */
export function meshFormatFromUrl(url: string): MeshFormat | null {
  const path = url.split(/[?#]/)[0] ?? ''
  const extension = path.split('.').pop()?.toLowerCase() ?? ''
  const found = MESH_FORMATS.find((format) => format.toLowerCase() === extension)
  return found ?? null
}

const OPERATION_LABELS: Record<string, string> = {
  retopo: 'Retopology',
  ai: 'AI Segmentation',
  smart: 'Smart Segmentation',
  uv: 'Smart UV',
  texture: 'AI Texturing',
  rig: 'Auto Rigging',
  convert: 'Format conversion',
}

function labelFor(tool: RefineToolId, options: Record<string, unknown>): string {
  if (tool === 'segment') return OPERATION_LABELS[variantOf(tool, options)] ?? 'Segmentation'
  if (tool === 'retopo') return `Retopology on Zetta ${variantOf(tool, options) === 'n1' ? 'N1' : 'R1'}`
  return OPERATION_LABELS[tool] ?? REFINE_TOOLS[tool].label
}

/** "a GLB", "an FBX", "an OBJ": the article follows the letter's sound. */
function withArticle(format: string): string {
  return `${'AEFHILMNORSX'.includes(format[0] ?? '') ? 'an' : 'a'} ${format}`
}

function formatList(formats: readonly MeshFormat[]): string {
  const list = formats.length === 1 ? `${formats[0]}` : `${formats.slice(0, -1).join(', ')} or ${formats[formats.length - 1]}`
  return withArticle(list)
}

function checkSource(
  tool: RefineToolId,
  input: RefineSourceInput,
  options: Record<string, unknown>,
  problems: Problem[],
): Pick<CreateGenerationRequest, 'sourcePostId' | 'sourceFileUrl'> {
  const out: Pick<CreateGenerationRequest, 'sourcePostId' | 'sourceFileUrl'> = {}
  const url = input.sourceFileUrl?.trim() ?? ''
  const hasPost = input.sourcePostId !== undefined

  if (hasPost && url !== '') {
    problems.push(problem('SOURCE_CONFLICT', 'Use either sourcePostId or sourceFileUrl, not both.', 'sourceFileUrl'))
  } else if (!hasPost && url === '') {
    problems.push(
      problem('SOURCE_REQUIRED', 'Name the mesh to work on: sourcePostId for one of your assets, or sourceFileUrl.', 'sourcePostId'),
    )
  }

  const formats = asFormats(input.sourceFormat)
  if (hasPost) {
    if (!isWholeNumber(input.sourcePostId) || (input.sourcePostId as number) < 1) {
      problems.push(problem('INVALID_SOURCE', 'sourcePostId must be a positive whole number.', 'sourcePostId'))
    } else {
      out.sourcePostId = input.sourcePostId
    }
  }
  if (url !== '') {
    out.sourceFileUrl = checkUrl(problems, 'sourceFileUrl', url, 'The mesh address')
    const fromUrl = meshFormatFromUrl(url)
    if (fromUrl === null) {
      problems.push(
        problem('SOURCE_FORMAT_UNKNOWN', 'The mesh address must end in .glb, .obj or .fbx so its format can be read.', 'sourceFileUrl'),
      )
    } else {
      formats.splice(0, formats.length, fromUrl)
    }
  }

  const label = labelFor(tool, options)
  const accepted = acceptedFormats(tool, options)
  const held = formats.filter((format) => (MESH_FORMATS as readonly string[]).includes(format))
  if (held.length > 0 && !held.some((format) => accepted.includes(format))) {
    const convertible = accepted.filter((format) => (CONVERT_FORMATS as readonly string[]).includes(format))
    problems.push(
      problem(
        'SOURCE_FORMAT_NOT_ACCEPTED',
        `${label} needs ${formatList(accepted)} mesh, and this one is ${held.join(' or ')}. ` +
          (convertible.length > 0
            ? `Convert it to ${convertible.join(' or ')} with refine convert first.`
            : `Use a ${accepted.join(' or ')} source instead.`),
        url !== '' ? 'sourceFileUrl' : 'sourceFormat',
      ),
    )
  }

  const maxBytes = REFINE_TOOLS[tool].maxSourceBytes[variantOf(tool, options)] ?? null
  if (typeof input.sourceBytes === 'number' && maxBytes !== null && input.sourceBytes > maxBytes) {
    problems.push(
      problem(
        'SOURCE_TOO_LARGE',
        `${label} needs a mesh under ${Math.round(maxBytes / MB)}MB, and this one is ${Math.round(input.sourceBytes / MB)}MB. Retopologise it to reduce the geometry first.`,
        'sourceBytes',
      ),
    )
  }
  const maxTriangles = REFINE_TOOLS[tool].maxSourceTriangles
  if (typeof input.sourceTriangles === 'number' && maxTriangles !== undefined && input.sourceTriangles > maxTriangles) {
    problems.push(
      problem(
        'SOURCE_TOO_DENSE',
        `${label} needs a mesh under ${formatCount(maxTriangles)} triangles (a quad counts as two), and this one has ${formatCount(input.sourceTriangles)}. Run refine retopo on it first.`,
        'sourceTriangles',
      ),
    )
  }
  return out
}

function checkInteger(problems: Problem[], field: string, value: unknown, range?: FaceRange): value is number {
  if (!isWholeNumber(value)) {
    problems.push(problem('NOT_WHOLE_NUMBER', `${field} must be a whole number.`, field))
    return false
  }
  if (range && (value < range.min || value > range.max)) {
    problems.push(
      problem('OUT_OF_RANGE', `${field} must be between ${formatCount(range.min)} and ${formatCount(range.max)}.`, field),
    )
    return false
  }
  return true
}

function checkNumber(problems: Problem[], field: string, value: unknown, min: number, max: number): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    problems.push(problem('OUT_OF_RANGE', `${field} must be a number between ${min} and ${max}.`, field))
    return false
  }
  return true
}

function checkNames(problems: Problem[], field: string, value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((name) => typeof name !== 'string')) {
    problems.push(problem('INVALID_OPTION', `${field} must be a list of part names.`, field))
    return undefined
  }
  const names = value.map((name: string) => name.trim()).filter((name) => name !== '')
  return names.length > 0 ? names : undefined
}

function onlyFor(problems: Problem[], field: string, value: unknown, where: string): void {
  if (value !== undefined) {
    problems.push(problem('OPTION_NOT_APPLICABLE', `${field} applies to ${where} only. Remove it.`, field))
  }
}

type Fields = Partial<CreateGenerationRequest>

interface ToolBuild {
  code: string
  fields: Fields
  model?: string
}

function buildRetopo(opts: RetopoOptions, problems: Problem[]): ToolBuild {
  const fields: Fields = {}
  const engine: RetopoEngine = opts.engine ?? 'r1'
  if (opts.engine !== undefined) checkEnum(problems, 'engine', opts.engine, RETOPO_ENGINES)
  const polygonType = opts.polygonType ?? 'triangle'
  if (opts.polygonType !== undefined) checkEnum(problems, 'polygonType', opts.polygonType, REFINE_POLYGON_TYPES)
  const quad = polygonType === 'quad'

  fields.model = engine
  if (engine === 'n1') {
    // N1 takes a level and nothing else; a count, bake or part list would be refused or dropped.
    onlyFor(problems, 'faces', opts.faces, 'engine r1')
    onlyFor(problems, 'bake', opts.bake, 'engine r1')
    onlyFor(problems, 'partNames', opts.partNames, 'engine r1')
    const level = opts.faceLevel ?? 'medium'
    if (checkEnum(problems, 'faceLevel', level, FACE_LEVELS)) fields.faceLevel = level
  } else if (opts.faceLevel !== undefined && opts.faces !== undefined) {
    problems.push(problem('FACES_AND_LEVEL', 'Give faces or faceLevel, not both.', 'faceLevel'))
  } else if (opts.faceLevel !== undefined) {
    // R1 resolves a level to a count itself.
    if (checkEnum(problems, 'faceLevel', opts.faceLevel, FACE_LEVELS)) fields.faceLevel = opts.faceLevel
  } else {
    const faces = opts.faces ?? DEFAULT_RETOPO_FACES
    if (checkInteger(problems, 'faces', faces, quad ? R1_FACE_LIMITS.quad : R1_FACE_LIMITS.triangle)) {
      fields.faceCount = faces
    }
  }
  fields.polygonType = quad ? 'quadrilateral' : 'triangle'
  if (engine === 'r1') {
    // Baking is on unless turned off, so only `false` travels.
    if (opts.bake === false) fields.bake = false
    if (opts.partNames !== undefined) {
      const names = checkNames(problems, 'partNames', opts.partNames)
      if (names) fields.partNames = names
    }
  }
  return { code: OPERATIONS.SMART_TOPOLOGY, fields, model: engine }
}

function buildSegment(opts: SegmentOptions, problems: Problem[]): ToolBuild {
  const fields: Fields = {}
  const mode: SegmentMode = opts.mode ?? 'ai'
  if (opts.mode !== undefined) checkEnum(problems, 'mode', opts.mode, SEGMENT_MODES)
  const prompt = opts.prompt?.trim() ?? ''
  if (mode === 'smart') {
    onlyFor(problems, 'splitByConnectivity', opts.splitByConnectivity, 'mode ai')
    if (prompt.length > MAX_PROMPT_LENGTH) {
      problems.push(problem('PROMPT_TOO_LONG', `The prompt must be ${formatCount(MAX_PROMPT_LENGTH)} characters or fewer.`, 'prompt'))
    } else if (prompt !== '') {
      fields.prompt = prompt
    }
  } else if (prompt !== '') {
    problems.push(problem('OPTION_NOT_APPLICABLE', 'prompt applies to mode smart only. Remove it.', 'prompt'))
  }
  const granularity = opts.granularity ?? 'balanced'
  if (checkEnum(problems, 'granularity', granularity, SEGMENT_GRANULARITIES)) fields.segmentGranularity = granularity
  // On by default, so only `false` travels.
  if (mode === 'ai' && opts.splitByConnectivity === false) fields.splitByConnectivity = false
  return { code: mode === 'smart' ? OPERATIONS.SMART_SEGMENTATION : OPERATIONS.AI_SEGMENTATION, fields }
}

function buildUv(opts: UvOptions, problems: Problem[]): ToolBuild {
  const fields: Fields = {}
  if (opts.bake === false) fields.bake = false
  const orientation = opts.exportOrientation ?? 'as-is'
  if (checkEnum(problems, 'exportOrientation', orientation, UV_ORIENTATIONS) && orientation !== 'as-is') {
    fields.exportOrientation = orientation
  }
  if (opts.compressGeometry === true) fields.compressGeometry = true
  return { code: OPERATIONS.SMART_UV, fields }
}

function buildTexture(opts: TextureOptions, problems: Problem[], warnings: string[]): ToolBuild {
  const fields: Fields = {}
  const tier: TextureTier = opts.tier ?? 'standard'
  if (opts.tier !== undefined) checkEnum(problems, 'tier', opts.tier, TEXTURE_TIERS)
  const imageUrl = opts.imageUrl?.trim() ?? ''
  const hasViews = Object.values(opts.views ?? {}).some((url) => typeof url === 'string' && url.trim() !== '')

  if (hasViews) {
    // The Studio sends views here, but the server refuses views without a paid `multi_view`
    // modifier, which a refine job cannot carry. The server wins.
    problems.push(
      problem('TEXTURE_VIEWS_NOT_ACCEPTED', 'The server does not take reference views on a retexture yet. Send one imageUrl instead.', 'views'),
    )
  }
  if (imageUrl === '') {
    if (!hasViews) {
      problems.push(problem('REFERENCE_REQUIRED', 'AI Texturing paints from a reference picture. Give imageUrl.', 'imageUrl'))
    }
  } else {
    fields.imageUrl = checkUrl(problems, 'imageUrl', imageUrl, 'The reference picture address')
  }

  const alignment = opts.textureAlignment ?? 'original_image'
  if (checkEnum(problems, 'textureAlignment', alignment, ['original_image', 'geometry'] as const)) {
    fields.textureAlignment = alignment
  }
  if (opts.textureSeed !== undefined && checkInteger(problems, 'textureSeed', opts.textureSeed)) {
    fields.textureSeed = opts.textureSeed
  }
  if (opts.bake === false) fields.bake = false
  if (opts.partNames !== undefined) {
    const names = checkNames(problems, 'partNames', opts.partNames)
    if (names) fields.partNames = names
  }
  fields.enablePBR = opts.enablePBR ?? true
  if (opts.textureFast === true) {
    if (tier === 'standard') fields.textureFast = true
    else warnings.push('textureFast only speeds up the standard tier, so it is not sent with hd or 8k.')
  }
  fields.delight = opts.delight ?? true
  return { code: TEXTURE_TIER_CODES[tier] ?? OPERATIONS.RETEXTURE, fields }
}

function buildRig(opts: RigOptions, problems: Problem[]): ToolBuild {
  const fields: Fields = {}
  // Each has a default at the server, so only a different choice travels.
  if (opts.rigType !== undefined && checkEnum(problems, 'rigType', opts.rigType, RIG_TYPES) && opts.rigType !== 'biped') {
    fields.rigType = opts.rigType
  }
  if (opts.rigSpec !== undefined && checkEnum(problems, 'rigSpec', opts.rigSpec, RIG_SPECS) && opts.rigSpec !== 'standard') {
    fields.rigSpec = opts.rigSpec
  }
  if (
    opts.rigOutFormat !== undefined &&
    checkEnum(problems, 'rigOutFormat', opts.rigOutFormat, RIG_OUT_FORMATS) &&
    opts.rigOutFormat !== 'glb'
  ) {
    fields.rigOutFormat = opts.rigOutFormat
  }
  return { code: OPERATIONS.AUTO_RIGGING, fields }
}

function buildConvert(opts: ConvertOptions, problems: Problem[]): ToolBuild {
  const fields: Fields = {}
  let model: string | undefined
  const format = opts.outputFormat
  if (format === undefined) {
    problems.push(problem('OUTPUT_FORMAT_REQUIRED', `Choose an outputFormat: ${CONVERT_FORMATS.join(', ')}.`, 'outputFormat'))
  } else if (checkEnum(problems, 'outputFormat', format, CONVERT_FORMATS)) {
    fields.outputFormat = format
  }
  const quad = opts.quad === true

  // The exporter's own rules, refused before the charge.
  if (quad && format !== undefined && format !== 'FBX') {
    problems.push(problem('QUAD_NEEDS_FBX', 'Quad output is written as FBX. Choose outputFormat FBX, or export triangles.', 'quad'))
  }
  if (opts.forceSymmetry === true && !quad) {
    problems.push(problem('SYMMETRY_NEEDS_QUAD', 'forceSymmetry applies to quad output only.', 'forceSymmetry'))
  }
  if (opts.exportVertexColors === true && format !== 'OBJ' && format !== 'GLTF') {
    problems.push(problem('VERTEX_COLORS_NEED_OBJ_OR_GLTF', 'Vertex colours can only be written to OBJ or GLTF.', 'exportVertexColors'))
  }
  if (opts.fbxPreset !== undefined && format !== 'FBX') {
    problems.push(problem('FBX_PRESET_NEEDS_FBX', 'fbxPreset applies to FBX output only.', 'fbxPreset'))
  }
  if (opts.flattenBottomThreshold !== undefined && opts.flattenBottom !== true) {
    problems.push(problem('OPTION_NOT_APPLICABLE', 'flattenBottomThreshold needs flattenBottom.', 'flattenBottomThreshold'))
  }
  if (opts.animateInPlace === true && opts.withAnimation === false) {
    problems.push(problem('OPTION_NOT_APPLICABLE', 'animateInPlace needs withAnimation.', 'animateInPlace'))
  }

  if (quad) {
    fields.polygonType = 'quadrilateral'
    // The server only accepts polygonType on a refine job whose model takes quads at any base;
    // conversion runs on that engine anyway, so naming it changes nothing else.
    model = 'n25'
  }
  if (opts.faceLimit !== undefined) {
    const range = quad ? N25_FACE_LIMITS.high.quad : SHARED_FACE_LIMITS
    if (checkInteger(problems, 'faceLimit', opts.faceLimit, range)) fields.faceCount = opts.faceLimit
  }
  if (opts.forceSymmetry !== undefined) fields.forceSymmetry = opts.forceSymmetry
  if (opts.flattenBottom !== undefined) fields.flattenBottom = opts.flattenBottom
  if (opts.flattenBottomThreshold !== undefined && checkNumber(problems, 'flattenBottomThreshold', opts.flattenBottomThreshold, 0, 1)) {
    fields.flattenBottomThreshold = opts.flattenBottomThreshold
  }
  if (opts.textureSize !== undefined && checkInteger(problems, 'textureSize', opts.textureSize, { min: 128, max: 4096 })) {
    fields.textureSize = opts.textureSize
  }
  if (opts.textureFormat !== undefined && checkEnum(problems, 'textureFormat', opts.textureFormat, CONVERT_TEXTURE_FORMATS)) {
    fields.textureFormat = opts.textureFormat
  }
  if (opts.packUv !== undefined) fields.packUv = opts.packUv
  if (opts.exportVertexColors !== undefined) fields.exportVertexColors = opts.exportVertexColors
  if (opts.pivotToCenterBottom !== undefined) fields.pivotToCenterBottom = opts.pivotToCenterBottom
  if (opts.scaleFactor !== undefined && checkNumber(problems, 'scaleFactor', opts.scaleFactor, 0.001, 1000)) {
    fields.scaleFactor = opts.scaleFactor
  }
  // Sent by definedness: `withAnimation: false` is the point of that option.
  if (opts.withAnimation !== undefined) fields.withAnimation = opts.withAnimation
  if (opts.animateInPlace !== undefined) fields.animateInPlace = opts.animateInPlace
  if (opts.exportOrientation !== undefined && checkEnum(problems, 'exportOrientation', opts.exportOrientation, CONVERT_ORIENTATIONS)) {
    fields.exportOrientation = opts.exportOrientation
  }
  if (opts.fbxPreset !== undefined && checkEnum(problems, 'fbxPreset', opts.fbxPreset, FBX_PRESETS)) {
    fields.fbxPreset = opts.fbxPreset
  }
  return { code: convertTier(opts), fields, ...(model ? { model } : {}) }
}

/** The wire order the Studio uses, so bodies read the same in logs. */
const FIELD_ORDER: ReadonlyArray<keyof CreateGenerationRequest> = [
  'imageUrl',
  'prompt',
  'model',
  'faceLevel',
  'faceCount',
  'segmentGranularity',
  'splitByConnectivity',
  'polygonType',
  'rigType',
  'rigSpec',
  'rigOutFormat',
  'outputFormat',
  'forceSymmetry',
  'flattenBottom',
  'flattenBottomThreshold',
  'textureSize',
  'textureFormat',
  'packUv',
  'exportVertexColors',
  'pivotToCenterBottom',
  'scaleFactor',
  'withAnimation',
  'animateInPlace',
  'exportOrientation',
  'fbxPreset',
  'compressGeometry',
  'textureAlignment',
  'textureSeed',
  'bake',
  'partNames',
  'enablePBR',
  'textureFast',
  'delight',
]

/** Builds one refine job against `sourcePostId` or `sourceFileUrl`. */
export function buildRefineRequest<T extends RefineToolId>(
  tool: T,
  input: RefineInput<T>,
): BuildResult<CreateGenerationRequest> {
  if (!(REFINE_TOOL_IDS as readonly string[]).includes(tool)) {
    return {
      ok: false,
      problems: [problem('UNKNOWN_TOOL', `tool must be one of: ${REFINE_TOOL_IDS.join(', ')}.`, 'tool')],
    }
  }
  const problems: Problem[] = []
  const warnings: string[] = []
  const options = input as unknown as Record<string, unknown>

  // An option from another tool would be refused or ignored by the server; say so here.
  const known = new Set<string>([
    ...SOURCE_KEYS,
    ...METADATA_KEYS,
    ...REFINE_TOOLS[tool].options.map((option) => option.name),
    ...(tool === 'texture' ? ['views'] : []),
  ])
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined && !known.has(key)) {
      problems.push(problem('UNKNOWN_OPTION', `${key} is not an option of refine ${tool}.`, key))
    }
  }

  const source = checkSource(tool, input, options, problems)

  let built: ToolBuild
  switch (tool as RefineToolId) {
    case 'retopo':
      built = buildRetopo(input as RetopoOptions, problems)
      break
    case 'segment':
      built = buildSegment(input as SegmentOptions, problems)
      break
    case 'uv':
      built = buildUv(input as UvOptions, problems)
      break
    case 'texture':
      built = buildTexture(input as TextureOptions, problems, warnings)
      break
    case 'rig':
      built = buildRig(input as RigOptions, problems)
      break
    case 'convert':
      built = buildConvert(input as ConvertOptions, problems)
      break
  }

  const metadata = buildMetadata(input, problems)
  if (problems.length > 0) return { ok: false, problems }

  const fields: Fields = { ...built.fields, ...(built.model ? { model: built.model as CreateGenerationRequest['model'] } : {}) }
  const request: CreateGenerationRequest = { spec: { postProcess: [built.code] }, ...source }
  const target = request as unknown as Record<string, unknown>
  for (const key of FIELD_ORDER) {
    if (fields[key] !== undefined) target[key] = fields[key]
  }
  if (metadata.title) request.title = metadata.title
  if (metadata.tags) request.tags = metadata.tags
  if (metadata.availability) request.availability = metadata.availability
  request.origin = metadata.origin

  const quote: QuoteSpec = { postProcess: [built.code], ...(built.model ? { model: built.model } : {}) }
  return { ok: true, request, quote, warnings }
}
