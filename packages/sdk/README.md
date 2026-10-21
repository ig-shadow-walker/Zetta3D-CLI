# @zetta3d/sdk

The Zetta 3D API as a typed TypeScript library. The `zetta` CLI and its MCP server are built on it.

- **No runtime dependencies.** No Node-, Bun- or browser-only APIs: only `fetch`, `Blob`, `URL` and `crypto.randomUUID`.
- **One error type.** Every failure is a `ZettaError` with a stable `code`, the HTTP `status` (0 when nothing reached the server) and `details`.
- **Talks only to the Zetta 3D API.** It knows nothing about upstream providers.

```ts
import { ZettaClient, buildGenerateRequest, assertSucceeded, selectResultFiles } from '@zetta3d/sdk'

const zetta = new ZettaClient({ token: process.env.ZETTA_TOKEN, clientName: 'my-script' })

// Upload a picture (any Blob: Bun.file(path), fs.openAsBlob(path), a browser File…)
const picture = await zetta.uploads.upload(blob, { contentType: 'image/png' })

// Build and check the request locally: impossible option combinations never reach the server
const built = buildGenerateRequest({ engine: 'n25', imageUrl: picture.fileUrl, quality: 'high' })
if (!built.ok) throw new Error(built.problems.map((p) => p.message).join(' '))

const quote = await zetta.catalog.quote(built.quote) // free
const { generation } = await zetta.generations.create(built.request) // charged; an idempotency key is sent automatically
const done = await zetta.generations.wait(generation.id, { timeoutMs: 10 * 60_000 })
assertSucceeded(done.generation)
for (const file of selectResultFiles(done.generation, { primary: true })) {
  const { url } = await zetta.generations.downloadLink(done.generation.id, file.key)
  // fetch(url) — a pre-signed link; send no credentials
}
```

## What's inside

| Module | What it does |
|---|---|
| `ZettaClient` | `auth`, `billing`, `catalog`, `generations`, `uploads`, `images`, `tools`, `pipelines`, `runs` |
| `Transport` | Bearer auth and retries (reads, keyed writes and 429), timeouts, error normalisation |
| `Uploads` | The ticketed relay: one PUT up to 8 MiB, multipart above that, ticket refresh on 410 |
| `builders` | The web Studio's request rules for generate, refine, splat and world export, plus the image prompts that feed them |
| `pipeline` (namespace) | Graph types, node catalogue, `requestFor`, validation, and the friendly recipe format (`compilePipeline` / `decompilePipeline`) |
| `export` | GLB → OBJ (with MTL and textures) or binary STL, locally |
| `files` | Picture, video and GLB detection, the engines' input checks, base64 helpers |

The package is private for now. It could be published once the API offers API keys (see ROADMAP.md, B3).
