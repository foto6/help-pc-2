import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { R24_PRODUCER_PIN } from "./r24-runtime-health-consumer.js";
import { R26_PRODUCER_PIN } from "./r26-relay-progress-consumer.js";

export const R27_CUTOVER_AUTHORITY_V1 = "pc.native.r27.cutover_authority.v1";
export const R27_COORDINATOR_HANDOFF_V1 = "pc.native.r27.cutover_handoff.v1";

export const R27_DECISIONS = Object.freeze([
  "READY_FOR_EXPLICIT_CUTOVER",
  "BLOCKED",
  "RECONCILIATION_REQUIRED",
]);

export const R27_AUTHORITIES = Object.freeze({
  native_r26: Object.freeze({
    repository: "foto6/help-pc-2",
    sha: "46c50ea85c3cc4db6b0e43fbd2762d0420d1be28",
    ci_run: 36859871735,
  }),
  bridge_r23: Object.freeze({
    repository: "foto6/WebAIBridge",
    branch: "agent/bridge-r23-cutover-rehearsal-20261001",
    sha: "7e0d5e07f93990f103358850f8f3c10c1563f83a",
    ci_run: 36861515420,
    baseline_sha: "ba4525d0dc9ad808af73d766d0bb9ed0e9eee21b",
  }),
  pc_executor_r24: Object.freeze({
    repository: R24_PRODUCER_PIN.producer_repository,
    branch: R24_PRODUCER_PIN.producer_branch,
    sha: R24_PRODUCER_PIN.producer_sha,
    ci_run: R24_PRODUCER_PIN.producer_workflow_run,
  }),
  pc_relay_r26: Object.freeze({
    repository: R26_PRODUCER_PIN.repository,
    branch: R26_PRODUCER_PIN.branch,
    sha: R26_PRODUCER_PIN.sha,
    ci_run: R26_PRODUCER_PIN.workflow_run,
  }),
});

const BRIDGE_PIN_KEYS = Object.freeze([
  "contract_version",
  "bridge_repository",
  "bridge_branch",
  "bridge_sha",
  "bridge_ci_run",
  "bridge_baseline_sha",
  "source_blobs",
  "ci_artifacts",
  "rehearsal_contract",
  "release_gate",
  "candidate_manifests",
]);

const REQUIRED_ROLLBACK_STAGES = Object.freeze([
  "before_stop",
  "state_validation_failure",
  "after_start",
  "after_health_failure",
  "after_first_assignment",
]);

const REQUIRED_FAULTS = Object.freeze([
  "occupied_port",
  "stale_pid",
  "nonresponsive_status",
  "code_reload_required",
  "hung_cdp",
  "pending_assignment",
]);

export class R27CutoverAuthorityError extends Error {
  constructor(code, message = code, details = null) {
    super(message);
    this.name = "R27CutoverAuthorityError";
    this.code = code;
    this.category = "cutover_authority";
    this.retryable = false;
    this.details = details;
  }
}

