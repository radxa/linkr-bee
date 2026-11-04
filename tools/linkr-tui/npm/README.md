# linkr-bee-cli

The command-line client for a **Linkr Bee** wireless serial bridge: it drives a
target board's UART console over Bluetooth LE, over the bridge's LAN WebSocket,
or against a loopback simulator. It is the program the
[`dsh-linkr-bee`](https://github.com/radxa/linkr-bee/tree/main/linkr-bee-dsh)
DeepSeek Harness plugin shells out to — and it is useful on its own.

This npm package carries no binary. On first use it downloads the release asset
built for your platform by the project's Rust release workflow, verifies it
against the release's `SHA256SUMS`, and caches it, so `npx` and a global install
both end up running the same compiled program.

## Use

```sh
npx linkr-bee-cli --scan                 # find nearby boards
npx linkr-bee-cli --ble-name "Linkr Bee" --exec 'uname -a'
npx linkr-bee-cli --ble-name "Linkr Bee" --serve   # resident session, JSON on stdin/stdout
```

Or install it once, which also puts `bee-cli` on your `PATH` — the name the
Harness plugin looks for:

```sh
npm install -g linkr-bee-cli
bee-cli --scan
```

The full manual is the project's [CLI guide](https://github.com/radxa/linkr-bee/blob/main/tools/linkr-tui/README-cli.md);
`bee-cli --help` lists every flag.

## Where the binary comes from

| Step | What happens |
| --- | --- |
| 1 | `$BEE_CLI_BINARY`, when set, is used as-is (a checkout's build, CI, a packager). |
| 2 | A previous download is reused: `$XDG_CACHE_HOME/bee-cli/<version>/<target>/bee-cli` (or `%LOCALAPPDATA%` on Windows). |
| 3 | Otherwise the asset `bee-cli-<target>` is fetched from the `linkr-tui-v<version>` GitHub release and verified against `SHA256SUMS`. |

A mismatch, a missing checksum entry or an unpublished platform is an error, not
a guess: nothing is executed that the release did not sign for.

### Environment

| Variable | Meaning |
| --- | --- |
| `BEE_CLI_BINARY` | Use this executable and skip everything else |
| `BEE_CLI_VERSION` | Take the assets of another release (default: this package's version) |
| `BEE_CLI_TARGET` | Force a Rust target instead of detecting one |
| `BEE_CLI_BASE_URL` | Mirror root holding `bee-cli-<target>` and `SHA256SUMS` (http(s) or `file:`) |
| `BEE_CLI_REPO` | GitHub `owner/name` to download from (default `radxa/linkr-bee`) |
| `BEE_CLI_CACHE_DIR` | Cache root (default `$XDG_CACHE_HOME/bee-cli`) |
| `BEE_CLI_SHA256` | Pin the expected checksum instead of reading `SHA256SUMS` |
| `BEE_CLI_SKIP_DOWNLOAD=1` | Do not warm the cache during `npm install` |

### Platforms

Prebuilt for `x86_64`/`aarch64` macOS, `x86_64`/`aarch64`/`armv7`/`i686` Linux (glibc),
and `x86_64`/`aarch64`/`i686` Windows. On anything else — musl Linux or an
architecture the project does not build — the launcher says so and names the
build command; `BEE_CLI_BINARY` points it at your own build.

## License

Apache-2.0. The program links third-party crates whose notices ship in
`THIRD_PARTY_LICENSES.md`.
