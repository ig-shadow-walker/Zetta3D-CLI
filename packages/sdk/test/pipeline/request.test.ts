import { describe, expect, it } from 'vitest'
import {
  defaultSettings,
  incomingType,
  nodeProblems,
  requestFor,
  settingsWithDefaults,
  withRequests,
  type PipelineGraph,
} from '../../src/pipeline'

const req = (kind: Parameters<typeof requestFor>[0]['kind'], settings?: Record<string, unknown>, incoming: 'views' | 'picture' | null = null) =>
  requestFor({ kind, settings: settings ?? defaultSettings(kind) }, { incoming })

describe('requestFor — parity with the web editor’s node-config tests', () => {
  it('builds a generation with the Studio’s builder, leaving the picture to the server', () => {
    const request = req('generate_smart_3d', { ...defaultSettings('generate_smart_3d'), removeBackground: true })
    expect(request).toMatchObject({ model: 'np1', removeBackground: true })
    expect(request.spec).toMatchObject({ generation: { base: expect.any(String) } })
    for (const field of ['imageUrl', 'prompt', 'origin', 'imageFromPrompt']) expect(request).not.toHaveProperty(field)
  })

  it('prices views coming in as a multi-view job', () => {
    const request = req('generate_3d', undefined, 'views')
    expect((request.spec as { generation: { modifiers: string[] } }).generation.modifiers).toContain('multi_view')
  })

  it('sends a post-process as the Studio panel’s hook would, minus its origin', () => {
    expect(req('smart_uv', { bake: true, orientation: 'as-is', compress: true })).toEqual({
      spec: { postProcess: ['smart_uv'] },
      compressGeometry: true,
    })
  })

  it('carries Isolate Parts’ choices and the export’s format', () => {
    expect(req('isolate_parts', { ...defaultSettings('isolate_parts'), sensitivity: 'high', pose: 'a' })).toEqual({
      identify: true,
      sensitivity: 'high',
      maxParts: 6,
      pose: 'a',
      extraParts: [],
    })
    expect(req('export', { format: 'stl' })).toEqual({ format: 'stl' })
  })

  it('textures from the node’s own picture in place of its description', () => {
    const settings = { ...defaultSettings('texture'), prompt: 'bronze', reference: { uploadKey: 'inputImg/7/ref.png', name: 'ref.png' } }
    const request = req('texture', settings)
    expect(request).toMatchObject({ referenceUploadKey: 'inputImg/7/ref.png', removeReferenceBackground: true })
    expect(request).not.toHaveProperty('prompt')
    expect(req('texture', { ...settings, reference: null })).toMatchObject({ prompt: 'bronze' })
  })

  it('keeps no seed in the pipeline — each run chooses its own', () => {
    expect(req('seed_picture', { source: 'upload', uploadKey: 'inputImg/7/a.png' })).toEqual({})
    expect(req('seed_model', { gen3dPostId: 4 })).toEqual({})
  })
})

