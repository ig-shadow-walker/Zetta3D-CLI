# Refining models

The finishing tools work on any model:
- one from your library, given by its asset id;
- a local `.glb` file;
- a URL to a `.glb`, `.obj` or `.fbx`.

Each run makes a **new asset** and leaves the original untouched. They are paid commands, with the same flags as `generate`: `--dry-run`, `--max-credits`, `--yes`, `--idempotency-key`, `--wait`, `--timeout`, `--out`, `--format`, `--title`, `--tag` and `--visibility`. Finishing tools need a paid plan.

```bash
zetta refine <tool> <asset-id | file.glb | url> [options]
```

## Retopology: `zetta refine retopo`

Rebuilds the mesh as clean topology at a lower polygon count. It runs on Zetta R1, to an exact budget.

| Flag | What it does |
|---|---|
| `--faces N` | 500–20,000 triangles, or 500–10,000 quads (default 8,000) |
| `--quads` | Quad topology |
| `--no-bake` | Bare geometry. By default the textures are carried onto the new mesh |
| `--unwrap-uvs` | Unwrap fresh UVs in the same job, at no extra cost (replaces the UV layout) |
| `--part <name>` | Only these parts of a segmented model |

```bash
zetta refine retopo 1234 --faces 5000 --quads --yes --wait
zetta refine retopo ./scan.glb --faces 2000 --unwrap-uvs --dry-run
```

## Segmentation: `zetta refine segment`

Splits a model into separate parts.

| Flag | What it does |
|---|---|
| `--smart` | Smarter segmentation (better parts, costs more) |
| `--granularity simple\|balanced\|detailed` | How finely to split |
| `--no-split-by-connectivity` | Keep disconnected pieces together |
| `--prompt "seat, legs, backrest"` | With `--smart`: which parts you want |

## Smart UV: `zetta refine uv`

Unwraps clean UVs, for models up to 80,000 triangles.

| Flag | What it does |
|---|---|
| `--bake` | Bake the existing texture onto the new UVs. Off by default: you get bare UVs |
| `--orientation as-is\|+x\|-x\|+y\|-y` | Which way the model faces in the export (default `as-is`) |
| `--compress` | Compress geometry |

## Texturing: `zetta refine texture`

Repaints the texture from a reference picture, a description, both, or pictures of several sides.

| Flag | What it does |
|---|---|
| `--reference <picture>` | A file, URL or `image:<id>` showing the look you want |
| `--prompt "…"` | A description. It is turned into a reference picture first (needs image editing on your plan) |
| `--view side=picture` (repeat) | Reference pictures of several sides instead: `front` (required), `back`, `left`, `right`. Not with `--reference` or `--prompt` |
| `--tier standard\|hd\|8k` | Texture resolution: standard (2K), hd (4K) or 8k, each at its own price |
| `--alignment image\|geometry` | Follow the picture (default) or the mesh |
| `--pbr` / `--no-pbr` | PBR materials (on by default) |
| `--no-bake` | Don't bake material effects into the base texture (baked by default) |
| `--no-delight` | Keep the lighting in the reference (by default it is removed first) |
| `--fast` | The faster setting of the standard tier |
| `--remove-bg` | Remove the reference pictures' backgrounds first |
| `--part <name>`, `--seed N` | Only these parts; reproducible results |

```bash
zetta refine texture 1234 --reference oak.jpg --tier hd --yes --wait
zetta refine texture 1234 --prompt "brushed steel with scratches" --dry-run
zetta refine texture 1234 --view front=f.png --view back=b.png --dry-run
```

## Rigging: `zetta refine rig`

Adds a skeleton so the model can be animated.

| Flag | What it does |
|---|---|
| `--rig-type biped\|quadruped\|hexapod\|octopod\|avian\|serpentine\|aquatic\|others` | Body plan (default `biped`). `others` is for a creature none of the others describe |
| `--rig-spec standard\|mixamo\|unity\|unreal\|vrm\|actorcore` | Bone naming, for a biped only: standard (default), mixamo, unity (Humanoid), unreal (UE5 Mannequin), vrm (VRM 1.0) or actorcore |
| `--rig-format glb\|fbx` | File format of the rigged model (default `glb`) |

Not sure which body plan? `zetta asset rig-check <id>` looks at the model and suggests one (for example `quadruped`, with a reason). Add 1–4 `--frame <picture>` flags to give it your own renders, from different angles, instead of the thumbnail. Rig checks need a paid plan.

```bash
zetta asset rig-check 1234
zetta asset rig-check 1234 --frame front.png --frame side.png --frame back.png
zetta refine rig 1234 --rig-type quadruped --rig-format fbx --yes --out ./models
zetta refine rig 1234 --rig-spec unreal --dry-run
```

## Conversion

### Free, on your machine: `zetta asset export`

Converts a GLB without using the server or spending credits.

| `--format` | Output |
|---|---|
| `obj` | `.obj` + `.mtl` + the textures as files |
| `fbx` | Binary `.fbx` with the textures embedded, and also written beside it. `--fbx-preset unity\|unreal\|blender\|maya\|threejs` sets axes and units (default `unity`) |
| `stl` | Binary `.stl` (geometry only, for 3D printing) |

Some details:
- **Input:** an asset id (its GLB is fetched) or a local `.glb`.
- **Geometry:** node transforms are baked into it.
- **Compressed GLBs:** models with compressed geometry are refused; use the server conversion for those.

```bash
zetta asset export 1234 --format fbx --fbx-preset blender --out ./blender
zetta asset export ./chair.glb --format stl --out ./print
```

### On the server: `zetta refine convert`

For USDZ, 3MF and glTF, and for clean-up while converting. Options that change geometry or textures switch to the advanced, pricier tier.

| Flag | What it does |
|---|---|
| `--to gltf\|fbx\|usdz\|obj\|stl\|3mf` | Target format (any case) |
| `--quad`, `--symmetry`, `--faces N` | Quad topology (FBX); forced symmetry (with `--quad`); a face limit of 1,000–1,000,000, or 1,000–150,000 with `--quad` |
| `--flatten-bottom`, `--flatten-threshold X` | Flatten the base, for printing or placing |
| `--texture-size 128–4096`, `--texture-format jpeg\|png\|webp\|…` | Texture output |
| `--pack-uv`, `--vertex-colors` | Pack UVs; export vertex colours |
| `--pivot-bottom`, `--scale X`, `--orientation +x\|-x\|+y\|-y` | Pivot at the bottom centre, scale, forward axis |
| `--with-animation`, `--in-place`, `--fbx-preset blender\|3dsmax\|mixamo` | Animation and FBX target |

```bash
zetta refine convert 1234 --to usdz --yes --out ./ar
```

## Chaining

Each step returns the new asset's id, so tools chain naturally:

```bash
id=$(zetta generate -i robot.png --engine n2.5 --max-credits 100 --wait --json | jq -r .id)
topo=$(zetta refine retopo "$id" --faces 6000 --max-credits 60 --wait --json | jq -r .id)
zetta refine rig "$topo" --rig-type biped --rig-format fbx --max-credits 60 --out ./out
```

For the same chain over many inputs, use a [pipeline](pipelines.md).
