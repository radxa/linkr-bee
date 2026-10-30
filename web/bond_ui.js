import {
  bondLabelQueryCommand,
  bondLabelSetCommand,
  parseBondLabel,
  sanitizeBondLabel,
} from "./board_io.js";

export function parseBonds(text) {
  const lines = String(text).trim().split(/\r?\n/);
  const header = /^OK bonds pending=([01]) result=(-?\d+)$/.exec(lines.shift());
  if (!header) throw new Error(String(text));
  const peers = lines.filter(Boolean).map(line => {
    const match = /^BOND ([01]\/(?:[0-9A-F]{2}:){5}[0-9A-F]{2}) self=([01])$/i.exec(line);
    if (!match) throw new Error('Invalid paired-device reply');
    return { id: match[1], self: match[2] === '1' };
  });
  return { pending: header[1] === '1', result: Number(header[2]), peers };
}

/* Host names each client sent for its own bond, keyed by the same id the BOND
 * lines use. Firmware that predates the command answers ERR, which is not an
 * error here: an empty map just leaves the addresses on screen. */
export function parseBondNames(text) {
  const names = new Map();
  const lines = String(text).trim().split(/\r?\n/);
  if (!/^OK bonds names$/.test(lines.shift() || "")) return names;
  for (const line of lines.filter(Boolean)) {
    const match = /^NAME ([01]\/(?:[0-9A-F]{2}:){5}[0-9A-F]{2}) "(.*)"$/i.exec(line);
    if (match) names.set(match[1], match[2]);
  }
  return names;
}

/* A browser cannot read the machine's hostname, so it reports the little it can
 * see. The card says as much; the command line client can send the
 * real hostname. */
export function browserHostLabel(nav = globalThis.navigator) {
  const ua = String(nav?.userAgent || "");
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
      : /Firefox\//.test(ua) ? 'Firefox'
        : /Chrome\//.test(ua) ? 'Chrome'
          : /Safari\//.test(ua) ? 'Safari' : '';
  const platform = /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Android/.test(ua) ? 'Android'
      : /Macintosh|Mac OS X/.test(ua) ? 'macOS'
        : /Windows/.test(ua) ? 'Windows'
          : /CrOS/.test(ua) ? 'ChromeOS'
            : /Linux/.test(ua) ? 'Linux' : '';
  if (browser && platform) return `${browser} · ${platform}`;
  return browser || platform || '';
}

