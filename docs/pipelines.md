# Pipelines

A **pipeline** is a saved recipe of steps, for example: picture → remove background → make a model → retopology → rig. Each **run** starts from one seed (a picture, pictures of each side, or a model) and runs the steps on Zetta's servers. **Batches** start one run per seed: a folder of product photos becomes a folder of rigged models.

Pipelines are the same ones as in the web editor (`/pipelines`), so a recipe made in either place opens in the other.

## Recipes

Recipes are YAML (or JSON) files. Steps have ids; `from:` wires them together.

```yaml
version: 1
title: Picture to rigged character
steps:
  photo:  { kind: seed_picture }
  clean:  { kind: remove_background, from: photo }
  model:  { kind: generate_3d, from: clean, engine: n25, quality: high, output: textured }
  topo:   { kind: retopology, from: model, engine: r1, faces: 10000 }
  rig:    { kind: rigging, from: topo, rigType: biped, rigSpec: standard, format: fbx }
```

How the format works:
- **`from:`** names another step. Use `step.port` for a specific output, e.g. `split.each`, or a list when a step takes several inputs.
- **Settings** use the friendly names below. Anything you leave out takes the web editor's default.
- **`layout:`** is optional (positions on the canvas). Without it, steps are laid out left to right.

Run `zetta pipeline schema` to print four complete example recipes. `zetta pipeline schema --json` gives the JSON Schema and every step kind with its settings.

### Steps

| Kind | Takes | Gives | Settings |
|---|---|---|---|
| `seed_picture` | — | picture | *(the picture is given per run)* |
| `seed_model` | — | mesh | *(the model is given per run)* |
| `seed_views` | — | views | *(pictures of each side are given per run; front required)* |
| `remove_background` | picture | picture | — |
| `ai_edit` | picture | picture | `prompt`, `askAtRun` (ask for the instruction on each run), `for3D` |
| `draw_views` | picture | views | `views`: `back`, `left`, `right` |
| `isolate_parts` | picture | `character` and `each` (one branch per part) | `identify`, `sensitivity: low\|medium\|high`, `maxParts`, `pose: t\|a`, `extraParts` |
| `generate_3d` | one picture | mesh | `engine: n25`, `quality: low\|high\|ultra`, `output: textured\|geometry`, `pbr`, `polygonCount`, `polygonType: triangle\|quad`, `textureQuality: standard\|detailed`, `segmentParts`, `realWorldScale`, `textureAlignment: mesh\|picture`, `delight`, `autofixImage`, `compressGeometry`, `exportUv`, `removeBackground`, `availability`, `title` |
| `generate_smart_3d` | one picture | mesh | as `generate_3d`, with `engine: np1\|np15` and `textureQuality: …\|extreme` |
| `generate_3d_multiview` | views | mesh | as `generate_3d`; takes views from `seed_views` or `draw_views` |
| `generate_smart_3d_multiview` | views | mesh | as `generate_smart_3d`; takes views |
| `retopology` | mesh | mesh | `faces`, `polygonType`, `bake`, `unwrapUvs` (always the R1 engine) |
| `segmentation` | mesh | mesh | `mode: segment\|smart`, `granularity: simple\|balanced\|detailed`, `splitByConnectivity`, `hint` |
| `texture` | mesh (+ optional reference picture) | mesh | `tier: standard\|detailed\|8k`, `prompt`, `reference`, `removeReferenceBackground`, `alignment`, `bake`, `pbr`, `fast`, `delight` |
| `texture_multiview` | mesh (+ optional views) | mesh | as `texture`, with `views: {front, back?, left?, right?}` instead of `prompt`/`reference`. Without wired views or a `views` setting, each run asks for the pictures |
| `smart_uv` | mesh | mesh | `bake`, `orientation: as-is\|+x\|-x\|+y\|-y`, `compress` |
| `rigging` | mesh | mesh | `rigType: biped\|quadruped\|avian\|serpentine\|aquatic\|hexapod\|octopod\|others`, `rigSpec: standard\|mixamo\|unity\|unreal\|vrm\|actorcore` (humanoids only), `format: glb\|fbx` |

Zetta N1 is retired. Recipes that still name it load with a warning; change the step to `n25`. Older recipes that feed views into `generate_3d` or `generate_smart_3d` are read as the multi-view step, with a warning.

A recipe that starts from pictures of each side:

```yaml
version: 1
title: Product from photos of each side
steps:
  photos: { kind: seed_views }
  model:  { kind: generate_smart_3d_multiview, from: photos, engine: np15, polygonCount: 12000 }
  paint:  { kind: texture_multiview, from: { in: model, views: photos }, tier: detailed }
  uv:     { kind: smart_uv, from: paint }
```

## Describe a recipe

