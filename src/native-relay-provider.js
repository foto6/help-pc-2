import { createHash } from "node:crypto";
import {
  NATIVE_CONTROL_PROTOCOL_V1,
  NATIVE_RESPONSE_V1,
  TOOL_REGISTRY_LIST,
  toolDefinition,
} from "./native-registry.js";
import { digestJson as relayDigestJson } from "./native-relay-protocol.js";
import { PC_PARITY_REGISTRY_V1, routeNativeExecutorTool } from "./native-relay-registry-route.js";

// The genuine Python producer's executor.actions is the PARITY action list,
// while the frozen 37-tool Control native registry advertises COMPATIBILITY
// action names. A signed Python manifest also includes a verified
// compatibility.routes map. Project ONLY aliases that its original parity
// or legacy Executor inventory actually supports. Never invent a capability,
// weaken the frozen registry digest, or change the real Executor digest.
export function projectProducerExecutorActions(capabilities, executor) {
  const original = Array.isArray(executor?.actions) ? executor.actions : null;
  if (!original) return executor;
  const supportedParity = new Set(original);
  const routes = capabilities?.compatibility?.routes;
  const supportedLegacy = new Set(
    Array.isArray(capabilities?.compatibility?.legacy_executor?.actions)
      ? capabilities.compatibility.legacy_executor.actions : [],
  );
  if (!routes || typeof routes !== "object" || Array.isArray(routes)) return executor;
  const projected = new Set(original);
  for (const tool of TOOL_REGISTRY_LIST) {
    const route = routes[tool.name];
    if (route?.status !== "translated" || typeof route.target_action !== "string") continue;
    const proven = (route.surface === "parity" && supportedParity.has(route.target_action))
      || (route.surface === "legacy_executor" && supportedLegacy.has(route.target_action));
    if (proven) projected.add(tool.executorAction);
  }
  return { ...executor, actions: [...projected].sort() };
}

export const NATIVE_RELAY_PROVIDER_IDENTITY = Object.freeze({
  package: "pc-control-plane",
  package_version: "0.9.0",
  module: "src/native-relay-provider.js",
  factory_export: "createExecutorBridge",
  provider_contract: "pc.native.relay.executor_bridge.v1",
  relay_api: "pc.native.relay.control_api.v1",
  device_transport: "pc_remote_transport.frame.v1",
});

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const TERMINAL_DELIVERY = new Set([
  "completed",
  "failed",
  "cancelled",
  "reconciliation_required",
]);
const SAFE_NOT_DISPATCHED_CODES = new Set([
  "DEVICE_OFFLINE",
  "PENDING_QUOTA_EXCEEDED",
  "DEVICE_PENDING_QUOTA_EXCEEDED",
  "REQUEST_TOO_LARGE",
  "BODY_TOO_LARGE",
  "INVALID_ARGUMENT",
  "DELIVERY_ID_CONFLICT",
  "REQUEST_ID_CONFLICT",
  "AUTH_REQUIRED",
  "NOT_FOUND",
]);
const DEVICE_PRE_DISPATCH_CODES = new Set([
  "CAPABILITY_DRIFT",
  "CAPABILITY_SEMANTICS_MISMATCH",
  "EXECUTOR_ACTION_UNAVAILABLE",
  "EXECUTOR_PREFLIGHT_REJECTED",
  "OUTCOME_JOURNAL_REQUIRED",
  "PROTECTED_PATH_BLOCKED",
  "STALE_EXECUTION_CONTEXT",
  "STALE_PROCESS_HANDLE",
  "TOOL_NOT_FOUND",
  "SCHEMA_VERSION_MISMATCH",
]);

