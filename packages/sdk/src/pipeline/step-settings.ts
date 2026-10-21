/**
 * A STEP'S SETTINGS FROM ITS FRIENDLY FIELDS — shared by `compilePipeline` and `runNodeChange`.
 *
 * Friendly values become raw ones through the catalogue. The generate form is patched in the order a
 * person would click it — engine, rung, topology, the rest, then the polygon count — so each change
 * settles its coupled options as it does in the Studio, and an explicit count always wins. Raw
 * `settings` are applied last, as they are.
 */
import { NODE_KINDS, settingSpec, type SettingSpec } from './catalogue'
import { applyFormPatch, capabilitiesOf, type GenerateForm } from './generate-form'
import {
  RIG_SPEC_REPLACED_MESSAGE,
  defaultSettings,
  isGenerateKind,
  toFriendlyValue,
  toRawValue,
  withKnownRigSpec,
} from './settings'
import { DEFAULT_RIG_SPEC } from './tool-settings'
import type { NodeKind } from './types'

type Settings = Record<string, unknown>

export interface StepSettingsResult {
  settings: Settings
  /** Fields that could not be used: unknown names, values a setting does not take. */
  problems: Array<{ code: 'UNKNOWN_SETTING' | 'SETTING_INVALID'; field: string; message: string }>
  /** Things worth saying: a value the engine's rules changed, a bone naming replaced. */
  notes: string[]
}

/** Generate fields in the order a person would set them. */
const GENERATE_STAGES: ReadonlyArray<readonly string[]> = [['model'], ['quality'], ['polygonType']]

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]))
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a as Settings).filter((key) => (a as Settings)[key] !== undefined)
    const kb = Object.keys(b as Settings).filter((key) => (b as Settings)[key] !== undefined)
    return ka.length === kb.length && ka.every((key) => deepEqual((a as Settings)[key], (b as Settings)[key]))
  }
  return false
}

export { deepEqual }

function describe(spec: SettingSpec, raw: unknown): string {
  const friendly = toFriendlyValue(spec, raw)
  if (!friendly) return 'another value'
  const value = friendly.value
  return Array.isArray(value) ? value.join(', ') : String(value)
}

/**
 * The settings a step's friendly fields (and raw `settings`) make, over `base` — the kind's defaults
 * for a new step, or a step's current settings for a change.
 */
export function buildStepSettings(
  kind: NodeKind,
  fields: Settings,
  raw: Settings | undefined,
  base: Settings = defaultSettings(kind),
): StepSettingsResult {
  const problems: StepSettingsResult['problems'] = []
  const notes: string[] = []
  const patch: Settings = {}
  const asked: Array<{ spec: SettingSpec; value: unknown }> = []

  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue
    const spec = settingSpec(kind, name)
    if (!spec) {
      const names = NODE_KINDS[kind].settings.map((setting) => setting.name)
      problems.push({
        code: 'UNKNOWN_SETTING',
        field: name,
        message: names.length
          ? `${kind} has no setting "${name}". Its settings: ${names.join(', ')}.`
          : `${kind} has no settings.`,
      })
      continue
    }
    const converted = toRawValue(spec, value)
    if (!converted.ok) {
      if (kind === 'rigging' && spec.key === 'spec') {
        // Any bone naming but the two the Studio offers is treated as standard — never refused, never repeated.
        patch[spec.key] = DEFAULT_RIG_SPEC
        notes.push(RIG_SPEC_REPLACED_MESSAGE)
        continue
      }
      problems.push({ code: 'SETTING_INVALID', field: name, message: converted.message })
      continue
    }
    patch[spec.key] = converted.value
    asked.push({ spec, value: converted.value })
  }

  let settings: Settings
  if (isGenerateKind(kind)) {
    let form = { ...base } as unknown as GenerateForm
    const remaining = { ...patch }
    for (const stage of GENERATE_STAGES) {
      const part: Settings = {}
      for (const key of stage) {
        if (key in remaining) {
          part[key] = remaining[key]
          delete remaining[key]
        }
      }
      if (Object.keys(part).length) form = applyFormPatch(form, part as Partial<GenerateForm>)
    }
    const count = remaining.polygonCount
    delete remaining.polygonCount
    if (Object.keys(remaining).length) form = applyFormPatch(form, remaining as Partial<GenerateForm>)
    if (count !== undefined) form = applyFormPatch(form, { polygonCount: count as string })
    settings = { ...form }
  } else {
    settings = { ...base, ...patch }
  }

  if (raw) {
    const known = withKnownRigSpec(kind, raw)
    if (known.replaced) notes.push(RIG_SPEC_REPLACED_MESSAGE)
    settings = { ...settings, ...known.settings }
  }

  // Say where the Studio's rules moved a value away from what was asked.
  for (const { spec, value } of asked) {
    const final = settings[spec.key]
    if (raw && spec.key in raw) continue
    if (!deepEqual(final, value)) {
      const engine = isGenerateKind(kind) ? capabilitiesOf(settings.model)?.label : undefined
      notes.push(
        `${spec.name} is ${describe(spec, final)}, not ${describe(spec, value)}: ${engine ? `${engine}'s` : 'the tool’s'} rules changed it, as the Studio does.`,
      )
    }
  }
  return { settings, problems, notes }
}
