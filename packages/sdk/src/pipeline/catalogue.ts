/**
 * THE NODE CATALOGUE — every kind of step, what it takes and gives, and its settings in the friendly
 * document's words.
 *
 * Ports and rules mirror the backend's `NODE_SPECS` and the editor's palette. Each setting names the
 * editor `settings` key it is stored under (`key`) and, for a choice, the raw value stored for each
 * friendly one (`raw`), so a document can say `quality: high` where the graph holds `high-res`.
 */
import { ALL_NODE_KINDS, PART_HANDLE_PREFIX, type NodeKind, type PortType } from './types'

export type NodeGroup = 'seed' | 'picture' | 'make' | 'refine' | 'output'

export interface InputPortSpec {
  handle: string
  label: string
  accepts: readonly PortType[]
  required: boolean
  /** Still accepted by the server, but no longer offered by the editor (it drops such wires on load). */
  legacy?: boolean
}

export interface OutputPortSpec {
  handle: string
  label: string
  type: PortType
  description?: string
}

/**
 * How a step gets the input a run gives it:
 * - `seed`: the picture or model each run starts from (a batch seed);
 * - `always`: given on each run (AI texturing's description or picture);
 * - `when-asked`: given on each run when the step's `askAtRun` is on (AI edit's instruction);
 * - `none`: everything is in the recipe.
 */
export type RunInputKind = 'seed' | 'always' | 'when-asked' | 'none'

export type SettingType =
  /** A short string. */
  | 'string'
  /** Free text (a prompt, a description). */
  | 'text'
  | 'integer'
  | 'boolean'
  /** One of `choices`. */
  | 'enum'
  /** A list of distinct `choices`. */
  | 'enum-list'
  | 'string-list'
  /** A picture: `{ uploadKey, name? }` (an upload) or `{ gen2dPostId }` (an Image library picture). */
  | 'picture'

export interface SettingChoice {
  /** The friendly value a document writes. */
  value: string
  /** The value stored in the graph's settings, when it differs from `value`. */
  raw?: string
  label: string
  description?: string
  /** Other spellings accepted on input (matched case-insensitively, like `value`). */
  aliases?: readonly string[]
}

export interface SettingSpec {
  /** The friendly name a document writes. */
  name: string
  /** The editor settings key it is stored under. */
  key: string
  type: SettingType
  description: string
  /** The friendly default. Undefined for a setting whose default depends on others (`derived`). */
  default?: unknown
  choices?: readonly SettingChoice[]
  /** `null` is allowed and means "not chosen": the account's or the engine's own default. */
  nullable?: boolean
  min?: number
  max?: number
  maxLength?: number
  maxItems?: number
  /** Stored as a string holding the number (the generation's polygon count). */
  rawAsString?: boolean
  /** Its default follows other settings (the polygon count follows the engine, rung and topology). */
  derived?: boolean
}

export interface NodeKindSpec {
  kind: NodeKind
  label: string
  description: string
  group: NodeGroup
  /** Offered in the editor's palette. Kinds that are not still load, run and validate. */
  offered: boolean
  /** Loads and runs, but is no longer offered (`generate_splat`, `smart_segmentation`, `export`). */
  legacy: boolean
  /** A 3D job: queued, charged and watched. */
  threeD: boolean
  /** The step's tool has engines, and the step must name one. */
  engineChoice: boolean
  earlyAccess?: boolean
  inputs: readonly InputPortSpec[]
  outputs: readonly OutputPortSpec[]
  /** Isolate Parts' per-part outputs, `part:<key>` — one for each part a run identifies. */
  dynamicOutputs?: { prefix: string; type: PortType; description: string }
  settings: readonly SettingSpec[]
  runInput: { kind: RunInputKind; description: string }
}

/* ------------------------------------------------------------------------------ choices */

const BOOL = (name: string, description: string, def: boolean, key = name): SettingSpec => ({
  name,
  key,
  type: 'boolean',
  description,
  default: def,
})

