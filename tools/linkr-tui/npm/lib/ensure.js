'use strict'
/**
 * Make sure this machine has a runnable `bee-cli`, and answer its path.
 *
 * Order, first win:
 *   1. `$BEE_CLI_BINARY`             an explicit path (CI, a checkout, a packager)
 *   2. a cached download             `~/.cache/bee-cli/<version>/<target>/bee-cli`
 *   3. the release asset             `bee-cli-<target>` beside the SHA256SUMS
 */

const fs = require('node:fs')
const path = require('node:path')
const {
  assetName,
  hostTarget,
  detectLibc,
  cachePath,
  releaseBase,
  checksumFor,
  sha256File,
} = require('./resolve')
const { download, fetchText } = require('./download')

const VERSION = require('../package.json').version

const BUILD_HINT =
  'no prebuilt bee-cli for this platform; build it from source: ' +
  'git clone https://github.com/radxa/linkr-bee && cd linkr-bee/cliproxy-import/tools/linkr-tui && ' +
  'cargo build --release --no-default-features --features cli, then set BEE_CLI_BINARY to that binary ' +
  '(or BEE_CLI_TARGET to a release target name).'

/** Whether a path is a file this process may execute. */
function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** The cached binary for this machine, if a previous run left one. */
function cachedBinary(version = VERSION, env = process.env) {
  const target = env.BEE_CLI_TARGET || hostTarget(process.platform, process.arch, detectLibc())
  if (!target) return null
  const file = cachePath(version, target, { env, platform: process.platform })
  return isExecutable(file) ? file : null
}

/**
 * Answer a runnable binary, downloading and verifying the release asset when
 * there is no usable cache. Throws with a build hint when the platform has no
 * published asset; a caller that can do without the binary should catch.
 */
async function ensureBinary({ version = process.env.BEE_CLI_VERSION || VERSION, env = process.env, quiet = false } = {}) {
  if (env.BEE_CLI_BINARY) {
    if (!isExecutable(env.BEE_CLI_BINARY)) throw new Error(`BEE_CLI_BINARY is not an executable file: ${env.BEE_CLI_BINARY}`)
    return env.BEE_CLI_BINARY
  }
  const cached = cachedBinary(version, env)
  if (cached) return cached

  const target = env.BEE_CLI_TARGET || hostTarget(process.platform, process.arch, detectLibc())
  if (!target) throw new Error(BUILD_HINT)

  const asset = assetName(target, process.platform)
  const base = releaseBase(version, env)
  const destination = cachePath(version, target, { env, platform: process.platform })
  if (!quiet) process.stderr.write(`bee-cli: fetching ${base}/${asset}\n`)

  const tmp = `${destination}.${process.pid}.part`
  try {
    await download(`${base}/${asset}`, tmp)
    const expected = env.BEE_CLI_SHA256 || checksumFor(await fetchText(`${base}/SHA256SUMS`), asset)
    if (!expected) throw new Error(`the release has no SHA256SUMS entry for ${asset}; refusing an unverified binary`)
    const actual = await sha256File(tmp)
    if (actual !== expected.toLowerCase()) {
      throw new Error(`checksum mismatch for ${asset}: expected ${expected}, got ${actual}`)
    }
    await fs.promises.chmod(tmp, 0o755)
    await fs.promises.mkdir(path.dirname(destination), { recursive: true })
    await fs.promises.rename(tmp, destination)
    return destination
  } catch (error) {
    await fs.promises.rm(tmp, { force: true })
    throw error
  }
}

module.exports = { ensureBinary, cachedBinary, isExecutable, VERSION }
