import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { validateR31SourcePin } from "./pc-control-direct-candidate.js";
import {
  R33_PREFLIGHT_V1,
  R33_READY,
} from "./r33-live-readonly-canary-preflight.js";
import {
  R37_OPERATOR_LIFECYCLE_V1,
  R37_STATES,
} from "./r37-operator-lifecycle.js";

export const R39_LOCAL_CANARY_V1 = "native_mcp.local_canary.r39.v1";
export const R39_READINESS_V1 = "native_mcp.local_canary_readiness.r39.v1";
export const R39_CUTOVER_PLAN_V1 = "native_mcp.cutover_plan.r39.v1";
export const R39_REBOOT_AUTOSTART_V1 = "native_mcp.reboot_autostart_stage.r39.v1";
export const R39_ISOLATED_IDENTITY_V1 = "native_mcp.isolated_canary_identity.r39.v1";
export const R39_LIFECYCLE_REHEARSAL_V1 = "native_mcp.lifecycle_rehearsal.r39.v1";

export const R39_STATES = Object.freeze([
  "SOURCE_READY",
  "READY_FOR_STAGED_LOCAL_CANARY",
  "BLOCKED",
]);

const REQUIRED_SEQUENCE = Object.freeze([
  "RUNNING",
  "PAUSED",
  "DRAINING",
  "RECONCILIATION_REQUIRED",
  "PAUSED",
  "RUNNING",
  "RUNNING",
]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function r39Digest(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)), "utf8")
    .digest("hex");
}

function clone(value) {
  return structuredClone(value);
}

function blocker(code, detail = null) {
  return { code, detail };
}

function isLoopbackPort(port) {
  return Number.isInteger(port) && port >= 0 && port <= 65535;
}

function isSafeServiceIdentity(value) {
  return typeof value === "string"
    && /^native-mcp-r39-canary-[A-Za-z0-9._-]{1,80}$/.test(value);
}

export function validateR39SourceLineage({
  directPin = null,
  r38Lineage = null,
} = {}) {
  const active = validateR31SourcePin({
    ...(directPin ? { pin: directPin } : {}),
  });
  const lineage = r38Lineage ?? JSON.parse(readFileSync(
    new URL("../conformance/r38_source_pin_recovery/lineage.json", import.meta.url),
    "utf8",
  ));
  const accepted = active.recovery_acceptance;
  const ok = lineage?.contract_version === "native_mcp.source_pin_recovery.r38.v1"
    && lineage?.classification === "LEGITIMATE_ACCEPTED_SUCCESSOR_STALE_CONSUMER_PIN"
    && lineage?.safety?.current_authority === "github_relay"
    && lineage?.safety?.production_cutover === false
    && lineage?.safety?.firewall_or_tunnel_mutation === false
    && lineage?.operator_lifecycle?.contract === R37_OPERATOR_LIFECYCLE_V1
    && lineage?.operator_lifecycle?.automatic_side_effect_replay === false
    && accepted?.status === "accepted"
    && accepted?.ci_run_id === 37405176472
    && accepted?.head_sha === "5241858a029d293f7d200045c585adefc37dde5b"
    && accepted?.conclusion === "success"
    && r39Digest(lineage.active_blobs) === r39Digest(active.active_blobs);
  if (!ok) {
    const error = new Error("R39 source lineage is not the exact accepted R38 authority.");
    error.code = "R39_SOURCE_LINEAGE_INVALID";
    throw error;
  }
  return {
    contract_version: "native_mcp.source_lineage.r39.v1",
    direct_source_contract: active.contract_version,
    r38_contract: lineage.contract_version,
    r38_classification: lineage.classification,
    accepted_ci: clone(accepted),
    active_blobs: clone(active.active_blobs),
    current_authority: "github_relay",
    automatic_side_effect_replay: false,
    production_cutover: false,
  };
}

