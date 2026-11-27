# Getting started

From installing to a downloaded 3D model, in about five minutes.

## 1. Install and check

```bash
# macOS and Linux (on Windows, in PowerShell: irm https://github.com/ig-shadow-walker/Zetta3D-CLI/releases/latest/download/install.ps1 | iex)
curl -fsSL https://github.com/ig-shadow-walker/Zetta3D-CLI/releases/latest/download/install.sh | sh
zetta --version
zetta doctor
```

`zetta doctor` checks the version, your settings, the connection to Zetta 3D, your clock, your sign-in and the keychain.

## 2. Sign in

```bash
zetta auth login
```

Your browser opens zetta3d.ai. Sign in there if you aren't already, then click **Connect Zetta CLI**. The terminal confirms:

```
Signed in as you@example.com (creator plan).
Token saved in the system keychain; it expires 2026-12-26.
```

Other ways to sign in:
- **No browser on this machine** (SSH, a container, a server), **CI, scripts and agents:** use an API key. Make one with `zetta apikey create <name>`, then set `ZETTA_API_KEY` wherever zetta runs. A key works until you revoke it.

See [authentication.md](authentication.md) for every option.

## 3. Look around

```bash
zetta account show            # your plan, trial and balances
zetta account credits         # your balance: 1 credit = €0.01
zetta catalog entitlements    # what your plan allows
zetta catalog engines         # the engines and what each supports
zetta catalog pricing         # the price of every option
zetta asset list              # your 3D library
```

Every command has help: `zetta generate --help`, `zetta asset --help`. `zetta commands` lists them all.

**No plan yet?** There is no free tier: making models and pictures needs a plan. See the plans with `zetta billing plans` and buy one with `zetta billing checkout <plan>`, or redeem a trial code for 10 days of the Basic plan:

```bash
zetta account redeem ZETTA-7KQ2-M9XD
```

## 4. Make a model

Price it first. `--dry-run` uploads nothing and spends nothing:

```bash
zetta generate --image chair.png --engine n2.5 --dry-run
```

```
Price: 50 credits (nothing was spent)
  Textured model                        50
```

Then make it. `--out` waits for the job to finish and downloads the files:

```bash
zetta generate --image chair.png --engine n2.5 --max-credits 60 --out ./models
```

While it works, one status line shows progress: uploading, queue position, processing, downloading. Then:

```
#1234 · image to 3D · Zetta N2.5
  status:  success
  credits: 50
  saved:   /Users/you/models/1234-model.glb
```

The parts of that command:
- **`--max-credits 60`** spends only if the price is at most 60. In a terminal you could leave it out and be asked to confirm instead; scripts and agents must pass it, or `--yes`.
- **`--engine`** picks the engine:
  - `n2.5` (the default): quality levels, parts and quads;
  - `np1` and `np1.5`: clean topology to a polygon budget, and textures up to 8K.
- **`--out`** waits for the job and downloads the files.
- **In a terminal,** finished jobs download into the current folder even without `--out`. `--no-download` (or `zetta config set download.auto false`) returns at once with the asset id instead; the job keeps running on the server. Scripts and agents always get the id at once unless they ask with `--out`, `--wait` or `--download`.

Other ways in:

```bash
zetta generate -p "a stylised wooden treasure chest" --yes --wait                 # from text
zetta generate --view front=f.png --view back=b.png --view left=l.png --view right=r.png --engine n2.5 --yes
zetta generate -i product.jpg --remove-bg --engine np1.5 --texture-quality extreme --max-credits 200 --out .
```

All the options are in [generating.md](generating.md).

## 5. Wait and download later

```bash
zetta generate -p "a ceramic mug" --yes          # returns {"id": 1240, "status": "queued", …}
zetta asset wait 1240 --timeout 5m               # exit 0 when done, 10 if still running
zetta asset download 1240 --out ./models          # every result file
zetta asset download 1240 --format fbx            # only the FBX
```

## 6. Refine it

```bash
zetta refine retopo 1234 --faces 5000 --yes --wait            # clean topology
zetta asset rig-check 1235                                    # suggests a skeleton type
zetta refine rig 1235 --rig-type biped --rig-format fbx --yes --out ./models
zetta refine texture 1234 --prompt "weathered bronze" --tier hd --yes --wait
zetta asset texture-map 1234 --map normal --out ./maps        # an AI normal map from the texture
zetta asset export 1234 --format stl --out ./print            # free, on your machine
```

Each `refine` tool makes a new asset and leaves the original untouched. See [refining.md](refining.md), and [library.md](library.md#ai-texture-maps-paid-plans) for texture maps.

## 7. Share and organise

```bash
zetta asset rename 1234 "Lounge chair"
zetta asset tag 1234 --add furniture --add hero
zetta asset share 1234                        # prints a public link
zetta asset import ./sofa.fbx                 # bring in your own model (free)
zetta asset replace 1234 ./chair-fixed.glb    # save an edited file over it (can't be undone)
zetta asset delete 1240 --yes
```

## What next

- **Many files at once:** write a pipeline recipe and batch-run it over a folder. See [pipelines.md](pipelines.md).
- **Let an AI assistant drive it:** it's ready. The installer set up the skill for Claude Code, Codex and Cursor, so just ask in plain words (no MCP server needed). See [ai-agents.md](ai-agents.md).
- **Make it yours:** `zetta config set download.dir models` collects every download in one folder, and `download.formats glb,fbx` keeps only those formats. See [configuration.md](configuration.md).
- **Errors:** every error names its code and suggests a next step. See [troubleshooting.md](troubleshooting.md).
