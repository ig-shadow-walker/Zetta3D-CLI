/**
 * Generates the README artwork in docs/assets/ from the brand tokens:
 *   banner-dark.svg, banner-light.svg      the header
 *   terminal.svg                           a terminal session (static text, blinking cursor)
 *   how-it-works-dark.svg / -light.svg     agents → zetta → Zetta 3D → files
 *   social-preview.png                     1280×640 card for the GitHub repository settings
 *
 *   bun run readme:art
 *
 * Fonts (Figtree, Geist, Geist Mono; SIL Open Font License) are embedded so the SVGs look the
 * same on GitHub as in the brand kit. The PNG is rendered with headless Chrome when available.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ASSETS = join(import.meta.dir, '..', 'docs', 'assets')
const font = (file: string) => readFileSync(join(ASSETS, 'fonts', file)).toString('base64')
const FONTS = `
  @font-face { font-family: 'Figtree'; font-weight: 400 900; src: url(data:font/woff2;base64,${font('figtree-latin.woff2')}) format('woff2'); }
  @font-face { font-family: 'Geist'; font-weight: 400 700; src: url(data:font/woff2;base64,${font('geist-latin.woff2')}) format('woff2'); }
  @font-face { font-family: 'Geist Mono'; font-weight: 400 600; src: url(data:font/woff2;base64,${font('geist-mono-latin.woff2')}) format('woff2'); }`

const T = {
  ink: '#15130F',
  inkSoft: '#2A2620',
  umber: '#55514A',
  stone: '#C2BCAE',
  sand: '#DFDACE',
  linen: '#EFEBE2',
  cream: '#F7F4EE',
  paper: '#FAF8F4',
  signal: '#1677FF',
  signalDeep: '#0E58C0',
  signalLight: '#69B1FF',
  success: '#3C7A5B',
}

const DISPLAY = `'Figtree', 'Helvetica Neue', Arial, sans-serif`
const SANS = `'Geist', -apple-system, 'Segoe UI', Arial, sans-serif`
const MONO = `'Geist Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace`

/** The three-plane Zetta mark, scaled into a box at (x, y). */
function mark(x: number, y: number, size: number, fill: string): string {
  const s = size / 200
  return `<g transform="translate(${x} ${y}) scale(${s})" fill="${fill}">
    <path d="M 26 48 L 122 28 L 174 48 L 78 68 Z"/>
    <path d="M 26 100 L 122 80 L 174 100 L 78 120 Z"/>
    <path d="M 26 152 L 122 132 L 174 152 L 78 172 Z"/>
  </g>`
}

function dots(id: string, color: string, opacity: number): string {
  return `<pattern id="${id}" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.1" fill="${color}" opacity="${opacity}"/></pattern>`
}

const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// ── Banner ──────────────────────────────────────────────────────────────────

