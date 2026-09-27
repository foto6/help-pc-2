import { randomUUID } from "node:crypto";
import { ProviderRegistry, VerificationRegistry } from "./adapters.js";
import { RuntimeMetrics } from "./metrics.js";
import { redactMetadata } from "./persistence.js";
import { TERMINAL_ACTION_STATUSES, ValidationError, validateActionSpec } from "./schemas.js";

export class ControlPlaneError extends Error {
  constructor(message, code, details = undefined) { super(message); this.name = "ControlPlaneError"; this.code = code; this.details = details; }
}

function clone(value) { return value === undefined ? undefined : structuredClone(value); }
function asMs(value) { if (typeof value === "number") return value; if (value instanceof Date) return value.getTime(); const parsed = Date.parse(value); if (!Number.isFinite(parsed)) throw new TypeError(`Clock returned invalid time: ${value}`); return parsed; }
function asIso(value) { return typeof value === "string" ? value : new Date(asMs(value)).toISOString(); }
function errorInfo(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "PROVIDER_ERROR",
    category: typeof error?.category === "string" ? error.category : "provider_error",
    message: String(error?.message ?? error),
    retryable: error?.retryable === true,
    dispatchState: typeof error?.dispatchState === "string" ? error.dispatchState : "unknown",
    outcomeUncertain: error?.outcomeUncertain !== false,
  };
}
function isPolicyBlocked(error) { return error?.category === "policy_blocked" || error?.code === "policy_blocked"; }
function isInconclusive(result) {
  const value = `${result?.category ?? ""}:${result?.code ?? ""}:${result?.status ?? ""}`.toLowerCase();
  return result?.inconclusive === true || result?.stale === true || /stale|inconclusive|unknown/.test(value);
}
function actionLanes(type, desktopId, resource) {
  const lanes = []; const desktop = String(desktopId);
  if (/^(mouse\.|keyboard\.)/.test(type) || /^uia\.(invoke|focus|set_value)$/.test(type) || type === "vision.target.invoke") lanes.push(`keyboard-mouse:${desktop}`);
  if (/^(screenshot\.|windows\.)/.test(type) || /^uia\.(inspect|list|snapshot)/.test(type)) lanes.push(`observation:${desktop}`);
  if (/^shell\./.test(type)) lanes.push(`shell:${desktop}`);
  if (resource) lanes.push(`resource:${resource}`);
  if (!lanes.length) lanes.push(`desktop-action:${desktop}`);
  return [...new Set(lanes)];
}
function reconciliationLanes(action) { return [...new Set([...(action.lanes ?? []), `observation:${action.desktopId}`])]; }

function migrateSnapshot(raw) {
  const snapshot = clone(raw ?? {}); const version = snapshot.version ?? 1;
  if (![1, 2, 3].includes(version)) throw new ControlPlaneError(`Unsupported snapshot version ${version}.`, "STATE_VERSION_UNSUPPORTED");
  snapshot.version = 3; snapshot.sessions ??= []; snapshot.desktopOwners ??= []; snapshot.actions ??= []; snapshot.queue ??= []; snapshot.idempotency ??= []; snapshot.resourceLocks ??= []; snapshot.audit ??= []; snapshot.auditSequence ??= snapshot.audit.at(-1)?.sequence ?? 0; snapshot.metrics ??= {};
  for (const action of snapshot.actions) {
    if (action.status === "running") action.status = "executing";
    action.retryDelayMs ??= 0; action.verificationDelayMs ??= 0; action.correlationId ??= action.id; action.verification ??= null;
    action.lanes ??= actionLanes(action.type, action.desktopId, action.resource); action.lease ??= null; action.nextAttemptAtMs ??= null; action.nextReconciliationAtMs ??= null; action.cancellationRequested ??= false;
    action.executionAttempts ??= action.attempts ?? 0; action.attempts = action.executionAttempts;
    action.verificationAttempts ??= 0; action.reconciliationAttempts ??= 0;
    action.maxVerificationAttempts ??= 3; action.maxReconciliationAttempts ??= 3;
    action.executionResult ??= action.result ?? null; action.executorEvidence ??= null; action.executionOutcome ??= action.result ? "succeeded" : null;
    action.executionCorrelation ??= null; action.uncertainty ??= null;
  }
  const schedulable = new Set(snapshot.queue);
  for (const action of snapshot.actions) if (["queued", "retry_wait", "uncertain_outcome", "reconciliation_wait"].includes(action.status)) schedulable.add(action.id);
  snapshot.queue = [...schedulable];
  return snapshot;
}

