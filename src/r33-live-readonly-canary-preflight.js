import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  PROTECTED_PATH_POLICY_ID,
} from "./pc-control-direct-candidate.js";
import {
  R32_AUTHORITY_SNAPSHOT_V1,
  r32SourceAuthorityProfile,
  r32Digest,
} from "./r32-local-canary-operator.js";
import { relayDigestJson } from "./native-relay-protocol.js";

export const R33_PREFLIGHT_V1 = "pc.control.r33.live_readonly_canary_preflight.v1";
export const R33_DISCOVERY_V1 = "pc.control.r33.runtime_discovery.v1";
export const R33_NATIVE_RELAY_PROBE_V1 = "pc.control.r33.native_relay_probe.v1";
export const R33_READY = "READY_FOR_COORDINATOR_CANARY";
export const R33_BLOCKED = "BLOCKED";

export const R33_BLOCKERS = Object.freeze({
  MISSING_CREDENTIAL_PATH: "BLOCKED_MISSING_CREDENTIAL_PATH",
  RELAY_CHECKOUT_NOT_DISCOVERED: "BLOCKED_RELAY_CHECKOUT_NOT_DISCOVERED",
  RELAY_PROCESS_AMBIGUOUS: "BLOCKED_RELAY_PROCESS_AMBIGUOUS",
  AUTHORITY_SNAPSHOT_MISSING: "BLOCKED_AUTHORITY_SNAPSHOT_MISSING",
  AUTHORITY_SCHEMA_MISMATCH: "BLOCKED_AUTHORITY_SCHEMA_MISMATCH",
  AUTHORITY_NOT_HEALTHY: "BLOCKED_AUTHORITY_NOT_HEALTHY",
  AUTHORITY_RECONCILIATION_REQUIRED: "BLOCKED_AUTHORITY_RECONCILIATION_REQUIRED",
  AUTHORITY_HEAD_RELATION: "BLOCKED_AUTHORITY_HEAD_RELATION",
  AUTHORITY_STALE_QUEUE: "BLOCKED_AUTHORITY_STALE_QUEUE",
  SOURCE_PROFILE_DRIFT: "BLOCKED_SOURCE_PROFILE_DRIFT",
  PROTECTED_POLICY_DRIFT: "BLOCKED_PROTECTED_POLICY_DRIFT",
  NATIVE_RELAY_ORIGIN_MISSING: "BLOCKED_NATIVE_RELAY_ORIGIN_MISSING",
  NATIVE_RELAY_ORIGIN_UNSAFE: "BLOCKED_NATIVE_RELAY_ORIGIN_UNSAFE",
  NATIVE_RELAY_UNAVAILABLE: "BLOCKED_NATIVE_RELAY_UNAVAILABLE",
  NATIVE_RELAY_UNHEALTHY: "BLOCKED_NATIVE_RELAY_UNHEALTHY",
  DEVICE_IDENTITY_MISSING: "BLOCKED_DEVICE_IDENTITY_MISSING",
  DEVICE_IDENTITY_AMBIGUOUS: "BLOCKED_DEVICE_IDENTITY_AMBIGUOUS",
  DEVICE_OFFLINE: "BLOCKED_DEVICE_OFFLINE",
  DEVICE_CAPABILITY_DIGEST: "BLOCKED_DEVICE_CAPABILITY_DIGEST",
  DEVICE_EXECUTOR_DIGEST: "BLOCKED_DEVICE_EXECUTOR_DIGEST",
  REPLAY_SEMANTICS_INVALID: "BLOCKED_REPLAY_SEMANTICS_INVALID",
});

function blocker(code, detail = null) {
  return { code, detail };
}

function sameJson(left, right) {
  return r32Digest(left) === r32Digest(right);
}

function normalizeLoopbackOrigin(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!["127.0.0.1", "::1", "localhost"].includes(hostname)) return null;
  if (!["http:", "https:"].includes(url.protocol)) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  url.pathname = "/";
  return url.origin;
}

function validateSourceProfile(snapshot) {
  const expected = r32SourceAuthorityProfile();
  const actual = snapshot?.source_profile;
  if (!actual || typeof actual !== "object") {
    return { ok: false, code: R33_BLOCKERS.SOURCE_PROFILE_DRIFT };
  }
  if (actual.native_registry_digest !== expected.native_registry_digest
      || actual.compatibility_registry_digest !== expected.compatibility_registry_digest
      || actual.protected_path_policy !== PROTECTED_PATH_POLICY_ID
      || actual.reconciliation_status !== "reconciliation_required"
      || actual.automatic_replay !== false
      || actual.tool_surface_digest !== expected.tool_surface_digest
      || !sameJson(actual.tools, expected.tools)) {
    return { ok: false, code: R33_BLOCKERS.SOURCE_PROFILE_DRIFT };
  }
  return { ok: true, expected };
}

