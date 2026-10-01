export const R28_HEALTH_V1 = "pc_relay.health.v1";
export const R28_FRESHNESS_GATE_V1 = "pc.native.r28.relay_freshness_gate.v1";
export const R28_PRODUCER_PIN = Object.freeze({
  repository: "foto6/help-pc-1",
  branch: "agent/pc-relay-stale-sync-watchdog-20261001",
  sha: "2158066be7f4141c70e9bf24f6138d399bff7164",
  workflow_run: 36885427807,
  source_blobs: Object.freeze({
    health_schema: "2a2f4e88e3b483db768fc95972c2ed25fa9a187e",
    producer_pin: "935940dfc0678c65fa76db3a2c1d0364de4fbe8f",
    relay: "d10c3064ae21833cc7288d37adead7dc0f67e15d",
    launcher: "c9545f09b8dc6eb2d10cf1903736e95829cbaba0",
  }),
});

const SHA40 = /^[0-9a-f]{40}$/;
const REQUEST_ID = /^[A-Za-z0-9._-]{1,80}$/;
const STATUSES = new Set(["starting", "process_exists", "healthy", "degraded"]);
const PHASES = new Set([
  "startup", "publish_pending", "sync_fetch", "sync_complete", "execute_request",
  "reconcile_interrupted_side_effect", "result_published", "idle", "cycle_error",
]);
const LONG_PHASES = new Set(["execute_request", "reconcile_interrupted_side_effect"]);

function blocker(code, detail = null) {
  return { code, detail };
}
function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function nonNegativeInt(value) {
  return Number.isInteger(value) && value >= 0;
}
function nullableTimestamp(value) {
  return value === null || (finite(value) && value >= 0);
}
function exactProducer(producer) {
  if (!producer || typeof producer !== "object") return false;
  if (producer.repository !== R28_PRODUCER_PIN.repository
      || producer.branch !== R28_PRODUCER_PIN.branch
      || producer.sha !== R28_PRODUCER_PIN.sha
      || producer.workflow_run !== R28_PRODUCER_PIN.workflow_run) return false;
  const blobs = producer.source_blobs;
  if (!blobs || typeof blobs !== "object") return false;
  return Object.entries(R28_PRODUCER_PIN.source_blobs)
    .every(([name, sha]) => blobs[name] === sha);
}

export function validateR28HealthSnapshot(health) {
  if (!health || typeof health !== "object" || Array.isArray(health)) {
    return { ok: false, code: "MISSING_HEALTH_EVIDENCE" };
  }
  if (health.health_version !== R28_HEALTH_V1) return { ok: false, code: "HEALTH_SCHEMA_DRIFT" };
  if (!Number.isInteger(health.pid) || health.pid < 1) return { ok: false, code: "HEALTH_PID_INVALID" };
  if (typeof health.branch !== "string" || health.branch.length === 0) return { ok: false, code: "HEALTH_BRANCH_INVALID" };
  if (typeof health.live !== "boolean" || !STATUSES.has(health.status) || !PHASES.has(health.phase)) {
    return { ok: false, code: "HEALTH_ENUM_DRIFT" };
  }
  for (const [key, value] of [
    ["updated_at_unix", health.updated_at_unix],
    ["started_at_unix", health.started_at_unix],
  ]) {
    if (!finite(value) || value < 0) return { ok: false, code: "HEALTH_TIMESTAMP_INVALID", detail: key };
  }
  for (const key of ["last_sync_at_unix", "last_cycle_completed_at_unix", "last_result_published_at_unix"]) {
    if (!nullableTimestamp(health[key])) return { ok: false, code: "HEALTH_TIMESTAMP_INVALID", detail: key };
  }
  if (health.started_at_unix > health.updated_at_unix) return { ok: false, code: "IMPOSSIBLE_TIME_ORDER" };
  for (const key of ["last_sync_at_unix", "last_cycle_completed_at_unix", "last_result_published_at_unix"]) {
    if (health[key] !== null && health[key] > health.updated_at_unix) {
      return { ok: false, code: "IMPOSSIBLE_TIME_ORDER", detail: key };
    }
  }
  if (health.local_head !== null && !SHA40.test(health.local_head)) return { ok: false, code: "LOCAL_HEAD_INVALID" };
  if (health.remote_head !== null && !SHA40.test(health.remote_head)) return { ok: false, code: "REMOTE_HEAD_INVALID" };
  if (![health.request_count, health.result_count, health.backlog_count].every(nonNegativeInt)) {
    return { ok: false, code: "QUEUE_COUNTER_INVALID" };
  }
  if (health.result_count > health.request_count
      || health.backlog_count !== health.request_count - health.result_count) {
    return { ok: false, code: "QUEUE_COUNTER_INCONSISTENT" };
  }
  if (health.current_request_id !== null
      && (typeof health.current_request_id !== "string" || !REQUEST_ID.test(health.current_request_id))) {
    return { ok: false, code: "CURRENT_REQUEST_INVALID" };
  }
  if (health.last_reconciliation_request_id !== null
      && (typeof health.last_reconciliation_request_id !== "string"
          || !REQUEST_ID.test(health.last_reconciliation_request_id))) {
    return { ok: false, code: "RECONCILIATION_ID_INVALID" };
  }
  if (typeof health.reconciliation_required !== "boolean") {
    return { ok: false, code: "RECONCILIATION_FLAG_INVALID" };
  }
  return { ok: true };
}

