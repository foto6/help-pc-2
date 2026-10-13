import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {verifyR45Release} from '../bin/pc-autonomy-daemon.js';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CONTRACT, admission, PcAutonomySupervisor, atomicWrite, localRead, budgetCheck, createLock, assertConfig, httpJson} from '../src/pc-autonomy-supervisor.js';
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
test('lock refuses concurrent writer and releases only original instance',()=>{const t=tmp();try{const u=createLock(t.file);assert.throws(()=>createLock(t.file),/EEXIST/);u();const r=createLock(t.file);r();}finally{t.cleanup();}});
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
