import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export const R37_OPERATOR_LIFECYCLE_V1 = "native_mcp.operator_lifecycle.r37.v1";
export const R37_DIRECT_HOST_REHEARSAL_V1 = "native_mcp.direct_host_rehearsal.r37.v1";
export const R37_CUTOVER_READINESS_V1 = "native_mcp.cutover_readiness.r37.v1";
export const R37_PINNED_AUTHORITY_SHA = "6f44216e7e5fbf9fe3ae635f302c3c33887e0930";
export const R37_PINNED_AUTHORITY_VERSION = "pc.native.r29.relay_cutover_qa_pin.v1";
export const R37_STATES = Object.freeze([
  "RUNNING",
  "PAUSED",
  "DRAINING",
  "RECONCILIATION_REQUIRED",
]);
export const R37_COMPONENTS = Object.freeze([
  "native_mcp_host",
  "control_service",
  "executor",
  "github_relay_fallback",
  "direct_lane",
]);

const STATE_VERSION = 1;
const EFFECT_READ_ONLY = "read_only";
const EFFECT_SIDE_EFFECT = "side_effect";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

export function r37Digest(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)), "utf8")
    .digest("hex");
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function requireText(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new R37OperatorLifecycleError(`${name} must be a non-empty string.`, {
      code: "R37_INVALID_ARGUMENT",
    });
  }
  return value.trim();
}

function normalizeRequestId(value) {
  if (value === null || value === undefined) return null;
  return requireText(value, "requestId");
}

function validatePersistedState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new R37OperatorLifecycleError("R37 lifecycle state is not an object.", {
      code: "R37_STATE_CORRUPTED",
    });
  }
  if (value.store_version !== STATE_VERSION ||
      value.contract_version !== R37_OPERATOR_LIFECYCLE_V1 ||
      !R37_STATES.includes(value.operator_state) ||
      !Number.isInteger(value.generation) || value.generation < 0 ||
      !Number.isFinite(value.updated_at_ms) ||
      !value.authority || typeof value.authority !== "object" ||
      value.authority.lane !== "github_relay" ||
      value.automatic_side_effect_replay !== false ||
      value.live_pc_control_cutover !== false ||
      !value.reconciliation || typeof value.reconciliation !== "object" ||
      value.reconciliation.required !== (value.reconciliation.request_ids?.length > 0) ||
      !Array.isArray(value.reconciliation.request_ids) ||
      value.reconciliation.request_ids.some((id) => typeof id !== "string" || !id)) {
    throw new R37OperatorLifecycleError("R37 lifecycle state schema is invalid.", {
      code: "R37_STATE_CORRUPTED",
    });
  }
  if (value.operator_state === "RECONCILIATION_REQUIRED" &&
      value.reconciliation.required !== true) {
    throw new R37OperatorLifecycleError(
      "R37 reconciliation state lost its unknown-outcome evidence.",
      { code: "R37_STATE_CORRUPTED" },
    );
  }
  return value;
}

function defaultState({
  authoritySha = R37_PINNED_AUTHORITY_SHA,
  authorityVersion = R37_PINNED_AUTHORITY_VERSION,
  now = Date.now(),
} = {}) {
  return {
    store_version: STATE_VERSION,
    contract_version: R37_OPERATOR_LIFECYCLE_V1,
    operator_state: "RUNNING",
    generation: 0,
    updated_at_ms: now,
    pause_reason: null,
    draining_since_ms: null,
    reconciliation: {
      required: false,
      request_ids: [],
    },
    authority: {
      lane: "github_relay",
      sha: typeof authoritySha === "string" && authoritySha ? authoritySha : null,
      version: typeof authorityVersion === "string" && authorityVersion
        ? authorityVersion
        : null,
      verified: Boolean(authoritySha && authorityVersion),
    },
    automatic_side_effect_replay: false,
    live_pc_control_cutover: false,
  };
}

export class R37OperatorLifecycleError extends Error {
  constructor(message, {
    code = "R37_OPERATOR_LIFECYCLE_ERROR",
    state = null,
    details = null,
  } = {}) {
    super(message);
    this.name = "R37OperatorLifecycleError";
    this.code = code;
    this.state = state;
    this.details = details;
  }
}