const IMAGE_ENGINE: SettingSpec = {
  name: 'imageEngine',
  key: 'model',
  type: 'string',
  nullable: true,
  default: null,
  maxLength: 120,
  description:
    'The image engine id, one of those the Image Studio offers. Omit (or null) for the account’s default.',
}

const POLYGON_TYPES: readonly SettingChoice[] = [
  { value: 'triangle', label: 'Triangles', aliases: ['triangles', 'tri', 'tris'] },
  { value: 'quad', raw: 'quadrilateral', label: 'Quads', aliases: ['quads', 'quadrilateral'] },
]

function generateSettings(engines: readonly SettingChoice[], defaultEngine: string): SettingSpec[] {
  return [
    {
      name: 'engine',
      key: 'model',
      type: 'enum',
      choices: engines,
      default: defaultEngine,
      description: 'The engine that makes the mesh.',
    },
    {
      name: 'quality',
      key: 'quality',
      type: 'enum',
      default: 'high',
      choices: [
        {
          value: 'low',
          raw: 'low-poly',
          label: 'Low-poly',
          aliases: ['low-poly', 'lowpoly'],
          description: 'A low-poly mesh. Not on the Np engines, which build to a face budget (it becomes high).',
        },
        {
          value: 'high',
          raw: 'high-res',
          label: 'High-Res',
          aliases: ['high-res', 'highres'],
          description: 'The usual density. On Zetta N1, 200,000 polygons.',
        },
        {
          value: 'ultra',
          label: 'Ultra',
          description: 'The densest mesh. On Zetta N1, 1,000,000 polygons; on Zetta N2.5 a paid extra.',
        },
      ],
      description:
        'The mesh density rung. Choosing a rung fills the polygon count with its preset (the rung’s maximum on Zetta N2.5).',
    },
    {
      name: 'output',
      key: 'output',
      type: 'enum',
      default: 'textured',
      choices: [
        { value: 'textured', label: 'Textured' },
        { value: 'geometry', label: 'Geometry', aliases: ['geometry_only', 'untextured'], description: 'A bare mesh, no texture.' },
      ],
      description: 'A textured mesh or bare geometry.',
    },
    BOOL('pbr', 'PBR materials (a paid extra). Textured output only.', true, 'pbrMaterials'),
    {
      name: 'polygonCount',
      key: 'polygonCount',
      type: 'integer',
      rawAsString: true,
      derived: true,
      min: 1,
      description:
        'The polygon budget. Omit to use the rung’s preset. A count other than the preset is a paid extra. ' +
        'Bounds: Zetta N1 3,100–1,480,000; Zetta N2.5 per rung (low 1,000–20,000, high 1,000–1,000,000, ultra 1,000–2,000,000; ' +
        'quads 500–10,000 / 1,000–150,000); Zetta Np1 48–20,000; Zetta Np1.5 48–50,000 (quads 48–25,000). ' +
        'On Zetta N1 a count also moves the rung, as typing it in the Studio does.',
    },
    {
      name: 'polygonType',
      key: 'polygonType',
      type: 'enum',
      default: 'triangle',
      choices: POLYGON_TYPES,
      description: 'Triangles or quads. On Zetta N1 quads apply to the low rung only; Zetta Np1 has triangles only.',
    },
    BOOL('removeBackground', 'Cut the subject out of its background before generating.', true),
    {
      name: 'textureQuality',
      key: 'textureQuality',
      type: 'enum',
      default: 'standard',
      choices: [
        { value: 'standard', label: 'Standard' },
        { value: 'detailed', label: 'Detailed', aliases: ['hd'], description: 'Sharper textures (a paid extra).' },
        {
          value: 'extreme',
          label: '8K',
          aliases: ['8k'],
          description: 'The sharpest textures (a paid extra). Np engines only; elsewhere it becomes detailed.',
        },
      ],
      description: 'The texture’s quality band. Textured output only.',
    },
    BOOL(
      'segmentParts',
      'A mesh that arrives split into editable parts (a paid extra, Zetta N2.5). Forces geometry output and triangles; not on the low rung.',
      false,
    ),
    BOOL('realWorldScale', 'Scale to real-world metres. Engines with tuning options only.', false),
    {
      name: 'textureAlignment',
      key: 'textureAlignment',
      type: 'enum',
      default: 'mesh',
      choices: [
        { value: 'mesh', raw: 'geometry', label: 'Fit texture to mesh', aliases: ['geometry'] },
        { value: 'picture', raw: 'original_image', label: 'Fit texture to picture', aliases: ['original_image', 'image'] },
      ],
      description: 'When the picture and the mesh disagree, which the texture follows.',
    },
    BOOL('delight', 'Strip the picture’s baked-in lighting before it becomes a texture.', false),
    {
      name: 'availability',
      key: 'availability',
      type: 'enum',
      nullable: true,
      default: null,
      choices: [
        { value: 'private', label: 'Private' },
        { value: 'public', label: 'Public' },
      ],
      description: 'Who can see the finished model. Omit (or null) for the account’s default.',
    },
    BOOL('autofixImage', 'Pre-clean the picture before reconstructing. Slower.', false),
    BOOL('compressGeometry', 'Compress the geometry for a smaller file.', false),
    BOOL('exportUv', 'Unwrap UVs during generation. Off is faster and smaller.', true),
    {
      name: 'title',
      key: 'title',
      type: 'string',
      default: '',
      maxLength: 200,
      description: 'What the model is called. Empty: named after the run’s seed.',
    },
  ]
}

