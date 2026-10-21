import {
  buildRefineRequest,
  checkEntitlements,
  CONVERT_FORMATS,
  CONVERT_ORIENTATIONS,
  CONVERT_TEXTURE_FORMATS,
  FBX_PRESETS,
  fileFormat,
  fromBase64,
  REFINE_TOOLS,
  RIG_OUT_FORMATS,
  RIG_SPECS,
  RIG_TYPES,
  SEGMENT_GRANULARITIES,
  textureReferenceEditRequest,
  toBase64,
  UV_ORIENTATIONS,
  ZettaError,
  type MeshFormat,
  type RefineInput,
  type RefineToolId,
  type ZettaClient,
} from '@zetta3d/sdk'
import { z } from 'zod'
import type { Context } from '../core/context'
import { defineCommand, spendShape, waitShape } from '../core/define'
import { usageError } from '../core/errors'
import { renderJob, runPaidJob, type WaitFlags } from '../core/jobs'
import type { SpendFlags } from '../core/spend'
import { inlinePicture, isUrl, resolvePicture, uploadLocal } from '../core/local-files'
import { failOnProblems, planLimits } from './generate'

const common = {
  source: z.string().describe('The model: an asset id, a local .glb file, or a URL to a .glb/.obj/.fbx.'),
  title: z.string().max(200).optional().describe('Title of the new asset.'),
  tag: z.array(z.string()).optional().describe('Tags for the new asset.'),
  visibility: z.enum(['public', 'private']).optional().describe('Share publicly, or keep private.'),
  format: z.array(z.string()).optional().describe('When downloading: only these formats.'),
  ...spendShape,
  ...waitShape,
}

type CommonInput = SpendFlags & WaitFlags & { source: string; title?: string; tag?: string[]; visibility?: 'public' | 'private'; idempotencyKey?: string; format?: string[] }

interface ResolvedSource {
  fields: { sourcePostId?: number; sourceFileUrl?: string; sourceFormat?: MeshFormat[] }
  /** Uploads a local file only once the spend is approved. */
  finish: () => Promise<{ sourcePostId?: number; sourceFileUrl?: string }>
}

const FORMAT_OF: Record<string, MeshFormat> = { glb: 'GLB', fbx: 'FBX', obj: 'OBJ', zip: 'OBJ' }

async function resolveSource(ctx: Context, client: ZettaClient, source: string): Promise<ResolvedSource> {
  if (/^\d+$/.test(source)) {
    const id = Number(source)
    const { generation } = await client.generations.get(id)
    if (generation.status !== 'success') {
      throw new ZettaError({ code: 'GEN3D_NOT_READY', message: `#${id} is ${generation.status}; it must finish first.`, details: { id }, status: 409 })
    }
    const formats = [...new Set((generation.result?.files ?? []).map((f) => FORMAT_OF[fileFormat(f)]).filter((f): f is MeshFormat => Boolean(f)))]
    return { fields: { sourcePostId: id, ...(formats.length ? { sourceFormat: formats } : {}) }, finish: async () => ({ sourcePostId: id }) }
  }
  if (isUrl(source)) return { fields: { sourceFileUrl: source }, finish: async () => ({ sourceFileUrl: source }) }
  if (!/\.glb$/i.test(source)) throw usageError('Local models must be .glb files. For OBJ or FBX, pass a URL, or import a GLB with `zetta asset import`.')
  const placeholder = `https://placeholder.invalid/${encodeURIComponent(source.split(/[/\\]/).pop() ?? 'model.glb')}`
  return {
    fields: { sourceFileUrl: placeholder, sourceFormat: ['GLB'] },
    finish: async () => ({ sourceFileUrl: (await uploadLocal(ctx, client, source, 'model')).fileUrl }),
  }
}

