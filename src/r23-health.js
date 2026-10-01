export const R23_HEALTH_V1 = "pc.native.health.v1";
export const R23_LIFECYCLE_V1 = "pc.native.request_lifecycle.v1";
export const R23_LAUNCHER_LIVENESS_V1 = "pc.native.launcher_liveness.v1";

export const R23_LIFECYCLE_STATES = Object.freeze([
  "queued",
  "dispatched",
  "executing",
  "completed",
  "timeout",
  "unknown",
  "reconciled",
]);

const DEFAULT_TIMEOUTS = Object.freeze({
  uia: 5_000,
  shell: 15_000,
  windows: 5_000,
  screenshot: 8_000,
  input: 8_000,
  clipboard: 5_000,
  outcome_journal: 5_000,
  executor: 8_000,
  filesystem: 15_000,
  search: 15_000,
  process: 15_000,
  other: 10_000,
});

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function nowMs(clock) {
  const value = clock();
  if (!Number.isFinite(value)) throw new TypeError("clock must return epoch milliseconds");
  return value;
}

function boundedNumber(value, fallback, minimum, maximum) {
  const actual = value === undefined ? fallback : value;
  if (!Number.isInteger(actual) || actual < minimum || actual > maximum) {
    throw new TypeError(`value must be an integer in ${minimum}..${maximum}`);
  }
  return actual;
}

export function adapterNameForAction(action) {
  const name = String(action ?? "");
  if (/^(uia\.|vision\.target\.)/.test(name)) return "uia";
  if (/^(shell\.)/.test(name)) return "shell";
  if (/^(window\.|windows\.)/.test(name)) return "windows";
  if (/^(screenshot\.)/.test(name)) return "screenshot";
  if (/^(input\.|mouse\.|keyboard\.)/.test(name)) return "input";
  if (/^(clipboard\.)/.test(name)) return "clipboard";
  if (/^(outcome\.)/.test(name)) return "outcome_journal";
  if (/^(fs\.|file\.|log\.|pdf\.)/.test(name)) return "filesystem";
  if (/^(search\.)/.test(name)) return "search";
  if (/^(process\.|system\.process\.)/.test(name)) return "process";
  if (/^(capabilities\.|action\.preflight|health\.|device\.|config\.|identity\.|diagnostics\.|agent\.|system\.health$|system\.config\.)/.test(name)) {
    return "executor";
  }
  return "other";
}

function circuitError(adapter, state, effect) {
  const error = new Error(`Native adapter '${adapter}' circuit is open.`);
  error.name = "AdapterCircuitOpenError";
  error.code = "ADAPTER_CIRCUIT_OPEN";
  error.category = "adapter_health";
  error.retryable = effect === "read_only";
  error.dispatchState = "not_dispatched";
  error.outcomeUncertain = false;
  error.automaticReplay = false;
  error.details = {
    adapter,
    circuit_state: state.state,
    open_until_ms: state.openUntilMs,
  };
  return error;
}

function timeoutError(adapter, timeoutMs, effect) {
  const error = new Error(`Native adapter '${adapter}' exceeded its bounded timeout.`);
  error.name = "AdapterTimeoutError";
  error.code = "ADAPTER_TIMEOUT";
  error.category = "adapter_timeout";
  error.retryable = effect === "read_only";
  error.dispatchState = effect === "side_effect" ? "unknown" : "not_dispatched";
  error.outcomeUncertain = effect === "side_effect";
  error.automaticReplay = false;
  error.details = {
    adapter,
    timeout_ms: timeoutMs,
    reconciliation_required: effect === "side_effect",
  };
  return error;
}

function linkAbort(parent, child) {
  if (!parent) return () => {};
  const onAbort = () => child.abort(parent.reason);
  if (parent.aborted) onAbort();
  else parent.addEventListener("abort", onAbort, { once: true });
  return () => parent.removeEventListener("abort", onAbort);
}