const SEGMENT_SETTINGS = (defaultMode: 'segment' | 'smart'): SettingSpec[] => [
  {
    name: 'mode',
    key: 'mode',
    type: 'enum',
    default: defaultMode,
    choices: [
      { value: 'segment', label: 'Segment', description: 'Splits the model you have into named parts.' },
      {
        value: 'smart',
        label: 'Smart Segment',
        description: 'Rebuilds as it splits, for cleaner parts on a rough or incomplete mesh.',
      },
    ],
    description: 'Which segmentation runs.',
  },
  {
    name: 'granularity',
    key: 'granularity',
    type: 'enum',
    default: 'balanced',
    choices: [
      { value: 'simple', label: 'Few parts', aliases: ['few'], description: 'Broad, obvious divisions.' },
      { value: 'balanced', label: 'Balanced' },
      { value: 'detailed', label: 'Max parts', aliases: ['max'], description: 'Finer, smaller pieces.' },
    ],
    description: 'How finely it splits.',
  },
  BOOL('splitByConnectivity', 'Split disconnected pieces apart. Segment mode only.', true),
  {
    name: 'hint',
    key: 'hint',
    type: 'text',
    default: '',
    maxLength: 500,
    description: 'Smart mode only: what the thing is, so the parts can be named.',
  },
]

const MESH_IN: readonly InputPortSpec[] = [{ handle: 'in', label: 'Model', accepts: ['mesh'], required: true }]
const PICTURE_IN: readonly InputPortSpec[] = [{ handle: 'in', label: 'Picture', accepts: ['picture'], required: true }]
const PICTURE_OR_VIEWS_IN: readonly InputPortSpec[] = [
  { handle: 'in', label: 'Picture or views', accepts: ['picture', 'views'], required: true },
]
const MESH_OUT: readonly OutputPortSpec[] = [{ handle: 'out', label: 'Model', type: 'mesh' }]
const PICTURE_OUT: readonly OutputPortSpec[] = [{ handle: 'out', label: 'Picture', type: 'picture' }]
const NO_RUN_INPUT = { kind: 'none' as const, description: 'Everything it needs is in the recipe.' }

/* ---------------------------------------------------------------------------- catalogue */

