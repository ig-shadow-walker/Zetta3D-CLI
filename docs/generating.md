# Generating models

`zetta generate` makes a 3D model from a text prompt, one picture, or several views. `zetta splat create` makes Gaussian-splat objects and worlds.

All of them are paid commands: they check the price first and follow the [spend guard](#spending). Each one makes a new asset in your library.

## Inputs

| Input | Flag | Example |
|---|---|---|
| Text | `-p, --prompt` | `-p "a stylised wooden treasure chest"` |
| One picture | `-i, --image` | `-i chair.png`, `-i https://…/chair.jpg`, `-i image:812` |
| Several views | `--view slot=picture` (repeat) | `--view front=f.png --view back=b.png` |

**Pictures.** A picture can be a local file (PNG, JPEG or WebP, each side 128–5000 px, at most 8 MB), an `https://` URL, or `image:<id>` from your [image library](images.md). Local files are checked and uploaded for you.

**View slots.** `front`, `back`, `left`, `right`, `top`, `bottom`, `left_front`, `right_front`.
- **On N1:** any of the slots.
- **On N2.5 and the Np engines:** a `front` view and at least one other.
- **Missing views:** `--draw-missing` draws the missing `front`, `back`, `left` and `right` views with AI from the one you gave.

**Text on engines that need a picture.** Only N1 takes a bare prompt. On the other engines, `zetta` first makes a picture from your prompt (with the image engine), then builds the model from that picture.

**Prompt with a picture.** With `--image`, `--prompt` guides the result.

## Engines

| `--engine` | Plan | Inputs | Quality levels | Texture | Polygons |
|---|---|---|---|---|---|
| `n1` (default) | All | text, picture, any views | lowpoly, high, ultra | standard | 3,100–1.5M; triangles or quads |
| `n2.5` | Paid | picture, views (front + 1) | lowpoly, high, ultra | standard, detailed | up to 2M (quads up to 150k); `--parts` |
| `np1` | Paid | picture, views | — | standard, detailed, 8k | 48–20,000 triangles |
| `np1.5` | Paid | picture, views | — | standard, detailed, 8k | 48–50,000 (quads up to 25,000) |

`zetta catalog engines --json` has the exact limits, including the face-count range and default for each quality level and polygon type. `zetta catalog entitlements` shows what your plan allows.

## Options

| Flag | What it does |
|---|---|
| `--quality lowpoly\|high\|ultra` | Low-poly, high-res (default) or ultra detail |
| `--no-texture` | Geometry only (cheaper) |
| `--pbr` / `--no-pbr` | PBR materials; on by default for textured models |
| `--texture-quality standard\|detailed\|8k` | Texture detail (`8k` on the Np engines) |
| `--faces N` | Polygon budget, within the engine's range for that quality |
| `--quads` | Quad topology instead of triangles |
| `--parts` | Split into separate editable parts (N2.5, geometry only) |
| `--texture-alignment image\|geometry` | Fit the texture to the picture or to the mesh |
| `--auto-size` | Scale the model to real-world size |
| `--delight` | Remove baked-in lighting from the picture before texturing |
| `--autofix` | Clean up the picture before building (slower) |
| `--compress` | Smaller files with geometry compression |
| `--no-uv` | Skip UV unwrapping (faster, smaller) |
| `--fast-texture` | Faster standard-quality texturing |
| `--sketch` | The picture is a line drawing (N1) |
| `--seed N`, `--texture-seed N` | Reproducible results |
| `--remove-bg` | Remove the picture's background first (good for product photos) |
| `--draw-missing` | With `--view`: draw the missing side views with AI |
| `--title`, `--tag` (repeat), `--visibility public\|private` | Library details (private needs a paid plan) |

Options that don't work together are rejected **before** anything is uploaded or charged, with a message saying what to change (exit code 2). Options your plan doesn't allow are rejected the same way (exit code 4).

## Spending

| Flag | Behaviour |
|---|---|
| `--dry-run` | Show the price and stop. Nothing is uploaded or spent |
| `--max-credits N` | Spend only if the price is at most N |
| `--yes` | Spend without asking |
| *(neither, in a terminal)* | You are asked to confirm |
| *(neither, no terminal)* | Refused with `SPEND_NOT_CONFIRMED`, exit code 5. Nothing is spent |
| `--idempotency-key K` | Reusing the same key never charges twice; use it to retry safely |

Set `zetta config set spend.maxPerCommand 200` to let scripts spend up to 200 credits per command without `--yes`. Failed jobs are refunded automatically.

## Waiting and downloading

| Flag | Behaviour |
|---|---|
| *(none)* | Returns at once: `{"id": 1234, "status": "queued", …, "next": "zetta asset wait 1234"}` |
| `--wait` | Waits for the job to finish |
| `--timeout 10m` | With `--wait`: stops waiting after this long. Exit code 10; the job keeps running |
| `--out <folder>` | Waits, then downloads the result files there |
| `--format glb` | With `--out`: only these formats |

Set `zetta config set defaults.wait true` to wait by default (`--no-wait` overrides it).

## Examples

```bash
# Text → model on the free engine
zetta generate -p "a low-poly fox, stylised" --quality lowpoly --yes --wait

# A product photo → clean textured model, downloaded as GLB and FBX
zetta generate -i shoe.jpg --remove-bg --engine n2.5 --max-credits 120 --out ./out --format glb --format fbx

# Four views, with the missing back drawn by AI
zetta generate --view front=f.png --view left=l.png --view right=r.png --draw-missing --engine n2.5 --yes

# Game-ready: quads at a fixed budget
zetta generate -i robot.png --engine n2.5 --quality lowpoly --quads --faces 8000 --max-credits 100 --wait

# Highest texture detail
zetta generate -i vase.jpg --engine np1.5 --texture-quality 8k --max-credits 200 --out .

# Everything as JSON input (handy for scripts and agents)
zetta generate --input '{"prompt":"a ceramic mug","engine":"n1","maxCredits":60}'
```

## Splat worlds (early access)

`zetta splat create` makes Gaussian-splat objects and environments. It needs early access: ask for it with `zetta account early-access "Zetta Splat"`.

| `--engine` | Makes | From |
|---|---|---|
| `splat` (default) | An object or a scene | One picture, or a prompt |
| `splat2` | A whole world | A picture, a video, or several pictures of the same place |
| `splat2.1` | A whole world (newer) | Same as `splat2` |

| Flag | What it does |
|---|---|
| `--image <picture>` | The main picture |
| `--video <file or URL>` | A walkthrough video (MP4, WebM, MOV or AVI, up to 100 MB; `splat2`/`splat2.1`) |
| `--prompt "…"` | Describes the scene. Without a picture, a picture is made from it first |
| `--subject object\|environment` | What the prompt picture should frame |
| `--world-view <azimuth>=<picture>` | More pictures of the same place, by direction in degrees (1–359) clockwise from the main picture |
| `--same-space` | Reconstruct from all the pictures together (up to 8) |
| `--seed N` | Reproducible results (`splat` engine) |

```bash
zetta splat create --image room.jpg --engine splat2 --dry-run
zetta splat create --video walkthrough.mp4 --engine splat2.1 --yes --wait
zetta splat create --image lobby.jpg --world-view 90=right.jpg --world-view 180=back.jpg --engine splat2 --yes
```

**Exports from a world:**

```bash
zetta splat export 1300 --as splat --resolution 500k --yes --out ./world   # a PLY splat (full_res, 500k, 150k or 100k)
zetta splat export 1300 --as mesh --mesh-variant textured --yes --out .     # a mesh (textured or vertex_colored)
zetta splat export 1300 --as collider --yes --out ./unity/Assets           # a light collider mesh for physics
```