export class JsonR37OperatorLifecycleStore {
  constructor(path) {
    this.path = requireText(path, "path");
  }

  load() {
    if (!existsSync(this.path)) return null;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8"));
    } catch (error) {
      throw new R37OperatorLifecycleError(
        `R37 lifecycle state is corrupted: ${error.message}`,
        { code: "R37_STATE_CORRUPTED" },
      );
    }
    return clone(validatePersistedState(parsed));
  }

  save(state) {
    validatePersistedState(state);
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      renameSync(temp, this.path);
    } catch (error) {
      try { unlinkSync(temp); } catch {}
      throw error;
    }
  }
}

function normalizeComponent(value, {
  defaultStatus = "UNKNOWN",
  defaultAvailable = false,
} = {}) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const status = typeof raw.status === "string" && raw.status
    ? raw.status
    : defaultStatus;
  return {
    status,
    available: typeof raw.available === "boolean" ? raw.available : defaultAvailable,
    version: typeof raw.version === "string" && raw.version ? raw.version : null,
    sha: typeof raw.sha === "string" && raw.sha ? raw.sha : null,
    detail: typeof raw.detail === "string" && raw.detail ? raw.detail : null,
  };
}

function probeFailure(error) {
  return {
    status: "UNKNOWN",
    available: false,
    version: null,
    sha: null,
    detail: typeof error?.code === "string" && error.code
      ? error.code
      : "PROBE_FAILED",
  };
}

export class R37OperatorLifecycle {
  constructor({
    store = null,
    authoritySha = null,
    authorityVersion = null,
    probes = {},
    clock = Date.now,
  } = {}) {
    if (store !== null &&
        (typeof store.load !== "function" || typeof store.save !== "function")) {
      throw new TypeError("store must expose load() and save().");
    }
    if (typeof clock !== "function") throw new TypeError("clock must be a function.");
    this.store = store;
    this.clock = clock;
    this.probes = { ...probes };
    const loaded = store?.load() ?? null;
    this.state = loaded ?? defaultState({
      authoritySha,
      authorityVersion,
      now: this.clock(),
    });
    validatePersistedState(this.state);
    if (loaded === null) this.#persist();
  }

