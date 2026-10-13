import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, readdirSync, existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {verifyR45Release,readRelayProbe,runCli} from '../bin/pc-autonomy-daemon.js';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CONTRACT, admission, PcAutonomySupervisor, atomicWrite, localRead, budgetCheck, createLock, LOCK_STALE_GRACE_MS, assertConfig, httpJson, assignmentLedgerSafety} from '../src/pc-autonomy-supervisor.js';
const now=Date.parse('2026-10-13T03:00:00Z');
function cfg(mode='armed'){return {contract:CONTRACT,mode,operatorApproved:mode==='armed',bridge:{url:'http://127.0.0.1:17448'},r45:{runner:'E:/WebAIBridge/app/data/operator-tools/r45-durable-autonomy/releases/xxx/autonomy-r45-runner.js',plan:'E:/plan.json',state:'E:/state.json'},maxSendsPerHour:3,minSpacingMs:90000,pollIntervalMs:60000};}
function probes(){return {bridge:{health:{state:'OK',reasons:[]}},cutover:{cutoverState:{holdActive:false}},operator:{mode:'RUNNING_MANAGED',queuePaused:false,allowAutonomousSend:true,reconciliationRequired:false},relay:{status:'HEALTHY',observedAt:new Date(now-3000).toISOString()}};}
const tmp=()=>{const dir=mkdtempSync(join(tmpdir(),'pc-control-autonomy-'));return {file:join(dir,'supervisor.json'),cleanup:()=>rmSync(dir,{force:true,recursive:true})};};
test('native PC supervisor uses single verified PC Control authority and exact gates',()=>{assert.deepEqual(admission({config:cfg(),...probes(),now}),{ready:true,blocks:[]});});
test('R42 hold blocks dispatch despite stale optimistic queue state',()=>{const p=probes();p.cutover.cutoverState.holdActive=true;assert.ok(admission({config:cfg(),...p,now}).blocks.includes('r42_cutover_hold'));});
test('operator pause and unknown side effects cannot be overridden by coordinator',()=>{const p=probes();p.operator.mode='PAUSED';p.operator.reconciliationRequired=true;const d=admission({config:cfg(),...p,now});assert.ok(d.blocks.includes('operator_not_running'));assert.ok(d.blocks.includes('operator_reconciliation_unknown'));});
test('PC relay freshness failure fails closed',()=>{const p=probes();p.relay.observedAt=new Date(now-180000).toISOString();assert.ok(admission({config:cfg(),...p,now}).blocks.includes('pc_control_relay_unverified'));});
test('bridge degraded, reason present, and intentional watchdog-off block real send',()=>{const p=probes();p.bridge.health.state='BLOCKED';p.bridge.health.reasons=['timeline_io:stale'];p.operator.allowAutonomousSend=false;const d=admission({config:cfg(),...p,now});assert.ok(d.blocks.includes('bridge_unhealthy'));assert.ok(d.blocks.includes('bridge_health_reasons_present'));assert.ok(d.blocks.includes('autonomous_send_disabled'));});
test('observer still makes status progress without a Send',async()=>{const t=tmp();let actual=null;try{const boss=new PcAutonomySupervisor({config:cfg('observe'),statePath:t.file,clock:()=>now,probes:async()=>probes(),runner:async x=>{actual=x;return {status:'READ_ONLY',dispatched:[],counts:{PENDING:2}};}});const s=await boss.cycle({dispatch:true,brain:true});assert.deepEqual(actual,{dispatch:false,brain:false});assert.equal(s.decision.dispatched,0);assert.equal(s.decision.status,'READ_ONLY');assert.equal(s.taskCounts.PENDING,2);}finally{t.cleanup();}});
test('admitted manual Send is bounded, persisted and spaced across process restart',async()=>{const t=tmp();let calls=0;try{const run=async o=>{calls++;return o.dispatch?{status:'SUBMITTED',dispatched:[{assignmentId:'a-'+calls}],counts:{PENDING:0}}:{status:'READ_ONLY',dispatched:[]};};const b=new PcAutonomySupervisor({config:cfg(),statePath:t.file,clock:()=>now,probes:async()=>probes(),runner:run});assert.equal((await b.cycle({dispatch:true})).decision.dispatched,1);const c=new PcAutonomySupervisor({config:cfg(),statePath:t.file,clock:()=>now+5000,probes:async()=>({...probes(),relay:{status:'HEALTHY',observedAt:new Date(now+5000).toISOString()}}),runner:run});const d=await c.cycle({dispatch:true});assert.equal(d.dispatchEnabled,false);assert.ok(d.decision.blocks.includes('send_rate_budget'));assert.equal(localRead(t.file).sends.length,1);}finally{t.cleanup();}});
test('unknown effect is durable and no automatic replay follows',async()=>{const t=tmp();let sent=0;try{const b=new PcAutonomySupervisor({config:cfg(),statePath:t.file,clock:()=>now,probes:async()=>probes(),runner:async ({dispatch})=>{if(dispatch)sent++;return {status:'RECONCILIATION_REQUIRED',dispatched:[]};}});await b.cycle({dispatch:true});assert.equal(localRead(t.file).pendingUnknown.length,1);await b.cycle({dispatch:true});assert.equal(sent,1);}finally{t.cleanup();}});
test('lock refuses concurrent writer and releases only original instance',()=>{const t=tmp();try{const u=createLock(t.file);assert.throws(()=>createLock(t.file),/AUTONOMY_LOCK_BUSY_OR_UNVERIFIED/);u();const r=createLock(t.file);r();}finally{t.cleanup();}});
test('corrupted journal fails closed instead of resetting',async()=>{const t=tmp();try{atomicWrite(t.file,{a:1});assert.deepEqual(localRead(t.file),{a:1});const s=readFileSync(t.file,'utf8');assert.match(s,/"a": 1/);}finally{t.cleanup();}});
test('disallow chat opens, rate-limit bypass, insecure origins, fast polling and unapproved arming',()=>{for(const bad of [{allowNewChat:true},{allowProviderRateBypass:true},{pollIntervalMs:1000},{operatorApproved:false}])assert.throws(()=>assertConfig({...cfg(),...bad}),/AUTONOMY_/);assert.throws(()=>assertConfig({...cfg(),bridge:{url:'http://1.2.3.4:17448'}}),/AUTONOMY_LOOPBACK/);});
test('reject non-loopback URL even for read-only probes',async()=>{await assert.rejects(()=>httpJson('http://example.com','/api/health'),/LOCAL_ONLY/);});
test('budget one hour window prunes old sends without replay',()=>{assert.equal(budgetCheck({sends:[now-3700000,now-120000,now-91000]},now,3,90000).allowed,true);assert.equal(budgetCheck({sends:[now-120000,now-91000,now-10000]},now,3,90000).allowed,false);});

