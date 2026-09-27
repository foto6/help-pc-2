import { randomUUID } from "node:crypto";
import { ProviderRegistry } from "./adapters.js";
import { TERMINAL_ACTION_STATUSES, ValidationError, validateActionSpec } from "./schemas.js";

export class ControlPlaneError extends Error {
  constructor(message, code, details = undefined) {
    super(message);
    this.name = "ControlPlaneError";
    this.code = code;
    this.details = details;
  }
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export class ControlPlane {
  constructor({ providers = [], policy = {}, clock, idFactory, snapshot } = {}) {
    this.providers = providers instanceof ProviderRegistry ? providers : new ProviderRegistry(providers);
    this.policy = {
      permissions: new Set(policy.permissions ?? ["desktop.observe", "desktop.control"]),
      allowDestructive: policy.allowDestructive ?? false,
    };
    this.clock = clock ?? (() => new Date().toISOString());
    this.idFactory = idFactory ?? (() => randomUUID());
    this.sessions = new Map();
    this.desktopOwners = new Map();
    this.actions = new Map();
    this.queue = [];
    this.idempotency = new Map();
    this.resourceLocks = new Map();
    this.controllers = new Map();
    this.audit = [];
    this.auditSequence = 0;
    if (snapshot) this.#loadSnapshot(snapshot);
  }

  #loadSnapshot(snapshot) {
    for (const session of snapshot.sessions ?? []) this.sessions.set(session.id, clone(session));
    for (const [desktopId, sessionId] of snapshot.desktopOwners ?? []) this.desktopOwners.set(desktopId, sessionId);
    for (const action of snapshot.actions ?? []) this.actions.set(action.id, clone(action));
    this.queue = [...(snapshot.queue ?? [])];
    for (const pair of snapshot.idempotency ?? []) this.idempotency.set(pair[0], pair[1]);
    for (const pair of snapshot.resourceLocks ?? []) this.resourceLocks.set(pair[0], pair[1]);
    this.audit = clone(snapshot.audit ?? []);
    this.auditSequence = snapshot.auditSequence ?? this.audit.at(-1)?.sequence ?? 0;
  }

