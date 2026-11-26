/**
 * THE FRIENDLY DOCUMENT, DESCRIBED — a JSON Schema an agent can be shown, and three worked examples.
 *
 * The envelope is written out here; each kind's step is spelt from the catalogue, so a setting added
 * there is described here too and the two cannot disagree.
 */
import { NODE_KINDS, type NodeKindSpec, type SettingSpec } from './catalogue'
import type { PipelineDoc } from './doc'
import { ALL_NODE_KINDS, VIEW_TYPES } from './types'

type Json = Record<string, unknown>

/** The choices a document is offered: a retired engine is still read, but never suggested. */
const offeredChoices = (spec: SettingSpec) => (spec.choices ?? []).filter((choice) => !choice.retired)

function choicesText(spec: SettingSpec): string {
  if (!spec.choices) return ''
  const described = offeredChoices(spec).filter((choice) => choice.description || choice.label !== choice.value)
  if (!described.length) return ''
  return (
    ' Values: ' +
    described
      .map((choice) => `${choice.value} — ${choice.label}${choice.description ? `: ${choice.description}` : ''}`)
      .join('; ') +
    '.'
  )
}

function settingSchema(spec: SettingSpec): Json {
  const description = spec.description + choicesText(spec) + (spec.nullable ? ' null: not chosen.' : '')
  const withDefault = (schema: Json): Json => (spec.default === undefined ? schema : { ...schema, default: spec.default })
  switch (spec.type) {
    case 'boolean':
      return withDefault({ type: 'boolean', description })
    case 'string':
    case 'text':
      return withDefault({
        type: spec.nullable ? ['string', 'null'] : 'string',
        ...(spec.maxLength !== undefined ? { maxLength: spec.maxLength } : {}),
        description,
      })
    case 'integer':
      return withDefault({
        type: 'integer',
        ...(spec.min !== undefined ? { minimum: spec.min } : {}),
        ...(spec.max !== undefined ? { maximum: spec.max } : {}),
        description,
      })
    case 'enum':
      return withDefault({
        enum: [...offeredChoices(spec).map((choice) => choice.value), ...(spec.nullable ? [null] : [])],
        description,
      })
    case 'enum-list':
      return withDefault({
        type: 'array',
        items: { enum: offeredChoices(spec).map((choice) => choice.value) },
        uniqueItems: true,
        description,
      })
    case 'string-list':
      return withDefault({
        type: 'array',
        items: { type: 'string', ...(spec.maxLength !== undefined ? { maxLength: spec.maxLength } : {}) },
        ...(spec.maxItems !== undefined ? { maxItems: spec.maxItems } : {}),
        description,
      })
    case 'picture':
      return {
        anyOf: [{ $ref: '#/$defs/picture' }, ...(spec.nullable ? [{ type: 'null' }] : [])],
        description,
      }
    case 'view-set':
      return withDefault({ $ref: '#/$defs/viewSet', description })
  }
}

function stepSchema(spec: NodeKindSpec): Json {
  const properties: Json = {
    kind: { const: spec.kind },
    ...(spec.inputs.length ? { from: { $ref: '#/$defs/from' } } : {}),
    label: { type: 'string', maxLength: 80, description: 'A name shown on the canvas.' },
    settings: {
      type: 'object',
      description: 'Raw editor settings, applied as they are after the friendly ones. Rarely needed.',
    },
    request: {
      type: 'object',
      description: 'A raw API request used as it is instead of one built from the settings. Rarely needed.',
    },
  }
  for (const setting of spec.settings) properties[setting.name] = settingSchema(setting)
  const outputs = [
    ...spec.outputs.map((output) => `${output.handle} (${output.type}${output.description ? `: ${output.description}` : ''})`),
    ...(spec.dynamicOutputs ? [`${spec.dynamicOutputs.prefix}<key> (${spec.dynamicOutputs.type}: ${spec.dynamicOutputs.description})`] : []),
  ]
  const inputs = spec.inputs
    .filter((input) => !input.legacy)
    .map((input) => `${input.handle} takes ${input.accepts.join(' or ')}`)
  return {
    type: 'object',
    title: spec.label,
    description:
      `${spec.description}` +
      (inputs.length ? ` Input: ${inputs.join('; ')}.` : '') +
      ` Outputs: ${outputs.join('; ')}.` +
      (spec.runInput.kind !== 'none' ? ` Per run: ${spec.runInput.description}` : '') +
      (spec.legacy ? ' Legacy: still runs, no longer offered — prefer the offered kinds.' : ''),
    ...(spec.legacy ? { deprecated: true } : {}),
    required: spec.inputs.some((input) => input.required) ? ['kind', 'from'] : ['kind'],
    properties,
    additionalProperties: false,
  }
}

