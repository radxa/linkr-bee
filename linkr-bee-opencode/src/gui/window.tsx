/**
 * The GUI window setup: contributes the styles, the side panel, the palette
 * command and the + menu row, and answers the console tool's `request` event.
 *
 * Everything here is contributed in `setup`, which runs synchronously in every
 * (desktop or browser) OpenCode window. The panel body is a Solid component in
 * `./console.tsx`; this file stays light so opening a window is cheap.
 */
import { onCleanup } from 'solid-js';
import { Command, MenuItem, Panel, Style, type PanelTab, type Plugin } from '@opencode/plugin/gui';

import LinkrBeeConsole from '../rpc.js';
import xtermCss from '@xterm/xterm/css/xterm.css?inline';
import guiCss from './gui.css?inline';
import { CONSOLE_COMMAND_ID, CONSOLE_TAB_ID, SETTINGS_COMMAND_ID, type definition } from './definition';
import { ConsolePanel } from './console';
import { SETTINGS_PAGE_ID, registerSettings } from './settings';

/** The panel key the strip and command use. */
export function consoleKey(ctx: { id: string }): string {
  return `${ctx.id}:${CONSOLE_TAB_ID}`;
}

/** Event listeners get the payload directly or wrapped in an RPC envelope. */
function payload(event: any) {
  return event && typeof event === 'object' && 'data' in event && event.data ? event.data : event;
}

export const setup: Plugin.Setup<typeof definition> = (ctx) => {
  // The bundled xterm stylesheet and the panel chrome. The host keeps each
  // string in the document while the plugin is loaded.
  ctx.add(Style, xtermCss);
  ctx.add(Style, guiCss);

  // The Settings page: transport, board discovery, bridge UART and the local
  // browser console page. It talks to the server through the console RPC.
  registerSettings(ctx);

  /** Opens the console tab, or closes it when it is already on screen. */
  const toggleConsole = () => {
    const session = ctx.sessions.current();
    if (!session) {
      try {
        ctx.toast.show({ title: ctx.t('hint.noSession') });
      } catch {
        /* the app interface may not be mounted yet */
      }
      return;
    }
    ctx.layout.toggle(consoleKey(ctx), session);
  };

  // The tab object is kept for the life of the plugin and read with getters,
  // so a language change re-reads the title without recreating the tab.
  const tab: PanelTab = {
    id: CONSOLE_TAB_ID,
    get title() {
      return ctx.t('title');
    },
    closable: 'compact',
  };

  ctx.add(Panel, {
    id: CONSOLE_TAB_ID,
    region: 'side',
    // A serial console is wider than the conversation's default side pane.
    width: 520,
    mobile: {
      get title() {
        return ctx.t('title');
      },
      order: 20,
      kind: 'drawer',
      icon: 'terminal',
      // Keep the terminal mounted while the user switches views, like a shell.
      cached: true,
    },
    list: (input) => (input.open.includes(CONSOLE_TAB_ID) ? [tab] : []),
    render: () => <ConsolePanel />,
  });

  ctx.add(
    Command,
    (): Command => ({
      id: CONSOLE_COMMAND_ID,
      title: ctx.t('command.toggle'),
      description: ctx.t('command.description'),
      keywords: 'serial uart console terminal board bee linkr',
      group: ctx.t('group'),
      section: 'terminal',
      bind: 'ctrl+`',
      run: toggleConsole,
    }),
  );

  ctx.add(
    Command,
    (): Command => ({
      id: SETTINGS_COMMAND_ID,
      title: ctx.t('command.settings'),
      description: ctx.t('command.settings.description'),
      keywords: 'linkr bee settings connection transport uart board',
      group: ctx.t('group'),
      section: 'terminal',
      run: () => ctx.layout.settings(SETTINGS_PAGE_ID),
    }),
  );

  ctx.add(
    MenuItem,
    (): MenuItem => ({
      menu: 'session.panel',
      id: CONSOLE_TAB_ID,
      title: ctx.t('title'),
      icon: 'terminal',
      keybind: `${ctx.id}.${CONSOLE_COMMAND_ID}`,
      order: 100,
      run: toggleConsole,
    }),
  );

  // The agent's console tool publishes `request {action:"open"|"focus"}` when
  // it wants the panel on screen. A panel component only exists while its tab
  // is mounted, so the open/focus side is handled here; `clear` is handled by
  // the mounted panel. Every failure is contained: an old server without the
  // RPC must not break the window or the panel.
  let requestOff: (() => void) | undefined;
  try {
    const rpc = ctx.client.rpc(LinkrBeeConsole);
    const subscription = rpc.events.on('request', (event: any) => {
      const request = payload(event);
      if (request?.action !== 'open' && request?.action !== 'focus') return;
      const session = ctx.sessions.current();
      if (!session) return;
      if (ctx.layout.state(consoleKey(ctx), session) !== 'visible') {
        ctx.layout.open(consoleKey(ctx), session);
      }
    });
    if (typeof subscription === 'function') {
      requestOff = subscription;
    } else if (subscription && typeof subscription.then === 'function') {
      subscription.then((cleanup: unknown) => {
        if (typeof cleanup === 'function') requestOff = cleanup as () => void;
      }).catch(() => {});
    }
  } catch {
    /* no console RPC (older server) or no client yet: the command still works */
  }
  onCleanup(() => {
    try {
      requestOff?.();
    } catch {
      /* already withdrawn with the plugin owner */
    }
  });
};