function banner(theme: 'dark' | 'light'): string {
  const dark = theme === 'dark'
  const bg = dark ? T.ink : T.cream
  const fg = dark ? T.paper : T.ink
  const muted = dark ? T.stone : T.umber
  const card = dark ? '#1E1B16' : T.paper
  const cardLine = dark ? '#34302A' : T.sand
  const W = 1280
  const H = 420
  const cmdX = 742
  const cmdY = 118
  const lines: Array<[string, string]> = [
    ['$ ', 'zetta generate --image chair.png --engine n2.5'],
    ['', '  status:  success · credits: 50'],
    ['', '  saved:   ./models/1234-model.glb'],
    ['$ ', 'zetta refine rig 1234 --rig-format fbx --yes'],
    ['$ ', 'zetta mcp --budget 500'],
  ]
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Zetta 3D CLI: 3D generation from your terminal, built for people and AI agents">
  <title>Zetta 3D CLI</title>
  <defs>
    <style>${FONTS}</style>
    ${dots('dots', dark ? T.paper : T.ink, dark ? 0.07 : 0.08)}
    <radialGradient id="glow" cx="0.78" cy="0.45" r="0.55">
      <stop offset="0" stop-color="${T.signal}" stop-opacity="${dark ? 0.22 : 0.12}"/>
      <stop offset="1" stop-color="${T.signal}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" rx="20" fill="${bg}"/>
  <rect width="${W}" height="${H}" rx="20" fill="url(#dots)"/>
  <rect width="${W}" height="${H}" rx="20" fill="url(#glow)"/>

  ${mark(64, 56, 54, fg)}
  <text x="128" y="94" font-family="${DISPLAY}" font-weight="700" font-size="30" letter-spacing="-0.6" fill="${fg}">Zetta 3D</text>
  <rect x="262" y="70" width="52" height="30" rx="8" fill="${T.signal}"/>
  <text x="288" y="91" text-anchor="middle" font-family="${MONO}" font-weight="600" font-size="16" fill="#FFFFFF">CLI</text>

  <text x="64" y="196" font-family="${DISPLAY}" font-weight="800" font-size="56" letter-spacing="-2" fill="${fg}">3D generation,</text>
  <text x="64" y="258" font-family="${DISPLAY}" font-weight="800" font-size="56" letter-spacing="-2" fill="${fg}">from your terminal.</text>
  <text x="64" y="310" font-family="${SANS}" font-size="20" fill="${muted}">Text, pictures and views to production-ready 3D.</text>
  <text x="64" y="340" font-family="${SANS}" font-size="20" fill="${muted}">Built for people and for AI agents.</text>

  <g>
    <rect x="${cmdX}" y="${cmdY - 46}" width="476" height="252" rx="14" fill="${card}" stroke="${cardLine}"/>
    <circle cx="${cmdX + 24}" cy="${cmdY - 22}" r="6" fill="#FF5F57"/>
    <circle cx="${cmdX + 44}" cy="${cmdY - 22}" r="6" fill="#FEBC2E"/>
    <circle cx="${cmdX + 64}" cy="${cmdY - 22}" r="6" fill="#28C840"/>
    ${lines
      .map(([prompt, text], i) => {
        const y = cmdY + 20 + i * 38
        const isCmd = prompt === '$ '
        return `<text xml:space="preserve" x="${cmdX + 24}" y="${y}" font-family="${MONO}" font-size="14.5" fill="${isCmd ? fg : muted}">${isCmd ? `<tspan fill="${T.signal}">$</tspan> ` : ''}${esc(text)}</text>`
      })
      .join('\n    ')}
  </g>
</svg>
`
}

// ── Terminal session ────────────────────────────────────────────────────────

type Line = { kind: 'cmd' | 'out' | 'ok' | 'dim' | 'blank'; text?: string }

function terminal(): string {
  const session: Line[] = [
    { kind: 'cmd', text: 'zetta generate --image chair.png --engine n2.5 --dry-run' },
    { kind: 'out', text: 'Price: 50 credits (nothing was spent)' },
    { kind: 'blank' },
    { kind: 'cmd', text: 'zetta generate --image chair.png --engine n2.5 --max-credits 60 --out ./models' },
    { kind: 'out', text: '#1234 · image to 3D · Zetta N2.5' },
    { kind: 'ok', text: '  status:  success' },
    { kind: 'out', text: '  credits: 50' },
    { kind: 'out', text: '  saved:   ./models/1234-model.glb' },
    { kind: 'blank' },
    { kind: 'cmd', text: 'zetta refine rig 1234 --rig-type biped --rig-format fbx --yes --out ./models' },
    { kind: 'out', text: '#1235 · auto rig' },
    { kind: 'ok', text: '  status:  success' },
    { kind: 'out', text: '  credits: 42' },
    { kind: 'out', text: '  saved:   ./models/1235-model.fbx' },
    { kind: 'blank' },
    { kind: 'cmd', text: 'zetta asset export 1235 --format stl --out ./print' },
    { kind: 'out', text: 'Saved ./print/1235-model.stl' },
  ]
  const W = 960
  const top = 64
  const step = 25
  const H = top + (session.length + 1) * step + 28
  const colors: Record<Line['kind'], string> = { cmd: T.paper, out: '#B9B3A6', ok: '#7CC4A0', dim: T.umber, blank: T.paper }
  // Static text, so the session reads the same in viewers that don't animate SVG; only the cursor blinks.
  const rows = session
    .map((line, i) => {
      const y = top + 18 + i * step
      if (line.kind === 'blank') return ''
      const content = line.kind === 'cmd' ? `<tspan fill="${T.signalLight}">$</tspan> ${esc(line.text!)}` : esc(line.text!)
      return `<text xml:space="preserve" x="28" y="${y}" font-family="${MONO}" font-size="14.5" fill="${colors[line.kind]}">${content}</text>`
    })
    .filter(Boolean)
    .join('\n  ')
  const promptY = top + 18 + session.length * step
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="A terminal session: pricing a model with --dry-run, generating it from a picture, rigging it as FBX, and exporting an STL locally">
  <title>zetta in a terminal</title>
  <defs><style>${FONTS}
    .cursor { animation: blink 1.1s steps(1) infinite; }
    @keyframes blink { 50% { opacity: 0; } }
    @media (prefers-reduced-motion: reduce) { .cursor { animation: none; } }
  </style></defs>
  <rect width="${W}" height="${H}" rx="14" fill="${T.ink}"/>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="14" fill="none" stroke="#34302A"/>
  <circle cx="26" cy="24" r="6.5" fill="#FF5F57"/>
  <circle cx="48" cy="24" r="6.5" fill="#FEBC2E"/>
  <circle cx="70" cy="24" r="6.5" fill="#28C840"/>
  <text x="${W / 2}" y="29" text-anchor="middle" font-family="${SANS}" font-size="13" fill="${T.stone}">~/project — zetta</text>
  <line x1="0" y1="46" x2="${W}" y2="46" stroke="#2A2620"/>
  ${rows}
  <text x="28" y="${promptY}" font-family="${MONO}" font-size="14.5" fill="${T.signalLight}">$</text>
  <rect class="cursor" x="44" y="${promptY - 13}" width="9" height="17" fill="${T.paper}"/>
</svg>
`
}

// ── How it works ────────────────────────────────────────────────────────────

