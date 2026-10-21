#!/usr/bin/env bun
import { COMMANDS, GROUPS, INTRO } from './commands'
import { runProgram } from './core/program'
import { cleanupOldBinaries, isCompiledBinary } from './upgrade'
import { maybeNotifyUpdate } from './update-notice'

// A Windows self-update leaves the previous executable beside the new one.
if (process.platform === 'win32' && isCompiledBinary()) {
  try {
    cleanupOldBinaries()
  } catch {
    // best effort
  }
}

const controller = new AbortController()
let interrupted = false
process.on('SIGINT', () => {
  if (interrupted) process.exit(130)
  interrupted = true
  controller.abort(new Error('Interrupted'))
  process.stderr.write('\nStopping… (press Ctrl-C again to quit now). Jobs already started keep running on the server.\n')
})

const code = await runProgram(process.argv.slice(2), {
  commands: COMMANDS,
  groups: GROUPS,
  intro: INTRO,
  signal: controller.signal,
})
const args = process.argv.slice(2)
if (args[0] !== 'mcp' && args[0] !== 'upgrade') await maybeNotifyUpdate()
process.exitCode = code
