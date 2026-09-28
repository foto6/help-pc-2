import { randomBytes, randomUUID } from "node:crypto";
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
    idFactory = randomUUID,
    secretFactory = () => randomBytes(24).toString("base64url"),
    sessionTtlMs = 30 * 60 * 1000,
    maxPageSize = DEFAULT_NATIVE_LIMITS.maxPageSize,
    clock = Date.now,
  } = {}) {
    if (!controlPlane) throw new TypeError("controlPlane is required.");
    if (typeof capabilityProvider !== "function") throw new TypeError("capabilityProvider must be a function.");
    this.controlPlane = controlPlane;
    this.store = store;
    this.capabilityProvider = capabilityProvider;
    this.idFactory = idFactory;
    this.secretFactory = secretFactory;
    this.sessionTtlMs = sessionTtlMs;
    this.maxPageSize = maxPageSize;
    this.clock = clock;
    this.state = store?.load() ?? defaultState();
  }

  #persist() { this.store?.save(this.state); }

  async capabilities() {
    const executorCapabilities = await this.capabilityProvider();
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
      this.#persist();
      throw new NativeFacadeError("Session expired.", { code: "STALE_SESSION", category: "session", httpStatus: 409 });
    }
    return session;
  }

  async #negotiate(client) {
    const manifest = await this.capabilities();
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
    };
    this.state.sessions.push(session);
    this.#persist();
    return {
      session_id: session.id,
      resume_token: session.resumeToken,
      capability_manifest: manifest,
    };
  }

  async reconnectSession({ sessionId, resumeToken, client }) {
    const session = this.#session(sessionId);
    if (typeof resumeToken !== "string" || resumeToken !== session.resumeToken) {
      throw new NativeFacadeError("Resume token is invalid.", { code: "SESSION_AUTH_FAILED", category: "auth", httpStatus: 401 });
    }
    const manifest = await this.#negotiate(client);
    if ((manifest.executor?.digest ?? null) !== session.executorDigest) {
      session.status = "stale";
      this.#persist();
      throw new NativeFacadeError("Executor capabilities drifted since session creation.", { code: "CAPABILITY_DRIFT", category: "capability_mismatch", httpStatus: 409 });
    }
    session.lastSeenAtMs = this.clock();
    this.#persist();
    return { session_id: session.id, capability_manifest: manifest };
  }

  closeSession(sessionId) {
    const session = this.#session(sessionId);
    session.status = "closed";
    session.lastSeenAtMs = this.clock();
    try { this.controlPlane.closeSession(session.controlSessionId); } catch {}
    this.#persist();
    return { session_id: session.id, status: session.status };
  }

  async #assertLiveCapabilities(session) {
    const current = await this.capabilityProvider();
    const digest = current?.digest ?? current?.capabilities_digest ?? null;
    if (digest !== session.executorDigest) {
      session.status = "stale";
      this.#persist();
      throw new NativeFacadeError("Executor capability digest changed.", { code: "CAPABILITY_DRIFT", category: "capability_mismatch", httpStatus: 409 });
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

  async #advance(session, request, tool) {
    let action = request.actionId ? this.controlPlane.getAction(request.actionId) : null;
    if (action && !TERMINAL.has(action.status) && !RECONCILING.has(action.status)) {
      await this.controlPlane.processNext();
      action = this.controlPlane.getAction(request.actionId);
    } else if (action && RECONCILING.has(action.status)) {
      await this.controlPlane.processNext();
      action = this.controlPlane.getAction(request.actionId);
    }
    if (!action) throw new NativeFacadeError("Durable action record is missing.", { code: "ACTION_RECORD_MISSING", category: "state", httpStatus: 500 });
    return this.#projectAction(session, request, tool, action);
  }

  async #advanceWithCancellation(session, request, tool, signal) {
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
      return await this.#advance(session, request, tool);
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
    await this.#assertLiveCapabilities(session);
    session.lastSeenAtMs = this.clock();
    const tool = toolDefinition(envelope.tool);
    if (!tool) throw new NativeFacadeError(`Unknown native tool '${envelope.tool}'.`, { code: "TOOL_NOT_FOUND", category: "tool", httpStatus: 404 });
    const args = envelope.arguments ?? {};
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new NativeFacadeError("arguments must be an object.", { code: "INVALID_ARGUMENT" });
    if (hasProtectedPath(args)) {
      throw new NativeFacadeError("Protected path is outside facade dispatch scope.", { code: "PROTECTED_PATH_BLOCKED", category: "policy", httpStatus: 403 });
    }
    this.#assertHandle(session, tool, args);
    const page = this.#validatePage(session.id, tool.name, envelope.page);
    const fingerprint = sha256({
      tool: tool.name,
      args,
      page: page.requested ? { limit: page.limit, inner: page.innerCursor } : null,
    });
    let request = this.#request(session.id, envelope.request_id);
    if (request) {
      if (request.fingerprint !== fingerprint) throw new NativeFacadeError("Duplicate request_id was reused with different input.", { code: "DUPLICATE_REQUEST_MISMATCH", category: "idempotency", httpStatus: 409 });
      if (request.status === "completed" || request.status === "cancelled" || request.status === "error") return clone(request.response);
      return this.#advanceWithCancellation(session, request, tool, signal);
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

    const input = clone(args);
    if (tool.streaming && page.requested) {
      input.limit = page.limit;
      if (page.innerCursor !== null) input.cursor = page.innerCursor;
    }
    const handle = inputHandle(args);
    const resource = typeof args.path === "string" ? args.path : handle ?? null;
    const action = this.controlPlane.enqueueAction(session.controlSessionId, {
      provider: "help-pc-1",
      type: tool.executorAction,
      input,
      ...(resource ? { resource } : {}),
      idempotencyKey: `native:${session.id}:${request.requestId}`,
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
    });
    request.actionId = action.id;
    request.status = "queued";
    this.#persist();
    return this.#advanceWithCancellation(session, request, tool, signal);
  }

  lookupRequest({ sessionId, requestId }) {
    const session = this.#session(sessionId);
    const request = this.#request(session.id, requestId);
    if (!request) throw new NativeFacadeError("Request was not found.", { code: "REQUEST_NOT_FOUND", category: "request", httpStatus: 404 });
    if (!request.actionId) return responseEnvelope({ requestId, sessionId, status: request.status });
    const action = this.controlPlane.getAction(request.actionId);
    const tool = toolDefinition(request.tool);
    return this.#projectAction(session, request, tool, action);
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
