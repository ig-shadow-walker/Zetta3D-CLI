# Images

Image Studio from the terminal. Use it to make reference pictures for 3D, edit and combine pictures, and remove backgrounds. The results are saved as files, and also kept in your image library as `image:<id>`, which any command that takes a picture accepts.

## Generate

```bash
zetta image generate -p "a red vintage armchair, studio light, plain background" --for-3d --out ./refs
```

| Flag | What it does |
|---|---|
| `-p, --prompt` | What to draw |
| `--for-3d` | A clean, square picture made to be turned into 3D |
| `--aspect-ratio 1:1\|16:9\|…` | `9:16`, `2:3`, `3:4`, `4:5`, `1:1`, `5:4`, `4:3`, `3:2`, `16:9`, `21:9` |
| `--resolution 1K\|2K\|4K` | 4K needs a paid plan |
| `--engine flash\|pro` | Image engine. `pro` needs a paid plan. List them with `zetta catalog engines --images` |
| `--subject object\|environment` | An object, or a whole environment |
| `--fast` | Faster, lighter generation |
| `--style <file>` (up to 3) | Style reference pictures |
| `--out <folder>` | Where to save (default: here, or the `download.dir` setting) |
| `--no-download` | Keep the picture in your image library only (also: `zetta config set download.auto false`) |

## Edit (paid plans)

```bash
zetta image edit ./chair.png -p "make it dark green velvet" --out ./refs
zetta image edit image:812 -p "remove the cushion"
```

## Combine 2–14 pictures

```bash
zetta image compose sofa.png lamp.png rug.png -p "a cosy living room with these items" --aspect-ratio 16:9
```

## Remove a background

```bash
zetta image remove-bg photo.jpg                   # saves photo-nobg.png next to it
zetta image remove-bg photo.jpg --out clean.png
```

`zetta generate --remove-bg` does this automatically before building a model.

## The image library

```bash
zetta image list --kind generate --search lamp
zetta image get 812
zetta image download 812 --out ./refs
zetta image delete 812 --yes
```

## Pictures → 3D

```bash
zetta image generate -p "a brass desk lamp" --for-3d --out ./refs --json     # note the imageId
zetta generate -i image:812 --engine n2.5 --max-credits 100 --out ./models
```