export class ControlPlane {
  constructor({ providers = [], verificationProviders = [], policy = {}, clock, idFactory, snapshot, store = null, auditTimeline = null, recoverOnStart = true, defaultLeaseMs = 30_000 } = {}) {
    this.providers = providers instanceof ProviderRegistry ? providers : new ProviderRegistry(providers);
    this.verificationProviders = verificationProviders instanceof VerificationRegistry ? verificationProviders : new VerificationRegistry(verificationProviders);
    this.policy = { permissions: new Set(policy.permissions ?? ["desktop.observe", "desktop.control"]), allowDestructive: policy.allowDestructive ?? false };
    this.clock = clock ?? (() => Date.now()); this.idFactory = idFactory ?? (() => randomUUID()); this.store = store; this.auditTimeline = auditTimeline; this.defaultLeaseMs = defaultLeaseMs;
    this.controllers = new Map(); this.sessions = new Map(); this.desktopOwners = new Map(); this.actions = new Map(); this.queue = []; this.idempotency = new Map(); this.resourceLocks = new Map(); this.audit = []; this.auditSequence = 0; this.metrics = new RuntimeMetrics();
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
    this.queue = [...snapshot.queue]; for (const [key, actionId] of snapshot.idempotency) this.idempotency.set(key, actionId); for (const [lane, actionId] of snapshot.resourceLocks) this.resourceLocks.set(lane, actionId);
    this.audit = clone(snapshot.audit); this.auditSequence = snapshot.auditSequence; this.metrics = new RuntimeMetrics(snapshot.metrics);
  }
  #auditEvent(event, data = {}) { const entry = Object.freeze({ sequence: ++this.auditSequence, at: this.#time().iso, event, ...redactMetadata(data) }); this.audit.push(entry); this.auditTimeline?.append?.(entry); return entry; }
  #session(sessionId) { const session = this.sessions.get(sessionId); if (!session || session.status !== "active") throw new ControlPlaneError("Active session not found.", "SESSION_NOT_FOUND", { sessionId }); return session; }
  #action(actionId) { const action = this.actions.get(actionId); if (!action) throw new ControlPlaneError("Action not found.", "ACTION_NOT_FOUND", { actionId }); return action; }
  #removeFromQueue(actionId) { this.queue = this.queue.filter((id) => id !== actionId); }
  #enqueueId(actionId) { if (!this.queue.includes(actionId)) this.queue.push(actionId); }
  #releaseLocks(action) { for (const lane of action.lease?.lanes ?? action.lanes ?? []) if (this.resourceLocks.get(lane) === action.id) this.resourceLocks.delete(lane); action.lease = null; }
  #locksAvailable(lanes) { return lanes.every((lane) => !this.resourceLocks.has(lane)); }
  #lock(action, lanes) { for (const lane of lanes) this.resourceLocks.set(lane, action.id); }