export function buildR39IsolatedCanaryIdentity({
  repoRoot,
  canaryRoot,
  port = 0,
  serviceIdentity,
  lifecycleStateFile = null,
} = {}) {
  if (typeof repoRoot !== "string" || !repoRoot) throw new TypeError("repoRoot is required");
  if (typeof canaryRoot !== "string" || !canaryRoot) throw new TypeError("canaryRoot is required");
  if (!isLoopbackPort(port)) throw new TypeError("port must be an integer 0..65535");
  if (!isSafeServiceIdentity(serviceIdentity)) throw new TypeError("serviceIdentity is invalid");

  const root = resolve(canaryRoot);
  const repo = resolve(repoRoot);
  const normalizedRoot = process.platform === "win32" ? root.toLowerCase() : root;
  const normalizedRepo = process.platform === "win32" ? repo.toLowerCase() : repo;
  const expectedPrefix = resolve(repo, ".r39-canary");
  const normalizedPrefix = process.platform === "win32"
    ? expectedPrefix.toLowerCase()
    : expectedPrefix;
  if (!(normalizedRoot === normalizedPrefix || normalizedRoot.startsWith(normalizedPrefix + "/")
      || normalizedRoot.startsWith(normalizedPrefix + "\\"))) {
    const error = new Error("R39 canary root must be under the repository .r39-canary directory.");
    error.code = "R39_CANARY_ROOT_NOT_ISOLATED";
    throw error;
  }

  const identity = {
    contract_version: R39_ISOLATED_IDENTITY_V1,
    root,
    bind_host: "127.0.0.1",
    requested_port: port,
    service_identity: serviceIdentity,
    lifecycle_state_file: lifecycleStateFile ?? resolve(root, "operator-lifecycle-r37.json"),
    candidate_descriptor: resolve(root, "candidate.json"),
    evidence_root: resolve(root, "evidence"),
    current_authority: "github_relay",
    current_authority_changed: false,
    isolated_state: true,
    service_registered: false,
    task_registered: false,
    firewall_changed: false,
    tunnel_changed: false,
    production_relay_replaced: false,
    live_cutover_performed: false,
  };
  return {
    ...identity,
    identity_digest: r39Digest(identity),
  };
}

export function validateR39LifecycleRehearsal(evidence) {
  const blockers = [];
  if (!evidence || evidence.contract_version !== R39_LIFECYCLE_REHEARSAL_V1) {
    blockers.push(blocker("R39_LIFECYCLE_REHEARSAL_SCHEMA_MISMATCH"));
  }
  const sequence = Array.isArray(evidence?.states) ? evidence.states : [];
  if (JSON.stringify(sequence) !== JSON.stringify(REQUIRED_SEQUENCE)) {
    blockers.push(blocker("R39_LIFECYCLE_SEQUENCE_INVALID", sequence));
  }
  if (!sequence.every((state) => R37_STATES.includes(state))) {
    blockers.push(blocker("R39_LIFECYCLE_UNKNOWN_STATE"));
  }
  if (evidence?.idempotent_resume !== true) blockers.push(blocker("R39_RESUME_NOT_IDEMPOTENT"));
  if (evidence?.resume_blocked_during_reconciliation !== true) {
    blockers.push(blocker("R39_RECONCILIATION_RESUME_NOT_BLOCKED"));
  }
  if (evidence?.clear_reconciliation_returns_paused !== true) {
    blockers.push(blocker("R39_RECONCILIATION_CLEAR_NOT_PAUSED"));
  }
  if (evidence?.explicit_resume_required !== true) blockers.push(blocker("R39_EXPLICIT_RESUME_NOT_REQUIRED"));
  if (evidence?.automatic_side_effect_replay !== false) blockers.push(blocker("R39_AUTOMATIC_REPLAY_INVALID"));
  if (evidence?.github_relay_fallback_current_authority !== true) {
    blockers.push(blocker("R39_GITHUB_RELAY_FALLBACK_NOT_AUTHORITY"));
  }
  if (evidence?.production_cutover_performed !== false) blockers.push(blocker("R39_PRODUCTION_CUTOVER_DETECTED"));
  return {
    contract_version: R39_LIFECYCLE_REHEARSAL_V1,
    status: blockers.length === 0 ? "PASS" : "BLOCKED",
    blockers,
    states: sequence,
    automatic_side_effect_replay: false,
    production_cutover_performed: false,
  };
}

