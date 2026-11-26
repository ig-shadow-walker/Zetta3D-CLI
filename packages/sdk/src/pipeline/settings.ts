/**
 * A NODE'S SETTINGS — the editor's defaults for each kind, and the conversion between the friendly
 * document's values and the raw values the graph stores.
 */
import { NODE_KINDS, isNodeKind, type SettingChoice, type SettingSpec } from './catalogue'
import { DEFAULT_FORM, applyFormPatch, type GenerateForm } from './generate-form'
import {
  DEFAULT_AUTO_RIG_SETTINGS,
  DEFAULT_ISOLATE_SETTINGS,
  DEFAULT_RETOPOLOGY_SETTINGS,
  DEFAULT_RIG_SPEC,
  DEFAULT_SEGMENT_SETTINGS,
  DEFAULT_SMART_UV_SETTINGS,
  DEFAULT_SPLAT_SETTINGS,
  DEFAULT_TEXTURE_SETTINGS,
  isKnownRigSpec,
} from './tool-settings'
import { VIEW_TYPES, type NodeKind, type PipelineNode } from './types'

type Settings = Record<string, unknown>

/** The settings a new step of this kind opens on — the editor's `defaultSettings`. */
export function defaultSettings(kind: string): Settings {
  switch (kind) {
    case 'seed_picture':
      return { source: null }
    case 'seed_model':
    case 'seed_views':
      return {}
    case 'ai_edit':
      return { prompt: '', model: null, for3D: true }
    case 'draw_views':
      return { views: ['back', 'left', 'right'] }
    case 'isolate_parts':
      return { ...DEFAULT_ISOLATE_SETTINGS, extraParts: [] }
    case 'generate_3d':
    case 'generate_3d_multiview':
      // A spread, not a patch: the count stays the form's 200,000, which reads as a custom count on
      // Zetta N2.5 — exactly as a new node in the web editor does.
      return { ...DEFAULT_FORM, model: 'n25' }
    case 'generate_smart_3d':
    case 'generate_smart_3d_multiview':
      return { ...applyFormPatch({ ...DEFAULT_FORM }, { model: 'np1' }) }
    case 'generate_splat':
      return { ...DEFAULT_SPLAT_SETTINGS, title: '' }
    case 'retopology':
      return { ...DEFAULT_RETOPOLOGY_SETTINGS }
    case 'segmentation':
      return { ...DEFAULT_SEGMENT_SETTINGS }
    case 'smart_segmentation':
      return { ...DEFAULT_SEGMENT_SETTINGS, mode: 'smart' }
    case 'texture':
      return { ...DEFAULT_TEXTURE_SETTINGS, prompt: '' }
    case 'texture_multiview':
      return { ...DEFAULT_TEXTURE_SETTINGS, prompt: '', referenceViews: {} }
    case 'smart_uv':
      return { ...DEFAULT_SMART_UV_SETTINGS }
    case 'rigging':
      return { ...DEFAULT_AUTO_RIG_SETTINGS }
    case 'export':
      return { format: 'glb' }
    default:
      return {}
  }
}

/** The four generate steps, which share the Studio's Generate form. */
export function isGenerateKind(
  kind: string,
): kind is 'generate_3d' | 'generate_smart_3d' | 'generate_3d_multiview' | 'generate_smart_3d_multiview' {
  return kind === 'generate_3d' || kind === 'generate_smart_3d' || kind === 'generate_3d_multiview' || kind === 'generate_smart_3d_multiview'
}

/**
 * Settings that name only what they change, over the editor's defaults — the editor's
 * `settingsWithDefaults` (how it opens a graph the in-app agent drafted). The generate form goes
 * through `applyFormPatch`, so a named engine settles its coupled options as picking it does.
 */
export function settingsWithDefaults(kind: string, settings: Settings | undefined): Settings {
  const defaults = defaultSettings(kind)
  if (!settings) return defaults
  if (isGenerateKind(kind)) {
    return { ...applyFormPatch(defaults as unknown as GenerateForm, settings as Partial<GenerateForm>) }
  }
  return { ...defaults, ...settings }
}

/** A node's settings as its request builder reads them: the defaults under whatever it holds (a plain spread). */
export function effectiveSettings(node: Pick<PipelineNode, 'kind' | 'settings'>): Settings {
  return { ...defaultSettings(node.kind), ...node.settings }
}

/* ---------------------------------------------------------------- friendly <-> raw values */

function choiceFor(spec: SettingSpec, value: string): SettingChoice | null {
  const wanted = value.toLowerCase()
  return (
    spec.choices?.find(
      (choice) =>
        choice.value.toLowerCase() === wanted ||
        (choice.raw ?? choice.value).toLowerCase() === wanted ||
        (choice.aliases ?? []).some((alias) => alias.toLowerCase() === wanted),
    ) ?? null
  )
}

function choiceForRaw(spec: SettingSpec, raw: unknown): SettingChoice | null {
  return spec.choices?.find((choice) => (choice.raw ?? choice.value) === raw) ?? null
}