export class R23AdapterCircuitRegistry {
  constructor({
    clock = Date.now,
    failureThreshold = 2,
    cooldownMs = 30_000,
    timeouts = {},
  } = {}) {
    this.clock = clock;
    this.failureThreshold = boundedNumber(failureThreshold, 2, 1, 20);
    this.cooldownMs = boundedNumber(cooldownMs, 30_000, 100, 600_000);
    this.timeouts = Object.freeze({ ...DEFAULT_TIMEOUTS, ...timeouts });
    this.states = new Map();
    this.journalIntegrity = {
      status: "UNKNOWN",
      last_checked_at_ms: null,
      last_error_code: null,
    };
  }

  #entry(adapter) {
    if (!this.states.has(adapter)) {
      this.states.set(adapter, {
        state: "CLOSED",
        consecutiveFailures: 0,
        totalTimeouts: 0,
        totalSuccesses: 0,
        openUntilMs: null,
        lastSuccessAtMs: null,
        lastFailureAtMs: null,
        lastErrorCode: null,
        lastLatencyMs: null,
      });
    }
    return this.states.get(adapter);
  }

  timeoutFor(adapter) {
    const value = this.timeouts[adapter] ?? this.timeouts.other;
    return boundedNumber(value, DEFAULT_TIMEOUTS.other, 50, 120_000);
  }

  markJournalIntegrity(status, errorCode = null) {
    if (!["OK", "UNKNOWN", "MISSING", "CORRUPT"].includes(status)) {
      throw new TypeError("journal integrity status is invalid");
    }
    this.journalIntegrity = {
      status,
      last_checked_at_ms: nowMs(this.clock),
      last_error_code: errorCode,
    };
  }

  markHealthy(adapter, latencyMs = null) {
    const state = this.#entry(adapter);
    state.state = "CLOSED";
    state.consecutiveFailures = 0;
    state.openUntilMs = null;
    state.lastErrorCode = null;
    state.lastSuccessAtMs = nowMs(this.clock);
    state.totalSuccesses += 1;
    if (Number.isFinite(latencyMs)) state.lastLatencyMs = Math.max(0, Math.round(latencyMs));
  }

  markFailure(adapter, code = "ADAPTER_ERROR", { timeout = false } = {}) {
    const state = this.#entry(adapter);
    const now = nowMs(this.clock);
    state.consecutiveFailures += 1;
    state.lastFailureAtMs = now;
    state.lastErrorCode = String(code || "ADAPTER_ERROR");
    if (timeout) state.totalTimeouts += 1;
    if (state.consecutiveFailures >= this.failureThreshold) {
      state.state = "OPEN";
      state.openUntilMs = now + this.cooldownMs;
    }
  }

  snapshot() {
    const names = new Set([...Object.keys(this.timeouts), ...this.states.keys()]);
    names.delete("other");
    const adapters = {};
    for (const name of [...names].sort()) {
      const state = this.#entry(name);
      adapters[name] = {
        status: state.state === "OPEN" ? "UNHEALTHY" : state.consecutiveFailures ? "DEGRADED" : "HEALTHY",
        circuit_state: state.state,
        consecutive_failures: state.consecutiveFailures,
        total_timeouts: state.totalTimeouts,
        total_successes: state.totalSuccesses,
        open_until_ms: state.openUntilMs,
        timeout_ms: this.timeoutFor(name),
        last_success_at_ms: state.lastSuccessAtMs,
        last_failure_at_ms: state.lastFailureAtMs,
        last_error_code: state.lastErrorCode,
        last_latency_ms: state.lastLatencyMs,
      };
    }
    return {
      adapters,
      outcome_journal_integrity: clone(this.journalIntegrity),
    };
  }

  async run({
    action,
    adapter = adapterNameForAction(action),
    effect = "read_only",
    signal = null,
    timeoutMs = undefined,
    operation,
  }) {
    if (typeof operation !== "function") throw new TypeError("operation must be a function");
    if (!["read_only", "side_effect"].includes(effect)) throw new TypeError("effect is invalid");
    const state = this.#entry(adapter);
    const now = nowMs(this.clock);
    if (state.state === "OPEN") {
      if ((state.openUntilMs ?? Infinity) > now || effect === "side_effect") {
        throw circuitError(adapter, state, effect);
      }
      state.state = "HALF_OPEN";
    }

    const bound = boundedNumber(timeoutMs, this.timeoutFor(adapter), 50, 120_000);
    const controller = new AbortController();
    const unlink = linkAbort(signal, controller);
    const started = nowMs(this.clock);
    let timer = null;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(new Error("adapter_timeout"));
          reject(timeoutError(adapter, bound, effect));
        }, bound);
      });
      const result = await Promise.race([
        Promise.resolve().then(() => operation(controller.signal)),
        timeout,
      ]);
      this.markHealthy(adapter, nowMs(this.clock) - started);
      return result;
    } catch (error) {
      if (signal?.aborted && error?.code !== "ADAPTER_TIMEOUT") throw error;
      if (error?.code === "ADAPTER_TIMEOUT") {
        this.markFailure(adapter, error.code, { timeout: true });
      } else if (error?.name !== "AbortError" && error?.code !== "CANCELLED") {
        this.markFailure(adapter, error?.code ?? "ADAPTER_ERROR");
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      unlink();
    }
  }
}