function evaluateAuthority(snapshot) {
  const blockers = [];
  if (!snapshot) {
    blockers.push(blocker(R33_BLOCKERS.AUTHORITY_SNAPSHOT_MISSING));
    return blockers;
  }
  if (snapshot.contract_version !== R32_AUTHORITY_SNAPSHOT_V1
      || snapshot.source_lane !== "github_relay"
      || snapshot.current_authority !== true) {
    blockers.push(blocker(R33_BLOCKERS.AUTHORITY_SCHEMA_MISMATCH));
    return blockers;
  }

  const health = snapshot.live_health;
  const watchdog = health?.watchdog;
  if (snapshot.safe_for_comparison !== true
      || health?.status !== "HEALTHY"
      || watchdog?.state !== "HEALTHY") {
    blockers.push(blocker(R33_BLOCKERS.AUTHORITY_NOT_HEALTHY, {
      health_status: health?.status ?? "UNKNOWN",
      watchdog_state: watchdog?.state ?? "UNKNOWN",
    }));
  }
  if (watchdog?.reconciliation_required === true) {
    blockers.push(blocker(R33_BLOCKERS.AUTHORITY_RECONCILIATION_REQUIRED));
  }
  if (watchdog?.recovery?.automatic_side_effect_replay !== false
      || watchdog?.recovery?.unknown_side_effect_requires_outcome_lookup !== true) {
    blockers.push(blocker(R33_BLOCKERS.REPLAY_SEMANTICS_INVALID));
  }
  if (watchdog?.observations?.head_relation !== "equal"
      || typeof watchdog?.observations?.local_head !== "string"
      || watchdog.observations.local_head !== watchdog?.observations?.remote_tracking_head) {
    blockers.push(blocker(R33_BLOCKERS.AUTHORITY_HEAD_RELATION, {
      head_relation: watchdog?.observations?.head_relation ?? "unknown",
    }));
  }
  const staleReasons = watchdog?.stale_reasons;
  if (!Array.isArray(staleReasons) || staleReasons.length !== 0) {
    blockers.push(blocker(R33_BLOCKERS.AUTHORITY_STALE_QUEUE, {
      stale_reasons: Array.isArray(staleReasons) ? staleReasons : ["missing_stale_evidence"],
    }));
  }

  const profile = validateSourceProfile(snapshot);
  if (!profile.ok) blockers.push(blocker(profile.code));
  if (snapshot?.source_profile?.protected_path_policy !== PROTECTED_PATH_POLICY_ID) {
    blockers.push(blocker(R33_BLOCKERS.PROTECTED_POLICY_DRIFT));
  }
  return blockers;
}

function sanitizeDevice(device) {
  return {
    device_id: typeof device?.device_id === "string" ? device.device_id : null,
    online: device?.online === true,
    status: typeof device?.status === "string" ? device.status : null,
    credential_generation: Number.isInteger(device?.credential_generation)
      ? device.credential_generation : null,
    last_session_epoch_present:
      typeof device?.last_session_epoch === "string" && device.last_session_epoch.length > 0,
    last_seen_at_ms: Number.isFinite(device?.last_seen_at_ms) ? device.last_seen_at_ms : null,
    capabilities_digest: typeof device?.capabilities_digest === "string"
      ? device.capabilities_digest : null,
    executor_digest: typeof device?.capabilities?.executor?.digest === "string"
      ? device.capabilities.executor.digest : null,
  };
}

