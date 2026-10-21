# Command reference

_Generated from the command definitions by `bun run docs:commands`. Do not edit by hand._

Global flags: `--output text|json|ndjson`, `--json`, `--profile <name>`, `--api-url <url>`, `--verbose`, `--quiet`, `--no-color`, `--non-interactive`. Every command also takes `--input <json|@file|->`.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Unexpected error |
| 2 | Bad usage or failed local check (fix the input) |
| 3 | Not signed in, or the token expired (run `zetta auth login`) |
| 4 | Your plan or access does not allow this |
| 5 | Not enough credits, or over the spend limit |
| 6 | Not found |
| 7 | Conflict, or a concurrency limit was reached |
| 8 | Rate limited (after retries) |
| 9 | The remote job failed or was cancelled |
| 10 | Stopped waiting; the job is still running |
| 11 | Network or server error |

## auth

Sign in and out; see who you are signed in as.

### `zetta auth login`

Sign in to your Zetta 3D account.

Three ways to sign in:
    (default)        Opens zetta3d.ai in your browser; click Connect.
    --email <addr>   No browser needed: we email you a sign-in link; paste it back here.
    --with-token     Reads a token from stdin (for CI and agents). Get one with `zetta auth token` on a machine where you are signed in.
You can also skip signing in and set ZETTA_TOKEN.

```
zetta auth login [flags]
```

Kind: changes something (free) · not an MCP tool

| Argument / flag | Type | Description |
|---|---|---|
| `--email` | string | Sign in with an emailed link instead of the browser. |
| `--with-token` | boolean | Read a token from stdin. |
| `--link` | string | With --email: the link (or token) from the email, if you already have it. |
| `--print-url` | boolean | Print the sign-in address instead of opening a browser. |

Examples:

```bash
zetta auth login
zetta auth login --email you@example.com
echo "$ZETTA_TOKEN" | zetta auth login --with-token
```

### `zetta auth logout`

Forget the saved token for this profile.

Note: tokens cannot be revoked server-side yet, so a copied token keeps working until it expires.

```
zetta auth logout [flags]
```

Kind: changes something (free) · not an MCP tool

### `zetta auth status`

Show who you are signed in as, and where the token comes from.

```
zetta auth status [flags]
```

Kind: reads only · MCP tool `auth_status`

### `zetta auth token`

Print the saved token (to copy to CI or a machine without a browser).

Treat it like a password: anyone with it can use your account and credits until it expires.

```
zetta auth token [flags]
```

Kind: reads only · not an MCP tool

## account

Your account, credits, usage history and onboarding.

### `zetta account show`

Your account: email, plan, credits and access.

```
zetta account show [flags]
```

Kind: reads only · MCP tool `account_show`

### `zetta account credits`

Your credit balances, per pool.

3D credits pay for generations and finishing tools (1 credit = €0.01). AI tokens pay for AI helpers such as auto-tagging.

```
zetta account credits [flags]
```

Kind: reads only · MCP tool `account_credits`

### `zetta account usage`

Your credit history: what was charged and refunded.

```
zetta account usage [flags]
```

Kind: reads only · MCP tool `account_usage`

| Argument / flag | Type | Description |
|---|---|---|
| `--limit` | number | Entries per page (max 100). |
| `--before` | string | Show entries older than this cursor (the `nextCursor` of the previous page). |
| `--all` | boolean | Fetch every page. |

### `zetta account onboarding`

Answer the five onboarding questions and get the one-time credit bonus.

Answers use the ids the web onboarding uses. Calling it again is harmless; the bonus is paid once.

```
zetta account onboarding [flags]
```

Kind: changes something (free) · MCP tool `account_onboarding`

| Argument / flag | Type | Description |
|---|---|---|
| `--user-type` | `company` \| `startup` \| `personal` | Who you are. (**required**) |
| `--industry` | `gaming` \| `film` \| `ecommerce` \| `printing` \| `architecture` \| `interior` \| `fashion` \| `xr` \| `other` | Your industry. (**required**) |
| `--industry-other` | string | Your industry, when --industry is other. |
| `--tools` | string (repeatable) | 3D tools you use (ids as in the web onboarding, e.g. blender, max, c4d, zbrush, houdini, or none). (**required**) |
| `--engines` | string (repeatable) | Game engines you use (e.g. unity, unreal, godot, or none). (**required**) |
| `--heard-from` | `google` \| `word-of-mouth` \| `linkedin` \| `youtube` \| `x` \| `friend` \| `other` | Where you heard about Zetta 3D. |

### `zetta account early-access`

Ask for access to an early-access feature (e.g. splat).

```
zetta account early-access <feature> [flags]
```

Kind: changes something (free) · MCP tool `account_early_access`

| Argument / flag | Type | Description |
|---|---|---|
| `<feature>` | string | The feature to ask for, e.g. "Zetta Splat". (**required**) |
| `--email` | string | Where to reach you, if not your account email. |

### `zetta account delete`

Delete your account and everything in it. Cannot be undone.

Only works in a terminal, after typing your email to confirm. Cancel any subscription first (`zetta billing portal`).

```
zetta account delete [flags]
```

Kind: **destructive** · not an MCP tool

## billing

Plans, subscription, checkout and billing portal links.

### `zetta billing plans`

Plans, what each includes, and credit packs.

```
zetta billing plans [flags]
```

Kind: reads only · MCP tool `billing_plans`

### `zetta billing subscription`

Your subscription: plan, status and renewal date.

```
zetta billing subscription [flags]
```

Kind: reads only · MCP tool `billing_subscription`

### `zetta billing checkout`

Get a secure checkout link to buy a plan or a credit pack.

Payment happens on the hosted checkout page in your browser; this CLI never sees card details. An agent can hand the link to a person.

```
zetta billing checkout [plan] [flags]
```

Kind: changes something (free) · MCP tool `billing_checkout`

| Argument / flag | Type | Description |
|---|---|---|
| `<plan>` | string | Plan to subscribe to (e.g. basic, creator), or a raw price id. |
| `--yearly` | boolean | Pay yearly instead of monthly. |
| `--pack` | number | Buy the credit pack with this many credits instead of a plan. |

Examples:

```bash
zetta billing checkout creator
zetta billing checkout --pack 1000
```

### `zetta billing portal`

Get a link to manage your subscription, card and invoices.

```
zetta billing portal [flags]
```

Kind: changes something (free) · MCP tool `billing_portal`

## catalog

Engines, prices and what your plan allows.

### `zetta catalog engines`

The 3D, splat and image engines, and what each supports.

```
zetta catalog engines [flags]
```

Kind: reads only · MCP tool `catalog_engines`

| Argument / flag | Type | Description |
|---|---|---|
| `--images` | boolean | List the image engines available to your account instead (needs sign-in). |

### `zetta catalog pricing`

Credit price of every 3D option (1 credit = €0.01).

```
zetta catalog pricing [flags]
```

Kind: reads only · MCP tool `catalog_pricing`

### `zetta catalog entitlements`

What your plan allows: engines, multi-view, low-poly, quads, private models, concurrency.

```
zetta catalog entitlements [flags]
```

Kind: reads only · MCP tool `catalog_entitlements`

## splat

Gaussian-splat worlds from pictures or video (early access).

### `zetta splat create`

Make a Gaussian-splat object or world from pictures, a video, or a prompt (early access).

Engines: splat (an object or scene from one picture), splat2 and splat2.1 (whole worlds; also from a video, or several pictures of the same place).
More pictures of the same place: --world-view <azimuth>=<picture>, e.g. 90=right.jpg (degrees clockwise from the main picture).
Exports from a world: `zetta splat export <id> --as splat|mesh|collider`.

```
zetta splat create [flags]
```

Kind: **spends credits** · MCP tool `splat_create`

