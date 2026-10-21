/**
 * THE GENERATE 3D FORM — a port of the Studio's form rules (`gen3d-request.ts`, `model-capabilities.ts`,
 * `generate-options.ts`), limited to what a pipeline's Generate 3D and Generate Smart 3D nodes use.
 *
 * The form holds the controls as designed (Quality, Output, the polygon count…); `deriveSpec` turns them
 * into the priced spec and `buildCreateRequest` into the API's fields. A node sends exactly what the
 * Studio would for the same choices, so every rule here is the Studio's, including its quirks.
 */

/** Our engine ids. `r1` only retopologises and the `zs*` ids only make splats; neither is a mesh generator. */
export type GenModel = 'n1' | 'n25' | 'np1' | 'np15' | 'r1' | 'zs2' | 'zs21'

export type Quality = 'low-poly' | 'high-res' | 'ultra'

export interface GenerateForm {
  quality: Quality
  output: 'geometry' | 'textured'
  pbrMaterials: boolean
  /** Raw input text. Empty means "send no count". */
  polygonCount: string
  /** The user typed `polygonCount` themselves: a topology switch keeps it. Never sent. */
  polygonCountTyped?: boolean
  polygonType: 'triangle' | 'quadrilateral'
  removeBackground: boolean
  controlMode: boolean
  textureQuality: 'standard' | 'detailed' | 'extreme'
  segmentParts: boolean
  realWorldScale: boolean
  textureAlignment: 'original_image' | 'geometry'
  delight: boolean
  /** Null: the caller did not choose, and the server decides by plan. */
  availability: 'public' | 'private' | null
  autofixImage: boolean
  compressGeometry: boolean
  /** Defaults ON; the request carries it only to turn UVs off. */
  exportUv: boolean
  imageFromPrompt: boolean
  model: GenModel
  imageUrl: string
  prompt: string
  title: string
}

export interface ModelCapabilities {
  label: string
  pbr: boolean
  customFaceCount: boolean
  multiView: boolean
  lowPoly: boolean
  geometryOnly: boolean
  extremeTexture: boolean
  faceRange?: { min: number; max: number }
  quadFaceRange?: { min: number; max: number }
  ceilingByQuality?: Record<Quality, number>
  floorByQuality?: Record<Quality, number>
  quadCeilingByQuality?: Record<Quality, number>
  quadFloorByQuality?: Record<Quality, number>
  hdTexture?: boolean
  imageTuning?: boolean
  parts?: boolean
  quadAnyBase?: boolean
  bareLowPoly?: boolean
}

export const MODEL_CAPABILITIES: Readonly<Record<GenModel, ModelCapabilities>> = {
  n1: {
    label: 'Zetta N1',
    multiView: true,
    lowPoly: true,
    pbr: true,
    customFaceCount: true,
    geometryOnly: true,
    extremeTexture: false,
  },
  n25: {
    label: 'Zetta N2.5',
    multiView: true,
    lowPoly: true,
    geometryOnly: true,
    pbr: true,
    customFaceCount: true,
    ceilingByQuality: { 'low-poly': 20_000, 'high-res': 1_000_000, ultra: 2_000_000 },
    floorByQuality: { 'low-poly': 1_000, 'high-res': 1_000, ultra: 1_000 },
    quadCeilingByQuality: { 'low-poly': 10_000, 'high-res': 150_000, ultra: 150_000 },
    quadFloorByQuality: { 'low-poly': 500, 'high-res': 1_000, ultra: 1_000 },
    hdTexture: true,
    imageTuning: true,
    parts: true,
    quadAnyBase: true,
    bareLowPoly: true,
    extremeTexture: false,
  },
  np1: {
    label: 'Zetta Np1',
    multiView: true,
    lowPoly: false,
    geometryOnly: true,
    pbr: true,
    customFaceCount: true,
    hdTexture: true,
    extremeTexture: true,
    imageTuning: true,
    parts: false,
    quadAnyBase: false,
    bareLowPoly: false,
    faceRange: { min: 48, max: 20_000 },
  },
  np15: {
    label: 'Zetta Np1.5',
    multiView: true,
    lowPoly: false,
    geometryOnly: true,
    pbr: true,
    customFaceCount: true,
    hdTexture: true,
    extremeTexture: true,
    imageTuning: true,
    parts: false,
    quadAnyBase: true,
    bareLowPoly: false,
    faceRange: { min: 48, max: 50_000 },
    quadFaceRange: { min: 48, max: 25_000 },
  },
  r1: {
    label: 'Zetta R1',
    multiView: false,
    lowPoly: false,
    pbr: false,
    customFaceCount: false,
    geometryOnly: false,
    extremeTexture: false,
  },
  zs2: {
    label: 'Zetta Splat 2',
    multiView: false,
    lowPoly: false,
    pbr: false,
    customFaceCount: false,
    geometryOnly: false,
    extremeTexture: false,
  },
  zs21: {
    label: 'Zetta Splat 2.1',
    multiView: false,
    lowPoly: false,
    pbr: false,
    customFaceCount: false,
    geometryOnly: false,
    extremeTexture: false,
  },
}