/** The friendly values a choice setting offers (a retired engine is still read, but not offered). */
export function choiceValues(spec: SettingSpec): string[] {
  return (spec.choices ?? []).filter((choice) => !choice.retired).map((choice) => choice.value)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export type ValueResult = { ok: true; value: unknown } | { ok: false; message: string }

/** A picture given in a document or on the command line, as the graph stores it, or null when it is not one. */
function pictureValue(value: unknown, extra: readonly string[] = []): Record<string, unknown> | null {
  if (!isRecord(value)) return null
  const keys = Object.keys(value)
  const allowed = (key: string, own: string) => key === own || key === 'name' || extra.includes(key)
  if (value.name !== undefined && typeof value.name !== 'string') return null
  const name = typeof value.name === 'string' ? { name: value.name } : {}
  if (typeof value.uploadKey === 'string' && value.uploadKey !== '') {
    return keys.every((key) => allowed(key, 'uploadKey')) ? { uploadKey: value.uploadKey, ...name } : null
  }
  if (typeof value.gen2dPostId === 'number' && Number.isInteger(value.gen2dPostId) && value.gen2dPostId > 0) {
    return keys.every((key) => allowed(key, 'gen2dPostId')) ? { gen2dPostId: value.gen2dPostId, ...name } : null
  }
  return null
}

/**
 * Pictures of each side as the editor stores them (`{ front: { uploadKey, name? }, back: … }`) —
 * known sides only, each a picture, the front required unless the set is empty (none given).
 */
function viewSetValue(spec: SettingSpec, value: unknown, stored: boolean): ValueResult {
  const shape = `${spec.name} is { front: picture, back?, left?, right? } — each { uploadKey, name? } or { gen2dPostId } — with a front.`
  if (!isRecord(value)) return { ok: false, message: shape }
  const out: Record<string, unknown> = {}
  for (const [side, picture] of Object.entries(value)) {
    if (!(VIEW_TYPES as readonly string[]).includes(side)) {
      return { ok: false, message: `${spec.name} names sides ${VIEW_TYPES.join(', ')} only.` }
    }
    // The editor keeps a preview next to each picture; it is never sent, and never written in a document.
    const parsed = pictureValue(picture, stored ? ['thumbnail'] : [])
    if (!parsed) return { ok: false, message: shape }
    out[side] = parsed
  }
  if (Object.keys(out).length && !out.front) return { ok: false, message: `${spec.name} needs a front picture.` }
  // In the slots' order, as the editor keeps them.
  return { ok: true, value: Object.fromEntries(VIEW_TYPES.filter((side) => side in out).map((side) => [side, out[side]])) }
}

/**
 * A friendly value as the graph stores it, or why it is not one this setting takes. Messages never
 * repeat the value that was refused.
 */
export function toRawValue(spec: SettingSpec, value: unknown): ValueResult {
  if (value === null) {
    return spec.nullable ? { ok: true, value: null } : { ok: false, message: `${spec.name} cannot be null.` }
  }
  switch (spec.type) {
    case 'boolean':
      return typeof value === 'boolean' ? { ok: true, value } : { ok: false, message: `${spec.name} must be true or false.` }
    case 'string':
    case 'text': {
      if (typeof value !== 'string') return { ok: false, message: `${spec.name} must be a string.` }
      if (spec.maxLength !== undefined && value.length > spec.maxLength) {
        return { ok: false, message: `${spec.name} is longer than ${spec.maxLength} characters.` }
      }
      return { ok: true, value }
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        return { ok: false, message: `${spec.name} must be a whole number.` }
      }
      if ((spec.min !== undefined && value < spec.min) || (spec.max !== undefined && value > spec.max)) {
        const range = spec.max !== undefined ? `between ${spec.min ?? 0} and ${spec.max}` : `at least ${spec.min}`
        return { ok: false, message: `${spec.name} must be ${range}.` }
      }
      return { ok: true, value: spec.rawAsString ? String(value) : value }
    }
    case 'enum': {
      const choice = typeof value === 'string' ? choiceFor(spec, value) : null
      if (!choice) return { ok: false, message: `${spec.name} must be one of: ${choiceValues(spec).join(', ')}.` }
      return { ok: true, value: choice.raw ?? choice.value }
    }
    case 'enum-list': {
      if (!Array.isArray(value)) return { ok: false, message: `${spec.name} must be a list of: ${choiceValues(spec).join(', ')}.` }
      const raw: string[] = []
      for (const item of value) {
        const choice = typeof item === 'string' ? choiceFor(spec, item) : null
        if (!choice) return { ok: false, message: `${spec.name} must be a list of: ${choiceValues(spec).join(', ')}.` }
        const stored = choice.raw ?? choice.value
        if (!raw.includes(stored)) raw.push(stored)
      }
      return { ok: true, value: raw }
    }
    case 'string-list': {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        return { ok: false, message: `${spec.name} must be a list of strings.` }
      }
      if (spec.maxItems !== undefined && value.length > spec.maxItems) {
        return { ok: false, message: `${spec.name} holds at most ${spec.maxItems} entries.` }
      }
      if (spec.maxLength !== undefined && value.some((item: string) => item.length > spec.maxLength!)) {
        return { ok: false, message: `Each of ${spec.name} is at most ${spec.maxLength} characters.` }
      }
      return { ok: true, value: [...value] }
    }
    case 'picture': {
      const picture = pictureValue(value)
      return picture ? { ok: true, value: picture } : { ok: false, message: `${spec.name} must be { uploadKey, name? } or { gen2dPostId }.` }
    }
    case 'view-set':
      return viewSetValue(spec, value, false)
  }
}

