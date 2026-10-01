import test from "node:test";
import assert from "node:assert/strict";

import {
  R28_AUTHORITIES,
  R28_CUTOVER_AUTHORITY_V1,
  R28_HANDOFF_V1,
  buildR28CoordinatorHandoff,
  consumeBridgeR24Evidence,
  consumeRelayR27Evidence,
  evaluateR28CutoverAuthority,
  loadR28Pins,
  validateR28BridgePin,
  validateR28PinnedArtifacts,
  validateR28RelayPin,
} from "../src/index.js";
import {
  FIXTURE_CLOCK_MS,
  buildReadyR28Input,
  finalizeRelayEnvelope,
  setBridgeGateState,
} from "./fixtures/r28-evidence-fixtures.js";

const clock = () => FIXTURE_CLOCK_MS;

function clone(value) {
  return structuredClone(value);
}

function expectBlocked(input, label) {
  const result = evaluateR28CutoverAuthority(input, { clock });
  assert.equal(result.decision, "BLOCKED", label);
  assert.equal(result.live_cutover_authorized, false, label);
  assert.equal(result.mutation_execution_authorized, false, label);
  assert.equal(result.automatic_replay_authorized, false, label);
  assert.equal(result.read_only_diagnostics_allowed, true, label);
  assert.ok(result.blockers.length >= 1, label);
  return result;
}

test("R28 independently pinned Bridge R24 and Relay R27 artifacts validate exactly", () => {
  const artifacts = validateR28PinnedArtifacts();
  assert.equal(artifacts.bridge.producer_sha, R28_AUTHORITIES.bridge_r24.sha);
  assert.equal(artifacts.bridge.producer_ci_run, 36865003806);
  assert.equal(artifacts.bridge.live_contract, "bridge.r24_live_preflight.v1");
  assert.equal(artifacts.bridge.schema_authority.standalone_json_schema_published, false);
  assert.equal(
    artifacts.bridge.ci_artifacts.ubuntu.archive_digest,
    "sha256:46399fa77887c1c2617a218f97ba266a1ebd2a3ea80e69b7f7b0c275e7dbbf51",
  );
  assert.equal(
    artifacts.bridge.ci_artifacts.windows.archive_digest,
    "sha256:2e32c7a3b548668fa2d169cb390c92b57a360b6ad81f216fa51a74e628dc305a",
  );

  assert.equal(artifacts.relay.producer_sha, R28_AUTHORITIES.relay_r27.sha);
  assert.equal(artifacts.relay.producer_ci_run, 36866129515);
  assert.equal(artifacts.relay.evidence_contract, "pc_relay.progress_evidence.v1");
  assert.ok(artifacts.relay_delivery_digests.reader_script_sha256.length >= 1);
  assert.ok(artifacts.relay_delivery_digests.evidence_module_sha256.length >= 1);
  for (const digest of [
    ...artifacts.relay_delivery_digests.reader_script_sha256,
    ...artifacts.relay_delivery_digests.evidence_module_sha256,
  ]) {
    assert.match(digest, /^[0-9a-f]{64}$/);
  }
});

test("exact-green Bridge R24 + Relay R27 + R25 produces READY_FOR_EXPLICIT_CUTOVER only", () => {
  const input = buildReadyR28Input();
  const bridge = consumeBridgeR24Evidence(input.bridge_r24_evidence, {
    clock,
    producerBinding: input.bridge_r24_producer_binding,
  });
  const relay = consumeRelayR27Evidence(input.relay_r27_evidence, {
    clock,
    producerBinding: input.relay_r27_producer_binding,
  });
  assert.equal(bridge.ready, true);
  assert.equal(bridge.all_required_gates_pass, true);
  assert.equal(bridge.queue_quiescent, true);
  assert.equal(bridge.code_reload_required, false);
  assert.equal(bridge.process_unambiguous, true);
  assert.equal(relay.ready, true);
  assert.equal(relay.status, "ok");
  assert.equal(relay.liveness_state, "healthy_progressing");
  assert.equal(relay.delivery_source_valid, true);
  assert.equal(relay.evidence_digest_valid, true);
  assert.equal(relay.progress_digest_valid, true);
  assert.equal(relay.atomic_binding_valid, true);
  assert.equal(relay.queue_quiescent, true);
  assert.equal(relay.process_unambiguous, true);
  assert.equal(relay.replay_authorized, false);

  const result = evaluateR28CutoverAuthority(input, { clock });
  assert.equal(result.contract_version, R28_CUTOVER_AUTHORITY_V1);
  assert.equal(result.decision, "READY_FOR_EXPLICIT_CUTOVER");
  assert.equal(result.explicit_cutover_preconditions_met, true);
  assert.equal(result.live_cutover_authorized, false);
  assert.equal(result.mutation_execution_authorized, false);
  assert.equal(result.live_cutover_performed, false);
  assert.equal(result.automatic_replay_authorized, false);
  assert.equal(result.automatic_restart_authorized, false);
  assert.equal(result.automatic_kill_authorized, false);
  assert.equal(result.read_only_diagnostics_allowed, true);
  assert.equal(result.blockers.length, 0);

  const handoff = buildR28CoordinatorHandoff(result, {
    generatedAt: "2026-10-01T14:00:00.000Z",
  });
  assert.equal(handoff.contract_version, R28_HANDOFF_V1);
  assert.equal(handoff.decision, "READY_FOR_EXPLICIT_CUTOVER");
  assert.equal(handoff.release_gate, "NO_LIVE_CUTOVER");
  assert.equal(handoff.live_cutover_authorized, false);
  assert.equal(handoff.mutation_execution_authorized, false);
  assert.equal(handoff.executable_live_cutover_action, null);
  assert.deepEqual(handoff.executable_commands, []);
  assert.match(handoff.digest, /^[0-9a-f]{64}$/);
});

