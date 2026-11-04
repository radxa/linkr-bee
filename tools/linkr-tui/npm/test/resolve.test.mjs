import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { assetName, hostTarget, cachePath, releaseBase, checksumFor } = require('../lib/resolve.js')

test('every published target is reachable from a platform and an arch', () => {
  assert.equal(hostTarget('darwin', 'arm64'), 'aarch64-apple-darwin')
  assert.equal(hostTarget('darwin', 'x64'), 'x86_64-apple-darwin')
  assert.equal(hostTarget('linux', 'x64', 'gnu'), 'x86_64-unknown-linux-gnu')
  assert.equal(hostTarget('linux', 'arm64', 'gnu'), 'aarch64-unknown-linux-gnu')
  assert.equal(hostTarget('linux', 'arm', 'gnu'), 'armv7-unknown-linux-gnueabihf')
  assert.equal(hostTarget('linux', 'ia32', 'gnu'), 'i686-unknown-linux-gnu')
  assert.equal(hostTarget('win32', 'x64'), 'x86_64-pc-windows-msvc')
  assert.equal(hostTarget('win32', 'arm64'), 'aarch64-pc-windows-msvc')
  assert.equal(hostTarget('win32', 'ia32'), 'i686-pc-windows-gnu')
})

test('a platform with no published asset is refused, not guessed', () => {
  assert.equal(hostTarget('linux', 'x64', 'musl'), null)
  assert.equal(hostTarget('freebsd', 'x64'), null)
  assert.equal(hostTarget('aix', 'ppc64'), null)
})

test('the asset is the one the release workflow stages', () => {
  assert.equal(assetName('aarch64-apple-darwin', 'darwin'), 'bee-cli-aarch64-apple-darwin')
  assert.equal(assetName('x86_64-unknown-linux-gnu', 'linux'), 'bee-cli-x86_64-unknown-linux-gnu')
  assert.equal(assetName('x86_64-pc-windows-msvc', 'win32'), 'bee-cli-x86_64-pc-windows-msvc.exe')
  assert.equal(assetName('i686-pc-windows-gnu', 'linux'), 'bee-cli-i686-pc-windows-gnu.exe')
})

test('the cache is one directory per version and target', () => {
  const posix = cachePath('0.1.2', 'aarch64-apple-darwin', { env: { XDG_CACHE_HOME: '/tmp/xdg' }, platform: 'darwin' })
  assert.equal(posix, '/tmp/xdg/bee-cli/0.1.2/aarch64-apple-darwin/bee-cli')
  const win = cachePath('0.1.2', 'x86_64-pc-windows-msvc', { env: { LOCALAPPDATA: 'C:\\Temp' }, platform: 'win32' })
  assert.match(win, /C:\\Temp[\\/]bee-cli[\\/]0\.1\.2[\\/]x86_64-pc-windows-msvc[\\/]bee-cli\.exe$/)
  const explicit = cachePath('1.2.3', 'x86_64-unknown-linux-gnu', { env: { BEE_CLI_CACHE_DIR: '/var/cache/bee' }, platform: 'linux' })
  assert.equal(explicit, '/var/cache/bee/1.2.3/x86_64-unknown-linux-gnu/bee-cli')
})

test('the release base is the tag the workflow publishes, and a mirror can replace it', () => {
  assert.equal(releaseBase('0.1.2', {}), 'https://github.com/radxa/linkr-bee/releases/download/linkr-tui-v0.1.2')
  assert.equal(releaseBase('0.1.2', { BEE_CLI_BASE_URL: 'https://mirror.example/bee/' }), 'https://mirror.example/bee')
  assert.equal(releaseBase('9.9.9', { BEE_CLI_BASE_URL: 'file:///srv/bee' }), 'file:///srv/bee')
})

test('checksums are read from coreutils SHA256SUMS, and a missing entry is null', () => {
  const hex = 'a'.repeat(64)
  const sums = `${hex}  bee-cli-x86_64-unknown-linux-gnu\n${'B'.repeat(64)} *bee-cli-aarch64-apple-darwin\n`
  assert.equal(checksumFor(sums, 'bee-cli-x86_64-unknown-linux-gnu'), hex)
  assert.equal(checksumFor(sums, 'bee-cli-aarch64-apple-darwin'), 'b'.repeat(64))
  assert.equal(checksumFor(sums, 'bee-cli-x86_64-pc-windows-msvc.exe'), null)
  assert.equal(checksumFor(null, 'anything'), null)
  assert.equal(checksumFor('not a checksum file', 'anything'), null)
})