describe('requestFor — every kind, with its defaults', () => {
  it('generate_3d opens on Zetta N2.5 at 200,000 polygons, which N2.5 counts as custom (as the web does)', () => {
    expect(req('generate_3d')).toEqual({
      spec: { generation: { base: 'textured', modifiers: ['pbr', 'custom_face_count'] } },
      faceCount: 200_000,
      polygonType: 'triangle',
      textureAlignment: 'geometry',
      advanceControl: true,
      model: 'n25',
      removeBackground: true,
    })
  })

  it('generate_smart_3d opens on Zetta Np1 at its 20,000 ceiling', () => {
    expect(req('generate_smart_3d')).toEqual({
      spec: { generation: { base: 'textured', modifiers: ['pbr'] } },
      faceCount: 20_000,
      textureAlignment: 'geometry',
      advanceControl: true,
      model: 'np1',
      removeBackground: true,
    })
  })

  it('a multi-view generation adds multi_view first', () => {
    expect((req('generate_3d', undefined, 'views').spec as { generation: { modifiers: string[] } }).generation.modifiers).toEqual([
      'multi_view',
      'pbr',
      'custom_face_count',
    ])
  })

  it('a form the Studio would refuse yields the engine alone', () => {
    expect(req('generate_3d', { ...defaultSettings('generate_3d'), polygonCount: '12,000' })).toEqual({ model: 'n25' })
  })

  it('a plan that cannot choose a count sends none', () => {
    const request = requestFor({ kind: 'generate_3d', settings: defaultSettings('generate_3d') }, { allowsCustomFaceCount: false })
    expect(request).not.toHaveProperty('faceCount')
    expect((request.spec as { generation: { modifiers: string[] } }).generation.modifiers).toEqual(['pbr'])
  })

  it('a title travels trimmed', () => {
    expect(req('generate_3d', { ...defaultSettings('generate_3d'), title: '  Knight ' }).title).toBe('Knight')
  })

  it('picture steps', () => {
    expect(req('remove_background')).toEqual({})
    expect(req('ai_edit')).toEqual({ prompt: '', for3D: true })
    expect(req('ai_edit', { prompt: 'Make it gold', model: 'image-x', for3D: false })).toEqual({ prompt: 'Make it gold', for3D: false, model: 'image-x' })
    expect(req('draw_views')).toEqual({ views: ['back', 'left', 'right'] })
    expect(req('draw_views', { views: ['left'] })).toEqual({ views: ['left'] })
    expect(req('isolate_parts', { identify: false, extraParts: ['sword'], model: 'image-x' })).toEqual({
      identify: false,
      sensitivity: 'low',
      maxParts: 6,
      pose: 't',
      extraParts: ['sword'],
      model: 'image-x',
    })
  })

  it('retopology sends a count on R1 and a level on N1, never both', () => {
    expect(req('retopology')).toEqual({ spec: { postProcess: ['smart_topology'] }, model: 'r1', faceCount: 8000, polygonType: 'triangle' })
    expect(req('retopology', { ...defaultSettings('retopology'), bake: false })).toMatchObject({ bake: false })
    expect(req('retopology', { ...defaultSettings('retopology'), engine: 'n1', faceLevel: 'high' })).toEqual({
      spec: { postProcess: ['smart_topology'] },
      model: 'n1',
      faceLevel: 'high',
      polygonType: 'triangle',
    })
  })

  it('segmentation sends one shape per mode', () => {
    expect(req('segmentation')).toEqual({ spec: { postProcess: ['ai_segmentation'] }, segmentGranularity: 'balanced' })
    expect(req('segmentation', { ...defaultSettings('segmentation'), splitByConnectivity: false })).toEqual({
      spec: { postProcess: ['ai_segmentation'] },
      segmentGranularity: 'balanced',
      splitByConnectivity: false,
    })
    expect(req('segmentation', { ...defaultSettings('segmentation'), mode: 'smart', hint: ' a chair ', splitByConnectivity: false })).toEqual({
      spec: { postProcess: ['smart_segmentation'] },
      prompt: 'a chair',
      segmentGranularity: 'balanced',
    })
    expect(req('smart_segmentation')).toEqual({ spec: { postProcess: ['smart_segmentation'] }, segmentGranularity: 'balanced' })
  })

  it('texture sends its tier as the code, and the fast setting only on the standard tier', () => {
    expect(req('texture')).toEqual({
      spec: { postProcess: ['retexture'] },
      textureAlignment: 'original_image',
      enablePBR: true,
      delight: true,
      removeReferenceBackground: true,
    })
    expect(req('texture', { ...defaultSettings('texture'), fast: true, bake: false, removeBg: false, reference: { gen2dPostId: 9 } })).toEqual({
      spec: { postProcess: ['retexture'] },
      textureAlignment: 'original_image',
      bake: false,
      enablePBR: true,
      textureFast: true,
      delight: true,
      referenceImageId: 9,
      removeReferenceBackground: false,
    })
    expect(req('texture', { ...defaultSettings('texture'), tier: 'retexture_hd', fast: true })).not.toHaveProperty('textureFast')
  })

  it('smart_uv sends defaults as silence', () => {
    expect(req('smart_uv')).toEqual({ spec: { postProcess: ['smart_uv'] } })
    expect(req('smart_uv', { bake: false, orientation: '+y', compress: false })).toEqual({
      spec: { postProcess: ['smart_uv'] },
      exportOrientation: '+y',
      bake: false,
    })
  })

  it('rigging sends each choice only when it is not the default', () => {
    expect(req('rigging')).toEqual({ spec: { postProcess: ['auto_rigging'] } })
    expect(req('rigging', { rigType: 'quadruped', spec: 'mixamo', outFormat: 'fbx' })).toEqual({
      spec: { postProcess: ['auto_rigging'] },
      rigType: 'quadruped',
      rigSpec: 'mixamo',
      rigOutFormat: 'fbx',
    })
  })

  it('rigging never sends a bone naming the Studio does not offer', () => {
    expect(req('rigging', { rigType: 'biped', spec: 'legacy-x', outFormat: 'glb' })).toEqual({ spec: { postProcess: ['auto_rigging'] } })
  })

  it('generate_splat (legacy) sends the splat spec, and a cut-out only for an object on Zetta Splat', () => {
    expect(req('generate_splat')).toEqual({ spec: { generation: { base: 'gaussian_splat', modifiers: [] } }, model: 'n25', removeBackground: true })
    expect(req('generate_splat', { ...defaultSettings('generate_splat'), subject: 'environment' }).removeBackground).toBe(false)
    expect(req('generate_splat', { ...defaultSettings('generate_splat'), engine: 'zs2' })).toMatchObject({ model: 'zs2', removeBackground: false })
  })

  it('export (legacy) defaults to GLB', () => {
    expect(req('export', {})).toEqual({ format: 'glb' })
  })

  it('reads the defaults for a setting the step does not hold', () => {
    expect(requestFor({ kind: 'retopology', settings: { faces: 5000 } })).toEqual({
      spec: { postProcess: ['smart_topology'] },
      model: 'r1',
      faceCount: 5000,
      polygonType: 'triangle',
    })
    expect(requestFor({ kind: 'rigging' })).toEqual({ spec: { postProcess: ['auto_rigging'] } })
  })

  it('never shares a list with the settings it came from', () => {
    const settings = { views: ['back'] }
    const request = requestFor({ kind: 'draw_views', settings })
    expect(request.views).not.toBe(settings.views)
  })
})

