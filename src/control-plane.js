import { randomUUID } from "node:crypto";
import { ProviderRegistry, VerificationRegistry } from "./adapters.js";
import { RuntimeMetrics } from "./metrics.js";
import { redactMetadata } from "./persistence.js";
import { TERMINAL_ACTION_STATUSES, ValidationError, validateActionSpec } from "./schemas.js";

export class ControlPlaneError extends Error {
  constructor(message, code, details = undefined) {
    super(message);
    this.name = "ControlPlaneError";
    this.code = code;
    this.details = details;
  }
}

function clone(value) { return value === undefined ? undefined : structuredClone(value); }
function asMs(value) {
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`Clock returned invalid time: ${value}`);
  return parsed;
}
function asIso(value) { return typeof value === "string" ? value : new Date(asMs(value)).toISOString(); }
function errorInfo(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "PROVIDER_ERROR",
    category: typeof error?.category === "string" ? error.category : "provider_error",
    message: String(error?.message ?? error),
    retryable: error?.retryable === true,
  };
}
function isCancellationError(error) {
  return error?.category === "cancelled" || error?.code === "CANCELLED" || error?.name === "AbortError";
}
function isPolicyBlocked(error) { return error?.category === "policy_blocked" || error?.code === "policy_blocked"; }

function actionLanes(type, desktopId, resource) {
  const lanes = [];
  const desktop = String(desktopId);
  if (/^(mouse\.|keyboard\.)/.test(type) || /^uia\.(invoke|focus|set_value)$/.test(type) || type === "vision.target.invoke") {
    lanes.push(`keyboard-mouse:${desktop}`);
  }
  if (/^(screenshot\.|windows\.)/.test(type) || /^uia\.(inspect|list)/.test(type)) lanes.push(`observation:${desktop}`);
  if (/^shell\./.test(type)) lanes.push(`shell:${desktop}`);
  if (resource) lanes.push(`resource:${resource}`);
  if (!lanes.length) lanes.push(`desktop-action:${desktop}`);
  return [...new Set(lanes)];
}

function migrateSnapshot(raw) {
  const snapshot = clone(raw ?? {});
  const version = snapshot.version ?? 1;
  if (![1, 2].includes(version)) throw new ControlPlaneError(`Unsupported snapshot version ${version}.`, "STATE_VERSION_UNSUPPORTED");
  snapshot.version = 2;
  snapshot.sessions ??= [];
  snapshot.desktopOwners ??= [];
  snapshot.actions ??= [];
  snapshot.queue ??= [];
  snapshot.idempotency ??= [];
  snapshot.resourceLocks ??= [];
  snapshot.audit ??= [];
  snapshot.auditSequence ??= snapshot.audit.at(-1)?.sequence ?? 0;
  snapshot.metrics ??= {};
  for (const action of snapshot.actions) {
    if (action.status === "running") action.status = "executing";
    action.retryDelayMs ??= 0;
    action.correlationId ??= action.id;
    action.verification ??= null;
    action.lanes ??= actionLanes(action.type, action.desktopId, action.resource);
    action.lease ??= null;
    action.nextAttemptAtMs ??= null;
    action.cancellationRequested ??= false;
  }
  const schedulable = new Set(snapshot.queue);
  for (const action of snapshot.actions) if (["queued", "retry_wait"].includes(action.status)) schedulable.add(action.id);
  snapshot.queue = [...schedulable];
  return snapshot;
}

export class ControlPlane {
  constructor({
    providers = [], verificationProviders = [], policy = {}, clock, idFactory, snapshot,
    store = null, auditTimeline = null, recoverOnStart = true, defaultLeaseMs = 30_000,
  } = {}) {
    this.providers = providers instanceof ProviderRegistry ? providers : new ProviderRegistry(providers);
    this.verificationProviders = verificationProviders instanceof VerificationRegistry
      ? verificationProviders : new VerificationRegistry(verificationProviders);
    this.policy = {
      permissions: new Set(policy.permissions ?? ["desktop.observe", "desktop.control"]),
      allowDestructive: policy.allowDestructive ?? false,
    };
    this.clock = clock ?? (() => Date.now());
    this.idFactory = idFactory ?? (() => randomUUID());
    this.store = store;
    this.auditTimeline = auditTimeline;
    this.defaultLeaseMs = defaultLeaseMs;
    this.controllers = new Map();
    this.sessions = new Map();
    this.desktopOwners = new Map();
    this.actions = new Map();
    this.queue = [];
    this.idempotency = new Map();
    this.resourceLocks = new Map();
    this.audit = [];
    this.auditSequence = 0;
    this.metrics = new RuntimeMetrics();

    const loaded = snapshot ?? this.store?.load?.() ?? null;
    if (loaded) this.#loadSnapshot(migrateSnapshot(loaded));
    if (loaded && recoverOnStart) this.#recoverInFlight("process_restart");
    this.#persist();
  }

