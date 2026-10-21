# Your library

Every model you generate, refine or import is an **asset** with a numeric id. Pictures live in a separate [image library](images.md), referenced as `image:<id>`.

## Listing and finding

```bash
zetta asset list                                   # newest first, 24 per page
zetta asset list --limit 10 --page 2
zetta asset list --status processing --status queued
zetta asset list --kind autoRigging                # img23d, txt23d, multiView23d, retopology, segmentation, retexture, autoRigging, uvUnwrap, convertFormat, upload, imageToSplat, …
zetta asset list --search chair --visibility public
zetta asset list --oldest-first --json
```

Each item comes back in the same compact shape:

```json
{
  "id": 1234, "status": "success", "kind": "img23d", "engine": "n25", "engineLabel": "Zetta N2.5",
  "title": "Lounge chair", "tags": ["furniture"], "availability": "private", "prompt": null, "error": null,
  "files": [{ "key": "…/model.glb", "format": "glb", "bytes": 7447908, "label": null }],
  "thumbnailUrl": "https://…", "pipelineRunId": null, "createdAt": "…", "updatedAt": "…"
}
```

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
zetta asset auto-tag 1234 --apply                    # suggests a category and tags with AI (uses AI tokens)
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

A job that is already running is **not** refunded when you delete it. Without a terminal, `delete` needs `--yes`.

## Importing your own models

```bash
zetta asset import ./my-model.glb --title "My model"     # free; GLB up to 512 MB
zetta refine retopo <new id> --faces 5000 --yes          # then use any finishing tool on it
```

Large files are uploaded in pieces, and retried if the connection drops.

## Exporting

`zetta asset export <id|file.glb> --format obj|fbx|stl` converts locally and for free. See [refining.md](refining.md#conversion).