export function createBondUi({ card, context, send, supported, beforeSelfDelete, afterSelfDelete }) {
  let peers = [], names = new Map();
  let busy = false, generation = null, reported = null;
  let editing = null, draft = "";
  let labelSupported = null, namesSupported = null;
  const list = card.querySelector('[data-bonds-list]');
  const status = card.querySelector('[role="status"]');
  const refresh = card.querySelector('[data-bonds-refresh]');
  const text = (zh, en) => context().lang.startsWith('zh') ? zh : en;
  const live = token => context().ready && context().generation === token;

  /* Tell the board which host this pairing belongs to, once per connection.
   * `bonds name` writes only the caller's own bond, so it works without taking
   * console ownership. Best effort: the label is cosmetic, so a refusal stays
   * silent. */
  function reportHostName() {
    const ctx = context();
    if (!ctx.ready || ctx.supported === false || reported === ctx.generation) return;
    const label = browserHostLabel();
    if (!label) return;
    reported = ctx.generation;
    return send(`@linkr bonds name ${label}`, { quiet: true }).catch(() => {});
  }

  function syncGeneration() {
    const ctx = context();
    if (generation === ctx.generation) return;
    generation = ctx.generation;
    peers = [];
    names = new Map();
    status.textContent = '';
    busy = false;
    editing = null;
    draft = "";
    labelSupported = ctx.label ?? null;
    namesSupported = null;
    reported = null;
  }

  function canRename(peer) {
    if (!context().ready) return false;
    if (peer.self) return labelSupported !== false || namesSupported === true;
    return labelSupported === true && context().control;
  }

  function button(action, word, disabled) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'btn btn-soft bond-action';
    element.dataset.bondAction = action;
    element.textContent = word;
    element.disabled = disabled;
    return element;
  }

  function render() {
    syncGeneration();
    const ctx = context();
    card.querySelector('[data-bonds-title]').textContent = text('已配对设备', 'Paired devices');
    card.setAttribute('aria-label', text('已配对设备', 'Paired devices'));
    card.querySelector('[data-bonds-hint]').textContent = text('管理保存在 Bee 上的蓝牙配对记录。名称由各主机自己上报，网页只能报出浏览器与系统；也可以改名。删除后需重新配对；主机系统中的旧记录需自行忽略。', 'Manage Bluetooth pairings saved on Bee. Hosts report their own names (a browser can only report its browser and system); you can rename them too. Deleted hosts must pair again; forget their old OS pairing too.');
    refresh.textContent = text('刷新列表', 'Refresh list');
    refresh.disabled = busy || !ctx.ready;
    list.replaceChildren();
    for (const peer of peers) {
      const row = document.createElement('div');
      row.className = 'bond-row';
      row.dataset.bondId = peer.id;
      const name = names.get(peer.id);
      if (editing === peer.id) {
        row.classList.add('is-editing');
        const form = document.createElement('div');
        form.className = 'bond-edit';
        const input = document.createElement('input');
        input.className = 'bond-input';
        input.type = 'text';
        input.value = draft;
        input.placeholder = text('设备标签', 'Device label');
        input.setAttribute('aria-label', text('设备标签', 'Device label'));
        input.addEventListener('input', () => { draft = input.value; });
        input.addEventListener('keydown', event => {
          if (event.key === 'Enter') {
            event.preventDefault();
            saveLabel(peer, input.value);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            cancelEdit();
          }
        });
        const save = button('save', text('保存', 'Save'), busy || !ctx.ready || (!peer.self && !ctx.control));
        save.addEventListener('click', () => saveLabel(peer, input.value));
        const cancel = button('cancel', text('取消', 'Cancel'), busy);
        cancel.addEventListener('click', cancelEdit);
        form.append(input, save, cancel);
        row.append(form);
      } else {
        const label = document.createElement('span');
        label.className = 'bond-identity';
        const nameLine = document.createElement('span');
        nameLine.className = name ? 'bond-name' : 'bond-name is-address';
        nameLine.textContent = name || peer.id;
        label.append(nameLine);
        const meta = [name ? peer.id : '', peer.self ? text('当前主机', 'This host') : ''].filter(Boolean).join(' · ');
        if (meta) {
          const metaLine = document.createElement('span');
          metaLine.className = 'bond-meta';
          metaLine.textContent = meta;
          label.append(metaLine);
        }
        const actions = document.createElement('span');
        actions.className = 'bond-actions';
        if (canRename(peer)) {
          const rename = button('rename', text('改名', 'Rename'), busy || !ctx.ready || (!peer.self && !ctx.control));
          rename.setAttribute('aria-label', `${rename.textContent} ${peer.id}`);
          rename.addEventListener('click', () => startEdit(peer));
          actions.append(rename);
        }
        const remove = button('remove', text('删除配对', 'Remove pairing'), busy || !ctx.ready || !ctx.control);
        remove.setAttribute('aria-label', `${remove.textContent} ${peer.id}`);
        remove.addEventListener('click', () => removePeer(peer, name));
        actions.append(remove);
        row.append(label, actions);
      }
      list.append(row);
    }
    if (editing !== null) {
      const input = list.querySelector('.bond-input');
      if (input) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    }
  }

  function startEdit(peer) {
    if (busy || !canRename(peer)) return;
    editing = peer.id;
    draft = names.get(peer.id) || '';
    render();
  }

  function cancelEdit() {
    editing = null;
    draft = '';
    render();
  }

  async function loadLabels(token) {
    // The full per-address command returns the configured label exactly and is
    // the only way to manage a peer that is not this host. If the board predates
    // it, fall back to the older `bonds names?` listing; `bonds name` still lets
    // this host rename itself there.
    let full = true;
    for (const peer of peers) {
      if (!live(token)) return;
      let response;
      try {
        response = await send(bondLabelQueryCommand({ id: peer.id }), { quiet: true });
      } catch {
        full = false;
        break;
      }
      if (!live(token)) return;
      if (/ERR.*(?:unknown command|unsupported)/i.test(response)) {
        full = false;
        break;
      }
      const parsed = parseBondLabel(response);
      if (parsed) {
        if (parsed.label) names.set(peer.id, parsed.label);
        else names.delete(peer.id);
      }
    }
    labelSupported = full;
    if (full) {
      namesSupported = true;
      return;
    }
    try {
      const response = await send('@linkr bonds names?', { quiet: true });
      if (!live(token)) return;
      const fallback = parseBondNames(response);
      if (fallback.size || /^OK bonds names/m.test(String(response))) {
        names = fallback;
        namesSupported = true;
      } else {
        namesSupported = false;
      }
    } catch {
      namesSupported = false;
    }
  }

  async function query() {
    if (!context().ready || context().supported === false || busy) return;
    const token = context().generation;
    busy = true;
    render();
    try {
      const response = await send('@linkr bonds?');
      if (!live(token)) return;
      if (/ERR.*(?:unknown command|unsupported)/i.test(response)) {
        supported(false);
        return;
      }
      const result = parseBonds(response);
      supported(true);
      peers = result.peers;
      names = new Map();
      await loadLabels(token);
      if (!live(token)) return;
      status.textContent = result.pending ? text('正在删除，请稍后刷新。', 'Removal pending; refresh shortly.')
        : result.result ? text('上次删除失败，请刷新后重试。', 'Last removal failed; refresh and retry.')
          : peers.length ? text(`共 ${peers.length} 个设备`, `${peers.length} paired devices`)
            : text('没有已配对设备。', 'No paired devices.');
    } catch (error) {
      if (live(token)) status.textContent = error.message;
    } finally {
      if (live(token)) { busy = false; render(); }
    }
  }

  async function saveLabel(peer, value) {
    if (busy || !context().ready || !canRename(peer)) return;
    const token = context().generation;
    const clean = sanitizeBondLabel(value);
    busy = true;
    render();
    try {
      let response;
      if (peer.self) {
        // `bonds name` is the self-only form and needs no console ownership.
        response = await send(clean ? `@linkr bonds name ${clean}` : '@linkr bonds name');
        if (!live(token)) return;
        if (!/^OK bonds name/m.test(String(response))) throw new Error(String(response));
      } else {
        response = await send(bondLabelSetCommand({ id: peer.id, label: clean }));
        if (!live(token)) return;
        const parsed = parseBondLabel(response);
        if (!parsed) throw new Error(String(response));
      }
      if (clean) names.set(peer.id, clean);
      else names.delete(peer.id);
      editing = null;
      draft = '';
      status.textContent = clean ? text('名称已保存。', 'Name saved.') : text('名称已清除。', 'Name cleared.');
    } catch (error) {
      if (live(token)) status.textContent = error.message;
    } finally {
      if (live(token)) { busy = false; render(); }
    }
  }

  async function removePeer(peer, name) {
    if (busy || !context().ready || !context().control) return;
    const token = context().generation;
    const target = name ? `${name} (${peer.id})` : peer.id;
    const warning = text(`删除 ${target} 的配对记录？${peer.self ? '当前连接将断开。' : '该主机若在线也将断开。'}重新连接需要按固件策略重新授权配对。`, `Remove pairing for ${target}? ${peer.self ? 'This connection will close.' : 'That host will disconnect if online.'} Reconnection requires pairing under the firmware policy.`);
    if (!window.confirm(warning) || !live(token) || !context().control) return;
    busy = true;
    render();
    let queued = false;
    if (peer.self) beforeSelfDelete();
    try {
      const response = await send(`@linkr bonds remove ${peer.id}`);
      if (!live(token)) return;
      if (String(response).trim() !== 'OK bonds queued') throw new Error(String(response));
      queued = true;
      status.textContent = text('删除请求已受理，正在等待固件处理。', 'Removal queued; waiting for firmware.');
      await new Promise(resolve => setTimeout(resolve, 900));
    } catch (error) {
      if (live(token)) status.textContent = error.message;
    } finally {
      if (peer.self) afterSelfDelete(token, queued);
      if (live(token)) { busy = false; names.delete(peer.id); render(); await query(); }
    }
  }

  refresh.onclick = query;
  render();
  return { render, query, reportHostName };
}
