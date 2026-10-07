import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  R33_PREFLIGHT_V1,
  R33_READY,
} from "../src/r33-live-readonly-canary-preflight.js";
import {
  R37_OPERATOR_LIFECYCLE_V1,
  R37OperatorLifecycle,
} from "../src/r37-operator-lifecycle.js";
import {
  R39_CUTOVER_PLAN_V1,
  R39_ISOLATED_IDENTITY_V1,
  R39_LIFECYCLE_REHEARSAL_V1,
  R39_LOCAL_CANARY_V1,
  R39_READINESS_V1,
  R39_REBOOT_AUTOSTART_V1,
  buildR39CutoverPlan,
  buildR39IsolatedCanaryIdentity,
  buildR39RebootAutostartStage,
  evaluateR39Readiness,
  evaluateR39StagedCanary,
  validateR39LifecycleRehearsal,
  validateR39SourceLineage,
} from "../src/r39-local-canary.js";

function component(status="RUNNING",available=true,version="v1"){
  return {status,available,version};
}

function lifecycleStatus(overrides={}){
  return {
    contract_version:R37_OPERATOR_LIFECYCLE_V1,
    operator_state:"RUNNING",
    persisted_operator_state:"RUNNING",
    generation:1,
    observed_at_ms:1,
    components:{
      native_mcp_host:component(),
      control_service:component(),
      executor:{...component(),sha:"executor"},
      github_relay_fallback:{...component(),enabled:true,current_authority:true},
      direct_lane:component(),
    },
    direct_lane_available:true,
    reconciliation_required:false,
    reconciliation_request_ids:[],
    authority:{lane:"github_relay",sha:"authority",version:"v1"},
    automatic_side_effect_replay:false,
    live_pc_control_cutover:false,
    status_digest:"a".repeat(64),
    ...overrides,
  };
}

function r33Ready(overrides={}){
  return {
    contract_version:R33_PREFLIGHT_V1,
    state:R33_READY,
    blockers:[],
    current_authority:"github_relay",
    current_authority_changed:false,
    actual_read_only_canary_executed:false,
    read_only_canary_pass_claimed:false,
    actual_pc_control_cutover:false,
    side_effect_probe_count:0,
    automatic_replay_authorized:false,
    fallback_authorized:false,
    live_mutation_authorized:false,
    discovery:{},
    expected_source_profile:{},
    run_canary_command:"pwsh -NoProfile -File r32.ps1 -Action RunCanary",
    report_digest:"b".repeat(64),
    ...overrides,
  };
}

function lifecycleRehearsal(overrides={}){
  return {
    contract_version:R39_LIFECYCLE_REHEARSAL_V1,
    states:[
      "RUNNING","PAUSED","DRAINING","RECONCILIATION_REQUIRED","PAUSED","RUNNING","RUNNING",
    ],
    idempotent_resume:true,
    resume_blocked_during_reconciliation:true,
    clear_reconciliation_returns_paused:true,
    explicit_resume_required:true,
    automatic_side_effect_replay:false,
    github_relay_fallback_current_authority:true,
    production_cutover_performed:false,
    ...overrides,
  };
}

function tempIdentity(){
  const repo=mkdtempSync(join(tmpdir(),"r39-repo-"));
  const root=join(repo,".r39-canary","fixture");
  mkdirSync(root,{recursive:true});
  const identity=buildR39IsolatedCanaryIdentity({
    repoRoot:repo,
    canaryRoot:root,
    port:0,
    serviceIdentity:"native-mcp-r39-canary-fixture",
  });
  return {repo,root,identity,cleanup:()=>rmSync(repo,{recursive:true,force:true})};
}