export const NODE_KINDS: Readonly<Record<NodeKind, NodeKindSpec>> = {
  seed_picture: {
    kind: 'seed_picture',
    label: 'Picture seed',
    description: 'The picture the pipeline starts from. The pipeline keeps no picture: each run chooses its own.',
    group: 'seed',
    offered: true,
    legacy: false,
    threeD: false,
    engineChoice: false,
    inputs: [],
    outputs: PICTURE_OUT,
    settings: [],
    runInput: {
      kind: 'seed',
      description: 'Each run is given its picture: an upload ({uploadKey, name}) or an Image library picture ({gen2dPostId}).',
    },
  },
  seed_model: {
    kind: 'seed_model',
    label: 'Model seed',
    description: 'A model from the 3D library the pipeline starts from. Each run chooses its own.',
    group: 'seed',
    offered: true,
    legacy: false,
    threeD: false,
    engineChoice: false,
    inputs: [],
    outputs: MESH_OUT,
    settings: [],
    runInput: { kind: 'seed', description: 'Each run is given its model ({gen3dPostId}).' },
  },
  remove_background: {
    kind: 'remove_background',
    label: 'Remove background',
    description: 'Cuts the subject out of its background. Free.',
    group: 'picture',
    offered: true,
    legacy: false,
    threeD: false,
    engineChoice: false,
    inputs: PICTURE_IN,
    outputs: PICTURE_OUT,
    settings: [],
    runInput: NO_RUN_INPUT,
  },
  ai_edit: {
    kind: 'ai_edit',
    label: 'AI edit',
    description: 'Changes the picture by an instruction. Needs a plan that includes image editing.',
    group: 'picture',
    offered: true,
    legacy: false,
    threeD: false,
    engineChoice: false,
    inputs: PICTURE_IN,
    outputs: PICTURE_OUT,
    settings: [
      {
        name: 'prompt',
        key: 'prompt',
        type: 'text',
        default: '',
        maxLength: 4000,
        description: 'How to change the picture, e.g. "Make the armour gold, keep everything else". Required unless askAtRun.',
      },
      BOOL('askAtRun', 'Set on each run: every run gives its own instruction before it starts.', false),
      IMAGE_ENGINE,
      BOOL('for3D', 'Frame it for 3D: one object, centred, plain background.', true),
    ],
    runInput: {
      kind: 'when-asked',
      description: 'With askAtRun on, each run is given its own instruction before it starts (a draft run asks for it).',
    },
  },
  draw_views: {
    kind: 'draw_views',
    label: 'Draw views',
    description: 'Draws the back and sides from one picture (the incoming picture is the front), for a multi-view generation.',
    group: 'picture',
    offered: true,
    legacy: false,
    threeD: false,
    engineChoice: false,
    inputs: PICTURE_IN,
    outputs: [{ handle: 'out', label: 'Views', type: 'views' }],
    settings: [
      {
        name: 'views',
        key: 'views',
        type: 'enum-list',
        default: ['back', 'left', 'right'],
        choices: [
          { value: 'back', label: 'Back' },
          { value: 'left', label: 'Left' },
          { value: 'right', label: 'Right' },
        ],
        description: 'The angles to draw besides the front.',
      },
    ],
    runInput: NO_RUN_INPUT,
  },
  isolate_parts: {
    kind: 'isolate_parts',
    label: 'Isolate parts',
    description:
      'Splits a picture into its parts — the character, the weapon, the shield — each drawn on its own. ' +
      'Wire `character` for the subject alone (re-posed, hands empty), `each` to run what follows once per part, ' +
      'or `part:<key>` for one part. In Manual mode a run stops for the user to confirm the parts.',
    group: 'picture',
    offered: true,
    legacy: false,
    threeD: false,
    engineChoice: false,
    inputs: PICTURE_IN,
    outputs: [
      { handle: 'character', label: 'Character', type: 'picture', description: 'The subject alone, re-posed, with its held items taken out.' },
      { handle: 'each', label: 'Each part', type: 'picture', description: 'Runs the steps that follow once per isolated part.' },
    ],
    dynamicOutputs: {
      prefix: PART_HANDLE_PREFIX,
      type: 'picture',
      description: 'One identified part, by key (a lowercase label with dashes: `part:sword`, `part:kite-shield`).',
    },
    settings: [
      BOOL('identify', 'Read the picture first to find its parts. Off: isolate only extraParts.', true),
      {
        name: 'sensitivity',
        key: 'sensitivity',
        type: 'enum',
        default: 'low',
        choices: [
          {
            value: 'low',
            label: 'Low',
            description: 'The whole character and each thing it holds. Anything not humanoid: its main body and what is attached.',
          },
          {
            value: 'medium',
            label: 'Medium',
            description: 'Also the head and hands; for anything else, its major parts (wheels, doors, wings, a tail).',
          },
          { value: 'high', label: 'High', description: 'Everything it can tell apart.' },
        ],
        description: 'How many parts it finds.',
      },
      {
        name: 'maxParts',
        key: 'maxParts',
        type: 'integer',
        default: 6,
        min: 1,
        max: 16,
        description: 'The most parts it isolates. Held items come first, then typed ones, then the rest.',
      },
      {
        name: 'pose',
        key: 'pose',
        type: 'enum',
        default: 't',
        choices: [
          { value: 't', label: 'T-pose', aliases: ['t-pose', 'tpose'] },
          { value: 'a', label: 'A-pose', aliases: ['a-pose', 'apose'] },
        ],
        description: 'The pose a humanoid character is redrawn in.',
      },
      {
        name: 'extraParts',
        key: 'extraParts',
        type: 'string-list',
        default: [],
        maxItems: 16,
        maxLength: 80,
        description: 'Parts to isolate whatever the picture shows, e.g. ["sword", "shield"].',
      },
      IMAGE_ENGINE,
    ],
    runInput: NO_RUN_INPUT,
  },
  generate_3d: {
    kind: 'generate_3d',
    label: 'Generate 3D',
    description: 'A model from a picture, or from several views (wire a Draw views step in for a multi-view job).',
    group: 'make',
    offered: true,
    legacy: false,
    threeD: true,
    engineChoice: true,
    inputs: PICTURE_OR_VIEWS_IN,
    outputs: MESH_OUT,
    settings: generateSettings(
      [
        { value: 'n1', label: 'Zetta N1', description: 'The base model.' },
        { value: 'n25', label: 'Zetta N2.5', description: 'The highest quality of mesh and texture.' },
      ],
      'n25',
    ),
    runInput: NO_RUN_INPUT,
  },
  generate_smart_3d: {
    kind: 'generate_smart_3d',
    label: 'Generate Smart 3D',
    description: 'Clean, low topology to a face budget, from a picture or views.',
    group: 'make',
    offered: true,
    legacy: false,
    threeD: true,
    engineChoice: true,
    inputs: PICTURE_OR_VIEWS_IN,
    outputs: MESH_OUT,
    settings: generateSettings(
      [
        { value: 'np1', label: 'Zetta Np1', description: 'Clean topology, balanced quality.' },
        { value: 'np15', label: 'Zetta Np1.5', description: 'Clean topology, quad native.' },
      ],
      'np1',
    ),
    runInput: NO_RUN_INPUT,
  },
  generate_splat: {
    kind: 'generate_splat',
    label: 'Generate Splat',
    description: 'A splat object or environment from a picture. No longer offered; graphs that have one still run (early access).',
    group: 'make',
    offered: false,
    legacy: true,
    threeD: true,
    engineChoice: true,
    earlyAccess: true,
    inputs: PICTURE_IN,
    outputs: [{ handle: 'out', label: 'Splat', type: 'splat' }],
    settings: [
      {
        name: 'subject',
        key: 'subject',
        type: 'enum',
        default: 'object',
        choices: [
          { value: 'object', label: 'Object' },
          { value: 'environment', label: 'Environment' },
        ],
        description: 'What the picture is of.',
      },
      {
        name: 'engine',
        key: 'engine',
        type: 'enum',
        default: 'n25',
        choices: [
          { value: 'n25', label: 'Zetta Splat' },
          { value: 'zs2', label: 'Zetta Splat 2', description: 'A whole world from one picture.' },
          { value: 'zs21', label: 'Zetta Splat 2.1', description: 'A larger world from one picture.' },
        ],
        description: 'The splat engine.',
      },
      BOOL('removeBackground', 'Cut the object out first (an object on Zetta Splat only).', true),
      {
        name: 'ratio',
        key: 'ratio',
        type: 'enum',
        default: '16:9',
        choices: ['16:9', '21:9', '3:2', '4:3', '1:1'].map((value) => ({ value, label: value })),
        description: 'An environment’s frame.',
      },
      {
        name: 'resolution',
        key: 'resolution',
        type: 'enum',
        default: '1K',
        choices: ['1K', '2K', '4K'].map((value) => ({ value, label: value })),
        description: 'An environment picture’s resolution.',
      },
      {
        name: 'title',
        key: 'title',
        type: 'string',
        default: '',
        maxLength: 200,
        description: 'What the splat is called. Empty: named after the run’s seed.',
      },
    ],
    runInput: NO_RUN_INPUT,
  },
  retopology: {
    kind: 'retopology',
    label: 'Retopology',
    description: 'A clean mesh at the polygon budget you set.',
    group: 'refine',
    offered: true,
    legacy: false,
    threeD: true,
    engineChoice: true,
    inputs: MESH_IN,
    outputs: MESH_OUT,
    settings: [
      {
        name: 'engine',
        key: 'engine',
        type: 'enum',
        default: 'r1',
        choices: [
          { value: 'r1', label: 'Zetta R1', description: 'An exact budget up to 20,000 polygons. Faster, and less than half the price.' },
          { value: 'n1', label: 'Zetta N1', description: 'No polygon ceiling — for a dense mesh. Takes a face level, not a count.' },
        ],
        description: 'The retopology engine.',
      },
      {
        name: 'faces',
        key: 'faces',
        type: 'integer',
        default: 8_000,
        min: 500,
        max: 20_000,
        description: 'Zetta R1 only: the exact polygon budget, 500–20,000 triangles or 500–10,000 quads.',
      },
      {
        name: 'faceLevel',
        key: 'faceLevel',
        type: 'enum',
        default: 'medium',
        choices: [
          { value: 'low', label: 'Low', description: 'Fewest polygons — game-ready.' },
          { value: 'medium', label: 'Medium' },
          { value: 'high', label: 'High', description: 'Keeps the most detail.' },
        ],
        description: 'Zetta N1 only: how dense the new mesh is.',
      },
      { name: 'polygonType', key: 'polygonType', type: 'enum', default: 'triangle', choices: POLYGON_TYPES, description: 'Triangles or quads.' },
      BOOL('bake', 'Zetta R1 only: bake the textures onto the new mesh.', true),
    ],
    runInput: NO_RUN_INPUT,
  },
  segmentation: {
    kind: 'segmentation',
    label: 'Segmentation',
    description: 'Splits the model into parts — Segment or Smart Segment.',
    group: 'refine',
    offered: true,
    legacy: false,
    threeD: true,
    engineChoice: false,
    inputs: MESH_IN,
    outputs: MESH_OUT,
    settings: SEGMENT_SETTINGS('segment'),
    runInput: NO_RUN_INPUT,
  },
  smart_segmentation: {
    kind: 'smart_segmentation',
    label: 'Smart segmentation',
    description: 'Splits the model into named parts. No longer offered: use segmentation with mode: smart.',
    group: 'refine',
    offered: false,
    legacy: true,
    threeD: true,
    engineChoice: false,
    inputs: MESH_IN,
    outputs: MESH_OUT,
    settings: SEGMENT_SETTINGS('smart'),
    runInput: NO_RUN_INPUT,
  },
  texture: {
    kind: 'texture',
    label: 'AI texturing',
    description: 'New textures for the model, from a reference picture or a description.',
    group: 'refine',
    offered: true,
    legacy: false,
    threeD: true,
    engineChoice: false,
    inputs: [
      { handle: 'in', label: 'Model', accepts: ['mesh'], required: true },
      { handle: 'reference', label: 'Reference', accepts: ['picture'], required: false, legacy: true },
    ],
    outputs: MESH_OUT,
    settings: [
      {
        name: 'tier',
        key: 'tier',
        type: 'enum',
        default: 'standard',
        choices: [
          { value: 'standard', raw: 'retexture', label: 'Standard', aliases: ['retexture', '2k'], description: '2K textures.' },
          { value: 'detailed', raw: 'retexture_hd', label: 'Detailed', aliases: ['retexture_hd', 'hd', '4k'], description: '4K textures.' },
          { value: '8k', raw: 'retexture_8k', label: '8K', aliases: ['retexture_8k', 'extreme'], description: '8K textures.' },
        ],
        description: 'The texture tier — each is priced on its own.',
      },
      {
        name: 'prompt',
        key: 'prompt',
        type: 'text',
        default: '',
        maxLength: 4000,
        description: 'A description of the texture, used when there is no reference picture.',
      },
      {
        name: 'reference',
        key: 'reference',
        type: 'picture',
        nullable: true,
        description: 'A reference picture to texture from; it replaces the description.',
      },
      BOOL('removeReferenceBackground', 'Cut the reference picture out of its background first.', true, 'removeBg'),
      {
        name: 'alignment',
        key: 'alignment',
        type: 'enum',
        default: 'picture',
        choices: [
          { value: 'picture', raw: 'original_image', label: 'Fit texture to picture', aliases: ['original_image', 'image'] },
          { value: 'mesh', raw: 'geometry', label: 'Fit texture to mesh', aliases: ['geometry'] },
        ],
        description: 'When the picture and the mesh disagree, which the texture follows.',
      },
      BOOL('bake', 'Bake the result into the textures.', true),
      BOOL('pbr', 'PBR materials (free on a retexture).', true),
      BOOL('fast', 'The standard tier’s faster setting.', false),
      BOOL('delight', 'Strip the reference’s baked-in lighting.', true),
    ],
    runInput: {
      kind: 'always',
      description:
        'The editor treats AI texturing as set on each run: a new draft run starts it empty and needs a description or a ' +
        'reference picture before Start. A prompt or reference kept in the recipe is used by runs started without a draft.',
    },
  },
  smart_uv: {
    kind: 'smart_uv',
    label: 'Smart UV',
    description: 'A new UV layout, with the textures re-baked onto it. Up to 80,000 triangles.',
    group: 'refine',
    offered: true,
    legacy: false,
    threeD: true,
    engineChoice: false,
    inputs: MESH_IN,
    outputs: MESH_OUT,
    settings: [
      BOOL('bake', 'Re-bake the textures onto the new layout. Off: layout only.', true),
      {
        name: 'orientation',
        key: 'orientation',
        type: 'enum',
        default: 'as-is',
        choices: ['as-is', '+x', '-x', '+y', '-y'].map((value) => ({ value, label: value === 'as-is' ? 'As is' : value.toUpperCase() })),
        description: 'Which way the exported model faces.',
      },
      BOOL('compress', 'Compress the geometry for a smaller file.', false),
    ],
    runInput: NO_RUN_INPUT,
  },
  rigging: {
    kind: 'rigging',
    label: 'Auto rig',
    description: 'A skeleton, skinned, ready to animate.',
    group: 'refine',
    offered: true,
    legacy: false,
    threeD: true,
    engineChoice: false,
    inputs: MESH_IN,
    outputs: MESH_OUT,
    settings: [
      {
        name: 'rigType',
        key: 'rigType',
        type: 'enum',
        default: 'biped',
        choices: [
          { value: 'biped', label: 'Humanoid', aliases: ['humanoid'], description: 'Two legs, two arms.' },
          { value: 'quadruped', label: 'Four legs', aliases: ['four-legs'], description: 'Dogs, horses, most mammals.' },
          { value: 'avian', label: 'Bird', aliases: ['bird'], description: 'Wings and a tail.' },
          { value: 'serpentine', label: 'Snake', aliases: ['snake'], description: 'A long spine, no limbs.' },
          { value: 'aquatic', label: 'Fish', aliases: ['fish'], description: 'Fins and a tail.' },
          { value: 'hexapod', label: 'Six legs', aliases: ['insect'], description: 'Insects.' },
          { value: 'octopod', label: 'Eight legs', aliases: ['spider'], description: 'Spiders and octopods.' },
        ],
        description: 'The body the skeleton is for.',
      },
      {
        name: 'rigSpec',
        key: 'spec',
        type: 'enum',
        default: 'standard',
        choices: [
          { value: 'standard', label: 'Standard', description: 'The rigger’s own skeleton naming.' },
          { value: 'mixamo', label: 'Mixamo', description: 'For Mixamo and libraries that follow it.' },
        ],
        description: 'The bone naming convention. Any other value is treated as standard.',
      },
      {
        name: 'format',
        key: 'outFormat',
        type: 'enum',
        default: 'glb',
        choices: [
          { value: 'glb', label: 'GLB' },
          { value: 'fbx', label: 'FBX' },
        ],
        description: 'The file the rigged model comes back as.',
      },
    ],
    runInput: NO_RUN_INPUT,
  },
  export: {
    kind: 'export',
    label: 'Export',
    description: 'A file of the model. No longer offered: files download from the library. Free.',
    group: 'output',
    offered: false,
    legacy: true,
    threeD: false,
    engineChoice: false,
    inputs: MESH_IN,
    outputs: [{ handle: 'out', label: 'File', type: 'file' }],
    settings: [
      {
        name: 'format',
        key: 'format',
        type: 'enum',
        default: 'glb',
        choices: ['glb', 'fbx', 'obj', 'stl'].map((value) => ({ value, label: value.toUpperCase() })),
        description: 'The file format.',
      },
    ],
    runInput: NO_RUN_INPUT,
  },
}