export function evaluateR39StagedCanary({
  r33Preflight,
  lifecycleStatus,
  lifecycleRehearsal,
  canaryIdentity,
  sourceLineage = null,
  actualCoordinatorRun = false,
} = {}) {
  const blockers = [];
  let lineage = sourceLineage;
  try {
    lineage = lineage ?? validateR39SourceLineage();
  } catch (error) {
    blockers.push(blocker(error?.code ?? "R39_SOURCE_LINEAGE_INVALID"));
  }

  if (!r33Preflight || r33Preflight.contract_version !== R33_PREFLIGHT_V1) {
    blockers.push(blocker("R39_R33_PREFLIGHT_MISSING"));
  } else if (r33Preflight.state !== R33_READY) {
    blockers.push(...(r33Preflight.blockers ?? [blocker("R39_R33_PREFLIGHT_BLOCKED")]));
  }
  if (r33Preflight?.actual_read_only_canary_executed !== false
      || r33Preflight?.actual_pc_control_cutover !== false
      || r33Preflight?.side_effect_probe_count !== 0
      || r33Preflight?.automatic_replay_authorized !== false) {
    blockers.push(blocker("R39_R33_PREFLIGHT_MUTATION_INVARIANT_INVALID"));
  }

  if (!lifecycleStatus || lifecycleStatus.contract_version !== R37_OPERATOR_LIFECYCLE_V1) {
    blockers.push(blocker("R39_LIFECYCLE_STATUS_MISSING"));
  } else {
    if (lifecycleStatus.reconciliation_required === true) blockers.push(blocker("R39_RECONCILIATION_REQUIRED"));
    if (lifecycleStatus.automatic_side_effect_replay !== false) blockers.push(blocker("R39_AUTOMATIC_REPLAY_INVALID"));
    if (lifecycleStatus.components?.github_relay_fallback?.enabled !== true
        || lifecycleStatus.components?.github_relay_fallback?.current_authority !== true
        || lifecycleStatus.components?.github_relay_fallback?.available !== true) {
      blockers.push(blocker("R39_GITHUB_RELAY_FALLBACK_NOT_AVAILABLE"));
    }
    if (lifecycleStatus.authority?.lane !== "github_relay") {
      blockers.push(blocker("R39_AUTHORITY_CHANGED"));
    }
  }

  const rehearsal = validateR39LifecycleRehearsal(lifecycleRehearsal);
  blockers.push(...rehearsal.blockers);

  if (!canaryIdentity || canaryIdentity.contract_version !== R39_ISOLATED_IDENTITY_V1) {
    blockers.push(blocker("R39_CANARY_IDENTITY_MISSING"));
  } else {
    if (canaryIdentity.bind_host !== "127.0.0.1"
        || canaryIdentity.isolated_state !== true
        || canaryIdentity.current_authority !== "github_relay"
        || canaryIdentity.current_authority_changed !== false
        || canaryIdentity.service_registered !== false
        || canaryIdentity.task_registered !== false
        || canaryIdentity.firewall_changed !== false
        || canaryIdentity.tunnel_changed !== false
        || canaryIdentity.production_relay_replaced !== false
        || canaryIdentity.live_cutover_performed !== false) {
      blockers.push(blocker("R39_CANARY_ISOLATION_INVALID"));
    }
  }

  const sourceOnly = actualCoordinatorRun !== true;
  const state = blockers.length > 0
    ? "BLOCKED"
    : sourceOnly
      ? "SOURCE_READY"
      : "READY_FOR_STAGED_LOCAL_CANARY";

  const report = {
    contract_version: R39_LOCAL_CANARY_V1,
    state,
    blockers,
    source_lineage: lineage,
    r33_preflight_digest: r33Preflight?.report_digest ?? null,
    lifecycle_status_digest: lifecycleStatus?.status_digest ?? null,
    lifecycle_rehearsal: rehearsal,
    canary_identity: canaryIdentity ? clone(canaryIdentity) : null,
    actual_coordinator_run: actualCoordinatorRun === true,
    current_authority: "github_relay",
    github_relay_fallback_enabled: true,
    side_effect_mirroring: false,
    automatic_side_effect_replay: false,
    actual_read_only_canary_executed: false,
    actual_pc_control_cutover: false,
    production_relay_replaced: false,
  };
  return {
    ...report,
    report_digest: r39Digest(report),
  };
}

export function buildR39CutoverPlan({
  stagedCanary,
  canaryIdentity,
} = {}) {
  const blockers = [];
  if (!stagedCanary || stagedCanary.contract_version !== R39_LOCAL_CANARY_V1) {
    blockers.push(blocker("R39_STAGED_CANARY_MISSING"));
  }
  if (!["SOURCE_READY", "READY_FOR_STAGED_LOCAL_CANARY"].includes(stagedCanary?.state)) {
    blockers.push(...(stagedCanary?.blockers ?? [blocker("R39_STAGED_CANARY_BLOCKED")]));
  }
  if (!canaryIdentity || canaryIdentity.contract_version !== R39_ISOLATED_IDENTITY_V1) {
    blockers.push(blocker("R39_CANARY_IDENTITY_MISSING"));
  }

  const plan = {
    contract_version: R39_CUTOVER_PLAN_V1,
    state: blockers.length === 0 ? "PLAN_READY" : "BLOCKED",
    blockers,
    apply_authorized: false,
    executable_cutover_action: null,
    production_cutover_performed: false,
    current_authority: "github_relay",
    fallback_authority: "github_relay",
    automatic_side_effect_replay: false,
    required_stopping_rules: [
      "STOP if R33 read-only preflight is not READY_FOR_COORDINATOR_CANARY.",
      "STOP if lifecycle status is RECONCILIATION_REQUIRED.",
      "STOP if any unknown side-effect outcome exists; reconcile explicitly and never replay.",
      "STOP if GitHub relay fallback is unavailable or not current authority.",
      "STOP if isolated candidate identity changes, becomes non-loopback, or uses production state.",
      "STOP if registry/schema/protected-path evidence drifts.",
      "STOP if reboot/autostart staging would register a task/service in this milestone.",
      "This plan is generator-only; a later milestone must explicitly authorize application.",
    ],
    phases: [
      { phase: "preflight", mutation: false, source: "R33" },
      { phase: "isolated_candidate_start", mutation: "isolated_process_only", source: "R32" },
      { phase: "lifecycle_validation", mutation: "isolated_state_only", source: "R37" },
      { phase: "read_only_canary", mutation: false, source: "R32/R33" },
      { phase: "candidate_cleanup", mutation: "isolated_process_only", source: "R32" },
      { phase: "cutover_review", mutation: false, apply: false, source: "R39" },
    ],
    canary_identity_digest: canaryIdentity?.identity_digest ?? null,
  };
  return {
    ...plan,
    plan_digest: r39Digest(plan),
  };
}

