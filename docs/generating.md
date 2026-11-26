# Generating models

`zetta generate` makes a 3D model from a text prompt, one picture, or several views. `zetta splat create` makes Gaussian-splat objects and worlds.

All of them are paid commands: they check the price first and follow the [spend guard](#spending). Each one makes a new asset in your library. Every generation needs a paid plan; without one it fails with `PLAN_REQUIRED` (exit code 4). See [Your plan and billing](authentication.md#your-plan-and-billing).

## Inputs

| Input | Flag | Example |
|---|---|---|
| Text (up to 1,024 characters) | `-p, --prompt` | `-p "a stylised wooden treasure chest"` |
| One picture | `-i, --image` | `-i chair.png`, `-i https://…/chair.jpg`, `-i image:812` |
| Several views | `--view slot=picture` (repeat) | `--view front=f.png --view back=b.png` |

**Pictures.** A picture can be a local file (PNG, JPEG or WebP, each side 128–5000 px, at most 8 MB), an `https://` URL, or `image:<id>` from your [image library](images.md). Local files are checked and uploaded for you.

**View slots.** `front`, `back`, `left` and `right`.
- **Required:** a `front` view and at least one other, on every engine.
- **Missing views:** `--draw-missing` draws the missing `front`, `back`, `left` and `right` views with AI from the one you gave.

**Text.** No engine builds from a bare prompt. `zetta` first makes a picture from your prompt with the image engine, then builds the model from that picture. The picture is made only after you approve the spend.

**One input at a time.** Give `--prompt`, `--image` or `--view`. A prompt doesn't go with a picture or with views.

## Engines

| `--engine` | Inputs | Quality levels | Texture | Polygons |
|---|---|---|---|---|
| `n2.5` (default) | text, picture, views (front + 1) | lowpoly, high, ultra | standard, detailed | low-poly 1,000–20,000; high up to 1M; ultra up to 2M. Quads 500–10,000 on low-poly, up to 150,000 otherwise. `--parts` |
| `np1` | text, picture, views (front + 1) | — | standard, detailed, extreme | 48–20,000 triangles |
| `np1.5` | text, picture, views (front + 1) | — | standard, detailed, extreme | 48–50,000 triangles, or 48–25,000 quads |

Every engine needs a paid plan. `zetta catalog engines --json` has the exact limits, including the face-count range and default for each quality level and polygon type. `zetta catalog entitlements` shows what your plan allows: `threeD.generate` is `false` without a plan, and `threeD.engines` lists `n25`, `np1` and `np15`.

N1 is retired: `--engine n1` is refused, and a saved `defaults.engine n1` fails with a message saying so. Use `n2.5` or `np1`.

## Options

| Flag | What it does |
|---|---|
| `--quality lowpoly\|high\|ultra` | N2.5 only: low-poly, high-res (default) or ultra detail (a paid extra) |
| `--no-texture` | Geometry only (cheaper) |
| `--pbr` / `--no-pbr` | PBR materials; on by default for textured models |
| `--texture-quality standard\|detailed\|extreme` | Texture detail. `extreme` is 8K, on np1 and np1.5 only (`8k` is accepted too) |
| `--faces N` | Polygon budget, within the engine's range for that quality. Defaults to the most allowed; another count is a paid extra |
| `--quads` | Quad topology instead of triangles (N2.5 and np1.5) |
| `--parts` | Split into separate editable parts (N2.5, geometry only, not low-poly) |
| `--texture-alignment image\|geometry` | Fit the texture to the picture, or to the mesh (default) |
| `--auto-size` | Scale the model to real-world size |
| `--delight` | Remove baked-in lighting from the picture before texturing |
| `--autofix` | Clean up the picture before building (slower) |
| `--compress` | Smaller files with geometry compression |
| `--no-uv` | Skip UV unwrapping (faster, smaller) |
| `--fast-texture` | Faster standard-quality texturing |
| `--seed N`, `--texture-seed N` | Reproducible results |
| `--remove-bg` | Remove the picture's background first (good for product photos) |
| `--draw-missing` | With `--view`: draw the missing side views with AI |
| `--title`, `--tag` (repeat), `--visibility public\|private` | Library details (private needs a paid plan) |

Options that don't work together are rejected **before** anything is uploaded or charged, with a message saying what to change (exit code 2). Options your plan doesn't allow are rejected the same way (exit code 4), and so is any generation without a plan (`PLAN_REQUIRED`).

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
| *(none, in a terminal)* | Waits, then downloads the result files into the current folder ([automatic downloads](configuration.md#automatic-downloads)) |
| *(none, scripts and agents)* | Returns at once: `{"id": 1234, "status": "queued", …, "next": "zetta asset wait 1234"}` |
| `--wait` | Waits for the job to finish |
| `--timeout 10m` | Stops waiting after this long. Exit code 10; the job keeps running |
| `--out <folder>` | Waits, then downloads the result files there |
| `--download` / `--no-download` | Turns the automatic download on or off for this command |
| `--no-wait` | Returns at once, without downloading |
| `--format glb` | When downloading: only these formats |

`zetta config set download.auto false` turns automatic downloads off, and `true` turns them on for scripts too. `zetta config set defaults.wait true` waits by default without downloading (`--no-wait` overrides it).

## Examples

```bash
# Text → a low-poly model
zetta generate -p "a low-poly fox, stylised" --quality lowpoly --yes --wait

# A product photo → clean textured model, downloaded as GLB and FBX
zetta generate -i shoe.jpg --remove-bg --engine n2.5 --max-credits 120 --out ./out --format glb --format fbx

# Four views, with the missing back drawn by AI
zetta generate --view front=f.png --view left=l.png --view right=r.png --draw-missing --engine n2.5 --yes

# Game-ready: quads at a fixed budget
zetta generate -i robot.png --engine n2.5 --quality lowpoly --quads --faces 8000 --max-credits 100 --wait

# Highest texture detail
zetta generate -i vase.jpg --engine np1.5 --texture-quality extreme --max-credits 200 --out .

# Everything as JSON input (handy for scripts and agents)
zetta generate --input '{"prompt":"a ceramic mug","engine":"n2.5","maxCredits":60}'
```

## Splat worlds (early access)

`zetta splat create` makes Gaussian-splat objects and environments. It needs early access: ask for it with `zetta account early-access "Zetta Splat"`. Splats, world exports and video uploads don't work with an API key: they are refused with `SPLAT_NOT_IN_API`.

| `--engine` | Makes | From |
|---|---|---|
| `splat` (default) | An object or a scene | One picture, or a prompt |
| `splat2` | A whole world | A picture, a video, or several pictures of the same place |
| `splat2.1` | A whole world (newer) | Same as `splat2` |

| Flag | What it does |
|---|---|
| `-i, --image <picture>` | The main picture |
| `--video <file or URL>` | A walkthrough video (MP4, WebM, MOV or AVI, up to 100 MB; `splat2`/`splat2.1`). A video builds a place, so it needs subject `environment` |
| `-p, --prompt "…"` | Describes the scene, up to 1,024 characters. Without a picture or video, a picture is made from it first |
| `--subject object\|environment` | What the scene is. Default: `environment` on `splat2`/`splat2.1`, `object` on `splat` |
| `--aspect-ratio 16:9\|21:9\|3:2\|4:3\|1:1` | With `--prompt` alone: the frame of the environment picture made from it (default `16:9`) |
| `--resolution 1K\|2K\|4K` | With `--prompt` alone: the size of the environment picture made from it (default `1K`) |
| `--remove-bg` | Cut the object out of its background first (an object, on the `splat` engine only) |
| `--world-view <azimuth>=<picture>` | More pictures of the same place, by direction in degrees (1–359) clockwise from the main picture. Up to 3, or 7 with `--same-space` |
| `--same-space` | Reconstruct from all the pictures together (up to 8) |
| `--seed N` | Reproducible results (`splat` engine) |

`--aspect-ratio` and `--resolution` shape only an environment picture made from a prompt. Beside `--image` or `--video`, or with subject `object`, they are refused.

```bash
zetta splat create --image room.jpg --engine splat2 --dry-run
zetta splat create --video walkthrough.mp4 --engine splat2.1 --yes --wait
zetta splat create --image lobby.jpg --world-view 90=right.jpg --world-view 180=back.jpg --engine splat2 --yes
zetta splat create -p "a misty pine forest clearing" --engine splat2 --aspect-ratio 21:9 --resolution 2K --dry-run
```

**Exports from a world:**

```bash
zetta splat export 1300 --as splat --resolution 500k --yes --out ./world   # a PLY splat (full_res, 500k, 150k or 100k)
zetta splat export 1300 --as mesh --mesh-variant textured --yes --out .     # a mesh (textured or vertex_colored)
zetta splat export 1300 --as collider --yes --out ./unity/Assets           # a light collider mesh for physics
```
