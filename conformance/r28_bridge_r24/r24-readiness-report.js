'use strict';

const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');

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
function readJson(file){
  try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}
}

const fixture=readJson(path.resolve(
  process.cwd(),argValue('--fixture')||'r24-live-preflight-fixture.json'));
const sourceSha=String(process.env.GITHUB_SHA||process.env.R24_SOURCE_SHA||gitHead()||'').trim();
const report={
  object:'bridge.r24_readiness_report',
  sourceSha,
  sourceBranch:String(process.env.GITHUB_REF_NAME
    ||'agent/bridge-r24-live-preflight-20261001'),
  workflowRunId:String(process.env.GITHUB_RUN_ID||'local'),
  workflowRunAttempt:String(process.env.GITHUB_RUN_ATTEMPT||'1'),
  runnerOs:String(process.env.RUNNER_OS||process.platform),
  generatedAt:new Date().toISOString(),
  baselineSha:'dac4dd0edd35cdbf96d5c03344acd94f899a6aba',
  validationCommand:'npm run validate:r24',
  focusedTests:'npm run test:r24',
  fullTests:'npm test',
  deterministicFixtureArtifact:fixture,
  knownBlockers:[],
  releaseGate:'NO_LIVE_DEPLOY',
  releaseGateReason:'R24 only collects read-only live evidence. Explicit coordinator cutover authority is separate and no live mutation is authorized by this report.',
  collectorSafety:{
    allowedHttpMethods:['GET'],
    writesLiveFiles:false,
    killsProcesses:false,
    restartsProcesses:false,
    createsTabs:false,
    createsChats:false,
    dispatchesAssignments:false,
    migratesState:false,
    exposesSecrets:false,
  },
};
const body=JSON.stringify(report,null,2)+'\n';
const out=argValue('--out');
if(out){
  const target=path.resolve(process.cwd(),out);
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.writeFileSync(target,body,'utf8');
}
process.stdout.write(body);