function fail(code, message = code, details = null) {
  throw new R27CutoverAuthorityError(code, message, details);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function exactKeys(value, expected, where) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("R27_SCHEMA_DRIFT", `${where} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("R27_SCHEMA_DRIFT", `${where} keys drifted`, { expected: wanted, actual });
  }
}

function isSha40(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function gate(id, ok, reason, evidence = {}) {
  return {
    id,
    state: ok ? "PASS" : "BLOCK",
    ok: Boolean(ok),
    reason,
    evidence: clone(evidence),
  };
}

function digestJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function validateBridgeR23AuthorityPin(pin) {
  exactKeys(pin, BRIDGE_PIN_KEYS, "bridge R23 pin");
  const expected = R27_AUTHORITIES.bridge_r23;
  if (pin.contract_version !== "pc.native.r27.bridge_r23_authority_pin.v1"
      || pin.bridge_repository !== expected.repository
      || pin.bridge_branch !== expected.branch
      || pin.bridge_sha !== expected.sha
      || pin.bridge_ci_run !== expected.ci_run
      || pin.bridge_baseline_sha !== expected.baseline_sha
      || pin.release_gate !== "NO_LIVE_CUTOVER") {
    fail("R27_BRIDGE_AUTHORITY_DRIFT", "Bridge R23 authority identity drifted");
  }

  const requiredSourceBlobs = {
    ".github/workflows/r23-cutover-rehearsal.yml": "77ca1f8a3f0eb5dad1482c124cc9013f7d689af9",
    "app/cutover-r23.js": "0aa125960ebe37020cec19d9048089789d3bef01",
    "app/r23-cutover-rehearsal.js": "82b6c6fe21b32445421a6aaf06128cc26eb22c8a",
    "app/r23-readiness-report.js": "bd00e0674a40df5a0b301c5ccaa89d7c5df8008c",
    "app/r23-cutover-contract.test.js": "663eba71c226904899ff72ce841191b26e72d938",
    "app/docs/BRIDGE_R23_SAFE_CUTOVER_REHEARSAL.md": "e1d4de4ca6ee9610df9dd1dba0c9e1306da6ea6f",
  };
  exactKeys(pin.source_blobs, Object.keys(requiredSourceBlobs), "bridge R23 source_blobs");
  for (const [path, sha] of Object.entries(requiredSourceBlobs)) {
    if (pin.source_blobs[path] !== sha) {
      fail("R27_BRIDGE_SOURCE_BLOB_DRIFT", `Bridge R23 source blob drifted: ${path}`);
    }
  }

  exactKeys(pin.ci_artifacts, ["ubuntu", "windows"], "bridge R23 ci_artifacts");
  const artifactExpected = {
    ubuntu: {
      artifact_id: 11161244146,
      name: "r23-readiness-ubuntu-latest",
      archive_digest: "sha256:63f9a62a9bb2d83d1c3eee3eca9a169bd342e3ec15b9944294f7ce46cda7f8af",
      readiness_json_sha256: "f922dfdc10636e66015a1feb9c8d5673e8b0b6c493172a4f7a4c73d82d1ee827",
      evidence_json_sha256: "c7e503de0a38ba65f2e410a0f2d2ee847300699e2045e36d2f69186550fd7bf3",
      candidate_manifest_digest: "11471c274f1fccb488986077535d3730ea238058095ced0c7669e7e10c555670",
    },
    windows: {
      artifact_id: 11161923643,
      name: "r23-readiness-windows-latest",
      archive_digest: "sha256:fa87af539c857c7bd35b5a77b47ea1ec234a151e0c4a2b74849b39b9fe4618be",
      readiness_json_sha256: "d9c41e518bf6a3934c330ba3e74e6064082f7627e0ae0553fa09c7a47f68a497",
      evidence_json_sha256: "15c639c93a581783069bb8566478e3d0b1930ccdaca567a30e5c2c5791f4f1d5",
      candidate_manifest_digest: "91b50e9d14702e94fad08b0ccadbaa8c027adddb8cdf38da83c869bd9e4b0a94",
    },
  };
  for (const [os, expectedArtifact] of Object.entries(artifactExpected)) {
    const actual = pin.ci_artifacts[os];
    for (const [key, expectedValue] of Object.entries(expectedArtifact)) {
      if (actual?.[key] !== expectedValue) {
        fail("R27_BRIDGE_ARTIFACT_DRIFT", `Bridge R23 ${os} artifact drifted at ${key}`);
      }
    }
    if (!isSha256(actual.state_digest) || !isSha256(actual.config_digest)) {
      fail("R27_BRIDGE_ARTIFACT_DRIFT", `Bridge R23 ${os} state/config digest invalid`);
    }
  }

  const rehearsal = pin.rehearsal_contract;
  if (rehearsal?.readiness_object !== "bridge.r23_cutover_readiness_report"
      || rehearsal?.evidence_scenario !== "bridge-r23-safe-cutover-rehearsal"
      || rehearsal?.candidate_object !== "bridge.r23_candidate_manifest"
      || rehearsal?.final_decision !== "READY_FOR_EXPLICIT_CUTOVER"
      || rehearsal?.release_gate !== "NO_LIVE_DEPLOY"
      || rehearsal?.healthy_candidate_gate_count !== 8) {
    fail("R27_BRIDGE_REHEARSAL_DRIFT", "Bridge R23 rehearsal contract drifted");
  }
  if (JSON.stringify(rehearsal.rollback_stages) !== JSON.stringify(REQUIRED_ROLLBACK_STAGES)
      || JSON.stringify(rehearsal.required_faults) !== JSON.stringify(REQUIRED_FAULTS)) {
    fail("R27_BRIDGE_REHEARSAL_DRIFT", "Bridge R23 rollback/fault proof set drifted");
  }
  const mutations = rehearsal.mutation_invariants ?? {};
  if (mutations.liveBridgeMutated !== false
      || mutations.realProviderMutation !== false
      || mutations.realConversationCreate !== false
      || mutations.realConversationDelete !== false
      || mutations.jsonNewRequests !== 0) {
    fail("R27_BRIDGE_REHEARSAL_DRIFT", "Bridge R23 no-mutation evidence drifted");
  }

  exactKeys(pin.candidate_manifests, ["ubuntu", "windows"], "bridge R23 candidate_manifests");
  for (const [os, manifest] of Object.entries(pin.candidate_manifests)) {
    exactKeys(manifest, [
      "object", "sourceSha", "sourceBranch", "baselineSha", "stateSchemaVersion",
      "configDigest", "stateDigest", "backupStateDigest", "backupConfigDigest",
      "candidatePort", "cdpPort", "validationCommand", "releaseGate", "rollback", "digest",
    ], `bridge R23 candidate_manifests.${os}`);
    if (manifest.object !== "bridge.r23_candidate_manifest"
        || manifest.sourceSha !== expected.sha
        || manifest.sourceBranch !== expected.branch
        || manifest.baselineSha !== expected.baseline_sha
        || manifest.stateSchemaVersion !== 13
        || manifest.stateDigest !== manifest.backupStateDigest
        || manifest.configDigest !== manifest.backupConfigDigest
        || manifest.candidatePort !== 0
        || !Number.isInteger(manifest.cdpPort) || manifest.cdpPort < 1
        || manifest.validationCommand !== "npm run validate:r23"
        || manifest.releaseGate !== "NO_LIVE_DEPLOY"
        || manifest.rollback?.ready !== true
        || manifest.rollback?.reason !== "exact_identity_required_before_execution"
        || manifest.rollback?.command_count !== 8
        || manifest.digest !== pin.ci_artifacts[os].candidate_manifest_digest) {
      fail("R27_BRIDGE_MANIFEST_DRIFT", `Bridge R23 ${os} candidate manifest drifted`);
    }
  }
  return true;
}

export function loadBridgeR23AuthorityPin({
  root = dirname(dirname(fileURLToPath(import.meta.url))),
} = {}) {
  const path = join(root, "conformance", "r27_cutover_authority", "bridge-r23-pin.json");
  const pin = JSON.parse(readFileSync(path, "utf8"));
  validateBridgeR23AuthorityPin(pin);
  return Object.freeze(clone(pin));
}

function validateLivePreflight(value, clock) {
  exactKeys(value, [
    "observed_at_ms",
    "max_age_ms",
    "candidate_provenance",
    "process_ownership",
    "backup",
    "migration",
    "queue",
    "status",
    "cdp",
  ], "bridge_live_preflight");
  const now = clock();
  const observed = Number(value.observed_at_ms);
  const maxAge = Number(value.max_age_ms);
  const liveFresh = Number.isFinite(observed) && Number.isFinite(maxAge)
    && maxAge > 0 && now >= observed && now - observed <= maxAge;

  const provenance = value.candidate_provenance ?? {};
  const provenanceOk = provenance.source_sha === R27_AUTHORITIES.bridge_r23.sha
    && provenance.source_branch === R27_AUTHORITIES.bridge_r23.branch
    && provenance.state_schema_version === 13
    && isSha256(provenance.config_digest);

  const ownership = value.process_ownership ?? {};
  const ownershipOk = ownership.exact_pid_and_command === true
    && ownership.ambiguous !== true;

  const backup = value.backup ?? {};
  const backupOk = backup.state_valid === true
    && backup.config_valid === true
    && isSha256(backup.state_digest)
    && backup.state_digest === backup.backup_state_digest
    && isSha256(backup.config_digest)
    && backup.config_digest === backup.backup_config_digest;

  const migration = value.migration ?? {};
  const migrationOk = migration.compatible === true
    && migration.target_state_version === 13;

  const queue = value.queue ?? {};
  const queueOk = queue.quiescent === true
    && Number(queue.active_assignments) === 0
    && Number(queue.active_tasks) === 0
    && Number(queue.active_outbox) === 0;

  const status = value.status ?? {};
  const statusOk = status.responded === true
    && status.control_plane_responsive === true
    && status.operational_state === "OK"
    && status.code_reload_required === false
    && Number.isFinite(Number(status.age_ms))
    && Number(status.age_ms) >= 0
    && Number(status.age_ms) <= Number(status.max_age_ms)
    && Number.isFinite(Number(status.latency_ms))
    && Number(status.latency_ms) >= 0
    && Number(status.latency_ms) <= Number(status.max_latency_ms);

  const cdp = value.cdp ?? {};
  const cdpOk = cdp.required === false || (
    cdp.responded === true
    && cdp.state === "healthy"
    && Number.isFinite(Number(cdp.age_ms))
    && Number(cdp.age_ms) >= 0
    && Number(cdp.age_ms) <= Number(cdp.max_age_ms)
    && Number.isFinite(Number(cdp.latency_ms))
    && Number(cdp.latency_ms) >= 0
    && Number(cdp.latency_ms) <= Number(cdp.max_latency_ms)
  );

  return {
    gates: [
      gate("bridge_live_freshness", liveFresh, liveFresh ? "fresh_live_preflight" : "stale_or_future_live_preflight"),
      gate("bridge_candidate_provenance", provenanceOk, provenanceOk ? "exact_bridge_candidate" : "bridge_candidate_provenance_mismatch", provenance),
      gate("bridge_process_ownership", ownershipOk, ownershipOk ? "exact_unambiguous_process" : "ambiguous_or_mismatched_process", ownership),
      gate("bridge_backup_validity", backupOk, backupOk ? "state_config_backups_match" : "state_or_config_backup_invalid", backup),
      gate("bridge_migration_compatibility", migrationOk, migrationOk ? "schema13_compatible" : "migration_incompatible", migration),
      gate("bridge_queue_quiescence", queueOk, queueOk ? "queue_quiescent" : "pending_or_inflight_work", queue),
      gate("bridge_status_freshness", statusOk, statusOk ? "bounded_fresh_operational_status" : "nonresponsive_stale_degraded_or_reload_required", status),
      gate("bridge_cdp_freshness", cdpOk, cdpOk ? "bounded_fresh_cdp" : "cdp_unavailable_stale_or_over_budget", cdp),
    ],
  };
}

function validateR25(snapshot, requiredAdapters, producerAttestation, clock) {
  const sourceExact = snapshot?.contract_version === "pc.native.r25.r24_runtime_health_consumer.v1"
    && snapshot?.producer_contract === "pc_executor.runtime_health.v1"
    && snapshot?.producer_repository === R27_AUTHORITIES.pc_executor_r24.repository
    && snapshot?.producer_sha === R27_AUTHORITIES.pc_executor_r24.sha
    && snapshot?.producer_workflow_run === R27_AUTHORITIES.pc_executor_r24.ci_run
    && snapshot?.vendored_artifacts_verified === true;
  const fresh = snapshot?.source_state === "SOURCE_BOUND"
    && snapshot?.freshness === "fresh"
    && snapshot?.complete === true
    && snapshot?.cutover?.producer_health_fresh === true;
  const generation = Number.isInteger(snapshot?.generation?.executor_process_id)
    && snapshot.generation.executor_process_id > 0
    && typeof snapshot?.generation?.operations_generation_id === "string"
    && snapshot.generation.operations_generation_id.length > 0
    && snapshot?.cutover?.generation_known === true;
  const journal = snapshot?.outcome_journal?.configured === true
    && snapshot?.outcome_journal?.integrity === "healthy"
    && snapshot?.cutover?.journal_healthy === true;

  const attestationFresh = producerAttestation?.verified === true
    && producerAttestation?.sha === R27_AUTHORITIES.pc_executor_r24.sha
    && Number.isFinite(Number(producerAttestation?.observed_at_ms))
    && Number.isFinite(Number(producerAttestation?.max_age_ms))
    && Number(producerAttestation.max_age_ms) > 0
    && clock() >= Number(producerAttestation.observed_at_ms)
    && clock() - Number(producerAttestation.observed_at_ms) <= Number(producerAttestation.max_age_ms);

  const adapterFailures = [];
  for (const name of requiredAdapters) {
    const adapter = snapshot?.adapters?.[name];
    const ok = adapter?.available === true
      && adapter?.state === "responsive"
      && adapter?.circuit?.state === "closed";
    if (!ok) adapterFailures.push(name);
  }
  const adaptersOk = adapterFailures.length === 0;
  const systemOk = snapshot?.system_state === "HEALTHY";
  return {
    gates: [
      gate("r25_exact_runtime_health_authority", sourceExact, sourceExact ? "exact_r24_contract_and_pin" : "r24_runtime_health_authority_mismatch"),
      gate("r25_runtime_health_fresh", fresh, fresh ? "fresh_complete_runtime_health" : "runtime_health_stale_unknown_or_incomplete"),
      gate("r25_generation_identity", generation, generation ? "known_executor_generation" : "unknown_executor_generation"),
      gate("r25_journal_integrity", journal, journal ? "healthy_outcome_journal" : "outcome_journal_not_healthy"),
      gate("r25_runtime_producer_attestation", attestationFresh, attestationFresh ? "exact_fresh_runtime_producer_sha" : "runtime_producer_sha_unattested_or_stale", producerAttestation),
      gate("r25_required_adapters", adaptersOk, adaptersOk ? "required_adapters_responsive" : "required_adapter_unhealthy", { required: requiredAdapters, failed: adapterFailures }),
      gate("r25_system_health", systemOk, systemOk ? "system_health_acceptable" : "runtime_system_health_not_acceptable"),
    ],
  };
}

function validateR26(snapshot) {
  const exact = snapshot?.contract_version === "pc.native.r26.relay_progress_consumer.v1"
    && snapshot?.producer_repository === R27_AUTHORITIES.pc_relay_r26.repository
    && snapshot?.producer_branch === R27_AUTHORITIES.pc_relay_r26.branch
    && snapshot?.producer_sha === R27_AUTHORITIES.pc_relay_r26.sha
    && snapshot?.producer_workflow_run === R27_AUTHORITIES.pc_relay_r26.ci_run
    && snapshot?.producer_sha_wire_attested === true
    && snapshot?.vendored_artifacts_verified === true;
  const fresh = snapshot?.source_state === "SOURCE_BOUND"
    && snapshot?.cutover?.fresh_evidence === true;
  const healthy = snapshot?.liveness_state === "healthy_progressing"
    && snapshot?.classification === "healthy_progressing"
    && snapshot?.cutover?.healthy_progressing === true;
  const ownership = snapshot?.cutover?.ambiguous_ownership === false
    && Array.isArray(snapshot?.process?.observed_pids)
    && snapshot.process.observed_pids.length === 1
    && snapshot.process.observed_pids[0] === snapshot.process.pid;
  const noReplay = snapshot?.recovery?.auto_restart === false
    && snapshot?.recovery?.auto_kill === false
    && snapshot?.recovery?.automatic_replay === false
    && snapshot?.recovery?.replay_authorized_after_liveness_recovery === false;
  return {
    gates: [
      gate("r26_exact_relay_authority", exact, exact ? "exact_r26_progress_authority" : "r26_progress_authority_mismatch"),
      gate("r26_progress_freshness", fresh, fresh ? "fresh_relay_progress" : "relay_progress_stale_unknown_or_invalid"),
      gate("r26_healthy_progressing", healthy, healthy ? "relay_healthy_progressing" : "relay_not_healthy_progressing"),
      gate("r26_process_ownership", ownership, ownership ? "single_exact_relay_owner" : "ambiguous_or_mismatched_relay_owner"),
      gate("r26_no_automatic_recovery", noReplay, noReplay ? "no_restart_kill_or_replay_authority" : "unsafe_recovery_semantics_detected"),
    ],
  };
}

export function evaluateR27CutoverAuthority(input, {
  clock = Date.now,
  bridgePin = loadBridgeR23AuthorityPin(),
} = {}) {
  let bridgeAuthorityOk = true;
  let bridgeAuthorityReason = "exact_bridge_r23_rehearsal_and_rollback_authority";
  let bridgeAuthorityError = null;
  try {
    validateBridgeR23AuthorityPin(bridgePin);
  } catch (error) {
    bridgeAuthorityOk = false;
    bridgeAuthorityReason = error?.code ?? "R27_BRIDGE_AUTHORITY_INVALID";
    bridgeAuthorityError = {
      code: error?.code ?? "R27_BRIDGE_AUTHORITY_INVALID",
      category: error?.category ?? "cutover_authority",
    };
  }
  exactKeys(input, [
    "bridge_live_preflight",
    "r25_runtime_health",
    "r25_runtime_producer_attestation",
    "r26_relay_progress",
    "unknown_side_effects",
    "required_native_adapters",
  ], "R27 authority input");

  if (!Array.isArray(input.required_native_adapters)
      || input.required_native_adapters.some((item) => typeof item !== "string" || !item)) {
    fail("R27_SCHEMA_DRIFT", "required_native_adapters must be an array of adapter names");
  }
  const unknown = input.unknown_side_effects ?? {};
  if (!Number.isInteger(unknown.count) || unknown.count < 0
      || !Array.isArray(unknown.ids)
      || unknown.ids.length !== unknown.count
      || unknown.ids.some((id) => typeof id !== "string" || !id)) {
    fail("R27_SCHEMA_DRIFT", "unknown_side_effects is invalid");
  }

  const bridgeAuthorityGate = gate(
    "bridge_r23_rehearsal_authority",
    bridgeAuthorityOk,
    bridgeAuthorityReason,
    bridgeAuthorityOk ? {
      bridge_sha: bridgePin.bridge_sha,
      bridge_ci_run: bridgePin.bridge_ci_run,
      ubuntu_artifact_id: bridgePin.ci_artifacts.ubuntu.artifact_id,
      windows_artifact_id: bridgePin.ci_artifacts.windows.artifact_id,
      rollback_stages: bridgePin.rehearsal_contract.rollback_stages,
    } : bridgeAuthorityError,
  );
  const live = validateLivePreflight(input.bridge_live_preflight, clock);
  const r25 = validateR25(
    input.r25_runtime_health,
    input.required_native_adapters,
    input.r25_runtime_producer_attestation,
    clock,
  );
  const r26 = validateR26(input.r26_relay_progress);

  const unknownCount = Math.max(
    unknown.count,
    Number(input.r26_relay_progress?.pending_unknown_effects ?? 0),
  );
  const reconciliationRequired = unknownCount > 0
    || input.r26_relay_progress?.reconciliation_required === true;
  const reconciliationGate = gate(
    "unknown_side_effect_reconciliation",
    !reconciliationRequired,
    reconciliationRequired ? "unknown_side_effect_requires_reconciliation" : "no_unknown_side_effects",
    {
      explicit_count: unknown.count,
      relay_pending_unknown_effects: input.r26_relay_progress?.pending_unknown_effects ?? null,
      automatic_replay: false,
    },
  );

  const gates = [
    bridgeAuthorityGate,
    ...live.gates,
    ...r25.gates,
    ...r26.gates,
    reconciliationGate,
  ];
  const blockers = gates.filter((item) => !item.ok);
  const decision = reconciliationRequired
    ? "RECONCILIATION_REQUIRED"
    : blockers.length > 0
      ? "BLOCKED"
      : "READY_FOR_EXPLICIT_CUTOVER";

  return {
    contract_version: R27_CUTOVER_AUTHORITY_V1,
    decision,
    release_gate: "NO_LIVE_CUTOVER",
    live_cutover_performed: false,
    automatic_replay_authorized: false,
    automatic_restart_authorized: false,
    automatic_kill_authorized: false,
    read_only_diagnostics_allowed: true,
    mutation_or_cutover_authorized: decision === "READY_FOR_EXPLICIT_CUTOVER",
    gates,
    blockers: blockers.map((item) => ({ gate: item.id, reason: item.reason })),
    authorities: clone(R27_AUTHORITIES),
    bridge_artifacts: bridgeAuthorityOk ? {
      ubuntu: clone(bridgePin.ci_artifacts.ubuntu),
      windows: clone(bridgePin.ci_artifacts.windows),
    } : null,
    stopping_rules: [
      "STOP on any failed, stale, unknown, ambiguous or schema-drifted authority gate.",
      "STOP on any UNKNOWN side effect and reconcile via outcome evidence; never replay as a new mutation.",
      "STOP on ambiguous Bridge or relay process ownership; never kill/restart by port, PID record, or ambiguity.",
      "STOP if Bridge status is nonresponsive, stale, degraded, over budget, or code reload is required.",
      "STOP if required CDP evidence is unavailable, stale, unhealthy, or over budget.",
      "STOP if Bridge state/config backup digests do not exactly match their pre-cutover counterparts.",
      "STOP if queue quiescence is false or any assignment/task/outbox mutation is pending.",
      "STOP if R25 runtime health/generation/journal evidence is stale, unknown, corrupt, or required adapters are not responsive.",
      "STOP if R26 relay evidence is not fresh healthy_progressing with unambiguous ownership.",
      "This authority is advisory only: it contains no executable live cutover action.",
    ],
  };
}

export function buildR27CoordinatorHandoff(decisionResult, {
  generatedAt = new Date().toISOString(),
} = {}) {
  if (!decisionResult || decisionResult.contract_version !== R27_CUTOVER_AUTHORITY_V1
      || !R27_DECISIONS.includes(decisionResult.decision)) {
    fail("R27_HANDOFF_INPUT_INVALID", "R27 coordinator handoff requires a valid authority decision");
  }
  const handoff = {
    contract_version: R27_COORDINATOR_HANDOFF_V1,
    generated_at: generatedAt,
    decision: decisionResult.decision,
    release_gate: "NO_LIVE_CUTOVER",
    authorities: clone(R27_AUTHORITIES),
    bridge_artifacts: clone(decisionResult.bridge_artifacts),
    required_live_preflight_fields: [
      "bridge_live_preflight.observed_at_ms/max_age_ms",
      "bridge_live_preflight.candidate_provenance.source_sha/source_branch/state_schema_version/config_digest",
      "bridge_live_preflight.process_ownership.exact_pid_and_command/ambiguous",
      "bridge_live_preflight.backup.state_valid/config_valid/state_digest/backup_state_digest/config_digest/backup_config_digest",
      "bridge_live_preflight.migration.compatible/target_state_version",
      "bridge_live_preflight.queue.quiescent/active_assignments/active_tasks/active_outbox",
      "bridge_live_preflight.status.responded/control_plane_responsive/operational_state/code_reload_required/age_ms/max_age_ms/latency_ms/max_latency_ms",
      "bridge_live_preflight.cdp.required/responded/state/age_ms/max_age_ms/latency_ms/max_latency_ms",
      "r25_runtime_health exact source-bound pc_executor.runtime_health.v1 snapshot",
      "r25_runtime_producer_attestation exact SHA/freshness",
      "r26_relay_progress exact source-bound pc_relay.progress/liveness snapshot",
      "unknown_side_effects count and durable identities",
      "required_native_adapters",
    ],
    stopping_rules: clone(decisionResult.stopping_rules),
    blockers: clone(decisionResult.blockers),
    read_only_diagnostics_allowed: true,
    automatic_replay_authorized: false,
    automatic_restart_authorized: false,
    automatic_kill_authorized: false,
    executable_live_cutover_action: null,
    executable_commands: [],
  };
  handoff.digest = digestJson(handoff);
  return handoff;
}
