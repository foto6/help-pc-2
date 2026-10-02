import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildR32AuthoritySnapshot,
  r32SourceAuthorityProfile,
} from "../src/r32-local-canary-operator.js";
import {
  R33_DISCOVERY_V1,
  R33_NATIVE_RELAY_PROBE_V1,
  R33_READY,
  R33_BLOCKED,
  R33_BLOCKERS,
  buildR33RunCanaryCommand,
  evaluateR33Preflight,
  loadR33SourcePin,
} from "../src/r33-live-readonly-canary-preflight.js";
import { digestJson as relayDigestJson } from "../src/native-relay-protocol.js";

function healthyWatchdog(overrides={}) {
  const base={
    status_version:"pc_relay.watchdog_status.v1",
    state:"HEALTHY",
    observed_at_unix:1800000000,
    process:{
      matching_pids:[4000,4001],
      logical_roots:[4000],
      logical_process_count:1,
      health_pid:4001,
      health_pid_observed:true,
    },
    observations:{
      local_head:"a".repeat(40),
      remote_tracking_head:"a".repeat(40),
      head_relation:"equal",
      remote_tracking_queue:{request_count:10,result_count:10,backlog_count:0},
      remote_observation_source:"local_remote_tracking_ref_no_network",
    },
    stale_reasons:[],
    health:{reconciliation_required:false,last_error:null},
    error:null,
    recovery:{
      automatic_restart:false,
      automatic_kill:false,
      automatic_side_effect_replay:false,
      preserve_state_dir:".pc-relay/state",
      preserve_outcome_journal:".pc-relay/outcomes.jsonl",
      unknown_side_effect_requires_outcome_lookup:true,
    },
  };
  return {...base,...overrides};
}

function device(overrides={}) {
  const capabilities={
    protocol_version:"pc.native.control.v1",
    registry_digest:r32SourceAuthorityProfile().native_registry_digest,
    executor:{digest:"e".repeat(64),actions:["health.get","device.info"]},
  };
  return {
    device_id:"fixture-device",
    credential_generation:7,
    status:"active",
    online:true,
    last_session_epoch:"epoch-r33",
    last_seen_at_ms:1800000000000,
    capabilities_digest:relayDigestJson(capabilities),
    capabilities,
    limits:{},
    metadata:{},
    ...overrides,
  };
}

function discovery(overrides={}) {
  const authority=buildR32AuthoritySnapshot({
    watchdogStatus:healthyWatchdog(),
    probeLatencyMs:10,
    observedAtMs:1800000000000,
  });
  return {
    contract_version:R33_DISCOVERY_V1,
    observed_at:"2026-10-02T00:00:00.000Z",
    relay_checkout:"C:\\relay",
    relay_process:{
      logical_process_count:1,
      runtime_pid:4001,
      parent_pid:4000,
      observed_matching_process_count:2,
    },
    authority_snapshot:authority,
    native_relay:{
      origin:"http://127.0.0.1:17460",
      probe:{
        contract_version:R33_NATIVE_RELAY_PROBE_V1,
        observed_at:"2026-10-02T00:00:00.000Z",
        health:{
          status:"ok",
          running:true,
          process_alive:true,
          transport_connected:true,
          queue_progressing:true,
          executor_responsive:true,
          pending_deliveries:0,
          oldest_pending_age_ms:0,
          stalest_pending_progress_age_ms:0,
          online_devices:1,
        },
        devices:[device()],
      },
      probe_error_classification:null,
    },
    credential_path:"C:\\secure\\native-relay-token.txt",
    native_device_id:"fixture-device",
    native_desktop_id:"desktop-A",
    secret_bytes_persisted:false,
    raw_command_lines_persisted:false,
    process_environment_scraped:false,
    port_scan_performed:false,
    side_effect_probe_count:0,
    current_authority_changed:false,
    ...overrides,
  };
}

test("exact source pin binds R33 to green R32 head",()=>{
  const pin=loadR33SourcePin();
  assert.equal(pin.exact_start_sha,"b235e319a2afe049a708d48329cc6d80d988256f");
  assert.equal(pin.exact_start_ci.run_id,36993946760);
  assert.equal(pin.exact_start_ci.conclusion,"success");
  assert.equal(pin.inherited.current_authority,"github_relay");
});

