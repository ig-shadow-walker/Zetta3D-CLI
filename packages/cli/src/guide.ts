import { SKILL_REFERENCES } from './skill/sources'
import { VERSION } from './version'

/** The agent guide printed by `zetta guide`. skill/SKILL.md carries the same text with skill front matter. */
export const AGENT_GUIDE = `# Zetta 3D CLI — guide for AI agents

\`zetta\` drives a Zetta 3D account: make 3D models from text or pictures, refine them
(retopology, segmentation, UVs, texturing, rigging, format conversion), make pictures
and texture maps, build Gaussian-splat worlds, and run multi-step pipelines. It talks only to the Zetta 3D API.

## Ground rules

- Output is JSON whenever stdout is not a terminal. Parse stdout; diagnostics go to stderr.
- Every error is JSON on stderr: {"error":{"code","message","details","hint","exitCode"}}.
  Branch on \`code\` or the exit code, and follow \`hint\` — it names the next command.
- Exit codes: 0 ok · 2 fix the input · 3 sign in · 4 no paid plan / plan does not allow it · 5 credits/spend limit
  · 6 not found · 7 conflict/concurrency · 8 rate limited · 9 job failed (refunded) · 10 still
  running (wait again) · 11 network/server.
- Never prompts without a terminal: missing confirmation is an error, not a hang.
- \`zetta commands --json\` lists every command and flag. \`zetta schema <command>\` gives the JSON
  Schema of its input. Any command takes \`--input '<json>'\` (keys = flag names in camelCase).

## Start of a session

    zetta upgrade --check        # a newer zetta out? tell the user, who updates with \`upgradeWith\` (zetta upgrade)
    zetta auth status            # signed in? (else: ask the user to run \`zetta auth login\`, or use ZETTA_API_KEY)
    zetta account credits        # 3D credits available (1 credit = €0.01) and whether the plan can spend
    zetta catalog entitlements   # what the plan allows (engines, quads, private, multi-view…)
    zetta catalog engines        # engines and their limits

## Spending credits (read this)

Everything that makes something needs a paid plan; without one it fails with PLAN_REQUIRED
(exit 4). Tell the user: \`zetta billing plans\`, or \`zetta account redeem <code>\` for a trial.

Paid commands: \`generate\`, \`refine *\`, \`splat create\`, \`splat export\`, \`pipeline run/batch\`.
AI tokens (not credits): \`pipeline draft\`, \`asset auto-tag\`, \`asset rig-check\`.
Pictures (\`image *\`, \`asset texture-map\`) need a paid plan too.

1. Price it first: add \`--dry-run\`. Nothing is uploaded or spent; you get {"dryRun":true,"credits":N}.
2. Spend with \`--max-credits N\` (refuses if the price is higher — prefer this) or \`--yes\`.
3. Retry safely: pass the same \`--idempotency-key <key>\` again and you are never charged twice.
Ask the user before spending large amounts. Failed jobs are refunded automatically.

## Long jobs: never block for minutes

Jobs take 30 s to several minutes. Shells time out, so:

    zetta generate --image chair.png --max-credits 100        # returns {"id":123,"status":"queued",…}
    zetta asset wait 123 --timeout 90s --out ./models         # exit 10 = still running → run it again

\`--out <folder>\` waits and downloads in one go; use it only when the wait fits your time limit.
If the user turned on automatic downloads (\`download.auto true\`), jobs wait and download into the
current folder: add \`--no-wait\` to return at once, and \`--no-download\` to \`asset wait\` to only wait.

## Inputs

- Pictures: a local file (PNG/JPEG/WebP, 128–5000 px, ≤ 8 MB), an https URL, or \`image:<id>\`
  from the image library. Models: an asset id, a local .glb, or a URL. Video: a local file or URL.
- Files are uploaded for you. \`--remove-bg\` cleans a product photo first.

## Common recipes

    # Picture → textured model, downloaded
    zetta generate -i photo.jpg --remove-bg --engine n2.5 --max-credits 150 --out ./out
    # Text → model
    zetta generate -p "a stylised wooden treasure chest" --quality lowpoly --max-credits 100
    # Multi-view
    zetta generate --view front=f.png --view back=b.png --view left=l.png --view right=r.png --max-credits 150
    # Game-ready: clean topology, then rig, then FBX
    zetta refine retopo 123 --faces 5000 --max-credits 100 --wait --timeout 90s
    zetta asset rig-check 124                     # suggests --rig-type
    zetta refine rig 124 --rig-type biped --rig-format fbx --max-credits 60 --out ./out
    # Retexture from a description
    zetta refine texture 123 --prompt "weathered bronze" --tier hd --max-credits 80
    # Free local export (obj, fbx or stl)
    zetta asset export 123 --format fbx --out ./out
    # Pictures
    zetta image generate -p "a brass desk lamp, studio light" --for-3d --out ./refs
    # Many inputs at once: a pipeline batch (see \`zetta pipeline schema\` for the YAML format)
    zetta pipeline draft "photo to rigged game character" --output text > recipe.yaml   # or write it
    zetta pipeline create --file recipe.yaml
    zetta pipeline estimate <id>
    zetta pipeline batch <id> ./photos/*.jpg --max-credits 2000
    zetta run wait <runId> --timeout 90s ; zetta run outputs <runId> --out ./out

## Library

    zetta asset list --status success --limit 20
    zetta asset get 123 · zetta asset download 123 --format glb · zetta asset share 123
    zetta asset tag 123 --add prop · zetta asset delete 123 --yes
    zetta asset import chair.obj chair.mtl textures/      # any common 3D format, zipped for you
    zetta asset replace 123 edited.glb --yes              # save a model back over an asset
    zetta asset texture-map 123 --map normal --map roughness --out ./maps

## MCP

Not needed: run these commands in your shell. Don't set up \`zetta mcp\` for yourself, since its
tool list would sit in your context every session. It is for apps that can't run commands, such
as Claude Desktop (\`zetta setup claude-desktop\`).
`