function processEvidence(health, processes) {
  if (!Array.isArray(processes) || processes.length === 0) {
    return { ok: false, code: "PROCESS_EVIDENCE_MISSING" };
  }
  for (const item of processes) {
    if (!item || !Number.isInteger(item.pid) || item.pid < 1
        || (item.parent_pid !== null && (!Number.isInteger(item.parent_pid) || item.parent_pid < 1))
        || !["launcher_wrapper", "relay_runtime"].includes(item.role)) {
      return { ok: false, code: "PROCESS_EVIDENCE_INVALID" };
    }
  }
  const runtimes = processes.filter((item) => item.role === "relay_runtime");
  if (runtimes.length !== 1) return { ok: false, code: "RELAY_RUNTIME_OWNERSHIP_AMBIGUOUS" };
  if (runtimes[0].pid !== health.pid) return { ok: false, code: "HEALTH_PID_IDENTITY_MISMATCH" };
  const wrappers = processes.filter((item) => item.role === "launcher_wrapper");
  if (wrappers.length > 1) return { ok: false, code: "LAUNCHER_WRAPPER_AMBIGUOUS" };
  if (wrappers.length === 1 && runtimes[0].parent_pid !== wrappers[0].pid) {
    return { ok: false, code: "PROCESS_CHAIN_INVALID" };
  }
  return { ok: true };
}

function monotonicity(previous, current) {
  if (!previous) return { ok: true };
  const old = validateR28HealthSnapshot(previous);
  if (!old.ok) return { ok: false, code: "PREVIOUS_HEALTH_INVALID" };
  if (previous.pid !== current.pid || previous.started_at_unix !== current.started_at_unix) {
    return { ok: true, restart_observed: true };
  }
  for (const key of ["updated_at_unix", "request_count", "result_count"]) {
    if (current[key] < previous[key]) return { ok: false, code: "IMPOSSIBLE_MONOTONICITY", detail: key };
  }
  for (const key of ["last_sync_at_unix", "last_cycle_completed_at_unix", "last_result_published_at_unix"]) {
    if (previous[key] !== null && current[key] !== null && current[key] < previous[key]) {
      return { ok: false, code: "IMPOSSIBLE_MONOTONICITY", detail: key };
    }
  }
  return { ok: true, restart_observed: false };
}

