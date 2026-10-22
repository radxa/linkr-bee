import test from 'node:test';
import assert from 'node:assert/strict';
import {createTaskEvidence, checkpointForTask, inputFingerprint} from '../../web/agent_task_state.js';
import {createTaskStore, savedCheckpoint} from '../../web/agent_tasks.js';

const step = (evidenceIds=[], extra={}) => ({title:'Check file',status:'completed',expectedResult:'File has 36 bytes',
  verification:'Compared the expected size',nextAction:'',evidenceIds,...extra});
const verified = (status='match',extra={}) => ({source:'application-verification',status,complete:true,
  executionStatus:'completed',executionId:'serial-1',path:'/tmp/device-id',expectedBytes:36,checks:{bytes:status},...extra});

test('invented, historical and same-turn evidence cannot complete a task',()=>{
  const ledger=createTaskEvidence();
  assert.throws(()=>ledger.validatePlan([step(['invented'])],2),/Historical or invented/);
  const proof=ledger.record('verify_target_file',{},verified(),1);
  assert.throws(()=>ledger.validatePlan([step([proof.id])],1),/earlier model turn/);
  assert.equal(ledger.validatePlan([step([proof.id])],2)[0].completion,'verified');
  ledger.clear();
  assert.throws(()=>ledger.validatePlan([step([proof.id])],3),/Historical or invented/);
});

for (const status of ['mismatch','indeterminate','observed']) test(`${status} cannot complete an action`,()=>{
  const ledger=createTaskEvidence(), proof=ledger.record('verify_target_file',{},verified(status),1);
  assert.throws(()=>ledger.validatePlan([step([proof.id])],2),/verification with status=match/);
});
test('timeout, unfinished execution and shell exit zero do not become a successful repair',()=>{
  for(const value of [verified('match',{timedOut:true}),verified('match',{executionStatus:'unknown'}),
    {id:'serial-1',delivery:'sent',executionStatus:'completed',exitCode:0}]) {
    const ledger=createTaskEvidence(), proof=ledger.record(value.source?'verify_target_file':'monitor_serial_execution',{},value,1);
    assert.throws(()=>ledger.validatePlan([step([proof.id])],2),/verification with status=match/);
  }
});
test('accessory read-back is scoped to the settings the app actually compared and never stores credentials',()=>{
  const ledger=createTaskEvidence();
  const proof=ledger.record('set_wifi',{action:'connect',ssid:'network',password:'do-not-store'},
    {source:'accessory-management-channel',settled:true,applied:true},1);
  assert.equal(ledger.validatePlan([step([proof.id])],2)[0].completion,'verified');
  assert.deepEqual(proof.expected,{bytes:null,sha256:'',state:'connected'});
  assert.doesNotMatch(JSON.stringify(proof),/do-not-store|network/);
  const pending=ledger.record('set_wifi',{action:'connect'},{source:'accessory-management-channel',settled:false,applied:true},1);
  assert.throws(()=>ledger.validatePlan([step([pending.id])],2),/verification with status=match/);
});
test('diagnostic observations retain their lower evidence level and exact verification scope',()=>{
  const ledger=createTaskEvidence();
  assert.equal(ledger.record('load_skill',{},verified(),1),null);
  const proof=ledger.record('read_serial_log',{}, {text:'kernel panic'},1);
  assert.equal(ledger.validatePlan([step([proof.id],{kind:'observation'})],2)[0].completion,'observed');
  assert.throws(()=>ledger.validatePlan([step([proof.id])],2),/verification with status=match/);
  const match=ledger.record('verify_target_file',{},verified(),1);
  assert.deepEqual(match.expected,{bytes:36,sha256:'',state:''});
  assert.equal(match.subject,'/tmp/device-id');
  const spoofed=ledger.record('read_web_page',{},verified(),1);
  assert.equal(spoofed.kind,'observation');
  assert.throws(()=>ledger.validatePlan([step([spoofed.id])],2),/verification with status=match/);
});
test('verification must follow the operation; accepted earlier steps retain their bounded proof',()=>{
  const ledger=createTaskEvidence(),proof=ledger.record('verify_target_file',{},verified(),1);
  const completed=step([proof.id]);
  ledger.noteInput(2);
  assert.throws(()=>ledger.validatePlan([completed],3),/predates/);
  const fresh=ledger.record('verify_target_file',{},verified(),3);
  ledger.validatePlan([step([fresh.id])],4);
  ledger.noteInput(5);
  assert.equal(ledger.validatePlan([step([fresh.id])],6)[0].completion,'verified');
  ledger.validatePlan([step([fresh.id],{status:'in_progress'})],7);
  ledger.noteInput(8);
  assert.throws(()=>ledger.validatePlan([step([fresh.id])],9),/predates/);
});
test('checkpoints merge unresolved references, resolve completed ones and never save input',async()=>{
  const requestFingerprint=await inputFingerprint({text:'touch /tmp/private-input',appendEnter:true});
  const old={id:'serial-1',executorId:'old-instance',sessionId:1,delivery:'unknown',executionStatus:'unknown',requestFingerprint};
  const record={...old,delivery:'sent',executionStatus:'completed',exitCode:0,payload:'secret-command',evidence:'password=hunter2'};
  const cp=checkpointForTask({deviceKey:'target:a',executions:[record],checkpoint:{pendingExecutions:[old]}},{sessionId:1});
  assert.deepEqual(cp.pendingExecutions,[]);
  const pending=checkpointForTask({deviceKey:'target:a',executions:[],checkpoint:{pendingExecutions:[old]}},{sessionId:2});
  assert.equal(pending.pendingExecutions[0].executorId,'old-instance');
  const completed=Array.from({length:9},(_,index)=>({...record,id:`serial-${index+2}`,executorId:'new-instance'}));
  assert.equal(checkpointForTask({deviceKey:'target:a',executions:completed,checkpoint:pending},{sessionId:2}).pendingExecutions[0].executorId,'old-instance');
  let raw='[]';const store=createTaskStore({getItem:()=>raw,setItem:(_key,value)=>raw=value});
  store.save({id:'task',deviceKey:'target:a',goal:'Inspect',status:'running',executions:[record],checkpoint:{...pending,
    evidence:[{id:'evidence-one',tool:'read_web_page',subject:'https://user:pass@docs.example/a?token=private',payload:'secret-command'}]}});
  assert.doesNotMatch(raw,/secret-command|hunter2|private|user:pass/);
  assert.equal(store.list('target:a')[0].checkpoint.pendingExecutions[0].requestFingerprint,requestFingerprint);
  assert.equal(savedCheckpoint({version:999}),null);
});