test('pinned R45 guarded shadow manifest loads and detects any source tamper',()=>{
  const d=mkdtempSync(join(tmpdir(),'r45-durable-autonomy-'));
  try {
    const dir=join(d,'releases','28e4-test');mkdirSync(dir,{recursive:true});
    const runner=join(dir,'autonomy-r45-runner.js');
    const body=Buffer.from('module.exports={tick:()=>({status:"READ_ONLY"})};');
    writeFileSync(runner,body);
    const sha=createHash('sha1').update('blob '+body.length+'\0').update(body).digest('hex');
    const exactSha='a'.repeat(40);
    writeFileSync(join(dir,'MANIFEST.json'),JSON.stringify({schema:'r45.isolated.release.v1',exactSha,
      dispatchEnabled:false,running:false,productionModified:false,files:{'autonomy-r45-runner.js':sha}}));
    assert.equal(verifyR45Release({r45:{runner,sha:exactSha}}),runner);
    writeFileSync(runner,'module.exports={}');
    assert.throws(()=>verifyR45Release({r45:{runner,sha:exactSha}}),/R45_BLOB_DRIFT/);
  }finally{rmSync(d,{recursive:true,force:true});}
});

test('existing PC relay health.json is trusted only if live, synced and free of unknown effects',()=>{
  const t=tmp();
  try{
    const record={status:'healthy',phase:'execute_request',live:true,
      reconciliation_required:false,local_head:'a'.repeat(40),
      remote_head:'a'.repeat(40),backlog_count:0,updated_at_unix:now/1000};
    writeFileSync(t.file,JSON.stringify(record));
    assert.equal(readRelayProbe({relay:{healthFile:t.file}}).status,'HEALTHY');
    assert.equal(readRelayProbe({relay:{healthFile:t.file}}).observedAt,new Date(now).toISOString());
    record.reconciliation_required=true;
    writeFileSync(t.file,JSON.stringify(record));
    assert.equal(readRelayProbe({relay:{healthFile:t.file}}).status,'UNKNOWN');
    record.reconciliation_required=false;record.remote_head='b'.repeat(40);
    writeFileSync(t.file,JSON.stringify(record));
    assert.equal(readRelayProbe({relay:{healthFile:t.file}}).status,'UNKNOWN');
    record.remote_head=record.local_head;record.backlog_count=1;
    writeFileSync(t.file,JSON.stringify(record));
    assert.equal(readRelayProbe({relay:{healthFile:t.file}}).status,'UNKNOWN');
  }finally{t.cleanup();}
});
test('offline local Ollama proposal is allowed under R42 HOLD but cannot Send',async()=>{
  const t=tmp(),conf={...cfg('observe'),enableBrain:true};
  let params;
  try{
    const p=probes();p.cutover.cutoverState.holdActive=true;
    const b=new PcAutonomySupervisor({config:conf,statePath:t.file,clock:()=>now,
      probes:async()=>p,runner:async o=>{params=o;return {status:'READ_ONLY',dispatched:[]};}});
    const r=await b.cycle({dispatch:true,brain:true});
    assert.deepEqual(params,{dispatch:false,brain:true});
    assert.equal(r.dispatchEnabled,false);
    assert.ok(r.decision.blocks.includes('r42_cutover_hold'));
  }finally{t.cleanup();}
});