export function projectActionLifecycle(action) {
  const status = action?.status ?? null;
  let lifecycle = "queued";
  if (["leased", "preflighting", "verifying"].includes(status)) lifecycle = "dispatched";
  else if (status === "executing") lifecycle = "executing";
  else if (["uncertain_outcome", "reconciliation_wait", "reconciling"].includes(status)) lifecycle = "unknown";
  else if (["succeeded", "failed", "blocked", "cancelled"].includes(status)) {
    const code = String(action?.error?.code ?? "");
    const category = String(action?.error?.category ?? "");
    if (/timeout/i.test(code) || /timeout/i.test(category)) lifecycle = "timeout";
    else lifecycle = (action?.reconciliationAttempts ?? 0) > 0 ? "reconciled" : "completed";
  }
  return {
    contract_version: R23_LIFECYCLE_V1,
    action_id: action?.id ?? null,
    request_id: action?.correlationId ?? action?.id ?? null,
    control_status: status,
    lifecycle_state: lifecycle,
    execution_attempts: action?.executionAttempts ?? action?.attempts ?? 0,
    reconciliation_attempts: action?.reconciliationAttempts ?? 0,
    created_at_ms: action?.createdAtMs ?? null,
    updated_at: action?.updatedAt ?? null,
    automatic_replay: false,
  };
}

function healthAge(now, timestamp) {
  return Number.isFinite(timestamp) ? Math.max(0, now - timestamp) : null;
}

export class R23HealthSupervisor {
  constructor({
    clock = Date.now,
    controlPlane = null,
    circuitRegistry = new R23AdapterCircuitRegistry({ clock }),
    processAlive = () => true,
    transportProbe = null,
    producerHealthConsumer = null,
    staleProgressMs = 20_000,
    staleResultMs = 60_000,
    canaryTimeoutMs = 5_000,
  } = {}) {
    this.clock = clock;
    this.controlPlane = controlPlane;
    this.circuitRegistry = circuitRegistry;
    this.processAlive = processAlive;
    this.transportProbe = transportProbe;
    this.producerHealthConsumer = producerHealthConsumer;
    this.staleProgressMs = boundedNumber(staleProgressMs, 20_000, 100, 600_000);
    this.staleResultMs = boundedNumber(staleResultMs, 60_000, 100, 3_600_000);
    this.canaryTimeoutMs = boundedNumber(canaryTimeoutMs, 5_000, 100, 120_000);
    this.startedAtMs = nowMs(clock);
    this.lastQueueFingerprint = null;
    this.lastQueueProgressAtMs = this.startedAtMs;
    this.lastRequestAtMs = null;
    this.lastResultAtMs = null;
    this.lastCanaryAtMs = null;
    this.lastCanarySuccessAtMs = null;
    this.lastCanaryErrorCode = null;
    this.transport = {
      connected: false,
      process_alive: null,
      queue_progressing: null,
      executor_responsive: null,
      last_progress_at_ms: null,
      last_successful_result_at_ms: null,
      error_code: null,
    };
    this.canarySequence = 0;
    this.pendingCanaryId = null;
  }

