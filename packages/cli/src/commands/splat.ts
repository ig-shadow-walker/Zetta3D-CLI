import {
  buildSplatRequest,
  buildWorldExportRequest,
  checkEntitlements,
  fromBase64,
  imageForPromptRequest,
  normalizeAzimuth,
  SPLAT_ENGINES,
  WORLD_MESH_VARIANTS,
  WORLD_SPLAT_RESOLUTIONS,
  ZettaError,
  type SplatEngineId,
  type SplatInput,
} from '@zetta3d/sdk'
import { z } from 'zod'
import { defineCommand, spendShape, waitShape } from '../core/define'
import { usageError } from '../core/errors'
import { renderJob, runPaidJob } from '../core/jobs'
import { isUrl, resolvePicture, uploadLocal } from '../core/local-files'
import { failOnProblems, planLimits } from './generate'

const PLACEHOLDER = 'https://placeholder.invalid/picture.png'

function splatEngine(value: string | undefined): SplatEngineId {
  const v = (value ?? 'splat').toLowerCase().replace(/\s|zetta/g, '')
  if (v === 'splat' || v === 'n25') return 'n25'
  if (v === 'splat2' || v === 'zs2') return 'zs2'
  if (v === 'splat2.1' || v === 'splat21' || v === 'zs21') return 'zs21'
  throw usageError(`Unknown splat engine "${value}". Engines: splat, splat2, splat2.1.`)
}

export const splatCreate = defineCommand({
  path: ['splat', 'create'],
  summary: 'Make a Gaussian-splat object or world from pictures, a video, or a prompt (early access).',
  description: [
    'Engines: splat (an object or scene from one picture), splat2 and splat2.1 (whole worlds; also from a video, or several pictures of the same place).',
    'More pictures of the same place: --world-view <azimuth>=<picture>, e.g. 90=right.jpg (degrees clockwise from the main picture).',
    'Exports from a world: `zetta splat export <id> --as splat|mesh|collider`.',
  ].join('\n'),
  kind: 'spend',
  input: z.object({
    image: z.string().optional().describe('The main picture: a file, URL or image:<id>.'),
    video: z.string().optional().describe('A video of the place (splat2/2.1): MP4, WebM, MOV or AVI up to 100 MB.'),
    prompt: z.string().max(5000).optional().describe('Describe the scene. Without a picture, a picture is made from it first.'),
    engine: z.string().optional().describe('splat (default), splat2 or splat2.1.'),
    subject: z.enum(['object', 'environment']).optional().describe('An object, or an environment (changes how a prompt picture is framed).'),
    worldView: z.array(z.string()).optional().describe('Extra pictures of the same place as azimuth=picture (splat2/2.1).'),
    sameSpace: z.boolean().optional().describe('Reconstruct from all pictures together (up to 8).'),
    seed: z.number().int().optional().describe('Seed (splat engine only).'),
    title: z.string().max(200).optional().describe('Title in your library.'),
    tag: z.array(z.string()).optional().describe('Tags.'),
    visibility: z.enum(['public', 'private']).optional().describe('Share publicly, or keep private.'),
    format: z.array(z.string()).optional().describe('With --out: only these formats (ply, spz, glb …).'),
    ...spendShape,
    ...waitShape,
  }),
  examples: ['zetta splat create --image room.jpg --engine splat2 --dry-run', 'zetta splat create --video walkthrough.mp4 --engine splat2.1 --yes --wait'],
  async run(ctx, input) {
    const engine = splatEngine(input.engine)
    if (!input.image && !input.video && !input.prompt) throw usageError('Give --image, --video or --prompt.')
    const views = (input.worldView ?? []).map((value) => {
      const at = value.indexOf('=')
      const azimuth = at > 0 ? normalizeAzimuth(value.slice(0, at)) : null
      const source = at > 0 ? value.slice(at + 1) : value
      if (at > 0 && azimuth === null) throw usageError(`--world-view "${value}": the azimuth must be 1–359 degrees.`)
      return { azimuth, source }
    })
    const fromPrompt = Boolean(input.prompt && !input.image && !input.video)
    const client = await ctx.client()
    const base = (sources: { imageUrl?: string; videoUrl?: string; worldViews?: SplatInput['worldViews'] }): SplatInput => ({
      engine,
      ...(input.subject ? { subject: input.subject } : {}),
      ...(sources.imageUrl ? { imageUrl: sources.imageUrl } : {}),
      ...(sources.videoUrl ? { videoUrl: sources.videoUrl } : {}),
      ...(sources.worldViews?.length ? { worldViews: sources.worldViews } : {}),
      ...(input.sameSpace ? { reconstructImages: true } : {}),
      ...(input.prompt ? { prompt: input.prompt } : {}),
      ...(fromPrompt ? { imageFromPrompt: true } : {}),
      ...(input.seed !== undefined ? { seed: input.seed } : {}),
      ...(input.title ? { title: input.title } : {}),
      ...(input.tag?.length ? { tags: input.tag } : {}),
      ...(input.visibility ? { availability: input.visibility } : {}),
    })
    const draft = buildSplatRequest(base({
      ...(input.image || fromPrompt ? { imageUrl: PLACEHOLDER } : {}),
      ...(input.video ? { videoUrl: 'https://placeholder.invalid/clip.mp4' } : {}),
      worldViews: views.map((v) => ({ azimuth: v.azimuth, imageUrl: PLACEHOLDER })),
    }))
    if (!draft.ok) failOnProblems(draft.problems)
    const limits = await planLimits(client)
    if (limits) {
      const problems = checkEntitlements(draft.request, limits)
      if (problems.length) failOnProblems(problems, 'Your plan does not allow this')
    }
    for (const warning of draft.warnings) ctx.out.warn(warning)

    return runPaidJob(ctx, client, {
      what: `${SPLAT_ENGINES[engine].label} ${input.video ? 'from video' : fromPrompt ? 'from a prompt' : 'from pictures'}`,
      request: draft.request as unknown as Record<string, unknown>,
      quote: draft.quote,
      flags: input,
      ...(input.format ? { formats: input.format } : {}),
      prepare: async () => {
        const sources: { imageUrl?: string; videoUrl?: string; worldViews?: SplatInput['worldViews'] } = {}
        if (fromPrompt) {
          ctx.out.progress({ stage: 'image', message: 'Making a picture from the prompt…' })
          const request = imageForPromptRequest(input.prompt!, { subject: input.subject ?? 'environment' })
          const result = await client.images.generate(request.body, crypto.randomUUID())
          const image = result.images[0]
          if (!image) throw new ZettaError({ code: 'IMAGE_GEN_NO_IMAGE', message: 'No picture came back for the prompt.' })
          sources.imageUrl = (await client.uploads.upload(new Blob([fromBase64(image.base64) as BlobPart], { type: image.contentType }), { contentType: image.contentType })).fileUrl
        }
        if (input.image) sources.imageUrl = (await resolvePicture(ctx, client, input.image, { label: 'the picture' })).url
        if (input.video) sources.videoUrl = isUrl(input.video) ? input.video : (await uploadLocal(ctx, client, input.video, 'video')).fileUrl
        if (views.length) {
          sources.worldViews = []
          for (const view of views) {
            sources.worldViews.push({ azimuth: view.azimuth, imageUrl: (await resolvePicture(ctx, client, view.source, { label: `the ${view.azimuth ?? 'extra'}° view` })).url })
          }
        }
        const final = buildSplatRequest(base(sources))
        if (!final.ok) failOnProblems(final.problems)
        return final.request as unknown as Record<string, unknown>
      },
    })
  },
  text: renderJob,
})