  #persist() {
    this.store?.save(this.state);
  }

  #reload() {
    if (!this.store) return;
    const loaded = this.store.load();
    if (loaded) this.state = validatePersistedState(loaded);
  }

  #transition(nextState, patch = {}) {
    this.#reload();
    if (!R37_STATES.includes(nextState)) {
      throw new R37OperatorLifecycleError("Unsupported R37 operator state.", {
        code: "R37_INVALID_STATE",
      });
    }
    const next = {
      ...this.state,
      ...patch,
      operator_state: nextState,
    };
    const before = JSON.stringify(this.state);
    const afterComparable = JSON.stringify({
      ...next,
      generation: this.state.generation,
      updated_at_ms: this.state.updated_at_ms,
    });
    const beforeComparable = JSON.stringify({
      ...this.state,
      generation: this.state.generation,
      updated_at_ms: this.state.updated_at_ms,
    });
    if (afterComparable === beforeComparable) return clone(this.state);
    next.generation = this.state.generation + 1;
    next.updated_at_ms = this.clock();
    validatePersistedState(next);
    this.state = next;
    this.#persist();
    return clone(this.state);
  }

  pause(reason = "operator_pause") {
    this.#reload();
    if (this.state.operator_state === "RECONCILIATION_REQUIRED") {
      return clone(this.state);
    }
    return this.#transition("PAUSED", {
      pause_reason: requireText(reason, "reason"),
      draining_since_ms: null,
    });
  }

  drain() {
    this.#reload();
    if (this.state.operator_state === "RECONCILIATION_REQUIRED") {
      return clone(this.state);
    }
    if (this.state.operator_state === "DRAINING") return clone(this.state);
    return this.#transition("DRAINING", {
      pause_reason: null,
      draining_since_ms: this.clock(),
    });
  }

  resume() {
    this.#reload();
    if (this.state.reconciliation.required ||
        this.state.operator_state === "RECONCILIATION_REQUIRED") {
      throw new R37OperatorLifecycleError(
        "Unknown side-effect outcomes require explicit reconciliation before resume.",
        {
          code: "R37_RECONCILIATION_REQUIRED",
          state: "RECONCILIATION_REQUIRED",
          details: {
            request_ids: [...this.state.reconciliation.request_ids],
            automatic_replay: false,
          },
        },
      );
    }
    if (this.state.operator_state === "RUNNING") return clone(this.state);
    return this.#transition("RUNNING", {
      pause_reason: null,
      draining_since_ms: null,
    });
  }

  requireReconciliation(requestId) {
    const id = requireText(requestId, "requestId");
    this.#reload();
    const ids = [...new Set([...this.state.reconciliation.request_ids, id])].sort();
    return this.#transition("RECONCILIATION_REQUIRED", {
      pause_reason: null,
      draining_since_ms: null,
      reconciliation: {
        required: true,
        request_ids: ids,
      },
    });
  }

  clearReconciliation(requestId) {
    const id = requireText(requestId, "requestId");
    this.#reload();
    const ids = this.state.reconciliation.request_ids.filter((item) => item !== id);
    if (ids.length > 0) {
      return this.#transition("RECONCILIATION_REQUIRED", {
        reconciliation: {
          required: true,
          request_ids: ids,
        },
      });
    }
    return this.#transition("PAUSED", {
      pause_reason: "reconciliation_cleared_explicit_resume_required",
      draining_since_ms: null,
      reconciliation: {
        required: false,
        request_ids: [],
      },
    });
  }

  assertSideEffectAdmission({
    effect,
    requestId = null,
  } = {}) {
    this.#reload();
    if (effect === EFFECT_READ_ONLY) return true;
    if (effect !== EFFECT_SIDE_EFFECT) {
      throw new R37OperatorLifecycleError("Action effect classification is required.", {
        code: "R37_EFFECT_CLASSIFICATION_REQUIRED",
        state: this.state.operator_state,
      });
    }
    if (this.state.operator_state === "RUNNING" &&
        this.state.reconciliation.required === false) {
      return true;
    }
    const code = this.state.operator_state === "RECONCILIATION_REQUIRED"
      ? "R37_RECONCILIATION_REQUIRED"
      : "R37_SIDE_EFFECT_DISPATCH_PAUSED";
    throw new R37OperatorLifecycleError(
      `Side-effect dispatch is blocked while operator state is ${this.state.operator_state}.`,
      {
        code,
        state: this.state.operator_state,
        details: {
          request_id: normalizeRequestId(requestId),
          automatic_replay: false,
        },
      },
    );
  }

  async #probe(name) {
    const probe = this.probes[name];
    if (typeof probe !== "function") {
      return normalizeComponent(null);
    }
    try {
      return normalizeComponent(await probe());
    } catch (error) {
      return probeFailure(error);
    }
  }

  async status() {
    this.#reload();
    const [
      nativeMcpHost,
      controlService,
      executor,
      githubRelayFallback,
      directLane,
    ] = await Promise.all([
      this.#probe("nativeMcpHost"),
      this.#probe("controlService"),
      this.#probe("executor"),
      this.#probe("githubRelayFallback"),
      this.#probe("directLane"),
    ]);
    let externalReconciliation = false;
    if (typeof this.probes.reconciliation === "function") {
      try {
        const value = await this.probes.reconciliation();
        externalReconciliation = value?.required === true;
      } catch {
        externalReconciliation = true;
      }
    }
    const reconciliationRequired =
      this.state.reconciliation.required || externalReconciliation;
    const operatorState = reconciliationRequired
      ? "RECONCILIATION_REQUIRED"
      : this.state.operator_state;
    const snapshot = {
      contract_version: R37_OPERATOR_LIFECYCLE_V1,
      operator_state: operatorState,
      persisted_operator_state: this.state.operator_state,
      generation: this.state.generation,
      observed_at_ms: this.clock(),
      components: {
        native_mcp_host: nativeMcpHost,
        control_service: controlService,
        executor,
        github_relay_fallback: {
          ...githubRelayFallback,
          enabled: true,
          current_authority: true,
        },
        direct_lane: directLane,
      },
      direct_lane_available: directLane.available === true,
      reconciliation_required: reconciliationRequired,
      reconciliation_request_ids: [...this.state.reconciliation.request_ids],
      authority: clone(this.state.authority),
      automatic_side_effect_replay: false,
      live_pc_control_cutover: false,
    };
    return {
      ...snapshot,
      status_digest: r37Digest(snapshot),
    };
  }

  snapshot() {
    this.#reload();
    return clone(this.state);
  }
}