test("R39 exact source lineage composes accepted R38 and keeps GitHub relay authority",()=>{
  const lineage=validateR39SourceLineage();
  assert.equal(lineage.contract_version,"native_mcp.source_lineage.r39.v1");
  assert.equal(lineage.r38_contract,"native_mcp.source_pin_recovery.r38.v1");
  assert.equal(lineage.r38_classification,"LEGITIMATE_ACCEPTED_SUCCESSOR_STALE_CONSUMER_PIN");
  assert.equal(lineage.accepted_ci.run_id,37405176472);
  assert.equal(lineage.accepted_ci.conclusion,"success");
  assert.equal(lineage.current_authority,"github_relay");
  assert.equal(lineage.automatic_side_effect_replay,false);
  assert.equal(lineage.production_cutover,false);
});

test("R39 source pin records exact task head and independently accepted parent CI",()=>{
  const pin=JSON.parse(readFileSync(
    new URL("../conformance/r39_local_canary/source-pin.json",import.meta.url),
    "utf8",
  ));
  assert.equal(pin.exact_task_head,"d8c7661d52670fe50e58bc68d50f59a624253e44");
  assert.equal(pin.accepted_parent.sha,"a0d8438f0e4fa93e6be50402efb6783f92c3412b");
  assert.equal(pin.accepted_parent.ci_run_id,37406258361);
  assert.equal(pin.accepted_parent.conclusion,"success");
  assert.equal(pin.inherited.current_authority,"github_relay");
  assert.equal(pin.inherited.automatic_side_effect_replay,false);
});

test("isolated identity is loopback-only and cannot represent production replacement",()=>{
  const t=tempIdentity();
  try{
    assert.equal(t.identity.contract_version,R39_ISOLATED_IDENTITY_V1);
    assert.equal(t.identity.bind_host,"127.0.0.1");
    assert.equal(t.identity.current_authority,"github_relay");
    assert.equal(t.identity.current_authority_changed,false);
    assert.equal(t.identity.service_registered,false);
    assert.equal(t.identity.task_registered,false);
    assert.equal(t.identity.firewall_changed,false);
    assert.equal(t.identity.tunnel_changed,false);
    assert.equal(t.identity.production_relay_replaced,false);
    assert.equal(t.identity.live_cutover_performed,false);
    assert.match(t.identity.identity_digest,/^[0-9a-f]{64}$/);
    assert.throws(()=>buildR39IsolatedCanaryIdentity({
      repoRoot:t.repo,
      canaryRoot:join(t.repo,"outside"),
      port:0,
      serviceIdentity:"native-mcp-r39-canary-bad",
    }),(e)=>e.code==="R39_CANARY_ROOT_NOT_ISOLATED");
  }finally{t.cleanup();}
});

test("R37 lifecycle semantics satisfy R39 exact transition rehearsal and explicit resume",()=>{
  const lifecycle=new R37OperatorLifecycle();
  const states=[lifecycle.snapshot().operator_state];
  states.push(lifecycle.pause("r39").operator_state);
  states.push(lifecycle.drain().operator_state);
  states.push(lifecycle.requireReconciliation("unknown-r39").operator_state);
  let blocked=false;
  try{lifecycle.resume();}catch(error){
    blocked=error.code==="R37_RECONCILIATION_REQUIRED"
      && error.details.automatic_replay===false;
  }
  states.push(lifecycle.clearReconciliation("unknown-r39").operator_state);
  states.push(lifecycle.resume().operator_state);
  const before=lifecycle.snapshot().generation;
  states.push(lifecycle.resume().operator_state);
  const after=lifecycle.snapshot().generation;
  const validated=validateR39LifecycleRehearsal({
    ...lifecycleRehearsal(),
    states,
    idempotent_resume:before===after,
    resume_blocked_during_reconciliation:blocked,
  });
  assert.equal(validated.status,"PASS");
  assert.deepEqual(validated.blockers,[]);
  assert.equal(validated.automatic_side_effect_replay,false);
});

