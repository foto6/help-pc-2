import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  R24_PRODUCER_PIN,
  R26_PRODUCER_PIN,
  R28_AUTHORITIES,
  validateR28PinnedArtifacts,
} from "../../src/index.js";

export const FIXTURE_CLOCK_MS = 1790820016000;

function clone(value) {
  return structuredClone(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

function sha256Canonical(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function sourceBinding(authority) {
  return {
    verified: true,
    repository: authority.repository,
    branch: authority.branch,
    sha: authority.sha,
    ci_run: authority.ci_run,
    observed_at_ms: FIXTURE_CLOCK_MS - 250,
    max_age_ms: 5000,
  };
}

function observation(observedAt, source, data, state = "PASS", budgetMs = 500) {
  return {
    source,
    state,
    observedAt,
    budgetMs,
    reason: state === "PASS" ? "fixture_pass" : `fixture_${state.toLowerCase()}`,
    data: clone(data),
  };
}

function gate(observedAt, id, evidence, state = "PASS") {
  return {
    id,
    state,
    ok: state === "PASS",
    reason: state === "PASS" ? "verified" : `fixture_${state.toLowerCase()}`,
    source: `fixture:${id}`,
    observedAt,
    evidence: clone(evidence),
  };
}

export function buildReadyBridgeR24Evidence() {
  const observedAt = new Date(FIXTURE_CLOCK_MS - 1000).toISOString();
  const data = {
    process_identity: {
      pid: 4242,
      commandFingerprint: "a".repeat(64),
      ambiguous: false,
    },
    source_provenance: {
      sha: "b".repeat(40),
      branch: "agent/live-bridge",
    },
    config_provenance: {
      digest: "c".repeat(64),
    },
    port_ownership: {
      port: 17448,
      listening: true,
      ownerPid: 4242,
      ambiguous: false,
    },
    status_responsiveness: {
      responded: true,
      latencyMs: 5,
      budgetMs: 500,
      summary: {
        controlPlaneResponsive: true,
        generatedFresh: true,
        operationalState: "OK",
        codeReloadRequired: false,
      },
    },
    health_responsiveness: {
      responded: true,
      latencyMs: 4,
      budgetMs: 500,
      summary: {
        checkedFresh: true,
        state: "OK",
        eventLoopState: "healthy",
        codeReloadRequired: false,
      },
    },
    queue_quiescence: {
      observable: true,
      quiescent: true,
      activeTaskCount: 0,
      activeAssignmentCount: 0,
      activeOutboxCount: 0,
    },
    cdp_readonly_probe: {
      required: true,
      profiles: [{
        profileId: "p1",
        responded: true,
        latencyMs: 5,
        budgetMs: 750,
        errorClass: "",
      }],
    },
    durable_state: {
      readable: true,
      valid: true,
      version: 13,
      digest: "d".repeat(64),
    },
    r23_candidate_manifest: {
      valid: true,
      digest: "e".repeat(64),
      sourceSha: "dac4dd0edd35cdbf96d5c03344acd94f899a6aba",
    },
  };
  return {
    schema: "bridge.r24_live_preflight.v1",
    object: "bridge.r24_live_preflight.v1",
    collectedAt: observedAt,
    candidate: {
      r23SourceSha: "dac4dd0edd35cdbf96d5c03344acd94f899a6aba",
      r23SourceBranch: "agent/bridge-r23-cutover-rehearsal-20261001",
      r23ManifestSha256: "e".repeat(64),
    },
    budgets: {
      httpMs: 500,
      cdpMs: 750,
      osMs: 1500,
      freshnessMs: 5000,
      fileMs: 1500,
    },
    expectations: {
      pid: 4242,
      commandFingerprint: "a".repeat(64),
      port: 17448,
      sourceSha: "b".repeat(40),
      sourceBranch: "agent/live-bridge",
      configDigest: "c".repeat(64),
    },
    observations: {
      processIdentity: observation(observedAt, "fixture process", data.process_identity),
      sourceProvenance: observation(observedAt, "fixture source", data.source_provenance),
      configProvenance: observation(observedAt, "fixture config", data.config_provenance),
      portOwnership: observation(observedAt, "fixture port", data.port_ownership),
      status: observation(observedAt, "fixture status", data.status_responsiveness),
      health: observation(observedAt, "fixture health", data.health_responsiveness),
      queue: observation(observedAt, "fixture queue", data.queue_quiescence),
      cdp: observation(observedAt, "fixture cdp", data.cdp_readonly_probe, "PASS", 750),
      durableState: observation(observedAt, "fixture state", data.durable_state, "PASS", 1500),
      r23Manifest: observation(observedAt, "fixture manifest", data.r23_candidate_manifest, "PASS", 1500),
    },
    gates: [
      gate(observedAt, "process_identity", data.process_identity),
      gate(observedAt, "source_provenance", data.source_provenance),
      gate(observedAt, "config_provenance", data.config_provenance),
      gate(observedAt, "port_ownership", data.port_ownership),
      gate(observedAt, "status_responsiveness", data.status_responsiveness),
      gate(observedAt, "health_responsiveness", data.health_responsiveness),
      gate(observedAt, "queue_quiescence", data.queue_quiescence),
      gate(observedAt, "cdp_readonly_probe", data.cdp_readonly_probe),
      gate(observedAt, "durable_state", data.durable_state),
      gate(observedAt, "r23_candidate_manifest", data.r23_candidate_manifest),
    ],
    decision: "READY_FOR_EXPLICIT_CUTOVER",
    releaseGate: "NO_LIVE_DEPLOY",
    readyForExplicitCutover: true,
    blockers: [],
    safety: {
      readOnly: true,
      methodsAllowed: ["GET"],
      providerMutationPerformed: false,
      bridgeMutationPerformed: false,
      processMutationPerformed: false,
      filesWrittenByCollector: false,
      tabsCreated: false,
      conversationsCreated: false,
      assignmentsDispatched: false,
      migrationsApplied: false,
      secretsIncluded: false,
    },
    stoppingRules: ["fixture stop on any non-pass gate"],
  };
}

function buildProgress() {
  const progress = JSON.parse(readFileSync(
    new URL("../../conformance/r26_relay_progress_v1/progress.example.json", import.meta.url),
    "utf8",
  ));
  progress.source.branch = R26_PRODUCER_PIN.branch;
  progress.source.startup_head = R26_PRODUCER_PIN.sha;
  progress.source.relay_script_sha256 = R26_PRODUCER_PIN.relay_script_sha256;
  progress.queue.pending_count = 0;
  progress.queue.oldest_pending_request_id = null;
  progress.queue.oldest_pending_age_seconds = null;
  return progress;
}

export function finalizeRelayEnvelope(envelope) {
  const out = clone(envelope);
  if (out.status === "ok" && out.progress) {
    out.progress_sha256 = sha256Canonical(out.progress);
  }
  const withoutDigest = { ...out };
  delete withoutDigest.evidence_sha256;
  out.evidence_sha256 = sha256Canonical(withoutDigest);
  return out;
}

export function buildReadyRelayR27Evidence() {
  const artifacts = validateR28PinnedArtifacts();
  const progress = buildProgress();
  const observed = progress.recorded_at_unix + 1;
  const liveness = {
    contract_version: "pc_relay.liveness_probe.v1",
    state: "healthy_progressing",
    reason: "cycle_and_queue_progress_within_bound",
    observed_pids: [progress.process.pid],
    progress_age_seconds: observed - progress.recorded_at_unix,
    queue_progress_age_seconds: observed - progress.queue.last_progress_at_unix,
    successful_cycle_age_seconds:
      observed - (progress.last_successful_cycle_at_unix ?? progress.process.started_at_unix),
    consecutive_cycle_failures: progress.consecutive_cycle_failures,
    pending_count: progress.queue.pending_count,
    loop_generation_id: progress.loop_generation_id,
    loop_epoch: progress.loop_epoch,
    process_pid: progress.process.pid,
    last_error_classification: progress.last_error?.classification ?? null,
  };
  return finalizeRelayEnvelope({
    contract_version: "pc_relay.progress_evidence.v1",
    status: "ok",
    observed_at_unix: observed,
    delivery_source: {
      repository: "foto6/help-pc-1",
      mechanism: "bounded_local_file_stdio",
      reader_script_sha256: artifacts.relay_delivery_digests.reader_script_sha256[0],
      evidence_module_sha256: artifacts.relay_delivery_digests.evidence_module_sha256[0],
    },
    delivery_semantics: {
      read_only: true,
      queue_acknowledged: false,
      lease_created: false,
      retry_triggered: false,
      replay_triggered: false,
    },
    binding: {
      relay_startup_head: progress.source.startup_head,
      relay_script_sha256: progress.source.relay_script_sha256,
      process_pid: progress.process.pid,
      process_started_at_unix: progress.process.started_at_unix,
      process_instance_id: progress.process.instance_id,
      loop_generation_id: progress.loop_generation_id,
      loop_epoch: progress.loop_epoch,
      progress_recorded_at_unix: progress.recorded_at_unix,
    },
    progress_sha256: "",
    progress,
    liveness,
    error: null,
    evidence_sha256: "",
  });
}

export function buildReadyR25RuntimeHealth() {
  return {
    contract_version: "pc.native.r25.r24_runtime_health_consumer.v1",
    producer_contract: "pc_executor.runtime_health.v1",
    producer_repository: R24_PRODUCER_PIN.producer_repository,
    producer_sha: R24_PRODUCER_PIN.producer_sha,
    producer_workflow_run: R24_PRODUCER_PIN.producer_workflow_run,
    vendored_artifacts_verified: true,
    source_state: "SOURCE_BOUND",
    freshness: "fresh",
    complete: true,
    system_state: "HEALTHY",
    generation: {
      executor_process_id: 4242,
      operations_generation_id: "r28-fixture-generation",
    },
    adapters: {
      shell: { available: true, state: "responsive", circuit: { state: "closed" } },
      windows: { available: true, state: "responsive", circuit: { state: "closed" } },
      screenshot: { available: true, state: "responsive", circuit: { state: "closed" } },
      outcome_journal: { available: true, state: "responsive", circuit: { state: "closed" } },
    },
    outcome_journal: {
      configured: true,
      integrity: "healthy",
    },
    cutover: {
      producer_health_fresh: true,
      generation_known: true,
      journal_healthy: true,
    },
  };
}

export function buildReadyR28Input() {
  return {
    bridge_r24_evidence: buildReadyBridgeR24Evidence(),
    bridge_r24_producer_binding: sourceBinding(R28_AUTHORITIES.bridge_r24),
    relay_r27_evidence: buildReadyRelayR27Evidence(),
    relay_r27_producer_binding: sourceBinding(R28_AUTHORITIES.relay_r27),
    r25_runtime_health: buildReadyR25RuntimeHealth(),
    r25_runtime_producer_binding: sourceBinding(R28_AUTHORITIES.executor_r24),
    unknown_side_effects: { count: 0, ids: [] },
    required_native_adapters: ["shell", "windows"],
  };
}

export function setBridgeGateState(snapshot, id, state) {
  const gateRow = snapshot.gates.find((row) => row.id === id);
  gateRow.state = state;
  gateRow.ok = state === "PASS";
  gateRow.reason = state === "PASS" ? "verified" : `fixture_${state.toLowerCase()}`;
  const map = {
    process_identity: "processIdentity",
    source_provenance: "sourceProvenance",
    config_provenance: "configProvenance",
    port_ownership: "portOwnership",
    status_responsiveness: "status",
    health_responsiveness: "health",
    queue_quiescence: "queue",
    cdp_readonly_probe: "cdp",
    durable_state: "durableState",
    r23_candidate_manifest: "r23Manifest",
  };
  snapshot.observations[map[id]].state = state;
  snapshot.observations[map[id]].reason = `fixture_${state.toLowerCase()}`;
  if (state === "DEGRADED") snapshot.decision = "DEGRADED";
  else if (state !== "PASS") snapshot.decision = "BLOCKED";
  snapshot.readyForExplicitCutover = false;
  snapshot.blockers = [{ gate: id, state, reason: `fixture_${state.toLowerCase()}` }];
}