function evaluateNativeRelay(discovery) {
  const blockers = [];
  const origin = normalizeLoopbackOrigin(discovery?.native_relay?.origin);
  if (!discovery?.native_relay?.origin) {
    blockers.push(blocker(R33_BLOCKERS.NATIVE_RELAY_ORIGIN_MISSING));
  } else if (!origin) {
    blockers.push(blocker(R33_BLOCKERS.NATIVE_RELAY_ORIGIN_UNSAFE));
  }

  const tokenPath = discovery?.credential_path;
  if (typeof tokenPath !== "string" || !tokenPath.trim()) {
    blockers.push(blocker(R33_BLOCKERS.MISSING_CREDENTIAL_PATH));
  }

  const probe = discovery?.native_relay?.probe;
  if (!probe) {
    blockers.push(blocker(R33_BLOCKERS.NATIVE_RELAY_UNAVAILABLE));
    return { blockers, origin, selectedDevice: null, sanitizedHealth: null };
  }
  if (probe.contract_version !== R33_NATIVE_RELAY_PROBE_V1) {
    blockers.push(blocker(R33_BLOCKERS.NATIVE_RELAY_UNAVAILABLE, "probe_contract_mismatch"));
  }
  const health = probe.health;
  if (!health || health.status !== "ok"
      || health.running !== true
      || health.process_alive !== true
      || health.transport_connected !== true
      || health.queue_progressing !== true
      || health.executor_responsive !== true) {
    blockers.push(blocker(R33_BLOCKERS.NATIVE_RELAY_UNHEALTHY, {
      status: health?.status ?? "UNKNOWN",
      running: health?.running ?? null,
      transport_connected: health?.transport_connected ?? null,
      queue_progressing: health?.queue_progressing ?? null,
      executor_responsive: health?.executor_responsive ?? null,
    }));
  }

  const devices = Array.isArray(probe.devices) ? probe.devices : [];
  const requestedId = discovery?.native_device_id ?? null;
  const online = devices.filter((item) => item?.online === true);
  let selected = null;
  if (requestedId) {
    selected = devices.find((item) => item?.device_id === requestedId) ?? null;
    if (!selected) blockers.push(blocker(R33_BLOCKERS.DEVICE_IDENTITY_MISSING, requestedId));
  } else if (online.length === 1) {
    selected = online[0];
  } else if (online.length === 0) {
    blockers.push(blocker(R33_BLOCKERS.DEVICE_IDENTITY_MISSING));
  } else {
    blockers.push(blocker(R33_BLOCKERS.DEVICE_IDENTITY_AMBIGUOUS, {
      online_device_count: online.length,
    }));
  }

  if (selected) {
    if (selected.online !== true || typeof selected.last_session_epoch !== "string"
        || !selected.last_session_epoch) {
      blockers.push(blocker(R33_BLOCKERS.DEVICE_OFFLINE, selected.device_id ?? null));
    }
    if (!selected.capabilities || typeof selected.capabilities !== "object"
        || typeof selected.capabilities_digest !== "string"
        || relayDigestJson(selected.capabilities) !== selected.capabilities_digest) {
      blockers.push(blocker(R33_BLOCKERS.DEVICE_CAPABILITY_DIGEST));
    }
    if (typeof selected?.capabilities?.executor?.digest !== "string"
        || !selected.capabilities.executor.digest) {
      blockers.push(blocker(R33_BLOCKERS.DEVICE_EXECUTOR_DIGEST));
    }
  }

  return {
    blockers,
    origin,
    selectedDevice: selected ? sanitizeDevice(selected) : null,
    sanitizedHealth: health ? {
      status: health.status ?? null,
      running: health.running === true,
      process_alive: health.process_alive === true,
      transport_connected: health.transport_connected === true,
      queue_progressing: health.queue_progressing === true,
      executor_responsive: health.executor_responsive === true,
      pending_deliveries: Number.isInteger(health.pending_deliveries)
        ? health.pending_deliveries : null,
      oldest_pending_age_ms: Number.isFinite(health.oldest_pending_age_ms)
        ? health.oldest_pending_age_ms : null,
      stalest_pending_progress_age_ms: Number.isFinite(health.stalest_pending_progress_age_ms)
        ? health.stalest_pending_progress_age_ms : null,
      online_devices: Number.isInteger(health.online_devices) ? health.online_devices : null,
    } : null,
  };
}

function quotePowerShell(value) {
  return "'" + String(value).replaceAll("'", "''") + "'";
}

