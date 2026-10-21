import { ENGINES, REFINE_TOOLS, SPLAT_ENGINES, type PriceListItem } from '@zetta3d/sdk'
import { z } from 'zod'
import { defineCommand } from '../core/define'
import { usageError } from '../core/errors'
import { engineLabel } from '../core/jobs'
import { table } from '../core/output'

export const catalogEngines = defineCommand({
  path: ['catalog', 'engines'],
  summary: 'The 3D, splat and image engines, and what each supports.',
  kind: 'read',
  auth: false,
  input: z.object({
    images: z.boolean().optional().describe('List the image engines available to your account instead (needs sign-in).'),
  }),
  async run(ctx, input) {
    if (input.images) {
      const { models } = await (await ctx.client()).catalog.imageModels()
      return { imageEngines: models.map((m) => ({ name: m.label.toLowerCase(), label: m.label, resolutions: m.resolutions, locked: Boolean(m.locked), lockedReason: m.lockedReason ?? null })) }
    }
    return {
      generate: Object.values(ENGINES).map((e) => ({
        id: e.id,
        flag: e.id === 'n25' ? 'n2.5' : e.id === 'np15' ? 'np1.5' : e.id,
        label: e.label,
        description: e.description,
        paidOnly: e.paidOnly,
        inputs: e.inputs,
        qualities: e.qualities,
        outputs: e.outputs,
        pbr: e.pbr,
        textureQualities: e.textureQualities,
        polygonTypes: e.polygonTypes,
        parts: e.parts,
        faceCounts: e.faceCounts,
        defaults: e.defaults,
      })),
      splat: Object.values(SPLAT_ENGINES).map((e) => ({ id: e.id, flag: e.id === 'n25' ? 'splat' : e.id === 'zs2' ? 'splat2' : 'splat2.1', label: e.label, description: e.description, video: e.video, worldViews: e.worldViews })),
      refine: Object.values(REFINE_TOOLS).map((t) => ({ tool: t.id, command: `zetta refine ${t.id}`, label: t.label, description: t.description, accepts: t.accepts, options: t.options })),
    }
  },
  text: (r: { generate?: Array<Record<string, unknown>>; splat?: Array<Record<string, unknown>>; refine?: Array<Record<string, unknown>>; imageEngines?: Array<Record<string, unknown>> }) => {
    if (r.imageEngines) return table(r.imageEngines, ['name', 'resolutions', 'locked'])
    return [
      '3D engines (zetta generate --engine <flag>):',
      table(r.generate!.map((e) => ({ flag: e.flag, label: e.label, paid: e.paidOnly ? 'paid plans' : 'all plans', about: e.description }))),
      '',
      'Splat engines (zetta splat create --engine <flag>):',
      table(r.splat!.map((e) => ({ flag: e.flag, label: e.label, about: e.description }))),
      '',
      'Finishing tools (zetta refine <tool>):',
      table(r.refine!.map((t) => ({ tool: t.tool, label: t.label, about: t.description }))),
      '',
      'Full detail (limits, defaults, options): zetta catalog engines --json',
    ].join('\n')
  },
})

export const catalogPricing = defineCommand({
  path: ['catalog', 'pricing'],
  summary: 'Credit price of every 3D option (1 credit = €0.01).',
  kind: 'read',
  input: z.object({}),
  async run(ctx) {
    const items = await (await ctx.client()).catalog.prices3d()
    return { items: items.map((item: PriceListItem) => ({ code: item.code, kind: item.kind, label: item.label, credits: item.credits, engine: item.model, engineLabel: engineLabel(item.model) })) }
  },
  text: (r: { items: Array<Record<string, unknown>> }) => table(r.items.map((i) => ({ ...i, engine: i.engineLabel ?? 'any' })), ['kind', 'code', 'label', 'engine', 'credits']),
})

export const catalogEntitlements = defineCommand({
  path: ['catalog', 'entitlements'],
  summary: 'What your plan allows: engines, multi-view, low-poly, quads, private models, concurrency.',
  kind: 'read',
  input: z.object({}),
  async run(ctx) {
    const client = await ctx.client()
    const [threeD, images] = await Promise.all([client.catalog.entitlements3d(), client.catalog.entitlements2d()])
    const e = threeD.entitlements as Record<string, unknown>
    const concurrency = e.concurrency as { total?: number | null } | undefined
    return {
      plan: threeD.plan,
      threeD: {
        engines: { n1: true, n25: Boolean(e.allowsZettaN25), np1: Boolean(e.allowsZettaNp1), np15: Boolean(e.allowsZettaNp1) },
        finishingTools: Boolean(e.allowsPostProcess),
        splat: Boolean(e.allowsSplat ?? e.allowsPrivateGenerations),
        privateModels: Boolean(e.allowsPrivateGenerations),
        maxMultiViewImages: e.maxMultiViewImages,
        lowPoly: Boolean(e.allowsLowPoly),
        quads: Boolean(e.allowsQuadMesh),
        customFaceCount: Boolean(e.allowsCustomFaceCount),
        maxFaceCount: e.maxFaceCount,
        maxConcurrentJobs: e.maxConcurrentJobs ?? concurrency?.total ?? null,
      },
      images: { editing: images.entitlements.allowsImageEditing, fourK: images.entitlements.allows4kImages, proEngine: images.entitlements.allowsProImageModel },
    }
  },
})

export const quote = defineCommand({
  path: ['quote'],
  summary: 'Price a raw operation spec (most people use --dry-run on the command instead).',
  description: 'Example: zetta quote --base textured --modifier pbr --engine n25. Codes are listed by `zetta catalog pricing`.',
  kind: 'read',
  input: z.object({
    base: z.string().optional().describe('Generation base code: geometry_only, textured, lowpoly, gaussian_splat.'),
    modifier: z.array(z.string()).optional().describe('Modifier codes, e.g. multi_view, pbr, detailed_texture.'),
    postProcess: z.array(z.string()).optional().describe('Finishing-tool codes, e.g. auto_rigging.'),
    engine: z.string().optional().describe('Engine id (n1, n25, np1, np15, r1, zs2, zs21).'),
  }),
  async run(ctx, input) {
    if (!input.base && !input.postProcess?.length) throw usageError('Give --base or --post-process.')
    const result = await (await ctx.client()).catalog.quote({
      ...(input.base ? { generation: { base: input.base, ...(input.modifier?.length ? { modifiers: input.modifier } : {}) } } : {}),
      ...(input.postProcess?.length ? { postProcess: input.postProcess } : {}),
      ...(input.engine ? { model: input.engine.replace('.', '') } : {}),
    })
    return result
  },
  text: (r: { credits: number; lines: Array<{ label: string; credits: number }> }) => [`${r.credits} credits`, ...r.lines.map((l) => `  ${l.label.padEnd(32)} ${l.credits}`)].join('\n'),
})

export const catalogCommands = [catalogEngines, catalogPricing, catalogEntitlements, quote]
