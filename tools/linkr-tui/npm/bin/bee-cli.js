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
  // Keep the listeners so they can be removed again: a re-raised signal that
  // this process still handles would be forwarded to a dead child and ignored.
  const relays = new Map()
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
    const relay = () => {
      try {
        child.kill(signal)
      } catch {
        /* the child is already gone */
      }
    }
    relays.set(signal, relay)
    process.on(signal, relay)
  }
  child.on('error', (error) => {
    process.stderr.write(`bee-cli: cannot run ${binary}: ${error.message}\n`)
    process.exit(1)
  })
  child.on('exit', (code, signal) => {
    if (!signal) {
      process.exit(code === null ? 1 : code)
      return
    }
    // Die the way the child died — but stop listening first, or this process
    // catches its own re-raised signal, forwards it to a dead child and lives
    // on, which is how a Ctrl-C in a terminal left the launcher running.
    for (const [name, relay] of relays) process.removeListener(name, relay)
    process.kill(process.pid, signal)
  })
}

main()