| Argument / flag | Type | Description |
|---|---|---|
| `--image` | string | The main picture: a file, URL or image:<id>. |
| `--video` | string | A video of the place (splat2/2.1): MP4, WebM, MOV or AVI up to 100 MB. |
| `--prompt` | string | Describe the scene. Without a picture, a picture is made from it first. |
| `--engine` | string | splat (default), splat2 or splat2.1. |
| `--subject` | `object` \| `environment` | An object, or an environment (changes how a prompt picture is framed). |
| `--world-view` | string (repeatable) | Extra pictures of the same place as azimuth=picture (splat2/2.1). |
| `--same-space` | boolean | Reconstruct from all pictures together (up to 8). |
| `--seed` | number | Seed (splat engine only). |
| `--title` | string | Title in your library. |
| `--tag` | string (repeatable) | Tags. |
| `--visibility` | `public` \| `private` | Share publicly, or keep private. |
| `--format` | string (repeatable) | When downloading: only these formats (ply, spz, glb …). |
| `--yes` | boolean | Spend without asking. Needed when not in a terminal, unless --max-credits covers the price. |
| `--max-credits` | number | Refuse if this would cost more than this many credits. |
| `--dry-run` | boolean | Show the price and stop. Nothing is spent. |
| `--idempotency-key` | string | Reuse the same key to retry a command without paying twice. |
| `--wait` | boolean | Wait for the job to finish (default: return at once with its id, unless it downloads automatically). |
| `--timeout` | string | Stop waiting after this long, e.g. 90s, 10m. The job keeps running. |
| `--out` | string | Download the results into this folder when done (implies --wait). |
| `--download` | boolean | Wait, then download the results into the current folder (default: the download.auto setting, which is on in a terminal). --no-download returns at once. |

Examples:

```bash
zetta splat create --image room.jpg --engine splat2 --dry-run
zetta splat create --video walkthrough.mp4 --engine splat2.1 --yes --wait
```

### `zetta splat export`

Export a splat world as a PLY splat, a mesh, or a collider mesh.

```
zetta splat export <id> [flags]
```

Kind: **spends credits** · MCP tool `splat_export`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | A Zetta Splat 2 / 2.1 world in your library. (**required**) |
| `--as` | `splat` \| `mesh` \| `collider` | What to export. (**required**) |
| `--resolution` | `full_res` \| `500k` \| `150k` \| `100k` | With --as splat: how many splats (default full_res). |
| `--mesh-variant` | `textured` \| `vertex_colored` | With --as mesh: textured (default) or vertex_colored. |
| `--title` | string | Title of the export. |
| `--format` | string (repeatable) | When downloading: only these formats. |
| `--yes` | boolean | Spend without asking. Needed when not in a terminal, unless --max-credits covers the price. |
| `--max-credits` | number | Refuse if this would cost more than this many credits. |
| `--dry-run` | boolean | Show the price and stop. Nothing is spent. |
| `--idempotency-key` | string | Reuse the same key to retry a command without paying twice. |
| `--wait` | boolean | Wait for the job to finish (default: return at once with its id, unless it downloads automatically). |
| `--timeout` | string | Stop waiting after this long, e.g. 90s, 10m. The job keeps running. |
| `--out` | string | Download the results into this folder when done (implies --wait). |
| `--download` | boolean | Wait, then download the results into the current folder (default: the download.auto setting, which is on in a terminal). --no-download returns at once. |

Examples:

```bash
zetta splat export 1234 --as collider --yes --out ./unity/Assets
```

## refine

Finishing tools: retopology, segmentation, UVs, texturing, rigging, conversion.

### `zetta refine retopo`

Rebuild a model’s topology to a clean, lower polygon count.

Engine r1 (default) takes an exact --faces budget; n1 takes a --face-level.

```
zetta refine retopo <source> [flags]
```

Kind: **spends credits** · MCP tool `refine_retopo`

| Argument / flag | Type | Description |
|---|---|---|
| `<source>` | string | The model: an asset id, a local .glb file, or a URL to a .glb/.obj/.fbx. (**required**) |
| `--title` | string | Title of the new asset. |
| `--tag` | string (repeatable) | Tags for the new asset. |
| `--visibility` | `public` \| `private` | Share publicly, or keep private. |
| `--format` | string (repeatable) | When downloading: only these formats. |
| `--yes` | boolean | Spend without asking. Needed when not in a terminal, unless --max-credits covers the price. |
| `--max-credits` | number | Refuse if this would cost more than this many credits. |
| `--dry-run` | boolean | Show the price and stop. Nothing is spent. |
| `--idempotency-key` | string | Reuse the same key to retry a command without paying twice. |
| `--wait` | boolean | Wait for the job to finish (default: return at once with its id, unless it downloads automatically). |
| `--timeout` | string | Stop waiting after this long, e.g. 90s, 10m. The job keeps running. |
| `--out` | string | Download the results into this folder when done (implies --wait). |
| `--download` | boolean | Wait, then download the results into the current folder (default: the download.auto setting, which is on in a terminal). --no-download returns at once. |
| `--engine` | `r1` \| `n1` | Retopology engine (default r1). |
| `--faces` | number | Target faces (r1): 500–20,000 triangles or 500–10,000 quads. Default 8,000. |
| `--face-level` | `low` \| `medium` \| `high` | Density (n1). |
| `--quads` | boolean | Quad topology. |
| `--bake` | boolean | Bake the original detail into the new model’s textures. |
| `--part` | string (repeatable) | Only these named parts of a segmented model. |

Examples:

```bash
zetta refine retopo 1234 --faces 5000 --quads --yes --wait
zetta refine retopo ./scan.glb --engine n1 --face-level low --dry-run
```

### `zetta refine segment`

Split a model into separate parts.

--smart uses the smarter segmentation (optionally guided by --prompt).

```
zetta refine segment <source> [flags]
```

Kind: **spends credits** · MCP tool `refine_segment`

| Argument / flag | Type | Description |
|---|---|---|
| `<source>` | string | The model: an asset id, a local .glb file, or a URL to a .glb/.obj/.fbx. (**required**) |
| `--title` | string | Title of the new asset. |
| `--tag` | string (repeatable) | Tags for the new asset. |
| `--visibility` | `public` \| `private` | Share publicly, or keep private. |
| `--format` | string (repeatable) | When downloading: only these formats. |
| `--yes` | boolean | Spend without asking. Needed when not in a terminal, unless --max-credits covers the price. |
| `--max-credits` | number | Refuse if this would cost more than this many credits. |
| `--dry-run` | boolean | Show the price and stop. Nothing is spent. |
| `--idempotency-key` | string | Reuse the same key to retry a command without paying twice. |
| `--wait` | boolean | Wait for the job to finish (default: return at once with its id, unless it downloads automatically). |
| `--timeout` | string | Stop waiting after this long, e.g. 90s, 10m. The job keeps running. |
| `--out` | string | Download the results into this folder when done (implies --wait). |
| `--download` | boolean | Wait, then download the results into the current folder (default: the download.auto setting, which is on in a terminal). --no-download returns at once. |
| `--smart` | boolean | Smart segmentation (better parts, costs more). |
| `--granularity` | `simple` \| `balanced` \| `detailed` | How finely to split. |
| `--split-by-connectivity` | boolean | Split disconnected pieces apart (default on; --no-split-by-connectivity to turn off). |
| `--prompt` | string | With --smart: which parts you want, e.g. "seat, legs, backrest". |

### `zetta refine uv`

Unwrap clean UVs (Smart UV). Max 80,000 triangles.

```
zetta refine uv <source> [flags]
```

Kind: **spends credits** · MCP tool `refine_uv`