test("lifecycle rehearsal rejects blind replay or missing explicit resume semantics",()=>{
  const bad=validateR39LifecycleRehearsal(lifecycleRehearsal({
    automatic_side_effect_replay:true,
    idempotent_resume:false,
    clear_reconciliation_returns_paused:false,
  }));
  assert.equal(bad.status,"BLOCKED");
  assert.ok(bad.blockers.some((b)=>b.code==="R39_AUTOMATIC_REPLAY_INVALID"));
  assert.ok(bad.blockers.some((b)=>b.code==="R39_RESUME_NOT_IDEMPOTENT"));
  assert.ok(bad.blockers.some((b)=>b.code==="R39_RECONCILIATION_CLEAR_NOT_PAUSED"));
});

test("source-only staged canary remains SOURCE_READY; coordinator execution can become READY for staging only",()=>{
  const t=tempIdentity();
  try{
    const common={
      r33Preflight:r33Ready(),
      lifecycleStatus:lifecycleStatus(),
      lifecycleRehearsal:lifecycleRehearsal(),
      canaryIdentity:t.identity,
      sourceLineage:validateR39SourceLineage(),
    };
    const source=evaluateR39StagedCanary({...common,actualCoordinatorRun:false});
    assert.equal(source.contract_version,R39_LOCAL_CANARY_V1);
    assert.equal(source.state,"SOURCE_READY");
    assert.equal(source.actual_read_only_canary_executed,false);
    assert.equal(source.actual_pc_control_cutover,false);
    const live=evaluateR39StagedCanary({...common,actualCoordinatorRun:true});
    assert.equal(live.state,"READY_FOR_STAGED_LOCAL_CANARY");
    assert.equal(live.current_authority,"github_relay");
    assert.equal(live.github_relay_fallback_enabled,true);
    assert.equal(live.side_effect_mirroring,false);
    assert.equal(live.automatic_side_effect_replay,false);
  }finally{t.cleanup();}
});

test("R39 blocks reconciliation or missing GitHub relay fallback",()=>{
  const t=tempIdentity();
  try{
    const reconciled=lifecycleStatus({
      reconciliation_required:true,
      operator_state:"RECONCILIATION_REQUIRED",
    });
    let result=evaluateR39StagedCanary({
      r33Preflight:r33Ready(),
      lifecycleStatus:reconciled,
      lifecycleRehearsal:lifecycleRehearsal(),
      canaryIdentity:t.identity,
      sourceLineage:validateR39SourceLineage(),
      actualCoordinatorRun:true,
    });
    assert.equal(result.state,"BLOCKED");
    assert.ok(result.blockers.some((b)=>b.code==="R39_RECONCILIATION_REQUIRED"));

    const fallback=lifecycleStatus();
    fallback.components.github_relay_fallback.available=false;
    result=evaluateR39StagedCanary({
      r33Preflight:r33Ready(),
      lifecycleStatus:fallback,
      lifecycleRehearsal:lifecycleRehearsal(),
      canaryIdentity:t.identity,
      sourceLineage:validateR39SourceLineage(),
      actualCoordinatorRun:true,
    });
    assert.equal(result.state,"BLOCKED");
    assert.ok(result.blockers.some((b)=>b.code==="R39_GITHUB_RELAY_FALLBACK_NOT_AVAILABLE"));
  }finally{t.cleanup();}
});

test("R39 cutover plan is generator-only and has no apply authority",()=>{
  const t=tempIdentity();
  try{
    const staged=evaluateR39StagedCanary({
      r33Preflight:r33Ready(),
      lifecycleStatus:lifecycleStatus(),
      lifecycleRehearsal:lifecycleRehearsal(),
      canaryIdentity:t.identity,
      sourceLineage:validateR39SourceLineage(),
      actualCoordinatorRun:true,
    });
    const plan=buildR39CutoverPlan({stagedCanary:staged,canaryIdentity:t.identity});
    assert.equal(plan.contract_version,R39_CUTOVER_PLAN_V1);
    assert.equal(plan.state,"PLAN_READY");
    assert.equal(plan.apply_authorized,false);
    assert.equal(plan.executable_cutover_action,null);
    assert.equal(plan.production_cutover_performed,false);
    assert.equal(plan.current_authority,"github_relay");
    assert.equal(plan.fallback_authority,"github_relay");
    assert.equal(plan.automatic_side_effect_replay,false);
  }finally{t.cleanup();}
});