export function evaluateR28RelayFreshness(input, {
  nowUnix,
  defaultFreshSeconds = 30,
  longRunningFreshSeconds = 150,
} = {}) {
  const blockers = [];
  const producerOk = exactProducer(input?.producer);
  if (!producerOk) blockers.push(blocker("PRODUCER_PIN_DRIFT"));

  const healthCheck = validateR28HealthSnapshot(input?.health);
  if (!healthCheck.ok) blockers.push(blocker(healthCheck.code, healthCheck.detail ?? null));

  const pendingUnknown = input?.pending_unknown_effects;
  if (!nonNegativeInt(pendingUnknown ?? -1)) blockers.push(blocker("UNKNOWN_EFFECT_COUNT_INVALID"));

  if (!healthCheck.ok) {
    return {
      contract_version: R28_FRESHNESS_GATE_V1,
      decision: "MISSING_EVIDENCE",
      usable_for_mutation: false,
      read_only_diagnostics_allowed: true,
      live_cutover_authorized: false,
      automatic_restart_authorized: false,
      automatic_kill_authorized: false,
      automatic_replay_authorized: false,
      blockers,
    };
  }

  const health = input.health;
  if ((pendingUnknown ?? 0) > 0 || health.reconciliation_required) {
    blockers.push(blocker("SIDE_EFFECT_RECONCILIATION_REQUIRED"));
    return {
      contract_version: R28_FRESHNESS_GATE_V1,
      decision: "RECONCILIATION_REQUIRED",
      usable_for_mutation: false,
      read_only_diagnostics_allowed: true,
      live_cutover_authorized: false,
      automatic_restart_authorized: false,
      automatic_kill_authorized: false,
      automatic_replay_authorized: false,
      blockers,
    };
  }

  const proc = processEvidence(health, input?.processes);
  if (!proc.ok) blockers.push(blocker(proc.code));

  const observedRemoteHead = input?.observed_remote_head;
  if (typeof observedRemoteHead !== "string" || !SHA40.test(observedRemoteHead)) {
    blockers.push(blocker("OBSERVED_REMOTE_HEAD_MISSING_OR_INVALID"));
  } else {
    if (health.remote_head !== observedRemoteHead) blockers.push(blocker("REMOTE_HEAD_OBSERVATION_DRIFT"));
    if (health.local_head !== observedRemoteHead) blockers.push(blocker("LOCAL_HEAD_STALE"));
  }

  const mono = monotonicity(input?.previous_health ?? null, health);
  if (!mono.ok) blockers.push(blocker(mono.code, mono.detail ?? null));

  const now = finite(nowUnix) ? nowUnix : Date.now() / 1000;
  const age = Math.max(0, now - health.updated_at_unix);
  const freshBudget = LONG_PHASES.has(health.phase)
    ? Math.max(defaultFreshSeconds, longRunningFreshSeconds)
    : defaultFreshSeconds;
  if (age > freshBudget) blockers.push(blocker("HEALTH_STALE", { age_seconds: age, budget_seconds: freshBudget }));
  if (health.status !== "healthy") blockers.push(blocker("PRODUCER_NOT_HEALTHY", health.status));
  if (health.local_head === null || health.remote_head === null) blockers.push(blocker("HEAD_BINDING_MISSING"));

  let decision = blockers.length === 0 ? "HEALTHY" : "BLOCKED";
  if (blockers.some((item) => ["HEALTH_STALE", "LOCAL_HEAD_STALE", "REMOTE_HEAD_OBSERVATION_DRIFT"].includes(item.code))) {
    decision = "STALE";
  }
  return {
    contract_version: R28_FRESHNESS_GATE_V1,
    decision,
    usable_for_mutation: decision === "HEALTHY",
    read_only_diagnostics_allowed: true,
    live_cutover_authorized: false,
    automatic_restart_authorized: false,
    automatic_kill_authorized: false,
    automatic_replay_authorized: false,
    producer_pin_valid: producerOk,
    evidence_age_seconds: age,
    freshness_budget_seconds: freshBudget,
    restart_observed: mono.restart_observed === true,
    blockers,
  };
}
