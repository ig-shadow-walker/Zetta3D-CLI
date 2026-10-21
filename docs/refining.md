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

Rebuilds the mesh as clean topology at a lower polygon count.

| Flag | What it does |
|---|---|
| `--engine r1\|n1` | `r1` (default) takes an exact budget; `n1` takes a density level |
| `--faces N` | `r1`: 500–20,000 triangles or 500–10,000 quads (default 8,000) |
| `--face-level low\|medium\|high` | `n1`: density |
| `--quads` | Quad topology |
| `--bake` | Bake the original's detail into the new model's textures |
| `--part <name>` | Only these parts of a segmented model (`r1`) |

```bash
zetta refine retopo 1234 --faces 5000 --quads --yes --wait
zetta refine retopo ./scan.glb --engine n1 --face-level low --dry-run
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
| `--bake` | Bake the existing texture onto the new UVs |
| `--orientation as-is\|+x\|-x\|+y\|-y` | Which way the model faces in the export |
| `--compress` | Compress geometry |

## Texturing: `zetta refine texture`

Repaints the texture from a reference picture, a description, or both.

| Flag | What it does |
|---|---|
| `--reference <picture>` | A file, URL or `image:<id>` showing the look you want |
| `--prompt "…"` | A description. It is turned into a reference picture first (needs image editing on your plan) |
| `--tier standard\|hd\|8k` | Texture resolution |
| `--alignment image\|geometry` | Follow the picture or the mesh |
| `--pbr` / `--no-pbr` | PBR materials |
| `--bake`, `--fast`, `--delight` | Bake lighting into the texture; faster standard tier; remove the reference's lighting |
| `--remove-bg` | Remove the reference picture's background first |
| `--part <name>`, `--seed N` | Only these parts; reproducible results |

```bash
zetta refine texture 1234 --reference oak.jpg --tier hd --yes --wait
zetta refine texture 1234 --prompt "brushed steel with scratches" --dry-run
```

## Rigging: `zetta refine rig`

Adds a skeleton so the model can be animated.

| Flag | What it does |
|---|---|
| `--rig-type biped\|quadruped\|hexapod\|octopod\|avian\|serpentine\|aquatic` | Body plan (default `biped`) |
| `--rig-spec standard\|mixamo` | Bone naming. Use `mixamo` for Mixamo animations |
| `--rig-format glb\|fbx` | File format of the rigged model |

Not sure which body plan? `zetta asset rig-check <id>` looks at the model and suggests one (for example `quadruped`, with a reason). Add `--frame <picture>` (up to 4) to give it your own renders instead of the thumbnail.

```bash
zetta asset rig-check 1234
zetta refine rig 1234 --rig-type quadruped --rig-format fbx --yes --out ./models
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
| `--quad`, `--symmetry`, `--faces N` | Quad topology, forced symmetry, face limit |
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