/** A stored value as the friendly document writes it, or null when it is not one this setting knows. */
export function toFriendlyValue(spec: SettingSpec, raw: unknown): { value: unknown } | null {
  if (raw === null) return spec.nullable ? { value: null } : null
  switch (spec.type) {
    case 'boolean':
      return typeof raw === 'boolean' ? { value: raw } : null
    case 'string':
    case 'text':
      return typeof raw === 'string' ? { value: raw } : null
    case 'integer': {
      if (spec.rawAsString) {
        // Only a plain whole number written as one: '9000', not '1e4', ' 9000' or ''.
        if (typeof raw !== 'string') return null
        const parsed = Number(raw)
        return Number.isInteger(parsed) && String(parsed) === raw ? { value: parsed } : null
      }
      return typeof raw === 'number' && Number.isInteger(raw) ? { value: raw } : null
    }
    case 'enum': {
      const choice = choiceForRaw(spec, raw)
      return choice ? { value: choice.value } : null
    }
    case 'enum-list': {
      if (!Array.isArray(raw)) return null
      const values: string[] = []
      for (const item of raw) {
        const choice = choiceForRaw(spec, item)
        if (!choice) return null
        values.push(choice.value)
      }
      return { value: values }
    }
    case 'string-list':
      return Array.isArray(raw) && raw.every((item) => typeof item === 'string') ? { value: [...raw] } : null
    case 'picture': {
      if (!isRecord(raw)) return null
      if (typeof raw.uploadKey === 'string' && raw.uploadKey !== '') {
        return { value: { uploadKey: raw.uploadKey, ...(typeof raw.name === 'string' ? { name: raw.name } : {}) } }
      }
      if (typeof raw.gen2dPostId === 'number') {
        return { value: { gen2dPostId: raw.gen2dPostId, ...(typeof raw.name === 'string' ? { name: raw.name } : {}) } }
      }
      return null
    }
    case 'view-set': {
      const read = viewSetValue(spec, raw, true)
      return read.ok ? { value: read.value } : null
    }
  }
}

/* -------------------------------------------------------------------- loaded settings */

/** A warning about a loaded setting. `field` is the friendly name. */
export interface SettingNote {
  code: 'UNKNOWN_VALUE' | 'RIG_SPEC_REPLACED'
  field: string
  message: string
}

export const RIG_SPEC_REPLACED_MESSAGE = 'Unknown bone-naming value replaced with standard.'

/**
 * Whether a stored value is one the setting knows. Values are never repeated in the notes: a value
 * this SDK does not know could be anything.
 */
export function settingNotes(kind: string, settings: Settings | undefined): SettingNote[] {
  if (!isNodeKind(kind) || !settings) return []
  const notes: SettingNote[] = []
  for (const spec of NODE_KINDS[kind].settings) {
    if (!(spec.key in settings)) continue
    const raw = settings[spec.key]
    if (raw === undefined) continue
    if (kind === 'rigging' && spec.key === 'spec') {
      if (!isKnownRigSpec(raw)) notes.push({ code: 'RIG_SPEC_REPLACED', field: spec.name, message: RIG_SPEC_REPLACED_MESSAGE })
      continue
    }
    if (toFriendlyValue(spec, raw) === null && !(spec.rawAsString && typeof raw === 'string')) {
      notes.push({
        code: 'UNKNOWN_VALUE',
        field: spec.name,
        message: `${spec.name} holds a value this version does not know; it is kept as it is.`,
      })
    }
  }
  return notes
}

/** Settings with a bone naming the Studio does not offer replaced by `standard`. Other values are untouched. */
export function withKnownRigSpec(kind: NodeKind | string, settings: Settings | undefined): { settings: Settings | undefined; replaced: boolean } {
  if (kind !== 'rigging' || !settings || !('spec' in settings) || isKnownRigSpec(settings.spec)) {
    return { settings, replaced: false }
  }
  return { settings: { ...settings, spec: DEFAULT_RIG_SPEC }, replaced: true }
}

/** A raw rigging request with a bone naming the Studio does not offer taken out (no `rigSpec` is `standard`). */
export function withKnownRigSpecRequest(
  kind: NodeKind | string,
  request: Settings | undefined,
): { request: Settings | undefined; replaced: boolean } {
  if (kind !== 'rigging' || !request || !('rigSpec' in request) || isKnownRigSpec(request.rigSpec)) {
    return { request, replaced: false }
  }
  const { rigSpec: _dropped, ...rest } = request
  return { request: rest, replaced: true }
}
