// Task summaries only: no model settings, live tool calls, permissions or keys.
export const TASKS_KEY = 'linkr-agent-tasks-v1';
export function deviceIdentity(status) {
  if (status.targetBinding?.verified) return `target:${status.targetBinding.targetId}`;
  return status.deviceId ? JSON.stringify([status.transport, status.deviceId, status.uart || '']) : null;
}

/* Credential shapes found in free text. The task store, the Markdown report and
 * the MCP audit list all echo text that came from a model, a console or a tool
 * result, so a credential often arrives without an argument key that names it:
 * `{"apiKey":"…"}`, `curl -u user:pass …`, `Authorization: Bearer …`. The
 * patterns below cover the labelled forms the app and common shell tools use.
 * Redaction stays best effort and is not a safety review: an unlabelled secret,
 * a credential split across two fields, or one inside an image or binary blob is
 * not recognized. There is no interactive preview before the report is
 * downloaded (the panel exports the finished text directly), so callers must
 * read this as "the known shapes were removed", never as "the text is clean". */
const REDACTED = '[redacted]';
const SECRET_LABEL = '(?:password|passwd|secret|token|api[_-]?key|authorization|credential)';
const QUOTED_LABEL = new RegExp(`((?:"|')${SECRET_LABEL}(?:"|')\\s*[:=]\\s*)("[^"\\n]*"|'[^'\\n]*'|[^\\s,;}]+)`, 'gi');
const BARE_LABEL = new RegExp(`(${SECRET_LABEL}\\s*[:=]\\s*(?:(?:Bearer|Basic|Digest|Token)\\s+)?)("[^"\\n]*"|'[^'\\n]*'|[^\\s,;}]+)`, 'gi');
const BEARER = /\b(Bearer\s+)(\S+)/gi;
/* curl/wget credential flag: the whole user:pass pair goes, not just the
 * password, because the pair is only useful to someone trying to authenticate. */
const USER_FLAG = /(\s(?:-u|--user)[ =]\s*)([^\s:]+:[^\s]+)/gi;

function maskQuoted(value, prefix) {
  const quote = value[0] === '"' || value[0] === "'" ? value[0] : '';
  return `${prefix}${quote}${REDACTED}${quote}`;
}

export function redactSecretText(value) {
  return String(value ?? '')
    .replace(BEARER, `$1${REDACTED}`)
    .replace(QUOTED_LABEL, (_match, prefix, secret) => maskQuoted(secret, prefix))
    .replace(BARE_LABEL, (_match, prefix, secret) => maskQuoted(secret, prefix))
    .replace(USER_FLAG, `$1${REDACTED}`);
}

/* The values those labels marked as secret, so a caller can also scrub the same
 * value from other text (MCP tool results, audit messages). Bounded: this is
 * defence in depth, not a secret scanner. */
