# Third-party notices

This package contains no vendored third-party source. It uses Node.js built-in
modules and depends on the following packages at runtime:

## @opencode/plugin 2.2.7 — MIT

The `Plugin` helper and the tool/context types are imported by `index.js` so the
plugin can register its tools with OpenCode 2.x. MIT-licensed:

```
Copyright (c) 2025 opencode

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## xterm.js 6.0.0 and @xterm/addon-fit 0.11.0 — MIT (bundled in the built UI assets)

The committed `dist/gui-experimental.cjs` and `dist/web-console.js` bundles
inline the unmodified xterm.js and its fit addon so the browser/desktop console
can render a real terminal (ANSI colour, cursor movement, carriage-return
progress). Both packages are MIT-licensed:

```
Copyright (c) 2014-2024 The xterm.js authors. All rights reserved.
@license MIT

Copyright (c) 2012-2013, Christopher Jeffrey (MIT License)
@license MIT

Originally forked from (with the author's permission):
  Fabrice Bellard's javascript vt100 for jslinux:
  http://bellard.org/jslinux/
  Copyright (c) 2011 Fabrice Bellard

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## UI peer dependencies (optional)

The optional TUI and Web UI parts declare peer dependencies on `@opentui/core`,
`@opentui/solid`, `solid-js` and (for the desktop bundle) the OpenCode GUI
tooling. They are not installed by this package and are not needed for the
server part or the four one-shot tools; when present, they are used under their
respective MIT licenses (`@opentui/*`, `solid-js`).

## linkr-bee-cli 1.2.0 — Apache-2.0

The Linkr Bee command-line client (`bee-cli`) this plugin drives. It is part of
the Linkr Bee project and is licensed under the Apache License 2.0; see the
repository's `LICENSE` and the CLI package's `THIRD_PARTY_LICENSES.md`. The
package is not required at plugin load time: it is resolved when a tool runs.
