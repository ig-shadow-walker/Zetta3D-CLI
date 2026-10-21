/**
 * THE STUDIO TOOLS' SETTINGS AS DATA — ports of the web's `*-settings-value.ts` (retopology, segment,
 * texture, Smart UV, auto rig, splat) and of `postProcessRequestBody`, without `origin` or
 * `sourcePostId` (the server adds those). Each tool has its defaults and the one mapping from its
 * settings to a request, so a pipeline node sends what the Studio panel sends.
 */

export const SMART_TOPOLOGY = 'smart_topology'
export const AI_SEGMENTATION = 'ai_segmentation'
export const SMART_SEGMENTATION = 'smart_segmentation'
export const RETEXTURE = 'retexture'
export const RETEXTURE_HD = 'retexture_hd'
export const RETEXTURE_8K = 'retexture_8k'
export const AUTO_RIGGING = 'auto_rigging'
export const SMART_UV = 'smart_uv'
export const SPLAT_BASE = 'gaussian_splat'
export const SPLAT_MODEL = 'n25'

/** Smart UV refuses meshes over this many triangles. */
export const SMART_UV_MAX_TRIANGLES = 80_000

export const RETOPOLOGY_BOUNDS = {
  triangle: { min: 500, max: 20_000 },
  quadrilateral: { min: 500, max: 10_000 },
} as const

export const DEFAULT_RETOPOLOGY_FACES = 8_000

/** The rig conventions (bone naming) the Studio offers. Anything else is treated as `standard`. */
export const RIG_SPEC_VALUES = ['standard', 'mixamo'] as const
export const DEFAULT_RIG_TYPE = 'biped'
export const DEFAULT_RIG_SPEC = 'standard'
export const DEFAULT_RIG_OUT_FORMAT = 'glb'

export function isKnownRigSpec(value: unknown): boolean {
  return typeof value === 'string' && (RIG_SPEC_VALUES as readonly string[]).includes(value)
}

export const DEFAULT_RETOPOLOGY_SETTINGS = {
  engine: 'r1',
  faceLevel: 'medium',
  polygonType: 'triangle',
  faces: DEFAULT_RETOPOLOGY_FACES,
  bake: true,
} as const

export const DEFAULT_SEGMENT_SETTINGS = {
  mode: 'segment',
  granularity: 'balanced',
  splitByConnectivity: true,
  hint: '',
} as const

export const DEFAULT_TEXTURE_SETTINGS = {
  tier: RETEXTURE,
  alignment: 'original_image',
  bake: true,
  pbr: true,
  fast: false,
  delight: true,
  removeBg: true,
} as const

export const DEFAULT_SMART_UV_SETTINGS = {
  bake: true,
  orientation: 'as-is',
  compress: false,
} as const

export const DEFAULT_AUTO_RIG_SETTINGS = {
  rigType: DEFAULT_RIG_TYPE,
  spec: DEFAULT_RIG_SPEC,
  outFormat: DEFAULT_RIG_OUT_FORMAT,
} as const

export const DEFAULT_SPLAT_SETTINGS = {
  subject: 'object',
  engine: SPLAT_MODEL,
  removeBackground: true,
  ratio: '16:9',
  resolution: '1K',
} as const

export const DEFAULT_ISOLATE_SETTINGS = {
  identify: true,
  sensitivity: 'low',
  maxParts: 6,
  pose: 't',
  extraParts: [] as string[],
  model: null as string | null,
}

type Settings = Record<string, unknown>

/** A post-process tool's own fields, as its settings build them (`PostProcessSettingsRequest`). */
export interface PostProcessInput {
  code: string
  prompt?: string
  model?: string
  faceLevel?: string
  faceCount?: number
  segmentGranularity?: string
  splitByConnectivity?: boolean
  polygonType?: string
  rigType?: string
  rigSpec?: string
  rigOutFormat?: string
  exportOrientation?: string
  compressGeometry?: boolean
  textureAlignment?: string
  bake?: boolean
  enablePBR?: boolean
  textureFast?: boolean
  delight?: boolean
}

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

