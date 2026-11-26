# Your library

Every model you generate, refine or import is an **asset** with a numeric id. Pictures live in a separate [image library](images.md), referenced as `image:<id>`.

## Listing and finding

```bash
zetta asset list                                     # newest first, 24 per page
zetta asset list --limit 10 --page 2
zetta asset list --status processing --status queued
zetta asset list --kind autoRigging                  # one kind only (see below)
zetta asset list --search chair --visibility public  # search matches ids, titles and tags
zetta asset list --group-runs --sort updated         # one entry per pipeline run; last changed first
zetta asset list --oldest-first --json
```

The kinds are `img23d`, `txt23d`, `multiView23d`, `retopology`, `segmentation`, `smartSegmentation`, `uvUnwrap`, `retexture`, `autoRigging`, `convertFormat`, `upload`, `imageToSplat`, `worldSplatExport` and `worldMeshExport`. `--sort` is `created` (default) or `updated`.

Each item comes back in the same compact shape:

```json
{
  "id": 1234, "status": "success", "kind": "img23d", "engine": "n25", "engineLabel": "Zetta N2.5",
  "title": "Lounge chair", "tags": ["furniture"], "availability": "private", "prompt": null, "error": null,
  "files": [{ "key": "…/model.glb", "format": "glb", "bytes": 7447908, "label": null }],
  "thumbnailUrl": "https://…", "pipelineRunId": null, "createdAt": "…", "updatedAt": "…"
}
```

With `--group-runs`, each pipeline run is one item: its newest model, with a `run` field that holds the run's `id`, `pipelineId`, `pipeline` title, `count` and the ids of every model it made (`members`).

## Status, waiting, downloading

```bash
zetta asset get 1234                               # status, queue position, files
zetta asset wait 1234 --timeout 5m                 # exit 0 success · 9 failed/cancelled · 10 still running
zetta asset wait 1234 --out ./models --format glb  # wait, then download
zetta asset wait 1234 --no-download                 # only wait (in a terminal it downloads here by default)
zetta asset download 1234 --out ./models           # every result file
zetta asset download 1234 --format fbx --format usdz
zetta asset download 1234 --primary                # just the best model file (GLB, then FBX, glTF, OBJ)
zetta asset download 1234 --overwrite              # replace files instead of adding -2, -3 …
```

How downloads work:
- **Links:** each download uses a fresh pre-signed link. The CLI fetches it without sending your token.
- **File names:** files are saved as `<id>-<original name>`.
- **Statuses:** `pending → queued → processing → saving → success | failed | cancelled`. Failed jobs are refunded automatically, and `zetta asset get` shows why the job failed.

## Organising and sharing

```bash
zetta asset rename 1234 "Lounge chair"
zetta asset tag 1234 --add furniture --add hero      # --remove x, or --set a,b to replace all
zetta asset auto-tag 1234 --apply                    # suggests a category and tags with AI (paid plans; uses AI tokens)
zetta asset share 1234                               # public; prints the link
zetta asset unshare 1234                             # private again (paid plans)
zetta asset get 17 --public                          # read anyone's shared asset, no sign-in needed
zetta asset featured                                 # community highlights
```

## Cancelling and deleting

```bash
zetta asset cancel 1240              # only before the job starts; full refund
zetta asset delete 1240 1241 --yes   # deletes the assets and their files
```

How deleting works:
- **Refunds:** a job that is already running is **not** refunded when you delete it.
- **Confirming:** in a terminal you are asked first. Without one, `delete` needs `--yes`.
- **Several ids:** each is deleted on its own. If some fail, the rest are still deleted, the failures are listed in `failed` with the reason, and the exit code is 1.

## Importing your own models

```bash
zetta asset import ./chair.glb --title "Lounge chair"        # one file, stored as it is
zetta asset import ./chair.obj ./chair.mtl ./wood.png        # a model and its files, zipped together
zetta asset import ./chair-folder/                           # a whole folder
zetta asset import ./chair.zip                               # a zip of a model and its textures
zetta asset import ./my-rig.fbx --source 1234 --rigged       # a rig you made yourself from #1234
zetta refine retopo <new id> --faces 5000 --yes              # then use any finishing tool on it
```