test("moving producer SHAs and pin/schema/manifest drift fail closed", () => {
  const inputBridge = buildReadyR28Input();
  inputBridge.bridge_r24_producer_binding.sha = "0".repeat(40);
  expectBlocked(inputBridge, "moving Bridge R24 SHA");

  const inputRelay = buildReadyR28Input();
  inputRelay.relay_r27_producer_binding.sha = "f".repeat(40);
  expectBlocked(inputRelay, "moving Relay R27 SHA");

  const { bridgePin, relayPin } = loadR28Pins();
  const badBridge = clone(bridgePin);
  badBridge.producer_sha = "0".repeat(40);
  assert.throws(
    () => validateR28BridgePin(badBridge),
    (error) => error.code === "R28_BRIDGE_PRODUCER_DRIFT",
  );

  const bridgeArtifactDrift = clone(bridgePin);
  bridgeArtifactDrift.ci_artifacts.ubuntu.archive_digest = "sha256:" + "0".repeat(64);
  assert.throws(
    () => validateR28BridgePin(bridgeArtifactDrift),
    (error) => error.code === "R28_BRIDGE_ARTIFACT_DRIFT",
  );

  const badRelay = clone(relayPin);
  badRelay.source_blobs["conformance/pc_relay.progress_evidence.v1/manifest.json"] = "0".repeat(40);
  assert.throws(
    () => validateR28RelayPin(badRelay),
    (error) => error.code === "R28_RELAY_BLOB_DRIFT",
  );

  const bridgeSchema = buildReadyR28Input();
  bridgeSchema.bridge_r24_evidence.unpublished_field = true;
  expectBlocked(bridgeSchema, "Bridge schema drift");

  const relaySchema = buildReadyR28Input();
  relaySchema.relay_r27_evidence.unpublished_field = true;
  expectBlocked(relaySchema, "Relay schema drift");
});

for (const state of ["DEGRADED", "BLOCK", "UNKNOWN"]) {
  test(`Bridge R24 ${state} evidence cannot be inferred into readiness`, () => {
    const input = buildReadyR28Input();
    setBridgeGateState(input.bridge_r24_evidence, "status_responsiveness", state);
    const result = expectBlocked(input, `Bridge state ${state}`);
    assert.equal(result.evidence.bridge_r24.ready, false);
  });
}

test("stale Bridge snapshot blocks even when historical producer gates were PASS", () => {
  const input = buildReadyR28Input();
  input.bridge_r24_evidence.collectedAt = new Date(FIXTURE_CLOCK_MS - 60_000).toISOString();
  const result = expectBlocked(input, "stale Bridge snapshot");
  assert.ok(result.evidence.bridge_r24.blockers.includes("bridge_r24_snapshot_stale"));
});

