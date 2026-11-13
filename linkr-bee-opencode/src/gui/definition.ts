/**
 * The GUI half's declarations for the package's `./gui-experimental` part.
 *
 * `Plugin.define` here declares only what the host needs before either setup
 * runs (the copy catalog). `src/gui.tsx` spreads these declarations and adds
 * the window setup. Keeping the declaration in its own file lets the Solid
 * components type `usePlugin<typeof definition>()` without importing the entry
 * (and therefore each other).
 *
 * The GUI declares no id: the host assigns the server part's (`opencode-linkr-bee`),
 * which is why every host key the panel and command create is built from
 * `ctx.id` rather than a literal.
 */
import { Plugin } from '@opencode/plugin/gui';

/** The panel's local id. Panel keys are `${ctx.id}:${CONSOLE_TAB_ID}`. */
export const CONSOLE_TAB_ID = 'console';

/** The command's local id. Published as `${ctx.id}.${CONSOLE_COMMAND_ID}`. */
export const CONSOLE_COMMAND_ID = 'toggle';

/** The settings command's local id. Published as `${ctx.id}.${SETTINGS_COMMAND_ID}`. */
export const SETTINGS_COMMAND_ID = 'settings';

/** The live serial console panel and the command that toggles it. */
export const definition = Plugin.define({
  i18n: {
    en: {
      title: 'Linkr Bee console',
      'command.toggle': 'Linkr Bee: toggle console',
      'command.description': 'Show or hide the live serial console for the Linkr Bee board',
      'command.settings': 'Linkr Bee: settings',
      'command.settings.description': 'Open the Linkr Bee connection, bridge UART and browser page settings',
      'action.settings': 'Settings',
      group: 'Linkr Bee',
      'status.connected': 'connected',
      'status.disconnected': 'disconnected',
      'status.connecting': 'connecting…',
      'status.error': 'RPC unavailable',
      'hint.disconnected': 'No board connected. Plug in a Linkr Bee board (or start bee-cli) and press Reconnect.',
      'hint.target': 'Last error',
      target: 'Target',
      'hint.rpc': 'The console RPC is not available on this server',
      'hint.noSession': 'Open a session tab first; the console lives in the session side panel.',
      'view.reading': 'Reading',
      'view.raw': 'Raw',
      'view.label': 'Console view',
      clear: 'Clear',
      reconnect: 'Reconnect',
      'meta.cleared': 'console cleared',
      'meta.reconnected': 'reconnecting to the board…',
      'meta.truncated': 'older console bytes were already dropped (ring truncated)',
      'meta.noRpc': 'console RPC unavailable; the panel cannot reach the board session',
    },
  },
});