Formats: GLB, glTF, FBX, OBJ, STL, PLY, DAE, 3DS, 3MF, AMF, USD, USDA, USDC, USDZ, VRML (`.wrl`), LWO and KMZ, or a `.zip` of a model and its files.

How importing works:
- **Free:** importing costs nothing.
- **Nothing is converted.** One file is stored exactly as it is.
- **Several files or a folder** are stored together as one zip, as the Studio does: an OBJ with its `.mtl` and textures, or a glTF with its `.bin` and images. A folder's files keep their paths inside it. When there are several models, the most complete format is the model (GLB, then glTF, FBX, OBJ …).
- **Size:** up to 512 MB. Large files are uploaded in pieces, and retried if the connection drops.
- **`--title`** names it in the library (default: the model's file name).
- **`--source <id>`** records the library asset the model was made from. **`--rigged`** (needs `--source`) files it as a rig rather than an upload.

## Saving back

`zetta asset replace` saves a model file over an asset's stored GLB or FBX, as the Studio's Save does.

```bash
zetta asset replace 1234 ./chair-fixed.glb            # over #1234's GLB
zetta asset replace 1240 ./part-2.glb --part 2 --yes  # one part of a segmented asset
zetta asset replace 1250 ./rig.fbx --format fbx --yes # over the asset's FBX (a rig, a retopology)
```

Some details:
- **It can't be undone.** The file is overwritten in place, and the old one is gone. The asset keeps its id, title and share link. In a terminal you are asked first; scripts and agents pass `--yes`.
- **Parts** count from 1. A segmented asset needs `--part`, and parts are GLBs.
- **Format:** your file decides which stored file is replaced: a GLB replaces the GLB, and an FBX the asset's one FBX. `--format glb|fbx`, if given, must match the file. Files can be up to 512 MB.

## AI texture maps (paid plans)

`zetta asset texture-map` makes PBR maps from a model's base-colour texture with AI: normal, roughness, metalness, emissive and ambient occlusion.

```bash
zetta asset texture-map 1234 --map normal --out ./maps                # just the pictures
zetta asset texture-map 1234 --map roughness,metalness --apply        # put them on #1234 and save it
zetta asset texture-map ./chair.glb --map normal --map ao --apply     # writes chair-maps.glb
zetta asset texture-map ./albedo.png --map normal                     # from a base-colour picture
```

| Flag | What it does |
|---|---|
| `--map normal\|roughness\|metalness\|emissive\|ao` | Which maps. Repeat the flag, or separate them with commas |
| `--material <number or name>` | Only this material (numbers start at 0). Default: every material with a base-colour texture |
| `--part <n>` | For a segmented asset: which part (1 = the first) |
| `--out <folder>` | Where to save the maps (default: the current folder, or the `download.dir` setting) |
| `--apply` | Also put the maps on the model and save it: over the asset's GLB (can't be undone), or for a local file as `<name>-maps.glb` in the output folder |

How it works:
- **Source:** an asset id, a local `.glb`, or a base-colour picture (PNG, JPEG or WebP). `--apply` needs a model.
- **Each map** is drawn by AI from the material's base-colour texture: square, at the texture's own size (1K, 2K or 4K). The maps are saved as pictures, and kept in your image library.
- **Roughness and metalness** share one packed texture in a GLB. When the model's existing metal/rough texture is a JPEG, make both maps together (`--map roughness,metalness`); otherwise `--apply` refuses.
- **Factors:** with `--apply`, a metallic or roughness factor of 0 is set to 1, and a black emissive colour to white, so the new map shows. The result lists each change as a note.
- **Failures:** if some maps fail, the others are still saved, the failures are listed, and the exit code is 1.

## Exporting

`zetta asset export <id|file.glb> --format obj|fbx|stl` converts locally and for free. See [refining.md](refining.md#conversion).