/** Shared path of every finishing tool: resolve → validate → plan check → quote → spend → submit. */
async function runRefine(
  ctx: Context,
  tool: RefineToolId,
  input: CommonInput,
  options: Record<string, unknown>,
  extra: { prepareOptions?: () => Promise<Record<string, unknown>> } = {},
) {
  const client = await ctx.client()
  const source = await resolveSource(ctx, client, input.source)
  const metadata = {
    ...(input.title ? { title: input.title } : {}),
    ...(input.tag?.length ? { tags: input.tag } : {}),
    ...(input.visibility ? { availability: input.visibility } : {}),
  }
  const draft = buildRefineRequest(tool, { ...source.fields, ...metadata, ...options } as RefineInput)
  if (!draft.ok) failOnProblems(draft.problems)
  const limits = await planLimits(client)
  if (limits) {
    const problems = checkEntitlements(draft.request, limits)
    if (problems.length) failOnProblems(problems, 'Your plan does not allow this')
  }
  for (const warning of draft.warnings) ctx.out.warn(warning)
  return runPaidJob(ctx, client, {
    what: REFINE_TOOLS[tool].label,
    request: draft.request as unknown as Record<string, unknown>,
    quote: draft.quote,
    flags: input,
    ...(input.format ? { formats: input.format } : {}),
    prepare: async () => {
      const finalSource = await source.finish()
      const finalOptions = extra.prepareOptions ? { ...options, ...(await extra.prepareOptions()) } : options
      const { sourceFormat } = source.fields
      const final = buildRefineRequest(tool, { ...finalSource, ...(sourceFormat ? { sourceFormat } : {}), ...metadata, ...finalOptions } as RefineInput)
      if (!final.ok) failOnProblems(final.problems)
      return final.request as unknown as Record<string, unknown>
    },
  })
}

const pick = <T extends Record<string, unknown>>(value: T) => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined))

export const refineRetopo = defineCommand({
  path: ['refine', 'retopo'],
  summary: 'Rebuild a model’s topology to a clean, lower polygon count.',
  description: 'Engine r1 (default) takes an exact --faces budget; n1 takes a --face-level.',
  kind: 'spend',
  positionals: [{ name: 'source', required: true }],
  input: z.object({
    ...common,
    engine: z.enum(['r1', 'n1']).optional().describe('Retopology engine (default r1).'),
    faces: z.number().int().positive().optional().describe('Target faces (r1): 500–20,000 triangles or 500–10,000 quads. Default 8,000.'),
    faceLevel: z.enum(['low', 'medium', 'high']).optional().describe('Density (n1).'),
    quads: z.boolean().optional().describe('Quad topology.'),
    bake: z.boolean().optional().describe('Bake the original detail into the new model’s textures.'),
    part: z.array(z.string()).optional().describe('Only these named parts of a segmented model.'),
  }),
  examples: ['zetta refine retopo 1234 --faces 5000 --quads --yes --wait', 'zetta refine retopo ./scan.glb --engine n1 --face-level low --dry-run'],
  async run(ctx, input) {
    return runRefine(ctx, 'retopo', input, pick({ engine: input.engine, faces: input.faces, faceLevel: input.faceLevel, polygonType: input.quads ? 'quad' : undefined, bake: input.bake, partNames: input.part }))
  },
  text: renderJob,
})

export const refineSegment = defineCommand({
  path: ['refine', 'segment'],
  summary: 'Split a model into separate parts.',
  description: '--smart uses the smarter segmentation (optionally guided by --prompt).',
  kind: 'spend',
  positionals: [{ name: 'source', required: true }],
  input: z.object({
    ...common,
    smart: z.boolean().optional().describe('Smart segmentation (better parts, costs more).'),
    granularity: z.enum(SEGMENT_GRANULARITIES).optional().describe('How finely to split.'),
    splitByConnectivity: z.boolean().optional().describe('Split disconnected pieces apart (default on; --no-split-by-connectivity to turn off).'),
    prompt: z.string().max(500).optional().describe('With --smart: which parts you want, e.g. "seat, legs, backrest".'),
  }),
  negatable: ['splitByConnectivity'],
  async run(ctx, input) {
    return runRefine(ctx, 'segment', input, pick({ mode: input.smart ? 'smart' : 'ai', granularity: input.granularity, splitByConnectivity: input.splitByConnectivity, prompt: input.prompt }))
  },
  text: renderJob,
})

export const refineUv = defineCommand({
  path: ['refine', 'uv'],
  summary: 'Unwrap clean UVs (Smart UV). Max 80,000 triangles.',
  kind: 'spend',
  positionals: [{ name: 'source', required: true }],
  input: z.object({
    ...common,
    bake: z.boolean().optional().describe('Bake the existing texture onto the new UVs.'),
    orientation: z.enum(UV_ORIENTATIONS).optional().describe('Which way the model faces in the export.'),
    compress: z.boolean().optional().describe('Compress geometry.'),
  }),
  async run(ctx, input) {
    return runRefine(ctx, 'uv', input, pick({ bake: input.bake, exportOrientation: input.orientation, compressGeometry: input.compress }))
  },
  text: renderJob,
})

