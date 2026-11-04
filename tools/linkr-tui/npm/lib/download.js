'use strict'
/**
 * Getting the release's bytes onto this machine: https, http, and `file:` for
 * a mirror or a test. No dependencies and no shelling out to curl, so the same
 * code runs on every platform Node supports.
 */

const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const https = require('node:https')
const { fileURLToPath } = require('node:url')

const REDIRECTS = 5
const TIMEOUT_MS = 60000

/** Fetch `url` into `target`, following redirects and rejecting on HTTP errors. */
function download(url, target, redirectsLeft = REDIRECTS) {
  if (url.startsWith('file:')) {
    const source = fileURLToPath(url)
    return fs.promises.mkdir(path.dirname(target), { recursive: true }).then(() =>
      fs.promises.copyFile(source, target),
    )
  }
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http
    const request = client.get(url, { timeout: TIMEOUT_MS, headers: { 'user-agent': 'bee-cli-npm' } }, (response) => {
      const status = response.statusCode || 0
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume()
        if (redirectsLeft <= 0) {
          reject(new Error(`too many redirects for ${url}`))
          return
        }
        const next = new URL(response.headers.location, url).toString()
        download(next, target, redirectsLeft - 1).then(resolve, reject)
        return
      }
      if (status !== 200) {
        response.resume()
        reject(new Error(`${url} answered HTTP ${status}`))
        return
      }
      fs.promises
        .mkdir(path.dirname(target), { recursive: true })
        .then(() => {
          const out = fs.createWriteStream(target, { mode: 0o755 })
          out.on('error', reject)
          response.on('error', reject)
          response.pipe(out)
          out.on('close', () => resolve(target))
        })
        .catch(reject)
    })
    request.on('timeout', () => request.destroy(new Error(`timed out after ${TIMEOUT_MS} ms: ${url}`)))
    request.on('error', reject)
  })
}

/** The text at `url`, or null when it is not there. */
async function fetchText(url) {
  try {
    const tmp = path.join(require('node:os').tmpdir(), `bee-cli-${process.pid}-${Date.now()}.txt`)
    await download(url, tmp)
    const text = await fs.promises.readFile(tmp, 'utf8')
    await fs.promises.rm(tmp, { force: true })
    return text
  } catch {
    return null
  }
}

module.exports = { download, fetchText }
