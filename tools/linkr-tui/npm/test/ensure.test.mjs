import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { ensureBinary, cachedBinary, isExecutable } = require('../lib/ensure.js')
const { hostTarget, assetName, detectLibc } = require('../lib/resolve.js')

const VERSION = require('../package.json').version

/** A fake release directory: one executable asset plus its SHA256SUMS. */
function fakeRelease(body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bee-cli-release-'))
  const target = hostTarget(process.platform, process.arch, detectLibc())
  const asset = assetName(target, process.platform)
  const file = path.join(root, asset)
  fs.writeFileSync(file, body, { mode: 0o755 })
  const hex = createHash('sha256').update(body).digest('hex')
  fs.writeFileSync(path.join(root, 'SHA256SUMS'), `${hex}  ${asset}\n`)
  return { root, asset, hex, target }
}

test('a release asset is downloaded, verified and cached', async () => {
  const release = fakeRelease(`#!/bin/sh\necho bee-cli ${VERSION}\n`)
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'bee-cli-cache-'))
  const env = { BEE_CLI_BASE_URL: `file://${release.root}`, BEE_CLI_CACHE_DIR: cache }
  const binary = await ensureBinary({ env, quiet: true })
  assert.ok(isExecutable(binary))
  assert.match(fs.readFileSync(binary, 'utf8'), /bee-cli/)
  const cached = cachedBinary(VERSION, { BEE_CLI_CACHE_DIR: cache })
  assert.equal(cached, binary, 'the second call answers from the cache')
})

test('a tampered asset is refused and nothing is cached', async () => {
  const release = fakeRelease(`#!/bin/sh\necho tampered\n`)
  fs.writeFileSync(path.join(release.root, release.asset), '#!/bin/sh\necho something else\n', { mode: 0o755 })
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'bee-cli-cache-'))
  const env = { BEE_CLI_BASE_URL: `file://${release.root}`, BEE_CLI_CACHE_DIR: cache }
  await assert.rejects(ensureBinary({ env, quiet: true }), /checksum mismatch/)
  assert.equal(cachedBinary(VERSION, { BEE_CLI_CACHE_DIR: cache }), null)
})

test('a release without a checksum entry is refused', async () => {
  const release = fakeRelease(`#!/bin/sh\necho no sums\n`)
  fs.writeFileSync(path.join(release.root, 'SHA256SUMS'), '')
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'bee-cli-cache-'))
  const env = { BEE_CLI_BASE_URL: `file://${release.root}`, BEE_CLI_CACHE_DIR: cache }
  await assert.rejects(ensureBinary({ env, quiet: true }), /no SHA256SUMS entry/)
})

test('an explicit BEE_CLI_BINARY wins, and a bad one is named', async () => {
  const release = fakeRelease(`#!/bin/sh\necho explicit\n`)
  const env = { BEE_CLI_BINARY: path.join(release.root, release.asset) }
  assert.equal(await ensureBinary({ env, quiet: true }), env.BEE_CLI_BINARY)
  await assert.rejects(ensureBinary({ env: { BEE_CLI_BINARY: '/nope/bee-cli' }, quiet: true }), /not an executable file/)
})
