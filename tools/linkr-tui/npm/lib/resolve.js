'use strict'
/**
 * Where the real `bee-cli` binary lives for this machine, and how this package
 * finds, verifies and caches it.
 *
 * The npm package carries no binaries of its own: the Rust program is built
 * per platform by the project's release workflow, and this package downloads
 * the one matching the host, checks it against the release's SHA256SUMS and
 * keeps it in the user's cache. Everything here is a pure function so the
 * rules can be tested without a network or a board.
 */

const os = require('node:os')
const path = require('node:path')

/** The program's own file name on this platform. */
function executableName(platform = process.platform) {
  return platform === 'win32' ? 'bee-cli.exe' : 'bee-cli'
}

/** The release asset for one Rust target, as the workflow names it. */
function assetName(target, platform = process.platform) {
  return `bee-cli-${target}${platform === 'win32' || target.includes('windows') ? '.exe' : ''}`
}

/**
 * The Rust target this machine needs.
 *
 * Only targets the project actually publishes are named; anything else is
 * refused here, with the build instructions, rather than by a 404 halfway
 * through a download.
 */
function hostTarget(platform = process.platform, arch = process.arch, libc = 'gnu') {
  const table = {
    'darwin arm64': 'aarch64-apple-darwin',
    'darwin x64': 'x86_64-apple-darwin',
    'linux x64': libc === 'musl' ? null : 'x86_64-unknown-linux-gnu',
    'linux arm64': libc === 'musl' ? null : 'aarch64-unknown-linux-gnu',
    'linux arm': libc === 'musl' ? null : 'armv7-unknown-linux-gnueabihf',
    'linux ia32': libc === 'musl' ? null : 'i686-unknown-linux-gnu',
    'win32 x64': 'x86_64-pc-windows-msvc',
    'win32 arm64': 'aarch64-pc-windows-msvc',
    'win32 ia32': 'i686-pc-windows-gnu',
  }
  const key = `${platform} ${arch}`
  if (!(key in table)) return null
  return table[key]
}

/** Whether the running Node was built against musl (Alpine and friends). */
function detectLibc(report = typeof process.report?.getReport === 'function' ? process.report.getReport() : null) {
  if (!report) return 'gnu'
  const glibc = report.header?.glibcVersionRuntime
  return glibc ? 'gnu' : process.platform === 'linux' ? 'musl' : 'gnu'
}

/** Where a downloaded binary is kept: one directory per version and target. */
function cachePath(version, target, { env = process.env, platform = process.platform } = {}) {
  const root =
    env.BEE_CLI_CACHE_DIR ||
    (platform === 'win32'
      ? path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'bee-cli')
      : path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'bee-cli'))
  // The file itself keeps the program's own name: it is what argv[0] shows a
  // caller, and `bee-cli --version` should not read `bee-cli-x86_64-…`.
  return path.join(root, version, target, executableName(platform))
}

/** The release the binary comes from, unless the caller named another one. */
function releaseBase(version, env = process.env) {
  if (env.BEE_CLI_BASE_URL) return env.BEE_CLI_BASE_URL.replace(/\/+$/, '')
  const repo = env.BEE_CLI_REPO || 'radxa/linkr-bee'
  return `https://github.com/${repo}/releases/download/linkr-tui-v${version}`
}

/**
 * The checksum a release's SHA256SUMS gives for one asset.
 *
 * The file is coreutils' format: `<hex>  <name>` per line, and the name may
 * carry a `*` marker for binaries. Absent or unreadable is `null`; the caller
 * decides whether that is fatal, because a mirror may publish the disk image
 * only.
 */
function checksumFor(sums, asset) {
  if (typeof sums !== 'string') return null
  for (const line of sums.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim())
    if (match && match[2].trim() === asset) return match[1].toLowerCase()
  }
  return null
}

/** sha256 of a file, streamed: the binary is tens of megabytes. */
async function sha256File(file) {
  const { createHash } = require('node:crypto')
  const { createReadStream } = require('node:fs')
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

module.exports = { executableName, assetName, hostTarget, detectLibc, cachePath, releaseBase, checksumFor, sha256File }