| Argument / flag | Type | Description |
|---|---|---|
| `<source>` | string | The model: an asset id, a local .glb file, or a URL to a .glb/.obj/.fbx. (**required**) |
| `--title` | string | Title of the new asset. |
| `--tag` | string (repeatable) | Tags for the new asset. |
| `--visibility` | `public` \| `private` | Share publicly, or keep private. |
| `--format` | string (repeatable) | When downloading: only these formats. |
| `--yes` | boolean | Spend without asking. Needed when not in a terminal, unless --max-credits covers the price. |
| `--max-credits` | number | Refuse if this would cost more than this many credits. |
| `--dry-run` | boolean | Show the price and stop. Nothing is spent. |
| `--idempotency-key` | string | Reuse the same key to retry a command without paying twice. |
| `--wait` | boolean | Wait for the job to finish (default: return at once with its id, unless it downloads automatically). |
| `--timeout` | string | Stop waiting after this long, e.g. 90s, 10m. The job keeps running. |
| `--out` | string | Download the results into this folder when done (implies --wait). |
| `--download` | boolean | Wait, then download the results into the current folder (default: the download.auto setting, which is on in a terminal). --no-download returns at once. |
| `--bake` | boolean | Bake the existing texture onto the new UVs. |
| `--orientation` | `as-is` \| `+x` \| `-x` \| `+y` \| `-y` | Which way the model faces in the export. |
| `--compress` | boolean | Compress geometry. |

### `zetta refine texture`

Repaint a model’s texture from a reference picture or a description.

Give --reference (a picture of the look you want), --prompt (a description), or both.
A description is turned into a reference picture first (needs image editing on your plan).

```
zetta refine texture <source> [flags]
```

Kind: **spends credits** · MCP tool `refine_texture`

| Argument / flag | Type | Description |
|---|---|---|
| `<source>` | string | The model: an asset id, a local .glb file, or a URL to a .glb/.obj/.fbx. (**required**) |
| `--title` | string | Title of the new asset. |
| `--tag` | string (repeatable) | Tags for the new asset. |
| `--visibility` | `public` \| `private` | Share publicly, or keep private. |
| `--format` | string (repeatable) | When downloading: only these formats. |
| `--yes` | boolean | Spend without asking. Needed when not in a terminal, unless --max-credits covers the price. |
| `--max-credits` | number | Refuse if this would cost more than this many credits. |
| `--dry-run` | boolean | Show the price and stop. Nothing is spent. |
| `--idempotency-key` | string | Reuse the same key to retry a command without paying twice. |
| `--wait` | boolean | Wait for the job to finish (default: return at once with its id, unless it downloads automatically). |
| `--timeout` | string | Stop waiting after this long, e.g. 90s, 10m. The job keeps running. |
| `--out` | string | Download the results into this folder when done (implies --wait). |
| `--download` | boolean | Wait, then download the results into the current folder (default: the download.auto setting, which is on in a terminal). --no-download returns at once. |
| `--reference` | string | Reference picture: a file, URL or image:<id>. |
| `--prompt` | string | Describe the look, e.g. "weathered bronze with green patina". |
| `--tier` | `standard` \| `hd` \| `8k` | Texture resolution tier. |
| `--alignment` | `image` \| `geometry` | Follow the picture or the mesh. |
| `--pbr` | boolean | PBR materials. |
| `--bake` | boolean | Bake lighting effects into the base texture. |
| `--fast` | boolean | Faster standard tier. |
| `--delight` | boolean | Remove lighting from the reference first. |
| `--remove-bg` | boolean | Remove the reference picture’s background first. |
| `--part` | string (repeatable) | Only these named parts. |
| `--seed` | number | Texture seed. |

Examples:

```bash
zetta refine texture 1234 --reference oak.jpg --tier hd --yes
zetta refine texture 1234 --prompt "brushed steel" --dry-run
```

### `zetta refine rig`

Add a skeleton so the model can be animated.

Not sure which --rig-type? Run `zetta asset rig-check <id>` first. --rig-spec mixamo names bones for Mixamo animations.

```
zetta refine rig <source> [flags]
```

Kind: **spends credits** · MCP tool `refine_rig`

| Argument / flag | Type | Description |
|---|---|---|
| `<source>` | string | The model: an asset id, a local .glb file, or a URL to a .glb/.obj/.fbx. (**required**) |
| `--title` | string | Title of the new asset. |
| `--tag` | string (repeatable) | Tags for the new asset. |
| `--visibility` | `public` \| `private` | Share publicly, or keep private. |
| `--format` | string (repeatable) | When downloading: only these formats. |
| `--yes` | boolean | Spend without asking. Needed when not in a terminal, unless --max-credits covers the price. |
| `--max-credits` | number | Refuse if this would cost more than this many credits. |
| `--dry-run` | boolean | Show the price and stop. Nothing is spent. |
| `--idempotency-key` | string | Reuse the same key to retry a command without paying twice. |
| `--wait` | boolean | Wait for the job to finish (default: return at once with its id, unless it downloads automatically). |
| `--timeout` | string | Stop waiting after this long, e.g. 90s, 10m. The job keeps running. |
| `--out` | string | Download the results into this folder when done (implies --wait). |
| `--download` | boolean | Wait, then download the results into the current folder (default: the download.auto setting, which is on in a terminal). --no-download returns at once. |
| `--rig-type` | `biped` \| `quadruped` \| `hexapod` \| `octopod` \| `avian` \| `serpentine` \| `aquatic` | Body plan (default biped). |
| `--rig-spec` | `standard` \| `mixamo` | Bone naming (default standard). |
| `--rig-format` | `glb` \| `fbx` | File format of the rigged model (default glb). |

Examples:

```bash
zetta refine rig 1234 --rig-type quadruped --rig-format fbx --yes --out .
```

### `zetta refine convert`

Convert to FBX, USDZ, OBJ, STL, 3MF or glTF on the server, with optional clean-up.

For a quick, free GLB → OBJ/STL on your own machine, use `zetta asset export`. Geometry or texture options switch to the advanced (pricier) tier.

```
zetta refine convert <source> [flags]
```

Kind: **spends credits** · MCP tool `refine_convert`

| Argument / flag | Type | Description |
|---|---|---|
| `<source>` | string | The model: an asset id, a local .glb file, or a URL to a .glb/.obj/.fbx. (**required**) |
| `--title` | string | Title of the new asset. |
| `--tag` | string (repeatable) | Tags for the new asset. |
| `--visibility` | `public` \| `private` | Share publicly, or keep private. |
| `--format` | string (repeatable) | When downloading: only these formats. |
| `--yes` | boolean | Spend without asking. Needed when not in a terminal, unless --max-credits covers the price. |
| `--max-credits` | number | Refuse if this would cost more than this many credits. |
| `--dry-run` | boolean | Show the price and stop. Nothing is spent. |
| `--idempotency-key` | string | Reuse the same key to retry a command without paying twice. |
| `--wait` | boolean | Wait for the job to finish (default: return at once with its id, unless it downloads automatically). |
| `--timeout` | string | Stop waiting after this long, e.g. 90s, 10m. The job keeps running. |
| `--out` | string | Download the results into this folder when done (implies --wait). |
| `--download` | boolean | Wait, then download the results into the current folder (default: the download.auto setting, which is on in a terminal). --no-download returns at once. |
| `--to` | string | Target format: GLTF, FBX, USDZ, OBJ, STL, 3MF (any case). (**required**) |
| `--quad` | boolean | Quad topology. |
| `--symmetry` | boolean | Force symmetry. |
| `--faces` | number | Face limit. |
| `--flatten-bottom` | boolean | Flatten the base (for printing or placing). |
| `--flatten-threshold` | number | How much of the base to flatten. |
| `--texture-size` | number | Texture size in pixels (128–4096). |
| `--texture-format` | string | Texture image format: JPEG, PNG, WEBP, BMP, DPX, HDR, OPEN_EXR, TARGA, TIFF (any case). |
| `--pack-uv` | boolean | Pack UVs. |
| `--vertex-colors` | boolean | Export vertex colours. |
| `--pivot-bottom` | boolean | Put the pivot at the bottom centre. |
| `--scale` | number | Scale factor. |
| `--with-animation` | boolean | Keep animation. |
| `--in-place` | boolean | Animate in place. |
| `--orientation` | `+x` \| `-x` \| `-y` \| `+y` | Forward axis. |
| `--fbx-preset` | `blender` \| `3dsmax` \| `mixamo` | FBX preset for a target app. |