export function secretValuesIn(text, limit = 16) {
  const values = [];
  for (const pattern of [BEARER, QUOTED_LABEL, BARE_LABEL, USER_FLAG]) {
    for (const match of String(text ?? '').matchAll(pattern)) {
      const value = String(match[2] ?? '').replace(/^["']|["']$/g, '');
      if (value && value !== REDACTED && !values.includes(value)) values.push(value);
      if (values.length >= limit) return values;
    }
  }
  return values;
}

/* `secrets` are values already known to be secret (for example the credential
 * of the current WiFi change): they are replaced by value, wherever they
 * appear. Shorter values are skipped because replacing them would destroy
 * unrelated text without protecting anything. */
export function redactTaskText(value, secrets = []) {
  const known = (Array.isArray(secrets) ? secrets : [])
    .filter(secret => typeof secret === 'string' && secret.length >= 4);
  return known.reduce((text, secret) => text.split(secret).join(REDACTED), redactSecretText(value))
    .replace(/https?:\/\/[^\s"<>]+/gi, url => {
      try { const u = new URL(url); u.username = ''; u.password = ''; u.search = ''; u.hash = ''; return u.href; } catch { return '[url]'; }
    }).slice(0, 2000);
}
function savedEvidence(value) {
  return {id:redactTaskText(value.id).slice(0,80), tool:redactTaskText(value.tool).slice(0,80),
    kind:['verification','observation','execution'].includes(value.kind) ? value.kind : 'observation',
    status:redactTaskText(value.status).slice(0,40), subject:redactTaskText(value.subject).slice(0,400),
    executionId:redactTaskText(value.executionId).slice(0,80), complete:value.complete === true,
    expected:{bytes:Number.isSafeInteger(value.expected?.bytes) ? value.expected.bytes : null,
      sha256:/^[a-f0-9]{64}$/i.test(value.expected?.sha256) ? value.expected.sha256 : '',
      state:redactTaskText(value.expected?.state).slice(0,200)}};
}
export function savedPlan(plan) {
  return (Array.isArray(plan) ? plan : []).slice(0,8).filter(s=>s && typeof s==='object').map(s=>({
    title:redactTaskText(s.title), status:['pending','in_progress','completed','blocked'].includes(s.status)?s.status:'pending',
    verification:redactTaskText(s.verification), nextAction:redactTaskText(s.nextAction),
    kind:s.kind === 'observation' ? 'observation' : 'action', expectedResult:redactTaskText(s.expectedResult),
    completion:['verified','observed'].includes(s.completion) ? s.completion : null,
    evidenceIds:(Array.isArray(s.evidenceIds) ? s.evidenceIds : []).slice(0,8).map(id=>redactTaskText(id).slice(0,80)),
    evidence:(Array.isArray(s.evidence) ? s.evidence : []).slice(0,8).filter(Boolean).map(savedEvidence),
  }));
}
export function savedCheckpoint(value) {
  if (value?.version !== 1 || typeof value.deviceKey !== 'string') return null;
  const sessionId = value => typeof value === 'string' ? value.slice(0,80) : Number.isSafeInteger(value) ? value : null;
  return {version:1, deviceKey:value.deviceKey.slice(0,1000), sessionId:sessionId(value.sessionId),
    logCursor:Number.isSafeInteger(value.logCursor) && value.logCursor>=0 ? value.logCursor : null,
    plan:savedPlan(value.plan), evidence:(Array.isArray(value.evidence) ? value.evidence : []).slice(-16).filter(Boolean).map(savedEvidence),
    pendingExecutions:(Array.isArray(value.pendingExecutions) ? value.pendingExecutions : []).slice(-8)
      .filter(ref=>ref && typeof ref.id==='string' && typeof ref.executorId==='string' && /^[a-zA-Z0-9_-]{1,80}$/.test(ref.id) && /^[a-zA-Z0-9_-]{1,80}$/.test(ref.executorId))
      .map(ref=>({id:ref.id,executorId:ref.executorId,sessionId:sessionId(ref.sessionId),
        delivery:['sent','unknown','not-sent'].includes(ref.delivery) ? ref.delivery : 'unknown',
        executionStatus:ref.executionStatus === 'completed' ? 'completed' : 'unknown',
        ...(Number.isInteger(ref.logStart) ? {logStart:ref.logStart} : {}),
        ...(Number.isInteger(ref.cursor) ? {cursor:ref.cursor} : {}),
        ...(/^[a-f0-9]{64}$/.test(ref.requestFingerprint) ? {requestFingerprint:ref.requestFingerprint} : {})})),
  };
}
export function createTaskStore(storage) {
  const read = () => {
    try {
      const data = JSON.parse(storage.getItem(TASKS_KEY) || '[]');
      return Array.isArray(data) ? data.filter(t => t && typeof t.id === 'string' && typeof t.goal === 'string' && typeof t.deviceKey === 'string').slice(-20) : [];
    } catch { return []; }
  };
  return {
    list: key => read().filter(t => t.deviceKey === key).reverse().map(t => ({ ...t, status: t.status === 'running' ? 'interrupted' : t.status, historical: true })),
    save(task) {
      if (!task.deviceKey) return;
      const item = { id: task.id, deviceKey: task.deviceKey, updatedAt: Date.now(), goal: redactTaskText(task.goal),
        summary: redactTaskText(task.summary), status: task.status,
        plan:savedPlan(task.plan), checkpoint:savedCheckpoint(task.checkpoint),
        executions: (task.executions || []).slice(-8).map(e => ({ delivery: e.delivery, exitCode: e.exitCode,
          executionStatus: e.executionStatus, path: redactTaskText(e.download?.path), observation: e.observation })) };
      const data = read().filter(t => t.id !== item.id); data.push(item);
      storage.setItem(TASKS_KEY, JSON.stringify(data.slice(-20)));
    },
    clear(key) { storage.setItem(TASKS_KEY, JSON.stringify(read().filter(t => t.deviceKey !== key))); },
  };
}