export const splatExport = defineCommand({
  path: ['splat', 'export'],
  summary: 'Export a splat world as a PLY splat, a mesh, or a collider mesh.',
  kind: 'spend',
  positionals: [{ name: 'id', required: true }],
  input: z.object({
    id: z.number().int().positive().describe('A Zetta Splat 2 / 2.1 world in your library.'),
    as: z.enum(['splat', 'mesh', 'collider']).describe('What to export.'),
    resolution: z.enum(WORLD_SPLAT_RESOLUTIONS).optional().describe('With --as splat: how many splats (default full_res).'),
    meshVariant: z.enum(WORLD_MESH_VARIANTS).optional().describe('With --as mesh: textured (default) or vertex_colored.'),
    title: z.string().max(200).optional().describe('Title of the export.'),
    format: z.array(z.string()).optional().describe('With --out: only these formats.'),
    ...spendShape,
    ...waitShape,
  }),
  examples: ['zetta splat export 1234 --as collider --yes --out ./unity/Assets'],
  async run(ctx, input) {
    const client = await ctx.client()
    const { generation } = await client.generations.get(input.id)
    const engine = generation.selectedModel === 'zs21' ? 'zs21' : generation.selectedModel === 'zs2' ? 'zs2' : undefined
    const built = buildWorldExportRequest({
      sourcePostId: input.id,
      kind: input.as,
      ...(input.resolution ? { splatResolution: input.resolution } : {}),
      ...(input.meshVariant ? { meshVariant: input.meshVariant } : {}),
      ...(engine ? { engine } : {}),
      ...(input.title ? { title: input.title } : {}),
    })
    if (!built.ok) failOnProblems(built.problems)
    return runPaidJob(ctx, client, {
      what: `World ${input.as} export`,
      request: built.request as unknown as Record<string, unknown>,
      quote: built.quote,
      flags: input,
      ...(input.format ? { formats: input.format } : {}),
    })
  },
  text: renderJob,
})

export const splatCommands = [splatCreate, splatExport]