/** The engines each generate tab offers. */
export const GENERATE_ENGINES = ['n1', 'n25'] as const
export const SMART_ENGINES = ['np1', 'np15'] as const

export const MULTI_VIEW_MODIFIER = 'multi_view'
export const FACE_COUNT_MODIFIER = 'custom_face_count'
export const PBR_MODIFIER = 'pbr'
export const DETAILED_GEOMETRY_MODIFIER = 'detailed_geometry'
export const DETAILED_TEXTURE_MODIFIER = 'detailed_texture'
export const EXTREME_TEXTURE_MODIFIER = 'extreme_texture'
export const GENERATE_PARTS_MODIFIER = 'generate_parts'
export const GEOMETRY_BASE = 'geometry_only'
export const TEXTURED_BASE = 'textured'
export const LOWPOLY_BASE = 'lowpoly'

export interface GenerationSpec {
  generation: { base: string; modifiers: string[] }
}

/** The client-side polygon bounds where an engine has no table of its own. */
export const POLYGON_MIN = 3_100
export const POLYGON_MAX = 1_480_000

/** What each rung fills the polygon count with on an engine whose rungs are counts. */
export const QUALITY_POLYGONS: Readonly<Record<Quality, number>> = {
  'low-poly': 9_000,
  'high-res': 200_000,
  ultra: 1_000_000,
}

const LOW_POLY_CEILING = 15_000
const ULTRA_FLOOR = 1_000_000
const MAX_IMAGE_URL = 2048

/** The Studio's own form defaults. */
export const DEFAULT_FORM: Readonly<GenerateForm> = {
  quality: 'high-res',
  output: 'textured',
  pbrMaterials: true,
  polygonCount: String(QUALITY_POLYGONS['high-res']),
  polygonType: 'triangle',
  textureQuality: 'standard',
  segmentParts: false,
  realWorldScale: false,
  textureAlignment: 'geometry',
  delight: false,
  availability: null,
  autofixImage: false,
  compressGeometry: false,
  exportUv: true,
  imageFromPrompt: false,
  removeBackground: true,
  controlMode: true,
  model: 'n1',
  imageUrl: '',
  prompt: '',
  title: '',
}

/** An engine's capabilities, or null for an id this SDK does not know. */
export function capabilitiesOf(model: unknown): ModelCapabilities | null {
  return typeof model === 'string' && Object.hasOwn(MODEL_CAPABILITIES, model)
    ? MODEL_CAPABILITIES[model as GenModel]
    : null
}

/** A number the way the Studio prints it ("1,000,000"). */
export function formatCount(value: number): string {
  return value.toLocaleString('en-US')
}

/** Which rung a polygon count implies on an engine whose rungs are counts, or null when it should not move it. */
export function qualityForPolygons(raw: string): Quality | null {
  const text = String(raw ?? '')
  const parsed = Number(text)
  if (text.trim() === '' || !Number.isInteger(parsed)) return null
  if (parsed < POLYGON_MIN || parsed > POLYGON_MAX) return null
  if (parsed >= ULTRA_FLOOR) return 'ultra'
  if (parsed > LOW_POLY_CEILING) return 'high-res'
  return 'low-poly'
}

/** The most and fewest polygons this form may ask for. */
export function polygonBounds(form: GenerateForm): { min: number; max: number } {
  const caps = capabilitiesOf(form.model)
  if (!caps) return { min: POLYGON_MIN, max: POLYGON_MAX }
  if (caps.faceRange) {
    return form.polygonType === 'quadrilateral' && caps.quadFaceRange ? caps.quadFaceRange : caps.faceRange
  }
  const quads = form.polygonType === 'quadrilateral'
  const ceilings = quads ? caps.quadCeilingByQuality : caps.ceilingByQuality
  const floors = quads ? caps.quadFloorByQuality : caps.floorByQuality
  return {
    min: floors?.[form.quality] ?? POLYGON_MIN,
    max: ceilings?.[form.quality] ?? POLYGON_MAX,
  }
}