Examples:

```bash
zetta refine convert 1234 --to usdz --yes --out .
zetta refine convert 1234 --to fbx --fbx-preset blender --dry-run
```

## asset

Your 3D library: list, inspect, wait, download, share, delete, import.

### `zetta asset export`

Convert a GLB to OBJ, FBX (both with materials and textures) or STL, locally and for free.

Works on a library asset or a local .glb file. For USDZ, 3MF or clean-up options, use `zetta refine convert` (server-side). Compressed geometry is refused here; convert those on the server.

```
zetta asset export <source> [flags]
```

Kind: reads only · MCP tool `asset_export`

| Argument / flag | Type | Description |
|---|---|---|
| `<source>` | string | An asset id, or a local .glb file. (**required**) |
| `--format` | `obj` \| `fbx` \| `stl` | Target format. (**required**) |
| `--fbx-preset` | `unity` \| `unreal` \| `blender` \| `maya` \| `threejs` | With --format fbx: axes and units for this app (default unity). |
| `--out` | string | Folder to save into (default: the current folder, or the download.dir setting). |

Examples:

```bash
zetta asset export 1234 --format stl --out ./print
zetta asset export ./chair.glb --format obj
zetta asset export 1234 --format fbx --fbx-preset blender
```

### `zetta asset list`

List your 3D library (newest first).

```
zetta asset list [flags]
```

Kind: reads only · MCP tool `asset_list`

| Argument / flag | Type | Description |
|---|---|---|
| `--page` | number | Page number (starts at 1). |
| `--limit` | number | Items per page (max 100). |
| `--status` | string (repeatable) | Only these statuses. |
| `--kind` | string | Only this kind, e.g. img23d, txt23d, retopology, autoRigging, imageToSplat. |
| `--search` | string | Search titles, tags and prompts. |
| `--visibility` | `public` \| `private` | Only shared (public) or private items. |
| `--oldest-first` | boolean | Oldest first. |

Examples:

```bash
zetta asset list --limit 10
zetta asset list --status processing --status queued
zetta asset list --search chair --json
```

### `zetta asset get`

Show one asset: status, queue position, files.

```
zetta asset get <id> [flags]
```

Kind: reads only · MCP tool `asset_get`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | The asset id (shown by `zetta asset list`). (**required**) |
| `--public` | boolean | Read a shared asset of anyone (no sign-in needed). |

### `zetta asset wait`

Wait until an asset finishes (success, failed or cancelled).

Exits 0 on success, 9 if the job failed or was cancelled, 10 if --timeout passed first (the job keeps running). With the download.auto setting on (the default in a terminal), the results download into the current folder.

```
zetta asset wait <id> [flags]
```

Kind: reads only · MCP tool `asset_wait`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | The asset id (shown by `zetta asset list`). (**required**) |
| `--timeout` | string | Stop waiting after this long, e.g. 90s, 10m. |
| `--out` | string | Download the results into this folder when done. |
| `--download` | boolean | Download the results into the current folder (default: the download.auto setting). --no-download only waits. |
| `--format` | string (repeatable) | When downloading: only these formats (glb, fbx, obj, usdz, …). |

Examples:

```bash
zetta asset wait 1234 --timeout 9m
zetta asset wait 1234 --out ./models --format glb
```

### `zetta asset download`

Download an asset’s result files.

Without --format, every result file is downloaded. --primary keeps only the best model file (GLB, then FBX, glTF, OBJ).

```
zetta asset download <id> [flags]
```

Kind: reads only · MCP tool `asset_download`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | The asset id (shown by `zetta asset list`). (**required**) |
| `--out` | string | Folder to save into (default: the current folder, or the download.dir setting). |
| `--format` | string (repeatable) | Only these formats, e.g. glb, fbx, obj, usdz, ply. |
| `--primary` | boolean | Only the single best model file. |
| `--overwrite` | boolean | Replace existing files instead of adding -2, -3 … |

Examples:

```bash
zetta asset download 1234 --out ./models
zetta asset download 1234 --format fbx
```

### `zetta asset rename`

Give an asset a title.

```
zetta asset rename <id> <title> [flags]
```

Kind: changes something (free) · MCP tool `asset_rename`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | The asset id (shown by `zetta asset list`). (**required**) |
| `<title>` | string | The new title. (**required**) |

### `zetta asset tag`

Set, add or remove an asset’s tags.

```
zetta asset tag <id> [flags]
```

Kind: changes something (free) · MCP tool `asset_tag`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | The asset id (shown by `zetta asset list`). (**required**) |
| `--set` | string (repeatable) | Replace all tags with these. |
| `--add` | string (repeatable) | Add these tags. |
| `--remove` | string (repeatable) | Remove these tags. |

Examples:

```bash
zetta asset tag 1234 --add chair --add wood
zetta asset tag 1234 --set prop,interior
```

### `zetta asset share`

Make an asset public and get its share link.

```
zetta asset share <id> [flags]
```

Kind: changes something (free) · MCP tool `asset_share`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | The asset id (shown by `zetta asset list`). (**required**) |

### `zetta asset unshare`

Make an asset private again (needs a paid plan).

```
zetta asset unshare <id> [flags]
```

Kind: changes something (free) · MCP tool `asset_unshare`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | The asset id (shown by `zetta asset list`). (**required**) |

### `zetta asset cancel`

Cancel a job that has not started yet (full refund).

```
zetta asset cancel <id> [flags]
```

Kind: **destructive** · MCP tool `asset_cancel`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | The asset id (shown by `zetta asset list`). (**required**) |

### `zetta asset delete`

Delete assets and their files.

A job that is still running is not refunded. In a terminal you are asked first; otherwise pass --yes.

```
zetta asset delete <ids...> [flags]
```

Kind: **destructive** · MCP tool `asset_delete`

| Argument / flag | Type | Description |
|---|---|---|
| `<ids>` | number (repeatable) | Asset ids. (**required**) |
| `--yes` | boolean | Delete without asking. |

### `zetta asset import`

Upload your own GLB model into the library (free).

The imported model can then go through any finishing tool: `zetta refine retopo <id>` …

```
zetta asset import <file> [flags]
```

Kind: changes something (free) · MCP tool `asset_import`

| Argument / flag | Type | Description |
|---|---|---|
| `<file>` | string | A .glb file. (**required**) |
| `--title` | string | Title in the library (default: the file name). |

### `zetta asset auto-tag`

Suggest a category and tags for an asset with AI (uses AI tokens).

Looks at the asset’s thumbnail, or at up to 4 pictures you pass with --frame. Add --apply to save the tags.

```
zetta asset auto-tag <id> [flags]
```

Kind: changes something (free) · MCP tool `asset_auto_tag`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | The asset id (shown by `zetta asset list`). (**required**) |
| `--frame` | string (repeatable) | Pictures of the model (1–4) to look at instead of the thumbnail. |
| `--apply` | boolean | Save the suggested tags on the asset. |

### `zetta asset rig-check`

Guess which skeleton an asset needs before rigging it.

```
zetta asset rig-check <id> [flags]
```

Kind: reads only · MCP tool `asset_rig_check`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | The asset id (shown by `zetta asset list`). (**required**) |
| `--frame` | string (repeatable) | Pictures of the model (1–4) instead of the thumbnail. |

### `zetta asset featured`

Featured public assets from the community.

```
zetta asset featured [flags]
```

Kind: reads only · MCP tool `asset_featured`

| Argument / flag | Type | Description |
|---|---|---|
| `--limit` | number | How many. |

## image

Image Studio: generate, edit, compose pictures; remove backgrounds.

### `zetta image generate`

Make a picture from a text prompt.

Use --for-3d to get a square picture ready for `zetta generate --image`.

```
zetta image generate [flags]
```

Kind: changes something (free) · MCP tool `image_generate`