  noteRequest() {
    this.lastRequestAtMs = nowMs(this.clock);
  }

  noteResult() {
    this.lastResultAtMs = nowMs(this.clock);
  }

  ingestProducerRuntimeHealth(payload) {
    if (!this.producerHealthConsumer) return null;
    return this.producerHealthConsumer.ingest(payload);
  }

  noteProducerRuntimeHealthError(code = "R24_PRODUCER_HEALTH_MISSING") {
    if (!this.producerHealthConsumer) return;
    this.producerHealthConsumer.lastError = {
      code,
      observed_at_ms: nowMs(this.clock),
    };
  }

  producerRuntimeHealth() {
    return this.producerHealthConsumer?.snapshot?.() ?? null;
  }

  producerActionReadiness(action, { effect = "read_only" } = {}) {
    if (!this.producerHealthConsumer) {
      return { state: "UNKNOWN", adapter: adapterNameForAction(action), reason: "R24_CONSUMER_UNAVAILABLE" };
    }
    return this.producerHealthConsumer.actionReadiness(action, { effect });
  }

  shouldEnforceProducerHealth() {
    return Boolean(this.producerHealthConsumer?.last || this.producerHealthConsumer?.lastError);
  }

  cutoverReadiness() {
    return this.producerHealthConsumer?.cutoverReadiness?.() ?? {
      decision: "NO_LIVE_CUTOVER",
      prerequisites: { exact_r24_consumer_available: false },
      health_prerequisites_satisfied: false,
      release_ready: false,
    };
  }