const STEP_REF = {
  type: 'string',
  pattern: '^[A-Za-z0-9_-]{1,64}(\\.(out|character|each|part:[^.]+))?$',
  description:
    'A step id ("photo"), or "<id>.<output>" for a step with several outputs: "iso.character", "iso.each", "iso.part:sword".',
}

/** A JSON Schema (draft 2020-12) of the friendly pipeline document. */
export const PIPELINE_DOC_JSON_SCHEMA: Json = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Zetta 3D pipeline',
  description:
    'A 3D pipeline: steps keyed by id, each a Studio tool, wired from ONE seed step (seed_picture, seed_model or seed_views). ' +
    'Each step names the step it follows in `from`. Settings are written inline; anything left out keeps the ' +
    'Studio default. The pipeline keeps no seed asset: each run is given its picture, its model, or its pictures of each side. Typical chains: ' +
    'seed_picture → remove_background → generate_3d → retopology → rigging; ' +
    'seed_picture → isolate_parts → (character) draw_views → generate_3d_multiview and (each) generate_smart_3d; ' +
    'seed_views → generate_smart_3d_multiview → texture_multiview (views from the seed); ' +
    'seed_model → retopology → smart_uv → texture. One picture goes to generate_3d / generate_smart_3d; ' +
    'pictures of each side (seed_views, draw_views) only to the *_multiview steps.',
  type: 'object',
  required: ['steps'],
  additionalProperties: false,
  properties: {
    version: { const: 1, description: 'The document format version.' },
    title: { type: 'string', maxLength: 200, description: 'The pipeline’s name.' },
    steps: {
      type: 'object',
      minProperties: 1,
      maxProperties: 200,
      description: 'The steps, keyed by id (letters, digits, "_" and "-"). Exactly one is a seed.',
      propertyNames: { pattern: '^[A-Za-z0-9_-]{1,64}$' },
      additionalProperties: { $ref: '#/$defs/step' },
    },
    layout: {
      type: 'object',
      description: 'Optional canvas positions by step id; steps not listed are laid out left to right.',
      additionalProperties: { $ref: '#/$defs/position' },
    },
  },
  $defs: {
    stepRef: STEP_REF,
    from: {
      description:
        'The step this one follows: a step reference for its main input, a list for its inputs in order, or an object by input name.',
      anyOf: [
        { $ref: '#/$defs/stepRef' },
        { type: 'array', items: { $ref: '#/$defs/stepRef' }, minItems: 1 },
        {
          type: 'object',
          additionalProperties: {
            anyOf: [{ $ref: '#/$defs/stepRef' }, { type: 'array', items: { $ref: '#/$defs/stepRef' } }],
          },
        },
      ],
    },
    position: {
      type: 'object',
      required: ['x', 'y'],
      properties: { x: { type: 'number' }, y: { type: 'number' } },
      additionalProperties: false,
    },
    picture: {
      description: 'A picture: an upload (the key the upload relay returned) or a picture from the Image library.',
      oneOf: [
        {
          type: 'object',
          required: ['uploadKey'],
          properties: { uploadKey: { type: 'string', minLength: 1 }, name: { type: 'string' } },
          additionalProperties: false,
        },
        {
          type: 'object',
          required: ['gen2dPostId'],
          properties: { gen2dPostId: { type: 'integer', minimum: 1 }, name: { type: 'string' } },
          additionalProperties: false,
        },
      ],
    },
    viewSet: {
      description: 'Pictures of each side, the front at least. Empty ({}) means none given.',
      type: 'object',
      properties: Object.fromEntries(VIEW_TYPES.map((side) => [side, { $ref: '#/$defs/picture' }])),
      additionalProperties: false,
    },
    step: {
      description: 'One step. `kind` decides which settings it takes.',
      oneOf: ALL_NODE_KINDS.map((kind) => ({ $ref: `#/$defs/${kind}` })),
    },
    ...Object.fromEntries(ALL_NODE_KINDS.map((kind) => [kind, stepSchema(NODE_KINDS[kind])])),
  },
}