export const refineTexture = defineCommand({
  path: ['refine', 'texture'],
  summary: 'Repaint a model’s texture from a reference picture or a description.',
  description: [
    'Give --reference (a picture of the look you want), --prompt (a description), or both.',
    'A description is turned into a reference picture first (needs image editing on your plan).',
  ].join('\n'),
  kind: 'spend',
  positionals: [{ name: 'source', required: true }],
  input: z.object({
    ...common,
    reference: z.string().optional().describe('Reference picture: a file, URL or image:<id>.'),
    prompt: z.string().max(2000).optional().describe('Describe the look, e.g. "weathered bronze with green patina".'),
    tier: z.enum(['standard', 'hd', '8k']).optional().describe('Texture resolution tier.'),
    alignment: z.enum(['image', 'geometry']).optional().describe('Follow the picture or the mesh.'),
    pbr: z.boolean().optional().describe('PBR materials.'),
    bake: z.boolean().optional().describe('Bake lighting effects into the base texture.'),
    fast: z.boolean().optional().describe('Faster standard tier.'),
    delight: z.boolean().optional().describe('Remove lighting from the reference first.'),
    removeBg: z.boolean().optional().describe('Remove the reference picture’s background first.'),
    part: z.array(z.string()).optional().describe('Only these named parts.'),
    seed: z.number().int().optional().describe('Texture seed.'),
  }),
  negatable: ['pbr'],
  examples: ['zetta refine texture 1234 --reference oak.jpg --tier hd --yes', 'zetta refine texture 1234 --prompt "brushed steel" --dry-run'],
  async run(ctx, input) {
    if (!input.reference && !input.prompt) throw usageError('Give --reference <picture> or --prompt <description>.')
    const options = pick({
      tier: input.tier,
      textureAlignment: input.alignment === 'image' ? 'original_image' : input.alignment,
      enablePBR: input.pbr,
      bake: input.bake,
      textureFast: input.fast,
      delight: input.delight,
      partNames: input.part,
      textureSeed: input.seed,
      imageUrl: 'https://placeholder.invalid/reference.png',
    })
    return runRefine(ctx, 'texture', input, options, {
      prepareOptions: async () => {
        const client = await ctx.client()
        if (!input.prompt) return { imageUrl: (await resolvePicture(ctx, client, input.reference!, { removeBackground: Boolean(input.removeBg), label: 'the reference' })).url }
        ctx.out.progress({ stage: 'image', message: 'Making a reference picture from the description…' })
        const reference = input.reference ? await referenceSource(input.reference) : await thumbnailSource(client, input.source)
        const request = textureReferenceEditRequest(input.prompt, reference as never)
        const result = await client.images.edit(request.body as never, crypto.randomUUID())
        const image = result.images[0]
        if (!image) throw new ZettaError({ code: 'IMAGE_GEN_NO_IMAGE', message: 'No reference picture came back for the description.' })
        const uploaded = await client.uploads.upload(new Blob([fromBase64(image.base64) as BlobPart], { type: image.contentType }), { contentType: image.contentType })
        return { imageUrl: uploaded.fileUrl }
      },
    })
  },
  text: renderJob,
})

async function referenceSource(value: string): Promise<{ data: string; contentType: string } | { sourcePostId: number }> {
  const library = /^image:(\d+)$/.exec(value)?.[1]
  if (library) return { sourcePostId: Number(library) }
  if (isUrl(value)) {
    const response = await fetch(value)
    if (!response.ok) throw usageError(`Could not fetch ${value}.`)
    return { data: toBase64(new Uint8Array(await response.arrayBuffer())), contentType: response.headers.get('content-type')?.split(';')[0] ?? 'image/png' }
  }
  return inlinePicture(value)
}

async function thumbnailSource(client: ZettaClient, source: string): Promise<{ data: string; contentType: string }> {
  if (!/^\d+$/.test(source)) throw usageError('With --prompt and no --reference, the source must be a library asset (its thumbnail is the starting picture).')
  const { generation } = await client.generations.get(Number(source))
  if (!generation.thumbnailURL) throw usageError(`#${source} has no thumbnail; give --reference too.`)
  const response = await fetch(generation.thumbnailURL)
  if (!response.ok) throw usageError(`Could not fetch #${source}'s thumbnail; give --reference too.`)
  return { data: toBase64(new Uint8Array(await response.arrayBuffer())), contentType: response.headers.get('content-type')?.split(';')[0] ?? 'image/png' }
}