/** The count a rung fills the field with — and therefore the count that is not custom. */
export function defaultPolygonCount(form: GenerateForm): number {
  const caps = capabilitiesOf(form.model)
  if (caps?.faceRange) return polygonBounds(form).max
  if (caps?.ceilingByQuality) return polygonBounds(form).max
  return QUALITY_POLYGONS[form.quality] ?? QUALITY_POLYGONS['high-res']
}

/** Whether the count is a custom one (paid for), rather than the one the rung fills in. */
export function hasCustomPolygonCount(form: GenerateForm, mayChoose = true): boolean {
  if (!mayChoose || !capabilitiesOf(form.model)?.customFaceCount) return false
  const raw = String(form.polygonCount ?? '').trim()
  if (raw === '') return false
  const parsed = Number(raw)
  if (Number.isInteger(parsed) && parsed === defaultPolygonCount(form)) return false
  return true
}

/**
 * A change to the form, with the coupled controls kept in step: the engine's legal values, the
 * Low-Poly and Segmented-mesh invariants, and the polygon count following a rung, a topology or an
 * engine change — or moving the rung when typed, where a rung is a count.
 */
export function applyFormPatch(current: GenerateForm, patch: Partial<GenerateForm>): GenerateForm {
  const next: GenerateForm = { ...current, ...patch }
  const capabilities = capabilitiesOf(next.model)
  if (!capabilities) return next

  if (next.quality === 'low-poly' && !capabilities.lowPoly) next.quality = 'high-res'
  if (next.textureQuality === 'extreme' && !capabilities.extremeTexture) next.textureQuality = 'detailed'
  if (next.polygonType === 'quadrilateral' && !capabilities.quadAnyBase && !capabilities.lowPoly) {
    next.polygonType = 'triangle'
  }

  if (next.quality === 'low-poly') {
    if (!capabilities.bareLowPoly) next.output = 'textured'
    next.segmentParts = false
  } else if (next.segmentParts) {
    next.output = 'geometry'
    next.polygonType = 'triangle'
  }

  if (patch.quality !== undefined && patch.quality !== current.quality) {
    return { ...next, polygonCount: String(defaultPolygonCount(next)), polygonCountTyped: false }
  }
  if (patch.polygonType !== undefined && patch.polygonType !== current.polygonType && !next.polygonCountTyped) {
    return { ...next, polygonCount: String(defaultPolygonCount(next)) }
  }
  if (patch.model !== undefined && patch.model !== current.model) {
    const bounds = polygonBounds(next)
    const count = Number(next.polygonCount)
    if (!Number.isFinite(count) || count < bounds.min || count > bounds.max) {
      return { ...next, polygonCount: String(defaultPolygonCount(next)) }
    }
  }
  if (patch.polygonCount !== undefined && !capabilities.ceilingByQuality) {
    const implied = qualityForPolygons(patch.polygonCount)
    if (implied !== null) return { ...next, quality: implied }
  }
  return next
}

/** The priced spec the form's controls resolve to. */
export function deriveSpec(form: GenerateForm, multiView = false, mayChooseFaceCount = true): GenerationSpec {
  const model = capabilitiesOf(form.model)
  const base =
    form.quality === 'low-poly' && model?.lowPoly
      ? LOWPOLY_BASE
      : form.output === 'geometry'
        ? GEOMETRY_BASE
        : TEXTURED_BASE

  const modifiers: string[] = []
  if (multiView) modifiers.push(MULTI_VIEW_MODIFIER)
  if (form.pbrMaterials && form.output === 'textured' && model?.pbr) modifiers.push(PBR_MODIFIER)
  if (form.quality === 'ultra' && model?.ceilingByQuality) modifiers.push(DETAILED_GEOMETRY_MODIFIER)
  if (form.segmentParts && form.output === 'geometry' && form.quality !== 'low-poly' && model?.parts) {
    modifiers.push(GENERATE_PARTS_MODIFIER)
  }
  if (form.output === 'textured') {
    if (form.textureQuality === 'extreme' && model?.extremeTexture) modifiers.push(EXTREME_TEXTURE_MODIFIER)
    else if (form.textureQuality === 'detailed' && model?.hdTexture) modifiers.push(DETAILED_TEXTURE_MODIFIER)
  }
  if (hasCustomPolygonCount(form, mayChooseFaceCount)) modifiers.push(FACE_COUNT_MODIFIER)
  return { generation: { base, modifiers } }
}

