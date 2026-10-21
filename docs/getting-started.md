# Getting started

From installing to a downloaded 3D model, in about five minutes.

## 1. Install and check

```bash
curl -fsSL https://zetta3d.ai/install.sh | sh       # Windows: irm https://zetta3d.ai/install.ps1 | iex
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
Token saved in the system keychain; it expires 2026-11-20.
```

No browser on this machine? Use `zetta auth login --email you@example.com`, then paste the link from the email. Copy the link; don't click it, because it works only once. See [authentication.md](authentication.md) for CI and agents.

## 3. Look around

```bash
zetta account credits         # your balance: 1 credit = €0.01
zetta catalog entitlements    # what your plan allows
zetta catalog engines         # the engines and what each supports
zetta catalog pricing         # the price of every option
zetta asset list              # your 3D library
```

Every command has help: `zetta generate --help`, `zetta asset --help`. `zetta commands` lists them all.

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
  - `n1` (the default) works on every plan;
  - `n2.5`, `np1` and `np1.5` need a paid plan.
- **`--out`** waits for the job and downloads the files. Without `--wait` or `--out`, the command returns at once with the asset id, and the job keeps running on the server.

Other ways in:

```bash
zetta generate -p "a stylised wooden treasure chest" --yes --wait                 # from text
zetta generate --view front=f.png --view back=b.png --view left=l.png --view right=r.png --engine n2.5 --yes
zetta generate -i product.jpg --remove-bg --engine np1.5 --texture-quality 8k --max-credits 200 --out .
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
zetta asset export 1234 --format stl --out ./print            # free, on your machine
```

Each finishing tool makes a new asset and leaves the original untouched. See [refining.md](refining.md).

## 7. Share and organise

```bash
zetta asset rename 1234 "Lounge chair"
zetta asset tag 1234 --add furniture --add hero
zetta asset share 1234          # prints a public link
zetta asset delete 1240 --yes
```

## What next

- **Many files at once:** write a pipeline recipe and batch-run it over a folder. See [pipelines.md](pipelines.md).
- **Let an AI assistant drive it:** `zetta setup claude-code`, and see [ai-agents.md](ai-agents.md).
- **Make it yours:** `zetta config set defaults.wait true` makes paid commands wait by default. See [configuration.md](configuration.md).
- **Errors:** every error names its code and suggests a next step. See [troubleshooting.md](troubleshooting.md).
