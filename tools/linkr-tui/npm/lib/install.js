'use strict'
/**
 * Postinstall: warm the cache so the first `bee-cli` run does not wait for a
 * download. Best effort by design — an offline install must not fail, because
 * the binary is not needed until something actually talks to a board.
 */

const { ensureBinary } = require('./ensure')

async function main() {
  if (process.env.BEE_CLI_SKIP_DOWNLOAD === '1') return
  try {
    const binary = await ensureBinary({ quiet: true })
    if (binary) process.stdout.write(`bee-cli: ${binary}\n`)
  } catch (error) {
    process.stderr.write(`bee-cli: will fetch the binary on first use (${error.message})\n`)
  }
}

if (require.main === module) main()