describe('settingsWithDefaults — how the editor fills a graph that names only what it changed', () => {
  it('settles a named engine’s coupled options', () => {
    expect(settingsWithDefaults('generate_smart_3d', { model: 'np15' }).polygonCount).toBe('20000')
    expect(settingsWithDefaults('generate_3d', { quality: 'ultra' }).polygonCount).toBe('2000000')
    expect(settingsWithDefaults('retopology', { engine: 'n1' })).toEqual({ ...defaultSettings('retopology'), engine: 'n1' })
  })
})

describe('withRequests and incomingType', () => {
  const graph: PipelineGraph = {
    version: 1,
    nodes: [
      { id: 'seed', kind: 'seed_picture', position: { x: 0, y: 0 }, settings: { source: null } },
      { id: 'views', kind: 'draw_views', position: { x: 0, y: 0 }, settings: defaultSettings('draw_views') },
      { id: 'gen', kind: 'generate_3d', position: { x: 0, y: 0 }, settings: defaultSettings('generate_3d') },
      { id: 'raw', kind: 'retopology', position: { x: 0, y: 0 }, request: { model: 'r1', spec: { postProcess: ['smart_topology'] } } },
    ],
    edges: [
      { id: 'a', source: 'seed', sourceHandle: 'out', target: 'views', targetHandle: 'in' },
      { id: 'b', source: 'views', sourceHandle: 'out', target: 'gen', targetHandle: 'in' },
      { id: 'c', source: 'gen', sourceHandle: 'out', target: 'raw', targetHandle: 'in' },
    ],
  }

  it('knows what arrives on each input', () => {
    expect(incomingType(graph, 'gen')).toBe('views')
    expect(incomingType(graph, 'views')).toBe('picture')
    expect(incomingType(graph, 'seed')).toBeNull()
  })

  it('rebuilds every request from its settings, and keeps a request with no settings behind it', () => {
    const built = withRequests(graph)
    expect((built.nodes[2]!.request!.spec as { generation: { modifiers: string[] } }).generation.modifiers).toContain('multi_view')
    expect(built.nodes[0]!.request).toEqual({})
    expect(built.nodes[3]!.request).toEqual({ model: 'r1', spec: { postProcess: ['smart_topology'] } })
  })
})

describe('nodeProblems — what the Studio’s form would refuse', () => {
  it('says when a Retopology count is out of range for its topology', () => {
    expect(nodeProblems({ kind: 'retopology', settings: { faces: 15000, polygonType: 'quadrilateral' } })).toEqual([
      { field: 'faces', message: 'The polygon count must be between 500 and 10,000.' },
    ])
    expect(nodeProblems({ kind: 'retopology', settings: { engine: 'n1', faces: 999999 } })).toEqual([])
  })

  it('says when a generation’s polygon count is refused', () => {
    expect(nodeProblems({ kind: 'generate_smart_3d', settings: { ...defaultSettings('generate_smart_3d'), polygonCount: '90000' } })).toEqual([
      { field: 'polygonCount', message: 'The polygon count must be between 48 and 20,000.' },
    ])
    expect(nodeProblems({ kind: 'generate_3d', settings: defaultSettings('generate_3d') })).toEqual([])
  })
})