An AI can draft a recipe from a description, or change an existing one. It uses AI tokens and needs a paid plan (at most 10 a minute). Nothing is saved unless you ask:

```bash
zetta pipeline draft "a game-ready character from a photo, rigged for Unity" --output text > recipe.yaml
zetta pipeline draft "use quads everywhere" --from recipe.yaml --output text > recipe-quads.yaml
zetta pipeline draft "add AI texturing at the end" --update 12      # changes pipeline 12
zetta pipeline draft "products from photos of each side" --create   # saves a new pipeline
```

The printed recipe lists the draft's title, problems and per-run inputs as `#` comments, so it can be saved straight to a file and checked with `zetta pipeline validate`.

## Create, check and price

```bash
zetta pipeline validate recipe.yaml              # checks the recipe here and on the server; free
zetta pipeline estimate recipe.yaml --seeds 20   # price per run, and for 20 runs
zetta pipeline create --file recipe.yaml         # saves it → pipeline id
zetta pipeline list
zetta pipeline get 12 --output text > recipe.yaml   # back to an editable recipe
zetta pipeline update 12 --file recipe.yaml
zetta pipeline duplicate 12
zetta pipeline delete 12 --yes
```

Pipelines made in the web editor come back as recipes too, so you can edit them in a text editor and save them back.

## Run

```bash
zetta pipeline run 12 ./shoe.jpg --max-credits 300            # one run
zetta pipeline batch 12 ./photos --max-credits 3000           # one run per picture in the folder
zetta pipeline batch 12 a.jpg b.jpg image:812 --yes           # files, library pictures…
zetta pipeline batch 12 1234 1235 --yes                       # …or library models, for seed_model pipelines
```

For a pipeline that starts from pictures of each side (`seed_views`), each run is a set of pictures, front required:

```bash
zetta pipeline run 14 --views front=f.png,back=b.png,left=l.png --max-credits 300
zetta pipeline batch 14 --views front=a1.png,back=a2.png --views front=b1.png --yes   # each front= starts a new run
zetta pipeline batch 14 ./products --max-credits 3000    # products/chair/front.png, products/chair/back.png, …
```

A folder that holds `front.png` (plus `back`, `left`, `right`) is one run, named after the folder. A folder of such folders gives one run each. `image:<id>` works for any side.

How runs are started:
- **Total price first:** the whole batch is priced and checked against `--max-credits` before anything starts. Steps that fan out (Isolate Parts) cost more for each part found, so the price shown is a minimum.
- **Large batches:** more than 20 seeds are sent in several batches.
- **`--mode manual`:** each step waits for you (`zetta run continue`).
- **API keys:** a run uses the pipeline as it is saved. The CLI sends its own copy of the recipe only when it differs, which an API key is not allowed to do (`PIPELINE_EDIT_NOT_ALLOWED`); it then warns and runs the saved recipe. A key also cannot draft, create, edit, duplicate or delete pipelines, or run a recipe with a Gaussian-splat step (`SPLAT_NOT_IN_API`).
- **Paid plan:** runs, batches and drafts need one (`PLAN_REQUIRED`).
- **`--draft`:** creates the runs without starting them, so you can set per-run inputs first. For example, an AI texturing prompt:

```bash
zetta pipeline batch 12 ./photos --draft
zetta run set-input 88 paint --prompt "matte black ceramic"
zetta run set-input 88 paint --reference ./swatch.jpg
zetta run set-input 88 paint --views front=f.png,back=b.png   # Multi-view - AI texturing
zetta run start 88 --max-credits 200
```

## Follow and control runs

```bash
zetta run get 88                     # every step: status, asset id, error
zetta run wait 88 --timeout 5m       # exit 0 when done or waiting on you · 9 failed · 10 still running
zetta run wait 88                    # in a terminal: wait, then save the final models here
zetta run wait 88 --out ./out        # wait, then download every model it made
zetta run outputs 88 --out ./out --final-only     # only the last step of each branch
zetta pipeline runs 12               # recent runs of a pipeline
```

When a run waits on you, `zetta run get` / `wait` list what is blocking it, with the exact next command:

| Waiting for | Command |
|---|---|
| Isolate Parts review | `zetta run confirm-parts 88 <stepId> --keys head,torso` |
| A manual-mode step | `zetta run step-run 88 <stepId>` or `zetta run continue 88` |
| A failed step (refunded) | `zetta run step-retry 88 <stepId> [--set quality=ultra]` |
| A draft | `zetta run set-input …`, then `zetta run start 88` |
| A pause | `zetta run resume 88` |

Other controls: `zetta run pause 88`, `zetta run cancel 88` (steps not yet started are not charged), `zetta run mode 88 auto|manual`, `zetta run delete 88 --yes` (only a run that is done, failed, cancelled or still a draft; the models stay in your library).