/** What the form's parameters alone would be refused for. */
export function parameterProblems(form: GenerateForm, mayChooseFaceCount = true): string[] {
  const problems: string[] = []
  if (hasCustomPolygonCount(form, mayChooseFaceCount)) {
    const parsed = Number(form.polygonCount)
    const bounds = polygonBounds(form)
    if (!Number.isInteger(parsed)) {
      problems.push('The polygon count must be a whole number.')
    } else if (parsed < bounds.min || parsed > bounds.max) {
      problems.push(`The polygon count must be between ${formatCount(bounds.min)} and ${formatCount(bounds.max)}.`)
    }
  }
  return problems
}

/** The wire fields for the engine's own options. */
function engineFields(form: GenerateForm, spec: GenerationSpec): Record<string, unknown> {
  const caps = capabilitiesOf(form.model)
  const partsRequested = spec.generation.modifiers.includes(GENERATE_PARTS_MODIFIER)
  const polygonType =
    (spec.generation.base === LOWPOLY_BASE || caps?.quadAnyBase) && !(partsRequested && form.polygonType === 'quadrilateral')
      ? form.polygonType
      : undefined
  return {
    ...(polygonType === undefined ? {} : { polygonType }),
    ...(spec.generation.base === LOWPOLY_BASE && form.output === 'geometry' && caps?.bareLowPoly
      ? { generationType: 'Geometry' }
      : {}),
    ...(form.availability ? { availability: form.availability } : {}),
    ...(caps?.imageTuning
      ? {
          ...(form.realWorldScale ? { autoSize: true } : {}),
          ...(form.textureAlignment !== 'original_image' ? { textureAlignment: form.textureAlignment } : {}),
          ...(form.autofixImage ? { autofixImage: true } : {}),
          ...(form.compressGeometry ? { compressGeometry: true } : {}),
          ...(form.delight ? { delight: true } : {}),
          ...(form.exportUv ? {} : { exportUv: false }),
        }
      : {}),
  }
}

export type BuildResult = { ok: true; input: Record<string, unknown> & { spec: GenerationSpec } } | { ok: false; problems: string[] }

/** The single-picture (or prompt) create request the Studio sends, or why it would be refused. */
export function buildCreateRequest(form: GenerateForm, mayChooseFaceCount = true): BuildResult {
  const problems = parameterProblems(form, mayChooseFaceCount)
  const spec = deriveSpec(form, false, mayChooseFaceCount)
  const imageUrl = String(form.imageUrl ?? '').trim()
  const prompt = String(form.prompt ?? '').trim()
  const hasImage = imageUrl !== ''
  const hasPrompt = prompt !== ''
  const fromPrompt = form.imageFromPrompt && hasImage && hasPrompt

  if (hasImage && hasPrompt && !fromPrompt) problems.push('Use either a prompt or an image, not both.')
  if (!hasImage && !hasPrompt) problems.push('Attach an image to generate from.')
  if (hasImage) {
    if (!/^https?:\/\//i.test(imageUrl)) problems.push('The image address must start with http:// or https://')
    if (imageUrl.length > MAX_IMAGE_URL) problems.push(`The image address is longer than ${MAX_IMAGE_URL} characters.`)
  }

  const rawCount = String(form.polygonCount ?? '')
  const parsedCount = Number(rawCount)
  const requestedCount =
    rawCount.trim() !== '' && Number.isInteger(parsedCount) && problems.length === 0 ? parsedCount : undefined
  const faceCount = mayChooseFaceCount && capabilitiesOf(form.model)?.customFaceCount ? requestedCount : undefined

  if (problems.length > 0) return { ok: false, problems }

  const title = String(form.title ?? '').trim()
  return {
    ok: true,
    input: {
      spec,
      ...(fromPrompt ? { imageUrl, prompt, imageFromPrompt: true } : hasImage ? { imageUrl } : { prompt }),
      ...(faceCount === undefined ? {} : { faceCount }),
      ...engineFields(form, spec),
      ...(title ? { title } : {}),
      ...(form.controlMode ? { advanceControl: true } : {}),
      model: form.model,
      origin: 'studio',
    },
  }
}