test('verified-dead old PID can be reclaimed after grace and preserves orphan evidence',()=>{
  const t=tmp();
  try{
    const dir=t.file+'.lock';mkdirSync(dir);
    writeFileSync(join(dir,'owner.json'),JSON.stringify({pid:88888888,nonce:'old-owner',at:'2020-01-01T00:00:00Z'}));
    const release=createLock(t.file,{now:now,dead:pid=>pid===88888888});
    assert.equal(JSON.parse(readFileSync(join(dir,'owner.json'),'utf8')).pid,process.pid);
    assert.equal(readdirSync(join(t.file,'..')).some(x=>x.includes('.orphan.')),true);
    release();
    assert.equal(existsSync(dir),false);
  }finally{t.cleanup();}
});
test('live, fresh, missing, or suspicious lock owners cannot be taken over',()=>{
  const t=tmp();
  try{
    const dir=t.file+'.lock';mkdirSync(dir);
    const owner={pid:88888888,nonce:'old',at:'2020-01-01T00:00:00Z'};
    writeFileSync(join(dir,'owner.json'),JSON.stringify(owner));
    assert.throws(()=>createLock(t.file,{now,dead:()=>false}),/BUSY_OR_UNVERIFIED/);
    writeFileSync(join(dir,'owner.json'),JSON.stringify({...owner,at:new Date(now).toISOString()}));
    assert.throws(()=>createLock(t.file,{now,dead:()=>true}),/BUSY_OR_UNVERIFIED/);
    writeFileSync(join(dir,'owner.json'),'{"broken":true}');
    assert.throws(()=>createLock(t.file,{now,dead:()=>true}),/BUSY_OR_UNVERIFIED/);
    assert.equal(existsSync(dir),true);
    assert.equal(LOCK_STALE_GRACE_MS,120000);
  }finally{t.cleanup();}
});
test('restarted stale owner cannot delete successor lock on release',()=>{
  const t=tmp();
  try{
    const release=createLock(t.file);
    const file=join(t.file+'.lock','owner.json');
    const owner=JSON.parse(readFileSync(file,'utf8'));
    writeFileSync(file,JSON.stringify({...owner,nonce:'new-owner-generation'}));
    release();
    assert.equal(existsSync(t.file+'.lock'),true);
  }finally{t.cleanup();}
});
test('lock takeover race is fenced by exact owner nonce and recheck',()=>{
  const t=tmp();
  try{
    const dir=t.file+'.lock';mkdirSync(dir);
    const file=join(dir,'owner.json');
    writeFileSync(file,JSON.stringify({pid:88888888,nonce:'generation-1',at:'2020-01-01T00:00:00Z'}));
    let calls=0;
    assert.throws(()=>createLock(t.file,{now,dead:()=>{
      if(++calls===1)writeFileSync(file,JSON.stringify({pid:88888888,nonce:'generation-2',at:'2020-01-01T00:00:00Z'}));
      return true;
    }}),/LOCK_CHANGED_DURING_RECOVERY/);
    assert.equal(existsSync(dir),true);
    assert.equal(existsSync(dir+'.takeover'),false);
  }finally{t.cleanup();}
});

