import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const launcher = path.join(here, '..', 'bin', 'bee-cli.js')

/** Run the launcher against `sleep`, then signal it and watch it die. */
function runAndSignal(signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [launcher, '30'], {
      env: { ...process.env, BEE_CLI_BINARY: '/bin/sleep' },
      stdio: 'ignore',
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('the launcher did not exit after ' + signal))
    }, 5000)
    child.on('exit', (code, sig) => {
      clearTimeout(timer)
      resolve({ code, sig })
    })
    setTimeout(() => child.kill(signal), 400)
  })
}

test('a forwarded signal ends the launcher, not just the child', async () => {
  const { code, sig } = await runAndSignal('SIGTERM')
  assert.equal(code, null, `exited with code ${code} instead of by signal`)
  assert.equal(sig, 'SIGTERM')
})

test('an interrupted launcher also dies by signal', async () => {
  const { sig } = await runAndSignal('SIGINT')
  assert.equal(sig, 'SIGINT')
})
