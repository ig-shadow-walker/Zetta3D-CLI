# Pipelines

A **pipeline** is a saved recipe of steps, for example: picture → remove background → make a model → retopology → rig. Each **run** starts from one seed (a picture or a model) and runs the steps on Zetta's servers. **Batches** start one run per seed: a folder of product photos becomes a folder of rigged models.

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

Run `zetta pipeline schema` to print three complete example recipes. `zetta pipeline schema --json` gives the JSON Schema and every step kind with its settings.

### Steps

| Kind | Takes | Gives | Settings |
|---|---|---|---|
| `seed_picture` | — | picture | *(the picture is given per run)* |
| `seed_model` | — | mesh | *(the model is given per run)* |
| `remove_background` | picture | picture | — |
| `ai_edit` | picture | picture | `prompt`, `askAtRun` (ask for the instruction on each run), `for3D` |
| `draw_views` | picture | views | `views`: `back`, `left`, `right` |
| `isolate_parts` | picture | `character` and `each` (one branch per part) | `identify`, `sensitivity: low\|medium\|high`, `maxParts`, `pose: t\|a`, `extraParts` |
| `generate_3d` | picture or views | mesh | `engine: n1\|n25`, `quality: low\|high\|ultra`, `output: textured\|geometry`, `pbr`, `polygonCount`, `polygonType: triangle\|quad`, `textureQuality: standard\|detailed`, `segmentParts`, `realWorldScale`, `textureAlignment: mesh\|picture`, `delight`, `removeBackground`, `title` |
| `generate_smart_3d` | picture or views | mesh | as `generate_3d`, with `engine: np1\|np15` and `textureQuality: …\|extreme` |
| `retopology` | mesh | mesh | `engine: r1\|n1`, `faces`, `faceLevel: low\|medium\|high`, `polygonType`, `bake` |
| `segmentation` | mesh | mesh | `mode: segment\|smart`, `granularity: simple\|balanced\|detailed`, `splitByConnectivity`, `hint` |
| `texture` | mesh (+ optional reference picture) | mesh | `tier: standard\|detailed\|8k`, `prompt`, `reference`, `removeReferenceBackground`, `alignment`, `bake`, `pbr`, `fast`, `delight` |
| `smart_uv` | mesh | mesh | `bake`, `orientation: as-is\|+x\|-x\|+y\|-y`, `compress` |
| `rigging` | mesh | mesh | `rigType: biped\|quadruped\|avian\|serpentine\|aquatic\|hexapod\|octopod`, `rigSpec: standard\|mixamo`, `format: glb\|fbx` |

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

How runs are started:
- **Total price first:** the whole batch is priced and checked against `--max-credits` before anything starts. Steps that fan out (Isolate Parts) cost more for each part found, so the price shown is a minimum.
- **Large batches:** more than 20 seeds are sent in several batches.
- **`--mode manual`:** each step waits for you (`zetta run continue`).
- **`--draft`:** creates the runs without starting them, so you can set per-run inputs first. For example, an AI texturing prompt:

```bash
zetta pipeline batch 12 ./photos --draft
zetta run set-input 88 paint --prompt "matte black ceramic"
zetta run set-input 88 paint --reference ./swatch.jpg
zetta run start 88 --max-credits 200
```

## Follow and control runs

```bash
zetta run get 88                     # every step: status, asset id, error
zetta run wait 88 --timeout 5m       # exit 0 when done or waiting on you · 9 failed · 10 still running
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

Other controls: `zetta run pause 88`, `zetta run cancel 88` (steps not yet started are not charged), `zetta run mode 88 auto|manual`, `zetta run delete 88 --yes` (the models stay in your library).
