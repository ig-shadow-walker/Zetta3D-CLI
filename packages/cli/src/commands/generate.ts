import {
  buildGenerateRequest,
  checkEntitlements,
  drawViewRequest,
  ENGINES,
  fromBase64,
  imageForPromptRequest,
  missingViews,
  needsImageForPrompt,
  PLAN_REQUIRED_MESSAGE,
  referenceView,
  retiredModelMessage,
  ZettaError,
  type DrawView,
  type GenerateEngineId,
  type GenerateInput,
  type Problem,
  type ThreeDEntitlements,
  type ViewType,
  type ZettaClient,
} from '@zetta3d/sdk'
import { z } from 'zod'
import type { Context } from '../core/context'
import { defineCommand, spendShape, waitShape } from '../core/define'
import { usageError } from '../core/errors'
import { renderJob, runPaidJob } from '../core/jobs'
import { inlinePicture, isUrl, resolvePicture } from '../core/local-files'

/** Accepts the public spellings (n2.5, np1.5) and the ids (n25, np15). */
export const ENGINE_CHOICES = ['n2.5', 'n25', 'np1', 'np1.5', 'np15'] as const
const ENGINE_LIST = 'n2.5 (Generate 3D), np1 and np1.5 (Generate Smart 3D)'
export function engineId(value: string | undefined, fallback: GenerateEngineId = 'n25'): GenerateEngineId {
  if (!value) return fallback
  const id = value.toLowerCase().replace('zetta ', '').replace('.', '')
  if (id === 'n25' || id === 'np1' || id === 'np15') return id
  const retired = retiredModelMessage(id)
  if (retired) throw usageError(`${retired} Engines: ${ENGINE_LIST}.`)
  throw usageError(`Unknown engine "${value}". Engines: ${ENGINE_LIST} (see \`zetta catalog engines\`).`)
}

/** The sides a multi-view generation takes. */
const VIEW_SLOTS: readonly ViewType[] = ['front', 'back', 'left', 'right']

/** Placeholder URL used to validate and price a request before anything is uploaded. */
const PLACEHOLDER = 'https://placeholder.invalid/picture.png'

/**
 * Throws one error listing everything that must change: PLAN_REQUIRED (no paid plan at all),
 * PLAN_CAPABILITY_REQUIRED (the plan lacks a feature) or BUILD_PROBLEMS (options that conflict).
 */
export function failOnProblems(problems: Problem[], what = 'These options do not work together'): never {
  if (problems.some((p) => p.code === 'PLAN_REQUIRED')) {
    throw new ZettaError({ code: 'PLAN_REQUIRED', message: PLAN_REQUIRED_MESSAGE, status: 403, details: { problems } })
  }
  const planGate = problems.some((p) => p.code.endsWith('_NOT_AVAILABLE') || p.code === 'PLAN_CAPABILITY_REQUIRED')
  throw new ZettaError({
    code: planGate ? 'PLAN_CAPABILITY_REQUIRED' : 'BUILD_PROBLEMS',
    message: `${what}: ${problems.map((p) => p.message).join(' ')}`,
    ...(planGate ? { status: 403 } : {}),
    details: { problems },
  })
}

/** Plan limits, used to fail early (the server enforces them too). Missing data never blocks. */
export async function planLimits(client: ZettaClient): Promise<ThreeDEntitlements | undefined> {
  try {
    return (await client.catalog.entitlements3d()).entitlements as unknown as ThreeDEntitlements
  } catch {
    return undefined
  }
}

function parseViews(values: string[] | undefined): Partial<Record<ViewType, string>> | undefined {
  if (!values?.length) return undefined
  const views: Partial<Record<ViewType, string>> = {}
  for (const value of values) {
    const at = value.indexOf('=')
    const slot = (at > 0 ? value.slice(0, at) : '').trim().toLowerCase() as ViewType
    const source = at > 0 ? value.slice(at + 1).trim() : ''
    if (!VIEW_SLOTS.includes(slot) || !source) {
      throw usageError(`--view "${value}" should look like front=./front.png (slots: ${VIEW_SLOTS.join(', ')}).`)
    }
    views[slot] = source
  }
  return views
}