export function evaluateR37DirectHostRehearsal(evidence = {}) {
  const hostAvailable = evidence?.direct_host_available === true;
  const fallbackDisabled = evidence?.relay_fallback_enabled === false;
  const live = evidence?.actual_direct_host_run === true;
  const readOnly = evidence?.read_only_status === "completed";
  const mutation = evidence?.reversible_operation_status === "completed";
  const rollback = evidence?.rollback_status === "completed";
  const restored = evidence?.fixture_restored === true;
  const noReplay = evidence?.automatic_replay === false;
  const blockers = [];

  if (!fallbackDisabled) blockers.push({ code: "RELAY_FALLBACK_NOT_DISABLED" });
  if (!hostAvailable) {
    blockers.push({
      code: evidence?.blocker_code ?? "DIRECT_HOST_UNAVAILABLE",
      detail: evidence?.blocker_detail ?? null,
    });
  } else {
    if (!live) blockers.push({ code: "LIVE_DIRECT_HOST_RUN_NOT_PROVEN" });
    if (!readOnly) blockers.push({ code: "DIRECT_READ_ONLY_REQUEST_NOT_PROVEN" });
    if (!mutation) blockers.push({ code: "REVERSIBLE_LOCAL_OPERATION_NOT_PROVEN" });
    if (!rollback || !restored) blockers.push({ code: "REVERSIBLE_OPERATION_ROLLBACK_NOT_PROVEN" });
    if (!noReplay) blockers.push({ code: "AUTOMATIC_REPLAY_SEMANTICS_INVALID" });
  }

  return {
    contract_version: R37_DIRECT_HOST_REHEARSAL_V1,
    status: blockers.length === 0 ? "PASS" : "BLOCKED",
    actual_direct_host_run: live,
    relay_fallback_enabled: evidence?.relay_fallback_enabled ?? null,
    direct_host_available: hostAvailable,
    read_only_proven: readOnly,
    reversible_operation_proven: mutation && rollback && restored,
    automatic_replay: evidence?.automatic_replay ?? null,
    blockers,
    production_cutover_performed: false,
  };
}

export function evaluateR37CutoverReadiness({
  lifecycleStatus,
  directHostRehearsal,
  sourceSha = null,
  ciConclusion = null,
} = {}) {
  const blockers = [];
  if (!lifecycleStatus ||
      lifecycleStatus.contract_version !== R37_OPERATOR_LIFECYCLE_V1) {
    blockers.push({ code: "LIFECYCLE_STATUS_MISSING" });
  } else {
    if (lifecycleStatus.reconciliation_required) {
      blockers.push({ code: "RECONCILIATION_REQUIRED" });
    }
    if (lifecycleStatus.components?.github_relay_fallback?.available !== true) {
      blockers.push({ code: "RELAY_FALLBACK_NOT_AVAILABLE" });
    }
  }
  if (!directHostRehearsal ||
      directHostRehearsal.contract_version !== R37_DIRECT_HOST_REHEARSAL_V1 ||
      directHostRehearsal.status !== "PASS") {
    blockers.push(...(directHostRehearsal?.blockers ?? [{ code: "DIRECT_HOST_REHEARSAL_MISSING" }]));
  }
  if (ciConclusion !== null && ciConclusion !== "success") {
    blockers.push({ code: "EXACT_HEAD_CI_NOT_GREEN" });
  }
  return {
    contract_version: R37_CUTOVER_READINESS_V1,
    source_sha: sourceSha,
    state: blockers.length === 0 ? "READY_FOR_EXPLICIT_CUTOVER_REVIEW" : "BLOCKED",
    cutover_ready: blockers.length === 0,
    current_authority: "github_relay",
    current_authority_changed: false,
    automatic_side_effect_replay: false,
    production_cutover_performed: false,
    blockers,
  };
}
