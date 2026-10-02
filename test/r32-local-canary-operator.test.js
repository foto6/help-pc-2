import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  R32_AUTHORITY_SNAPSHOT_V1,
  R32_CANDIDATE_DESCRIPTOR_V1,
  assertR32SafeCanaryTools,
  buildR32AuthoritySnapshot,
  buildR32CanaryEvidence,
  compareR32AuthorityCandidate,
  evaluateR32Readiness,
  r32SourceAuthorityProfile,
  validateR32CandidateDescriptor,
} from "../src/r32-local-canary-operator.js";
import { PC_CONTROL_PLUGIN_SURFACE_V1 } from "../src/pc-control-direct-candidate.js";

function healthyWatchdog(overrides = {}) {
  return {
    status_version: "pc_relay.watchdog_status.v1",
    state: "HEALTHY",
    observed_at_unix: 1800000000,
    process: {
      matching_pids: [4242],
      logical_roots: [4242],
      logical_process_count: 1,
      health_pid: 4242,
      health_pid_observed: true,
    },
    observations: {
      local_head: "a".repeat(40),
      remote_tracking_head: "a".repeat(40),
      head_relation: "equal",
      remote_tracking_queue: { request_count: 10, result_count: 10, backlog_count: 0 },
      remote_observation_source: "local_remote_tracking_ref_no_network",
    },
    stale_reasons: [],
    health: {
      reconciliation_required: false,
      last_error: null,
    },
    error: null,
    recovery: {
      automatic_restart: false,
      automatic_kill: false,
      automatic_side_effect_replay: false,
      preserve_state_dir: ".pc-relay/state",
      preserve_outcome_journal: ".pc-relay/outcomes.jsonl",
      unknown_side_effect_requires_outcome_lookup: true,
    },
    ...overrides,
  };
}

function candidateFromProfile(snapshot, overrides = {}) {
  const p=snapshot.source_profile;
  return {
    contract_version: PC_CONTROL_PLUGIN_SURFACE_V1,
    source_lane: "direct_mcp_candidate",
    observed_at_ms: 1800000000000,
    health: {
      status: snapshot.live_health.status,
      reason: "fixture",
      latency_ms: 5,
      transport_connected: true,
      queue_progressing: true,
      executor_responsive: true,
    },
    capabilities: {
      protocol_version: "pc.native.control.v1",
      native_registry_digest: p.native_registry_digest,
      executor_digest: "e".repeat(64),
      compatibility_registry_digest: p.compatibility_registry_digest,
      protected_path_policy: p.protected_path_policy,
      explicit_side_effect_request_id_required: true,
      reconciliation_status: "reconciliation_required",
      automatic_replay: false,
    },
    tools: p.tools.map((tool) => ({
      name: tool.name,
      effect: tool.effect,
      available: true,
      input_schema_digest: tool.schema_digest,
    })),
    tool_surface_digest: "f".repeat(64),
    ...overrides,
  };
}

function descriptor(overrides={}) {
  return {
    contract_version:R32_CANDIDATE_DESCRIPTOR_V1,
    instance_id:"fixture-instance",
    pid:4243,
    bind_host:"127.0.0.1",
    mcp_endpoint:"http://127.0.0.1:17499/mcp",
    health_endpoint:"http://127.0.0.1:17499/healthz",
    state_dir:"C:\\tmp\\r32-state",
    token_file:"C:\\tmp\\r32-token.txt",
    isolated_state:true,
    current_authority:"github_relay",
    current_authority_changed:false,
    service_or_task_registered:false,
    firewall_or_tunnel_changed:false,
    live_cutover_performed:false,
    started_at:"2026-10-02T00:00:00.000Z",
    ...overrides,
  };
}

function r31Canary() {
  return {
    contract_version:"pc.control.direct_canary_evidence.v1",
    evidence_origin:"live_explicit_read_only_canary",
    status:"PASS",
    started_at_ms:1,
    completed_at_ms:2,
    side_effect_calls:0,
    replay_authorized:false,
    surface_digest:"f".repeat(64),
    capability_registry_digest:"a",
    executor_digest:"b",
    health_status:"HEALTHY",
    health_latency_ms:5,
    calls:[
      {tool:"device.ping",effect:"read_only",status:"completed",latency_ms:1,request_id_present:false,result_digest:"a".repeat(64)},
      {tool:"device.info",effect:"read_only",status:"completed",latency_ms:1,request_id_present:false,result_digest:"b".repeat(64)},
    ],
  };
}

test("source authority profile exposes registry, protected policy, effects and schema digests without results", () => {
  const profile=r32SourceAuthorityProfile();
  assert.match(profile.native_registry_digest,/^[0-9a-f]{64}$/);
  assert.match(profile.compatibility_registry_digest,/^[0-9a-f]{64}$/);
  assert.equal(profile.protected_path_policy,"pc.native.facade.protected_path_fail_closed.v1");
  assert.equal(profile.automatic_replay,false);
  assert.ok(profile.tools.length > 80);
  assert.ok(profile.tools.some((t)=>t.name==="device.ping" && t.effect==="read_only"));
  assert.ok(profile.tools.some((t)=>t.name==="file.write" && t.effect==="side_effect"));
  assert.ok(profile.tools.every((t)=>/^[0-9a-f]{64}$/.test(t.schema_digest)));
});