export const SKILL_NAME = 'zetta3d'

export const SKILL_DESCRIPTION =
  'Make, change and manage 3D models with the Zetta 3D CLI (zetta) — text or pictures to 3D, retopology, segmentation, UVs, texturing, rigging, format conversion, pictures and PBR texture maps, Gaussian-splat worlds, multi-step pipelines and batches, and the Zetta 3D library, credits, plan and API keys. Use when the user wants a 3D asset made, edited, downloaded, imported or exported, mentions Zetta 3D or zetta, or asks about their Zetta 3D account.'

const COMPATIBILITY = 'Needs the zetta command-line tool (curl -fsSL https://github.com/ig-shadow-walker/Zetta3D-CLI/releases/latest/download/install.sh | sh, which also installs this skill).'

/** A reference topic name, as `zetta guide <topic>` takes it: the file name without .md. */
export const guideTopic = (file: string) => file.replace(/\.md$/, '')

/** Where to read more: the skill's reference files, or `zetta guide <topic>` outside a skill. */
function moreDetail(where: 'skill' | 'cli'): string {
  const lines = SKILL_REFERENCES.map((r) =>
    where === 'skill' ? `- [references/${r.file}](references/${r.file}): ${r.about}` : `- \`zetta guide ${guideTopic(r.file)}\`: ${r.about}`,
  )
  const intro =
    where === 'skill'
      ? 'Open the one you need; each is the CLI\'s own documentation for that area.'
      : 'Print the one you need; each is the CLI\'s own documentation for that area.'
  return ['## More detail', '', intro, '', ...lines, ''].join('\n')
}

/** The guide as \`zetta guide\` prints it. */
export function guideText(): string {
  return `${AGENT_GUIDE.trim()}\n\n${moreDetail('cli')}`
}

/** SKILL.md as agent frameworks expect it (Agent Skills format): front matter, then the guide. */
export function skillMarkdown(version: string = VERSION): string {
  return [
    '---',
    `name: ${SKILL_NAME}`,
    `description: ${SKILL_DESCRIPTION}`,
    `compatibility: ${COMPATIBILITY}`,
    'metadata:',
    `  version: "${version}"`,
    '---',
    '',
    `<!-- Installed and kept up to date by zetta ${version}; edits here are replaced on the next update. -->`,
    '',
    AGENT_GUIDE.trim(),
    '',
    moreDetail('skill'),
  ].join('\n')
}
