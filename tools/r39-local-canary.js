#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  JsonR37OperatorLifecycleStore,
  R37OperatorLifecycle,
} from "../src/r37-operator-lifecycle.js";
import {
  R39_LIFECYCLE_REHEARSAL_V1,
  buildR39CutoverPlan,
  buildR39IsolatedCanaryIdentity,
  buildR39RebootAutostartStage,
  evaluateR39Readiness,
  evaluateR39StagedCanary,
  validateR39SourceLineage,
} from "../src/r39-local-canary.js";

function arg(flag, fallback=null){
  const i=process.argv.indexOf(flag);
  return i>=0 && process.argv[i+1] ? process.argv[i+1] : fallback;
}
function requireArg(flag){
  const v=arg(flag);
  if(!v) throw new Error(`${flag} is required`);
  return v;
}
function readJson(path){ return JSON.parse(readFileSync(resolve(path),"utf8")); }
function writeJson(path,value){
  writeFileSync(resolve(path),JSON.stringify(value,null,2)+"\n",{encoding:"utf8",mode:0o600});
}
function component(status="RUNNING",available=true,version="r39-fixture"){
  return {status,available,version};
}
function lifecycleProbes(){
  return {
    nativeMcpHost:async()=>component("RUNNING",true,"native-mcp"),
    controlService:async()=>component("RUNNING",true,"control"),
    executor:async()=>({...component("RUNNING",true,"executor"),sha:"isolated-r39"}),
    githubRelayFallback:async()=>component("RUNNING",true,"github-relay"),
    directLane:async()=>component("RUNNING",true,"direct-candidate"),
    reconciliation:async()=>({required:false}),
  };
}

const command=process.argv[2]??"status";
const stateFile=resolve(arg("--state-file",".r39-canary/operator-lifecycle-r37.json"));
function makeLifecycle(){
  return new R37OperatorLifecycle({
    store:new JsonR37OperatorLifecycleStore(stateFile),
    probes:lifecycleProbes(),
  });
}

if(command==="lifecycle-rehearsal"){
  const lifecycle=makeLifecycle();
  const out=requireArg("--out");
  const states=[lifecycle.snapshot().operator_state];
  states.push(lifecycle.pause("r39_rehearsal").operator_state);
  states.push(lifecycle.drain().operator_state);
  states.push(lifecycle.requireReconciliation("r39-unknown-fixture").operator_state);
  let blocked=false;
  try{ lifecycle.resume(); }catch(error){ blocked=error?.code==="R37_RECONCILIATION_REQUIRED"; }
  states.push(lifecycle.clearReconciliation("r39-unknown-fixture").operator_state);
  states.push(lifecycle.resume().operator_state);
  const before=lifecycle.snapshot().generation;
  states.push(lifecycle.resume().operator_state);
  const after=lifecycle.snapshot().generation;
  const evidence={
    contract_version:R39_LIFECYCLE_REHEARSAL_V1,
    states,
    idempotent_resume:before===after,
    resume_blocked_during_reconciliation:blocked,
    clear_reconciliation_returns_paused:states[4]==="PAUSED",
    explicit_resume_required:true,
    automatic_side_effect_replay:false,
    github_relay_fallback_current_authority:true,
    production_cutover_performed:false,
  };
  writeJson(out,evidence);
  process.stdout.write(JSON.stringify(evidence)+"\n");
}else if(command==="status"){
  const lifecycle=makeLifecycle();
  const status=await lifecycle.status();
  process.stdout.write(JSON.stringify(status,null,2)+"\n");
}else if(command==="resume"){
  const lifecycle=makeLifecycle();
  const resumed=lifecycle.resume();
  process.stdout.write(JSON.stringify(resumed,null,2)+"\n");
}else if(command==="identity"){
  const identity=buildR39IsolatedCanaryIdentity({
    repoRoot:requireArg("--repo-root"),
    canaryRoot:requireArg("--canary-root"),
    port:Number.parseInt(arg("--port","0"),10),
    serviceIdentity:requireArg("--service-identity"),
    lifecycleStateFile:stateFile,
  });
  writeJson(requireArg("--out"),identity);
  process.stdout.write(JSON.stringify(identity)+"\n");
}else if(command==="evaluate"){
  const staged=evaluateR39StagedCanary({
    r33Preflight:readJson(requireArg("--preflight")),
    lifecycleStatus:readJson(requireArg("--lifecycle-status")),
    lifecycleRehearsal:readJson(requireArg("--lifecycle-rehearsal")),
    canaryIdentity:readJson(requireArg("--identity")),
    sourceLineage:validateR39SourceLineage(),
    actualCoordinatorRun:process.argv.includes("--actual-coordinator-run"),
  });
  writeJson(requireArg("--out"),staged);
  process.stdout.write(JSON.stringify({state:staged.state,blockers:staged.blockers})+"\n");
}else if(command==="cutover-plan"){
  const staged=readJson(requireArg("--staged-canary"));
  const identity=readJson(requireArg("--identity"));
  const plan=buildR39CutoverPlan({stagedCanary:staged,canaryIdentity:identity});
  writeJson(requireArg("--out"),plan);
  process.stdout.write(JSON.stringify({state:plan.state,apply_authorized:plan.apply_authorized})+"\n");
}else if(command==="reboot-stage"){
  const identity=readJson(requireArg("--identity"));
  const stage=buildR39RebootAutostartStage({
    canaryIdentity:identity,
    startCommand:requireArg("--start-command"),
  });
  writeJson(requireArg("--out"),stage);
  process.stdout.write(JSON.stringify({state:stage.state,registration:stage.registration})+"\n");
}else if(command==="readiness"){
  const report=evaluateR39Readiness({
    sourceLineage:validateR39SourceLineage(),
    stagedCanary:arg("--staged-canary")?readJson(arg("--staged-canary")):null,
    cutoverPlan:arg("--cutover-plan")?readJson(arg("--cutover-plan")):null,
    rebootStage:arg("--reboot-stage")?readJson(arg("--reboot-stage")):null,
    exactHead:arg("--source-sha"),
    ciRunId:arg("--ci-run-id")?Number(arg("--ci-run-id")):null,
    runnerOs:arg("--runner-os"),
  });
  writeJson(requireArg("--out"),report);
  process.stdout.write(JSON.stringify({state:report.state,blockers:report.blockers})+"\n");
}else{
  throw new Error("command must be one of: lifecycle-rehearsal, status, resume, identity, evaluate, cutover-plan, reboot-stage, readiness");
}