/** The kinds the editor's palette offers, in its order. */
export const OFFERED_NODE_KINDS: readonly NodeKind[] = ALL_NODE_KINDS.filter((kind) => NODE_KINDS[kind].offered)
/** The kinds that still load and run but are no longer offered. */
export const LEGACY_NODE_KINDS: readonly NodeKind[] = ALL_NODE_KINDS.filter((kind) => NODE_KINDS[kind].legacy)

export function isNodeKind(value: unknown): value is NodeKind {
  return typeof value === 'string' && (ALL_NODE_KINDS as readonly string[]).includes(value)
}

export function isSeed(kind: string): boolean {
  return kind === 'seed_picture' || kind === 'seed_model'
}

/** What an output handle carries, or null for one the node does not have. */
export function outputType(kind: string, handle: string): PortType | null {
  if (!isNodeKind(kind)) return null
  const spec = NODE_KINDS[kind]
  const fixed = spec.outputs.find((output) => output.handle === handle)
  if (fixed) return fixed.type
  if (spec.dynamicOutputs && handle.startsWith(spec.dynamicOutputs.prefix)) {
    return spec.dynamicOutputs.type
  }
  return null
}

/** A node's input port, or null for one it does not have. */
export function inputPort(kind: string, handle: string): InputPortSpec | null {
  if (!isNodeKind(kind)) return null
  return NODE_KINDS[kind].inputs.find((input) => input.handle === handle) ?? null
}

/** A setting of a kind, by its friendly name. */
export function settingSpec(kind: NodeKind, name: string): SettingSpec | null {
  return NODE_KINDS[kind].settings.find((setting) => setting.name === name) ?? null
}

/** A setting of a kind, by the editor settings key it is stored under. */
export function settingSpecByKey(kind: NodeKind, key: string): SettingSpec | null {
  return NODE_KINDS[kind].settings.find((setting) => setting.key === key) ?? null
}