test("exact healthy live-shaped evidence reaches READY_FOR_COORDINATOR_CANARY only",()=>{
  const result=evaluateR33Preflight(discovery(),{
    repoRoot:"C:\\help-pc-2",
    outputDir:"C:\\help-pc-2\\.r33-canary\\run",
  });
  assert.equal(result.state,R33_READY);
  assert.deepEqual(result.blockers,[]);
  assert.equal(result.actual_read_only_canary_executed,false);
  assert.equal(result.read_only_canary_pass_claimed,false);
  assert.equal(result.actual_pc_control_cutover,false);
  assert.equal(result.side_effect_probe_count,0);
  assert.equal(result.automatic_replay_authorized,false);
  assert.equal(result.fallback_authorized,false);
  assert.match(result.run_canary_command,/RunCanary/);
  assert.match(result.run_canary_command,/ExplicitLiveReadOnlyCanary/);
  assert.match(result.run_canary_command,/native-relay-token\.txt/);
  assert.doesNotMatch(result.run_canary_command,/Bearer|token-secret|Authorization/i);
});

test("missing credential path emits exact BLOCKED_MISSING_CREDENTIAL_PATH and no command",()=>{
  const input=discovery({credential_path:null});
  input.native_relay={origin:"http://127.0.0.1:17460",probe:null,probe_error_classification:null};
  const result=evaluateR33Preflight(input,{repoRoot:"C:\\help-pc-2"});
  assert.equal(result.state,R33_BLOCKED);
  assert.ok(result.blockers.some((b)=>b.code===R33_BLOCKERS.MISSING_CREDENTIAL_PATH));
  assert.equal(result.run_canary_command,null);
});

test("authority health, reconciliation, head drift and stale queue all block",()=>{
  const cases=[
    ["health", healthyWatchdog({state:"STALE"}), R33_BLOCKERS.AUTHORITY_NOT_HEALTHY],
    ["reconcile", healthyWatchdog({health:{reconciliation_required:true}}), R33_BLOCKERS.AUTHORITY_RECONCILIATION_REQUIRED],
    ["head", healthyWatchdog({observations:{
      local_head:"a".repeat(40),remote_tracking_head:"b".repeat(40),head_relation:"local_behind_remote",
      remote_tracking_queue:{request_count:10,result_count:10,backlog_count:0},
      remote_observation_source:"local_remote_tracking_ref_no_network",
    }}), R33_BLOCKERS.AUTHORITY_HEAD_RELATION],
    ["stale", healthyWatchdog({stale_reasons:["remote_backlog_advanced_without_completed_cycle"]}), R33_BLOCKERS.AUTHORITY_STALE_QUEUE],
  ];
  for(const [name,watchdog,code] of cases){
    const input=discovery();
    input.authority_snapshot=buildR32AuthoritySnapshot({watchdogStatus:watchdog,probeLatencyMs:10});
    const result=evaluateR33Preflight(input,{repoRoot:"C:\\help-pc-2"});
    assert.equal(result.state,R33_BLOCKED,name);
    assert.ok(result.blockers.some((b)=>b.code===code),name);
    assert.equal(result.run_canary_command,null,name);
  }
});

test("exact registry/schema/protected policy source profile is required",()=>{
  const drifts=[
    (s)=>{s.source_profile.native_registry_digest="0".repeat(64);},
    (s)=>{s.source_profile.compatibility_registry_digest="1".repeat(64);},
    (s)=>{s.source_profile.protected_path_policy="wrong";},
    (s)=>{s.source_profile.tools[0].schema_digest="2".repeat(64);},
  ];
  for(const mutate of drifts){
    const input=discovery();
    mutate(input.authority_snapshot);
    const result=evaluateR33Preflight(input,{repoRoot:"C:\\help-pc-2"});
    assert.equal(result.state,R33_BLOCKED);
    assert.ok(result.blockers.some((b)=>[
      R33_BLOCKERS.SOURCE_PROFILE_DRIFT,
      R33_BLOCKERS.PROTECTED_POLICY_DRIFT,
    ].includes(b.code)));
  }
});

test("native relay must be loopback, healthy, progressing and executor responsive",()=>{
  const unsafe=discovery();
  unsafe.native_relay.origin="http://192.168.1.10:17460";
  let result=evaluateR33Preflight(unsafe,{repoRoot:"C:\\help-pc-2"});
  assert.ok(result.blockers.some((b)=>b.code===R33_BLOCKERS.NATIVE_RELAY_ORIGIN_UNSAFE));

  const unhealthy=discovery();
  unhealthy.native_relay.probe.health.queue_progressing=false;
  unhealthy.native_relay.probe.health.status="degraded";
  result=evaluateR33Preflight(unhealthy,{repoRoot:"C:\\help-pc-2"});
  assert.ok(result.blockers.some((b)=>b.code===R33_BLOCKERS.NATIVE_RELAY_UNHEALTHY));
});