test("healthy GitHub-relay watchdog becomes a sanitized authority snapshot", () => {
  const snapshot=buildR32AuthoritySnapshot({watchdogStatus:healthyWatchdog(),probeLatencyMs:12.5,observedAtMs:10});
  assert.equal(snapshot.contract_version,R32_AUTHORITY_SNAPSHOT_V1);
  assert.equal(snapshot.current_authority,true);
  assert.equal(snapshot.live_health.status,"HEALTHY");
  assert.equal(snapshot.safe_for_comparison,true);
  assert.equal(snapshot.raw_results_included,false);
  assert.equal(snapshot.credentials_included,false);
  assert.match(snapshot.snapshot_digest,/^[0-9a-f]{64}$/);
});

test("stale, duplicate, unknown and reconciliation authority evidence never becomes comparison-ready", () => {
  const cases=[
    healthyWatchdog({state:"STALE"}),
    healthyWatchdog({state:"DUPLICATE_AMBIGUOUS"}),
    healthyWatchdog({status_version:"unknown"}),
    healthyWatchdog({health:{reconciliation_required:true}}),
  ];
  for(const watchdog of cases){
    const snapshot=buildR32AuthoritySnapshot({watchdogStatus:watchdog});
    assert.equal(snapshot.safe_for_comparison,false);
    assert.ok(snapshot.blockers.length>0);
  }
});

test("surface comparison fails closed on registry, protected policy, effect or schema mismatch", () => {
  const authority=buildR32AuthoritySnapshot({watchdogStatus:healthyWatchdog()});
  assert.equal(compareR32AuthorityCandidate(authority,candidateFromProfile(authority)).compatible,true);

  const registry=candidateFromProfile(authority);
  registry.capabilities.native_registry_digest="0".repeat(64);
  assert.ok(compareR32AuthorityCandidate(authority,registry).blockers.some((b)=>b.code==="REGISTRY_DIGEST_MISMATCH"));

  const protectedMismatch=candidateFromProfile(authority);
  protectedMismatch.capabilities.protected_path_policy="drift";
  assert.ok(compareR32AuthorityCandidate(authority,protectedMismatch).blockers.some((b)=>b.code==="PROTECTED_PATH_POLICY_MISMATCH"));

  const effect=candidateFromProfile(authority);
  effect.tools[0]={...effect.tools[0],effect:effect.tools[0].effect==="read_only"?"side_effect":"read_only"};
  assert.ok(compareR32AuthorityCandidate(authority,effect).blockers.some((b)=>b.code==="TOOL_EFFECT_MISMATCH"));

  const schema=candidateFromProfile(authority);
  schema.tools[0]={...schema.tools[0],input_schema_digest:"1".repeat(64)};
  assert.ok(compareR32AuthorityCandidate(authority,schema).blockers.some((b)=>b.code==="TOOL_SCHEMA_MISMATCH"));
});

test("successful ping+info live canary can prove executor responsiveness after pre-canary DEGRADED health", () => {
  const authority=buildR32AuthoritySnapshot({watchdogStatus:healthyWatchdog()});
  const candidate=candidateFromProfile(authority);
  candidate.health={...candidate.health,status:"DEGRADED",transport_connected:true,queue_progressing:true,executor_responsive:false};

  const before=compareR32AuthorityCandidate(authority,candidate);
  assert.ok(before.blockers.some((b)=>b.code==="HEALTH_STATUS_MISMATCH"));
  assert.ok(before.blockers.some((b)=>b.code==="CANDIDATE_TRANSPORT_NOT_READY"));

  const after=compareR32AuthorityCandidate(authority,candidate,{candidateCanaryEvidence:r31Canary()});
  assert.equal(after.compatible,true);
  assert.equal(after.executor_responsiveness_proven_by_read_only_canary,true);

  const failed=r31Canary();
  failed.calls[0]={...failed.calls[0],status:"error"};
  const rejected=compareR32AuthorityCandidate(authority,candidate,{candidateCanaryEvidence:failed});
  assert.equal(rejected.compatible,false);
});

test("R32 canary allowlist refuses side effects and non-approved read-only tools", () => {
  const authority=buildR32AuthoritySnapshot({watchdogStatus:healthyWatchdog()});
  const candidate=candidateFromProfile(authority);
  assert.equal(assertR32SafeCanaryTools(candidate,["device.ping","device.info"]),true);
  assert.throws(()=>assertR32SafeCanaryTools(candidate,["file.write"]),(e)=>e.code==="R32_CANARY_TOOL_NOT_ALLOWED");
  assert.throws(()=>assertR32SafeCanaryTools(candidate,["file.read"]),(e)=>e.code==="R32_CANARY_TOOL_NOT_ALLOWED");
});