  #now() {
    return this.clock();
  }

  #audit(event, data = {}) {
    const entry = Object.freeze({
      sequence: ++this.auditSequence,
      at: this.#now(),
      event,
      ...clone(data),
    });
    this.audit.push(entry);
    return entry;
  }

  #session(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== "active") {
      throw new ControlPlaneError("Active session not found.", "SESSION_NOT_FOUND", { sessionId });
    }
    return session;
  }

  #action(actionId) {
    const action = this.actions.get(actionId);
    if (!action) throw new ControlPlaneError("Action not found.", "ACTION_NOT_FOUND", { actionId });
    return action;
  }

  createSession({ desktopId, principal = "anonymous", permissions, claimDesktop = true } = {}) {
    if (typeof desktopId !== "string" || !desktopId.trim()) {
      throw new ValidationError("desktopId is required.");
    }
    const granted = new Set(permissions ?? [...this.policy.permissions]);
    for (const permission of granted) {
      if (!this.policy.permissions.has(permission)) {
        throw new ControlPlaneError(`Permission '${permission}' is not allowed by policy.`, "PERMISSION_DENIED");
      }
    }
    const session = {
      id: this.idFactory(),
      desktopId: desktopId.trim(),
      principal,
      permissions: [...granted],
      status: "active",
      createdAt: this.#now(),
    };
    this.sessions.set(session.id, session);
    this.#audit("session.created", { sessionId: session.id, desktopId: session.desktopId, principal });
    if (claimDesktop) this.claimDesktop(session.id);
    return clone(session);
  }

  closeSession(sessionId) {
    const session = this.#session(sessionId);
    for (const action of this.actions.values()) {
      if (action.sessionId === sessionId && !TERMINAL_ACTION_STATUSES.has(action.status)) this.cancelAction(action.id, "session_closed");
    }
    if (this.desktopOwners.get(session.desktopId) === sessionId) this.releaseDesktop(sessionId);
    session.status = "closed";
    session.closedAt = this.#now();
    this.#audit("session.closed", { sessionId, desktopId: session.desktopId });
    return clone(session);
  }

  claimDesktop(sessionId) {
    const session = this.#session(sessionId);
    const owner = this.desktopOwners.get(session.desktopId);
    if (owner && owner !== sessionId) {
      throw new ControlPlaneError("Desktop is owned by another active session.", "DESKTOP_OWNED", {
        desktopId: session.desktopId,
        ownerSessionId: owner,
      });
    }
    this.desktopOwners.set(session.desktopId, sessionId);
    this.#audit("desktop.claimed", { sessionId, desktopId: session.desktopId });
    return { desktopId: session.desktopId, ownerSessionId: sessionId };
  }

  releaseDesktop(sessionId) {
    const session = this.#session(sessionId);
    if (this.desktopOwners.get(session.desktopId) !== sessionId) return false;
    this.desktopOwners.delete(session.desktopId);
    this.#audit("desktop.released", { sessionId, desktopId: session.desktopId });
    return true;
  }

  enqueueAction(sessionId, rawSpec) {
    const session = this.#session(sessionId);
    const spec = validateActionSpec(rawSpec);
    if (!session.permissions.includes(spec.permission) || !this.policy.permissions.has(spec.permission)) {
      throw new ControlPlaneError(`Permission '${spec.permission}' is required.`, "PERMISSION_DENIED");
    }
    if (spec.destructive) {
      if (!this.policy.allowDestructive || !session.permissions.includes("destructive")) {
        throw new ControlPlaneError("Destructive actions are disabled by default policy.", "DESTRUCTIVE_DISABLED");
      }
    }
    if (spec.requiresDesktop && this.desktopOwners.get(session.desktopId) !== sessionId) {
      throw new ControlPlaneError("Session does not own its desktop.", "DESKTOP_NOT_OWNED");
    }
    if (!this.providers.get(spec.provider)) {
      throw new ControlPlaneError(`Provider '${spec.provider}' is not registered.`, "PROVIDER_NOT_FOUND");
    }

    const idemScope = spec.idempotencyKey ? `${sessionId}:${spec.idempotencyKey}` : null;
    if (idemScope && this.idempotency.has(idemScope)) {
      const existing = this.#action(this.idempotency.get(idemScope));
      this.#audit("action.deduplicated", { actionId: existing.id, sessionId, idempotencyKey: spec.idempotencyKey });
      return clone(existing);
    }

    const confirmationRequired = spec.destructive || spec.confirmation === "required";
    const action = {
      id: this.idFactory(),
      sessionId,
      desktopId: session.desktopId,
      provider: spec.provider,
      type: spec.type,
      input: spec.input,
      resource: spec.resource ?? `desktop:${session.desktopId}`,
      permission: spec.permission,
      idempotencyKey: spec.idempotencyKey,
      maxAttempts: spec.maxAttempts,
      attempts: 0,
      confirmationRequired,
      confirmedBy: null,
      destructive: spec.destructive,
      requiresDesktop: spec.requiresDesktop,
      metadata: spec.metadata,
      status: confirmationRequired ? "awaiting_confirmation" : "queued",
      cancellationRequested: false,
      createdAt: this.#now(),
      updatedAt: this.#now(),
      result: null,
      error: null,
    };
    this.actions.set(action.id, action);
    if (idemScope) this.idempotency.set(idemScope, action.id);
    if (action.status === "queued") this.queue.push(action.id);
    this.#audit("action.enqueued", {
      actionId: action.id,
      sessionId,
      provider: action.provider,
      type: action.type,
      status: action.status,
      resource: action.resource,
    });
    return clone(action);
  }

  confirmAction(actionId, { approvedBy = "user" } = {}) {
    const action = this.#action(actionId);
    if (action.status !== "awaiting_confirmation") {
      throw new ControlPlaneError("Action is not awaiting confirmation.", "CONFIRMATION_NOT_REQUIRED");
    }
    action.confirmedBy = approvedBy;
    action.confirmedAt = this.#now();
    action.status = "queued";
    action.updatedAt = this.#now();
    this.queue.push(action.id);
    this.#audit("action.confirmed", { actionId, sessionId: action.sessionId, approvedBy });
    return clone(action);
  }

  cancelAction(actionId, reason = "user_requested") {
    const action = this.#action(actionId);
    if (TERMINAL_ACTION_STATUSES.has(action.status)) return clone(action);
    action.cancellationRequested = true;
    action.cancelReason = reason;
    action.updatedAt = this.#now();
    if (action.status === "running") {
      this.controllers.get(action.id)?.abort(new Error(reason));
      this.#audit("action.cancellation_requested", { actionId, sessionId: action.sessionId, reason });
    } else {
      action.status = "cancelled";
      action.cancelledAt = this.#now();
      this.#audit("action.cancelled", { actionId, sessionId: action.sessionId, reason });
    }
    return clone(action);
  }

  getAction(actionId) {
    return clone(this.#action(actionId));
  }

  listActions({ sessionId, status } = {}) {
    return [...this.actions.values()]
      .filter((action) => (!sessionId || action.sessionId === sessionId) && (!status || action.status === status))
      .map(clone);
  }

  #findRunnableIndex() {
    for (let i = 0; i < this.queue.length; i += 1) {
      const action = this.actions.get(this.queue[i]);
      if (!action || action.status !== "queued") continue;
      if (!this.resourceLocks.has(action.resource)) return i;
    }
    return -1;
  }

  async processNext() {
    const index = this.#findRunnableIndex();
    if (index < 0) return null;
    const [actionId] = this.queue.splice(index, 1);
    const action = this.#action(actionId);
    const session = this.#session(action.sessionId);
    if (action.requiresDesktop && this.desktopOwners.get(action.desktopId) !== action.sessionId) {
      action.status = "failed";
      action.error = { code: "DESKTOP_NOT_OWNED", message: "Desktop ownership was lost before execution." };
      action.updatedAt = this.#now();
      this.#audit("action.failed", { actionId, sessionId: action.sessionId, error: action.error });
      return clone(action);
    }

    this.resourceLocks.set(action.resource, action.id);
    const controller = new AbortController();
    this.controllers.set(action.id, controller);
    action.status = "running";
    action.attempts += 1;
    action.startedAt = this.#now();
    action.updatedAt = this.#now();
    this.#audit("action.started", {
      actionId,
      sessionId: action.sessionId,
      attempt: action.attempts,
      resource: action.resource,
    });

    try {
      const provider = this.providers.get(action.provider);
      const result = await provider.execute(clone(action), {
        signal: controller.signal,
        attempt: action.attempts,
        session: clone(session),
      });
      if (action.cancellationRequested || controller.signal.aborted) {
        action.status = "cancelled";
        action.cancelledAt = this.#now();
        this.#audit("action.cancelled", { actionId, sessionId: action.sessionId, reason: action.cancelReason ?? "aborted" });
      } else {
        action.status = "succeeded";
        action.result = clone(result);
        action.completedAt = this.#now();
        this.#audit("action.succeeded", { actionId, sessionId: action.sessionId, attempt: action.attempts });
      }
    } catch (error) {
      if (action.cancellationRequested || controller.signal.aborted) {
        action.status = "cancelled";
        action.cancelledAt = this.#now();
        action.error = null;
        this.#audit("action.cancelled", { actionId, sessionId: action.sessionId, reason: action.cancelReason ?? "aborted" });
      } else if (error?.retryable === true && action.attempts < action.maxAttempts) {
        action.status = "queued";
        action.error = { code: error.code ?? "RETRYABLE_ERROR", message: String(error.message ?? error) };
        action.updatedAt = this.#now();
        this.queue.push(action.id);
        this.#audit("action.retry_scheduled", {
          actionId,
          sessionId: action.sessionId,
          attempt: action.attempts,
          maxAttempts: action.maxAttempts,
          error: action.error,
        });
      } else {
        action.status = "failed";
        action.error = { code: error?.code ?? "PROVIDER_ERROR", message: String(error?.message ?? error) };
        action.failedAt = this.#now();
        this.#audit("action.failed", { actionId, sessionId: action.sessionId, attempt: action.attempts, error: action.error });
      }
    } finally {
      this.controllers.delete(action.id);
      if (this.resourceLocks.get(action.resource) === action.id) this.resourceLocks.delete(action.resource);
      action.updatedAt = this.#now();
    }
    return clone(action);
  }

  async drain({ limit = 1000 } = {}) {
    const processed = [];
    while (processed.length < limit) {
      const action = await this.processNext();
      if (!action) break;
      processed.push(action);
    }
    return processed;
  }

  recover() {
    const recovered = [];
    this.resourceLocks.clear();
    this.controllers.clear();
    for (const action of this.actions.values()) {
      if (action.status !== "running") continue;
      if (action.cancellationRequested) {
        action.status = "cancelled";
        action.cancelledAt = this.#now();
        this.#audit("action.recovered_cancelled", { actionId: action.id, sessionId: action.sessionId });
      } else {
        action.status = "queued";
        action.updatedAt = this.#now();
        if (!this.queue.includes(action.id)) this.queue.push(action.id);
        this.#audit("action.recovered", { actionId: action.id, sessionId: action.sessionId, attempts: action.attempts });
      }
      recovered.push(clone(action));
    }
    return recovered;
  }

  getAuditLog({ afterSequence = 0 } = {}) {
    return this.audit.filter((entry) => entry.sequence > afterSequence).map(clone);
  }

  snapshot() {
    return clone({
      version: 1,
      sessions: [...this.sessions.values()],
      desktopOwners: [...this.desktopOwners.entries()],
      actions: [...this.actions.values()],
      queue: this.queue,
      idempotency: [...this.idempotency.entries()],
      resourceLocks: [...this.resourceLocks.entries()],
      audit: this.audit,
      auditSequence: this.auditSequence,
    });
  }
}
