/** The agent guide printed by `zetta guide`. skill/SKILL.md carries the same text with skill front matter. */
export const AGENT_GUIDE = `# Zetta 3D CLI — guide for AI agents

\`zetta\` drives a Zetta 3D account: make 3D models from text or pictures, refine them
(retopology, segmentation, UVs, texturing, rigging, format conversion), make pictures, build
Gaussian-splat worlds, and run multi-step pipelines. It talks only to the Zetta 3D API.

## Ground rules

- Output is JSON whenever stdout is not a terminal. Parse stdout; diagnostics go to stderr.
- Every error is JSON on stderr: {"error":{"code","message","details","hint","exitCode"}}.
  Branch on \`code\` or the exit code, and follow \`hint\` — it names the next command.
- Exit codes: 0 ok · 2 fix the input · 3 sign in · 4 plan does not allow it · 5 credits/spend limit
  · 6 not found · 7 conflict/concurrency · 8 rate limited · 9 job failed (refunded) · 10 still
  running (wait again) · 11 network/server.
- Never prompts without a terminal: missing confirmation is an error, not a hang.
- \`zetta commands --json\` lists every command and flag. \`zetta schema <command>\` gives the JSON
  Schema of its input. Any command takes \`--input '<json>'\` (keys = flag names in camelCase).

## Start of a session

    zetta auth status            # signed in? (else: ask the user to run \`zetta auth login\`, or use ZETTA_TOKEN)
    zetta account credits        # 3D credits available (1 credit = €0.01)
    zetta catalog entitlements   # what the plan allows (engines, quads, private, multi-view…)
    zetta catalog engines        # engines and their limits

## Spending credits (read this)

Paid commands: \`generate\`, \`refine *\`, \`splat create\`, \`splat export\`.

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
    zetta pipeline create --file recipe.yaml
    zetta pipeline estimate <id>
    zetta pipeline batch <id> ./photos/*.jpg --max-credits 2000
    zetta run wait <runId> --timeout 90s ; zetta run outputs <runId> --out ./out

## Library

    zetta asset list --status success --limit 20
    zetta asset get 123 · zetta asset download 123 --format glb · zetta asset share 123
    zetta asset tag 123 --add prop · zetta asset delete 123 --yes

## MCP

\`zetta mcp --budget 500\` serves every command as an MCP tool with the same checks; the budget
caps what the session may spend.
`

export const SKILL_NAME = 'zetta3d'

export const SKILL_DESCRIPTION =
  'Make and edit 3D models with the Zetta 3D CLI — text or pictures to 3D, retopology, segmentation, UVs, texturing, rigging, format conversion, splat worlds, image generation and pipelines. Use when the user wants a 3D asset made, changed, downloaded or exported, or asks about their Zetta 3D account, credits or library.'

/** SKILL.md as agent frameworks expect it: front matter, then the guide. */
export function skillMarkdown(): string {
  return [
    '---',
    `name: ${SKILL_NAME}`,
    `description: ${SKILL_DESCRIPTION}`,
    '---',
    '',
    AGENT_GUIDE.trim(),
    '',
    'Full command reference: run `zetta commands --json` (or `zetta <command> --help`).',
    '',
  ].join('\n')
}
