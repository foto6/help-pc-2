import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  DEFAULT_NATIVE_LIMITS,
  NATIVE_CONTROL_PROTOCOL_V1,
  NATIVE_RESPONSE_V1,
  TOOL_REGISTRY_DIGEST,
  assertCapabilityNegotiation,
  canonicalJson,
  nativeCapabilityManifestV1,
  sha256,
  toolDefinition,
} from "./native-registry.js";

const TERMINAL = new Set(["succeeded", "blocked", "cancelled", "failed"]);
const RECONCILING = new Set(["uncertain_outcome", "reconciliation_wait", "reconciling"]);
const ACTIVE_SESSION = "active";
const STORE_VERSION = 1;

export class NativeFacadeError extends Error {
  constructor(message, {
    code = "NATIVE_FACADE_ERROR",
    category = "facade_error",
    retryable = false,
    httpStatus = 400,
    details = null,
  } = {}) {
    super(message);
    this.name = "NativeFacadeError";
    this.code = code;
    this.category = category;
    this.retryable = retryable;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export class JsonFacadeStateStore {
  constructor(path) { this.path = path; }
  load() {
    if (!existsSync(this.path)) return null;
    let parsed;
    try { parsed = JSON.parse(readFileSync(this.path, "utf8")); }
    catch (error) { throw new NativeFacadeError(`Native facade state is corrupted: ${error.message}`, { code: "FACADE_STATE_CORRUPTED", httpStatus: 500 }); }
    if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.sessions) || !Array.isArray(parsed.requests) || !Array.isArray(parsed.handles)) {
      throw new NativeFacadeError("Native facade state schema is invalid.", { code: "FACADE_STATE_CORRUPTED", httpStatus: 500 });
    }
    return parsed;
  }
  save(snapshot) {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(temp, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    try { renameSync(temp, this.path); }
    catch (error) { try { unlinkSync(temp); } catch {} throw error; }
  }
}

function asFacadeError(error, fallbackCode = "NATIVE_FACADE_ERROR") {
  if (error instanceof NativeFacadeError) return error;
  return new NativeFacadeError(String(error?.message ?? error), {
    code: error?.code ?? fallbackCode,
    category: error?.category ?? "facade_error",
    retryable: error?.retryable === true,
    httpStatus: error?.httpStatus ?? 400,
    details: error?.details ?? null,
  });
}

function defaultState() {
  return { version: STORE_VERSION, sessions: [], requests: [], handles: [] };
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function normalizedPath(value) {
  return value.replaceAll("/", "\\").replace(/\\+/g, "\\").toLowerCase();
}

function hasProtectedPath(value) {
  if (typeof value === "string") {
    const path = normalizedPath(value);
    return path === "e:\\manhwa" || path.startsWith("e:\\manhwa\\");
  }
  if (Array.isArray(value)) return value.some(hasProtectedPath);
  if (value && typeof value === "object") return Object.values(value).some(hasProtectedPath);
  return false;
}

function extractHandle(data) {
  if (!data || typeof data !== "object") return null;
  for (const key of ["process_handle", "session_handle", "handle", "handle_id", "session_id"]) {
    if (typeof data[key] === "string" && data[key]) return data[key];
  }
  return null;
}

function inputHandle(input) {
  if (!input || typeof input !== "object") return null;
  for (const key of ["process_handle", "session_handle", "handle", "handle_id", "session_id"]) {
    if (typeof input[key] === "string" && input[key]) return input[key];
  }
  return null;
}

function encodeCursor(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(cursor) {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!value || value.v !== 1 || typeof value.session !== "string" || typeof value.tool !== "string" || !Object.hasOwn(value, "inner")) throw new Error("invalid cursor");
    return value;
  } catch {
    throw new NativeFacadeError("Malformed stream cursor.", { code: "MALFORMED_STREAM_CURSOR", category: "invalid_cursor" });
  }
}

export function responseEnvelope({ requestId = null, sessionId = null, status, data = null, error = null, stream = null }) {
  return {
    contract_version: NATIVE_RESPONSE_V1,
    request_id: requestId,
    session_id: sessionId,
    status,
    data,
    error,
    stream,
  };
}

export function errorEnvelope(error, { requestId = null, sessionId = null } = {}) {
  const e = asFacadeError(error);
  return responseEnvelope({
    requestId,
    sessionId,
    status: "error",
    error: {
      code: e.code,
      category: e.category,
      message: e.message,
      retryable: e.retryable,
      details: e.details,
    },
  });
}

export class NativeControlFacade {
  constructor({
    controlPlane,
    store = null,
    capabilityProvider = async () => null,
    deviceIdentityProvider = null,
    deviceIdentityObserver = null,
    deviceIdentityRebinder = null,
    idFactory = randomUUID,
    secretFactory = () => randomBytes(24).toString("base64url"),
    sessionTtlMs = 30 * 60 * 1000,
    maxPageSize = DEFAULT_NATIVE_LIMITS.maxPageSize,
    clock = Date.now,
  } = {}) {
    if (!controlPlane) throw new TypeError("controlPlane is required.");
    if (typeof capabilityProvider !== "function") throw new TypeError("capabilityProvider must be a function.");
    if (deviceIdentityProvider !== null && typeof deviceIdentityProvider !== "function") {
      throw new TypeError("deviceIdentityProvider must be a function or null.");
    }
    if (deviceIdentityObserver !== null && typeof deviceIdentityObserver !== "function") {
      throw new TypeError("deviceIdentityObserver must be a function or null.");
    }
    if (deviceIdentityRebinder !== null && typeof deviceIdentityRebinder !== "function") {
      throw new TypeError("deviceIdentityRebinder must be a function or null.");
    }
    this.controlPlane = controlPlane;
    this.store = store;
    this.capabilityProvider = capabilityProvider;
    this.deviceIdentityProvider = deviceIdentityProvider;
    this.deviceIdentityObserver = deviceIdentityObserver;
    this.deviceIdentityRebinder = deviceIdentityRebinder;
    this.idFactory = idFactory;
    this.secretFactory = secretFactory;
    this.sessionTtlMs = sessionTtlMs;
    this.maxPageSize = maxPageSize;
    this.clock = clock;
    this.state = store?.load() ?? defaultState();
  }

  #persist() { this.store?.save(this.state); }