export interface PipelineDocExample {
  name: string
  description: string
  doc: PipelineDoc
}

/** Four realistic documents, each one that compiles and validates. */
export const PIPELINE_DOC_EXAMPLES: readonly PipelineDocExample[] = [
  {
    name: 'picture-to-rigged-character',
    description:
      'A character picture, cut out, made into a textured model on Zetta N2.5, rebuilt at a clean 10,000 polygons and rigged as a humanoid FBX.',
    doc: {
      version: 1,
      title: 'Picture to rigged character',
      steps: {
        photo: { kind: 'seed_picture' },
        clean: { kind: 'remove_background', from: 'photo' },
        model: { kind: 'generate_3d', from: 'clean', engine: 'n25', quality: 'high', output: 'textured', removeBackground: false },
        topo: { kind: 'retopology', from: 'model', engine: 'r1', faces: 10000 },
        rig: { kind: 'rigging', from: 'topo', rigType: 'biped', rigSpec: 'standard', format: 'fbx' },
      },
    },
  },
  {
    name: 'character-and-props',
    description:
      'A character holding props, split apart: the character (A-posed, hands empty) drawn from three sides, made into one multi-view model ' +
      'and rigged for Mixamo; every prop made on its own as a clean low-poly model with a fresh UV layout.',
    doc: {
      version: 1,
      title: 'Character and props',
      steps: {
        photo: { kind: 'seed_picture' },
        split: { kind: 'isolate_parts', from: 'photo', sensitivity: 'low', pose: 'a', maxParts: 4 },
        views: { kind: 'draw_views', from: 'split.character' },
        hero: { kind: 'generate_3d_multiview', from: 'views', engine: 'n25', quality: 'high' },
        heroRig: { kind: 'rigging', from: 'hero', rigType: 'biped', rigSpec: 'mixamo', format: 'fbx' },
        props: { kind: 'generate_smart_3d', from: 'split.each', engine: 'np15', polygonCount: 8000 },
        propsUv: { kind: 'smart_uv', from: 'props' },
      },
    },
  },
  {
    name: 'remesh-and-retexture',
    description:
      'A model from the library rebuilt in quads, given a new UV layout, then retextured in detail — each run describes the texture it wants.',
    doc: {
      version: 1,
      title: 'Remesh and retexture',
      steps: {
        source: { kind: 'seed_model' },
        topo: { kind: 'retopology', from: 'source', engine: 'r1', faces: 8000, polygonType: 'quad' },
        uv: { kind: 'smart_uv', from: 'topo' },
        paint: { kind: 'texture', from: 'uv', tier: 'detailed' },
      },
    },
  },
  {
    name: 'product-from-photos-of-each-side',
    description:
      'Each run gives photos of a product from each side (front required; back, left, right as you have them): one clean multi-view ' +
      'model on Zetta Np1.5, retextured in detail from the same photos, with a fresh UV layout.',
    doc: {
      version: 1,
      title: 'Product from photos of each side',
      steps: {
        photos: { kind: 'seed_views' },
        model: { kind: 'generate_smart_3d_multiview', from: 'photos', engine: 'np15', polygonCount: 12000 },
        paint: { kind: 'texture_multiview', from: { in: 'model', views: 'photos' }, tier: 'detailed' },
        uv: { kind: 'smart_uv', from: 'paint' },
      },
    },
  },
]
