#!/usr/bin/env node
'use strict'
/**
 * `npx linkr-bee-cli …` / the installed `bee-cli` shim.
 *
 * The arguments go straight to the real program, with the parent's stdio so a
 * TUI or an interactive session behaves as if it had been run directly, and
 * the exit status is the target program's own.
 */

const { spawn } = require('node:child_process')
const { ensureBinary } = require('../lib/ensure')

async function main() {
  let binary
  try {
    binary = await ensureBinary()
  } catch (error) {
    process.stderr.write(`bee-cli: ${error.message}\n`)
    process.exit(1)
  }
  const child = spawn(binary, process.argv.slice(2), { stdio: 'inherit' })
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
    process.on(signal, () => {
      try {
        child.kill(signal)
      } catch {
        /* the child is already gone */
      }
    })
  }
  child.on('error', (error) => {
    process.stderr.write(`bee-cli: cannot run ${binary}: ${error.message}\n`)
    process.exit(1)
  })
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    else process.exit(code === null ? 1 : code)
  })
}

main()
