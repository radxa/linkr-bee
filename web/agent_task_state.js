/* Application-owned task evidence and resumable observations. No command text,
 * permissions or model settings belong in a checkpoint. Stored state is history,
 * never evidence for a new run. */
const idPattern = /^[a-zA-Z0-9_-]{1,80}$/;
const statuses = ['pending', 'in_progress', 'completed', 'blocked'];
const observationTools = new Set(['get_device_status', 'read_serial_log', 'search_serial_log',
  'wait_for_serial_output', 'read_web_page', 'search_radxa_docs', 'read_target_file',
  'watch_serial_output', 'get_accessory_diagnostics', 'wifi_scan']);
const verificationTools = new Set(['verify_target_file', 'verify_target_service']);
const accessoryTools = new Set(['set_uart_config','set_wifi','set_webdav']);

export async function inputFingerprint({text, appendEnter}) {
  const bytes = new TextEncoder().encode(JSON.stringify([text, appendEnter]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function executionReference(record) {
  if (!record || typeof record.id !== 'string' || typeof record.executorId !== 'string' || !idPattern.test(record.id) || !idPattern.test(record.executorId)) return null;
  return {id:record.id, executorId:record.executorId, sessionId:record.sessionId,
    delivery:record.delivery, executionStatus:record.executionStatus,
    ...(Number.isInteger(record.exitCode) ? {exitCode:record.exitCode} : {}),
    ...(Number.isInteger(record.logStart) ? {logStart:record.logStart} : {}),
    ...(Number.isInteger(record.observedCursor) ? {cursor:record.observedCursor} : {}),
    ...(typeof record.requestFingerprint === 'string' && /^[a-f0-9]{64}$/.test(record.requestFingerprint)
      ? {requestFingerprint:record.requestFingerprint} : {})};
}

export function checkpointForTask(task, status) {
  const executions = [...new Map([...(task.checkpoint?.pendingExecutions || []),
    ...(task.executions || []).map(executionReference).filter(Boolean)]
    .map(ref => [`${ref.executorId}:${ref.id}`,ref])).values()]
    .filter(e => e.delivery !== 'not-sent' && e.executionStatus !== 'completed').slice(-8);
  return {version:1, deviceKey:task.deviceKey, sessionId:status.sessionId,
    pendingExecutions:executions,
    plan:task.plan || [], evidence:task.checkpoint?.evidence || [],
    logCursor:task.checkpoint?.logCursor ?? null};
}

/* Only successful tool results can enter the ledger; the model cannot supply a
 * verdict, forge a reference or promote an exit code into a goal verification. */
export function createTaskEvidence() {
  const entries = new Map();
  const accepted = new Set();
  let inputRound = 0;
  return {
    clear() { entries.clear(); accepted.clear(); inputRound=0; },
    noteInput(round) { inputRound=round; },
    list() { return [...entries.values()].map(entry => structuredClone(entry)); },
    record(tool, args, value, round) {
      let kind;
      const accessory=accessoryTools.has(tool) && value.source === 'accessory-management-channel';
      if (verificationTools.has(tool) && value.source === 'application-verification') kind = 'verification';
      else if (accessory) kind = 'verification';
      else if (['inspect_serial_execution', 'monitor_serial_execution'].includes(tool)) kind = 'execution';
      else if (observationTools.has(tool)) kind = 'observation';
      else return null;
      const entry = {id:`evidence-${crypto.randomUUID()}`, tool, kind, round,
        status:accessory ? (value.settled ? value.applied === true ? 'match' : 'mismatch' : 'indeterminate') : kind === 'verification' ? value.status : kind === 'execution' ? value.executionStatus : 'observed',
        executionId:value.executionId || (kind === 'execution' ? value.id : undefined),
        subject:accessory ? `Linkr Bee: ${tool}` : value.path || value.subject || value.url || args.path || args.unit || args.process || (args.port ? String(args.port) : ''),
        /* Keep the app's exact comparison scope, not the model's paraphrase. */
        ...(kind === 'verification' ? {expected:{bytes:value.expectedBytes ?? null,
          sha256:value.expectedSha256 || '', state:accessory ? (tool === 'set_uart_config' ? JSON.stringify(Object.fromEntries(['baud','dataBits','parity','stopBits','flow'].filter(key=>args[key]!==undefined).map(key=>[key,args[key]]))) : args.action === 'off' ? 'off' : tool === 'set_wifi' ? 'connected' : 'on') : value.expected || ''}, checks:value.checks || {},
          complete:accessory ? value.settled === true : value.complete === true && !value.timedOut && value.executionStatus === 'completed'} : {})};
      entries.set(entry.id, entry);
      if (entries.size > 96) entries.delete(entries.keys().next().value);
      return structuredClone(entry);
    },
    validatePlan(steps, round) {
      if (!Array.isArray(steps) || !steps.length || steps.length > 8 ||
          steps.filter(s => s.status === 'in_progress').length > 1 || steps.some(s =>
            !s.title?.trim() || !statuses.includes(s.status) ||
            (s.kind !== undefined && !['action','observation'].includes(s.kind)) ||
            (s.status === 'completed' && (!s.verification?.trim() || !s.expectedResult?.trim())) ||
            (s.status === 'blocked' && (!s.verification?.trim() || !s.nextAction?.trim())))) {
        throw new Error('Use up to eight steps, at most one in progress, verification for completed steps with expectedResult, and a reason plus next action for blocked steps.');
      }
      const validated = steps.map(step => {
        const refs = [...new Set(step.evidenceIds || [])];
        const evidence = refs.map(id => entries.get(id));
        if (evidence.some(entry => !entry || entry.round >= round)) {
          throw new Error('Evidence must come from a successful tool result reviewed in an earlier model turn of this question. Historical or invented evidence is not current.');
        }
        let completion = null;
        if (step.status === 'completed') {
          if (!refs.length) throw new Error('Completed steps require current evidenceIds; prose and exit code 0 are insufficient.');
          if ((step.kind || 'action') === 'action') {
            if (!evidence.some(entry => entry.kind === 'verification' && entry.status === 'match' && entry.complete)) {
              throw new Error('Completed action steps require a completed application verification with status=match. Mark unsupported verification blocked, or use kind=observation for a diagnostic finding only.');
            }
            const key=JSON.stringify([step.title,step.expectedResult,refs]);
            if (!accepted.has(key) && !evidence.some(entry=>entry.kind === 'verification' && entry.status === 'match' && entry.complete && entry.round>=inputRound)) {
              throw new Error('This verification predates a later serial input. Verify the effect after the operation before completing a new action step.');
            }
            completion = 'verified';
          } else {
            if (!evidence.some(entry => entry.kind !== 'execution')) throw new Error('Delivery or shell exit alone cannot complete an observation step. Read the actual result.');
            completion = 'observed';
          }
        }
        return {...step, kind:step.kind || 'action', evidenceIds:refs, evidence:structuredClone(evidence), completion};
      });
      accepted.clear();
      for (const step of validated) if(step.completion==='verified') accepted.add(JSON.stringify([step.title,step.expectedResult,step.evidenceIds]));
      return validated;
    },
  };
}