export const generate = defineCommand({
  path: ['generate'],
  summary: 'Make a 3D model from a text prompt, a picture, or several views.',
  description: [
    'Pictures can be local files, URLs, or image:<id> from your image library. A prompt is made into a picture first, then into a model.',
    'Engines: n2.5 (the default; quality levels, parts, quads) and the Smart engines np1 and np1.5 (clean topology to a polygon budget, 8K textures). Every generation needs a paid plan. See `zetta catalog engines` for limits and defaults.',
    'The price is checked first: use --dry-run to see it, --yes or --max-credits to spend without a prompt.',
    'In a terminal it waits, then downloads the results into the current folder (the download.auto setting). Scripts and agents get the asset id at once; add --wait to wait, or --out <folder> to wait and download.',
  ].join('\n'),
  kind: 'spend',
  input: z.object({
    prompt: z.string().min(1).max(1024).optional().describe('Describe the object (text to 3D). A picture is made from it first. Not with --image or --view.'),
    image: z.string().optional().describe('One picture of the object: a file, URL, or image:<id>.'),
    view: z.array(z.string()).optional().describe('Multi-view pictures as slot=source: front (required) plus at least one of back, left, right.'),
    engine: z.enum(ENGINE_CHOICES).optional().describe('Engine: n2.5 (default, or `defaults.engine` from config), np1 or np1.5.'),
    quality: z.enum(['lowpoly', 'high', 'ultra']).optional().describe('N2.5 only: low-poly (1,000–20,000 polygons), high (default, up to 1,000,000) or ultra (up to 2,000,000, a paid extra).'),
    texture: z.boolean().default(true).describe('Textured model (default). --no-texture gives geometry only.'),
    pbr: z.boolean().optional().describe('PBR materials (on by default for textured models; --no-pbr to skip).'),
    textureQuality: z.enum(['standard', 'detailed', 'extreme', '8k']).optional().describe('Texture detail: standard (default), detailed (HD), or extreme (8K, np1 and np1.5 only; 8k is the same).'),
    faces: z.number().int().positive().optional().describe('Polygon budget. Defaults to the most the engine and quality allow; another count is a paid extra. See `zetta catalog engines`.'),
    quads: z.boolean().optional().describe('Quad topology instead of triangles (N2.5 and np1.5).'),
    parts: z.boolean().optional().describe('Split into separate editable parts (N2.5, geometry only, not low-poly).'),
    textureAlignment: z.enum(['image', 'geometry']).optional().describe('Fit the texture to the picture, or to the mesh (default).'),
    autoSize: z.boolean().optional().describe('Scale to real-world size.'),
    delight: z.boolean().optional().describe('Remove baked-in lighting from the picture before texturing.'),
    autofix: z.boolean().optional().describe('Clean up the picture before building (slower).'),
    compress: z.boolean().optional().describe('Compress geometry for a smaller file.'),
    uv: z.boolean().default(true).describe('Unwrap UVs (default). --no-uv is faster and smaller.'),
    fastTexture: z.boolean().optional().describe('Faster standard-quality texturing.'),
    seed: z.number().int().optional().describe('Model seed, for reproducible results.'),
    textureSeed: z.number().int().optional().describe('Texture seed.'),
    removeBg: z.boolean().optional().describe('Remove the background from the picture(s) first.'),
    drawMissing: z.boolean().optional().describe('With --view: draw the missing side views with AI from the front view.'),
    title: z.string().max(200).optional().describe('Title in your library.'),
    tag: z.array(z.string()).optional().describe('Tags.'),
    visibility: z.enum(['public', 'private']).optional().describe('Share publicly, or keep private. Your plan’s default when left out.'),
    format: z.array(z.string()).optional().describe('When downloading: only these formats (glb, fbx, obj, usdz …).'),
    ...spendShape,
    ...waitShape,
  }),
  short: { prompt: 'p', image: 'i' },
  negatable: ['pbr'],
  examples: [
    'zetta generate --image chair.png --engine n2.5 --out ./models',
    'zetta generate -p "a low-poly treasure chest" --quality lowpoly --dry-run',
    'zetta generate --view front=f.png --view back=b.png --view left=l.png --view right=r.png --yes --wait',
    'zetta generate -i photo.jpg --remove-bg --engine np1.5 --quads --faces 8000 --texture-quality extreme --max-credits 200 --out .',
  ],
  async run(ctx, input) {
    const engine = engineId(input.engine ?? ctx.config.file.defaults?.engine)
    const views = parseViews(input.view)
    if (!input.prompt && !input.image && !views) throw usageError('Give --prompt, --image or --view.')
    if (input.image && views) throw usageError('Use --image or --view, not both (put the main picture in front=).')
    if (input.drawMissing && !views) throw usageError('--draw-missing goes with --view.')

    const client = await ctx.client()
    const limits = await planLimits(client)
    // Text to 3D as the Studio does it: a picture from the prompt, then a model from the picture.
    const textFirst = Boolean(input.prompt && !input.image && !views && needsImageForPrompt(engine))

    const options = (sources: { imageUrl?: string; views?: Partial<Record<ViewType, string>> }): GenerateInput => ({
      engine,
      ...(input.prompt ? { prompt: input.prompt } : {}),
      ...(sources.imageUrl ? { imageUrl: sources.imageUrl } : {}),
      ...(textFirst ? { imageFromPrompt: true } : {}),
      ...(sources.views ? { views: sources.views } : {}),
      ...(input.quality ? { quality: input.quality } : {}),
      ...(input.texture === false ? { output: 'geometry' as const } : {}),
      ...(input.pbr !== undefined ? { pbr: input.pbr } : {}),
      ...(input.textureQuality ? { textureQuality: input.textureQuality } : {}),
      ...(input.faces !== undefined ? { faceCount: input.faces } : {}),
      ...(input.quads ? { polygonType: 'quad' as const } : {}),
      ...(input.parts ? { parts: true } : {}),
      ...(input.textureAlignment ? { textureAlignment: input.textureAlignment === 'image' ? ('original_image' as const) : ('geometry' as const) } : {}),
      ...(input.autoSize ? { autoSize: true } : {}),
      ...(input.delight ? { delight: true } : {}),
      ...(input.autofix ? { autofixImage: true } : {}),
      ...(input.compress ? { compressGeometry: true } : {}),
      ...(input.uv === false ? { exportUv: false } : {}),
      ...(input.fastTexture ? { textureFast: true } : {}),
      ...(input.seed !== undefined ? { modelSeed: input.seed } : {}),
      ...(input.textureSeed !== undefined ? { textureSeed: input.textureSeed } : {}),
      ...(input.title ? { title: input.title } : {}),
      ...(input.tag?.length ? { tags: input.tag } : {}),
      ...(input.visibility ? { availability: input.visibility } : {}),
      ...(limits ? { allowsCustomFaceCount: limits.allowsCustomFaceCount } : {}),
    })

    // 1. Validate and price with placeholders, before uploading or generating anything.
    const slots = views ? [...Object.keys(views), ...(input.drawMissing ? missingViews(views as Partial<Record<DrawView, unknown>>) : [])] : []
    const placeholderViews = views ? Object.fromEntries(slots.map((slot) => [slot, PLACEHOLDER])) : undefined
    const draft = buildGenerateRequest(options({ ...(input.image || textFirst ? { imageUrl: PLACEHOLDER } : {}), ...(placeholderViews ? { views: placeholderViews } : {}) }))
    if (!draft.ok) failOnProblems(draft.problems)
    if (limits) {
      const problems = checkEntitlements(draft.request, limits)
      if (problems.length) failOnProblems(problems, 'Your plan does not allow this')
    }
    for (const warning of draft.warnings) ctx.out.warn(warning)

    const what = `${ENGINES[engine].label} ${views ? 'multi-view' : input.image ? 'image' : 'text'} to 3D`
    const outcome = await runPaidJob(ctx, client, {
      what,
      request: draft.request as unknown as Record<string, unknown>,
      quote: draft.quote,
      flags: input,
      ...(input.format ? { formats: input.format } : {}),
      // 2. Only once the spend is approved: make/upload the pictures and build the real request.
      prepare: async () => {
        const sources: { imageUrl?: string; views?: Partial<Record<ViewType, string>> } = {}
        if (textFirst) sources.imageUrl = await pictureFromPrompt(ctx, client, input.prompt!)
        if (input.image) sources.imageUrl = (await resolvePicture(ctx, client, input.image, { removeBackground: Boolean(input.removeBg), label: 'the picture' })).url
        if (views) sources.views = await resolveViews(ctx, client, views, { removeBackground: Boolean(input.removeBg), drawMissing: Boolean(input.drawMissing) })
        const final = buildGenerateRequest(options(sources))
        if (!final.ok) failOnProblems(final.problems)
        return final.request as unknown as Record<string, unknown>
      },
    })
    return outcome
  },
  text: renderJob,
})

