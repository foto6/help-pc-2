import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  DEFAULT_RELAY_LIMITS,
  REMOTE_FRAME_VERSION,
  ReplayGuard,
  RelayProtocolError,
  StreamAssembler,
  assertHelloPayload,
  decodeRelayFrame,
  encodeRelayFrame,
  parseRelayEnvelope,
  requestFingerprint,
  validateRequestPayload,
} from "./native-relay-protocol.js";
import {
  NativeRelayState,
  RelayStateError,
} from "./native-relay-state.js";

const TERMINAL_DELIVERY = new Set([
  "completed",
  "failed",
  "cancelled",
  "reconciliation_required",
]);

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export class NativeRelayServerError extends Error {
  constructor(message, {
    code = "NATIVE_RELAY_ERROR",
    httpStatus = 400,
  } = {}) {
    super(message);
    this.name = "NativeRelayServerError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left), "utf8");
  const b = Buffer.from(String(right), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function jsonResponse(res, status, body) {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(raw),
    "cache-control": "no-store",
  });
  res.end(raw);
}

async function readJsonBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new NativeRelayServerError("Request body exceeds relay bound.", {
        code: "BODY_TOO_LARGE",
        httpStatus: 413,
      });
    }
    chunks.push(chunk);
  }
  if (total === 0) return {};
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new NativeRelayServerError("Request body must be JSON.", {
      code: "INVALID_JSON",
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new NativeRelayServerError("Request body must be an object.", {
      code: "INVALID_ARGUMENT",
    });
  }
  return parsed;
}

function wsDataToBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function normalizeError(error) {
  if (error instanceof NativeRelayServerError) return error;
  if (error instanceof RelayProtocolError) {
    return new NativeRelayServerError(error.message, {
      code: error.code,
      httpStatus: 400,
    });
  }
  if (error instanceof RelayStateError) {
    const conflict = [
      "DEVICE_ALREADY_EXISTS",
      "STALE_SESSION_EPOCH",
      "DELIVERY_ID_CONFLICT",
      "REQUEST_ID_CONFLICT",
      "TOKEN_GENERATION_MISMATCH",
    ].includes(error.code);
    const missing = ["DEVICE_NOT_FOUND", "DELIVERY_NOT_FOUND"].includes(error.code);
    return new NativeRelayServerError(error.message, {
      code: error.code,
      httpStatus: missing ? 404 : conflict ? 409 : 400,
    });
  }
  return new NativeRelayServerError(String(error?.message ?? error), {
    code: error?.code ?? "NATIVE_RELAY_ERROR",
    httpStatus: error?.httpStatus ?? 500,
  });
}

export class NativeRelayServer {
  constructor({
    state = new NativeRelayState(),
    controlToken,
    host = "127.0.0.1",
    port = 0,
    devicePath = "/v1/device/connect",
    allowNonLoopbackBind = false,
    maxConnections = 64,
    maxPendingTotal = 512,
    maxPendingPerDevice = 64,
    maxBufferedBytes = 1_048_576,
    heartbeatIntervalMs = 15_000,
    heartbeatTimeoutMs = 45_000,
    idleTimeoutMs = 120_000,
    maxFrameBytes = DEFAULT_RELAY_LIMITS.maxFrameBytes,
    maxRequestBytes = DEFAULT_RELAY_LIMITS.maxRequestBytes,
    maxChunkBytes = DEFAULT_RELAY_LIMITS.maxChunkBytes,
    maxStreamBytes = DEFAULT_RELAY_LIMITS.maxStreamBytes,
    maxControlBodyBytes = 1_048_576,
    defaultWaitTimeoutMs = 30_000,
    maxWaitTimeoutMs = 120_000,
    clock = Date.now,
    idFactory = randomUUID,
  } = {}) {
    if (!(state instanceof NativeRelayState)) {
      throw new TypeError("state must be a NativeRelayState");
    }
    if (typeof controlToken !== "string" || controlToken.length < 32) {
      throw new TypeError("controlToken must contain at least 32 characters");
    }
    if (!allowNonLoopbackBind && !LOOPBACK.has(host)) {
      throw new TypeError("non-loopback relay bind requires explicit opt-in");
    }
    for (const [name, value] of Object.entries({
      maxConnections,
      maxPendingTotal,
      maxPendingPerDevice,
      maxBufferedBytes,
      heartbeatIntervalMs,
      heartbeatTimeoutMs,
      idleTimeoutMs,
      maxFrameBytes,
      maxRequestBytes,
      maxChunkBytes,
      maxStreamBytes,
      maxControlBodyBytes,
      defaultWaitTimeoutMs,
      maxWaitTimeoutMs,
    })) {
      if (!Number.isInteger(value) || value <= 0) {
        throw new TypeError(`${name} must be a positive integer`);
      }
    }
    this.state = state;
    this.controlToken = controlToken;
    this.host = host;
    this.port = port;
    this.devicePath = devicePath;
    this.maxConnections = maxConnections;
    this.maxPendingTotal = maxPendingTotal;
    this.maxPendingPerDevice = maxPendingPerDevice;
    this.maxBufferedBytes = maxBufferedBytes;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
    this.idleTimeoutMs = idleTimeoutMs;
    this.maxFrameBytes = maxFrameBytes;
    this.maxRequestBytes = maxRequestBytes;
    this.maxChunkBytes = maxChunkBytes;
    this.maxStreamBytes = maxStreamBytes;
    this.maxControlBodyBytes = maxControlBodyBytes;
    this.defaultWaitTimeoutMs = defaultWaitTimeoutMs;
    this.maxWaitTimeoutMs = maxWaitTimeoutMs;
    this.clock = clock;
    this.idFactory = idFactory;
    this.httpServer = null;
    this.wsServer = null;
    this.sweepTimer = null;
    this.connections = new Set();
    this.sessions = new Map();
    this.waiters = new Map();
    this.streams = new Map();
    this.rotationWaiters = new Map();
  }