test("Bridge ambiguous process, non-quiescent queue, code reload and unhealthy CDP each block", () => {
  {
    const input = buildReadyR28Input();
    setBridgeGateState(input.bridge_r24_evidence, "process_identity", "UNKNOWN");
    input.bridge_r24_evidence.gates.find((row) => row.id === "process_identity").evidence.ambiguous = true;
    input.bridge_r24_evidence.observations.processIdentity.data.ambiguous = true;
    expectBlocked(input, "ambiguous Bridge process");
  }
  {
    const input = buildReadyR28Input();
    setBridgeGateState(input.bridge_r24_evidence, "queue_quiescence", "BLOCK");
    const gate = input.bridge_r24_evidence.gates.find((row) => row.id === "queue_quiescence");
    Object.assign(gate.evidence, {
      quiescent: false,
      activeTaskCount: 0,
      activeAssignmentCount: 1,
      activeOutboxCount: 0,
    });
    Object.assign(input.bridge_r24_evidence.observations.queue.data, gate.evidence);
    expectBlocked(input, "Bridge queue non-quiescent");
  }
  {
    const input = buildReadyR28Input();
    setBridgeGateState(input.bridge_r24_evidence, "status_responsiveness", "BLOCK");
    input.bridge_r24_evidence.gates.find((row) => row.id === "status_responsiveness").evidence.summary.codeReloadRequired = true;
    input.bridge_r24_evidence.observations.status.data.summary.codeReloadRequired = true;
    const result = expectBlocked(input, "Bridge code reload");
    assert.ok(result.evidence.bridge_r24.blockers.includes("bridge_code_reload_required_or_unknown"));
  }
  {
    const input = buildReadyR28Input();
    setBridgeGateState(input.bridge_r24_evidence, "cdp_readonly_probe", "BLOCK");
    const gate = input.bridge_r24_evidence.gates.find((row) => row.id === "cdp_readonly_probe");
    gate.evidence.profiles[0].responded = false;
    gate.evidence.profiles[0].errorClass = "TIMEOUT";
    input.bridge_r24_evidence.observations.cdp.data = clone(gate.evidence);
    expectBlocked(input, "Bridge CDP unhealthy");
  }
});

test("Relay R27 delivery source digest mismatch and replay authorization are rejected", () => {
  {
    const input = buildReadyR28Input();
    input.relay_r27_evidence.delivery_source.reader_script_sha256 = "0".repeat(64);
    input.relay_r27_evidence = finalizeRelayEnvelope(input.relay_r27_evidence);
    const result = expectBlocked(input, "reader digest mismatch");
    assert.equal(result.evidence.relay_r27.delivery_source_valid, false);
  }
  {
    const input = buildReadyR28Input();
    input.relay_r27_evidence.delivery_semantics.replay_triggered = true;
    input.relay_r27_evidence = finalizeRelayEnvelope(input.relay_r27_evidence);
    const result = expectBlocked(input, "replay authorization");
    assert.equal(result.evidence.relay_r27.delivery_semantics_valid, false);
    assert.equal(result.automatic_replay_authorized, false);
  }
});

test("Relay R27 evidence/progress digest and atomic binding drift are rejected", () => {
  {
    const input = buildReadyR28Input();
    input.relay_r27_evidence.evidence_sha256 = "0".repeat(64);
    const result = expectBlocked(input, "evidence digest mismatch");
    assert.equal(result.evidence.relay_r27.evidence_digest_valid, false);
  }
  {
    const input = buildReadyR28Input();
    input.relay_r27_evidence.progress_sha256 = "0".repeat(64);
    const without = clone(input.relay_r27_evidence);
    delete without.evidence_sha256;
    input.relay_r27_evidence.evidence_sha256 = "0".repeat(64);
    const result = expectBlocked(input, "progress digest mismatch");
    assert.equal(result.evidence.relay_r27.ready, false);
  }
  {
    const input = buildReadyR28Input();
    input.relay_r27_evidence.binding.loop_epoch += 1;
    input.relay_r27_evidence = finalizeRelayEnvelope(input.relay_r27_evidence);
    const result = expectBlocked(input, "atomic binding mismatch");
    assert.equal(result.evidence.relay_r27.atomic_binding_valid, false);
  }
});