  #validatedDeviceIdentity(identity, executorDigest) {
    if (!identity || typeof identity.deviceId !== "string" || !identity.deviceId ||
        typeof identity.sessionEpoch !== "string" || !identity.sessionEpoch ||
        identity.executorDigest !== executorDigest) {
      throw new NativeFacadeError("Authenticated device/epoch binding is invalid.", {
        code: "DEVICE_IDENTITY_MISMATCH", category: "session", httpStatus: 409,
      });
    }
    return {
      deviceId: identity.deviceId,
      sessionEpoch: identity.sessionEpoch,
      executorDigest: identity.executorDigest,
    };
  }

  async #captureDeviceIdentity(executorDigest, signal = null) {
    if (!this.deviceIdentityProvider) return null;
    return this.#validatedDeviceIdentity(
      await this.deviceIdentityProvider({ signal }),
      executorDigest,
    );
  }

  async #observeDeviceIdentity(executorDigest, signal = null) {
    const provider = this.deviceIdentityObserver ?? this.deviceIdentityProvider;
    if (!provider) return null;
    return this.#validatedDeviceIdentity(
      await provider({ signal }),
      executorDigest,
    );
  }

  #assertDeviceIdentity(before, after) {
    if (!before || !after || before.deviceId !== after.deviceId ||
        before.sessionEpoch !== after.sessionEpoch ||
        before.executorDigest !== after.executorDigest) {
      throw new NativeFacadeError("Device boot/session epoch cannot be proved unchanged.", {
        code: "STALE_DEVICE_SESSION", category: "session", httpStatus: 409,
      });
    }
  }

  #controlOwner(desktopId) {
    const snapshot = this.controlPlane.snapshot();
    return snapshot.desktopOwners.find(([name]) => name === desktopId)?.[1] ?? null;
  }

  async #rebindQuiescentDeviceIdentity(session, currentIdentity, signal = null) {
    const previous = session.deviceIdentity;
    if (!previous || !currentIdentity ||
        previous.deviceId !== currentIdentity.deviceId ||
        previous.executorDigest !== currentIdentity.executorDigest ||
        previous.sessionEpoch === currentIdentity.sessionEpoch ||
        !this.deviceIdentityObserver || !this.deviceIdentityRebinder) {
      throw new NativeFacadeError("Device boot/session epoch cannot be safely rebound.", {
        code: "STALE_DEVICE_SESSION", category: "session", httpStatus: 409,
      });
    }
    const control = this.controlPlane.listSessions()
      .find((entry) => entry.id === session.controlSessionId);
    const unfinishedActions = this.controlPlane.listActions({ sessionId: session.controlSessionId })
      .some((action) => !TERMINAL.has(action.status));
    const unsettledRequests = this.state.requests.some((request) =>
      request.sessionId === session.id &&
      !["completed", "cancelled", "error"].includes(request.status));
    if (control?.status !== "active" ||
        this.#controlOwner(session.desktopId) !== session.controlSessionId ||
        unfinishedActions || unsettledRequests) {
      throw new NativeFacadeError("Device boot/session epoch changed while the session owns unsettled work.", {
        code: "STALE_DEVICE_SESSION", category: "session", httpStatus: 409,
      });
    }
    this.#synchronizeHandleJournal(session);
    const openHandle = this.state.handles.some((record) =>
      record.sessionId === session.id && record.status === "open");
    if (openHandle) {
      throw new NativeFacadeError("Device boot/session epoch changed while the session owns a live process handle.", {
        code: "STALE_DEVICE_SESSION", category: "process_handle", httpStatus: 409,
      });
    }
    let committed = currentIdentity;
    if (this.deviceIdentityRebinder) {
      committed = this.#validatedDeviceIdentity(
        await this.deviceIdentityRebinder({ previous: clone(previous), current: clone(currentIdentity) }, { signal }),
        currentIdentity.executorDigest,
      );
      this.#assertDeviceIdentity(currentIdentity, committed);
    } else if (this.deviceIdentityObserver) {
      throw new NativeFacadeError("Device identity can be observed but no explicit provider rebind hook is available.", {
        code: "SESSION_DEVICE_REBIND_BLOCKED", category: "session", httpStatus: 409,
      });
    }
    session.deviceIdentity = clone(committed);
    session.deviceRebindCount = (session.deviceRebindCount ?? 0) + 1;
    session.lastDeviceRebindAtMs = this.clock();
    this.#persist();
    return clone(committed);
  }

  // Rehydrate only known terminal Executor action results. Never query/replay
  // the provider here. A crash after Control persisted process.start but before
  // the facade recorded the handle must not silently orphan that process.
  #synchronizeHandleJournal(session) {
    const actions = this.controlPlane.listActions({ sessionId: session.controlSessionId })
      // Control's append-only action insertion order survives persistence.
      // Do not sort by same-millisecond timestamps/random UUID: that could
      // replay process.close BEFORE process.start and resurrect a dead handle.
      .filter((action) => action.metadata?.native_session_id === session.id &&
        action.status === "succeeded");
    for (const action of actions) {
      const tool = toolDefinition(action.metadata.native_tool);
      if (!tool || !["create", "close"].includes(tool.handleMode)) continue;
      if (tool.handleMode === "create") {
        const raw = action.result ?? action.executionResult ?? null;
        const handle = extractHandle(raw?.data ?? raw);
        if (!handle) {
          throw new NativeFacadeError("Completed process creation lacks durable handle evidence.", {
            code: "SESSION_HANDLE_RECONCILIATION_REQUIRED", category: "process_handle", httpStatus: 409,
          });
        }
        this.#registerHandle(session, tool, { process_handle: handle });
      } else {
        this.#closeHandle(session, tool, action.input);
      }
    }
    this.#persist();
  }

  // A persisted ACTIVE R15c session has no historical epoch stamp. Attach
  // the NEW current boot epoch only when its old Control owner is exact and
  // quiescent and all prior process handles are demonstrably closed. This
  // cannot retroactively prove an unsettled action ran on the current boot.
  async #bindLegacyQuiescentIdentity(session, executorDigest) {
    if (!this.deviceIdentityProvider || session.deviceIdentity) return;
    const control = this.controlPlane.listSessions()
      .find((entry) => entry.id === session.controlSessionId);
    const unfinished = this.controlPlane.listActions({ sessionId: session.controlSessionId })
      .some((action) => !TERMINAL.has(action.status));
    if (control?.status !== "active" ||
        this.#controlOwner(session.desktopId) !== session.controlSessionId ||
        unfinished) {
      throw new NativeFacadeError("Active legacy session has unsettled work or ownership mismatch; epoch cannot be rebound.", {
        code: "SESSION_DEVICE_BINDING_MISSING", category: "session", httpStatus: 409,
      });
    }
    this.#synchronizeHandleJournal(session);
    const handles = this.state.handles.some((record) =>
      record.sessionId === session.id && record.status === "open");
    if (handles) {
      throw new NativeFacadeError("Active historical process handle has no frozen boot epoch.", {
        code: "SESSION_DEVICE_BINDING_MISSING", category: "process_handle", httpStatus: 409,
      });
    }
    // Failure to fetch an authoritative private relay identity blocks
    // migration, rather than minting a local or derived epoch.
    session.deviceIdentity = await this.#captureDeviceIdentity(executorDigest);
    if (!session.deviceIdentity) {
      throw new NativeFacadeError("No authenticated device epoch is available for legacy binding.", {
        code: "SESSION_DEVICE_BINDING_MISSING", category: "session", httpStatus: 409,
      });
    }
    this.#persist();
  }

  async capabilities({ signal = null, allowEpochObservation = false } = {}) {
    const executorCapabilities = await this.capabilityProvider({ signal, allowEpochObservation });
    return nativeCapabilityManifestV1({
      executorCapabilities,
      limits: { ...DEFAULT_NATIVE_LIMITS, maxPageSize: this.maxPageSize },
    });
  }

  #session(sessionId) {
    const session = this.state.sessions.find((item) => item.id === sessionId);
    if (!session || session.status !== ACTIVE_SESSION) {
      throw new NativeFacadeError("Session is stale or closed.", { code: "STALE_SESSION", category: "session", httpStatus: 409 });
    }
    if (this.clock() - session.lastSeenAtMs > this.sessionTtlMs) {
      session.status = "stale";
      session.staleReason = "ttl_expired";
      this.#persist();
      throw new NativeFacadeError("Session expired.", { code: "STALE_SESSION", category: "session", httpStatus: 409 });
    }
    return session;
  }

  async #negotiate(client, { signal = null, allowEpochObservation = false } = {}) {
    const manifest = await this.capabilities({ signal, allowEpochObservation });
    try { assertCapabilityNegotiation(client, manifest); }
    catch (error) {
      throw new NativeFacadeError(error.message, {
        code: error.code ?? "CAPABILITY_MISMATCH",
        category: "capability_mismatch",
        httpStatus: 409,
        details: { expected: error.expected ?? null, actual: error.actual ?? null },
      });
    }
    return manifest;
  }

  async openSession({ desktopId, client }) {
    if (typeof desktopId !== "string" || !desktopId.trim()) {
      throw new NativeFacadeError("desktopId is required.", { code: "INVALID_ARGUMENT" });
    }
    const manifest = await this.#negotiate(client);
    const deviceIdentity = await this.#captureDeviceIdentity(manifest.executor?.digest ?? null);
    const controlSession = this.controlPlane.createSession({ desktopId: desktopId.trim() });
    const now = this.clock();
    const session = {
      id: this.idFactory(),
      controlSessionId: controlSession.id,
      desktopId: desktopId.trim(),
      resumeToken: this.secretFactory(),
      status: ACTIVE_SESSION,
      createdAtMs: now,
      lastSeenAtMs: now,
      registryDigest: TOOL_REGISTRY_DIGEST,
      executorDigest: manifest.executor?.digest ?? null,
      deviceIdentity,
    };
    this.state.sessions.push(session);
    this.#persist();
    return {
      session_id: session.id,
      resume_token: session.resumeToken,
      capability_manifest: manifest,
    };
  }

  async reconnectSession({ sessionId, resumeToken, client, allowQuiescentDeviceRebind = false }) {
    const session = this.#session(sessionId);
    if (typeof resumeToken !== "string" || resumeToken !== session.resumeToken) {
      throw new NativeFacadeError("Resume token is invalid.", { code: "SESSION_AUTH_FAILED", category: "auth", httpStatus: 401 });
    }
    const manifest = await this.#negotiate(client, {
      allowEpochObservation: allowQuiescentDeviceRebind,
    });
    if ((manifest.executor?.digest ?? null) !== session.executorDigest) {
      session.status = "stale";
      session.staleReason = "capability_drift";
      this.#persist();
      throw new NativeFacadeError("Executor capabilities drifted since session creation.", { code: "CAPABILITY_DRIFT", category: "capability_mismatch", httpStatus: 409 });
    }
    if (session.deviceIdentity) {
      let currentIdentity;
      try {
        currentIdentity = await this.#captureDeviceIdentity(manifest.executor?.digest ?? null);
      } catch (error) {
        if (!allowQuiescentDeviceRebind || error?.code !== "STALE_DEVICE_SESSION" ||
            !this.deviceIdentityObserver) throw error;
        currentIdentity = await this.#observeDeviceIdentity(manifest.executor?.digest ?? null);
      }
      try {
        this.#assertDeviceIdentity(session.deviceIdentity, currentIdentity);
      } catch (error) {
        if (!allowQuiescentDeviceRebind || error?.code !== "STALE_DEVICE_SESSION") throw error;
        await this.#rebindQuiescentDeviceIdentity(session, currentIdentity);
      }
    } else if (this.deviceIdentityProvider) {
      await this.#bindLegacyQuiescentIdentity(session, manifest.executor?.digest ?? null);
    }
    session.lastSeenAtMs = this.clock();
    this.#persist();
    return { session_id: session.id, capability_manifest: manifest };
  }

  // TTL is a security boundary. Renew only a specifically authenticated, provably
  // expired session; do not revive it, replay its requests, or steal a desktop lease.
  async renewExpiredSession({ sessionId, resumeToken, desktopId, client }) {
    const prior = this.state.sessions.find((item) => item.id === sessionId);
    const supplied = typeof resumeToken === "string" ? Buffer.from(resumeToken, "utf8") : null;
    const expected = typeof prior?.resumeToken === "string" ? Buffer.from(prior.resumeToken, "utf8") : null;
    if (!prior || !supplied || !expected || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new NativeFacadeError("Renewal credentials are invalid.", { code: "SESSION_AUTH_FAILED", category: "auth", httpStatus: 401 });
    }
    if (desktopId !== prior.desktopId) {
      throw new NativeFacadeError("Desktop identity changed.", { code: "SESSION_DESKTOP_DRIFT", category: "session", httpStatus: 409 });
    }
    if (prior.status !== "stale" || prior.staleReason !== "ttl_expired" ||
        this.clock() - prior.lastSeenAtMs <= this.sessionTtlMs) {
      throw new NativeFacadeError("Only proven TTL expiry can be renewed.", { code: "STALE_SESSION", category: "session", httpStatus: 409 });
    }
    const manifest = await this.#negotiate(client);
    if (manifest.registry_digest !== prior.registryDigest ||
        (manifest.executor?.digest ?? null) !== prior.executorDigest) {
      throw new NativeFacadeError("Renewal capabilities drifted.", { code: "CAPABILITY_DRIFT", category: "capability_mismatch", httpStatus: 409 });
    }
    const activeActions = this.controlPlane.listActions({ sessionId: prior.controlSessionId })
      .filter((action) => !TERMINAL.has(action.status));
    const controlSession = this.controlPlane.listSessions()
      .find((entry) => entry.id === prior.controlSessionId);
    if (activeActions.length || controlSession?.status !== "active" ||
        this.#controlOwner(prior.desktopId) !== prior.controlSessionId) {
      throw new NativeFacadeError("Old desktop still owns unsettled work or ownership drifted.", {
        code: "SESSION_RENEWAL_BLOCKED", category: "session", httpStatus: 409,
      });
    }
    this.#synchronizeHandleJournal(prior);
    const activeHandles = this.state.handles.some((handle) =>
      handle.sessionId === prior.id && handle.status === "open");
    const currentIdentity = await this.#captureDeviceIdentity(manifest.executor?.digest ?? null);
    if (prior.deviceIdentity) this.#assertDeviceIdentity(prior.deviceIdentity, currentIdentity);
    if (activeHandles) {
      if (!prior.deviceIdentity) {
        throw new NativeFacadeError("A live handle cannot be rebound without frozen boot/epoch evidence.", {
          code: "SESSION_RENEWAL_BLOCKED", category: "process_handle", httpStatus: 409,
        });
      }
      // Keep the SAME Control/facade session so already-running process handles
      // retain their owner. Token rotates; nothing is sent to the Executor.
      prior.status = ACTIVE_SESSION;
      prior.staleReason = null;
      prior.resumeToken = this.secretFactory();
      prior.lastSeenAtMs = this.clock();
      prior.renewalCount = (prior.renewalCount ?? 0) + 1;
      this.#persist();
      return {
        session_id: prior.id,
        resume_token: prior.resumeToken,
        capability_manifest: manifest,
      };
    }
    // Prepare all fallible negotiation/identity checks before releasing lease.
    try {
      this.controlPlane.closeSession(prior.controlSessionId);
    } catch {
      throw new NativeFacadeError("Old desktop lease could not be released.", {
        code: "SESSION_RENEWAL_BLOCKED", category: "session", httpStatus: 409,
      });
    }
    // Retain the historical TTL-stale facade marker for durable audit.
    // The old Control owner is already persisted closed at this boundary.
    this.#persist();
    const renewed = await this.openSession({ desktopId: prior.desktopId, client });
    const next = this.state.sessions.find((session) => session.id === renewed.session_id);
    next.renewalOf = prior.id;
    this.#persist();
    return renewed;
  }

  // Explicit LOCAL single-owner upgrade of historical R15 stale snapshots.
  // Never revive a session with an unknown stale reason or touch the Executor.
  async migrateLegacyQuiescentSession({ sessionId, desktopId, client }) {
    const prior = this.state.sessions.find((entry) => entry.id === sessionId);
    if (!prior || prior.desktopId !== desktopId ||
        prior.status !== "stale" || prior.staleReason != null ||
        !Number.isFinite(prior.lastSeenAtMs) ||
        this.clock() - prior.lastSeenAtMs <= this.sessionTtlMs) {
      throw new NativeFacadeError("Legacy migration is not an expired quiescent session.", {
        code: "SESSION_MIGRATION_BLOCKED", category: "session", httpStatus: 409,
      });
    }
    const manifest = await this.#negotiate(client);
    if (manifest.registry_digest !== prior.registryDigest ||
        (manifest.executor?.digest ?? null) !== prior.executorDigest) {
      throw new NativeFacadeError("Legacy capability identity changed.", {
        code: "CAPABILITY_DRIFT", category: "capability_mismatch", httpStatus: 409,
      });
    }
    if (this.state.sessions.some((entry) => entry !== prior &&
      entry.desktopId === desktopId && entry.status === ACTIVE_SESSION)) {
      throw new NativeFacadeError("Concurrent facade owner prevents legacy migration.", {
        code: "SESSION_MIGRATION_BLOCKED", category: "session", httpStatus: 409,
      });
    }
    const actions = this.controlPlane.listActions({ sessionId: prior.controlSessionId });
    if (actions.some((action) => !TERMINAL.has(action.status))) {
      throw new NativeFacadeError("Old action must be reconciled before migration.", {
        code: "SESSION_MIGRATION_BLOCKED", category: "session", httpStatus: 409,
      });
    }
    this.#synchronizeHandleJournal(prior);
    if (this.state.handles.some((item) => item.sessionId === prior.id && item.status === "open")) {
      throw new NativeFacadeError("A live process handle prevents migration; preserve its owner.", {
        code: "SESSION_MIGRATION_BLOCKED", category: "process_handle", httpStatus: 409,
      });
    }
    const control = this.controlPlane.listSessions().find((item) => item.id === prior.controlSessionId);
    const owner = this.#controlOwner(desktopId);
    // This also resumes an interrupted two-store migration after Control
    // closed its old owner but before Facade persisted the closed marker.
    if (control?.status === "active" && owner === prior.controlSessionId) {
      this.controlPlane.closeSession(prior.controlSessionId);
    } else if (control?.status !== "closed" || owner !== null) {
      throw new NativeFacadeError("Legacy Control ownership does not match snapshot.", {
        code: "SESSION_MIGRATION_BLOCKED", category: "session", httpStatus: 409,
      });
    }
    prior.status = "closed";
    prior.staleReason = "legacy_quiescent_migrated";
    prior.lastSeenAtMs = this.clock();
    this.#persist();
    return { session_id: prior.id, status: "closed", migrated: true };
  }

  closeSession(sessionId) {
    let session;
    let expired = false;
    try {
      session = this.#session(sessionId);
    } catch (error) {
      // A deliberate close after an idle TTL must not strand an otherwise
      // unowned Control desktop. Never retire an ambiguous/in-flight session.
      session = this.state.sessions.find((entry) => entry.id === sessionId);
      if (error?.code !== "STALE_SESSION" || session?.status !== "stale" ||
          session.staleReason !== "ttl_expired") throw error;
      expired = true;
    }
    const unfinished = this.controlPlane.listActions({ sessionId: session.controlSessionId })
      .some((action) => !TERMINAL.has(action.status));
    if (!unfinished) this.#synchronizeHandleJournal(session);
    const handles = this.state.handles.some((entry) =>
      entry.sessionId === session.id && entry.status === "open");
    if (unfinished || handles) {
      throw new NativeFacadeError("Session still owns unfinished work or live handles; explicit reconciliation is required.", {
        code: "SESSION_CLOSE_BLOCKED", category: "session", httpStatus: 409,
      });
    }
    try {
      this.controlPlane.closeSession(session.controlSessionId);
    } catch {
      throw new NativeFacadeError("Control desktop close failed.", {
        code: "SESSION_CLOSE_BLOCKED", category: "session", httpStatus: 409,
      });
    }
    session.status = "closed";
    session.lastSeenAtMs = this.clock();
    this.#persist();
    return { session_id: session.id, status: session.status };
  }

  async #assertLiveCapabilities(session, signal = null) {
    const current = await this.capabilityProvider({ signal });
    const digest = current?.digest ?? current?.capabilities_digest ?? null;
    if (digest !== session.executorDigest) {
      session.status = "stale";
      session.staleReason = "capability_drift";
      this.#persist();
      throw new NativeFacadeError("Executor capability digest changed.", { code: "CAPABILITY_DRIFT", category: "capability_mismatch", httpStatus: 409 });
    }
    if (!session.deviceIdentity && this.deviceIdentityProvider) {
      await this.#bindLegacyQuiescentIdentity(session, digest);
    }
    if (session.deviceIdentity) {
      const currentIdentity = await this.#captureDeviceIdentity(digest, signal);
      this.#assertDeviceIdentity(session.deviceIdentity, currentIdentity);
    }
  }

  #validatePage(sessionId, tool, page) {
    if (page === undefined || page === null) return { limit: this.maxPageSize, innerCursor: null, requested: false };
    if (!page || typeof page !== "object" || Array.isArray(page)) {
      throw new NativeFacadeError("page must be an object.", { code: "INVALID_ARGUMENT" });
    }
    const limit = page.limit ?? this.maxPageSize;
    if (!Number.isInteger(limit) || limit < 1 || limit > this.maxPageSize) {
      throw new NativeFacadeError(`page.limit must be 1..${this.maxPageSize}.`, { code: "PAGE_LIMIT_EXCEEDED", category: "bounds" });
    }
    if (page.cursor === undefined || page.cursor === null) return { limit, innerCursor: null, requested: true };
    if (typeof page.cursor !== "string") throw new NativeFacadeError("page.cursor must be a string.", { code: "MALFORMED_STREAM_CURSOR" });
    const decoded = decodeCursor(page.cursor);
    if (decoded.session !== sessionId || decoded.tool !== tool) {
      throw new NativeFacadeError("Stream cursor is stale or belongs to another session/tool.", { code: "STALE_STREAM_CURSOR", category: "invalid_cursor", httpStatus: 409 });
    }
    return { limit, innerCursor: decoded.inner, requested: true };
  }

  #assertHandle(session, tool, args) {
    if (!["use", "close"].includes(tool.handleMode)) return;
    const handle = inputHandle(args);
    const record = this.state.handles.find((item) => item.handle === handle && item.sessionId === session.id && item.status === "open");
    if (!record) throw new NativeFacadeError("Process/session handle is stale.", { code: "STALE_PROCESS_HANDLE", category: "process_handle", httpStatus: 409 });
  }

  #registerHandle(session, tool, data) {
    if (tool.handleMode !== "create") return;
    const handle = extractHandle(data);
    if (!handle) return;
    const existing = this.state.handles.find((item) => item.handle === handle && item.sessionId === session.id);
    if (existing) existing.status = "open";
    else this.state.handles.push({ handle, sessionId: session.id, tool: tool.name, status: "open" });
  }

  #closeHandle(session, tool, args) {
    if (tool.handleMode !== "close") return;
    const handle = inputHandle(args);
    const existing = this.state.handles.find((item) => item.handle === handle && item.sessionId === session.id);
    if (existing) existing.status = "closed";
  }

  #request(sessionId, requestId) {
    return this.state.requests.find((item) => item.sessionId === sessionId && item.requestId === requestId) ?? null;
  }

  // A two-store crash can persist the Control action while the Facade request
  // still says "allocating" with no actionId. A stale/closed journal cannot
  // call enqueueAction: even an apparently safe retry would manufacture a
  // new mutation. Reconnect ONLY to the original durable Control record,
  // checking the exact owner, logical key, input and immutable provenance.
  #recoverPersistedActionLink(session, request) {
    if (request.actionId) return this.controlPlane.getAction(request.actionId);
    if (request.status !== "allocating") {
      throw new NativeFacadeError("Lost action link has an inconsistent Facade state.", {
        code: "REQUEST_STATE_CORRUPTED", category: "state", httpStatus: 409,
      });
    }
    const tool = toolDefinition(request.tool);
    if (!tool) {
      throw new NativeFacadeError("Original native tool is no longer available.", {
        code: "SESSION_REQUEST_RECONCILIATION_REQUIRED", category: "state", httpStatus: 409,
      });
    }
    const key = "native:" + session.id + ":" + request.requestId;
    const matches = this.controlPlane.listActions({ sessionId: session.controlSessionId })
      .filter((action) => action.idempotencyKey === key);
    if (matches.length === 0) return null; // No Control allocation: never dispatch here.
    if (matches.length !== 1) {
      throw new NativeFacadeError("Multiple Control records claim the same durable request.", {
        code: "REQUEST_STATE_CORRUPTED", category: "state", httpStatus: 409,
      });
    }
    const action = matches[0];
    const meta = action.metadata ?? {};
    const input = clone(request.args);
    if (tool.streaming && request.pageRequested) {
      // Cursor material is not stored in old Facade request records, so a
      // non-null inner cursor cannot be reconstructed with certainty.
      if (Object.hasOwn(action.input ?? {}, "cursor")) {
        throw new NativeFacadeError("Paged historical action needs manual cursor reconciliation.", {
          code: "SESSION_REQUEST_RECONCILIATION_REQUIRED", category: "state", httpStatus: 409,
        });
      }
      input.limit = request.pageLimit;
    }
    if (action.provider !== "help-pc-1" || action.type !== tool.executorAction ||
        canonicalJson(action.input) !== canonicalJson(input) ||
        action.sessionId !== session.controlSessionId ||
        meta.native_session_id !== session.id ||
        meta.native_request_id !== request.requestId ||
        meta.native_tool !== request.tool ||
        meta.effect !== tool.effect ||
        meta.native_executor_digest !== session.executorDigest) {
      throw new NativeFacadeError("Persisted Control action provenance does not match original Facade request.", {
        code: "DUPLICATE_REQUEST_MISMATCH", category: "idempotency", httpStatus: 409,
      });
    }
    request.actionId = action.id;
    request.status = "queued";
    this.#persist();
    return action;
  }

  #projectAction(session, request, tool, action) {
    const raw = action.result ?? action.executionResult ?? null;
    const data = raw?.data ?? raw;
    if (action.status === "succeeded") {
      this.#registerHandle(session, tool, data);
      this.#closeHandle(session, tool, request.args);
      let stream = null;
      if (tool.streaming) {
        const items = Array.isArray(data?.items) ? data.items : null;
        if (items && items.length > request.pageLimit) {
          throw new NativeFacadeError("Executor exceeded negotiated page bound.", { code: "PROVIDER_BOUNDS_VIOLATION", category: "bounds", httpStatus: 502 });
        }
        const next = data?.next_cursor;
        stream = {
          bounded: true,
          limit: request.pageLimit,
          next_cursor: next === null || next === undefined ? null : encodeCursor({ v: 1, session: session.id, tool: tool.name, inner: next }),
        };
      }
      request.status = "completed";
      request.response = responseEnvelope({ requestId: request.requestId, sessionId: session.id, status: "completed", data: clone(data), stream });
      this.#persist();
      return clone(request.response);
    }
    if (RECONCILING.has(action.status)) {
      request.status = "reconciliation_required";
      request.response = responseEnvelope({
        requestId: request.requestId,
        sessionId: session.id,
        status: "reconciliation_required",
        data: {
          action_id: action.id,
          action_status: action.status,
          lookup_required: true,
          execution_attempts: action.executionAttempts,
          reconciliation_attempts: action.reconciliationAttempts,
        },
      });
      this.#persist();
      return clone(request.response);
    }
    if (action.status === "cancelled") {
      request.status = "cancelled";
      request.response = responseEnvelope({ requestId: request.requestId, sessionId: session.id, status: "cancelled", data: { action_id: action.id } });
      this.#persist();
      return clone(request.response);
    }
    if (action.status === "blocked" || action.status === "failed") {
      request.status = "error";
      request.response = responseEnvelope({
        requestId: request.requestId,
        sessionId: session.id,
        status: "error",
        error: {
          code: action.error?.code ?? (action.status === "blocked" ? "EXECUTOR_BLOCKED" : "EXECUTION_FAILED"),
          category: action.error?.category ?? "execution",
          message: action.error?.message ?? `Action ${action.status}.`,
          retryable: false,
          details: { action_id: action.id, action_status: action.status },
        },
      });
      this.#persist();
      return clone(request.response);
    }
    request.status = "pending";
    request.response = responseEnvelope({ requestId: request.requestId, sessionId: session.id, status: "pending", data: { action_id: action.id, action_status: action.status } });
    this.#persist();
    return clone(request.response);
  }

  // A lookup is a historical RECEIPT read, not a second projection of
  // process lifecycle events. Re-projecting a completed process.start can
  // resurrect an old closed handle after its matching process.terminate.
  #projectJournalReceipt(session, request, tool, action) {
    if (["completed", "cancelled", "error"].includes(request.status)) {
      if (!request.response) {
        throw new NativeFacadeError("Terminal Facade receipt is missing from the durable journal.", {
          code: "FACADE_STATE_CORRUPTED", category: "state", httpStatus: 409,
        });
      }
      return clone(request.response);
    }
    if (!tool) {
      throw new NativeFacadeError("Historical native tool is missing from the registry.", {
        code: "FACADE_STATE_CORRUPTED", category: "state", httpStatus: 409,
      });
    }
    if (session.status !== ACTIVE_SESSION && tool.handleMode !== null &&
        action.status === "succeeded") {
      // An expired process creation whose original Facade receipt was lost
      // cannot be re-attached to a possibly different Windows process/epoch.
      return responseEnvelope({
        requestId: request.requestId, sessionId: session.id,
        status: "reconciliation_required",
        data: {
          action_id: action.id, action_status: action.status,
          lookup_required: true, reason: "historical_handle_receipt_missing",
        },
      });
    }
    return this.#projectAction(session, request, tool, action);
  }

  // Control persists the idempotency key before provider dispatch. If a
  // crash occurs while Facade still says "allocating", asking Control for
  // this SAME key returns its original action and can never run it twice.
  #ensureDurableAction(session, request, tool, page) {
    if (request.actionId) return;
    if (request.status !== "allocating") {
      throw new NativeFacadeError("Unlinked request state needs manual reconciliation.", {
        code: "REQUEST_STATE_CORRUPTED", category: "state", httpStatus: 409,
      });
    }
    const input = clone(request.args);
    if (tool.streaming && request.pageRequested) {
      input.limit = request.pageLimit;
      if (page.innerCursor !== null) input.cursor = page.innerCursor;
    }
    const handle = inputHandle(request.args);
    const resource = typeof request.args.path === "string" ? request.args.path : handle ?? null;
    const idempotencyKey = "native:" + session.id + ":" + request.requestId;
    const spec = {
      provider: "help-pc-1",
      type: tool.executorAction,
      input,
      ...(resource ? { resource } : {}),
      idempotencyKey,
      correlationId: request.requestId,
      destructive: tool.destructive,
      requiresDesktop: false,
      metadata: {
        native_tool: tool.name,
        effect: tool.effect,
        native_session_id: session.id,
        native_request_id: request.requestId,
        native_executor_digest: session.executorDigest,
      },
    };
    const old = this.controlPlane.listActions({ sessionId: session.controlSessionId })
      .find((action) => action.idempotencyKey === idempotencyKey);
    if (old && (old.type !== tool.executorAction ||
        canonicalJson(old.input) !== canonicalJson(input) ||
        old.metadata?.native_tool !== tool.name ||
        old.metadata?.native_session_id !== session.id ||
        old.metadata?.native_request_id !== request.requestId)) {
      throw new NativeFacadeError("Control action conflicts with original request.", {
        code: "DUPLICATE_REQUEST_MISMATCH", category: "idempotency", httpStatus: 409,
      });
    }
    if (!old) this.#assertHandle(session, tool, request.args);
    const action = this.controlPlane.enqueueAction(session.controlSessionId, spec);
    if (action.type !== tool.executorAction ||
        canonicalJson(action.input) !== canonicalJson(input) ||
        action.idempotencyKey !== idempotencyKey) {
      throw new NativeFacadeError("Control identity changed at durable enqueue.", {
        code: "DUPLICATE_REQUEST_MISMATCH", category: "idempotency", httpStatus: 409,
      });
    }
    request.actionId = action.id;
    request.status = "queued";
    this.#persist();
  }

  async #advance(session, request, tool, { healthCanary = false } = {}) {
    let action = request.actionId ? this.controlPlane.getAction(request.actionId) : null;
    if (action && !TERMINAL.has(action.status) && !RECONCILING.has(action.status)) {
      if (healthCanary) await this.controlPlane.processSpecificReadOnly(request.actionId);
      else await this.controlPlane.processNext();
      action = this.controlPlane.getAction(request.actionId);
    } else if (action && RECONCILING.has(action.status)) {
      if (healthCanary) await this.controlPlane.processSpecificReadOnly(request.actionId);
      else await this.controlPlane.processNext();
      action = this.controlPlane.getAction(request.actionId);
    }
    if (!action) throw new NativeFacadeError("Durable action record is missing.", { code: "ACTION_RECORD_MISSING", category: "state", httpStatus: 500 });
    return this.#projectAction(session, request, tool, action);
  }

  async #advanceWithCancellation(session, request, tool, signal, options = {}) {
    let onAbort = null;
    if (signal) {
      onAbort = () => {
        if (!request.actionId) return;
        try { this.controlPlane.cancelAction(request.actionId, "mcp_cancelled"); } catch {}
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      return await this.#advance(session, request, tool, options);
    } finally {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  async invoke(envelope, { signal = null } = {}) {
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw new NativeFacadeError("Request envelope must be an object.", { code: "INVALID_ARGUMENT" });
    if (envelope.contract_version !== NATIVE_CONTROL_PROTOCOL_V1) throw new NativeFacadeError("Unsupported request envelope version.", { code: "SCHEMA_VERSION_MISMATCH", category: "capability_mismatch", httpStatus: 409 });
    if (typeof envelope.session_id !== "string" || typeof envelope.request_id !== "string" || typeof envelope.tool !== "string") {
      throw new NativeFacadeError("session_id, request_id and tool are required.", { code: "INVALID_ARGUMENT" });
    }
    const session = this.#session(envelope.session_id);
    await this.#assertLiveCapabilities(session, signal);
    session.lastSeenAtMs = this.clock();
    const tool = toolDefinition(envelope.tool);
    if (!tool) throw new NativeFacadeError(`Unknown native tool '${envelope.tool}'.`, { code: "TOOL_NOT_FOUND", category: "tool", httpStatus: 404 });
    const args = envelope.arguments ?? {};
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new NativeFacadeError("arguments must be an object.", { code: "INVALID_ARGUMENT" });
    const healthCanary = envelope.health_canary === true;
    if (healthCanary && (tool.name !== "device.ping" || tool.effect !== "read_only" ||
        Object.keys(args).length !== 0 || envelope.page != null)) {
      throw new NativeFacadeError("health_canary is restricted to an unpaged device.ping request.", {
        code: "INVALID_HEALTH_CANARY", category: "health", httpStatus: 400,
      });
    }
    if (hasProtectedPath(args)) {
      throw new NativeFacadeError("Protected path is outside facade dispatch scope.", { code: "PROTECTED_PATH_BLOCKED", category: "policy", httpStatus: 403 });
    }
    const page = this.#validatePage(session.id, tool.name, envelope.page);
    const fingerprint = sha256({
      tool: tool.name,
      args,
      page: page.requested ? { limit: page.limit, inner: page.innerCursor } : null,
    });
    // PERSONAL / ONE OWNER: a logical mutation ID is durable across normal
    // close/restart and TTL renewal. Never reenque a historical mutation.
    if (tool.effect !== "read_only") {
      const historical = this.state.requests.filter((entry) =>
        entry.requestId === envelope.request_id &&
        entry.sessionId !== session.id &&
        (entry.effect !== "read_only" || toolDefinition(entry.tool)?.effect !== "read_only"));
      if (historical.length) {
        if (historical.some((entry) => entry.fingerprint !== fingerprint)) {
          throw new NativeFacadeError("Single-owner request ID was reused with different input.", {
            code: "DUPLICATE_REQUEST_MISMATCH", category: "idempotency", httpStatus: 409,
          });
        }
        if (historical.length !== 1) {
          throw new NativeFacadeError("Ambiguous historical request requires manual reconciliation.", {
            code: "SESSION_REQUEST_RECONCILIATION_REQUIRED", category: "idempotency", httpStatus: 409,
          });
        }
        const oldRequest = historical[0];
        const owner = this.state.sessions.find((item) => item.id === oldRequest.sessionId);
        if (!owner) {
          throw new NativeFacadeError("Old facade session is missing from durable journal.", {
            code: "FACADE_STATE_CORRUPTED", category: "state", httpStatus: 500,
          });
        }
        if (!oldRequest.actionId) this.#recoverPersistedActionLink(owner, oldRequest);
        if (!oldRequest.actionId) {
          throw new NativeFacadeError("No durable Control action link exists; never replay the old mutation.", {
            code: "SESSION_REQUEST_RECONCILIATION_REQUIRED", category: "idempotency", httpStatus: 409,
          });
        }
        // A historical terminal receipt must be returned as saved: projecting
        // a second time could re-register a process.start handle on a CLOSED
        // ancestor and resurrect a process that had already been terminated.
        if (["completed", "cancelled", "error"].includes(oldRequest.status) && oldRequest.response) {
          return clone(oldRequest.response);
        }
        const oldAction = this.controlPlane.getAction(oldRequest.actionId);
        if (RECONCILING.has(oldAction.status) || !TERMINAL.has(oldAction.status)) {
          return responseEnvelope({
            requestId: oldRequest.requestId, sessionId: owner.id,
            status: "reconciliation_required",
            data: { action_id: oldAction.id, action_status: oldAction.status, lookup_required: true },
          });
        }
        if (tool.handleMode !== null) {
          throw new NativeFacadeError("Historical process receipt requires explicit journal reconciliation.", {
            code: "SESSION_REQUEST_RECONCILIATION_REQUIRED", category: "idempotency", httpStatus: 409,
          });
        }
        // No enqueue, processNext or side effect: rebuild a non-handle
        // terminal result only when the old Facade receipt was never saved.
        return this.#projectAction(owner, oldRequest, tool, oldAction);
      }
    }
    let request = this.#request(session.id, envelope.request_id);
    if (request) {
      if (request.fingerprint !== fingerprint) throw new NativeFacadeError("Duplicate request_id was reused with different input.", { code: "DUPLICATE_REQUEST_MISMATCH", category: "idempotency", httpStatus: 409 });
      if (request.status === "completed" || request.status === "cancelled" || request.status === "error") return clone(request.response);
      if (!request.actionId) this.#ensureDurableAction(session, request, tool, page);
      return this.#advanceWithCancellation(session, request, tool, signal, { healthCanary });
    }

    request = {
      sessionId: session.id,
      requestId: envelope.request_id,
      fingerprint,
      tool: tool.name,
      effect: tool.effect,
      args: clone(args),
      pageLimit: page.limit,
      pageRequested: page.requested,
      actionId: null,
      status: "allocating",
      response: null,
    };
    this.state.requests.push(request);
    this.#persist();

    this.#ensureDurableAction(session, request, tool, page);
    return this.#advanceWithCancellation(session, request, tool, signal, { healthCanary });
  }

  #lookupSession(sessionId, resumeToken = null) {
    const session = this.state.sessions.find((entry) => entry.id === sessionId);
    if (!session) {
      throw new NativeFacadeError("Journal session was not found.", {
        code: "STALE_SESSION", category: "session", httpStatus: 409,
      });
    }
    if (session.status === ACTIVE_SESSION) {
      if (this.clock() - session.lastSeenAtMs <= this.sessionTtlMs) return session;
      session.status = "stale";
      session.staleReason = "ttl_expired";
      this.#persist();
    }
    // This grants ONLY a journal read/reconciliation tick, never invoke.
    if (!["stale", "closed"].includes(session.status)) {
      throw new NativeFacadeError("Journal session is not accessible.", {
        code: "STALE_SESSION", category: "session", httpStatus: 409,
      });
    }
    const actual = typeof resumeToken === "string" ? Buffer.from(resumeToken, "utf8") : null;
    const expected = typeof session.resumeToken === "string" ? Buffer.from(session.resumeToken, "utf8") : null;
    if (!actual || !expected || actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)) {
      throw new NativeFacadeError("Original local session token is required for expired journal access.", {
        code: "SESSION_AUTH_FAILED", category: "auth", httpStatus: 401,
      });
    }
    return session;
  }

  lookupRequest({ sessionId, requestId, resumeToken = null }) {
    const session = this.#lookupSession(sessionId, resumeToken);
    const request = this.#request(session.id, requestId);
    if (!request) throw new NativeFacadeError("Request was not found.", { code: "REQUEST_NOT_FOUND", category: "request", httpStatus: 404 });
    if (!request.actionId) this.#recoverPersistedActionLink(session, request);
    if (!request.actionId) {
      return responseEnvelope({ requestId, sessionId, status: "reconciliation_required",
        data: { lookup_required: true, reason: "control_action_not_allocated" } });
    }
    const action = this.controlPlane.getAction(request.actionId);
    const tool = toolDefinition(request.tool);
    return this.#projectJournalReceipt(session, request, tool, action);
  }

  async reconcileRequest({ sessionId, requestId, resumeToken = null }) {
    const session = this.#lookupSession(sessionId, resumeToken);
    const request = this.#request(session.id, requestId);
    if (!request) {
      throw new NativeFacadeError("Request was not found.", {
        code: "REQUEST_NOT_FOUND", category: "request", httpStatus: 404,
      });
    }
    if (!request.actionId) this.#recoverPersistedActionLink(session, request);
    if (!request.actionId) {
      return responseEnvelope({ requestId, sessionId, status: "reconciliation_required",
        data: { lookup_required: true, reason: "control_action_not_allocated" } });
    }
    let action = this.controlPlane.getAction(request.actionId);
    if (RECONCILING.has(action.status)) {
      action = await this.controlPlane.reconcileNext(request.actionId);
    }
    return this.#projectJournalReceipt(session, request, toolDefinition(request.tool), action);
  }

  cancelRequest({ sessionId, requestId, reason = "client_cancelled" }) {
    const session = this.#session(sessionId);
    const request = this.#request(session.id, requestId);
    if (!request?.actionId) throw new NativeFacadeError("Request was not found.", { code: "REQUEST_NOT_FOUND", category: "request", httpStatus: 404 });
    this.controlPlane.cancelAction(request.actionId, reason);
    return this.lookupRequest({ sessionId, requestId });
  }

  debugSnapshot() { return clone(this.state); }
}

export const __test = Object.freeze({ encodeCursor, decodeCursor, hasProtectedPath, canonicalJson });