/** Text to 3D on engines that need a picture: make one with the image engine, then upload it. */
async function pictureFromPrompt(ctx: Context, client: ZettaClient, prompt: string): Promise<string> {
  ctx.out.progress({ stage: 'image', message: 'Making a picture from the prompt…' })
  const request = imageForPromptRequest(prompt)
  const result = await client.images.generate(request.body, crypto.randomUUID())
  const image = result.images[0]
  if (!image) throw new ZettaError({ code: 'IMAGE_GEN_NO_IMAGE', message: 'No picture came back for the prompt.' })
  const uploaded = await client.uploads.upload(new Blob([fromBase64(image.base64) as BlobPart], { type: image.contentType }), { contentType: image.contentType })
  return uploaded.fileUrl
}

async function resolveViews(
  ctx: Context,
  client: ZettaClient,
  views: Partial<Record<ViewType, string>>,
  options: { removeBackground: boolean; drawMissing: boolean },
): Promise<Partial<Record<ViewType, string>>> {
  const resolved: Partial<Record<ViewType, string>> = {}
  for (const [slot, source] of Object.entries(views) as Array<[ViewType, string]>) {
    resolved[slot] = (await resolvePicture(ctx, client, source, { removeBackground: options.removeBackground, label: `the ${slot} view` })).url
  }
  if (!options.drawMissing) return resolved
  const drawable = views as Partial<Record<DrawView, string>>
  const reference = referenceView(drawable)
  if (!reference) throw usageError('--draw-missing needs at least one of front, back, left or right.')
  const referenceSource = drawable[reference]!
  const sourceBytes = isUrl(referenceSource) || referenceSource.startsWith('image:') ? undefined : referenceSource
  for (const view of missingViews(drawable)) {
    ctx.out.progress({ stage: 'image', message: `Drawing the ${view} view…` })
    const source = sourceBytes ? inlinePicture(sourceBytes) : { sourcePostId: Number(referenceSource.replace('image:', '')) }
    if (!sourceBytes && Number.isNaN((source as { sourcePostId: number }).sourcePostId)) {
      throw usageError('--draw-missing needs the reference view as a local file or image:<id>.')
    }
    const request = drawViewRequest(view, source as never)
    const result = await client.images.edit(request.body as never, crypto.randomUUID())
    const image = result.images[0]
    if (!image) throw new ZettaError({ code: 'IMAGE_GEN_NO_IMAGE', message: `No picture came back for the ${view} view.` })
    const uploaded = await client.uploads.upload(new Blob([fromBase64(image.base64) as BlobPart], { type: image.contentType }), { contentType: image.contentType })
    resolved[view] = uploaded.fileUrl
  }
  return resolved
}

export const generateCommands = [generate]
