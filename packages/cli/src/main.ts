#!/usr/bin/env bun
import { COMMANDS, GROUPS, INTRO } from './commands'
import { runProgram } from './core/program'
import { cleanupOldBinaries, isCompiledBinary } from './upgrade'
import { refreshInstalledSkills } from './skill/bundle'
import { maybeNotifyUpdate } from './update-notice'

// A Windows self-update leaves the previous executable beside the new one.
if (process.platform === 'win32' && isCompiledBinary()) {
  try {
    cleanupOldBinaries()
  } catch {
    // best effort
  }
}

// `zetta … | head` closes the pipe early; that is a normal way to read output, not an error.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(0)
    throw error
  })
}

const controller = new AbortController()
let interrupted = false
process.on('SIGINT', () => {
  if (interrupted) process.exit(130)
  interrupted = true
  controller.abort(new Error('Interrupted'))
  process.stderr.write('\nStopping… (press Ctrl-C again to quit now). Jobs already started keep running on the server.\n')
})

// No top-level await: release builds are compiled to bytecode, which needs a CommonJS-shaped entry.
void (async () => {
  const args = process.argv.slice(2)
  const code = await runProgram(args, { commands: COMMANDS, groups: GROUPS, intro: INTRO, signal: controller.signal })
  if (args[0] !== 'mcp' && args[0] !== 'upgrade') await maybeNotifyUpdate()
  // After an upgrade by any route, bring installed copies of the agent skill up to this version.
  if (isCompiledBinary() && args[0] !== 'skill') await refreshInstalledSkills()
  process.exitCode = code
})()