test("device discovery blocks ambiguous, offline and capability-digest drift",()=>{
  const ambiguous=discovery({native_device_id:null});
  ambiguous.native_relay.probe.devices=[device({device_id:"one"}),device({device_id:"two"})];
  let result=evaluateR33Preflight(ambiguous,{repoRoot:"C:\\help-pc-2"});
  assert.ok(result.blockers.some((b)=>b.code===R33_BLOCKERS.DEVICE_IDENTITY_AMBIGUOUS));

  const offline=discovery();
  offline.native_relay.probe.devices=[device({online:false})];
  result=evaluateR33Preflight(offline,{repoRoot:"C:\\help-pc-2"});
  assert.ok(result.blockers.some((b)=>b.code===R33_BLOCKERS.DEVICE_OFFLINE));

  const drift=discovery();
  drift.native_relay.probe.devices=[device({capabilities_digest:"f".repeat(64)})];
  result=evaluateR33Preflight(drift,{repoRoot:"C:\\help-pc-2"});
  assert.ok(result.blockers.some((b)=>b.code===R33_BLOCKERS.DEVICE_CAPABILITY_DIGEST));
});

test("relay checkout/process ambiguity fails closed before command generation",()=>{
  for(const input of [
    discovery({relay_checkout:null}),
    discovery({relay_process:{logical_process_count:2,runtime_pid:4001,parent_pid:4000,observed_matching_process_count:2}}),
  ]){
    const result=evaluateR33Preflight(input,{repoRoot:"C:\\help-pc-2"});
    assert.equal(result.state,R33_BLOCKED);
    assert.equal(result.run_canary_command,null);
  }
});

test("generated command contains paths and identifiers only, never credential bytes",()=>{
  const command=buildR33RunCanaryCommand({
    repoRoot:"C:\\help-pc-2",
    relayRepo:"C:\\relay",
    nativeRelayOrigin:"http://127.0.0.1:17460",
    credentialPath:"C:\\secure\\relay-token.txt",
    nativeDeviceId:"device-A",
    nativeDesktopId:"desktop-A",
    outputDir:"C:\\evidence",
  });
  assert.match(command,/NativeRelayTokenFile/);
  assert.match(command,/relay-token\.txt/);
  assert.doesNotMatch(command,/Authorization|Bearer|actual-secret-value/i);
});

test("PowerShell preflight is read-only and never executes RunCanary or mutates live services",()=>{
  const source=readFileSync(new URL("../tools/r33-live-readonly-canary-preflight.ps1",import.meta.url),"utf8");
  assert.match(source,/github_relay\.py/);
  assert.match(source,/--status/);
  assert.match(source,/\/v1\/relay\/health/);
  assert.match(source,/\/v1\/relay\/devices/);
  assert.match(source,/PC_NATIVE_RELAY_TOKEN_FILE/);
  assert.match(source,/Environment\]::OSVersion\.Platform\s+-eq\s+\[PlatformID\]::Win32NT/);
  assert.doesNotMatch(source,/\$IsWindows\b|\$env:OS/);
  assert.match(source,/\$maxWatchdogAttempts\s*=\s*5/);
  assert.match(source,/state -ne "PROCESS_EXISTS"/);
  assert.match(source,/Start-Sleep -Milliseconds 250/);
  assert.doesNotMatch(source,/Start-Process|Stop-Process|Restart-Service|Stop-Service|Start-Service|Register-ScheduledTask|Unregister-ScheduledTask|New-NetFirewallRule|netsh|cloudflared|ngrok/i);
  assert.doesNotMatch(source,/-Action\s+RunCanary/);
  assert.doesNotMatch(source,/PC_NATIVE_RELAY_TOKEN\s*=/);
});

test("preflight never claims READ_ONLY_CANARY_PASS from source or fixtures",()=>{
  const result=evaluateR33Preflight(discovery(),{repoRoot:"C:\\help-pc-2"});
  const serialized=JSON.stringify(result);
  assert.equal(serialized.includes("READ_ONLY_CANARY_PASS"),false);
  assert.equal(result.actual_read_only_canary_executed,false);
  assert.equal(result.read_only_canary_pass_claimed,false);
});