| Argument / flag | Type | Description |
|---|---|---|
| `--prompt` | string | What to draw. (**required**) |
| `--aspect-ratio` | `9:16` \| `2:3` \| `3:4` \| `4:5` \| `1:1` \| `5:4` \| `4:3` \| `3:2` \| `16:9` \| `21:9` | Aspect ratio. |
| `--resolution` | `1K` \| `2K` \| `4K` | Resolution (4K needs a paid plan). |
| `--engine` | string | Image engine by name: flash (default) or pro. See `zetta catalog engines --images`. |
| `--out` | string | Folder to save the picture(s) into (default: the current folder, or the download.dir setting). |
| `--download` | boolean | Save the picture(s) (default: on, unless the download.auto setting is false). --no-download keeps them in your image library only. |
| `--for3d` | boolean | A clean, square picture made to be turned into 3D. |
| `--subject` | `object` \| `environment` | An object, or a whole environment. |
| `--fast` | boolean | Faster, lighter generation. |
| `--style` | string (repeatable) | Up to 3 style reference pictures (files). |

Examples:

```bash
zetta image generate -p "a red vintage armchair, studio light" --for-3d --out ./refs
```

### `zetta image edit`

Change a picture with an instruction (needs a paid plan).

```
zetta image edit <image> [flags]
```

Kind: changes something (free) · MCP tool `image_edit`

| Argument / flag | Type | Description |
|---|---|---|
| `<image>` | string | The picture: a file, a URL, or image:<id> from your image library. (**required**) |
| `--prompt` | string | What to change. (**required**) |
| `--aspect-ratio` | `9:16` \| `2:3` \| `3:4` \| `4:5` \| `1:1` \| `5:4` \| `4:3` \| `3:2` \| `16:9` \| `21:9` | Aspect ratio. |
| `--resolution` | `1K` \| `2K` \| `4K` | Resolution (4K needs a paid plan). |
| `--engine` | string | Image engine by name: flash (default) or pro. See `zetta catalog engines --images`. |
| `--out` | string | Folder to save the picture(s) into (default: the current folder, or the download.dir setting). |
| `--download` | boolean | Save the picture(s) (default: on, unless the download.auto setting is false). --no-download keeps them in your image library only. |

Examples:

```bash
zetta image edit ./chair.png -p "make it dark green velvet"
```

### `zetta image compose`

Combine 2–14 pictures into one, following a prompt.

```
zetta image compose <images...> [flags]
```

Kind: changes something (free) · MCP tool `image_compose`

| Argument / flag | Type | Description |
|---|---|---|
| `<images>` | string (repeatable) | Pictures: files, URLs or image:<id>. (**required**) |
| `--prompt` | string | How to combine them. (**required**) |
| `--aspect-ratio` | `9:16` \| `2:3` \| `3:4` \| `4:5` \| `1:1` \| `5:4` \| `4:3` \| `3:2` \| `16:9` \| `21:9` | Aspect ratio. |
| `--resolution` | `1K` \| `2K` \| `4K` | Resolution (4K needs a paid plan). |
| `--engine` | string | Image engine by name: flash (default) or pro. See `zetta catalog engines --images`. |
| `--out` | string | Folder to save the picture(s) into (default: the current folder, or the download.dir setting). |
| `--download` | boolean | Save the picture(s) (default: on, unless the download.auto setting is false). --no-download keeps them in your image library only. |

Examples:

```bash
zetta image compose sofa.png lamp.png rug.png -p "a cosy living room with these items"
```

### `zetta image list`

List your image library (newest first).

```
zetta image list [flags]
```

Kind: reads only · MCP tool `image_list`

| Argument / flag | Type | Description |
|---|---|---|
| `--page` | number | Page number (starts at 1). |
| `--limit` | number | Items per page (max 100). |
| `--kind` | `generate` \| `edit` \| `compose` | Only this kind. |
| `--search` | string | Search prompts. |

### `zetta image get`

Show one picture set from your image library.

```
zetta image get <id> [flags]
```

Kind: reads only · MCP tool `image_get`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | Image id (from `zetta image list`). (**required**) |

### `zetta image download`

Download the pictures of an image-library entry.

```
zetta image download <id> [flags]
```

Kind: reads only · MCP tool `image_download`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | Image id. (**required**) |
| `--out` | string | Folder to save into (default: the current folder, or the download.dir setting). |

### `zetta image delete`

Delete image-library entries.

```
zetta image delete <ids...> [flags]
```

Kind: **destructive** · MCP tool `image_delete`

| Argument / flag | Type | Description |
|---|---|---|
| `<ids>` | number (repeatable) | Image ids. (**required**) |
| `--yes` | boolean | Delete without asking. |

### `zetta image remove-bg`

Remove the background from a picture (saves a PNG).

```
zetta image remove-bg <file> [flags]
```

Kind: changes something (free) · MCP tool `image_remove_bg`

| Argument / flag | Type | Description |
|---|---|---|
| `<file>` | string | A PNG, JPEG or WebP picture (max 8 MB). (**required**) |
| `--out` | string | Where to save the PNG (default: <name>-nobg.png next to the input). |

## pipeline

Saved multi-step recipes: create, validate, estimate, run, batch.

### `zetta pipeline list`

List your pipelines.

```
zetta pipeline list [flags]
```

Kind: reads only · MCP tool `pipeline_list`

### `zetta pipeline get`

Show a pipeline as an editable recipe (YAML in a terminal).

Save it with `zetta pipeline get <id> --output text > recipe.yaml`, edit, then `zetta pipeline update <id> --file recipe.yaml`. --raw gives the stored graph.

```
zetta pipeline get <id> [flags]
```

Kind: reads only · MCP tool `pipeline_get`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | Pipeline id (from `zetta pipeline list`). (**required**) |
| `--raw` | boolean | The stored graph instead of the recipe. |

### `zetta pipeline schema`

The recipe format: JSON Schema, every step kind with its settings, and examples.

```
zetta pipeline schema [flags]
```

Kind: local only · not an MCP tool

### `zetta pipeline validate`

Check a recipe file (or a saved pipeline) without saving or spending anything.

```
zetta pipeline validate <target> [flags]
```

Kind: reads only · MCP tool `pipeline_validate`

| Argument / flag | Type | Description |
|---|---|---|
| `<target>` | string | A recipe file (.yaml/.json) or a pipeline id. (**required**) |

### `zetta pipeline estimate`

Price one run of a pipeline (or a recipe file), step by step.

```
zetta pipeline estimate <target> [flags]
```

Kind: reads only · MCP tool `pipeline_estimate`

| Argument / flag | Type | Description |
|---|---|---|
| `<target>` | string | A pipeline id or a recipe file. (**required**) |
| `--seeds` | number | Multiply by this many runs. |

### `zetta pipeline create`

Save a new pipeline from a recipe file (see `zetta pipeline schema`).

```
zetta pipeline create [flags]
```

Kind: changes something (free) · MCP tool `pipeline_create`

| Argument / flag | Type | Description |
|---|---|---|
| `--file` | string | Recipe file (.yaml or .json): the friendly format, or a raw graph. (**required**) |
| `--title` | string | Title (overrides the file’s). |

Examples:

```bash
zetta pipeline create --file product-to-rig.yaml
```

### `zetta pipeline update`

Replace a pipeline’s steps from a recipe file, or rename it.

```
zetta pipeline update <id> [flags]
```

Kind: changes something (free) · MCP tool `pipeline_update`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | Pipeline id (from `zetta pipeline list`). (**required**) |
| `--file` | string | Recipe file with the new steps. |
| `--title` | string | New title. |

### `zetta pipeline duplicate`

Copy a pipeline.

```
zetta pipeline duplicate <id> [flags]
```

Kind: changes something (free) · MCP tool `pipeline_duplicate`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | Pipeline id (from `zetta pipeline list`). (**required**) |

### `zetta pipeline delete`

Delete a pipeline (its finished models stay in your library).

```
zetta pipeline delete <id> [flags]
```

Kind: **destructive** · MCP tool `pipeline_delete`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | Pipeline id (from `zetta pipeline list`). (**required**) |
| `--yes` | boolean | Delete without asking. |