test("Relay R27 stale, blocked, stalled, ambiguous and non-quiescent evidence cannot authorize readiness", () => {
  {
    const input = buildReadyR28Input();
    input.relay_r27_evidence.observed_at_unix -= 60;
    input.relay_r27_evidence.liveness.progress_age_seconds += 60;
    input.relay_r27_evidence.liveness.queue_progress_age_seconds += 60;
    input.relay_r27_evidence.liveness.successful_cycle_age_seconds += 60;
    input.relay_r27_evidence = finalizeRelayEnvelope(input.relay_r27_evidence);
    expectBlocked(input, "stale relay evidence");
  }
  {
    const input = buildReadyR28Input();
    const ready = input.relay_r27_evidence;
    input.relay_r27_evidence = finalizeRelayEnvelope({
      contract_version: ready.contract_version,
      status: "blocked",
      observed_at_unix: ready.observed_at_unix,
      delivery_source: ready.delivery_source,
      delivery_semantics: ready.delivery_semantics,
      binding: null,
      progress_sha256: null,
      progress: null,
      liveness: null,
      error: {
        classification: "stale_snapshot",
        reason: "relay progress snapshot exceeded the delivery freshness bound",
        retryable: false,
      },
      evidence_sha256: "",
    });
    const result = expectBlocked(input, "producer status blocked");
    assert.equal(result.evidence.relay_r27.status, "blocked");
  }
  {
    const input = buildReadyR28Input();
    input.relay_r27_evidence.liveness.state = "alive_stalled";
    input.relay_r27_evidence.liveness.reason = "pending_queue_has_no_result_progress";
    input.relay_r27_evidence = finalizeRelayEnvelope(input.relay_r27_evidence);
    expectBlocked(input, "relay alive stalled");
  }
  {
    const input = buildReadyR28Input();
    const pid = input.relay_r27_evidence.binding.process_pid;
    input.relay_r27_evidence.liveness.state = "duplicate_processes_ambiguous";
    input.relay_r27_evidence.liveness.reason = "multiple_matching_relay_processes";
    input.relay_r27_evidence.liveness.observed_pids = [pid, pid + 1];
    input.relay_r27_evidence = finalizeRelayEnvelope(input.relay_r27_evidence);
    const result = expectBlocked(input, "relay duplicate processes");
    assert.equal(result.evidence.relay_r27.process_unambiguous, false);
  }
  {
    const input = buildReadyR28Input();
    input.relay_r27_evidence.progress.queue.pending_count = 1;
    input.relay_r27_evidence.progress.queue.oldest_pending_request_id = "fixture-request-001";
    input.relay_r27_evidence.progress.queue.oldest_pending_age_seconds = 1;
    input.relay_r27_evidence.liveness.pending_count = 1;
    input.relay_r27_evidence = finalizeRelayEnvelope(input.relay_r27_evidence);
    const result = expectBlocked(input, "relay queue non-quiescent");
    assert.equal(result.evidence.relay_r27.queue_quiescent, false);
  }
});

test("R25 unhealthy journal or required adapter keeps R28 blocked", () => {
  {
    const input = buildReadyR28Input();
    input.r25_runtime_health.outcome_journal.integrity = "corrupt";
    input.r25_runtime_health.cutover.journal_healthy = false;
    input.r25_runtime_health.system_state = "UNHEALTHY";
    const result = expectBlocked(input, "R25 journal corrupt");
    assert.equal(result.evidence.r25.journal_healthy, false);
  }
  {
    const input = buildReadyR28Input();
    input.r25_runtime_health.adapters.shell.state = "unhealthy";
    input.r25_runtime_health.adapters.shell.circuit.state = "open";
    const result = expectBlocked(input, "R25 required adapter unhealthy");
    assert.deepEqual(result.evidence.r25.adapter_failures, ["shell"]);
  }
});

test("UNKNOWN side effect has precedence over other blockers and never enables replay", () => {
  const input = buildReadyR28Input();
  input.unknown_side_effects = { count: 1, ids: ["unknown-effect-001"] };
  setBridgeGateState(input.bridge_r24_evidence, "status_responsiveness", "BLOCK");
  const result = evaluateR28CutoverAuthority(input, { clock });
  assert.equal(result.decision, "RECONCILIATION_REQUIRED");
  assert.equal(result.live_cutover_authorized, false);
  assert.equal(result.mutation_execution_authorized, false);
  assert.equal(result.automatic_replay_authorized, false);
  assert.equal(result.read_only_diagnostics_allowed, true);
  assert.ok(result.blockers.some((row) => row.gate === "unknown_side_effect_reconciliation"));
  assert.ok(result.blockers.some((row) => row.gate === "bridge_r24_exact_live_evidence"));
});

test("R28 source contains no live restart, kill, service or deployment execution primitive", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/r28-evidence-consumer.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /child_process|spawn\s*\(|execFile|process\.kill|taskkill|Stop-Process|Restart-Service|Start-Service/);
  assert.doesNotMatch(source, /\/json\/new|liveCutover\s*\(|deploy\s+live|repoint/i);
});
