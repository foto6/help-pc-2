'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {
  R23_SOURCE_SHA,
  evaluateLivePreflight,
  observation,
}=require('./live-preflight-r24');

function argValue(flag){
  const i=process.argv.indexOf(flag);
  return i>=0&&process.argv[i+1]?process.argv[i+1]:'';
}
function gitHead(){
  const r=spawnSync('git',['rev-parse','HEAD'],{
    cwd:__dirname,encoding:'utf8',windowsHide:true,
  });
  return r.status===0?String(r.stdout||'').trim():'';
}
function obs(source,data,state='PASS'){
  return observation({
    source,state,observedAt:'2026-10-01T12:00:00.000Z',budgetMs:500,
    reason:state==='PASS'?'fixture_pass':'fixture_'+state.toLowerCase(),data,
  });
}
function base(){
  return {
    collectedAt:'2026-10-01T12:00:00.000Z',
    budgets:{httpMs:500,cdpMs:750,osMs:1500,freshnessMs:5000,fileMs:1500},
    expectations:{
      pid:4242,port:17448,commandFingerprint:'a'.repeat(64),
      sourceSha:'b'.repeat(40),sourceBranch:'agent/live-bridge',
      configDigest:'c'.repeat(64),
    },
    observations:{
      processIdentity:obs('fixture process',{pid:4242,
        commandFingerprint:'a'.repeat(64),ambiguous:false}),
      sourceProvenance:obs('fixture source',{sha:'b'.repeat(40),branch:'agent/live-bridge'}),
      configProvenance:obs('fixture config',{digest:'c'.repeat(64)}),
      portOwnership:obs('fixture port',{port:17448,listening:true,ownerPid:4242,ambiguous:false}),
      status:obs('fixture status',{responded:true,latencyMs:5,budgetMs:500,
        summary:{controlPlaneResponsive:true,generatedFresh:true,
          operationalState:'OK',codeReloadRequired:false}}),
      health:obs('fixture health',{responded:true,latencyMs:4,budgetMs:500,
        summary:{checkedFresh:true,state:'OK',eventLoopState:'healthy',
          codeReloadRequired:false}}),
      queue:obs('fixture queue',{observable:true,quiescent:true,
        activeTaskCount:0,activeAssignmentCount:0,activeOutboxCount:0}),
      cdp:obs('fixture cdp',{required:true,profiles:[{
        profileId:'p1',responded:true,latencyMs:5,budgetMs:750,errorClass:'',
      }]}),
      durableState:obs('fixture state',{readable:true,valid:true,
        version:13,digest:'d'.repeat(64)}),
      r23Manifest:obs('fixture manifest',{valid:true,digest:'e'.repeat(64),
        sourceSha:R23_SOURCE_SHA}),
    },
  };
}
function scenario(name,mutate){
  const input=base();
  mutate?.(input);
  const result=evaluateLivePreflight(input);
  return {name,decision:result.decision,releaseGate:result.releaseGate,
    blockers:result.blockers,gates:result.gates.map(g=>({id:g.id,state:g.state,ok:g.ok}))};
}

const scenarios=[
  scenario('ready_fixture'),
  scenario('timeout',input=>{
    input.observations.status=obs('fixture status',{responded:false,
      latencyMs:500,budgetMs:500},'BLOCK');
  }),
  scenario('stale_status',input=>{
    input.observations.status=obs('fixture status',{responded:true,
      latencyMs:5,budgetMs:500,summary:{controlPlaneResponsive:true,
        generatedFresh:false,operationalState:'OK',codeReloadRequired:false}},'DEGRADED');
  }),
  scenario('ambiguous_pid',input=>{
    input.observations.processIdentity=obs('fixture process',{pid:4242,
      commandFingerprint:'a'.repeat(64),ambiguous:true},'UNKNOWN');
  }),
  scenario('pending_assignment',input=>{
    input.observations.queue=obs('fixture queue',{observable:true,quiescent:false,
      activeTaskCount:0,activeAssignmentCount:1,activeOutboxCount:0},'BLOCK');
  }),
  scenario('corrupt_state',input=>{
    input.observations.durableState=obs('fixture state',{readable:true,valid:false,
      version:null,digest:'d'.repeat(64)},'BLOCK');
  }),
  scenario('hung_cdp',input=>{
    input.observations.cdp=obs('fixture cdp',{required:true,profiles:[{
      profileId:'p1',responded:false,latencyMs:750,budgetMs:750,errorClass:'TIMEOUT',
    }]},'BLOCK');
  }),
  scenario('partial_observability',input=>{
    input.observations.configProvenance=observation({
      source:'fixture config',state:'UNKNOWN',
      observedAt:'2026-10-01T12:00:00.000Z',reason:'config_unobservable',
    });
  }),
];
assert.equal(scenarios[0].decision,'READY_FOR_EXPLICIT_CUTOVER');
for(const row of scenarios.slice(1)) assert.notEqual(row.decision,'READY_FOR_EXPLICIT_CUTOVER');

const artifact={
  object:'bridge.r24_live_preflight_fixture.v1',
  sourceSha:String(process.env.GITHUB_SHA||gitHead()||''),
  generatedAt:new Date().toISOString(),
  candidateR23SourceSha:R23_SOURCE_SHA,
  releaseGate:'NO_LIVE_DEPLOY',
  scenarios,
  liveBridgeTouched:false,
  mutationsPerformed:false,
};
const body=JSON.stringify(artifact,null,2)+'\n';
const out=argValue('--out');
if(out)fs.writeFileSync(path.resolve(process.cwd(),out),body,'utf8');
process.stdout.write(body);
