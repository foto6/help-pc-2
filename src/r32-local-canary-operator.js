import { createHash } from "node:crypto";
import * as z from "zod/v4";

import {
  TOOL_REGISTRY_DIGEST,
  TOOL_REGISTRY_LIST,
} from "./native-registry.js";
import {
  DC_COMPATIBILITY_REGISTRY_DIGEST,
  DC_COMPATIBILITY_REGISTRY_LIST,
} from "./dc-compatibility-registry.js";
import {
  mcpToolSchema,
  mcpCompatibilityToolSchema,
} from "./mcp-tool-schemas.js";
import {
  PC_CONTROL_PLUGIN_SURFACE_V1,
  PROTECTED_PATH_POLICY_ID,
  digestJson,
} from "./pc-control-direct-candidate.js";

export const R32_AUTHORITY_SNAPSHOT_V1 = "pc.control.r32.authority_snapshot.v1";
export const R32_CANARY_EVIDENCE_V1 = "pc.control.r32.local_canary_evidence.v1";
export const R32_READINESS_V1 = "pc.control.r32.local_canary_readiness.v1";
export const R32_CANDIDATE_DESCRIPTOR_V1 = "pc.control.r32.isolated_candidate.v1";

export const R32_STATES = Object.freeze([
  "SOURCE_READY",
  "READ_ONLY_CANARY_PASS",
  "READY_FOR_EXPLICIT_PLUGIN_CANDIDATE",
  "BLOCKED",
]);