### `zetta pipeline runs`

Recent runs of a pipeline.

```
zetta pipeline runs <id> [flags]
```

Kind: reads only · MCP tool `pipeline_runs`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | Pipeline id (from `zetta pipeline list`). (**required**) |

### `zetta pipeline run`

Run a pipeline on one seed (a picture or a model).

Returns at once with the run id, unless the final models download: with the download.auto setting on (the default in a terminal), or with --wait, --out or --download, it waits for the run and saves them. --no-wait returns at once.

```
zetta pipeline run <id> <seed> [flags]
```

Kind: **spends credits** · MCP tool `pipeline_run`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | Pipeline id (from `zetta pipeline list`). (**required**) |
| `<seed>` | string | A picture file, image:<id>, an asset id, or a .glb. (**required**) |
| `--mode` | `auto` \| `manual` | auto runs every step; manual waits for you to run each step. (default `auto`) |
| `--draft` | boolean | Create the runs as drafts: give per-run inputs (`zetta run set-input`), then `zetta run start`. |
| `--yes` | boolean | Spend without asking. Needed when not in a terminal, unless --max-credits covers the price. |
| `--max-credits` | number | Refuse if this would cost more than this many credits. |
| `--dry-run` | boolean | Show the price and stop. Nothing is spent. |
| `--idempotency-key` | string | Reuse the same key to retry a command without paying twice. |
| `--wait` | boolean | Wait for the job to finish (default: return at once with its id, unless it downloads automatically). |
| `--timeout` | string | Stop waiting after this long, e.g. 90s, 10m. The job keeps running. |
| `--out` | string | Download the results into this folder when done (implies --wait). |
| `--download` | boolean | Wait, then download the results into the current folder (default: the download.auto setting, which is on in a terminal). --no-download returns at once. |

Examples:

```bash
zetta pipeline run 12 ./shoe.jpg --max-credits 300
```

### `zetta pipeline batch`

Run a pipeline once per seed: many pictures, a folder, or several assets.

More than 20 seeds are sent in several batches. The total price is checked against --max-credits first. Downloads work as for `pipeline run`: every run is waited for, then its final models are saved.

```
zetta pipeline batch <id> <seeds...> [flags]
```

Kind: **spends credits** · MCP tool `pipeline_batch`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | Pipeline id (from `zetta pipeline list`). (**required**) |
| `<seeds>` | string (repeatable) | Pictures, folders, asset ids or image:<id>. (**required**) |
| `--mode` | `auto` \| `manual` | auto runs every step; manual waits for you to run each step. (default `auto`) |
| `--draft` | boolean | Create the runs as drafts: give per-run inputs (`zetta run set-input`), then `zetta run start`. |
| `--yes` | boolean | Spend without asking. Needed when not in a terminal, unless --max-credits covers the price. |
| `--max-credits` | number | Refuse if this would cost more than this many credits. |
| `--dry-run` | boolean | Show the price and stop. Nothing is spent. |
| `--idempotency-key` | string | Reuse the same key to retry a command without paying twice. |
| `--wait` | boolean | Wait for the job to finish (default: return at once with its id, unless it downloads automatically). |
| `--timeout` | string | Stop waiting after this long, e.g. 90s, 10m. The job keeps running. |
| `--out` | string | Download the results into this folder when done (implies --wait). |
| `--download` | boolean | Wait, then download the results into the current folder (default: the download.auto setting, which is on in a terminal). --no-download returns at once. |

Examples:

```bash
zetta pipeline batch 12 ./photos --max-credits 3000
zetta pipeline batch 12 a.jpg b.jpg c.jpg --draft
```

## run

Pipeline runs: watch, start, pause, retry steps, collect outputs.

### `zetta run get`

Show a pipeline run: every step, its status and its asset.

```
zetta run get <id> [flags]
```

Kind: reads only · MCP tool `run_get`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | Run id (from `zetta pipeline runs <id>` or a batch result). (**required**) |

### `zetta run wait`

Wait until a run finishes, or needs you (review, manual step, draft input).

Exits 0 when done or waiting on you (see `blocked`), 9 if it failed or was cancelled, 10 if --timeout passed first. With the download.auto setting on (the default in a terminal), the final models download into the current folder.

```
zetta run wait <id> [flags]
```

Kind: reads only · MCP tool `run_wait`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | Run id (from `zetta pipeline runs <id>` or a batch result). (**required**) |
| `--timeout` | string | Stop waiting after this long, e.g. 90s, 10m. |
| `--out` | string | When done, download every output into this folder. |
| `--download` | boolean | When done, download the final models into the current folder (default: the download.auto setting). --no-download only waits. |

### `zetta run outputs`

Download every model a run produced.

```
zetta run outputs <id> [flags]
```

Kind: reads only · MCP tool `run_outputs`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | Run id (from `zetta pipeline runs <id>` or a batch result). (**required**) |
| `--out` | string | Folder to save into (default: the current folder, or the download.dir setting). |
| `--format` | string (repeatable) | Only these formats (glb, fbx, …). |
| `--final-only` | boolean | Only the last step of each branch. |

### `zetta run start`

Start a draft run (after its per-run inputs are set).

```
zetta run start <id> [flags]
```

Kind: **spends credits** · MCP tool `run_start`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | Run id (from `zetta pipeline runs <id>` or a batch result). (**required**) |
| `--yes` | boolean | Spend without asking. Needed when not in a terminal, unless --max-credits covers the price. |
| `--max-credits` | number | Refuse if this would cost more than this many credits. |
| `--dry-run` | boolean | Show the price and stop. Nothing is spent. |
| `--idempotency-key` | string | Reuse the same key to retry a command without paying twice. |

### `zetta run pause`

Pause a run after the steps already running.

```
zetta run pause <id> [flags]
```

Kind: changes something (free) · MCP tool `run_pause`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | Run id (from `zetta pipeline runs <id>` or a batch result). (**required**) |

### `zetta run resume`

Resume a paused run.

```
zetta run resume <id> [flags]
```

Kind: **spends credits** · MCP tool `run_resume`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | Run id (from `zetta pipeline runs <id>` or a batch result). (**required**) |
| `--yes` | boolean | Spend without asking. Needed when not in a terminal, unless --max-credits covers the price. |
| `--max-credits` | number | Refuse if this would cost more than this many credits. |
| `--dry-run` | boolean | Show the price and stop. Nothing is spent. |
| `--idempotency-key` | string | Reuse the same key to retry a command without paying twice. |

### `zetta run continue`

Manual mode: run every step that is ready.

```
zetta run continue <id> [flags]
```

Kind: **spends credits** · MCP tool `run_continue`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | Run id (from `zetta pipeline runs <id>` or a batch result). (**required**) |
| `--yes` | boolean | Spend without asking. Needed when not in a terminal, unless --max-credits covers the price. |
| `--max-credits` | number | Refuse if this would cost more than this many credits. |
| `--dry-run` | boolean | Show the price and stop. Nothing is spent. |
| `--idempotency-key` | string | Reuse the same key to retry a command without paying twice. |

### `zetta run cancel`

Cancel a run (steps not started are not charged).

```
zetta run cancel <id> [flags]
```

Kind: **destructive** · MCP tool `run_cancel`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | Run id (from `zetta pipeline runs <id>` or a batch result). (**required**) |

### `zetta run mode`

Switch a run between auto and manual.

```
zetta run mode <id> <mode> [flags]
```

Kind: changes something (free) · MCP tool `run_mode`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | Run id (from `zetta pipeline runs <id>` or a batch result). (**required**) |
| `<mode>` | `auto` \| `manual` | auto or manual. (**required**) |

### `zetta run set-input`

Set a step’s per-run input or settings before it runs (e.g. a draft’s texture prompt).

Use friendly setting names as in recipes: --prompt, --reference, or --set key=value for anything else.

```
zetta run set-input <id> <step> [flags]
```

