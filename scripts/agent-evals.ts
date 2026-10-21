/**
 * Agent evals: give an AI agent plain requests and check that it finishes them with `zetta` alone.
 *
 *   bun run evals --list                          # show the tasks
 *   ZETTA_TOKEN=… bun run evals                   # free tasks, with Claude Code as the agent
 *   ZETTA_TOKEN=… bun run evals --paid            # also tasks that spend credits (each capped)
 *   bun run evals --only credits,price-only --no-skill --report evals-report.json
 *
 * The agent runs in a fresh folder per task, with the Zetta skill installed there (unless
 * --no-skill, to measure the baseline). Any agent works: --agent takes a command template where
 * {prompt} is replaced by the task (shell-quoted). The default is Claude Code in print mode,
 * allowed to run only `zetta` and to read and write files in the task folder.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { parse as parseYaml } from 'yaml'

interface Check {
  answerMatches?: string
  fileGlob?: string
  command?: string
  exitCode?: number
  noSpend?: boolean
  spendAtMost?: number
}

interface Task {
  id: string
  prompt: string
  paid?: boolean
  maxCredits?: number
  checks: Check[]
}

const { values } = parseArgs({
  options: {
    tasks: { type: 'string', default: join(import.meta.dir, '..', 'evals', 'tasks.yaml') },
    only: { type: 'string' },
    paid: { type: 'boolean', default: false },
    skill: { type: 'boolean', default: true },
    agent: {
      type: 'string',
      default: 'claude -p {prompt} --output-format json --max-turns 40 --allowedTools "Bash(zetta:*)" Read Write Edit Glob',
    },
    zetta: { type: 'string', default: 'zetta' },
    timeout: { type: 'string', default: '1200' },
    list: { type: 'boolean', default: false },
    report: { type: 'string' },
  },
  allowNegative: true,
})

const tasks = (parseYaml(readFileSync(values.tasks, 'utf8')) as Task[]).filter((t) => !values.only || values.only.split(',').includes(t.id))

if (values.list) {
  for (const task of tasks) console.log(`${task.id.padEnd(18)} ${task.paid ? `paid ≤${task.maxCredits}` : 'free     '}  ${task.prompt.replace(/\s+/g, ' ').slice(0, 90)}`)
  process.exit(0)
}

const shellQuote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`

function zetta(args: string, cwd: string): { code: number; json: any } {
  const r = spawnSync('sh', ['-c', `${values.zetta} --json --non-interactive ${args}`], { cwd, encoding: 'utf8', env: { ...process.env, ZETTA_NO_UPDATE_CHECK: '1' } })
  let json: any
  try {
    json = JSON.parse(r.stdout)
  } catch {
    json = undefined
  }
  return { code: r.status ?? 1, json }
}

const credits = (cwd: string): number | undefined => zetta('account credits', cwd).json?.threeD?.total

function globMatches(dir: string, pattern: string): string[] {
  const [folder, file] = pattern.includes('/') ? [pattern.slice(0, pattern.lastIndexOf('/')), pattern.slice(pattern.lastIndexOf('/') + 1)] : ['.', pattern]
  const full = join(dir, folder)
  if (!existsSync(full)) return []
  const re = new RegExp(`^${file.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
  return readdirSync(full).filter((name) => re.test(name))
}

interface Outcome {
  id: string
  passed: boolean
  failures: string[]
  spent: number | null
  seconds: number
  turns: number | null
  agentCostUsd: number | null
  answer: string
}

if (zetta('auth status', tmpdir()).json?.signedIn !== true) {
  console.error('Not signed in. Set ZETTA_TOKEN (or run `zetta auth login`) first.')
  process.exit(2)
}

const outcomes: Outcome[] = []
for (const task of tasks) {
  if (task.paid && !values.paid) {
    console.log(`SKIP  ${task.id} (spends credits; pass --paid)`)
    continue
  }
  const dir = mkdtempSync(join(tmpdir(), `zetta-eval-${task.id}-`))
  if (values.skill) zetta('skill install --project', dir)
  const before = credits(dir)
  const started = Date.now()
  const command = values.agent.replace('{prompt}', shellQuote(task.prompt))
  const run = spawnSync('sh', ['-c', command], { cwd: dir, encoding: 'utf8', timeout: Number(values.timeout) * 1000, env: process.env })
  const seconds = Math.round((Date.now() - started) / 1000)

  let answer = run.stdout ?? ''
  let turns: number | null = null
  let agentCostUsd: number | null = null
  try {
    const parsed = JSON.parse(answer) as { result?: string; num_turns?: number; total_cost_usd?: number }
    answer = parsed.result ?? answer
    turns = parsed.num_turns ?? null
    agentCostUsd = parsed.total_cost_usd ?? null
  } catch {
    // a plain-text agent
  }
  const after = credits(dir)
  const spent = before !== undefined && after !== undefined ? before - after : null

  const failures: string[] = []
  if (run.error) failures.push(`agent did not run: ${run.error.message}`)
  for (const check of task.checks) {
    if (check.answerMatches && !new RegExp(check.answerMatches, 'i').test(answer)) failures.push(`answer does not match /${check.answerMatches}/`)
    if (check.fileGlob && !globMatches(dir, check.fileGlob).length) failures.push(`no file matches ${check.fileGlob}`)
    if (check.command) {
      const code = zetta(check.command, dir).code
      if (code !== (check.exitCode ?? 0)) failures.push(`\`zetta ${check.command}\` exited ${code}`)
    }
    if (check.noSpend && spent !== 0) failures.push(`credits changed by ${spent ?? 'unknown'}`)
    if (check.spendAtMost !== undefined && (spent === null || spent > check.spendAtMost)) failures.push(`spent ${spent ?? 'unknown'} > ${check.spendAtMost}`)
  }
  const outcome: Outcome = { id: task.id, passed: failures.length === 0, failures, spent, seconds, turns, agentCostUsd, answer: answer.slice(0, 2000) }
  outcomes.push(outcome)
  console.log(`${outcome.passed ? 'PASS' : 'FAIL'}  ${task.id} · ${seconds}s · ${turns ?? '?'} turns · spent ${spent ?? '?'} credits${failures.length ? `\n      ${failures.join('\n      ')}` : ''}`)
}

const passed = outcomes.filter((o) => o.passed).length
console.log(`\n${passed}/${outcomes.length} tasks passed${values.skill ? '' : ' (without the skill)'}.`)
if (values.report) writeFileSync(values.report, JSON.stringify({ at: new Date().toISOString(), skill: values.skill, outcomes }, null, 2))
process.exit(passed === outcomes.length ? 0 : 1)
