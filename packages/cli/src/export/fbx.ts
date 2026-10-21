import { FBXExporter } from '@comfyorg/fbx-exporter-three'
import { collectMaterials, collectParts, parseGlb, ZettaError, type ExportedFile } from '@zetta3d/sdk'
import { BufferAttribute, BufferGeometry, Group, Mesh, MeshStandardMaterial, Texture } from 'three'

export const FBX_PRESETS = ['unity', 'unreal', 'blender', 'maya', 'threejs'] as const
export type FbxPreset = (typeof FBX_PRESETS)[number]

/**
 * GLB → binary FBX, locally. Geometry comes with world transforms baked in; base colours and
 * base-colour textures are kept, the textures embedded in the FBX as their original bytes and
 * also written beside it for importers that look for loose files.
 *
 * Loaded only by `zetta asset export --format fbx`, so three.js never slows other commands.
 */
export async function glbToFbx(data: Uint8Array, base = 'model', preset: FbxPreset = 'unity'): Promise<ExportedFile[]> {
  const glb = parseGlb(data)
  const parts = collectParts(glb)
  if (!parts.length) throw new ZettaError({ code: 'INVALID_INPUT', message: 'The model has no triangles to export.' })

  const files: ExportedFile[] = []
  const textureFiles = new Map<number, { name: string; bytes: Uint8Array }>()
  const materials = collectMaterials(glb).map((info) => {
    const material = new MeshStandardMaterial({ name: info.name })
    material.color.setRGB(info.color[0], info.color[1], info.color[2])
    if (info.color[3] < 1) {
      material.transparent = true
      material.opacity = info.color[3]
    }
    if (info.texture) {
      const name = `${base}_texture${info.index}.${info.texture.extension}`
      const texture = new Texture()
      texture.name = name.replace(/\.[^.]+$/, '')
      // glTF textures are not flipped; this tells the exporter to flip V for FBX.
      texture.flipY = false
      material.map = texture
      textureFiles.set(texture.id, { name, bytes: info.texture.bytes })
      files.push({ name, bytes: info.texture.bytes })
    }
    return material
  })
  const fallback = new MeshStandardMaterial({ name: 'default' })

  const root = new Group()
  root.name = base
  for (const part of parts) {
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(part.positions), 3))
    if (part.normals) geometry.setAttribute('normal', new BufferAttribute(new Float32Array(part.normals), 3))
    if (part.uvs) geometry.setAttribute('uv', new BufferAttribute(new Float32Array(part.uvs), 2))
    geometry.setIndex(part.triangles)
    if (!part.normals) geometry.computeVertexNormals()
    const mesh = new Mesh(geometry, part.material !== undefined ? (materials[part.material] ?? fallback) : fallback)
    mesh.name = part.name
    root.add(mesh)
  }

  const exporter = new FBXExporter()
  // The exporter cannot decode pictures outside a browser; hand it the original bytes instead.
  exporter.register((sceneData: { textures?: { textures?: Map<Texture, { texture: Texture; fileName: string; imageBytes: Uint8Array | null; extension: string }> } }) => {
    for (const entry of sceneData.textures?.textures?.values() ?? []) {
      const file = textureFiles.get(entry.texture.id)
      if (!file) continue
      entry.fileName = file.name
      entry.imageBytes = file.bytes
      entry.extension = file.name.split('.').pop() ?? 'png'
    }
  })
  const bytes = exporter.parseSync(root, { preset, embedTextures: false, includeAnimations: false, creator: 'Zetta 3D' })
  return [{ name: `${base}.fbx`, bytes }, ...files]
}