  #queueSnapshot() {
    if (!this.controlPlane || typeof this.controlPlane.snapshot !== "function") {
      return { length: 0, fingerprint: "none", oldestAgeMs: 0, lifecycles: [] };
    }
    const snapshot = this.controlPlane.snapshot();
    const queued = Array.isArray(snapshot.queue) ? snapshot.queue : [];
    const actions = Array.isArray(snapshot.actions) ? snapshot.actions : [];
    const byId = new Map(actions.map((action) => [action.id, action]));
    const now = nowMs(this.clock);
    const queuedActions = queued.map((id) => byId.get(id)).filter(Boolean);
    const fingerprint = queuedActions
      .map((action) => `${action.id}:${action.status}:${action.updatedAt ?? ""}`)
      .join("|");
    if (fingerprint !== this.lastQueueFingerprint) {
      this.lastQueueFingerprint = fingerprint;
      this.lastQueueProgressAtMs = now;
    }
    const oldest = queuedActions
      .map((action) => Number.isFinite(action.createdAtMs) ? action.createdAtMs : now)
      .reduce((value, item) => Math.min(value, item), now);
    return {
      length: queuedActions.length,
      fingerprint,
      oldestAgeMs: queuedActions.length ? Math.max(0, now - oldest) : 0,
      lifecycles: actions.slice(-512).map(projectActionLifecycle),
    };
  }

  async probeTransport({ signal = null } = {}) {
    if (typeof this.transportProbe !== "function") return clone(this.transport);
    const controller = new AbortController();
    const unlink = linkAbort(signal, controller);
    let timer = null;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(new Error("transport_health_timeout"));
          const error = new Error("R23 transport health probe timed out.");
          error.code = "TRANSPORT_HEALTH_TIMEOUT";
          reject(error);
        }, this.canaryTimeoutMs);
      });
      const value = await Promise.race([
        this.transportProbe({ signal: controller.signal }),
        timeout,
      ]);
      this.transport = {
        connected: value?.transport_connected === true,
        process_alive: value?.process_alive === true,
        queue_progressing: value?.queue_progressing !== false,
        executor_responsive: value?.executor_responsive !== false,
        last_progress_at_ms: value?.last_progress_at_ms ?? null,
        last_successful_result_at_ms: value?.last_successful_result_at_ms ?? null,
        error_code: null,
      };
    } catch (error) {
      this.transport = {
        ...this.transport,
        connected: false,
        executor_responsive: false,
        error_code: error?.code ?? "TRANSPORT_HEALTH_UNAVAILABLE",
      };
    } finally {
      if (timer) clearTimeout(timer);
      unlink();
    }
    return clone(this.transport);
  }

  noteCanaryUnavailable(code = "R23_CANARY_CAPABILITY_UNAVAILABLE") {
    this.lastCanaryAtMs = nowMs(this.clock);
    this.lastCanaryErrorCode = code;
  }

  async runCanary({ invoke, sessionId }) {
    if (typeof invoke !== "function") throw new TypeError("canary invoke must be a function");
    const now = nowMs(this.clock);
    this.lastCanaryAtMs = now;
    if (!this.pendingCanaryId) {
      this.canarySequence += 1;
      this.pendingCanaryId = `r23-canary:${sessionId}:${this.canarySequence}`;
    }
    const requestId = this.pendingCanaryId;
    const controller = new AbortController();
    let timer = null;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(new Error("r23_canary_timeout"));
          const error = new Error("R23 read-only canary timed out.");
          error.code = "R23_CANARY_TIMEOUT";
          error.category = "health";
          error.retryable = true;
          reject(error);
        }, this.canaryTimeoutMs);
      });
      const result = await Promise.race([
        invoke({ requestId, signal: controller.signal }),
        timeout,
      ]);
      if (result?.status !== "completed") {
        const error = new Error("R23 canary did not complete.");
        error.code = "R23_CANARY_STALLED";
        error.category = "health";
        throw error;
      }
      this.lastCanarySuccessAtMs = nowMs(this.clock);
      this.lastCanaryErrorCode = null;
      this.pendingCanaryId = null;
      this.noteResult();
      return { ok: true, request_id: requestId, status: result.status };
    } catch (error) {
      this.lastCanaryErrorCode = error?.code ?? "R23_CANARY_FAILED";
      return { ok: false, request_id: requestId, error_code: this.lastCanaryErrorCode };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  snapshot() {
    const now = nowMs(this.clock);
    const queue = this.#queueSnapshot();
    const circuits = this.circuitRegistry.snapshot();
    const processAlive = this.transport.process_alive === false
      ? false : Boolean(this.processAlive());
    const transportConnected = this.transport.connected === true;
    const queueProgressing = queue.length === 0
      ? true
      : healthAge(now, this.lastQueueProgressAtMs) <= this.staleProgressMs
        && this.transport.queue_progressing !== false;
    const executorResponsive = this.lastCanarySuccessAtMs !== null
      && healthAge(now, this.lastCanarySuccessAtMs) <= this.staleResultMs
      && this.transport.executor_responsive !== false;
    const unhealthyAdapter = Object.values(circuits.adapters)
      .some((entry) => entry.status === "UNHEALTHY");
    const degradedAdapter = Object.values(circuits.adapters)
      .some((entry) => entry.status === "DEGRADED");
    const journal = circuits.outcome_journal_integrity;
    const producerRuntimeHealth = this.producerRuntimeHealth();
    const producerSystemState = producerRuntimeHealth?.system_state ?? "UNKNOWN";
    const hasUnknownLifecycle = queue.lifecycles.some((row) => row.lifecycle_state === "unknown");
    let status = "HEALTHY";
    if (!processAlive || !queueProgressing || journal.status === "CORRUPT"
        || producerSystemState === "UNHEALTHY") status = "UNHEALTHY";
    else if (!transportConnected || !executorResponsive || unhealthyAdapter
        || degradedAdapter || journal.status === "MISSING"
        || (journal.status === "UNKNOWN" && hasUnknownLifecycle)
        || (producerRuntimeHealth && producerSystemState === "UNKNOWN")) status = "DEGRADED";
    return {
      contract_version: R23_HEALTH_V1,
      status,
      process_alive: processAlive,
      transport_connected: transportConnected,
      queue_progressing: queueProgressing,
      executor_responsive: executorResponsive,
      per_adapter_health: circuits.adapters,
      producer_runtime_health: producerRuntimeHealth,
      producer_adapter_health: producerRuntimeHealth?.adapters ?? null,
      producer_adapter_specific_degraded: producerRuntimeHealth?.adapter_specific_degraded ?? [],
      producer_adapter_specific_unhealthy: producerRuntimeHealth?.adapter_specific_unhealthy ?? [],
      outcome_journal_integrity: producerRuntimeHealth?.outcome_journal ?? journal,
      cutover_readiness: this.cutoverReadiness(),
      last_successful_request_age_ms: healthAge(now, this.lastRequestAtMs),
      last_successful_result_age_ms: healthAge(now, this.lastResultAtMs),
      last_canary_age_ms: healthAge(now, this.lastCanaryAtMs),
      last_canary_success_age_ms: healthAge(now, this.lastCanarySuccessAtMs),
      last_canary_error_code: this.lastCanaryErrorCode,
      queue: {
        depth: queue.length,
        oldest_age_ms: queue.oldestAgeMs,
        last_progress_age_ms: healthAge(now, this.lastQueueProgressAtMs),
      },
      lifecycle: {
        contract_version: R23_LIFECYCLE_V1,
        retained: queue.lifecycles.length,
        states: [...R23_LIFECYCLE_STATES],
        records: queue.lifecycles,
      },
      transport: clone(this.transport),
      measured_at_ms: now,
    };
  }
}