export function buildR33RunCanaryCommand({
  repoRoot,
  relayRepo,
  nativeRelayOrigin,
  credentialPath,
  nativeDeviceId,
  nativeDesktopId = "desktop-A",
  outputDir,
} = {}) {
  for (const [name, value] of Object.entries({
    repoRoot, relayRepo, nativeRelayOrigin, credentialPath, nativeDeviceId, outputDir,
  })) {
    if (typeof value !== "string" || !value) {
      throw new TypeError(`${name} is required for RunCanary command generation`);
    }
  }
  const script = resolve(repoRoot, "tools", "r32-local-canary-operator.ps1");
  return [
    "pwsh", "-NoProfile", "-File", quotePowerShell(script),
    "-Action", "RunCanary",
    "-ExplicitLiveReadOnlyCanary",
    "-RepoRoot", quotePowerShell(repoRoot),
    "-RunDir", quotePowerShell(outputDir),
    "-RelayRepo", quotePowerShell(relayRepo),
    "-NativeRelayUrl", quotePowerShell(nativeRelayOrigin),
    "-NativeRelayTokenFile", quotePowerShell(credentialPath),
    "-NativeDeviceId", quotePowerShell(nativeDeviceId),
    "-NativeDesktopId", quotePowerShell(nativeDesktopId),
  ].join(" ");
}

export function evaluateR33Preflight(discovery, {
  repoRoot = process.cwd(),
  outputDir = null,
} = {}) {
  const blockers = [];

  if (!discovery || discovery.contract_version !== R33_DISCOVERY_V1) {
    blockers.push(blocker("BLOCKED_DISCOVERY_SCHEMA_MISMATCH"));
  }
  if (typeof discovery?.relay_checkout !== "string" || !discovery.relay_checkout) {
    blockers.push(blocker(R33_BLOCKERS.RELAY_CHECKOUT_NOT_DISCOVERED));
  }
  const processEvidence = discovery?.relay_process;
  if (!processEvidence || processEvidence.logical_process_count !== 1
      || !Number.isInteger(processEvidence.runtime_pid)
      || processEvidence.runtime_pid < 1) {
    blockers.push(blocker(R33_BLOCKERS.RELAY_PROCESS_AMBIGUOUS));
  }

  blockers.push(...evaluateAuthority(discovery?.authority_snapshot ?? null));
  const native = evaluateNativeRelay(discovery);
  blockers.push(...native.blockers);

  const unique = [];
  const seen = new Set();
  for (const item of blockers) {
    const key = `${item.code}\0${JSON.stringify(item.detail)}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(item);
    }
  }

  let command = null;
  const chosenDevice = native.selectedDevice?.device_id ?? null;
  if (unique.length === 0) {
    command = buildR33RunCanaryCommand({
      repoRoot,
      relayRepo: discovery.relay_checkout,
      nativeRelayOrigin: native.origin,
      credentialPath: discovery.credential_path,
      nativeDeviceId: chosenDevice,
      nativeDesktopId: discovery.native_desktop_id ?? "desktop-A",
      outputDir: outputDir ?? resolve(repoRoot, ".r33-canary", "coordinator-live"),
    });
  }

  const report = {
    contract_version: R33_PREFLIGHT_V1,
    state: unique.length === 0 ? R33_READY : R33_BLOCKED,
    blockers: unique,
    current_authority: "github_relay",
    current_authority_changed: false,
    actual_read_only_canary_executed: false,
    read_only_canary_pass_claimed: false,
    actual_pc_control_cutover: false,
    side_effect_probe_count: 0,
    automatic_replay_authorized: false,
    fallback_authorized: false,
    live_mutation_authorized: false,
    discovery: {
      relay_checkout: discovery?.relay_checkout ?? null,
      relay_process: processEvidence ? {
        runtime_pid: processEvidence.runtime_pid ?? null,
        parent_pid: processEvidence.parent_pid ?? null,
        logical_process_count: processEvidence.logical_process_count ?? null,
      } : null,
      authority_snapshot_digest: discovery?.authority_snapshot?.snapshot_digest ?? null,
      native_relay_origin: native.origin,
      credential_path_present: typeof discovery?.credential_path === "string"
        && discovery.credential_path.length > 0,
      selected_device: native.selectedDevice,
      native_relay_health: native.sanitizedHealth,
    },
    expected_source_profile: {
      native_registry_digest: r32SourceAuthorityProfile().native_registry_digest,
      compatibility_registry_digest: r32SourceAuthorityProfile().compatibility_registry_digest,
      protected_path_policy: PROTECTED_PATH_POLICY_ID,
      tool_surface_digest: r32SourceAuthorityProfile().tool_surface_digest,
    },
    run_canary_command: command,
  };
  return {
    ...report,
    report_digest: r32Digest(report),
  };
}

export function loadR33SourcePin() {
  return JSON.parse(readFileSync(
    new URL("../conformance/r33_live_readonly_preflight/source-pin.json", import.meta.url),
    "utf8",
  ));
}
