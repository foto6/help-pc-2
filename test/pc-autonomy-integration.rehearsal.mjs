#!/usr/bin/env node
// Isolated PC Control R41 -> pinned R45 -> R50 contract rehearsal.
// NO localhost requests, NO browser targets, NO GitHub writes, NO provider Send.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {PcAutonomySupervisor, CONTRACT} from '../src/pc-autonomy-supervisor.js';
import {verifyR45Release} from '../bin/pc-autonomy-daemon.js';
const req=createRequire(import.meta.url);
const [runnerInput,gateInput]=process.argv.slice(2);
if(!runnerInput||!gateInput)throw Error('usage: node test/pc-autonomy-integration.rehearsal.mjs ABSOLUTE_R45_SHADOW_RUNNER ABSOLUTE_R50_GATE');
const runner=resolve(runnerInput),gate=resolve(gateInput);
assert.equal(verifyR45Release({r45:{runner,sha:'28e4accf59e37e767c37585b85cdacbdbac62120'}}),runner);
const gateBytes=readFileSync(gate);
const blob=createHash('sha1').update('blob '+gateBytes.length+'\0').update(gateBytes).digest('hex');
assert.equal(blob,'4b1fb7ba970ce03fff025a4a240a18334ad42546','R50 gate SHA must be immutable');
const {tick}=req(runner);
const {authorizeAutonomousSend}=req(gate);
assert.equal(typeof tick,'function');
const healthy=()=>({
  bridge:{health:{state:'OK',reasons:[]}},
  cutover:{cutoverState:{holdActive:false}},
  operator:{mode:'RUNNING_MANAGED',queuePaused:false,allowAutonomousSend:true,reconciliationRequired:false},
  relay:{status:'HEALTHY',observedAt:new Date(tickAt).toISOString()},
});
let tickAt=Date.parse('2026-10-13T07:00:00Z');
const holdDecision=authorizeAutonomousSend({
  holdActive:true,queuePaused:true,lifecycleMode:'RUNNING_MANAGED',
  supervisor:{mode:'off',enabled:false,allowAutonomousSend:false,enforceHighMode:true},
  assignmentState:'queued',
});
assert.equal(holdDecision.allowed,false);
assert.ok(holdDecision.blocks.includes('r42_hold_active_or_unknown'));
const candidate={
  holdActive:false,queuePaused:false,lifecycleMode:'RUNNING_MANAGED',
  supervisor:{mode:'full',enabled:true,allowAutonomousSend:true,enforceHighMode:true},
  assignmentState:'queued',
};
assert.equal(authorizeAutonomousSend(candidate).allowed,true);
const unsafeDuring=authorizeAutonomousSend({...candidate,queuePaused:true,assignmentState:'dispatching'});
assert.equal(unsafeDuring.allowed,false);
const data=mkdtempSync(join(tmpdir(),'r41-r45-r50-fully-mocked-'));
const evidence={networkRequests:0,providerSends:0,assignmentsEnqueued:0,independentStartAttestations:0,independentCompletionAttestations:0,unknownPostAttempts:0};
function scenario({planId,unknownPost=false}){
  const taskId='one-finite-task';
  const idempotencyKey='r45:'+planId+':'+taskId;
  const p={
    id:planId,goal:'Offline end to end finite task evidence test',
    allowDispatch:true,maxParallel:1,
    agents:[{id:'test-engineer',chatId:'virtual-offline-chat',
      role:'QA',repository:'foto6/boss',branch:'agent/offline-fixture-only'}],
    tasks:[{id:taskId,agentId:'test-engineer',expectedHead:'a'.repeat(40),
      dependsOn:[],instruction:'EXECUTE NOW — SYNTHETIC OFFLINE TEST ONLY. Do not send any provider messages. Assert one approved assignment and CI attestation.',
      requireSupervisor:true}],
    brain:{enabled:false,autoAccept:false},
  };
  const rows=[];
  let attempts=0;
  const hooks={
    observe:async()=>({health:{state:'HEALTHY'},assignments:structuredClone(rows),status:{}}),
    api:async (_base,route,options={})=>{
      if(route==='/api/projects/control-plane/cutover-r42/status')
        return {cutoverState:{holdActive:false}};
      if(route==='/api/supervisor-watchdog/agent-assignments')
        return {assignments:structuredClone(rows)};
      if(route==='/api/supervisor-watchdog/managed-chats?inspect=1')
        return {chats:[{
          id:'virtual-offline-chat',status:'idle',openTabs:1,highMode:true,
          generating:false,draftPresent:false,providerLoadError:false,
          contextLimit:false,rotationPending:false,activeAssignmentCount:rows.length,
        }]};
      if(route==='/api/supervisor-watchdog/managed-chats/virtual-offline-chat/assignments'
        &&options.method==='POST'){
        attempts++;
        assert.equal(options.body.idempotencyKey,idempotencyKey);
        assert.equal(options.body.expectedHead,'a'.repeat(40));
        if(unknownPost){evidence.unknownPostAttempts++;throw Error('SYNTHETIC_TIMEOUT_UNKNOWN_EFFECT');}
        if(rows.length)throw Error('OFFLINE_DUPLICATE_POST_REJECTED');
        rows.push({id:'synthetic-assignment-'+planId,state:'queued',idempotencyKey,
          targetChatId:'virtual-offline-chat',dispatchSubmitAttempted:false,dispatchCount:0});
        evidence.assignmentsEnqueued++;
        return {id:rows[0].id};
      }
      throw Error('UNEXPECTED_OFFLINE_API:'+route);
    },
    attestStartHead:async()=>{evidence.independentStartAttestations++;return {ok:true,head:'a'.repeat(40)};},
    attestCompleted:async()=>{evidence.independentCompletionAttestations++;return {ok:true,currentHead:'b'.repeat(40),ciRunId:123};},
  };
  const r45State=join(data,planId+'.r45.json'),r41State=join(data,planId+'.r41.json');
  const conf={contract:CONTRACT,mode:'armed',operatorApproved:true,
    bridge:{url:'http://127.0.0.1:17448'},
    r45:{runner,plan:join(data,'synthetic-fixture.json'),state:r45State},
    maxSendsPerHour:12,minSpacingMs:90000,pollIntervalMs:60000};
  const build=()=>new PcAutonomySupervisor({
    config:conf,statePath:r41State,clock:()=>tickAt,
    probes:async()=>healthy(),
    runner:async({dispatch})=>tick({
      plan:p,stateFile:r45State,base:'http://127.0.0.1:17448',
      dispatch,brain:false,hooks,
    }),
  });
  return {build,p,rows,get attempts(){return attempts;},r41State,r45State};
}
try{
  const success=scenario({planId:'r41-offline-success'});
  const first=await success.build().cycle({dispatch:true});
  assert.equal(first.dispatchEnabled,true);
  assert.equal(first.decision.dispatched,1);
  assert.equal(first.decision.uncertainEffect,false);
  assert.equal(success.attempts,1);
  assert.equal(JSON.parse(readFileSync(success.r41State,'utf8')).pendingDispatch,null);
  tickAt+=1000;
  const tooSoon=await success.build().cycle({dispatch:true});
  assert.equal(tooSoon.dispatchEnabled,false);
  assert.ok(tooSoon.decision.blocks.includes('send_rate_budget'));
  assert.equal(success.attempts,1);
  tickAt+=100000;
  const alreadyQueued=await success.build().cycle({dispatch:true});
  assert.equal(alreadyQueued.decision.dispatched,0);
  assert.equal(success.attempts,1);
  success.rows[0].state='completed';
  Object.assign(success.rows[0],{
    currentHead:'b'.repeat(40),exactCommitSha:'b'.repeat(40),
    ciConclusion:'success',ciRunId:123,supervisorVerified:true,
  });
  tickAt+=100000;
  const accepted=await success.build().cycle({dispatch:true});
  assert.equal(accepted.decision.dispatched,0);
  assert.equal(success.attempts,1);
  assert.ok(evidence.independentCompletionAttestations>=1);
  assert.equal(JSON.parse(readFileSync(success.r45State,'utf8')).tasks['one-finite-task'].state,'ACCEPTED');
  const unknown=scenario({planId:'r41-offline-unknown',unknownPost:true});
  tickAt+=100000;
  const attempted=await unknown.build().cycle({dispatch:true});
  assert.equal(attempted.decision.uncertainEffect,true);
  assert.equal(attempted.unknownEffects,1);
  const original=JSON.parse(readFileSync(unknown.r41State,'utf8')).pendingDispatch.token;
  tickAt+=180000;
  const quarantined=await unknown.build().cycle({dispatch:true});
  assert.equal(quarantined.dispatchEnabled,false);
  assert.ok(quarantined.decision.blocks.includes('unresolved_dispatch_intent'));
  assert.equal(unknown.attempts,1);
  assert.equal(JSON.parse(readFileSync(unknown.r41State,'utf8')).pendingDispatch.token,original);
  // No real network route or provider adapter was accessed. Every API and
  // every Git/CI attestation in this rehearsal is an explicitly mocked hook.
  assert.equal(evidence.networkRequests,0);
  assert.equal(evidence.providerSends,0);
  assert.equal(evidence.assignmentsEnqueued,1);
  assert.equal(evidence.unknownPostAttempts,1);
  console.log(JSON.stringify({
    status:'R41_R45_R50_MOCKED_OFFLINE_E2E_PASS',sourceSha:'28e4accf59e37e767c37585b85cdacbdbac62120',
    r50GitBlob:blob,fullChainAccepted:true,duplicateSuppressed:true,
    crashRetryQuarantined:true,sendAuthorityRechecked:true,evidence,
    warning:'SYNTHETIC ONLY. NO REAL GITHUB ATTESTATION OR CHATGPT SEND.',
  }));
}finally{rmSync(data,{recursive:true,force:true});}