test("R39 reboot/autostart contract is staged only and persists lifecycle safety",()=>{
  const t=tempIdentity();
  try{
    const stage=buildR39RebootAutostartStage({
      canaryIdentity:t.identity,
      startCommand:"pwsh -NoProfile -File tools/r32-local-canary-operator.ps1 -Action StartCandidate",
    });
    assert.equal(stage.contract_version,R39_REBOOT_AUTOSTART_V1);
    assert.equal(stage.state,"STAGED_NOT_INSTALLED");
    assert.equal(stage.registration.service_installed,false);
    assert.equal(stage.registration.scheduled_task_installed,false);
    assert.equal(stage.registration.startup_folder_modified,false);
    assert.equal(stage.registration.registry_run_key_modified,false);
    assert.equal(stage.reboot_semantics.paused_remains_paused,true);
    assert.equal(stage.reboot_semantics.draining_remains_draining,true);
    assert.equal(stage.reboot_semantics.reconciliation_required_remains_blocked,true);
    assert.equal(stage.reboot_semantics.explicit_resume_after_reconciliation_clear,true);
    assert.equal(stage.reboot_semantics.automatic_side_effect_replay,false);
    assert.equal(stage.rollback.command,null);
  }finally{t.cleanup();}
});

test("R39 exact-head readiness is SOURCE_READY until coordinator local stage is executed",()=>{
  const report=evaluateR39Readiness({
    sourceLineage:validateR39SourceLineage(),
    exactHead:"f".repeat(40),
    ciRunId:1,
    runnerOs:"test",
  });
  assert.equal(report.contract_version,R39_READINESS_V1);
  assert.equal(report.state,"SOURCE_READY");
  assert.equal(report.staged_canary_state,"NOT_EXECUTED_COORDINATOR_LIVE");
  assert.equal(report.reboot_autostart_state,"STAGED_NOT_INSTALLED");
  assert.equal(report.current_authority,"github_relay");
  assert.equal(report.actual_local_canary_executed,false);
  assert.equal(report.production_cutover,false);
});

test("one R39 status command reports all required lifecycle components, reconciliation and authority",()=>{
  const dir=mkdtempSync(join(tmpdir(),"r39-status-"));
  try{
    const stateFile=join(dir,"lifecycle.json");
    const result=spawnSync(process.execPath,[
      fileURLToPath(new URL("../tools/r39-local-canary.js",import.meta.url)),
      "status","--state-file",stateFile,
    ],{encoding:"utf8"});
    assert.equal(result.status,0,result.stderr);
    const status=JSON.parse(result.stdout);
    for(const name of ["native_mcp_host","control_service","executor","github_relay_fallback","direct_lane"]){
      assert.ok(status.components[name],name);
    }
    assert.equal(status.reconciliation_required,false);
    assert.equal(status.authority.lane,"github_relay");
    assert.equal(status.automatic_side_effect_replay,false);
    assert.equal(status.live_pc_control_cutover,false);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("R39 Windows operator composes R33/R32 but does not execute cutover, service, task, firewall or tunnel mutation",()=>{
  const source=readFileSync(new URL("../tools/r39-local-canary.ps1",import.meta.url),"utf8");
  assert.match(source,/r33-live-readonly-canary-preflight\.ps1/);
  assert.match(source,/r32-local-canary-operator\.ps1/);
  assert.match(source,/NOT_EXECUTED_BY_R39_WRAPPER/);
  assert.doesNotMatch(source,/Invoke-Expression|iex\b/i);
  assert.doesNotMatch(source,/Register-ScheduledTask|New-ScheduledTask|New-Service|Restart-Service|Stop-Service|Start-Service|New-NetFirewallRule|netsh|cloudflared|ngrok/i);
  assert.doesNotMatch(source,/taskkill|Stop-Process[^\n]*(github_relay|bridge|mcp)/i);
});