Kind: changes something (free) · MCP tool `run_set_input`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | Run id (from `zetta pipeline runs <id>` or a batch result). (**required**) |
| `<step>` | string | The step id (as in the recipe). (**required**) |
| `--prompt` | string | Instruction or description for this run. |
| `--reference` | string | A reference picture for this run: a file or image:<id>. |
| `--set` | string (repeatable) | Other settings as key=value (friendly names). |

Examples:

```bash
zetta run set-input 88 paint --prompt "matte black ceramic"
zetta run set-input 88 gen --set quality=ultra
```

### `zetta run step-run`

Manual mode: run one ready step.

```
zetta run step-run <id> <step-id> [flags]
```

Kind: **spends credits** · MCP tool `run_step_run`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | Run id (from `zetta pipeline runs <id>` or a batch result). (**required**) |
| `<step-id>` | number | The step’s numeric id (from `zetta run get`). (**required**) |
| `--yes` | boolean | Spend without asking. Needed when not in a terminal, unless --max-credits covers the price. |
| `--max-credits` | number | Refuse if this would cost more than this many credits. |
| `--dry-run` | boolean | Show the price and stop. Nothing is spent. |
| `--idempotency-key` | string | Reuse the same key to retry a command without paying twice. |

### `zetta run step-retry`

Retry a failed step, optionally with changed settings.

```
zetta run step-retry <id> <step-id> [flags]
```

Kind: **spends credits** · MCP tool `run_step_retry`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | Run id (from `zetta pipeline runs <id>` or a batch result). (**required**) |
| `<step-id>` | number | The failed step’s numeric id. (**required**) |
| `--set` | string (repeatable) | Changed settings as key=value (friendly names). |
| `--yes` | boolean | Spend without asking. Needed when not in a terminal, unless --max-credits covers the price. |
| `--max-credits` | number | Refuse if this would cost more than this many credits. |
| `--dry-run` | boolean | Show the price and stop. Nothing is spent. |
| `--idempotency-key` | string | Reuse the same key to retry a command without paying twice. |

### `zetta run confirm-parts`

Choose which isolated parts to keep (Isolate Parts review).

```
zetta run confirm-parts <id> <step-id> [flags]
```

Kind: changes something (free) · MCP tool `run_confirm_parts`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | Run id (from `zetta pipeline runs <id>` or a batch result). (**required**) |
| `<step-id>` | number | The Isolate Parts step’s numeric id. (**required**) |
| `--keys` | string (repeatable) | Part keys to keep (shown in the step’s review). (**required**) |
| `--extra` | string (repeatable) | Extra parts to ask for, by name. |

### `zetta run delete`

Delete a run record (its models stay in your library).

```
zetta run delete <id> [flags]
```

Kind: **destructive** · MCP tool `run_delete`

| Argument / flag | Type | Description |
|---|---|---|
| `<id>` | number | Run id (from `zetta pipeline runs <id>` or a batch result). (**required**) |
| `--yes` | boolean | Delete without asking. |

## config

Settings and profiles.

### `zetta config list`

Show every setting and the active profile.

```
zetta config list [flags]
```

Kind: local only · not an MCP tool

### `zetta config get`

Read one setting.

```
zetta config get <key> [flags]
```

Kind: local only · not an MCP tool

| Argument / flag | Type | Description |
|---|---|---|
| `<key>` | `output` \| `defaults.wait` \| `defaults.engine` \| `download.auto` \| `download.dir` \| `download.formats` \| `spend.maxPerCommand` \| `spend.requireConfirm` \| `currentProfile` | The setting. (**required**) |

### `zetta config set`

Change a setting (e.g. spend.maxPerCommand 200).

```
zetta config set <key> <value> [flags]
```

Kind: local only · not an MCP tool

| Argument / flag | Type | Description |
|---|---|---|
| `<key>` | `output` \| `defaults.wait` \| `defaults.engine` \| `download.auto` \| `download.dir` \| `download.formats` \| `spend.maxPerCommand` \| `spend.requireConfirm` \| `currentProfile` | The setting. (**required**) |
| `<value>` | string | The new value. (**required**) |

Examples:

```bash
zetta config set spend.maxPerCommand 200
zetta config set defaults.wait true
zetta config set output json
```

### `zetta config unset`

Reset a setting to its default.

```
zetta config unset <key> [flags]
```

Kind: local only · not an MCP tool

| Argument / flag | Type | Description |
|---|---|---|
| `<key>` | `output` \| `defaults.wait` \| `defaults.engine` \| `download.auto` \| `download.dir` \| `download.formats` \| `spend.maxPerCommand` \| `spend.requireConfirm` \| `currentProfile` | The setting. (**required**) |

### `zetta config profiles`

List profiles (each has its own API address and sign-in).

```
zetta config profiles [flags]
```

Kind: local only · not an MCP tool

### `zetta config add-profile`

Add or change a profile (e.g. a staging server).

```
zetta config add-profile <name> [flags]
```

Kind: local only · not an MCP tool

| Argument / flag | Type | Description |
|---|---|---|
| `<name>` | string | Profile name. (**required**) |
| `--api` | string | API address, ending in /api. (**required**) |
| `--site` | string | Website address used for browser sign-in. |
| `--use` | boolean | Make it the active profile. |

Examples:

```bash
zetta config add-profile staging --api https://staging-api.example.com/api --site https://staging.example.com
```

### `zetta config remove-profile`

Remove a profile you added, and its saved sign-in.

```
zetta config remove-profile <name> [flags]
```

Kind: local only · not an MCP tool

| Argument / flag | Type | Description |
|---|---|---|
| `<name>` | string | Profile name. (**required**) |

### `zetta config use`

Switch the active profile.

```
zetta config use <name> [flags]
```

Kind: local only · not an MCP tool

| Argument / flag | Type | Description |
|---|---|---|
| `<name>` | string | Profile name. (**required**) |

## skill

Install the agent skill that teaches AI tools to use this CLI.

### `zetta skill install`

Install the Zetta 3D skill so AI agents (e.g. Claude Code) know how to use this CLI.

Default: ~/.claude/skills/zetta3d/SKILL.md (all your projects). --project: ./.claude/skills/ (this repository). --dir: any skills folder.

```
zetta skill install [flags]
```

Kind: local only · not an MCP tool

| Argument / flag | Type | Description |
|---|---|---|
| `--project` | boolean | Install for this project only (./.claude/skills). |
| `--dir` | string | Install into this skills folder instead. |

### `zetta skill uninstall`

Remove the installed Zetta 3D skill.

```
zetta skill uninstall [flags]
```

Kind: local only · not an MCP tool

| Argument / flag | Type | Description |
|---|---|---|
| `--project` | boolean | Remove it from this project (./.claude/skills). |
| `--dir` | string | Remove it from this skills folder. |

### `zetta skill show`

Print the skill file (SKILL.md) for frameworks that load skills from elsewhere.

```
zetta skill show [flags]
```

Kind: local only · not an MCP tool

## Other commands

### `zetta generate`

Make a 3D model from a text prompt, a picture, or several views.

Pictures can be local files, URLs, or image:<id> from your image library.
Engines: n1 (every plan), n2.5, np1, np1.5 (paid plans). See `zetta catalog engines` for what each supports.
The price is checked first: use --dry-run to see it, --yes or --max-credits to spend without a prompt.
In a terminal it waits, then downloads the results into the current folder (the download.auto setting). Scripts and agents get the asset id at once; add --wait to wait, or --out <folder> to wait and download.

```
zetta generate [flags]
```

Kind: **spends credits** · MCP tool `generate`