export const refineRig = defineCommand({
  path: ['refine', 'rig'],
  summary: 'Add a skeleton so the model can be animated.',
  description: 'Not sure which --rig-type? Run `zetta asset rig-check <id>` first. --rig-spec mixamo names bones for Mixamo animations.',
  kind: 'spend',
  positionals: [{ name: 'source', required: true }],
  input: z.object({
    ...common,
    rigType: z.enum(RIG_TYPES).optional().describe('Body plan (default biped).'),
    rigSpec: z.enum(RIG_SPECS).optional().describe('Bone naming (default standard).'),
    rigFormat: z.enum(RIG_OUT_FORMATS).optional().describe('File format of the rigged model (default glb).'),
  }),
  examples: ['zetta refine rig 1234 --rig-type quadruped --rig-format fbx --yes --out .'],
  async run(ctx, input) {
    return runRefine(ctx, 'rig', input, pick({ rigType: input.rigType, rigSpec: input.rigSpec, rigOutFormat: input.rigFormat }))
  },
  text: renderJob,
})

export const refineConvert = defineCommand({
  path: ['refine', 'convert'],
  summary: 'Convert to FBX, USDZ, OBJ, STL, 3MF or glTF on the server, with optional clean-up.',
  description: 'For a quick, free GLB → OBJ/STL on your own machine, use `zetta asset export`. Geometry or texture options switch to the advanced (pricier) tier.',
  kind: 'spend',
  positionals: [{ name: 'source', required: true }],
  input: z.object({
    ...common,
    to: z.string().describe(`Target format: ${CONVERT_FORMATS.join(', ')} (any case).`),
    quad: z.boolean().optional().describe('Quad topology.'),
    symmetry: z.boolean().optional().describe('Force symmetry.'),
    faces: z.number().int().positive().optional().describe('Face limit.'),
    flattenBottom: z.boolean().optional().describe('Flatten the base (for printing or placing).'),
    flattenThreshold: z.number().optional().describe('How much of the base to flatten.'),
    textureSize: z.number().int().min(128).max(4096).optional().describe('Texture size in pixels (128–4096).'),
    textureFormat: z.string().optional().describe(`Texture image format: ${CONVERT_TEXTURE_FORMATS.join(', ')} (any case).`),
    packUv: z.boolean().optional().describe('Pack UVs.'),
    vertexColors: z.boolean().optional().describe('Export vertex colours.'),
    pivotBottom: z.boolean().optional().describe('Put the pivot at the bottom centre.'),
    scale: z.number().positive().optional().describe('Scale factor.'),
    withAnimation: z.boolean().optional().describe('Keep animation.'),
    inPlace: z.boolean().optional().describe('Animate in place.'),
    orientation: z.enum(CONVERT_ORIENTATIONS).optional().describe('Forward axis.'),
    fbxPreset: z.enum(FBX_PRESETS).optional().describe('FBX preset for a target app.'),
  }),
  examples: ['zetta refine convert 1234 --to usdz --yes --out .', 'zetta refine convert 1234 --to fbx --fbx-preset blender --dry-run'],
  async run(ctx, input) {
    const to = input.to.toUpperCase()
    if (!(CONVERT_FORMATS as readonly string[]).includes(to)) throw usageError(`--to must be one of: ${CONVERT_FORMATS.join(', ')}.`)
    const textureFormat = input.textureFormat?.toUpperCase().replace(/^JPG$/, 'JPEG').replace(/^EXR$/, 'OPEN_EXR').replace(/^TGA$/, 'TARGA')
    if (textureFormat && !(CONVERT_TEXTURE_FORMATS as readonly string[]).includes(textureFormat)) {
      throw usageError(`--texture-format must be one of: ${CONVERT_TEXTURE_FORMATS.join(', ')}.`)
    }
    return runRefine(ctx, 'convert', input, pick({
      outputFormat: to,
      quad: input.quad,
      forceSymmetry: input.symmetry,
      faceLimit: input.faces,
      flattenBottom: input.flattenBottom,
      flattenBottomThreshold: input.flattenThreshold,
      textureSize: input.textureSize,
      textureFormat,
      packUv: input.packUv,
      exportVertexColors: input.vertexColors,
      pivotToCenterBottom: input.pivotBottom,
      scaleFactor: input.scale,
      withAnimation: input.withAnimation,
      animateInPlace: input.inPlace,
      exportOrientation: input.orientation,
      fbxPreset: input.fbxPreset,
    }))
  },
  text: renderJob,
})

export const refineCommands = [refineRetopo, refineSegment, refineUv, refineTexture, refineRig, refineConvert]