test('two long-lived coordinators cannot alternate turns or duplicate watcher ownership',async()=>{
  const home=mkdtempSync(join(tmpdir(),'pc-native-single-watch-'));
  try{
    const release=join(home,'r45-durable-autonomy','releases','test-source');
    mkdirSync(release,{recursive:true});
    const source=join(release,'autonomy-r45-runner.js');
    const bytes=Buffer.from('module.exports={tick:()=>({status:"READ_ONLY"}),observe:async()=>({})};');
    writeFileSync(source,bytes);
    const gitBlob=createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
    const fixedSha='a'.repeat(40);
    writeFileSync(join(release,'MANIFEST.json'),JSON.stringify({
      schema:'r45.isolated.release.v1',exactSha:fixedSha,
      dispatchEnabled:false,running:false,productionModified:false,
      files:{'autonomy-r45-runner.js':gitBlob},
    }));
    const planFile=join(home,'plan.json');
    writeFileSync(planFile,JSON.stringify({allowDispatch:false,tasks:[]}));
    const stateFile=join(home,'supervisor-state.json');
    const cfgFile=join(home,'config.json');
    writeFileSync(cfgFile,JSON.stringify({
      ...cfg('observe'),r45:{runner:source,plan:planFile,state:join(home,'r45-state.json'),sha:fixedSha},
      state:stateFile,
    }));
    let enter;
    const entered=new Promise(done=>{enter=done;});
    let resume;
    const held=new Promise(done=>{resume=done;});
    const stopper=new AbortController();
    const read=async()=>probes();
    const runner=async()=>{enter();await held;return {status:'READ_ONLY',dispatched:[]};};
    const first=runCli(['--config',cfgFile,'--watch'],{probes:read,runner,stopSignal:stopper.signal,clock:()=>now});
    await entered;
    assert.equal(existsSync(stateFile+'.watcher.lock'),true);
    await assert.rejects(()=>runCli(['--config',cfgFile,'--watch'],{
      probes:read,runner:async()=>{throw Error('NEVER_EXECUTE_SECOND_WATCHER');},clock:()=>now,
      stopSignal:new AbortController().signal,
    }),/AUTONOMY_LOCK_BUSY_OR_UNVERIFIED/);
    stopper.abort();resume();
    await first;
    assert.equal(existsSync(stateFile+'.watcher.lock'),false);
    assert.equal(JSON.parse(readFileSync(stateFile,'utf8')).revision,1);
  }finally{rmSync(home,{force:true,recursive:true});}
});

test('R49 assignment journal allows future work despite historical terminal CI/evidence failures',()=>{
  const source={assignments:[
    {id:'curator',state:'queued',dispatchSubmitAttempted:false,dispatchCount:0},
    {id:'prior-timeout',state:'blocked',dispatchSubmitAttempted:true,
      dispatchFingerprint:'specific-fingerprint',dispatchCount:1,dispatchFailureCode:'evidence_timeout'},
    {id:'prior-ci',state:'failed',dispatchSubmitAttempted:true,
      dispatchFingerprint:'specific-fingerprint-2',dispatchCount:1,dispatchFailureCode:'ci_failed'},
    {id:'completed',state:'completed',dispatchCount:1,dispatchSubmitAttempted:true,
      dispatchFingerprint:'confirmed'},
  ]};
  assert.deepEqual(assignmentLedgerSafety(source),{
    safe:true,reason:'ledger_reconciled',unknownCount:0,queued:1,
    active:0,historicFailed:2,total:4,
  });
});
test('R49 ledger forbids ambiguous queued retry, running Send, missing IDs and missing fingerprints',()=>{
 const base={assignments:[{id:'curator',state:'queued',dispatchSubmitAttempted:false,dispatchCount:0}]};
 for(const bad of [
  {id:'queuedAttempt',state:'queued',dispatchSubmitAttempted:true,dispatchCount:1},
  {id:'running',state:'running',dispatchSubmitAttempted:true,dispatchCount:1},
  {id:'unknown',state:'mystery'},
  {id:'blockedUncertain',state:'blocked',dispatchSubmitAttempted:true,dispatchCount:1},
  {id:'noConfirmedUnsent',state:'queued',dispatchCount:0},
  {id:'curator',state:'queued',dispatchSubmitAttempted:false,dispatchCount:0},
  {id:'activeEvidence',state:'awaiting_evidence',dispatchCount:1},
 ]) {
  const candidate={assignments:[...base.assignments,bad]};
  const decision=assignmentLedgerSafety(candidate);
  assert.equal(decision.safe,false,'must reject '+bad.id);
  assert.ok(decision.unknownCount>=1);
 }
 assert.equal(assignmentLedgerSafety({assignments:null}).safe,false);
 assert.equal(assignmentLedgerSafety({}).safe,false);
});
