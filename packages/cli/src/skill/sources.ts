/**
 * Which docs pages the agent skill carries as reference files, and how they are adapted.
 * `bun run docs:commands` runs this over docs/ and embeds the result (docs.generated.ts), because the
 * compiled binary has no docs folder to read.
 */

export interface SkillReference {
  /** File name under the skill's references/ folder. */
  file: string
  /** The docs page it comes from (docs/<doc>), or null when the binary builds it itself. */
  doc: string | null
  /** One line for SKILL.md: when to open it. */
  about: string
}

export const SKILL_REFERENCES: SkillReference[] = [
  { file: 'generating.md', doc: 'generating.md', about: 'engines, every generate option and limit, multi-view, splat worlds' },
  { file: 'refining.md', doc: 'refining.md', about: 'retopology, segmentation, UVs, texturing, rigging, conversion' },
  { file: 'pipelines.md', doc: 'pipelines.md', about: 'recipe YAML, every step kind, runs, batches, drafts from a description' },
  { file: 'library.md', doc: 'library.md', about: 'listing, waiting, downloading, importing, replacing, texture maps, sharing, deleting' },
  { file: 'images.md', doc: 'images.md', about: 'making, editing and combining pictures; background removal' },
  { file: 'account.md', doc: 'authentication.md', about: 'sign-in (browser, API keys), plans, trial codes, billing, usage' },
  { file: 'configuration.md', doc: 'configuration.md', about: 'settings, profiles, automatic downloads, environment variables' },
  { file: 'errors.md', doc: 'troubleshooting.md', about: 'every error code and exit code, and what to do about it' },
  { file: 'commands.md', doc: null, about: 'every command and flag (generated from this exact version)' },
]

/** docs page → reference file, for rewriting links between pages. */
const LINKED = new Map<string, string>([...SKILL_REFERENCES.filter((r) => r.doc).map((r) => [r.doc!, r.file] as const), ['COMMANDS.md', 'commands.md']])

/**
 * A docs page as a reference file: links to other carried pages point at their reference file;
 * links to pages the skill does not carry keep their text and lose the link.
 */
export function adaptDoc(markdown: string): string {
  return markdown.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, text: string, target: string) => {
    if (/^(https?:|mailto:|#)/.test(target)) return whole
    const [path = '', anchor] = target.split('#')
    const name = path.split('/').pop() ?? ''
    const file = LINKED.get(name)
    if (file && !path.includes('..')) return `[${text}](${file}${anchor ? `#${anchor}` : ''})`
    return text
  })
}

/** The reference files built from docs pages; `read` returns a page's text (docs/<name>). */
export function buildReferenceDocs(read: (doc: string) => string): Record<string, string> {
  const files: Record<string, string> = {}
  for (const ref of SKILL_REFERENCES) if (ref.doc) files[ref.file] = adaptDoc(read(ref.doc))
  return files
}
