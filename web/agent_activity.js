/* Presentation only: these disclosures never change Pi's history, permissions
 * or tool execution. Only provider-supplied reasoning is rendered as reasoning. */
import {renderAssistantMarkdown} from './agent_markdown.js';
const REASONING_LIMIT = 12000;

export function createAgentActivity({messages, text, onChange = null}) {
  let current = null;
  const owners = new WeakMap();
  /* Every path that grows the transcript passes through this module (a tool row,
   * a revealed approval, a finished group). Reporting each change lets the panel
   * keep the newest content in view instead of stopping at the last row it added
   * itself. */
  const changed = () => onChange?.();
  function paint(group) {
    const seconds = Math.max(0, Math.floor(((group.ended || Date.now()) - group.started) / 1000));
    group.title.textContent = text(group.state === 'running' ? 'activityRunning' : group.state === 'error' ? 'activityError' : group.state === 'interrupted' ? 'activityStopped' : 'activityDone');
    group.count.textContent = text("activityCount").replace("{count}", group.countValue).replace("{seconds}", seconds);
    group.details.dataset.state = group.state;
    group.details.setAttribute('aria-label', `${group.title.textContent} · ${group.countValue}`);
  }
  function ensure() {
    // A settings/MCP device action can begin outside a model conversation turn.
    if (current?.ended != null) current = null;
    if (current) return current;
    const details = document.createElement('details'); details.className = 'agent-activity';
    const summary = document.createElement('summary');
    const marker = document.createElement('span'); marker.className = 'agent-activity-mark'; marker.setAttribute('aria-hidden','true');
    const title = document.createElement('span'); title.className = 'agent-activity-title';
    const count = document.createElement('span'); count.className = 'agent-activity-meta';
    const body = document.createElement('div'); body.className = 'agent-activity-body';
    summary.append(marker,title,count); details.append(summary,body); messages.append(details);
    const group = {details,body,title,count,countValue:0,started:Date.now(),ended:null,state:'running',manual:false};
    summary.addEventListener('click', () => { group.manual = true; });
    group.timer = setInterval(() => paint(group), 1000);
    current = group; paint(group); changed(); return group;
  }
  function attach(row) {
    const group = ensure();
    if (!owners.has(row)) { group.countValue++; owners.set(row,group); }
    row.classList.add('agent-process-entry'); group.body.append(row); paint(group); changed();
  }
  function reveal(body, {error = false} = {}) {
    const group = owners.get(body.closest('.agent-message'));
    if (group) { group.hasIssue ||= error; group.details.open = true; paint(group); changed(); }
  }
  function finish(state = 'done') {
    if (!current || current.ended !== null) return;
    state = state === "done" && current.hasIssue ? "error" : state;
    current.state = state; current.ended = Date.now(); clearInterval(current.timer);
    if (state === 'error') current.details.open = true;
    else if (!current.manual) current.details.open = false;
    paint(current); changed();
  }
  return {
    attach, reveal, finish,
    boundary() { finish(); current = null; },
    reset() { finish('interrupted'); current = null; },
    refresh() { if (current) paint(current); },
    thinking() {
      const row = document.createElement('section'); row.className = 'agent-message agent-thinking';
      const details = document.createElement('details'); details.className = 'agent-reasoning';
      const summary = document.createElement('summary'); summary.textContent = text('reasoning');
      const body = document.createElement('div'); body.className = 'agent-message-text';
      details.append(summary,body); row.append(details); attach(row);
      const note = document.createElement('p'); note.className = 'agent-reasoning-note'; note.hidden = true; note.textContent = text('truncated'); details.append(note);
      let source = '', frame = 0;
      return {
        update(value, append = false) {
          const next = append ? source + value : value;
          note.hidden = next.length <= REASONING_LIMIT;
          source = next.slice(0, REASONING_LIMIT);
          if (!frame) frame = requestAnimationFrame(() => { frame = 0; if (body.isConnected) renderAssistantMarkdown(body, source); });
        },
      };
    },
  };
}