test("synthetic evidence can never self-promote beyond SOURCE_READY", () => {
  const authority=buildR32AuthoritySnapshot({watchdogStatus:healthyWatchdog()});
  const candidate=candidateFromProfile(authority);
  const evidence=buildR32CanaryEvidence({
    authoritySnapshot:authority,
    candidateSurface:candidate,
    candidateCanaryEvidence:r31Canary(),
    initializeStatus:"PASS",
    evidenceOrigin:"synthetic_ci",
    actualCoordinatorRun:false,
    candidateDescriptor:descriptor(),
  });
  assert.equal(evidence.state,"SOURCE_READY");
  assert.equal(evidence.synthetic_evidence,true);
  assert.equal(evidence.side_effect_calls,0);
  assert.equal(evidence.replay_authorized,false);
  assert.equal(evaluateR32Readiness({sourceReady:true,canaryEvidence:evidence}).state,"SOURCE_READY");
});

test("only actual coordinator live evidence can become READ_ONLY_CANARY_PASS and still never cuts over", () => {
  const authority=buildR32AuthoritySnapshot({watchdogStatus:healthyWatchdog()});
  const candidate=candidateFromProfile(authority);
  const evidence=buildR32CanaryEvidence({
    authoritySnapshot:authority,
    candidateSurface:candidate,
    candidateCanaryEvidence:r31Canary(),
    initializeStatus:"PASS",
    evidenceOrigin:"coordinator_live_read_only_canary",
    actualCoordinatorRun:true,
    candidateDescriptor:descriptor(),
  });
  assert.equal(evidence.state,"READ_ONLY_CANARY_PASS");
  const ready=evaluateR32Readiness({sourceReady:true,canaryEvidence:evidence});
  assert.equal(ready.state,"READ_ONLY_CANARY_PASS");
  assert.equal(ready.actual_pc_control_cutover,false);
  const candidateReady=evaluateR32Readiness({sourceReady:true,canaryEvidence:evidence,explicitPluginCandidateReview:true});
  assert.equal(candidateReady.state,"READY_FOR_EXPLICIT_PLUGIN_CANDIDATE");
  assert.equal(candidateReady.actual_pc_control_cutover,false);
});

test("invalid isolation identity blocks live canary promotion", () => {
  const authority=buildR32AuthoritySnapshot({watchdogStatus:healthyWatchdog()});
  const evidence=buildR32CanaryEvidence({
    authoritySnapshot:authority,
    candidateSurface:candidateFromProfile(authority),
    candidateCanaryEvidence:r31Canary(),
    evidenceOrigin:"coordinator_live_read_only_canary",
    actualCoordinatorRun:true,
    candidateDescriptor:descriptor({bind_host:"0.0.0.0"}),
  });
  assert.equal(evidence.state,"BLOCKED");
  assert.ok(evidence.blockers.some((b)=>b.code==="ISOLATED_CANDIDATE_IDENTITY_INVALID"));
  assert.equal(validateR32CandidateDescriptor(descriptor()),true);
  assert.equal(validateR32CandidateDescriptor(descriptor({service_or_task_registered:true})),false);
});

test("PowerShell operator cleanup is candidate-specific and contains no service/firewall/tunnel mutation", () => {
  const source=readFileSync(new URL("../tools/r32-local-canary-operator.ps1",import.meta.url),"utf8");
  assert.match(source,/r32-isolated-candidate\.js/);
  assert.match(source,/\$maxWatchdogAttempts\s*=\s*5/);
  assert.match(source,/state -ne "PROCESS_EXISTS"/);
  assert.match(source,/Start-Sleep -Milliseconds 250/);
  assert.match(source,/Stop-Process -Id \$pidValue/);
  assert.match(source,/refusing cleanup: PID is not the exact isolated R32 candidate/);
  assert.doesNotMatch(source,/Register-ScheduledTask|New-ScheduledTask|New-Service|Restart-Service|Stop-Service|netsh|New-NetFirewallRule|ssh -R|cloudflared|ngrok/i);
  assert.doesNotMatch(source,/Stop-Process[^\n]*github_relay|taskkill/i);
});

test("R32 CI readiness template is SOURCE_READY and explicitly not a live canary", () => {
  const template=JSON.parse(readFileSync(new URL("../conformance/r32_local_canary/readiness.template.json",import.meta.url),"utf8"));
  assert.equal(template.state,"SOURCE_READY");
  assert.equal(template.live_canary_artifact_present,false);
  assert.equal(template.read_only_canary_state,"NOT_EXECUTED_COORDINATOR_LIVE");
  assert.equal(template.actual_pc_control_cutover,false);
  assert.equal(template.current_working_path_changed,false);
  assert.equal(template.safety.side_effect_canary_calls,0);
  assert.equal(template.safety.automatic_replay,false);
});