  registerDevice(input) {
    return this.state.registerDevice(input);
  }

  async start() {
    if (this.httpServer) {
      throw new NativeRelayServerError("Relay is already running.", {
        code: "ALREADY_RUNNING",
        httpStatus: 409,
      });
    }
    this.httpServer = createServer((req, res) => {
      this.#handleHttp(req, res).catch((error) => {
        const normalized = normalizeError(error);
        if (!res.headersSent) {
          jsonResponse(res, normalized.httpStatus, {
            error: {
              code: normalized.code,
              message: normalized.message,
            },
          });
        } else {
          res.destroy();
        }
      });
    });
    this.wsServer = new WebSocketServer({
      noServer: true,
      maxPayload: this.maxFrameBytes,
      perMessageDeflate: false,
      clientTracking: false,
    });
    this.httpServer.on("upgrade", (req, socket, head) => {
      let path;
      try {
        path = new URL(req.url, "http://relay.invalid").pathname;
      } catch {
        socket.destroy();
        return;
      }
      if (path !== this.devicePath) {
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      if (this.connections.size >= this.maxConnections) {
        socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wsServer.handleUpgrade(req, socket, head, (ws) => this.#acceptSocket(ws));
    });
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.httpServer?.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.httpServer?.off("error", onError);
        resolve();
      };
      this.httpServer.once("error", onError);
      this.httpServer.once("listening", onListening);
      this.httpServer.listen(this.port, this.host);
    });
    this.sweepTimer = setInterval(
      () => this.sweep(),
      Math.max(250, Math.min(this.heartbeatIntervalMs, 5_000)),
    );
    this.sweepTimer.unref?.();
    const address = this.httpServer.address();
    const actualPort = typeof address === "object" && address ? address.port : this.port;
    const hostForUrl = this.host.includes(":") ? `[${this.host}]` : this.host;
    return {
      url: `http://${hostForUrl}:${actualPort}`,
      websocket_url: `ws://${hostForUrl}:${actualPort}${this.devicePath}`,
    };
  }

  async stop() {
    if (!this.httpServer) return;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const connection of [...this.connections]) {
      this.#handleConnectionLoss(connection, "relay_stopping");
      try {
        if (typeof connection.ws.terminate === "function") connection.ws.terminate();
        else connection.ws.close(1001, "relay stopping");
      } catch {}
    }
    const server = this.httpServer;
    this.httpServer = null;
    const wsServer = this.wsServer;
    this.wsServer = null;
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
    wsServer?.close();
  }

  health() {
    const deliveries = this.state.listDeliveries();
    const activeDeliveries = deliveries.filter(
      (item) => !TERMINAL_DELIVERY.has(item.status),
    );
    const active = activeDeliveries.length;
    const now = this.clock();
    const lastProgressAtMs = deliveries.reduce(
      (value, item) => Math.max(value, Number(item.updated_at_ms) || 0), 0) || null;
    const lastSuccessfulResultAtMs = deliveries
      .filter((item) => item.status === "completed")
      .reduce((value, item) => Math.max(value, Number(item.updated_at_ms) || 0), 0) || null;
    const oldestPendingAgeMs = activeDeliveries.length
      ? Math.max(0, now - Math.min(...activeDeliveries.map((item) => Number(item.created_at_ms) || now)))
      : 0;
    const queueProgressing = active === 0 || (
      lastProgressAtMs !== null && now - lastProgressAtMs <= this.heartbeatTimeoutMs
    );
    const running = Boolean(this.httpServer);
    return {
      status: !running ? "unhealthy" : queueProgressing ? "ok" : "degraded",
      protocol_version: REMOTE_FRAME_VERSION,
      running,
      process_alive: running,
      transport_connected: this.sessions.size > 0,
      queue_progressing: queueProgressing,
      executor_responsive: this.sessions.size > 0,
      last_progress_at_ms: lastProgressAtMs,
      last_successful_result_at_ms: lastSuccessfulResultAtMs,
      oldest_pending_age_ms: oldestPendingAgeMs,
      online_devices: this.sessions.size,
      connections: this.connections.size,
      pending_deliveries: active,
      limits: {
        max_connections: this.maxConnections,
        max_pending_total: this.maxPendingTotal,
        max_pending_per_device: this.maxPendingPerDevice,
        max_frame_bytes: this.maxFrameBytes,
        max_request_bytes: this.maxRequestBytes,
        max_chunk_bytes: this.maxChunkBytes,
        max_stream_bytes: this.maxStreamBytes,
        max_buffered_bytes: this.maxBufferedBytes,
        idle_timeout_ms: this.idleTimeoutMs,
        heartbeat_timeout_ms: this.heartbeatTimeoutMs,
      },
    };
  }

  listDevices() {
    return this.state.listDevices((deviceId) => this.sessions.has(deviceId));
  }

  lookupDelivery(deliveryId) {
    return this.state.deliveryView(deliveryId);
  }

  async dispatchRequest(input, {
    waitTimeoutMs = this.defaultWaitTimeoutMs,
  } = {}) {
    if (!input || typeof input.device_id !== "string") {
      throw new NativeRelayServerError("device_id is required.", {
        code: "INVALID_ARGUMENT",
      });
    }
    const request = validateRequestPayload({
      request_id: input.request_id,
      request_version: input.request_version,
      delivery_id: input.delivery_id,
      semantics: input.semantics,
      body: input.body,
    }, {
      maxRequestBytes: this.maxRequestBytes,
    });
    const payload = {
      request_id: request.request_id,
      request_version: request.request_version,
      delivery_id: request.delivery_id,
      semantics: request.semantics,
      body: request.body,
    };
    const fingerprint = requestFingerprint(payload);
    const existing = this.state.deliveryById(payload.delivery_id);
    if (existing) {
      if (existing.fingerprint !== fingerprint
        || existing.requestId !== payload.request_id
        || existing.deviceId !== input.device_id) {
        throw new NativeRelayServerError(
          "delivery_id was reused for different content.",
          { code: "DELIVERY_ID_CONFLICT", httpStatus: 409 },
        );
      }
      const view = this.state.deliveryView(payload.delivery_id);
      if (TERMINAL_DELIVERY.has(view.status)) return view;
      return this.#waitForDelivery(payload.delivery_id, waitTimeoutMs);
    }
    const session = this.sessions.get(input.device_id);
    if (!session) {
      throw new NativeRelayServerError("Device is offline.", {
        code: "DEVICE_OFFLINE",
        httpStatus: 409,
      });
    }
    const active = this.state.listDeliveries().filter(
      (item) => !TERMINAL_DELIVERY.has(item.status),
    );
    if (active.length >= this.maxPendingTotal) {
      throw new NativeRelayServerError("Relay pending quota reached.", {
        code: "PENDING_QUOTA_EXCEEDED",
        httpStatus: 429,
      });
    }
    const perDevice = active.filter((item) => item.device_id === session.deviceId).length;
    if (perDevice >= this.maxPendingPerDevice) {
      throw new NativeRelayServerError("Device pending quota reached.", {
        code: "DEVICE_PENDING_QUOTA_EXCEEDED",
        httpStatus: 429,
      });
    }
    const created = this.state.createDelivery({
      deviceId: session.deviceId,
      requestId: payload.request_id,
      requestVersion: payload.request_version,
      deliveryId: payload.delivery_id,
      semantics: payload.semantics,
      fingerprint,
      sessionEpoch: session.sessionEpoch,
    });
    if (created.duplicate) {
      const view = this.state.deliveryView(payload.delivery_id);
      if (TERMINAL_DELIVERY.has(view.status)) return view;
      return this.#waitForDelivery(payload.delivery_id, waitTimeoutMs);
    }
    try {
      await this.#sendFrame(session, "request", payload);
    } catch (error) {
      const view = payload.semantics === "side_effecting"
        ? this.state.requireReconciliation(
            payload.delivery_id,
            "relay_send_outcome_unknown",
          )
        : this.state.failDelivery(payload.delivery_id, {
            code: "DELIVERY_SEND_FAILED",
            message: String(error?.message ?? error),
            retryable: true,
          });
      this.#resolveWaiters(payload.delivery_id, view);
      return view;
    }
    return this.#waitForDelivery(payload.delivery_id, waitTimeoutMs);
  }

  cancelRequest({ deliveryId, reason = "cancelled_by_control" }) {
    const view = this.state.cancelDelivery(deliveryId, reason);
    this.streams.delete(deliveryId);
    this.#resolveWaiters(deliveryId, view);
    return view;
  }

  async rotateDeviceCredential({
    deviceId,
    newGeneration,
    newSecret,
    overlapMs = 30_000,
    waitTimeoutMs = 5_000,
  }) {
    const session = this.sessions.get(deviceId);
    if (!session) {
      throw new NativeRelayServerError("Device is offline.", {
        code: "DEVICE_OFFLINE",
        httpStatus: 409,
      });
    }
    const oldCredential = this.state.currentCredential(deviceId);
    const rotation = this.state.rotateCredential({
      deviceId,
      newGeneration,
      newSecret,
      overlapMs,
    });
    const current = this.state.currentCredential(deviceId);
    const promise = new Promise((resolve) => {
      this.rotationWaiters.set(deviceId, { generation: newGeneration, resolve });
    });
    try {
      await this.#sendFrame(session, "token.rotate", {
        new_generation: newGeneration,
        new_token_b64: current.secret.toString("base64"),
      }, { credential: oldCredential });
    } catch (error) {
      this.rotationWaiters.delete(deviceId);
      throw new NativeRelayServerError(
        `Rotation delivery outcome is unknown: ${error.message}`,
        { code: "ROTATION_DELIVERY_UNKNOWN", httpStatus: 409 },
      );
    }
    const timeout = this.#boundedWait(waitTimeoutMs);
    return Promise.race([
      promise,
      new Promise((resolve) => setTimeout(
        () => resolve({ ...rotation, acknowledged: false }),
        timeout,
      )),
    ]);
  }

  revokeDevice(deviceId) {
    const view = this.state.revokeDevice(deviceId);
    const session = this.sessions.get(deviceId);
    if (session) {
      try { session.ws.close(4003, "device revoked"); } catch {}
      this.#handleConnectionLoss(session, "device_revoked");
    }
    return view;
  }

  sweep() {
    const now = this.clock();
    for (const session of [...this.sessions.values()]) {
      if (now - session.lastInboundAtMs > this.heartbeatTimeoutMs) {
        try { session.ws.close(4008, "heartbeat timeout"); } catch {}
        this.#handleConnectionLoss(session, "heartbeat_timeout");
        continue;
      }
      const activeForSession = this.state.listDeliveries().some(
        (item) => item.session_epoch === session.sessionEpoch
          && !TERMINAL_DELIVERY.has(item.status),
      );
      if (!activeForSession && now - session.lastInboundAtMs > this.idleTimeoutMs) {
        try { session.ws.close(4000, "idle timeout"); } catch {}
        this.#handleConnectionLoss(session, "idle_timeout");
        continue;
      }
      if (now - session.lastOutboundAtMs >= this.heartbeatIntervalMs) {
        this.#sendFrame(session, "heartbeat", {
          last_inbound_sequence: session.inboundGuard.lastSequence,
        }).catch(() => {
          try { session.ws.close(1011, "heartbeat send failed"); } catch {}
          this.#handleConnectionLoss(session, "heartbeat_send_failed");
        });
      }
    }
  }

  #boundedWait(value) {
    if (!Number.isInteger(value) || value < 1) return this.defaultWaitTimeoutMs;
    return Math.min(value, this.maxWaitTimeoutMs);
  }

  #waitForDelivery(deliveryId, waitTimeoutMs) {
    const current = this.state.deliveryView(deliveryId);
    if (!current) {
      throw new NativeRelayServerError("Unknown delivery.", {
        code: "DELIVERY_NOT_FOUND",
        httpStatus: 404,
      });
    }
    if (TERMINAL_DELIVERY.has(current.status)) return Promise.resolve(current);
    const timeout = this.#boundedWait(waitTimeoutMs);
    return new Promise((resolve) => {
      const waiter = { resolve, timer: null };
      const set = this.waiters.get(deliveryId) ?? new Set();
      set.add(waiter);
      this.waiters.set(deliveryId, set);
      waiter.timer = setTimeout(() => {
        set.delete(waiter);
        if (!set.size) this.waiters.delete(deliveryId);
        resolve({
          ...this.state.deliveryView(deliveryId),
          wait_timeout: true,
        });
      }, timeout);
    });
  }

  #resolveWaiters(deliveryId, view) {
    const set = this.waiters.get(deliveryId);
    if (!set) return;
    this.waiters.delete(deliveryId);
    for (const waiter of set) {
      clearTimeout(waiter.timer);
      waiter.resolve(view);
    }
  }

  #acceptSocket(ws) {
    const connection = {
      id: this.idFactory(),
      ws,
      established: false,
      deviceId: null,
      sessionEpoch: null,
      inboundGuard: new ReplayGuard(),
      outboundSequence: 0,
      lastInboundAtMs: this.clock(),
      lastOutboundAtMs: this.clock(),
      queue: Promise.resolve(),
      closed: false,
      negotiatedLimits: null,
    };
    this.connections.add(connection);
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        try { ws.close(1003, "text frames required"); } catch {}
        this.#handleConnectionLoss(connection, "binary_frame_rejected");
        return;
      }
      const bytes = wsDataToBuffer(data);
      connection.queue = connection.queue
        .then(() => this.#handleSocketMessage(connection, bytes))
        .catch((error) => {
          const normalized = normalizeError(error);
          try { ws.close(4002, normalized.code.slice(0, 120)); } catch {}
          this.#handleConnectionLoss(connection, normalized.code);
        });
    });
    ws.on("close", () => this.#handleConnectionLoss(connection, "socket_closed"));
    ws.on("error", () => this.#handleConnectionLoss(connection, "socket_error"));
  }

  async #handleSocketMessage(connection, raw) {
    if (raw.length > this.maxFrameBytes) {
      throw new NativeRelayServerError("Frame exceeds relay bound.", {
        code: "FRAME_TOO_LARGE",
      });
    }
    if (!connection.established) {
      await this.#handleHello(connection, raw);
      return;
    }
    const frame = decodeRelayFrame(raw, {
      credentials: this.state.credentialCandidates(connection.deviceId),
      expectedDeviceId: connection.deviceId,
      expectedSessionEpoch: connection.sessionEpoch,
      maxFrameBytes: this.maxFrameBytes,
    });
    connection.inboundGuard.accept(frame.sequence);
    connection.lastInboundAtMs = this.clock();
    this.state.noteSeen(connection.deviceId);
    switch (frame.type) {
      case "heartbeat":
        await this.#sendFrame(connection, "heartbeat_ack", {
          relay_sequence: frame.sequence,
        });
        return;
      case "heartbeat_ack":
        return;
      case "response":
        this.#handleResponse(connection, frame.payload);
        return;
      case "stream_chunk":
        this.#handleStreamChunk(connection, frame.payload);
        return;
      case "stream_end":
        this.#handleStreamEnd(connection, frame.payload);
        return;
      case "reconcile_required":
        this.#handleReconcile(connection, frame.payload);
        return;
      case "error":
        this.#handleDeviceError(connection, frame.payload);
        return;
      case "token.rotated":
        this.#handleRotationAck(connection, frame.payload);
        return;
      default:
        throw new RelayProtocolError(`unexpected device frame type: ${frame.type}`);
    }
  }

  async #handleHello(connection, raw) {
    const { parsed } = parseRelayEnvelope(raw, {
      maxFrameBytes: this.maxFrameBytes,
    });
    if (parsed.type !== "hello") {
      throw new RelayProtocolError("first device frame must be hello");
    }
    const credentials = this.state.credentialCandidates(parsed.device_id);
    const frame = decodeRelayFrame(raw, {
      credentials,
      expectedDeviceId: parsed.device_id,
      expectedSessionEpoch: parsed.session_epoch,
      maxFrameBytes: this.maxFrameBytes,
    });
    connection.inboundGuard.accept(frame.sequence);
    const hello = assertHelloPayload(frame.payload);
    const existing = this.sessions.get(frame.device_id);
    if (existing) {
      try { existing.ws.close(4001, "superseded by reconnect"); } catch {}
      this.#handleConnectionLoss(existing, "superseded_by_reconnect");
    }
    this.state.beginSession({
      deviceId: frame.device_id,
      sessionEpoch: frame.session_epoch,
      capabilitiesDigest: hello.capabilities_digest,
      capabilities: hello.capabilities,
      limits: hello.limits,
    });
    connection.established = true;
    connection.deviceId = frame.device_id;
    connection.sessionEpoch = frame.session_epoch;
    connection.lastInboundAtMs = this.clock();
    connection.negotiatedLimits = {
      maxFrameBytes: Math.min(this.maxFrameBytes, hello.limits.max_frame_bytes),
      maxRequestBytes: Math.min(this.maxRequestBytes, hello.limits.max_request_bytes),
      maxChunkBytes: Math.min(this.maxChunkBytes, hello.limits.max_chunk_bytes),
      maxStreamBytes: Math.min(this.maxStreamBytes, hello.limits.max_stream_bytes),
    };
    this.sessions.set(frame.device_id, connection);
    const credential = credentials.find(
      (item) => item.generation === frame.token_generation,
    );
    await this.#sendFrame(connection, "welcome", {
      protocol_version: REMOTE_FRAME_VERSION,
      hello_nonce: hello.hello_nonce,
      accepted: true,
    }, { credential });
  }

  async #sendFrame(connection, type, payload, { credential = null } = {}) {
    if (connection.closed || connection.ws.readyState !== WebSocket.OPEN) {
      throw new NativeRelayServerError("Device connection is not writable.", {
        code: "DEVICE_CONNECTION_CLOSED",
        httpStatus: 409,
      });
    }
    if (connection.ws.bufferedAmount > this.maxBufferedBytes) {
      throw new NativeRelayServerError("Device connection is backpressured.", {
        code: "BACKPRESSURE_LIMIT",
        httpStatus: 429,
      });
    }
    connection.outboundSequence += 1;
    const token = credential ?? this.state.currentCredential(connection.deviceId);
    const maxFrameBytes = connection.negotiatedLimits?.maxFrameBytes ?? this.maxFrameBytes;
    const raw = encodeRelayFrame({
      deviceId: connection.deviceId,
      sessionEpoch: connection.sessionEpoch,
      sequence: connection.outboundSequence,
      type,
      payload,
      credential: token,
      maxFrameBytes,
    });
    await new Promise((resolve, reject) => {
      connection.ws.send(raw, { binary: false, compress: false }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    connection.lastOutboundAtMs = this.clock();
    if (connection.ws.bufferedAmount > this.maxBufferedBytes) {
      throw new NativeRelayServerError("Device connection exceeded backpressure bound.", {
        code: "BACKPRESSURE_LIMIT",
        httpStatus: 429,
      });
    }
  }

  #deliveryForInbound(connection, requestId, requestVersion = null) {
    const record = this.state.deliveryByRequestId(requestId);
    if (!record
      || record.deviceId !== connection.deviceId
      || record.sessionEpoch !== connection.sessionEpoch) {
      throw new RelayProtocolError("response does not match an active delivery");
    }
    if (requestVersion !== null && record.requestVersion !== requestVersion) {
      throw new RelayProtocolError("response request version mismatch");
    }
    if (TERMINAL_DELIVERY.has(record.status)) {
      throw new RelayProtocolError("response arrived for terminal delivery");
    }
    return record;
  }

  #handleResponse(connection, payload) {
    if (!exactKeys(payload, [
      "request_id",
      "request_version",
      "status",
      "body",
      "stream",
    ])) {
      throw new RelayProtocolError("invalid response payload");
    }
    if (payload.status !== "OK"
      || !payload.body
      || typeof payload.body !== "object"
      || Array.isArray(payload.body)) {
      throw new RelayProtocolError("invalid response status/body");
    }
    const record = this.#deliveryForInbound(
      connection,
      payload.request_id,
      payload.request_version,
    );
    if (payload.stream === null) {
      const view = this.state.completeDelivery(record.deliveryId, {
        status: "OK",
        body: structuredClone(payload.body),
        stream: null,
      });
      this.#resolveWaiters(record.deliveryId, view);
      return;
    }
    const assembler = new StreamAssembler(payload.stream, {
      maxStreamBytes: Math.min(
        this.maxStreamBytes,
        connection.negotiatedLimits?.maxStreamBytes ?? this.maxStreamBytes,
      ),
    });
    if (payload.stream.chunk_bytes
      > (connection.negotiatedLimits?.maxChunkBytes ?? this.maxChunkBytes)) {
      throw new RelayProtocolError("device stream chunk bound exceeds negotiation");
    }
    this.streams.set(record.deliveryId, {
      assembler,
      body: structuredClone(payload.body),
      manifest: structuredClone(payload.stream),
    });
    this.state.markStreaming(record.deliveryId);
  }

  #handleStreamChunk(connection, payload) {
    if (!payload || typeof payload.request_id !== "string") {
      throw new RelayProtocolError("invalid stream chunk request binding");
    }
    const record = this.#deliveryForInbound(connection, payload.request_id);
    const stream = this.streams.get(record.deliveryId);
    if (!stream) throw new RelayProtocolError("stream chunk has no active manifest");
    const chunk = { ...payload };
    delete chunk.request_id;
    stream.assembler.accept(chunk);
  }

  #handleStreamEnd(connection, payload) {
    if (!payload || typeof payload.request_id !== "string") {
      throw new RelayProtocolError("invalid stream end request binding");
    }
    const record = this.#deliveryForInbound(connection, payload.request_id);
    const stream = this.streams.get(record.deliveryId);
    if (!stream) throw new RelayProtocolError("stream end has no active manifest");
    const end = { ...payload };
    delete end.request_id;
    const data = stream.assembler.finish(end);
    this.streams.delete(record.deliveryId);
    const view = this.state.completeDelivery(record.deliveryId, {
      status: "OK",
      body: stream.body,
      stream: {
        manifest: stream.manifest,
        data_b64: data.toString("base64"),
      },
    });
    this.#resolveWaiters(record.deliveryId, view);
  }

  #handleReconcile(connection, payload) {
    if (!exactKeys(payload, [
      "request_id",
      "request_version",
      "status",
      "reason",
      "automatic_replay",
    ])) {
      throw new RelayProtocolError("invalid reconciliation payload");
    }
    if (payload.status !== "UNKNOWN_RECONCILE" || payload.automatic_replay !== false) {
      throw new RelayProtocolError("invalid reconciliation status");
    }
    const record = this.#deliveryForInbound(
      connection,
      payload.request_id,
      payload.request_version,
    );
    this.streams.delete(record.deliveryId);
    const view = this.state.requireReconciliation(
      record.deliveryId,
      payload.reason,
      structuredClone(payload),
    );
    this.#resolveWaiters(record.deliveryId, view);
  }

  #handleDeviceError(connection, payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)
      || typeof payload.request_id !== "string"
      || typeof payload.code !== "string"
      || typeof payload.message !== "string") {
      throw new RelayProtocolError("invalid device error payload");
    }
    const record = this.#deliveryForInbound(connection, payload.request_id);
    this.streams.delete(record.deliveryId);
    const view = record.semantics === "side_effecting"
      ? this.state.requireReconciliation(
          record.deliveryId,
          "device_error_after_dispatch",
          {
            status: "UNKNOWN_RECONCILE",
            automatic_replay: false,
            device_error_code: payload.code,
          },
        )
      : this.state.failDelivery(record.deliveryId, {
          code: payload.code,
          message: "Device reported a read-only dispatch error.",
          retryable: false,
        });
    this.#resolveWaiters(record.deliveryId, view);
  }

  #handleRotationAck(connection, payload) {
    if (!exactKeys(payload, ["generation"])
      || !Number.isInteger(payload.generation)
      || payload.generation <= 0) {
      throw new RelayProtocolError("invalid token rotation acknowledgement");
    }
    const waiter = this.rotationWaiters.get(connection.deviceId);
    if (!waiter || waiter.generation !== payload.generation) {
      throw new RelayProtocolError("unexpected token rotation acknowledgement");
    }
    const result = this.state.completeRotation(
      connection.deviceId,
      payload.generation,
    );
    this.rotationWaiters.delete(connection.deviceId);
    waiter.resolve({ ...result, acknowledged: true });
  }

  #handleConnectionLoss(connection, reason) {
    if (connection.closed) return;
    connection.closed = true;
    this.connections.delete(connection);
    if (connection.deviceId
      && this.sessions.get(connection.deviceId)?.id === connection.id) {
      this.sessions.delete(connection.deviceId);
    }
    if (!connection.established) return;
    for (const delivery of this.state.listDeliveries()) {
      if (delivery.session_epoch !== connection.sessionEpoch
        || TERMINAL_DELIVERY.has(delivery.status)) {
        continue;
      }
      this.streams.delete(delivery.delivery_id);
      const view = delivery.semantics === "side_effecting"
        ? this.state.requireReconciliation(
            delivery.delivery_id,
            `connection_lost:${reason}`,
          )
        : this.state.failDelivery(delivery.delivery_id, {
            code: "DEVICE_CONNECTION_LOST",
            message: "Read-only delivery lost its device connection.",
            retryable: true,
          });
      this.#resolveWaiters(delivery.delivery_id, view);
    }
    const rotation = this.rotationWaiters.get(connection.deviceId);
    if (rotation) {
      this.rotationWaiters.delete(connection.deviceId);
      rotation.resolve({
        device_id: connection.deviceId,
        generation: rotation.generation,
        acknowledged: false,
        connection_lost: true,
      });
    }
  }

  #authorized(req) {
    const header = req.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
    return safeEqual(header.slice("Bearer ".length), this.controlToken);
  }

  async #handleHttp(req, res) {
    if (!this.#authorized(req)) {
      jsonResponse(res, 401, {
        error: {
          code: "AUTH_REQUIRED",
          message: "Relay control authentication is required.",
        },
      });
      return;
    }
    const url = new URL(req.url, "http://relay.invalid");
    if (req.method === "GET" && url.pathname === "/v1/relay/health") {
      jsonResponse(res, 200, this.health());
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/relay/devices") {
      jsonResponse(res, 200, { devices: this.listDevices() });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/relay/request") {
      const deliveryId = url.searchParams.get("delivery_id");
      const view = deliveryId ? this.lookupDelivery(deliveryId) : null;
      if (!view) {
        jsonResponse(res, 404, {
          error: {
            code: "DELIVERY_NOT_FOUND",
            message: "Unknown delivery.",
          },
        });
        return;
      }
      jsonResponse(res, 200, view);
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/relay/request") {
      const body = await readJsonBody(req, this.maxControlBodyBytes);
      if (!exactKeys(body, [
        "device_id",
        "request_id",
        "request_version",
        "delivery_id",
        "semantics",
        "body",
        "wait_timeout_ms",
      ]) && !exactKeys(body, [
        "device_id",
        "request_id",
        "request_version",
        "delivery_id",
        "semantics",
        "body",
      ])) {
        throw new NativeRelayServerError("Invalid relay request envelope.", {
          code: "INVALID_ARGUMENT",
        });
      }
      const result = await this.dispatchRequest({
        device_id: body.device_id,
        request_id: body.request_id,
        request_version: body.request_version,
        delivery_id: body.delivery_id,
        semantics: body.semantics,
        body: body.body,
      }, {
        waitTimeoutMs: body.wait_timeout_ms ?? this.defaultWaitTimeoutMs,
      });
      jsonResponse(res, 200, result);
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/relay/request/cancel") {
      const body = await readJsonBody(req, this.maxControlBodyBytes);
      if (typeof body.delivery_id !== "string") {
        throw new NativeRelayServerError("delivery_id is required.", {
          code: "INVALID_ARGUMENT",
        });
      }
      jsonResponse(res, 200, this.cancelRequest({
        deliveryId: body.delivery_id,
        reason: typeof body.reason === "string"
          ? body.reason
          : "cancelled_by_control",
      }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/relay/device/rotate") {
      const body = await readJsonBody(req, this.maxControlBodyBytes);
      if (typeof body.device_id !== "string"
        || !Number.isInteger(body.new_generation)
        || typeof body.new_token_b64 !== "string") {
        throw new NativeRelayServerError("Invalid rotation request.", {
          code: "INVALID_ARGUMENT",
        });
      }
      const secret = Buffer.from(body.new_token_b64, "base64");
      if (secret.toString("base64") !== body.new_token_b64 || secret.length < 32) {
        throw new NativeRelayServerError("Invalid rotated credential.", {
          code: "INVALID_ARGUMENT",
        });
      }
      const result = await this.rotateDeviceCredential({
        deviceId: body.device_id,
        newGeneration: body.new_generation,
        newSecret: secret,
        overlapMs: body.overlap_ms ?? 30_000,
        waitTimeoutMs: body.wait_timeout_ms ?? 5_000,
      });
      jsonResponse(res, 200, result);
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/relay/device/revoke") {
      const body = await readJsonBody(req, this.maxControlBodyBytes);
      if (typeof body.device_id !== "string") {
        throw new NativeRelayServerError("device_id is required.", {
          code: "INVALID_ARGUMENT",
        });
      }
      jsonResponse(res, 200, this.revokeDevice(body.device_id));
      return;
    }
    jsonResponse(res, 404, {
      error: {
        code: "NOT_FOUND",
        message: "Unknown relay endpoint.",
      },
    });
  }
}