  createSession({ desktopId, principal = "anonymous", permissions, claimDesktop = true } = {}) {
    if (typeof desktopId !== "string" || !desktopId.trim()) throw new ValidationError("desktopId is required.");
    const granted = new Set(permissions ?? [...this.policy.permissions]); for (const permission of granted) if (!this.policy.permissions.has(permission)) throw new ControlPlaneError(`Permission '${permission}' is not allowed by policy.`, "PERMISSION_DENIED");
    const now = this.#time(); const session = { id: this.idFactory(), desktopId: desktopId.trim(), principal, permissions: [...granted], status: "active", createdAt: now.iso };
    this.sessions.set(session.id, session); this.#auditEvent("session.created", { sessionId: session.id, desktopId: session.desktopId, principal }); if (claimDesktop) this.claimDesktop(session.id, { persist: false }); this.#persist(); return clone(session);
  }
  getSession(sessionId) { return clone(this.#session(sessionId)); }
  listSessions() { return [...this.sessions.values()].map(clone); }
  closeSession(sessionId) { const session = this.#session(sessionId); for (const action of this.actions.values()) if (action.sessionId === sessionId && !TERMINAL_ACTION_STATUSES.has(action.status)) this.cancelAction(action.id, "session_closed", { persist: false }); if (this.desktopOwners.get(session.desktopId) === sessionId) this.releaseDesktop(sessionId, { persist: false }); session.status = "closed"; session.closedAt = this.#time().iso; this.#auditEvent("session.closed", { sessionId, desktopId: session.desktopId }); this.#persist(); return clone(session); }
  claimDesktop(sessionId, { persist = true } = {}) { const session = this.#session(sessionId); const owner = this.desktopOwners.get(session.desktopId); if (owner && owner !== sessionId) throw new ControlPlaneError("Desktop is owned by another active session.", "DESKTOP_OWNED", { desktopId: session.desktopId, ownerSessionId: owner }); this.desktopOwners.set(session.desktopId, sessionId); this.#auditEvent("desktop.claimed", { sessionId, desktopId: session.desktopId }); if (persist) this.#persist(); return { desktopId: session.desktopId, ownerSessionId: sessionId }; }
  releaseDesktop(sessionId, { persist = true } = {}) { const session = this.#session(sessionId); if (this.desktopOwners.get(session.desktopId) !== sessionId) return false; this.desktopOwners.delete(session.desktopId); this.#auditEvent("desktop.released", { sessionId, desktopId: session.desktopId }); if (persist) this.#persist(); return true; }

  enqueueAction(sessionId, rawSpec) {
    const session = this.#session(sessionId); const spec = validateActionSpec(rawSpec);
    if (!session.permissions.includes(spec.permission) || !this.policy.permissions.has(spec.permission)) throw new ControlPlaneError(`Permission '${spec.permission}' is required.`, "PERMISSION_DENIED");
    if (spec.destructive && (!this.policy.allowDestructive || !session.permissions.includes("destructive"))) throw new ControlPlaneError("Destructive actions are disabled by default policy.", "DESTRUCTIVE_DISABLED");
    if (spec.requiresDesktop && this.desktopOwners.get(session.desktopId) !== sessionId) throw new ControlPlaneError("Session does not own its desktop.", "DESKTOP_NOT_OWNED");
    if (!this.providers.get(spec.provider)) throw new ControlPlaneError(`Provider '${spec.provider}' is not registered.`, "PROVIDER_NOT_FOUND");
    if (spec.verification && !this.verificationProviders.get(spec.verification.provider)) throw new ControlPlaneError(`Verification provider '${spec.verification.provider}' is not registered.`, "VERIFIER_NOT_FOUND");
    const idemScope = spec.idempotencyKey ? `${sessionId}:${spec.idempotencyKey}` : null;
    if (idemScope && this.idempotency.has(idemScope)) { const existing = this.#action(this.idempotency.get(idemScope)); this.#auditEvent("action.deduplicated", { actionId: existing.id, sessionId, correlationId: existing.correlationId, idempotencyKey: spec.idempotencyKey }); this.#persist(); return clone(existing); }
    const now = this.#time(); const id = this.idFactory(); const confirmationRequired = spec.destructive || spec.confirmation === "required";
    const action = {
      id, correlationId: spec.correlationId ?? id, sessionId, desktopId: session.desktopId, provider: spec.provider, type: spec.type, input: spec.input,
      resource: spec.resource ?? null, lanes: actionLanes(spec.type, session.desktopId, spec.resource), permission: spec.permission, idempotencyKey: spec.idempotencyKey,
      maxAttempts: spec.maxAttempts, maxVerificationAttempts: spec.maxVerificationAttempts, maxReconciliationAttempts: spec.maxReconciliationAttempts, retryDelayMs: spec.retryDelayMs, verificationDelayMs: spec.verificationDelayMs,
      executionAttempts: 0, verificationAttempts: 0, reconciliationAttempts: 0, attempts: 0,
      confirmationRequired, confirmedBy: null, destructive: spec.destructive, requiresDesktop: spec.requiresDesktop, verification: spec.verification, metadata: spec.metadata,
      status: confirmationRequired ? "awaiting_confirmation" : "queued", cancellationRequested: false,
      createdAt: now.iso, createdAtMs: now.ms, updatedAt: now.iso, lease: null, nextAttemptAtMs: null, nextReconciliationAtMs: null,
      result: null, executionResult: null, executorEvidence: null, executionOutcome: null, executionCorrelation: null, verificationResult: null, error: null, uncertainty: null,
    };
    this.actions.set(id, action); if (idemScope) this.idempotency.set(idemScope, id); if (action.status === "queued") this.#enqueueId(id);
    this.#auditEvent("action.enqueued", { actionId: id, sessionId, correlationId: action.correlationId, provider: action.provider, type: action.type, status: action.status, lanes: action.lanes }); this.#persist(); return clone(action);
  }

  confirmAction(actionId, { approvedBy = "user" } = {}) { const action = this.#action(actionId); if (action.status !== "awaiting_confirmation") throw new ControlPlaneError("Action is not awaiting confirmation.", "CONFIRMATION_NOT_REQUIRED"); const now = this.#time(); action.confirmedBy = approvedBy; action.confirmedAt = now.iso; action.status = "queued"; action.updatedAt = now.iso; this.#enqueueId(action.id); this.#auditEvent("action.confirmed", { actionId, sessionId: action.sessionId, correlationId: action.correlationId, approvedBy }); this.#persist(); return clone(action); }

  cancelAction(actionId, reason = "user_requested", { persist = true } = {}) {
    const action = this.#action(actionId); if (TERMINAL_ACTION_STATUSES.has(action.status)) return clone(action); const now = this.#time(); action.cancellationRequested = true; action.cancelReason = reason; action.updatedAt = now.iso; this.metrics.increment("cancellations");
    if (action.status === "executing") {
      this.controllers.get(action.id)?.abort(Object.assign(new Error(reason), { code: "CANCELLED", category: "cancelled" }));
      this.#auditEvent("action.cancellation_requested", { actionId, sessionId: action.sessionId, correlationId: action.correlationId, reason, outcome: "uncertain_until_reconciled" });
    } else if (["verifying", "reconciling"].includes(action.status)) {
      this.controllers.get(action.id)?.abort(Object.assign(new Error(reason), { code: "CANCELLED", category: "cancelled" }));
      this.#auditEvent("action.cancellation_requested", { actionId, sessionId: action.sessionId, correlationId: action.correlationId, reason, reconciliationRequired: true });
    } else if (["uncertain_outcome", "reconciliation_wait"].includes(action.status) || (action.status === "leased" && action.lease?.mode === "reconcile")) {
      if (action.status === "leased") { this.#releaseLocks(action); action.status = "reconciliation_wait"; }
      this.#enqueueId(action.id);
      this.#auditEvent("action.cancellation_requested", { actionId, sessionId: action.sessionId, correlationId: action.correlationId, reason, reconciliationRequired: true });
    } else {
      action.status = "cancelled"; action.cancelledAt = now.iso; this.#removeFromQueue(action.id); this.#releaseLocks(action);
      this.#auditEvent("action.cancelled", { actionId, sessionId: action.sessionId, correlationId: action.correlationId, reason, dispatchState: "not_dispatched" });
    }
    if (persist) this.#persist(); return clone(action);
  }

  getAction(actionId) { return clone(this.#action(actionId)); }
  getActionStatus(actionId) { const action = this.#action(actionId); return clone({ id: action.id, correlationId: action.correlationId, status: action.status, attempts: action.executionAttempts, executionAttempts: action.executionAttempts, verificationAttempts: action.verificationAttempts, reconciliationAttempts: action.reconciliationAttempts, error: action.error, uncertainty: action.uncertainty, lease: action.lease }); }
  listActions({ sessionId, status } = {}) { return [...this.actions.values()].filter((action) => (!sessionId || action.sessionId === sessionId) && (!status || action.status === status)).map(clone); }

  #transitionUncertain(action, reason, error = null) {
    const now = this.#time(); const wasUncertain = action.status === "uncertain_outcome" || action.status === "reconciliation_wait";
    action.status = "uncertain_outcome"; action.error = error ? errorInfo(error) : action.error; action.uncertainty = { reason, since: action.uncertainty?.since ?? now.iso, executionAttempt: action.executionAttempts, cancellationRequested: action.cancellationRequested };
    action.updatedAt = now.iso; action.nextReconciliationAtMs = now.ms; this.#releaseLocks(action); this.#enqueueId(action.id); if (!wasUncertain) this.metrics.increment("uncertainOutcomes");
    this.#auditEvent("action.uncertain_outcome", { actionId: action.id, sessionId: action.sessionId, correlationId: action.correlationId, reason, executionAttempts: action.executionAttempts, cancellationRequested: action.cancellationRequested });
  }

  recoverExpiredLeases() {
    const now = this.#time(); const recovered = [];
    for (const action of this.actions.values()) {
      if (!["leased", "executing", "verifying", "reconciling"].includes(action.status) || !action.lease || action.lease.expiresAtMs > now.ms) continue;
      const previous = action.status; const mode = action.lease.mode;
      this.controllers.get(action.id)?.abort(Object.assign(new Error("lease expired"), { code: "LEASE_EXPIRED", category: "lease_expired" })); this.controllers.delete(action.id); this.metrics.increment("leaseExpiries");
      if (previous === "leased") {
        this.#releaseLocks(action);
        action.status = mode === "reconcile" ? "reconciliation_wait" : "queued";
        if (mode === "reconcile") action.nextReconciliationAtMs = now.ms; else action.nextAttemptAtMs = now.ms;
        this.#enqueueId(action.id);
      } else if (previous === "executing") {
        this.#transitionUncertain(action, "lease_expired_during_execution", Object.assign(new Error("Execution lease expired after dispatch may have begun."), { code: "LEASE_EXPIRED", category: "uncertain_outcome" }));
      } else {
        this.#releaseLocks(action); action.status = "reconciliation_wait"; action.nextReconciliationAtMs = now.ms; action.updatedAt = now.iso; this.#enqueueId(action.id);
        this.#auditEvent("action.reconciliation_interrupted", { actionId: action.id, sessionId: action.sessionId, correlationId: action.correlationId, reason: "lease_expired", previousStatus: previous });
      }
      recovered.push(clone(action));
    }
    if (recovered.length) this.#persist(); return recovered;
  }

  leaseNext({ workerId = "local-worker", leaseMs = this.defaultLeaseMs } = {}) {
    if (!Number.isInteger(leaseMs) || leaseMs < 1) throw new ValidationError("leaseMs must be a positive integer.");
    this.recoverExpiredLeases(); const now = this.#time();
    for (let i = 0; i < this.queue.length; i += 1) {
      const action = this.actions.get(this.queue[i]); if (!action) continue;
      if (action.status === "retry_wait") { if ((action.nextAttemptAtMs ?? 0) > now.ms) continue; action.status = "queued"; }
      if (action.status === "reconciliation_wait") { if ((action.nextReconciliationAtMs ?? 0) > now.ms) continue; action.status = "uncertain_outcome"; }
      const mode = action.status === "queued" ? "execute" : action.status === "uncertain_outcome" ? "reconcile" : null;
      if (!mode) continue;
      const lanes = mode === "execute" ? action.lanes : reconciliationLanes(action);
      if (!this.#locksAvailable(lanes)) continue;
      if (action.requiresDesktop && this.desktopOwners.get(action.desktopId) !== action.sessionId) {
        action.status = "blocked"; action.error = { code: "DESKTOP_NOT_OWNED", category: "policy_blocked", message: "Desktop ownership was lost before leasing.", retryable: false }; this.queue.splice(i, 1); i -= 1;
        this.#auditEvent("action.blocked", { actionId: action.id, sessionId: action.sessionId, correlationId: action.correlationId, error: action.error }); this.#persist(); continue;
      }
      this.queue.splice(i, 1); action.status = "leased"; action.updatedAt = now.iso; action.leasedAt = now.iso;
      action.lease = { mode, workerId, lanes, acquiredAt: now.iso, acquiredAtMs: now.ms, expiresAt: new Date(now.ms + leaseMs).toISOString(), expiresAtMs: now.ms + leaseMs };
      this.#lock(action, lanes); if (mode === "execute") this.metrics.recordDuration("queueLatency", Math.max(0, now.ms - (action.createdAtMs ?? asMs(action.createdAt))));
      this.#auditEvent("action.leased", { actionId: action.id, sessionId: action.sessionId, correlationId: action.correlationId, mode, workerId, lanes, expiresAt: action.lease.expiresAt }); this.#persist(); return clone(action);
    }
    return null;
  }

  async #runVerification(action, session, controller, { reconciliation = false } = {}) {
    if (!action.verification) return { kind: "success", result: null };
    const verifier = this.verificationProviders.get(action.verification.provider); const start = this.#time();
    action.status = reconciliation ? "reconciling" : "verifying"; action.verificationAttempts += 1; this.metrics.increment("verificationAttempts"); action.updatedAt = start.iso;
    this.#auditEvent("action.verification_attempt", { actionId: action.id, sessionId: action.sessionId, correlationId: action.correlationId, verificationAttempt: action.verificationAttempts, reconciliationAttempt: action.reconciliationAttempts, provider: action.verification.provider, type: action.verification.type }); this.#persist();
    try {
      const result = await verifier.verify({ action: clone(action), executionResult: clone(action.executionResult), executorEvidence: clone(action.executorEvidence), verification: clone(action.verification), reconciliation }, { signal: controller.signal, verificationAttempt: action.verificationAttempts, reconciliationAttempt: action.reconciliationAttempts, session: clone(session) });
      const end = this.#time(); this.metrics.recordDuration("verificationLatency", Math.max(0, end.ms - start.ms));
      if (!result || typeof result !== "object" || typeof result.ok !== "boolean") return { kind: "failed", error: { code: "VERIFICATION_MALFORMED", category: "verification_error", message: "Verification provider returned a malformed result.", retryable: false } };
      action.verificationResult = clone(result);
      if (result.ok) return { kind: "success", result };
      if (result.conclusive === true && result.outcome === "not_applied") return { kind: "not_applied", result };
      if (isInconclusive(result) || result.retryable === true) return { kind: "inconclusive", result };
      return { kind: "failed", result, error: { code: result.code ?? "VERIFICATION_FAILED", category: result.category ?? "verification_error", message: result.message ?? "Action verification failed.", retryable: false } };
    } catch (error) {
      const end = this.#time(); this.metrics.recordDuration("verificationLatency", Math.max(0, end.ms - start.ms));
      if (controller.signal.aborted) return { kind: "inconclusive", result: { ok: false, code: "VERIFICATION_INTERRUPTED", category: "inconclusive", retryable: true, message: String(error?.message ?? error) } };
      return { kind: "failed", error: errorInfo(error) };
    }
  }

  #scheduleReconciliation(action, reason, { error = null } = {}) {
    const now = this.#time(); action.status = "reconciliation_wait"; action.updatedAt = now.iso; action.nextReconciliationAtMs = now.ms + action.verificationDelayMs; if (error) action.error = clone(error); this.#releaseLocks(action); this.#enqueueId(action.id);
    this.#auditEvent("action.reconciliation_wait", { actionId: action.id, sessionId: action.sessionId, correlationId: action.correlationId, reason, verificationAttempts: action.verificationAttempts, reconciliationAttempts: action.reconciliationAttempts, nextReconciliationAtMs: action.nextReconciliationAtMs });
  }

  #exhaustReconciliation(action, reason, detail = null) {
    const now = this.#time(); action.status = "uncertain_outcome"; action.updatedAt = now.iso; action.error = { code: "RECONCILIATION_EXHAUSTED", category: "uncertain_outcome", message: reason, retryable: false, detail: detail ? redactMetadata(detail) : undefined }; action.nextReconciliationAtMs = null; this.#releaseLocks(action); this.#removeFromQueue(action.id);
    this.#auditEvent("action.reconciliation_exhausted", { actionId: action.id, sessionId: action.sessionId, correlationId: action.correlationId, verificationAttempts: action.verificationAttempts, reconciliationAttempts: action.reconciliationAttempts, reason });
  }

  #finishSuccess(action, result = action.executionResult) {
    const now = this.#time(); action.status = "succeeded"; action.result = clone(result); action.error = null; action.uncertainty = null; action.completedAt = now.iso; action.updatedAt = now.iso; this.#releaseLocks(action); this.#removeFromQueue(action.id);
    this.#auditEvent("action.succeeded", { actionId: action.id, sessionId: action.sessionId, correlationId: action.correlationId, executionAttempts: action.executionAttempts, verificationAttempts: action.verificationAttempts, reconciliationAttempts: action.reconciliationAttempts, reconciled: action.reconciliationAttempts > 0 });
  }

  #finishNotApplied(action, result) {
    const now = this.#time(); action.status = action.cancellationRequested ? "cancelled" : "failed"; action.error = action.cancellationRequested ? null : { code: "OUTCOME_NOT_APPLIED", category: "reconciled_not_applied", message: result?.message ?? "Read-only reconciliation concluded the side effect was not applied.", retryable: false }; action.updatedAt = now.iso; if (action.status === "cancelled") action.cancelledAt = now.iso; else action.failedAt = now.iso; action.uncertainty = null; this.#releaseLocks(action); this.#removeFromQueue(action.id);
    this.#auditEvent(action.status === "cancelled" ? "action.cancelled" : "action.failed", { actionId: action.id, sessionId: action.sessionId, correlationId: action.correlationId, reason: "reconciled_not_applied", executionAttempts: action.executionAttempts, verificationAttempts: action.verificationAttempts, reconciliationAttempts: action.reconciliationAttempts });
  }

  async #reconcileLeased(action, session, controller) {
    const start = this.#time(); action.status = "reconciling"; action.reconciliationAttempts += 1; this.metrics.increment("reconciliationAttempts"); action.updatedAt = start.iso;
    this.#auditEvent("action.reconciling", { actionId: action.id, sessionId: action.sessionId, correlationId: action.correlationId, reconciliationAttempt: action.reconciliationAttempts, executionAttempts: action.executionAttempts }); this.#persist();
    let evidence = action.executorEvidence;
    try {
      if (action.executionOutcome !== "succeeded") {
        const provider = this.providers.get(action.provider);
        evidence = typeof provider.readOutcomeEvidence === "function" ? await provider.readOutcomeEvidence(clone(action), { signal: controller.signal, reconciliationAttempt: action.reconciliationAttempts, session: clone(session) }) : { outcome: "unknown", source: action.provider, requestId: action.id, reason: "no_evidence_reader" };
        action.executorEvidence = clone(evidence);
      }
      const evidenceOutcome = evidence?.outcome ?? (action.executionOutcome === "succeeded" ? "succeeded" : "unknown");
      if (
        evidenceOutcome === "not_dispatched" &&
        evidence?.contract === "pc_executor.outcome_journal.lookup.v1" &&
        evidence?.safeNotStarted === true
      ) {
        const now = this.#time();
        if (action.cancellationRequested) {
          this.#finishNotApplied(action, { message: "Journal proved the interrupted attempt was not started before cancellation." });
          return;
        }
        if (action.executionAttempts < action.maxAttempts) {
          action.status = "retry_wait";
          action.error = {
            code: "JOURNAL_CONFIRMED_NOT_STARTED",
            category: "confirmed_not_dispatched",
            message: "Read-only Executor journal proved the interrupted attempt was not started.",
            retryable: true,
          };
          action.nextAttemptAtMs = now.ms + action.retryDelayMs;
          action.updatedAt = now.iso;
          action.uncertainty = null;
          this.#releaseLocks(action);
          this.#enqueueId(action.id);
          this.metrics.increment("retries");
          this.#auditEvent("action.retry_wait", {
            actionId: action.id,
            sessionId: action.sessionId,
            correlationId: action.correlationId,
            executionAttempt: action.executionAttempts,
            maxAttempts: action.maxAttempts,
            reason: "journal_confirmed_not_started",
            evidenceContract: evidence.contract,
            executionCorrelation: action.executionCorrelation,
          });
          return;
        }
        this.#finishNotApplied(action, { message: "Journal proved the interrupted attempt was not started, but the bounded execution-attempt budget is exhausted." });
        return;
      }
      if (evidenceOutcome === "blocked" || evidenceOutcome === "failed") {
        const now = this.#time(); action.status = "failed"; action.error = { code: evidenceOutcome === "blocked" ? "EXECUTOR_BLOCKED" : "EXECUTOR_FAILED", category: "reconciled_failure", message: "Executor evidence reports no successful side effect.", retryable: false }; action.failedAt = now.iso; action.updatedAt = now.iso; action.uncertainty = null; this.#releaseLocks(action); this.#removeFromQueue(action.id);
        this.#auditEvent("action.failed", { actionId: action.id, sessionId: action.sessionId, correlationId: action.correlationId, reason: "executor_evidence", evidenceOutcome }); return;
      }
      if (["not_dispatched", "cancelled"].includes(evidenceOutcome)) { this.#finishNotApplied(action, { message: `Executor evidence outcome: ${evidenceOutcome}` }); return; }
      if (evidenceOutcome === "succeeded") action.executionOutcome = "succeeded";

      if (action.verification) {
        const verification = await this.#runVerification(action, session, controller, { reconciliation: true });
        if (verification.kind === "success") { this.#finishSuccess(action); return; }
        if (verification.kind === "not_applied") { this.#finishNotApplied(action, verification.result); return; }
        if (verification.kind === "inconclusive") {
          if (action.verificationAttempts < action.maxVerificationAttempts && action.reconciliationAttempts < action.maxReconciliationAttempts) this.#scheduleReconciliation(action, "verification_inconclusive", { error: verification.result });
          else this.#exhaustReconciliation(action, "Read-only verification remained stale or inconclusive within bounded attempts.", verification.result);
          return;
        }
        const now = this.#time(); action.status = "failed"; action.error = verification.error ?? { code: verification.result?.code ?? "VERIFICATION_FAILED", category: verification.result?.category ?? "verification_error", message: verification.result?.message ?? "Verification failed.", retryable: false }; action.failedAt = now.iso; action.updatedAt = now.iso; action.uncertainty = null; this.#releaseLocks(action); this.#removeFromQueue(action.id); this.#auditEvent("action.failed", { actionId: action.id, sessionId: action.sessionId, correlationId: action.correlationId, reason: "verification_failed", error: action.error }); return;
      }

      if (evidenceOutcome === "succeeded") { this.#finishSuccess(action); return; }
      if (action.reconciliationAttempts < action.maxReconciliationAttempts) this.#scheduleReconciliation(action, "executor_evidence_inconclusive", { error: evidence });
      else this.#exhaustReconciliation(action, "Executor outcome evidence remained unknown within bounded read-only attempts.", evidence);
    } catch (error) {
      if (error?.category === "journal_evidence_invalid") {
        const now = this.#time();
        action.status = "blocked";
        action.error = errorInfo(error);
        action.blockedAt = now.iso;
        action.updatedAt = now.iso;
        action.uncertainty = null;
        this.#releaseLocks(action);
        this.#removeFromQueue(action.id);
        this.#auditEvent("action.blocked", {
          actionId: action.id,
          sessionId: action.sessionId,
          correlationId: action.correlationId,
          reason: "journal_evidence_invalid",
          error: action.error,
          executionCorrelation: action.executionCorrelation,
        });
      } else if (action.reconciliationAttempts < action.maxReconciliationAttempts) this.#scheduleReconciliation(action, "reconciliation_adapter_error", { error: errorInfo(error) });
      else this.#exhaustReconciliation(action, "Reconciliation adapter failed within bounded attempts.", errorInfo(error));
    } finally {
      this.metrics.recordDuration("reconciliationLatency", Math.max(0, this.#time().ms - start.ms)); this.controllers.delete(action.id); this.#persist();
    }
  }

  async executeLeased(actionId, { workerId = null } = {}) {
    const action = this.#action(actionId); if (action.status !== "leased" || !action.lease) throw new ControlPlaneError("Action is not leased.", "ACTION_NOT_LEASED", { actionId }); if (workerId && action.lease.workerId !== workerId) throw new ControlPlaneError("Lease is owned by another worker.", "LEASE_OWNED", { actionId, owner: action.lease.workerId });
    const session = this.#session(action.sessionId); const controller = new AbortController(); this.controllers.set(action.id, controller); const mode = action.lease.mode;
    if (mode === "reconcile") { await this.#reconcileLeased(action, session, controller); return clone(action); }
    let executionStart;
    try {
      let now = this.#time(); action.status = "executing"; action.executionAttempts += 1; action.attempts = action.executionAttempts; this.metrics.increment("executionAttempts"); action.executingAt = now.iso; action.dispatchStartedAt = now.iso; action.updatedAt = now.iso; executionStart = now.ms;
      const provider = this.providers.get(action.provider);
      action.executionCorrelation = typeof provider.executionCorrelation === "function"
        ? clone(provider.executionCorrelation(clone(action), action.executionAttempts))
        : { requestId: action.id, action: action.type, executionAttempt: action.executionAttempts };
      this.#auditEvent("action.executing", { actionId, sessionId: action.sessionId, correlationId: action.correlationId, executionAttempt: action.executionAttempts, executionCorrelation: action.executionCorrelation, workerId: action.lease.workerId }); this.#persist();
      const execution = await provider.execute(clone(action), { signal: controller.signal, executionAttempt: action.executionAttempts, session: clone(session) });
      now = this.#time(); this.metrics.recordDuration("executionLatency", Math.max(0, now.ms - executionStart)); executionStart = undefined;
      const wrapped = execution && typeof execution === "object" && Object.hasOwn(execution, "result") && Object.hasOwn(execution, "evidence");
      action.executionResult = clone(wrapped ? execution.result : execution); action.executorEvidence = clone(wrapped ? execution.evidence : null); action.executionOutcome = "succeeded"; action.updatedAt = now.iso; this.#persist();
      if (action.cancellationRequested || controller.signal.aborted) { this.#transitionUncertain(action, "cancellation_race_after_dispatch", Object.assign(new Error(action.cancelReason ?? "cancelled"), { code: "CANCELLED", category: "cancelled", outcomeUncertain: true })); return clone(action); }
      if (action.verification) {
        const verification = await this.#runVerification(action, session, controller, { reconciliation: false });
        if (verification.kind === "success") this.#finishSuccess(action);
        else if (verification.kind === "not_applied") this.#finishNotApplied(action, verification.result);
        else if (verification.kind === "inconclusive") {
          if (action.verificationAttempts < action.maxVerificationAttempts) this.#scheduleReconciliation(action, "verification_inconclusive_after_known_execution", { error: verification.result });
          else this.#exhaustReconciliation(action, "Verification remained inconclusive after known execution.", verification.result);
        } else {
          const end = this.#time(); action.status = "failed"; action.error = verification.error ?? { code: verification.result?.code ?? "VERIFICATION_FAILED", category: verification.result?.category ?? "verification_error", message: verification.result?.message ?? "Verification failed.", retryable: false }; action.failedAt = end.iso; action.updatedAt = end.iso; this.#releaseLocks(action); this.#removeFromQueue(action.id); this.#auditEvent("action.failed", { actionId, sessionId: action.sessionId, correlationId: action.correlationId, reason: "verification_failed", error: action.error });
        }
      } else this.#finishSuccess(action);
    } catch (error) {
      const now = this.#time(); if (executionStart !== undefined) this.metrics.recordDuration("executionLatency", Math.max(0, now.ms - executionStart));
      if (action.status === "uncertain_outcome" || action.status === "reconciliation_wait") { this.controllers.delete(action.id); this.#persist(); return clone(action); }
      const info = errorInfo(error); if (error?.executorEvidence) action.executorEvidence = clone(error.executorEvidence);
      if (isPolicyBlocked(error)) {
        action.status = "blocked"; action.error = info; action.blockedAt = now.iso; action.updatedAt = now.iso; this.#releaseLocks(action); this.#removeFromQueue(action.id); this.#auditEvent("action.blocked", { actionId, sessionId: action.sessionId, correlationId: action.correlationId, error: info });
      } else if (info.dispatchState === "not_dispatched") {
        if (action.cancellationRequested || info.category === "cancelled") { action.status = "cancelled"; action.error = null; action.cancelledAt = now.iso; action.updatedAt = now.iso; this.#releaseLocks(action); this.#removeFromQueue(action.id); this.#auditEvent("action.cancelled", { actionId, sessionId: action.sessionId, correlationId: action.correlationId, reason: action.cancelReason ?? info.message, dispatchState: "not_dispatched" }); }
        else if (info.retryable && action.executionAttempts < action.maxAttempts) { action.status = "retry_wait"; action.error = info; action.nextAttemptAtMs = now.ms + action.retryDelayMs; action.updatedAt = now.iso; this.#releaseLocks(action); this.#enqueueId(action.id); this.metrics.increment("retries"); this.#auditEvent("action.retry_wait", { actionId, sessionId: action.sessionId, correlationId: action.correlationId, executionAttempt: action.executionAttempts, maxAttempts: action.maxAttempts, reason: "confirmed_not_dispatched", error: info }); }
        else { action.status = "failed"; action.error = info; action.failedAt = now.iso; action.updatedAt = now.iso; this.#releaseLocks(action); this.#removeFromQueue(action.id); this.#auditEvent("action.failed", { actionId, sessionId: action.sessionId, correlationId: action.correlationId, executionAttempt: action.executionAttempts, error: info }); }
      } else {
        this.#transitionUncertain(action, action.cancellationRequested ? "cancellation_race_after_dispatch" : "provider_outcome_unknown", error);
      }
    } finally { this.controllers.delete(action.id); this.#persist(); }
    return clone(action);
  }

  async processNext({ workerId = "processNext", leaseMs = this.defaultLeaseMs } = {}) { const leased = this.leaseNext({ workerId, leaseMs }); if (!leased) return null; return this.executeLeased(leased.id, { workerId }); }
  async drain({ limit = 1000, workerId = "drain" } = {}) { const processed = []; while (processed.length < limit) { const action = await this.processNext({ workerId }); if (!action) break; processed.push(action); } return processed; }

  #recoverInFlight(reason) {
    const now = this.#time(); const recovered = []; this.resourceLocks.clear(); this.controllers.clear();
    for (const action of this.actions.values()) {
      if (!["leased", "executing", "verifying", "reconciling"].includes(action.status)) continue;
      const previous = action.status; const mode = action.lease?.mode ?? "execute";
      action.lease = null; action.updatedAt = now.iso;
      if (previous === "leased") { action.status = mode === "reconcile" ? "reconciliation_wait" : "queued"; if (mode === "reconcile") action.nextReconciliationAtMs = now.ms; else action.nextAttemptAtMs = now.ms; this.#enqueueId(action.id); }
      else if (previous === "executing") this.#transitionUncertain(action, "process_restart_after_dispatch", Object.assign(new Error("Process restarted while side-effect dispatch was in flight."), { code: "PROCESS_RESTART", category: "uncertain_outcome", outcomeUncertain: true }));
      else { action.status = "reconciliation_wait"; action.nextReconciliationAtMs = now.ms; this.#enqueueId(action.id); this.#auditEvent("action.reconciliation_interrupted", { actionId: action.id, sessionId: action.sessionId, correlationId: action.correlationId, reason, previousStatus: previous }); }
      recovered.push(clone(action));
    }
    return recovered;
  }
  recover() { const recovered = this.#recoverInFlight("manual_recovery"); if (recovered.length) this.#persist(); return recovered; }
  getAuditLog({ afterSequence = 0, correlationId = null } = {}) { return this.audit.filter((entry) => entry.sequence > afterSequence && (!correlationId || entry.correlationId === correlationId)).map(clone); }
  getMetrics() { return this.metrics.snapshot(); }
  snapshot() { return clone({ version: 3, sessions: [...this.sessions.values()], desktopOwners: [...this.desktopOwners.entries()], actions: [...this.actions.values()], queue: this.queue, idempotency: [...this.idempotency.entries()], resourceLocks: [...this.resourceLocks.entries()], audit: this.audit, auditSequence: this.auditSequence, metrics: this.metrics.persisted() }); }
}