function howItWorks(theme: 'dark' | 'light'): string {
  const dark = theme === 'dark'
  const bg = dark ? T.ink : T.cream
  const fg = dark ? T.paper : T.ink
  const muted = dark ? T.stone : T.umber
  const box = dark ? '#1E1B16' : T.paper
  const line = dark ? '#3A352E' : T.sand
  const W = 1280
  const H = 330
  const cols = [
    { x: 51, title: 'You or your agent', items: ['Claude Code · Codex', 'Cursor · Claude Desktop', 'scripts · CI'] },
    { x: 367, title: 'zetta', items: ['100+ commands · JSON', 'MCP server · skill', 'spend guard'], accent: true },
    { x: 683, title: 'Zetta 3D', items: ['generate · refine', 'splat · images', 'pipelines · library'] },
    { x: 999, title: 'Your files', items: ['GLB · FBX · OBJ', 'STL · USDZ · glTF', 'PLY'] },
  ]
  const boxW = 230
  const boxY = 92
  const boxH = 170
  const boxes = cols
    .map(
      (c) => `<g>
    <rect x="${c.x}" y="${boxY}" width="${boxW}" height="${boxH}" rx="16" fill="${box}" stroke="${c.accent ? T.signal : line}" stroke-width="${c.accent ? 2 : 1}"/>
    ${c.accent ? mark(c.x + 22, boxY + 22, 34, fg) : ''}
    <text x="${c.accent ? c.x + 64 : c.x + 24}" y="${boxY + 46}" font-family="${c.accent ? MONO : DISPLAY}" font-weight="700" font-size="${c.accent ? 22 : 20}" fill="${fg}">${esc(c.title)}</text>
    ${c.items.map((it, i) => `<text x="${c.x + 24}" y="${boxY + 92 + i * 28}" font-family="${SANS}" font-size="14.5" fill="${muted}">${esc(it)}</text>`).join('\n    ')}
  </g>`,
    )
    .join('\n  ')
  const arrows = [0, 1, 2]
    .map((i) => {
      const x1 = cols[i]!.x + boxW + 6
      const x2 = cols[i + 1]!.x - 8
      const y = boxY + boxH / 2
      return `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${T.signal}" stroke-width="2"/><path d="M ${x2} ${y - 6} L ${x2 + 8} ${y} L ${x2} ${y + 6} Z" fill="${T.signal}"/>`
    })
    .join('\n  ')
  const labels = ['shell / MCP', 'HTTPS API', 'download']
    .map((label, i) => {
      const x = (cols[i]!.x + boxW + cols[i + 1]!.x) / 2
      return `<text x="${x}" y="${boxY + boxH / 2 - 14}" text-anchor="middle" font-family="${SANS}" font-size="12" fill="${muted}">${label}</text>`
    })
    .join('\n  ')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="How it works: you or your AI agent call zetta from the shell or over MCP; zetta calls the Zetta 3D API to generate, refine and manage models; the results come back as GLB, FBX, OBJ, STL, USDZ, glTF or PLY files">
  <title>How zetta works</title>
  <defs><style>${FONTS}</style>${dots('d2', dark ? T.paper : T.ink, dark ? 0.06 : 0.07)}</defs>
  <rect width="${W}" height="${H}" rx="20" fill="${bg}"/>
  <rect width="${W}" height="${H}" rx="20" fill="url(#d2)"/>
  <text x="51" y="56" font-family="${DISPLAY}" font-weight="800" font-size="26" letter-spacing="-0.6" fill="${fg}">How it works</text>
  ${boxes}
  ${arrows}
  ${labels}
</svg>
`
}

writeFileSync(join(ASSETS, 'banner-dark.svg'), banner('dark'))
writeFileSync(join(ASSETS, 'banner-light.svg'), banner('light'))
writeFileSync(join(ASSETS, 'terminal.svg'), terminal())
writeFileSync(join(ASSETS, 'how-it-works-dark.svg'), howItWorks('dark'))
writeFileSync(join(ASSETS, 'how-it-works-light.svg'), howItWorks('light'))

// Social preview: the dark banner, centred on a 1280×640 card.
const social = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 640" width="1280" height="640">
  <rect width="1280" height="640" fill="${T.ink}"/>
  <image href="data:image/svg+xml;base64,${Buffer.from(banner('dark')).toString('base64')}" x="0" y="110" width="1280" height="420"/>
</svg>`
const chrome = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'google-chrome', 'chromium'].find((c) => c.startsWith('/') ? existsSync(c) : spawnSync('which', [c]).status === 0)
if (chrome) {
  const tmp = join(ASSETS, '.social.svg')
  writeFileSync(tmp, social)
  spawnSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', `--screenshot=${join(ASSETS, 'social-preview.png')}`, '--window-size=1280,640', `file://${tmp}`], { stdio: 'ignore', timeout: 60_000 })
  spawnSync('rm', ['-f', tmp])
}
console.log(`Wrote docs/assets: banner-dark.svg, banner-light.svg, terminal.svg, how-it-works-{dark,light}.svg${chrome ? ', social-preview.png' : ' (no Chrome: skipped social-preview.png)'}`)