| Argument / flag | Type | Description |
|---|---|---|
| `--prompt` | string | Describe the object (text to 3D). With a picture, it guides the result. |
| `--image` | string | One picture of the object: a file, URL, or image:<id>. |
| `--view` | string (repeatable) | Multi-view pictures as slot=source, e.g. front=f.png back=b.png left=l.png right=r.png. |
| `--engine` | `n1` \| `n2.5` \| `n25` \| `np1` \| `np1.5` \| `np15` | Engine (default n1, or `defaults.engine` from config). |
| `--quality` | `lowpoly` \| `high` \| `ultra` | Low-poly, high-res (default) or ultra detail. |
| `--texture` | boolean | Textured model (default). --no-texture gives geometry only. (default `true`) |
| `--pbr` | boolean | PBR materials (on by default for textured models; --no-pbr to skip). |
| `--texture-quality` | `standard` \| `detailed` \| `8k` | Texture detail (8k on Np engines). |
| `--faces` | number | Polygon budget (must fit the engine and quality; see `zetta catalog engines`). |
| `--quads` | boolean | Quad topology instead of triangles. |
| `--parts` | boolean | Split into separate editable parts (N2.5, geometry only). |
| `--texture-alignment` | `image` \| `geometry` | Fit the texture to the picture or to the mesh. |
| `--auto-size` | boolean | Scale to real-world size. |
| `--delight` | boolean | Remove baked-in lighting from the picture before texturing. |
| `--autofix` | boolean | Clean up the picture before building (slower). |
| `--compress` | boolean | Compress geometry for a smaller file. |
| `--uv` | boolean | Unwrap UVs (default). --no-uv is faster and smaller. (default `true`) |
| `--fast-texture` | boolean | Faster standard-quality texturing. |
| `--sketch` | boolean | The picture is a line drawing (N1). |
| `--seed` | number | Model seed, for reproducible results. |
| `--texture-seed` | number | Texture seed. |
| `--remove-bg` | boolean | Remove the background from the picture(s) first. |
| `--draw-missing` | boolean | With --view: draw the missing side views with AI from the front view. |
| `--title` | string | Title in your library. |
| `--tag` | string (repeatable) | Tags. |
| `--visibility` | `public` \| `private` | Share publicly, or keep private (private needs a paid plan). |
| `--format` | string (repeatable) | When downloading: only these formats (glb, fbx, obj, usdz …). |
| `--yes` | boolean | Spend without asking. Needed when not in a terminal, unless --max-credits covers the price. |
| `--max-credits` | number | Refuse if this would cost more than this many credits. |
| `--dry-run` | boolean | Show the price and stop. Nothing is spent. |
| `--idempotency-key` | string | Reuse the same key to retry a command without paying twice. |
| `--wait` | boolean | Wait for the job to finish (default: return at once with its id, unless it downloads automatically). |
| `--timeout` | string | Stop waiting after this long, e.g. 90s, 10m. The job keeps running. |
| `--out` | string | Download the results into this folder when done (implies --wait). |
| `--download` | boolean | Wait, then download the results into the current folder (default: the download.auto setting, which is on in a terminal). --no-download returns at once. |

Examples:

```bash
zetta generate --image chair.png --engine n2.5 --out ./models
zetta generate -p "a low-poly treasure chest" --quality lowpoly --dry-run
zetta generate --view front=f.png --view back=b.png --view left=l.png --view right=r.png --yes --wait
zetta generate -i photo.jpg --remove-bg --engine np1.5 --texture-quality 8k --max-credits 200 --out .
```

### `zetta quote`

Price a raw operation spec (most people use --dry-run on the command instead).

Example: zetta quote --base textured --modifier pbr --engine n25. Codes are listed by `zetta catalog pricing`.

```
zetta quote [flags]
```

Kind: reads only · MCP tool `quote`

| Argument / flag | Type | Description |
|---|---|---|
| `--base` | string | Generation base code: geometry_only, textured, lowpoly, gaussian_splat. |
| `--modifier` | string (repeatable) | Modifier codes, e.g. multi_view, pbr, detailed_texture. |
| `--post-process` | string (repeatable) | Finishing-tool codes, e.g. auto_rigging. |
| `--engine` | string | Engine id (n1, n25, np1, np15, r1, zs2, zs21). |

### `zetta commands`

List every command with its flags (use --json for a machine-readable map).

```
zetta commands [flags]
```

Kind: local only · not an MCP tool

| Argument / flag | Type | Description |
|---|---|---|
| `--group` | string | Only this group, e.g. asset. |

### `zetta schema`

JSON Schema of a command’s input (what --input accepts and MCP tools take).

```
zetta schema <command...> [flags]
```

Kind: local only · not an MCP tool

| Argument / flag | Type | Description |
|---|---|---|
| `<command>` | string (repeatable) | The command, e.g. generate, or asset list. (**required**) |

Examples:

```bash
zetta schema generate
zetta schema refine rig
```

### `zetta guide`

How to use this CLI well — written for AI agents (and handy for people).

```
zetta guide [flags]
```

Kind: local only · not an MCP tool

### `zetta exit-codes`

What each exit code means.

```
zetta exit-codes [flags]
```

Kind: local only · not an MCP tool

### `zetta doctor`

Check the setup: version, config, connection, sign-in, clock.

```
zetta doctor [flags]
```

Kind: reads only · MCP tool `doctor`

### `zetta completion`

Print a shell completion script (bash, zsh or fish).

Add to your shell, e.g.: zetta completion zsh > ~/.zsh/completions/_zetta

```
zetta completion <shell> [flags]
```

Kind: local only · not an MCP tool

| Argument / flag | Type | Description |
|---|---|---|
| `<shell>` | `bash` \| `zsh` \| `fish` | Your shell. (**required**) |

### `zetta mcp`

Run Zetta 3D as an MCP server over stdio, for AI assistants.

Every command becomes a tool with the same inputs, checks and spend guard.
Paid tools need yes/maxCredits per call, or a --budget for the whole session.

Add it to an MCP client, e.g.:
    claude mcp add zetta3d -- zetta mcp --budget 500
    { "mcpServers": { "zetta3d": { "command": "zetta", "args": ["mcp", "--budget", "500"] } } }

```
zetta mcp [flags]
```

Kind: local only · not an MCP tool

| Argument / flag | Type | Description |
|---|---|---|
| `--budget` | number | Credits the session may spend in total without per-call confirmation. |
| `--read-only` | boolean | Offer only tools that look and never change anything. |

Examples:

```bash
zetta mcp --budget 500
zetta mcp --read-only
```

### `zetta setup`

Connect an AI tool to Zetta 3D: Claude Code, Claude Desktop, Cursor, Codex, or an AGENTS.md.

claude-code     installs the skill and registers the MCP server (`claude mcp add`).
claude-desktop  adds the MCP server to claude_desktop_config.json.
cursor          adds the MCP server to ~/.cursor/mcp.json.
codex           adds the MCP server to ~/.codex/config.toml and the guide to ~/.codex/AGENTS.md.
agents-md       adds the guide to ./AGENTS.md (read by many coding agents).
Existing files are backed up to .bak, and re-running replaces our entry instead of duplicating it.
Without --budget, paid MCP tools need yes or maxCredits on every call.

```
zetta setup <client> [flags]
```

Kind: local only · not an MCP tool

| Argument / flag | Type | Description |
|---|---|---|
| `<client>` | `claude-code` \| `claude-desktop` \| `cursor` \| `codex` \| `agents-md` | The AI tool to connect. (**required**) |
| `--budget` | number | Credits each MCP session may spend without per-call confirmation. |
| `--read-only` | boolean | Offer only read-only tools over MCP. |
| `--print` | boolean | Show what would change, and change nothing. |

Examples:

```bash
zetta setup claude-code --budget 500
zetta setup claude-desktop --read-only
zetta setup agents-md --print
```

### `zetta upgrade`

Update zetta to the latest release (or a given version).

Downloads the binary for this machine, checks its SHA-256 and replaces this one. Use --check to only look.

```
zetta upgrade [flags]
```

Kind: local only · not an MCP tool

| Argument / flag | Type | Description |
|---|---|---|
| `--check` | boolean | Only report whether a newer version exists. |
| `--to` | string | Install exactly this version, e.g. 0.2.0. |
| `--force` | boolean | Reinstall even if already on that version. |