/** `postProcessRequestBody` without the fields the server adds (`origin`, `sourcePostId`). */
export function postProcessBody(input: PostProcessInput): Record<string, unknown> {
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
  return {
    spec: { postProcess: [input.code] },
    ...(prompt ? { prompt } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.faceLevel ? { faceLevel: input.faceLevel } : {}),
    ...(typeof input.faceCount === 'number' ? { faceCount: input.faceCount } : {}),
    ...(input.segmentGranularity ? { segmentGranularity: input.segmentGranularity } : {}),
    ...(input.splitByConnectivity === false ? { splitByConnectivity: false } : {}),
    ...(input.polygonType ? { polygonType: input.polygonType } : {}),
    ...(input.rigType ? { rigType: input.rigType } : {}),
    ...(input.rigSpec ? { rigSpec: input.rigSpec } : {}),
    ...(input.rigOutFormat ? { rigOutFormat: input.rigOutFormat } : {}),
    ...(input.exportOrientation ? { exportOrientation: input.exportOrientation } : {}),
    ...(input.compressGeometry ? { compressGeometry: true } : {}),
    ...(input.textureAlignment ? { textureAlignment: input.textureAlignment } : {}),
    ...(input.bake === false ? { bake: false } : {}),
    ...(input.enablePBR !== undefined ? { enablePBR: input.enablePBR } : {}),
    ...(input.textureFast ? { textureFast: true } : {}),
    ...(input.delight !== undefined ? { delight: input.delight } : {}),
  }
}

/** The polygon range R1 takes for a topology. */
export function retopologyBounds(polygonType: unknown): { min: number; max: number } {
  return polygonType === 'quadrilateral' ? RETOPOLOGY_BOUNDS.quadrilateral : RETOPOLOGY_BOUNDS.triangle
}

/** An R1 budget outside the range. Only R1 takes a count. */
export function retopologyOutOfRange(value: Settings): boolean {
  const bounds = retopologyBounds(value.polygonType)
  const faces = value.faces
  return (
    value.engine === 'r1' &&
    (typeof faces !== 'number' || !Number.isFinite(faces) || faces < bounds.min || faces > bounds.max)
  )
}

export function retopologyRequest(value: Settings): PostProcessInput {
  return {
    code: SMART_TOPOLOGY,
    model: str(value.engine),
    polygonType: str(value.polygonType),
    ...(value.engine === 'r1'
      ? {
          ...(typeof value.faces === 'number' ? { faceCount: value.faces } : {}),
          ...(typeof value.bake === 'boolean' ? { bake: value.bake } : {}),
        }
      : { faceLevel: str(value.faceLevel) }),
  }
}

export function segmentCode(value: Settings): string {
  return value.mode === 'smart' ? SMART_SEGMENTATION : AI_SEGMENTATION
}

export function segmentRequest(value: Settings): PostProcessInput {
  const hint = typeof value.hint === 'string' ? value.hint.trim() : ''
  return {
    code: segmentCode(value),
    segmentGranularity: str(value.granularity),
    ...(value.mode === 'smart'
      ? hint
        ? { prompt: hint }
        : {}
      : !value.splitByConnectivity
        ? { splitByConnectivity: false }
        : {}),
  }
}

export function textureRequest(value: Settings): PostProcessInput {
  return {
    code: String(value.tier),
    textureAlignment: str(value.alignment),
    enablePBR: value.pbr as boolean | undefined,
    ...(value.bake ? {} : { bake: false }),
    ...(value.fast && value.tier === RETEXTURE ? { textureFast: true } : {}),
    delight: value.delight as boolean | undefined,
  }
}

export function smartUvRequest(value: Settings): PostProcessInput {
  return {
    code: SMART_UV,
    ...(value.bake ? {} : { bake: false }),
    ...(value.orientation !== 'as-is' && typeof value.orientation === 'string' ? { exportOrientation: value.orientation } : {}),
    ...(value.compress ? { compressGeometry: true } : {}),
  }
}

/** Each choice is sent only when it is not the default; a bone naming the Studio does not offer is never sent. */
export function autoRigRequest(value: Settings): PostProcessInput {
  return {
    code: AUTO_RIGGING,
    ...(value.rigType !== DEFAULT_RIG_TYPE ? { rigType: str(value.rigType) } : {}),
    ...(value.spec !== DEFAULT_RIG_SPEC && isKnownRigSpec(value.spec) ? { rigSpec: str(value.spec) } : {}),
    ...(value.outFormat !== DEFAULT_RIG_OUT_FORMAT ? { rigOutFormat: str(value.outFormat) } : {}),
  }
}

/** The splat engine's cut-out is an object's only, on the first splat engine. */
export function splatRequest(value: Settings): { model: unknown; removeBackground: boolean } {
  const offersCutOut = value.subject === 'object' && value.engine === SPLAT_MODEL
  return { model: value.engine, removeBackground: offersCutOut && value.removeBackground === true }
}