export function buildR39RebootAutostartStage({
  canaryIdentity,
  startCommand,
  statusCommand = "node tools/r37-operator-lifecycle.js status",
  resumeCommand = "node tools/r37-operator-lifecycle.js resume",
} = {}) {
  if (!canaryIdentity || canaryIdentity.contract_version !== R39_ISOLATED_IDENTITY_V1) {
    throw new TypeError("valid canaryIdentity is required");
  }
  if (typeof startCommand !== "string" || !startCommand) throw new TypeError("startCommand is required");

  const stage = {
    contract_version: R39_REBOOT_AUTOSTART_V1,
    state: "STAGED_NOT_INSTALLED",
    canary_identity_digest: canaryIdentity.identity_digest,
    persisted_lifecycle_state_file: canaryIdentity.lifecycle_state_file,
    service_identity: canaryIdentity.service_identity,
    loopback_bind_host: canaryIdentity.bind_host,
    requested_port: canaryIdentity.requested_port,
    startup_command: startCommand,
    status_command: statusCommand,
    explicit_resume_command: resumeCommand,
    registration: {
      service_installed: false,
      scheduled_task_installed: false,
      startup_folder_modified: false,
      registry_run_key_modified: false,
    },
    reboot_semantics: {
      persisted_state_respected: true,
      paused_remains_paused: true,
      draining_remains_draining: true,
      reconciliation_required_remains_blocked: true,
      running_requires_existing_persisted_running_state: true,
      explicit_resume_after_reconciliation_clear: true,
      automatic_side_effect_replay: false,
    },
    rollback: {
      command: null,
      reason: "nothing_registered_in_r39",
    },
    current_authority: "github_relay",
    production_cutover_performed: false,
  };
  return {
    ...stage,
    stage_digest: r39Digest(stage),
  };
}

export function evaluateR39Readiness({
  sourceLineage = null,
  stagedCanary = null,
  cutoverPlan = null,
  rebootStage = null,
  exactHead = null,
  ciRunId = null,
  runnerOs = null,
} = {}) {
  const blockers = [];
  let lineage = sourceLineage;
  try {
    lineage = lineage ?? validateR39SourceLineage();
  } catch (error) {
    blockers.push(blocker(error?.code ?? "R39_SOURCE_LINEAGE_INVALID"));
  }
  if (stagedCanary && stagedCanary.state === "BLOCKED") {
    blockers.push(...(stagedCanary.blockers ?? []));
  }
  if (cutoverPlan && cutoverPlan.state === "BLOCKED") {
    blockers.push(...(cutoverPlan.blockers ?? []));
  }
  if (rebootStage && rebootStage.state !== "STAGED_NOT_INSTALLED") {
    blockers.push(blocker("R39_REBOOT_AUTOSTART_STAGE_INVALID"));
  }

  const report = {
    contract_version: R39_READINESS_V1,
    state: blockers.length === 0 ? "SOURCE_READY" : "BLOCKED",
    exact_head: exactHead,
    ci_run_id: ciRunId,
    runner_os: runnerOs,
    source_lineage: lineage,
    staged_canary_state: stagedCanary?.state ?? "NOT_EXECUTED_COORDINATOR_LIVE",
    cutover_plan_state: cutoverPlan?.state ?? "PLAN_NOT_GENERATED_LIVE",
    reboot_autostart_state: rebootStage?.state ?? "STAGED_NOT_INSTALLED",
    blockers,
    current_authority: "github_relay",
    github_relay_fallback_enabled: true,
    actual_local_canary_executed: stagedCanary?.actual_coordinator_run === true,
    automatic_side_effect_replay: false,
    live_remote_registration: false,
    production_cutover: false,
    service_or_task_registration: false,
    firewall_or_tunnel_mutation: false,
  };
  return {
    ...report,
    readiness_digest: r39Digest(report),
  };
}