const SAFE_CANARY_TOOLS = new Set(["device.ping", "device.info"]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function r32Digest(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");
}

function schemaDigest(schema) {
  return digestJson(z.toJSONSchema(schema));
}

export function r32SourceAuthorityProfile() {
  const native = TOOL_REGISTRY_LIST.map((tool) => ({
    name: tool.name,
    effect: tool.effect,
    schema_digest: schemaDigest(mcpToolSchema(tool.name)),
    registry: "native",
  }));
  const compatibility = DC_COMPATIBILITY_REGISTRY_LIST.map((tool) => ({
    name: tool.name,
    effect: tool.effect,
    schema_digest: schemaDigest(mcpCompatibilityToolSchema(tool.name)),
    registry: "desktop_commander_compat",
  }));
  const tools = [...native, ...compatibility].sort((a, b) => a.name.localeCompare(b.name));
  return {
    native_registry_digest: TOOL_REGISTRY_DIGEST,
    compatibility_registry_digest: DC_COMPATIBILITY_REGISTRY_DIGEST,
    protected_path_policy: PROTECTED_PATH_POLICY_ID,
    reconciliation_status: "reconciliation_required",
    automatic_replay: false,
    tools,
    tool_surface_digest: r32Digest(tools),
  };
}

function mapWatchdogHealth(watchdog) {
  const state = watchdog?.state ?? "UNKNOWN";
  if (state === "HEALTHY") return "HEALTHY";
  if (state === "RECONCILIATION_REQUIRED") return "BLOCKED";
  if (["STALE", "DUPLICATE_AMBIGUOUS", "PROCESS_MISSING"].includes(state)) return "BLOCKED";
  return "DEGRADED";
}

function sanitizedWatchdog(watchdog) {
  return {
    status_version: watchdog?.status_version ?? null,
    state: watchdog?.state ?? "UNKNOWN",
    observed_at_unix: Number.isFinite(watchdog?.observed_at_unix) ? watchdog.observed_at_unix : null,
    process: watchdog?.process ? {
      logical_process_count: watchdog.process.logical_process_count ?? null,
      health_pid_observed: watchdog.process.health_pid_observed ?? null,
    } : null,
    observations: watchdog?.observations ? {
      head_relation: watchdog.observations.head_relation ?? null,
      local_head: watchdog.observations.local_head ?? null,
      remote_tracking_head: watchdog.observations.remote_tracking_head ?? null,
      remote_tracking_queue: watchdog.observations.remote_tracking_queue ?? null,
      remote_observation_source: watchdog.observations.remote_observation_source ?? null,
    } : null,
    stale_reasons: Array.isArray(watchdog?.stale_reasons)
      ? watchdog.stale_reasons.filter((item) => typeof item === "string").slice(0, 16)
      : [],
    reconciliation_required: watchdog?.health?.reconciliation_required === true,
    recovery: {
      automatic_restart: watchdog?.recovery?.automatic_restart === true,
      automatic_kill: watchdog?.recovery?.automatic_kill === true,
      automatic_side_effect_replay: watchdog?.recovery?.automatic_side_effect_replay === true,
      unknown_side_effect_requires_outcome_lookup:
        watchdog?.recovery?.unknown_side_effect_requires_outcome_lookup === true,
    },
    error_classification: watchdog?.error?.classification ?? null,
  };
}

export function buildR32AuthoritySnapshot({
  watchdogStatus,
  probeLatencyMs = null,
  observedAtMs = Date.now(),
  evidenceOrigin = "coordinator_live_github_relay_snapshot",
} = {}) {
  if (!watchdogStatus || typeof watchdogStatus !== "object" || Array.isArray(watchdogStatus)) {
    throw new TypeError("watchdogStatus must be an object");
  }
  const profile = r32SourceAuthorityProfile();
  const watchdog = sanitizedWatchdog(watchdogStatus);
  const healthStatus = mapWatchdogHealth(watchdogStatus);
  const sourceBound = watchdog.status_version === "pc_relay.watchdog_status.v1";
  const unknown = !sourceBound
    || watchdog.state === "UNKNOWN"
    || watchdog.error_classification !== null
    || watchdog.process?.logical_process_count !== 1
    || watchdog.process?.health_pid_observed !== true;
  const blockers = [];
  if (!sourceBound) blockers.push({ code: "AUTHORITY_WATCHDOG_SCHEMA_MISMATCH" });
  if (unknown) blockers.push({ code: "AUTHORITY_LIVE_EVIDENCE_UNKNOWN" });
  if (healthStatus !== "HEALTHY") blockers.push({ code: "AUTHORITY_HEALTH_NOT_HEALTHY", detail: watchdog.state });
  if (watchdog.reconciliation_required) blockers.push({ code: "AUTHORITY_RECONCILIATION_REQUIRED" });
  if (watchdog.recovery.automatic_side_effect_replay) blockers.push({ code: "AUTHORITY_REPLAY_SEMANTICS_INVALID" });

  const snapshot = {
    contract_version: R32_AUTHORITY_SNAPSHOT_V1,
    evidence_origin: evidenceOrigin,
    observed_at_ms: observedAtMs,
    source_lane: "github_relay",
    current_authority: true,
    live_health: {
      status: healthStatus,
      latency_ms: Number.isFinite(probeLatencyMs) ? probeLatencyMs : null,
      watchdog,
    },
    source_profile: profile,
    blockers,
    safe_for_comparison: blockers.length === 0 && healthStatus === "HEALTHY",
    raw_results_included: false,
    credentials_included: false,
    actual_pc_control_cutover: false,
  };
  return {
    ...snapshot,
    snapshot_digest: r32Digest(snapshot),
  };
}

function toolMapFromAuthority(snapshot) {
  return new Map((snapshot?.source_profile?.tools ?? []).map((tool) => [tool.name, tool]));
}

function toolMapFromCandidate(surface) {
  return new Map((surface?.tools ?? []).map((tool) => [tool.name, {
    name: tool.name,
    effect: tool.effect,
    schema_digest: tool.input_schema_digest,
  }]));
}

function readOnlyCanaryProvesExecutorResponsive(evidence) {
  const calls = Array.isArray(evidence?.calls) ? evidence.calls : [];
  const required = new Set(["device.ping", "device.info"]);
  return evidence?.status === "PASS"
    && evidence?.side_effect_calls === 0
    && evidence?.replay_authorized === false
    && calls.length >= required.size
    && calls.every((call) => call?.effect === "read_only" && call?.status === "completed")
    && [...required].every((name) => calls.some((call) => call?.tool === name));
}

export function compareR32AuthorityCandidate(authoritySnapshot, candidateSurface, {
  maxHealthLatencyMs = 5_000,
  candidateCanaryEvidence = null,
} = {}) {
  const blockers = [];
  const fail = (code, detail = null) => blockers.push({ code, detail });
  const canaryProvesExecutor = readOnlyCanaryProvesExecutorResponsive(candidateCanaryEvidence);
  const candidatePreCanaryOnlyDegraded = canaryProvesExecutor
    && authoritySnapshot?.live_health?.status === "HEALTHY"
    && candidateSurface?.health?.status === "DEGRADED"
    && candidateSurface?.health?.transport_connected === true
    && candidateSurface?.health?.queue_progressing === true
    && candidateSurface?.health?.executor_responsive === false;
  if (authoritySnapshot?.contract_version !== R32_AUTHORITY_SNAPSHOT_V1) {
    fail("AUTHORITY_SNAPSHOT_SCHEMA_MISMATCH");
  }
  if (candidateSurface?.contract_version !== PC_CONTROL_PLUGIN_SURFACE_V1) {
    fail("CANDIDATE_SURFACE_SCHEMA_MISMATCH");
  }
  if (authoritySnapshot?.safe_for_comparison !== true) {
    fail("AUTHORITY_SNAPSHOT_NOT_HEALTHY");
  }
  if (candidateSurface?.health?.status !== authoritySnapshot?.live_health?.status
      && !candidatePreCanaryOnlyDegraded) {
    fail("HEALTH_STATUS_MISMATCH", {
      authority: authoritySnapshot?.live_health?.status ?? "UNKNOWN",
      candidate: candidateSurface?.health?.status ?? "UNKNOWN",
    });
  }
  if (!Number.isFinite(candidateSurface?.health?.latency_ms)
      || candidateSurface.health.latency_ms > maxHealthLatencyMs) {
    fail("CANDIDATE_HEALTH_LATENCY_BOUND");
  }
  if (authoritySnapshot?.source_profile?.native_registry_digest
      !== candidateSurface?.capabilities?.native_registry_digest) {
    fail("REGISTRY_DIGEST_MISMATCH");
  }
  if (authoritySnapshot?.source_profile?.compatibility_registry_digest
      !== candidateSurface?.capabilities?.compatibility_registry_digest) {
    fail("COMPAT_REGISTRY_DIGEST_MISMATCH");
  }
  if (authoritySnapshot?.source_profile?.protected_path_policy
      !== candidateSurface?.capabilities?.protected_path_policy) {
    fail("PROTECTED_PATH_POLICY_MISMATCH");
  }
  if (candidateSurface?.capabilities?.reconciliation_status !== "reconciliation_required"
      || candidateSurface?.capabilities?.automatic_replay !== false) {
    fail("RECONCILIATION_SEMANTICS_MISMATCH");
  }
  if (candidateSurface?.health?.transport_connected !== true
      || (candidateSurface?.health?.executor_responsive !== true && !canaryProvesExecutor)) {
    fail("CANDIDATE_TRANSPORT_NOT_READY");
  }

  const left = toolMapFromAuthority(authoritySnapshot);
  const right = toolMapFromCandidate(candidateSurface);
  const names = [...new Set([...left.keys(), ...right.keys()])].sort();
  for (const name of names) {
    const a = left.get(name);
    const b = right.get(name);
    if (!a || !b) {
      fail("TOOL_SET_MISMATCH", name);
      continue;
    }
    if (a.effect !== b.effect) fail("TOOL_EFFECT_MISMATCH", name);
    if (a.schema_digest !== b.schema_digest) fail("TOOL_SCHEMA_MISMATCH", name);
  }

  return {
    compatible: blockers.length === 0,
    blockers,
    executor_responsiveness_proven_by_read_only_canary: canaryProvesExecutor,
    authority_snapshot_digest: authoritySnapshot?.snapshot_digest ?? null,
    candidate_surface_digest: candidateSurface?.tool_surface_digest ?? null,
  };
}

export function assertR32SafeCanaryTools(candidateSurface, tools) {
  if (!Array.isArray(tools) || tools.length === 0) throw new TypeError("tools must be a non-empty array");
  const index = toolMapFromCandidate(candidateSurface);
  for (const name of tools) {
    if (!SAFE_CANARY_TOOLS.has(name)) {
      const error = new Error(`R32 canary tool is not in the explicit safe allowlist: ${name}`);
      error.code = "R32_CANARY_TOOL_NOT_ALLOWED";
      throw error;
    }
    const tool = index.get(name);
    if (!tool) {
      const error = new Error(`R32 canary tool is not advertised: ${name}`);
      error.code = "R32_CANARY_TOOL_NOT_ADVERTISED";
      throw error;
    }
    if (tool.effect !== "read_only") {
      const error = new Error(`R32 canary refuses side-effect tool: ${name}`);
      error.code = "R32_CANARY_SIDE_EFFECT_REFUSED";
      throw error;
    }
  }
  return true;
}

export function buildR32CanaryEvidence({
  authoritySnapshot,
  candidateSurface,
  candidateCanaryEvidence,
  initializeStatus = "PASS",
  evidenceOrigin = "synthetic_ci",
  actualCoordinatorRun = false,
  candidateDescriptor = null,
  startedAtMs = null,
  completedAtMs = null,
} = {}) {
  const comparison = compareR32AuthorityCandidate(authoritySnapshot, candidateSurface, {
    candidateCanaryEvidence,
  });
  const liveOrigin = evidenceOrigin === "coordinator_live_read_only_canary"
    && actualCoordinatorRun === true;
  const isolated = candidateDescriptor?.contract_version === R32_CANDIDATE_DESCRIPTOR_V1
    && candidateDescriptor?.bind_host === "127.0.0.1"
    && candidateDescriptor?.isolated_state === true
    && candidateDescriptor?.service_or_task_registered === false
    && candidateDescriptor?.firewall_or_tunnel_changed === false;
  const candidatePass = candidateCanaryEvidence?.status === "PASS"
    && candidateCanaryEvidence?.side_effect_calls === 0
    && candidateCanaryEvidence?.replay_authorized === false;
  const blockers = [...comparison.blockers];
  if (initializeStatus !== "PASS") blockers.push({ code: "MCP_INITIALIZE_FAILED" });
  if (!candidatePass) blockers.push({ code: "DIRECT_READ_ONLY_CANARY_FAILED" });
  if (liveOrigin && !isolated) blockers.push({ code: "ISOLATED_CANDIDATE_IDENTITY_INVALID" });

  let state = "SOURCE_READY";
  if (blockers.length > 0) state = "BLOCKED";
  else if (liveOrigin) state = "READ_ONLY_CANARY_PASS";

  const evidence = {
    contract_version: R32_CANARY_EVIDENCE_V1,
    state,
    evidence_origin: evidenceOrigin,
    actual_coordinator_run: actualCoordinatorRun === true,
    synthetic_evidence: !liveOrigin,
    started_at_ms: startedAtMs,
    completed_at_ms: completedAtMs,
    initialize_status: initializeStatus,
    authority_snapshot_digest: authoritySnapshot?.snapshot_digest ?? null,
    candidate_surface_digest: candidateSurface?.tool_surface_digest ?? null,
    candidate_canary_digest: candidateCanaryEvidence ? r32Digest(candidateCanaryEvidence) : null,
    comparison,
    side_effect_calls: candidateCanaryEvidence?.side_effect_calls ?? 0,
    replay_authorized: false,
    fallback_authorized: false,
    current_authority: "github_relay",
    current_authority_changed: false,
    candidate_process_isolated: isolated,
    actual_pc_control_cutover: false,
    blockers,
  };
  return {
    ...evidence,
    evidence_digest: r32Digest(evidence),
  };
}

export function evaluateR32Readiness({
  sourceReady = true,
  canaryEvidence = null,
  explicitPluginCandidateReview = false,
} = {}) {
  if (sourceReady !== true) {
    return {
      contract_version: R32_READINESS_V1,
      state: "BLOCKED",
      blockers: [{ code: "SOURCE_NOT_READY" }],
      actual_pc_control_cutover: false,
    };
  }
  if (!canaryEvidence) {
    return {
      contract_version: R32_READINESS_V1,
      state: "SOURCE_READY",
      blockers: [],
      actual_pc_control_cutover: false,
      current_authority: "github_relay",
    };
  }
  if (canaryEvidence.state === "BLOCKED") {
    return {
      contract_version: R32_READINESS_V1,
      state: "BLOCKED",
      blockers: canaryEvidence.blockers ?? [],
      actual_pc_control_cutover: false,
      current_authority: "github_relay",
    };
  }
  if (canaryEvidence.state !== "READ_ONLY_CANARY_PASS"
      || canaryEvidence.actual_coordinator_run !== true
      || canaryEvidence.synthetic_evidence !== false
      || canaryEvidence.side_effect_calls !== 0
      || canaryEvidence.replay_authorized !== false
      || canaryEvidence.current_authority_changed !== false) {
    return {
      contract_version: R32_READINESS_V1,
      state: "SOURCE_READY",
      blockers: [],
      actual_pc_control_cutover: false,
      current_authority: "github_relay",
    };
  }
  return {
    contract_version: R32_READINESS_V1,
    state: explicitPluginCandidateReview
      ? "READY_FOR_EXPLICIT_PLUGIN_CANDIDATE"
      : "READ_ONLY_CANARY_PASS",
    blockers: [],
    actual_pc_control_cutover: false,
    current_authority: "github_relay",
  };
}

export function validateR32CandidateDescriptor(descriptor) {
  if (!descriptor || descriptor.contract_version !== R32_CANDIDATE_DESCRIPTOR_V1) return false;
  return descriptor.bind_host === "127.0.0.1"
    && Number.isInteger(descriptor.pid) && descriptor.pid > 0
    && typeof descriptor.mcp_endpoint === "string"
    && descriptor.mcp_endpoint.startsWith("http://127.0.0.1:")
    && descriptor.isolated_state === true
    && descriptor.service_or_task_registered === false
    && descriptor.firewall_or_tunnel_changed === false
    && descriptor.current_authority_changed === false;
}
