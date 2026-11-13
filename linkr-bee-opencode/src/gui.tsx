/**
 * The package's `./gui-experimental` entry point.
 *
 * OpenCode 2.x evaluates this bundle in each app window and runs the returned
 * definition's `setup` there. The prebuilt CommonJS file is what `package.json`
 * exports as `./gui-experimental`; rebuild it with `npm run build:gui` after
 * editing anything under `src/gui/`.
 */
import { Plugin } from '@opencode/plugin/gui';

import { definition } from './gui/definition';
import { setup } from './gui/window';

export default Plugin.define({ ...definition, setup });