export class NativeRelayProviderError extends Error {
  constructor(message, {
    code = "NATIVE_RELAY_PROVIDER_ERROR",
    category = "native_relay_provider",
    retryable = false,
    dispatchState = "not_dispatched",
    outcomeUncertain = false,
    automaticReplay = false,
    httpStatus = null,
    details = null,
  } = {}) {
    super(message);
    this.name = "NativeRelayProviderError";
    this.code = code;
    this.category = category;
    this.retryable = retryable;
    this.dispatchState = dispatchState;
    this.outcomeUncertain = outcomeUncertain;
    this.automaticReplay = automaticReplay;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function requireText(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeRelayUrl(value) {
  const text = requireText(value, "relayUrl");
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new TypeError("relayUrl must be an absolute URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new TypeError("relayUrl must use http or https");
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new TypeError("relayUrl must resolve to an explicit loopback host");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError("relayUrl must not contain credentials, query, or fragment");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new TypeError("relayUrl must be an origin without an API path");
  }
  url.pathname = "/";
  return url;
}

function deliveryId(deviceId, logicalRequestId) {
  const digest = createHash("sha256")
    .update(`pc.native.relay.delivery.v1\0${deviceId}\0${logicalRequestId}`, "utf8")
    .digest("hex");
  return `relay-${digest.slice(0, 56)}`;
}

function uncertainError(message, {
  code = "UNKNOWN_RECONCILE",
  details = null,
} = {}) {
  return new NativeRelayProviderError(message, {
    code,
    category: "uncertain_outcome",
    retryable: false,
    dispatchState: "unknown",
    outcomeUncertain: true,
    automaticReplay: false,
    details,
  });
}

function cancelledBeforeDispatch() {
  const error = new NativeRelayProviderError("Request was cancelled before relay dispatch.", {
    code: "CANCELLED",
    category: "cancelled",
    retryable: false,
    dispatchState: "not_dispatched",
    outcomeUncertain: false,
  });
  error.name = "AbortError";
  return error;
}

function errorFromRelay(status, payload) {
  const code = typeof payload?.error?.code === "string"
    ? payload.error.code
    : "RELAY_CONTROL_ERROR";
  const message = typeof payload?.error?.message === "string"
    ? payload.error.message
    : "Relay control request failed.";
  const safe = SAFE_NOT_DISPATCHED_CODES.has(code);
  return new NativeRelayProviderError(message, {
    code,
    category: "relay_control",
    retryable: false,
    dispatchState: safe ? "not_dispatched" : "unknown",
    outcomeUncertain: !safe,
    automaticReplay: false,
    httpStatus: status,
  });
}

function bodyOutcome(body) {
  const evidence = body?.error?.details?.outcome_evidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return null;
  return evidence;
}

export class NativeRelayExecutorProvider {
  #relayUrl;
  #token;
  #deviceId;
  #fetch;
  #binding = null;
  #waitTimeoutMs;
  #controlTimeoutMs;
  #desktopId;

  constructor({
    relayUrl = process.env.PC_NATIVE_RELAY_URL,
    relayToken = process.env.PC_NATIVE_RELAY_TOKEN,
    deviceId = process.env.PC_NATIVE_DEVICE_ID,
    desktopId = process.env.PC_NATIVE_DESKTOP_ID ?? "desktop-A",
    fetchImpl = globalThis.fetch,
    waitTimeoutMs = 30_000,
    controlTimeoutMs = Number.parseInt(process.env.PC_NATIVE_RELAY_CONTROL_TIMEOUT_MS ?? "5000", 10),
  } = {}) {
    this.#relayUrl = normalizeRelayUrl(relayUrl);
    this.#token = requireText(relayToken, "relayToken");
    if (this.#token.length < 32) {
      throw new TypeError("relayToken must contain at least 32 characters");
    }
    this.#deviceId = requireText(deviceId, "deviceId");
    this.#desktopId = requireText(desktopId, "desktopId");
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
    if (!Number.isInteger(waitTimeoutMs) || waitTimeoutMs < 1 || waitTimeoutMs > 120_000) {
      throw new TypeError("waitTimeoutMs must be an integer between 1 and 120000");
    }
    if (!Number.isInteger(controlTimeoutMs) || controlTimeoutMs < 100 || controlTimeoutMs > 120_000) {
      throw new TypeError("controlTimeoutMs must be an integer between 100 and 120000");
    }
    this.#fetch = fetchImpl;
    this.#waitTimeoutMs = waitTimeoutMs;
    this.#controlTimeoutMs = controlTimeoutMs;

    this.invoke = this.invoke.bind(this);
    this.readCapabilities = this.readCapabilities.bind(this);
    this.readEvidence = this.readEvidence.bind(this);
    this.readTransportHealth = this.readTransportHealth.bind(this);
  }

  get desktopId() {
    return this.#desktopId;
  }

  async #json(path, {
    method = "GET",
    body = undefined,
    signal = undefined,
    allowNotFound = false,
    networkDispatchState = "not_dispatched",
    networkOutcomeUncertain = false,
  } = {}) {
    const target = new URL(path, this.#relayUrl);
    let response;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(Object.assign(new Error("relay_control_timeout"), { code: "RELAY_CONTROL_TIMEOUT" }));
    }, this.#controlTimeoutMs);
    let removeAbort = null;
    if (signal) {
      const onAbort = () => controller.abort(signal.reason ?? new Error("cancelled"));
      if (signal.aborted) onAbort();
      else {
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbort = () => signal.removeEventListener("abort", onAbort);
      }
    }
    try {
      response = await this.#fetch(target, {
        method,
        headers: {
          authorization: `Bearer ${this.#token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch (error) {
      if (signal?.aborted && !timedOut) throw cancelledBeforeDispatch();
      throw new NativeRelayProviderError(
        timedOut ? "Relay control API timed out." : "Relay control API is unavailable.",
        {
          code: timedOut ? "RELAY_CONTROL_TIMEOUT" : "RELAY_CONTROL_UNAVAILABLE",
          category: "relay_control",
          retryable: networkDispatchState === "not_dispatched",
          dispatchState: networkDispatchState,
          outcomeUncertain: networkOutcomeUncertain,
          automaticReplay: false,
        },
      );
    } finally {
      clearTimeout(timer);
      removeAbort?.();
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (allowNotFound && response.status === 404) return null;
    if (!response.ok) throw errorFromRelay(response.status, payload);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new NativeRelayProviderError("Relay control API returned malformed JSON.", {
        code: "RELAY_CONTROL_MALFORMED",
        category: "relay_control",
        retryable: false,
        dispatchState: "not_dispatched",
      });
    }
    return payload;
  }

  async #deviceSnapshot({ signal = undefined, establish = true } = {}) {
    const payload = await this.#json("/v1/relay/devices", { signal });
    if (!Array.isArray(payload.devices)) {
      throw new NativeRelayProviderError("Relay device discovery is malformed.", {
        code: "RELAY_DEVICE_DISCOVERY_MALFORMED",
      });
    }
    const device = payload.devices.find((item) => item?.device_id === this.#deviceId);
    if (!device) {
      throw new NativeRelayProviderError("Configured native device is not registered.", {
        code: "DEVICE_NOT_FOUND",
        category: "device",
        httpStatus: 404,
      });
    }
    if (device.online !== true) {
      throw new NativeRelayProviderError("Configured native device is offline.", {
        code: "DEVICE_OFFLINE",
        category: "device",
        retryable: true,
      });
    }
    if (typeof device.last_session_epoch !== "string" || !device.last_session_epoch) {
      throw new NativeRelayProviderError("Online device has no authenticated session epoch.", {
        code: "DEVICE_SESSION_MISSING",
        category: "device",
      });
    }
    if (!device.capabilities || typeof device.capabilities !== "object" || Array.isArray(device.capabilities)) {
      throw new NativeRelayProviderError("Online device has no capability manifest.", {
        code: "DEVICE_CAPABILITIES_MISSING",
        category: "capability_mismatch",
      });
    }
    const digest = relayDigestJson(device.capabilities);
    if (digest !== device.capabilities_digest) {
      throw new NativeRelayProviderError("Relay capability digest does not match the advertised manifest.", {
        code: "CAPABILITY_DIGEST_MISMATCH",
        category: "capability_mismatch",
      });
    }
    const executor = device.capabilities.executor;
    if (!executor || typeof executor !== "object" || Array.isArray(executor)
      || typeof executor.digest !== "string" || !executor.digest) {
      throw new NativeRelayProviderError("Device capability manifest has no Executor digest.", {
        code: "EXECUTOR_CAPABILITIES_MISSING",
        category: "capability_mismatch",
      });
    }
    const next = {
      deviceId: device.device_id,
      sessionEpoch: device.last_session_epoch,
      capabilitiesDigest: device.capabilities_digest,
      executorDigest: executor.digest,
    };
    if (this.#binding) {
      if (this.#binding.deviceId !== next.deviceId
        || this.#binding.sessionEpoch !== next.sessionEpoch) {
        throw new NativeRelayProviderError("Native device session epoch changed after provider binding.", {
          code: "STALE_DEVICE_SESSION",
          category: "session",
          httpStatus: 409,
        });
      }
      if (this.#binding.capabilitiesDigest !== next.capabilitiesDigest
        || this.#binding.executorDigest !== next.executorDigest) {
        throw new NativeRelayProviderError("Native device capabilities changed after provider binding.", {
          code: "CAPABILITY_DRIFT",
          category: "capability_mismatch",
          httpStatus: 409,
        });
      }
    } else if (establish) {
      this.#binding = next;
    }
    return { device: clone(device), binding: next, executor: clone(executor) };
  }

  async readTransportHealth(_request = {}, context = {}) {
    if (context.signal?.aborted) throw cancelledBeforeDispatch();
    const [relay, devices] = await Promise.all([
      this.#json("/v1/relay/health", { signal: context.signal }),
      this.#json("/v1/relay/devices", { signal: context.signal }),
    ]);
    const device = Array.isArray(devices.devices)
      ? devices.devices.find((item) => item?.device_id === this.#deviceId) : null;
    return Object.freeze({
      contract_version: "pc.native.relay.health.v1",
      process_alive: relay.process_alive === true || relay.running === true,
      transport_connected: device?.online === true && relay.transport_connected !== false,
      queue_progressing: relay.queue_progressing !== false,
      executor_responsive: device?.online === true,
      last_progress_at_ms: relay.last_progress_at_ms ?? null,
      last_successful_result_at_ms: relay.last_successful_result_at_ms ?? null,
      pending_deliveries: relay.pending_deliveries ?? null,
      oldest_pending_age_ms: relay.oldest_pending_age_ms ?? null,
      device_last_seen_at_ms: device?.last_seen_at_ms ?? null,
      device_session_epoch_present: typeof device?.last_session_epoch === "string"
        && device.last_session_epoch.length > 0,
    });
  }

  async readCapabilities(_request = {}, context = {}) {
    if (context.signal?.aborted) throw cancelledBeforeDispatch();
    const { device, executor } = await this.#deviceSnapshot({
      signal: context.signal,
      establish: true,
    });
    return projectProducerExecutorActions(device.capabilities, executor);
  }

  // A device boot epoch is not interchangeable with a static capability digest.
  // Keep the private relay binding authoritative for long-lived native handles.
  async readDeviceIdentity(_request = {}, context = {}) {
    if (context.signal?.aborted) throw cancelledBeforeDispatch();
    const { binding } = await this.#deviceSnapshot({
      signal: context.signal,
      establish: true,
    });
    return Object.freeze({
      deviceId: binding.deviceId,
      sessionEpoch: binding.sessionEpoch,
      executorDigest: binding.executorDigest,
    });
  }

  #bridgeContext(request, context, binding) {
    const logicalRequestId = requireText(
      context.logicalRequestId ?? context.actionMetadata?.native_request_id,
      "logicalRequestId",
    );
    const metadata = context.actionMetadata;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      throw new NativeRelayProviderError("Native facade action metadata is required.", {
        code: "NATIVE_BRIDGE_CONTEXT_MISSING",
        category: "bridge_context",
      });
    }
    if (metadata.native_request_id !== logicalRequestId) {
      throw new NativeRelayProviderError("Native facade request identity changed before relay dispatch.", {
        code: "REQUEST_ID_MISMATCH",
        category: "idempotency",
        httpStatus: 409,
      });
    }
    const nativeSessionId = requireText(metadata.native_session_id, "native_session_id");
    const nativeTool = requireText(metadata.native_tool, "native_tool");
    const tool = toolDefinition(nativeTool);
    if (!tool || tool.executorAction !== request.action) {
      throw new NativeRelayProviderError("Native tool/Executor action binding is invalid.", {
        code: "NATIVE_TOOL_BINDING_MISMATCH",
        category: "bridge_context",
      });
    }
    if (metadata.effect !== tool.effect) {
      throw new NativeRelayProviderError("Native tool effect classification changed before relay dispatch.", {
        code: "CAPABILITY_SEMANTICS_MISMATCH",
        category: "capability_mismatch",
      });
    }
    if (metadata.native_executor_digest
      && metadata.native_executor_digest !== binding.executorDigest) {
      throw new NativeRelayProviderError("Facade session Executor digest is stale.", {
        code: "CAPABILITY_DRIFT",
        category: "capability_mismatch",
        httpStatus: 409,
      });
    }
    return {
      logicalRequestId,
      nativeSessionId,
      nativeTool,
      tool,
    };
  }

  #nativeEnvelope(request, bridge, binding) {
    const arguments_ = clone(request.params ?? {});
    if (bridge.nativeTool === "agent.shutdown") {
      const generationId = requireText(arguments_.generation_id, "agent.shutdown generation_id");
      Object.keys(arguments_).forEach((key) => delete arguments_[key]);
      Object.assign(arguments_, {
        device_id: binding.deviceId,
        session_id: bridge.nativeSessionId,
        session_epoch: binding.sessionEpoch,
        generation_id: generationId,
      });
    }
    // Facade tool identity remains the public Control name; only the exact
    // PC Core wire registry/name is translated. Frozen v1 payloads are kept
    // byte-compatible (no new registry_version field). An explicit parity
    // version is mandatory for names absent from PC Core's frozen v1 registry.
    // This is deterministic and fail-closed BEFORE relay dispatch.
    const wire = routeNativeExecutorTool(
      bridge.nativeTool, bridge.tool.executorAction, bridge.tool.effect,
    );
    const envelope = {
      contract_version: NATIVE_CONTROL_PROTOCOL_V1,
      ...(wire.registryVersion === PC_PARITY_REGISTRY_V1
        ? { registry_version: wire.registryVersion } : {}),
      session_id: bridge.nativeSessionId,
      request_id: bridge.logicalRequestId,
      tool: wire.wireToolName,
      arguments: arguments_,
    };
    if (request.execution_context_binding !== undefined) {
      envelope.execution_context = {
        device_id: binding.deviceId,
        session_epoch: binding.sessionEpoch,
        binding: clone(request.execution_context_binding),
      };
    }
    return envelope;
  }

  async #cancelAfterDispatch(delivery, bridge) {
    try {
      return await this.#json("/v1/relay/request/cancel", {
        method: "POST",
        body: {
          delivery_id: delivery,
          reason: "control_bridge_cancelled",
        },
      });
    } catch (error) {
      if (error?.code === "DELIVERY_NOT_FOUND") {
        throw uncertainError("Cancellation raced relay dispatch; side-effect outcome is not provable.", {
          code: "CANCELLATION_DISPATCH_RACE",
          details: { logical_request_id: bridge.logicalRequestId },
        });
      }
      throw uncertainError("Cancellation could not prove relay delivery outcome.", {
        code: error?.code ?? "CANCELLATION_RECONCILE_REQUIRED",
        details: { logical_request_id: bridge.logicalRequestId },
      });
    }
  }

  async invoke(request, context = {}) {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new TypeError("bridge invoke request must be an object");
    }
    requireText(request.request_id, "request.request_id");
    requireText(request.action, "request.action");
    if (!request.params || typeof request.params !== "object" || Array.isArray(request.params)) {
      throw new TypeError("request.params must be an object");
    }
    if (context.signal?.aborted) throw cancelledBeforeDispatch();

    const { binding } = await this.#deviceSnapshot({
      signal: context.signal,
      establish: true,
    });
    if (context.signal?.aborted) throw cancelledBeforeDispatch();
    const bridge = this.#bridgeContext(request, context, binding);
    const envelope = this.#nativeEnvelope(request, bridge, binding);
    const delivery = deliveryId(binding.deviceId, bridge.logicalRequestId);
    const semantics = bridge.tool.effect === "read_only" ? "read_only" : "side_effecting";
    const relayRequest = {
      device_id: binding.deviceId,
      request_id: bridge.logicalRequestId,
      request_version: NATIVE_CONTROL_PROTOCOL_V1,
      delivery_id: delivery,
      semantics,
      body: envelope,
      wait_timeout_ms: this.#waitTimeoutMs,
    };

    const dispatchPromise = this.#json("/v1/relay/request", {
      method: "POST",
      body: relayRequest,
      networkDispatchState: "unknown",
      networkOutcomeUncertain: semantics === "side_effecting",
    });
    dispatchPromise.catch(() => {});

    let view;
    if (context.signal) {
      let removeAbort = null;
      const aborted = new Promise((resolve) => {
        const onAbort = () => resolve({ aborted: true });
        if (context.signal.aborted) onAbort();
        else {
          context.signal.addEventListener("abort", onAbort, { once: true });
          removeAbort = () => context.signal.removeEventListener("abort", onAbort);
        }
      });
      const winner = await Promise.race([
        dispatchPromise.then((value) => ({ value })),
        aborted,
      ]);
      removeAbort?.();
      if (winner.aborted) {
        view = await this.#cancelAfterDispatch(delivery, bridge);
      } else {
        view = winner.value;
      }
    } else {
      view = await dispatchPromise;
    }

    return this.#translateDelivery(view, request, bridge, semantics);
  }

  #translateDelivery(view, request, bridge, semantics) {
    if (!view || typeof view !== "object" || Array.isArray(view)) {
      throw uncertainError("Relay delivery response is malformed.", {
        code: "RELAY_DELIVERY_MALFORMED",
      });
    }
    if (view.request_id !== bridge.logicalRequestId || view.delivery_id !== deliveryId(this.#deviceId, bridge.logicalRequestId)) {
      throw uncertainError("Relay delivery identity does not match the logical request.", {
        code: "RELAY_DELIVERY_IDENTITY_MISMATCH",
      });
    }

    if (view.status === "reconciliation_required") {
      throw uncertainError("Relay requires reconciliation for the dispatched request.", {
        details: {
          logical_request_id: bridge.logicalRequestId,
          delivery_id: view.delivery_id,
          automatic_replay: false,
        },
      });
    }
    if (view.status === "failed") {
      const code = view.error?.code ?? "RELAY_DELIVERY_FAILED";
      if (semantics === "side_effecting") {
        throw uncertainError("Side-effect delivery failed after relay dispatch.", {
          code,
          details: {
            logical_request_id: bridge.logicalRequestId,
            delivery_id: view.delivery_id,
          },
        });
      }
      throw new NativeRelayProviderError(view.error?.message ?? "Read-only relay delivery failed.", {
        code,
        category: "relay_delivery",
        retryable: view.error?.retryable === true,
        dispatchState: "unknown",
        outcomeUncertain: false,
      });
    }
    if (view.status === "cancelled") {
      const error = new NativeRelayProviderError("Relay delivery was cancelled.", {
        code: "CANCELLED",
        category: "cancelled",
        dispatchState: "unknown",
        outcomeUncertain: false,
      });
      error.name = "AbortError";
      throw error;
    }
    if (view.status !== "completed") {
      if (semantics === "side_effecting") {
        throw uncertainError("Side-effect delivery result is not terminal.", {
          code: "UNKNOWN_RECONCILE",
          details: {
            logical_request_id: bridge.logicalRequestId,
            delivery_id: view.delivery_id,
            delivery_status: view.status ?? null,
          },
        });
      }
      throw new NativeRelayProviderError("Read-only delivery did not reach a terminal result.", {
        code: "RELAY_RESULT_PENDING",
        category: "relay_delivery",
        retryable: false,
        dispatchState: "unknown",
        outcomeUncertain: false,
      });
    }

    const relayResult = view.result;
    const body = relayResult?.body;
    if (relayResult?.status !== "OK"
      || !body
      || typeof body !== "object"
      || Array.isArray(body)
      || body.contract_version !== NATIVE_RESPONSE_V1
      || body.request_id !== bridge.logicalRequestId) {
      if (semantics === "side_effecting") {
        throw uncertainError("Side-effect relay result failed native response validation.", {
          code: "NATIVE_RESPONSE_MALFORMED",
        });
      }
      throw new NativeRelayProviderError("Relay returned an invalid native response.", {
        code: "NATIVE_RESPONSE_MALFORMED",
        category: "provider_protocol",
        dispatchState: "unknown",
      });
    }

    if (body.status === "completed") {
      return {
        request_id: request.request_id,
        action: request.action,
        ok: true,
        status: "completed",
        dry_run: false,
        data: clone(body.data ?? {}),
        relay_delivery: {
          delivery_id: view.delivery_id,
          logical_request_id: bridge.logicalRequestId,
          automatic_replay: false,
          stream: relayResult.stream
            ? {
                manifest: clone(relayResult.stream.manifest),
                data_b64: relayResult.stream.data_b64,
              }
            : null,
        },
      };
    }

    if (body.status === "error") {
      const outcome = bodyOutcome(body);
      const code = body.error?.code ?? "EXECUTION_FAILED";
      if (DEVICE_PRE_DISPATCH_CODES.has(code)
        || (outcome?.effect_state === "not_started"
          && outcome?.dispatch_started === false
          && outcome?.reexecution_safe === true)) {
        throw new NativeRelayProviderError(body.error?.message ?? "Device rejected request before execution.", {
          code,
          category: body.error?.category ?? "execution",
          retryable: false,
          dispatchState: "not_dispatched",
          outcomeUncertain: false,
          details: clone(body.error?.details ?? null),
        });
      }
      if (semantics === "side_effecting") {
        throw uncertainError(body.error?.message ?? "Side-effect result is not provably safe.", {
          code: outcome?.effect_state === "unknown" ? "UNKNOWN_RECONCILE" : code,
          details: {
            logical_request_id: bridge.logicalRequestId,
            delivery_id: view.delivery_id,
            native_error: clone(body.error ?? null),
          },
        });
      }
      return {
        request_id: request.request_id,
        action: request.action,
        ok: false,
        status: "failed",
        error: body.error?.message ?? "Read-only device request failed.",
        error_kind: body.error?.category ?? "executor_failure",
        dry_run: false,
        data: clone(body.error?.details ?? {}),
      };
    }

    if (semantics === "side_effecting") {
      throw uncertainError("Side-effect native response is not terminal.", {
        code: "UNKNOWN_RECONCILE",
      });
    }
    throw new NativeRelayProviderError("Read-only native response has unsupported status.", {
      code: "NATIVE_RESPONSE_STATUS_INVALID",
      category: "provider_protocol",
      dispatchState: "unknown",
    });
  }

  async readEvidence(request, context = {}) {
    const logicalRequestId = requireText(
      context.logicalRequestId ?? context.actionMetadata?.native_request_id,
      "logicalRequestId",
    );
    const delivery = deliveryId(this.#deviceId, logicalRequestId);
    const view = await this.#json(
      `/v1/relay/request?delivery_id=${encodeURIComponent(delivery)}`,
      { signal: context.signal, allowNotFound: true },
    );
    const base = {
      source: "native-relay-provider",
      requestId: request.request_id,
      logicalRequestId,
      deliveryId: delivery,
      automaticReplay: false,
    };
    if (!view) return { ...base, outcome: "unknown", reason: "relay_delivery_missing" };

    if (view.status === "completed") {
      const body = view.result?.body;
      if (body?.status === "completed" && body.request_id === logicalRequestId) {
        return {
          ...base,
          outcome: "succeeded",
          reason: "relay_cached_completed_result",
          result: {
            request_id: request.request_id,
            action: request.action,
            ok: true,
            status: "completed",
            dry_run: false,
            data: clone(body.data ?? {}),
            relay_delivery: {
              delivery_id: delivery,
              logical_request_id: logicalRequestId,
              automatic_replay: false,
              recovered_from_lookup: true,
            },
          },
        };
      }
      const outcome = bodyOutcome(body);
      if (outcome?.effect_state === "not_started" && outcome?.dispatch_started === false) {
        return { ...base, outcome: "not_dispatched", reason: "relay_cached_not_started" };
      }
      return { ...base, outcome: "unknown", reason: "relay_cached_non_success_result" };
    }
    if (view.status === "reconciliation_required") {
      return { ...base, outcome: "unknown", reason: "UNKNOWN_RECONCILE" };
    }
    if (view.status === "cancelled") {
      return { ...base, outcome: "cancelled", reason: "relay_cancelled" };
    }
    if (view.status === "failed") {
      return { ...base, outcome: "unknown", reason: view.error?.code ?? "relay_failed" };
    }
    return { ...base, outcome: "unknown", reason: `relay_${view.status ?? "unknown"}` };
  }
}

export function createNativeRelayExecutorBridge(options = {}) {
  const provider = new NativeRelayExecutorProvider(options);
  return Object.freeze({
    invoke: provider.invoke,
    readCapabilities: provider.readCapabilities,
    readDeviceIdentity: provider.readDeviceIdentity.bind(provider),
    readEvidence: provider.readEvidence,
    readTransportHealth: provider.readTransportHealth,
    dryRun: false,
    desktopId: provider.desktopId,
    identity: NATIVE_RELAY_PROVIDER_IDENTITY,
  });
}

export async function createExecutorBridge(options = {}) {
  return createNativeRelayExecutorBridge(options);
}

export default createExecutorBridge;

export const __test = Object.freeze({ deliveryId, normalizeRelayUrl });