  #time() { const value = this.clock(); return { iso: asIso(value), ms: asMs(value) }; }
  #persist() { if (this.store?.save) this.store.save(this.snapshot()); }
  #loadSnapshot(snapshot) {
    for (const session of snapshot.sessions) this.sessions.set(session.id, clone(session));
    for (const [desktopId, sessionId] of snapshot.desktopOwners) this.desktopOwners.set(desktopId, sessionId);
    for (const action of snapshot.actions) this.actions.set(action.id, clone(action));
    this.queue = [...snapshot.queue];
    for (const [key, actionId] of snapshot.idempotency) this.idempotency.set(key, actionId);
    for (const [lane, actionId] of snapshot.resourceLocks) this.resourceLocks.set(lane, actionId);
    this.audit = clone(snapshot.audit);
    this.auditSequence = snapshot.auditSequence;
    this.metrics = new RuntimeMetrics(snapshot.metrics);
  }

  #auditEvent(event, data = {}) {
    const now = this.#time();
    const safe = redactMetadata(data);
    const entry = Object.freeze({ sequence: ++this.auditSequence, at: now.iso, event, ...safe });
    this.audit.push(entry);
    this.auditTimeline?.append?.(entry);
    return entry;
  }
  #session(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== "active") throw new ControlPlaneError("Active session not found.", "SESSION_NOT_FOUND", { sessionId });
    return session;
  }
  #action(actionId) {
    const action = this.actions.get(actionId);
    if (!action) throw new ControlPlaneError("Action not found.", "ACTION_NOT_FOUND", { actionId });
    return action;
  }
  #releaseLocks(action) {
    for (const lane of action.lanes ?? []) if (this.resourceLocks.get(lane) === action.id) this.resourceLocks.delete(lane);
    action.lease = null;
  }
  #locksAvailable(action) { return (action.lanes ?? []).every((lane) => !this.resourceLocks.has(lane)); }
  #lock(action) { for (const lane of action.lanes ?? []) this.resourceLocks.set(lane, action.id); }
  #removeFromQueue(actionId) { this.queue = this.queue.filter((id) => id !== actionId); }
  #enqueueId(actionId) { if (!this.queue.includes(actionId)) this.queue.push(actionId); }

  createSession({ desktopId, principal = "anonymous", permissions, claimDesktop = true } = {}) {
    if (typeof desktopId !== "string" || !desktopId.trim()) throw new ValidationError("desktopId is required.");
    const granted = new Set(permissions ?? [...this.policy.permissions]);
    for (const permission of granted) if (!this.policy.permissions.has(permission)) {
      throw new ControlPlaneError(`Permission '${permission}' is not allowed by policy.`, "PERMISSION_DENIED");
    }
    const now = this.#time();
    const session = { id: this.idFactory(), desktopId: desktopId.trim(), principal, permissions: [...granted], status: "active", createdAt: now.iso };
    this.sessions.set(session.id, session);
    this.#auditEvent("session.created", { sessionId: session.id, desktopId: session.desktopId, principal });
    if (claimDesktop) this.claimDesktop(session.id, { persist: false });
    this.#persist();
    return clone(session);
  }

  getSession(sessionId) { return clone(this.#session(sessionId)); }
  listSessions() { return [...this.sessions.values()].map(clone); }

  closeSession(sessionId) {
    const session = this.#session(sessionId);
    for (const action of this.actions.values()) if (action.sessionId === sessionId && !TERMINAL_ACTION_STATUSES.has(action.status)) this.cancelAction(action.id, "session_closed", { persist: false });
    if (this.desktopOwners.get(session.desktopId) === sessionId) this.releaseDesktop(sessionId, { persist: false });
    session.status = "closed";
    session.closedAt = this.#time().iso;
    this.#auditEvent("session.closed", { sessionId, desktopId: session.desktopId });
    this.#persist();
    return clone(session);
  }

  claimDesktop(sessionId, { persist = true } = {}) {
    const session = this.#session(sessionId);
    const owner = this.desktopOwners.get(session.desktopId);
    if (owner && owner !== sessionId) throw new ControlPlaneError("Desktop is owned by another active session.", "DESKTOP_OWNED", { desktopId: session.desktopId, ownerSessionId: owner });
    this.desktopOwners.set(session.desktopId, sessionId);
    this.#auditEvent("desktop.claimed", { sessionId, desktopId: session.desktopId });
    if (persist) this.#persist();
    return { desktopId: session.desktopId, ownerSessionId: sessionId };
  }

  releaseDesktop(sessionId, { persist = true } = {}) {
    const session = this.#session(sessionId);
    if (this.desktopOwners.get(session.desktopId) !== sessionId) return false;
    this.desktopOwners.delete(session.desktopId);
    this.#auditEvent("desktop.released", { sessionId, desktopId: session.desktopId });
    if (persist) this.#persist();
    return true;
  }

  enqueueAction(sessionId, rawSpec) {
    const session = this.#session(sessionId);
    const spec = validateActionSpec(rawSpec);
    if (!session.permissions.includes(spec.permission) || !this.policy.permissions.has(spec.permission)) {
      throw new ControlPlaneError(`Permission '${spec.permission}' is required.`, "PERMISSION_DENIED");
    }
    if (spec.destructive && (!this.policy.allowDestructive || !session.permissions.includes("destructive"))) {
      throw new ControlPlaneError("Destructive actions are disabled by default policy.", "DESTRUCTIVE_DISABLED");
    }
    if (spec.requiresDesktop && this.desktopOwners.get(session.desktopId) !== sessionId) throw new ControlPlaneError("Session does not own its desktop.", "DESKTOP_NOT_OWNED");
    if (!this.providers.get(spec.provider)) throw new ControlPlaneError(`Provider '${spec.provider}' is not registered.`, "PROVIDER_NOT_FOUND");
    if (spec.verification && !this.verificationProviders.get(spec.verification.provider)) {
      throw new ControlPlaneError(`Verification provider '${spec.verification.provider}' is not registered.`, "VERIFIER_NOT_FOUND");
    }
    const idemScope = spec.idempotencyKey ? `${sessionId}:${spec.idempotencyKey}` : null;
    if (idemScope && this.idempotency.has(idemScope)) {
      const existing = this.#action(this.idempotency.get(idemScope));
      this.#auditEvent("action.deduplicated", { actionId: existing.id, sessionId, correlationId: existing.correlationId, idempotencyKey: spec.idempotencyKey });
      this.#persist();
      return clone(existing);
    }
    const now = this.#time();
    const id = this.idFactory();
    const confirmationRequired = spec.destructive || spec.confirmation === "required";
    const action = {
      id, correlationId: spec.correlationId ?? id, sessionId, desktopId: session.desktopId,
      provider: spec.provider, type: spec.type, input: spec.input,
      resource: spec.resource ?? null, lanes: actionLanes(spec.type, session.desktopId, spec.resource),
      permission: spec.permission, idempotencyKey: spec.idempotencyKey,
      maxAttempts: spec.maxAttempts, retryDelayMs: spec.retryDelayMs, attempts: 0,
      confirmationRequired, confirmedBy: null, destructive: spec.destructive, requiresDesktop: spec.requiresDesktop,
      verification: spec.verification, metadata: spec.metadata,
      status: confirmationRequired ? "awaiting_confirmation" : "queued", cancellationRequested: false,
      createdAt: now.iso, createdAtMs: now.ms, updatedAt: now.iso, lease: null, nextAttemptAtMs: null,
      result: null, verificationResult: null, error: null,
    };
    this.actions.set(id, action);
    if (idemScope) this.idempotency.set(idemScope, id);
    if (action.status === "queued") this.#enqueueId(id);
    this.#auditEvent("action.enqueued", { actionId: id, sessionId, correlationId: action.correlationId, provider: action.provider, type: action.type, status: action.status, lanes: action.lanes });
    this.#persist();
    return clone(action);
  }

  confirmAction(actionId, { approvedBy = "user" } = {}) {
    const action = this.#action(actionId);
    if (action.status !== "awaiting_confirmation") throw new ControlPlaneError("Action is not awaiting confirmation.", "CONFIRMATION_NOT_REQUIRED");
    const now = this.#time();
    action.confirmedBy = approvedBy; action.confirmedAt = now.iso; action.status = "queued"; action.updatedAt = now.iso;
    this.#enqueueId(action.id);
    this.#auditEvent("action.confirmed", { actionId, sessionId: action.sessionId, correlationId: action.correlationId, approvedBy });
    this.#persist();
    return clone(action);
  }

  cancelAction(actionId, reason = "user_requested", { persist = true } = {}) {
    const action = this.#action(actionId);
    if (TERMINAL_ACTION_STATUSES.has(action.status)) return clone(action);
    const now = this.#time();
    action.cancellationRequested = true; action.cancelReason = reason; action.updatedAt = now.iso;
    this.metrics.increment("cancellations");
    if (["executing", "verifying"].includes(action.status)) {
      this.controllers.get(action.id)?.abort(Object.assign(new Error(reason), { code: "CANCELLED", category: "cancelled" }));
      this.#auditEvent("action.cancellation_requested", { actionId, sessionId: action.sessionId, correlationId: action.correlationId, reason });
    } else {
      action.status = "cancelled"; action.cancelledAt = now.iso; this.#removeFromQueue(action.id); this.#releaseLocks(action);
      this.#auditEvent("action.cancelled", { actionId, sessionId: action.sessionId, correlationId: action.correlationId, reason });
    }
    if (persist) this.#persist();
    return clone(action);
  }

  getAction(actionId) { return clone(this.#action(actionId)); }
  getActionStatus(actionId) {
    const action = this.#action(actionId);
    return clone({ id: action.id, correlationId: action.correlationId, status: action.status, attempts: action.attempts, error: action.error, lease: action.lease });
  }
  listActions({ sessionId, status } = {}) {
    return [...this.actions.values()].filter((action) => (!sessionId || action.sessionId === sessionId) && (!status || action.status === status)).map(clone);
  }

  recoverExpiredLeases() {
    const now = this.#time();
    const recovered = [];
    for (const action of this.actions.values()) {
      if (!["leased", "executing", "verifying"].includes(action.status) || !action.lease || action.lease.expiresAtMs > now.ms) continue;
      this.controllers.get(action.id)?.abort(Object.assign(new Error("lease expired"), { code: "LEASE_EXPIRED" }));
      this.controllers.delete(action.id);
      this.#releaseLocks(action);
      this.metrics.increment("leaseExpiries");
      if (action.cancellationRequested) {
        action.status = "cancelled"; action.cancelledAt = now.iso;
      } else if (action.status === "leased") {
        action.status = "queued"; this.#enqueueId(action.id);
      } else if (action.attempts < action.maxAttempts) {
        action.status = "retry_wait"; action.nextAttemptAtMs = now.ms + action.retryDelayMs; this.#enqueueId(action.id); this.metrics.increment("retries");
        action.error = { code: "LEASE_EXPIRED", category: "transient", message: "Execution lease expired.", retryable: true };
      } else {
        action.status = "failed"; action.failedAt = now.iso;
        action.error = { code: "LEASE_EXPIRED", category: "transient", message: "Execution lease expired at retry limit.", retryable: true };
      }
      action.updatedAt = now.iso;
      this.#auditEvent("action.lease_expired", { actionId: action.id, sessionId: action.sessionId, correlationId: action.correlationId, status: action.status, attempts: action.attempts });
      recovered.push(clone(action));
    }
    if (recovered.length) this.#persist();
    return recovered;
  }

  leaseNext({ workerId = "local-worker", leaseMs = this.defaultLeaseMs } = {}) {
    if (!Number.isInteger(leaseMs) || leaseMs < 1) throw new ValidationError("leaseMs must be a positive integer.");
    this.recoverExpiredLeases();
    const now = this.#time();
    for (let i = 0; i < this.queue.length; i += 1) {
      const action = this.actions.get(this.queue[i]);
      if (!action) continue;
      if (action.status === "retry_wait") {
        if ((action.nextAttemptAtMs ?? 0) > now.ms) continue;
        action.status = "queued";
      }
      if (action.status !== "queued" || !this.#locksAvailable(action)) continue;
      if (action.requiresDesktop && this.desktopOwners.get(action.desktopId) !== action.sessionId) {
        action.status = "blocked";
        action.error = { code: "DESKTOP_NOT_OWNED", category: "policy_blocked", message: "Desktop ownership was lost before leasing.", retryable: false };
        this.queue.splice(i, 1); i -= 1;
        this.#auditEvent("action.blocked", { actionId: action.id, sessionId: action.sessionId, correlationId: action.correlationId, error: action.error });
        this.#persist();
        continue;
      }
      this.queue.splice(i, 1);
      action.status = "leased"; action.updatedAt = now.iso; action.leasedAt = now.iso;
      action.lease = { workerId, acquiredAt: now.iso, acquiredAtMs: now.ms, expiresAt: new Date(now.ms + leaseMs).toISOString(), expiresAtMs: now.ms + leaseMs };
      this.#lock(action);
      this.metrics.recordDuration("queueLatency", Math.max(0, now.ms - (action.createdAtMs ?? asMs(action.createdAt))));
      this.#auditEvent("action.leased", { actionId: action.id, sessionId: action.sessionId, correlationId: action.correlationId, workerId, lanes: action.lanes, expiresAt: action.lease.expiresAt });
      this.#persist();
      return clone(action);
    }
    return null;
  }

  async executeLeased(actionId, { workerId = null } = {}) {
    const action = this.#action(actionId);
    if (action.status !== "leased" || !action.lease) throw new ControlPlaneError("Action is not leased.", "ACTION_NOT_LEASED", { actionId });
    if (workerId && action.lease.workerId !== workerId) throw new ControlPlaneError("Lease is owned by another worker.", "LEASE_OWNED", { actionId, owner: action.lease.workerId });
    const session = this.#session(action.sessionId);
    const controller = new AbortController();
    this.controllers.set(action.id, controller);
    let executionStart;
    try {
      let now = this.#time();
      action.status = "executing"; action.attempts += 1; action.executingAt = now.iso; action.updatedAt = now.iso; executionStart = now.ms;
      this.#auditEvent("action.executing", { actionId, sessionId: action.sessionId, correlationId: action.correlationId, attempt: action.attempts, workerId: action.lease.workerId });
      this.#persist();
      const provider = this.providers.get(action.provider);
      const executionResult = await provider.execute(clone(action), { signal: controller.signal, attempt: action.attempts, session: clone(session) });
      now = this.#time();
      this.metrics.recordDuration("executionLatency", Math.max(0, now.ms - executionStart));
      if (action.cancellationRequested || controller.signal.aborted) throw Object.assign(new Error(action.cancelReason ?? "aborted"), { code: "CANCELLED", category: "cancelled" });

      if (action.verification) {
        action.status = "verifying"; action.updatedAt = now.iso; action.verifyingAt = now.iso;
        this.#auditEvent("action.verifying", { actionId, sessionId: action.sessionId, correlationId: action.correlationId, provider: action.verification.provider, type: action.verification.type });
        this.#persist();
        const verificationStart = now.ms;
        const verifier = this.verificationProviders.get(action.verification.provider);
        const verificationResult = await verifier.verify({ action: clone(action), executionResult: clone(executionResult), verification: clone(action.verification) }, { signal: controller.signal, attempt: action.attempts, session: clone(session) });
        now = this.#time();
        this.metrics.recordDuration("verificationLatency", Math.max(0, now.ms - verificationStart));
        if (action.cancellationRequested || controller.signal.aborted) throw Object.assign(new Error(action.cancelReason ?? "aborted"), { code: "CANCELLED", category: "cancelled" });
        if (!verificationResult || typeof verificationResult !== "object" || typeof verificationResult.ok !== "boolean") {
          throw Object.assign(new Error("Verification provider returned a malformed result."), { code: "VERIFICATION_MALFORMED", category: "verification_error", retryable: false });
        }
        if (!verificationResult.ok) {
          throw Object.assign(new Error(verificationResult.message ?? "Action verification failed."), {
            code: verificationResult.code ?? "VERIFICATION_FAILED",
            category: verificationResult.category ?? "verification_error",
            retryable: verificationResult.retryable === true,
          });
        }
        action.verificationResult = clone(verificationResult);
      }

      now = this.#time();
      action.status = "succeeded"; action.result = clone(executionResult); action.error = null; action.completedAt = now.iso; action.updatedAt = now.iso;
      this.#releaseLocks(action);
      this.#auditEvent("action.succeeded", { actionId, sessionId: action.sessionId, correlationId: action.correlationId, attempt: action.attempts, verified: Boolean(action.verification) });
    } catch (error) {
      const now = this.#time();
      if (executionStart !== undefined && action.status === "executing") this.metrics.recordDuration("executionLatency", Math.max(0, now.ms - executionStart));
      const info = errorInfo(error);
      if (action.cancellationRequested || controller.signal.aborted || isCancellationError(error)) {
        action.status = "cancelled"; action.error = null; action.cancelledAt = now.iso;
        this.#auditEvent("action.cancelled", { actionId, sessionId: action.sessionId, correlationId: action.correlationId, reason: action.cancelReason ?? info.message });
      } else if (isPolicyBlocked(error)) {
        action.status = "blocked"; action.error = info; action.blockedAt = now.iso;
        this.#auditEvent("action.blocked", { actionId, sessionId: action.sessionId, correlationId: action.correlationId, error: info });
      } else if (info.retryable && action.attempts < action.maxAttempts) {
        action.status = "retry_wait"; action.error = info; action.nextAttemptAtMs = now.ms + action.retryDelayMs; this.#enqueueId(action.id); this.metrics.increment("retries");
        this.#auditEvent("action.retry_wait", { actionId, sessionId: action.sessionId, correlationId: action.correlationId, attempt: action.attempts, maxAttempts: action.maxAttempts, nextAttemptAtMs: action.nextAttemptAtMs, error: info });
      } else {
        action.status = "failed"; action.error = info; action.failedAt = now.iso;
        this.#auditEvent("action.failed", { actionId, sessionId: action.sessionId, correlationId: action.correlationId, attempt: action.attempts, error: info });
      }
      action.updatedAt = now.iso;
      this.#releaseLocks(action);
    } finally {
      this.controllers.delete(action.id);
      this.#persist();
    }
    return clone(action);
  }

  async processNext({ workerId = "processNext", leaseMs = this.defaultLeaseMs } = {}) {
    const leased = this.leaseNext({ workerId, leaseMs });
    if (!leased) return null;
    return this.executeLeased(leased.id, { workerId });
  }

  async drain({ limit = 1000, workerId = "drain" } = {}) {
    const processed = [];
    while (processed.length < limit) {
      const action = await this.processNext({ workerId });
      if (!action) break;
      processed.push(action);
    }
    return processed;
  }

  #recoverInFlight(reason) {
    const now = this.#time();
    const recovered = [];
    this.resourceLocks.clear();
    this.controllers.clear();
    for (const action of this.actions.values()) {
      if (!["leased", "executing", "verifying"].includes(action.status)) continue;
      if (action.cancellationRequested) {
        action.status = "cancelled"; action.cancelledAt = now.iso;
      } else if (action.status === "leased") {
        action.status = "queued"; this.#enqueueId(action.id);
      } else if (action.attempts < action.maxAttempts) {
        action.status = "retry_wait"; action.nextAttemptAtMs = now.ms + action.retryDelayMs; this.#enqueueId(action.id); this.metrics.increment("retries");
        action.error = { code: "PROCESS_RESTART", category: "transient", message: "Recovered interrupted execution after restart.", retryable: true };
      } else {
        action.status = "failed"; action.failedAt = now.iso;
        action.error = { code: "PROCESS_RESTART", category: "transient", message: "Interrupted execution reached retry limit.", retryable: true };
      }
      action.lease = null; action.updatedAt = now.iso;
      this.#auditEvent("action.recovered", { actionId: action.id, sessionId: action.sessionId, correlationId: action.correlationId, reason, status: action.status, attempts: action.attempts });
      recovered.push(clone(action));
    }
    return recovered;
  }

  recover() { const recovered = this.#recoverInFlight("manual_recovery"); if (recovered.length) this.#persist(); return recovered; }
  getAuditLog({ afterSequence = 0, correlationId = null } = {}) {
    return this.audit.filter((entry) => entry.sequence > afterSequence && (!correlationId || entry.correlationId === correlationId)).map(clone);
  }
  getMetrics() { return this.metrics.snapshot(); }
  snapshot() {
    return clone({
      version: 2,
      sessions: [...this.sessions.values()], desktopOwners: [...this.desktopOwners.entries()],
      actions: [...this.actions.values()], queue: this.queue, idempotency: [...this.idempotency.entries()],
      resourceLocks: [...this.resourceLocks.entries()], audit: this.audit, auditSequence: this.auditSequence,
      metrics: this.metrics.persisted(),
    });
  }
}