export function launcherLivenessDecision({
  processExists,
  duplicateProcess = false,
  pidIdentityCurrent = true,
  relayResponsive = true,
  executorPresent = true,
  networkAvailable = true,
  transportReady = true,
  health,
  startupDeadlineExceeded = false,
  journalState = "present",
} = {}) {
  const healthy = health?.contract_version === R23_HEALTH_V1 && health.status === "HEALTHY";
  const reasons = [];
  if (!processExists) reasons.push("PROCESS_ABSENT");
  if (processExists && !pidIdentityCurrent) reasons.push("STALE_PID_IDENTITY");
  if (duplicateProcess) reasons.push("DUPLICATE_PROCESS");
  if (!relayResponsive) reasons.push("RELAY_UNRESPONSIVE");
  if (!executorPresent) reasons.push("EXECUTOR_ABSENT");
  if (!networkAvailable) reasons.push("NETWORK_UNAVAILABLE");
  if (!transportReady) reasons.push("TRANSPORT_NOT_CONVERGED");
  if (journalState === "corrupt") reasons.push("JOURNAL_CORRUPT");
  if (processExists && !healthy) reasons.push("FRESHNESS_HANDSHAKE_FAILED");
  if (startupDeadlineExceeded && !healthy) reasons.push("STARTUP_CONVERGENCE_TIMEOUT");
  return {
    contract_version: R23_LAUNCHER_LIVENESS_V1,
    state: healthy && processExists && !duplicateProcess && pidIdentityCurrent
        && relayResponsive && executorPresent && networkAvailable && transportReady
        && journalState !== "corrupt"
      ? "HEALTHY"
      : processExists ? "RECOVERY_REQUIRED" : "STOPPED",
    already_running_healthy: Boolean(
      healthy && processExists && !duplicateProcess && pidIdentityCurrent
      && relayResponsive && executorPresent && networkAvailable && transportReady
      && journalState !== "corrupt"
    ),
    process_exists: Boolean(processExists),
    freshness_handshake_passed: Boolean(healthy),
    reasons: [...new Set(reasons)],
    recovery: {
      kill_existing_process: false,
      restart_live_stack: false,
      automatic_replay: false,
      instructions: [
        "Inspect the authenticated R23 health snapshot and queue freshness.",
        "Reconcile UNKNOWN side effects with outcome.lookup before any new mutation.",
        "Repair or restart only through the separately verified operator procedure; this contract never kills a process.",
      ],
    },
  };
}

// Export defaults for deterministic tests/reporting without allowing mutation.
export const R23_DEFAULT_ADAPTER_TIMEOUTS = DEFAULT_TIMEOUTS;
