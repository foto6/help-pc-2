import { createHash, createHmac, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { win32 as pathWin32 } from "node:path";
import WebSocket from "ws";
import {
  TOOL_REGISTRY_DIGEST,
  TOOL_REGISTRY_LIST,
  canonicalJson,
} from "./native-registry.js";
import {
  PC_FROZEN_REGISTRY_V1,
  PC_PARITY_REGISTRY_V1,
  PINNED_PC_FROZEN_DIGEST,
  PINNED_CONTROL_NATIVE_DIGEST,
  PC_NATIVE_WIRE_ROUTES,
} from "./native-relay-registry-route.js";

export const NATIVE_PLUGIN_DELIVERY_V1 = "pc.native.chatgpt.plugin_delivery.v1";
export const NATIVE_PLUGIN_PAIRING_REQUEST_V1 =
  "pc.native.chatgpt.plugin_pairing_request.v1";
export const NATIVE_PLUGIN_PAIRING_RESPONSE_V1 =
  "pc.native.chatgpt.plugin_pairing_response.v1";
export const NATIVE_PLUGIN_BROKER_FRAME_V1 =
  "pc.native.chatgpt.plugin_broker_frame.v1";
export const NATIVE_PLUGIN_REGISTRATION_CANDIDATE_V1 =
  "pc.native.chatgpt.registration_candidate.v1";

export const EXISTING_PLUGIN_IDENTITY = "pc-control";
export const DEFAULT_PAIRING_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_LIVE_STACK_MAX_AGE_MS = 30_000;
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
export const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;

const HEX_64_RE = /^[0-9a-f]{64}$/;
const IDENT_RE = /^[A-Za-z0-9._:-]{1,180}$/;
const DELIVERY_RE = /^[A-Za-z0-9._:-]{1,220}$/;
const PROTECTED_PATH_KEYS = new Set([
  "path",
  "paths",
  "cwd",
  "source",
  "destination",
  "from",
  "to",
  "file",
  "filename",
]);

function error(code, message, {
  category = "native_plugin_delivery",
  retryable = false,
  dispatchState = "not_dispatched",
  outcomeUncertain = false,
  details = null,
} = {}) {
  const value = new Error(message);
  value.name = "NativePluginDeliveryError";
  value.code = code;
  value.category = category;
  value.retryable = retryable;
  value.dispatchState = dispatchState;
  value.outcomeUncertain = outcomeUncertain;
  value.details = details;
  return value;
}

function requireText(value, name, re = IDENT_RE) {
  if (typeof value !== "string" || !re.test(value)) {
    throw error("INVALID_CONFIGURATION", `${name} is invalid`);
  }
  return value;
}

function requireHex64(value, name) {
  if (typeof value !== "string" || !HEX_64_RE.test(value)) {
    throw error("CAPABILITY_BINDING_INVALID", `${name} must be a lowercase sha256 digest`);
  }
  return value;
}

function sha256(value) {
  return createHash("sha256")
    .update(typeof value === "string" ? value : canonicalJson(value))
    .digest("hex");
}

function forbiddenHostname(hostname) {
  const lower = hostname.toLowerCase();
  return (
    lower === "localhost"
    || lower.endsWith(".localhost")
    || lower.endsWith(".local")
    || lower.endsWith(".internal")
    || isIP(lower) !== 0
  );
}

export function validateApprovedBrokerOrigin(
  brokerOrigin,
  { approvedHostname } = {},
) {
  let url;
  try {
    url = new URL(brokerOrigin);
  } catch {
    throw error("INVALID_HOST", "broker origin must be a valid HTTPS URL");
  }
  if (url.protocol !== "https:") {
    throw error("INVALID_HOST", "broker origin must use HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw error("INVALID_HOST", "broker origin must not contain credentials, query, or fragment");
  }
  if (url.pathname !== "/" || (url.port && url.port !== "443")) {
    throw error("INVALID_HOST", "broker origin must be the bare HTTPS origin on port 443");
  }
  if (forbiddenHostname(url.hostname)) {
    throw error("INVALID_HOST", "broker origin must not be localhost, private-local naming, or an IP literal");
  }
  if (
    typeof approvedHostname !== "string"
    || !approvedHostname
    || approvedHostname.toLowerCase() !== url.hostname.toLowerCase()
  ) {
    throw error("INVALID_HOST", "broker hostname is not the explicitly approved hostname");
  }
  return url.origin;
}

export function validateRemoteMcpUrl(remoteMcpUrl, brokerOrigin) {
  let url;
  try {
    url = new URL(remoteMcpUrl);
  } catch {
    throw error("REMOTE_MCP_ENDPOINT_INVALID", "remote MCP URL is invalid");
  }
  if (
    url.protocol !== "https:"
    || url.origin !== brokerOrigin
    || url.username
    || url.password
    || url.search
    || url.hash
    || !(url.pathname === "/mcp" || url.pathname.startsWith("/mcp/"))
  ) {
    throw error(
      "REMOTE_MCP_ENDPOINT_INVALID",
      "remote MCP URL must be credential-free HTTPS on the paired broker origin",
    );
  }
  return url.href;
}

export function assertCurrentLiveStack(
  liveStack,
  {
    now = Date.now(),
    maxAgeMs = DEFAULT_LIVE_STACK_MAX_AGE_MS,
  } = {},
) {
  if (!liveStack || typeof liveStack !== "object" || Array.isArray(liveStack)) {
    throw error("LOCAL_STACK_NOT_READY", "fresh live stack evidence is required");
  }
  if (liveStack.live_probe !== true) {
    throw error("LOCAL_STACK_NOT_READY", "historical persisted readiness is not accepted");
  }
  for (const key of ["pc_core", "relay", "control", "mcp_host"]) {
    if (liveStack[key] !== "ready") {
      throw error("LOCAL_STACK_NOT_READY", `current ${key} state is not ready`);
    }
  }
  const observed = liveStack.observed_at_epoch_ms;
  if (
    !Number.isInteger(observed)
    || observed <= 0
    || observed > now + 5_000
    || now - observed > maxAgeMs
  ) {
    throw error("LOCAL_STACK_NOT_READY", "live stack evidence is stale or malformed");
  }
  requireText(liveStack.device_epoch, "liveStack.device_epoch");
  requireText(liveStack.process_epoch, "liveStack.process_epoch");
  return Object.freeze({
    device_epoch: liveStack.device_epoch,
    process_epoch: liveStack.process_epoch,
    observed_at_epoch_ms: observed,
  });
}

function routeCounts() {
  const frozen = PC_NATIVE_WIRE_ROUTES.filter(
    (item) => item.registryVersion === PC_FROZEN_REGISTRY_V1,
  ).length;
  const parity = PC_NATIVE_WIRE_ROUTES.filter(
    (item) => item.registryVersion === PC_PARITY_REGISTRY_V1,
  ).length;
  if (
    frozen !== 37
    || parity !== 25
    || frozen + parity !== 62
    || TOOL_REGISTRY_LIST.length !== 62
    || TOOL_REGISTRY_DIGEST !== PINNED_CONTROL_NATIVE_DIGEST
  ) {
    throw error(
      "REGISTRY_DRIFT",
      "native registry partition changed; remote plugin delivery is blocked",
    );
  }
  return Object.freeze({ frozen, parity, total: frozen + parity });
}

export function buildCurrentDeviceBinding({
  deviceId,
  desktopId,
  executorDigest,
  capabilityDigest,
  liveStack,
  now = Date.now(),
} = {}) {
  const live = assertCurrentLiveStack(liveStack, { now });
  return Object.freeze({
    device_id: requireText(deviceId, "deviceId"),
    desktop_id: requireText(desktopId, "desktopId"),
    device_epoch: live.device_epoch,
    process_epoch: live.process_epoch,
    control_registry_digest: PINNED_CONTROL_NATIVE_DIGEST,
    pc_frozen_registry_digest: PINNED_PC_FROZEN_DIGEST,
    executor_digest: requireHex64(executorDigest, "executorDigest"),
    capability_digest: requireHex64(capabilityDigest, "capabilityDigest"),
    route_counts: routeCounts(),
  });
}

function ensureSecureStore(store) {
  if (
    !store
    || store.secure !== true
    || typeof store.put !== "function"
    || typeof store.get !== "function"
    || typeof store.delete !== "function"
  ) {
    throw error(
      "SECURE_CREDENTIAL_STORE_REQUIRED",
      "remote plugin delivery requires a secure credential store",
    );
  }
}

function ensureDurableDeliveryStore(store) {
  if (
    !store
    || store.durable !== true
    || typeof store.put !== "function"
    || typeof store.get !== "function"
  ) {
    throw error(
      "DURABLE_DELIVERY_STORE_REQUIRED",
      "remote side-effect delivery requires a durable delivery ledger",
    );
  }
}

function exactBindingMatches(expected, actual) {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  const keys = [
    "device_id",
    "desktop_id",
    "device_epoch",
    "process_epoch",
    "control_registry_digest",
    "pc_frozen_registry_digest",
    "executor_digest",
    "capability_digest",
  ];
  return keys.every((key) => actual[key] === expected[key])
    && actual.route_counts?.frozen === expected.route_counts.frozen
    && actual.route_counts?.parity === expected.route_counts.parity
    && actual.route_counts?.total === expected.route_counts.total;
}

function websocketUrlForOrigin(origin) {
  const url = new URL(origin);
  url.protocol = "wss:";
  url.pathname = "/v1/native-pc/device";
  return url.href;
}

function normalizeWindowsPathLexical(value) {
  if (typeof value !== "string" || !value) return null;
  let candidate = value.replaceAll("/", "\\");
  if (candidate.startsWith("\\\\?\\")) candidate = candidate.slice(4);
  if (!/^[A-Za-z]:\\/.test(candidate) && !candidate.startsWith("\\\\")) {
    return null;
  }
  candidate = pathWin32.normalize(candidate).replace(/\\+$/, "").toLowerCase();
  return candidate;
}

function collectPathLikeStrings(value, key = null, out = []) {
  if (typeof value === "string") {
    if (key && PROTECTED_PATH_KEYS.has(String(key).toLowerCase())) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPathLikeStrings(item, key, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const [childKey, childValue] of Object.entries(value)) {
      collectPathLikeStrings(childValue, childKey, out);
    }
  }
  return out;
}

export function assertNoProtectedPathArguments(value, protectedRoots = []) {
  const roots = protectedRoots
    .map(normalizeWindowsPathLexical)
    .filter(Boolean);
  for (const candidateRaw of collectPathLikeStrings(value)) {
    const candidate = normalizeWindowsPathLexical(candidateRaw);
    if (!candidate) continue;
    for (const root of roots) {
      if (candidate === root || candidate.startsWith(root + "\\")) {
        throw error(
          "PROTECTED_PATH",
          "broker request references a protected local path and was rejected lexically",
        );
      }
    }
  }
  return true;
}

function sanitizePairingResponse(body, expectedBinding, brokerOrigin, now) {
  if (
    !body
    || typeof body !== "object"
    || Array.isArray(body)
    || body.contract_version !== NATIVE_PLUGIN_PAIRING_RESPONSE_V1
    || body.accepted !== true
  ) {
    throw error("PAIRING_RESPONSE_INVALID", "pairing response is malformed");
  }
  if (body.broker_origin !== brokerOrigin) {
    throw error("PAIRING_BINDING_MISMATCH", "pairing response broker origin changed");
  }
  if (!exactBindingMatches(expectedBinding, body.binding)) {
    throw error("PAIRING_BINDING_MISMATCH", "pairing response device/digest/epoch binding changed");
  }
  const brokerIdentityDigest = requireHex64(
    body.broker_identity_digest,
    "broker_identity_digest",
  );
  const authorizedCallerDigest = requireHex64(
    body.authorized_caller_digest,
    "authorized_caller_digest",
  );
  const remoteMcpUrl = validateRemoteMcpUrl(body.remote_mcp?.url, brokerOrigin);
  if (body.remote_mcp?.transport !== "streamable-http") {
    throw error("REMOTE_MCP_ENDPOINT_INVALID", "remote MCP transport must be streamable-http");
  }
  const credential = body.credential;
  if (
    !credential
    || typeof credential !== "object"
    || typeof credential.id !== "string"
    || !IDENT_RE.test(credential.id)
    || typeof credential.token !== "string"
    || credential.token.length < 32
    || !Number.isInteger(credential.expires_at_epoch_ms)
    || credential.expires_at_epoch_ms < now + 30_000
    || credential.expires_at_epoch_ms > now + DEFAULT_PAIRING_TTL_MS
  ) {
    throw error("PAIRING_CREDENTIAL_INVALID", "pairing credential is missing, malformed, or not short-lived");
  }
  return {
    credential: {
      id: credential.id,
      token: credential.token,
      expires_at_epoch_ms: credential.expires_at_epoch_ms,
    },
    broker_identity_digest: brokerIdentityDigest,
    authorized_caller_digest: authorizedCallerDigest,
    remote_mcp_url: remoteMcpUrl,
  };
}

function pairingProof(pairingCode, payload) {
  if (typeof pairingCode !== "string" || pairingCode.length < 12) {
    throw error("PAIRING_CODE_INVALID", "pairing code must be at least 12 characters");
  }
  return createHmac("sha256", Buffer.from(pairingCode, "utf8"))
    .update(canonicalJson(payload))
    .digest("hex");
}

function redactCredential(record) {
  if (!record) return null;
  return Object.freeze({
    credential_id: record.credential_id,
    expires_at_epoch_ms: record.expires_at_epoch_ms,
    broker_origin: record.broker_origin,
    remote_mcp_url: record.remote_mcp_url,
    broker_identity_digest: record.broker_identity_digest,
    authorized_caller_digest: record.authorized_caller_digest,
    binding: structuredClone(record.binding),
  });
}

function frameBytes(value) {
  return Buffer.byteLength(
    typeof value === "string" ? value : JSON.stringify(value),
    "utf8",
  );
}

function requestFingerprint(frame) {
  return sha256({
    request_id: frame.request_id,
    delivery_id: frame.delivery_id,
    session_epoch: frame.session_epoch,
    semantics: frame.semantics,
    body: frame.body,
  });
}

function responseFrame({
  sessionEpoch,
  requestId,
  deliveryId,
  status,
  result = null,
  error: responseError = null,
}) {
  return {
    contract_version: NATIVE_PLUGIN_BROKER_FRAME_V1,
    type: "response",
    session_epoch: sessionEpoch,
    request_id: requestId,
    delivery_id: deliveryId,
    status,
    result,
    error: responseError,
    automatic_replay: false,
  };
}

function validateRequestFrame(frame, sessionEpoch, maxFrameBytes) {
  if (frameBytes(frame) > maxFrameBytes) {
    throw error("BROKER_FRAME_TOO_LARGE", "broker frame exceeds maximum size");
  }
  if (
    !frame
    || typeof frame !== "object"
    || Array.isArray(frame)
    || frame.contract_version !== NATIVE_PLUGIN_BROKER_FRAME_V1
    || frame.type !== "request"
    || frame.session_epoch !== sessionEpoch
    || typeof frame.request_id !== "string"
    || !IDENT_RE.test(frame.request_id)
    || typeof frame.delivery_id !== "string"
    || !DELIVERY_RE.test(frame.delivery_id)
    || !["read_only", "side_effecting"].includes(frame.semantics)
    || !frame.body
    || typeof frame.body !== "object"
    || Array.isArray(frame.body)
  ) {
    throw error("BROKER_FRAME_INVALID", "broker request frame is malformed or stale");
  }
  if (
    typeof frame.body_sha256 !== "string"
    || frame.body_sha256 !== sha256(frame.body)
  ) {
    throw error("BROKER_FRAME_INVALID", "broker request body digest mismatch");
  }
  return frame;
}

async function waitForSocketEvent(socket, successEvent, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const cleanups = [];
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      for (const fn of cleanups) fn();
    };
    const once = (eventName, handler) => {
      socket.once(eventName, handler);
      cleanups.push(() => socket.off?.(eventName, handler));
    };
    once(successEvent, (...args) => {
      cleanup();
      resolve(args);
    });
    once("error", () => {
      cleanup();
      reject(error("BROKER_OFFLINE", "remote broker connection failed", { retryable: true }));
    });
    once("close", () => {
      cleanup();
      reject(error("BROKER_OFFLINE", "remote broker closed before handshake", { retryable: true }));
    });
    timer = setTimeout(() => {
      cleanup();
      reject(error("BROKER_OFFLINE", "remote broker handshake timed out", { retryable: true }));
    }, timeoutMs);
    timer.unref?.();
  });
}

export class NativePluginBrokerConnector {
  constructor({
    enabled = false,
    brokerOrigin = null,
    approvedHostname = null,
    secureStore = null,
    deliveryStore = null,
    protectedRoots = [],
    fetchImpl = globalThis.fetch,
    websocketFactory = (url, options) => new WebSocket(url, options),
    randomBytesImpl = randomBytes,
    now = () => Date.now(),
    maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
    handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
  } = {}) {
    this.enabled = enabled === true;
    this.brokerOrigin = brokerOrigin;
    this.approvedHostname = approvedHostname;
    this.secureStore = secureStore;
    this.deliveryStore = deliveryStore;
    this.protectedRoots = [...protectedRoots];
    this.fetchImpl = fetchImpl;
    this.websocketFactory = websocketFactory;
    this.randomBytesImpl = randomBytesImpl;
    this.now = now;
    this.maxFrameBytes = maxFrameBytes;
    this.handshakeTimeoutMs = handshakeTimeoutMs;
  }

  #requireEnabledOrigin() {
    if (!this.enabled) {
      throw error("REMOTE_PLUGIN_DISABLED", "remote Native PC plugin delivery is opt-in and disabled");
    }
    return validateApprovedBrokerOrigin(this.brokerOrigin, {
      approvedHostname: this.approvedHostname,
    });
  }

  async pair({
    consent,
    pairingCode,
    deviceId,
    desktopId,
    executorDigest,
    capabilityDigest,
    liveStack,
  } = {}) {
    const brokerOrigin = this.#requireEnabledOrigin();
    ensureSecureStore(this.secureStore);
    if (
      !consent
      || consent.granted !== true
      || typeof consent.id !== "string"
      || !IDENT_RE.test(consent.id)
    ) {
      throw error("PAIRING_CONSENT_REQUIRED", "explicit user pairing consent is required");
    }
    const now = this.now();
    const binding = buildCurrentDeviceBinding({
      deviceId,
      desktopId,
      executorDigest,
      capabilityDigest,
      liveStack,
      now,
    });
    const nonce = this.randomBytesImpl(32).toString("base64url");
    const proofPayload = {
      contract_version: NATIVE_PLUGIN_PAIRING_REQUEST_V1,
      nonce,
      consent_id: consent.id,
      plugin_identity: EXISTING_PLUGIN_IDENTITY,
      binding,
    };
    const requestBody = {
      ...proofPayload,
      pairing_proof: pairingProof(pairingCode, proofPayload),
    };
    let response;
    try {
      response = await this.fetchImpl(new URL("/v1/native-pc/pair", brokerOrigin), {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
        },
        body: JSON.stringify(requestBody),
      });
    } catch {
      throw error("BROKER_OFFLINE", "approved remote pairing broker is unreachable", {
        retryable: true,
      });
    }
    if (response.status === 401) {
      throw error("PAIRING_UNAUTHORIZED", "pairing proof was rejected");
    }
    if (!response.ok) {
      throw error("PAIRING_REJECTED", `pairing broker rejected request with HTTP ${response.status}`);
    }
    if (response.url && new URL(response.url).origin !== brokerOrigin) {
      throw error("INVALID_HOST", "pairing response crossed the approved broker origin");
    }
    let body;
    try {
      body = await response.json();
    } catch {
      throw error("PAIRING_RESPONSE_INVALID", "pairing response was not JSON");
    }
    const paired = sanitizePairingResponse(body, binding, brokerOrigin, now);
    const record = {
      contract_version: NATIVE_PLUGIN_DELIVERY_V1,
      credential_id: paired.credential.id,
      token: paired.credential.token,
      expires_at_epoch_ms: paired.credential.expires_at_epoch_ms,
      broker_origin: brokerOrigin,
      remote_mcp_url: paired.remote_mcp_url,
      broker_identity_digest: paired.broker_identity_digest,
      authorized_caller_digest: paired.authorized_caller_digest,
      binding,
    };
    await this.secureStore.put(structuredClone(record));
    return {
      status: "paired",
      plugin_identity: EXISTING_PLUGIN_IDENTITY,
      pairing: redactCredential(record),
    };
  }

  async revoke() {
    ensureSecureStore(this.secureStore);
    const existing = await this.secureStore.get();
    await this.secureStore.delete();
    return {
      status: existing ? "revoked_local" : "already_unpaired",
      credential_id: existing?.credential_id ?? null,
    };
  }

  async registrationCandidate({ localBinding = null } = {}) {
    this.#requireEnabledOrigin();
    ensureSecureStore(this.secureStore);
    const record = await this.secureStore.get();
    if (!record) throw error("UNPAIRED", "remote Native PC connector is not paired");
    if (record.expires_at_epoch_ms <= this.now()) {
      throw error("PAIRING_EXPIRED", "remote Native PC pairing credential expired");
    }
    if (localBinding && !exactBindingMatches(localBinding, record.binding)) {
      throw error("PAIRING_BINDING_MISMATCH", "current device/digest/epoch does not match pairing");
    }
    return Object.freeze({
      contract_version: NATIVE_PLUGIN_REGISTRATION_CANDIDATE_V1,
      plugin_identity: EXISTING_PLUGIN_IDENTITY,
      publish_allowed: false,
      reason: "client_registration_requires_independent_reachability_and_tools_list_proof",
      mcp: {
        transport: "streamable-http",
        url: validateRemoteMcpUrl(record.remote_mcp_url, record.broker_origin),
        authentication: "paired_short_lived_broker_credential",
      },
      binding: structuredClone(record.binding),
      broker_identity_digest: record.broker_identity_digest,
      authorized_caller_digest: record.authorized_caller_digest,
      credential_id: record.credential_id,
      expires_at_epoch_ms: record.expires_at_epoch_ms,
    });
  }

  async dispatchBrokerRequest(frame, {
    dispatch,
    sessionEpoch,
    liveStack,
  } = {}) {
    if (typeof dispatch !== "function") {
      throw error("INVALID_CONFIGURATION", "dispatch callback is required");
    }
    ensureDurableDeliveryStore(this.deliveryStore);
    assertCurrentLiveStack(liveStack, { now: this.now() });
    validateRequestFrame(frame, sessionEpoch, this.maxFrameBytes);
    assertNoProtectedPathArguments(frame.body, this.protectedRoots);

    const fingerprint = requestFingerprint(frame);
    const existing = await this.deliveryStore.get(frame.delivery_id);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return responseFrame({
          sessionEpoch,
          requestId: frame.request_id,
          deliveryId: frame.delivery_id,
          status: "failed",
          error: {
            code: "DELIVERY_ID_CONFLICT",
            message: "delivery id was reused with different request content",
          },
        });
      }
      if (existing.response) return structuredClone(existing.response);
      return responseFrame({
        sessionEpoch,
        requestId: frame.request_id,
        deliveryId: frame.delivery_id,
        status: "reconciliation_required",
        error: {
          code: "UNKNOWN_RECONCILE",
          message: "prior dispatch has no provable terminal outcome",
        },
      });
    }

    await this.deliveryStore.put(frame.delivery_id, {
      fingerprint,
      request_id: frame.request_id,
      semantics: frame.semantics,
      state: "dispatching",
      response: null,
    });

    let response;
    try {
      const result = await dispatch(structuredClone(frame.body), {
        requestId: frame.request_id,
        deliveryId: frame.delivery_id,
        semantics: frame.semantics,
        sessionEpoch,
      });
      response = responseFrame({
        sessionEpoch,
        requestId: frame.request_id,
        deliveryId: frame.delivery_id,
        status: "completed",
        result: structuredClone(result ?? null),
      });
    } catch (caught) {
      const notDispatched = caught?.dispatchState === "not_dispatched"
        && caught?.outcomeUncertain !== true;
      if (frame.semantics === "side_effecting" && !notDispatched) {
        response = responseFrame({
          sessionEpoch,
          requestId: frame.request_id,
          deliveryId: frame.delivery_id,
          status: "reconciliation_required",
          error: {
            code: "UNKNOWN_RECONCILE",
            message: "side-effect outcome is not provable; automatic replay is forbidden",
          },
        });
      } else {
        response = responseFrame({
          sessionEpoch,
          requestId: frame.request_id,
          deliveryId: frame.delivery_id,
          status: "failed",
          error: {
            code: typeof caught?.code === "string" ? caught.code : "DISPATCH_FAILED",
            message: "request failed without an authorized automatic replay",
          },
        });
      }
    }

    await this.deliveryStore.put(frame.delivery_id, {
      fingerprint,
      request_id: frame.request_id,
      semantics: frame.semantics,
      state: response.status,
      response: structuredClone(response),
    });
    return response;
  }

  async connect({
    deviceId,
    desktopId,
    executorDigest,
    capabilityDigest,
    liveStack,
    dispatch,
  } = {}) {
    const brokerOrigin = this.#requireEnabledOrigin();
    ensureSecureStore(this.secureStore);
    ensureDurableDeliveryStore(this.deliveryStore);
    if (typeof dispatch !== "function") {
      throw error("INVALID_CONFIGURATION", "dispatch callback is required");
    }
    const now = this.now();
    const binding = buildCurrentDeviceBinding({
      deviceId,
      desktopId,
      executorDigest,
      capabilityDigest,
      liveStack,
      now,
    });
    const credential = await this.secureStore.get();
    if (!credential) throw error("UNPAIRED", "remote Native PC connector is not paired");
    if (credential.expires_at_epoch_ms <= now) {
      throw error("PAIRING_EXPIRED", "remote Native PC pairing credential expired");
    }
    if (
      credential.broker_origin !== brokerOrigin
      || !exactBindingMatches(binding, credential.binding)
    ) {
      throw error("PAIRING_BINDING_MISMATCH", "current device/digest/epoch does not match pairing");
    }

    let socket;
    try {
      socket = this.websocketFactory(websocketUrlForOrigin(brokerOrigin), {
        headers: {
          Authorization: `Bearer ${credential.token}`,
        },
        origin: brokerOrigin,
        handshakeTimeout: this.handshakeTimeoutMs,
        maxPayload: this.maxFrameBytes,
      });
    } catch {
      throw error("BROKER_OFFLINE", "approved remote broker is unreachable", {
        retryable: true,
      });
    }

    await waitForSocketEvent(socket, "open", this.handshakeTimeoutMs);
    const connectionNonce = this.randomBytesImpl(24).toString("base64url");
    socket.send(JSON.stringify({
      contract_version: NATIVE_PLUGIN_BROKER_FRAME_V1,
      type: "hello",
      credential_id: credential.credential_id,
      connection_nonce: connectionNonce,
      binding,
    }));

    const [rawWelcome] = await waitForSocketEvent(
      socket,
      "message",
      this.handshakeTimeoutMs,
    );
    let welcome;
    try {
      const text = Buffer.isBuffer(rawWelcome) ? rawWelcome.toString("utf8") : String(rawWelcome);
      if (Buffer.byteLength(text, "utf8") > this.maxFrameBytes) {
        throw new Error("oversized");
      }
      welcome = JSON.parse(text);
    } catch {
      try { socket.close(); } catch {}
      throw error("BROKER_HANDSHAKE_INVALID", "broker welcome frame is malformed");
    }
    if (
      welcome.contract_version !== NATIVE_PLUGIN_BROKER_FRAME_V1
      || welcome.type !== "welcome"
      || welcome.accepted !== true
      || welcome.connection_nonce !== connectionNonce
      || typeof welcome.session_epoch !== "string"
      || !IDENT_RE.test(welcome.session_epoch)
      || welcome.broker_identity_digest !== credential.broker_identity_digest
      || welcome.authorized_caller_digest !== credential.authorized_caller_digest
      || !exactBindingMatches(binding, welcome.binding)
    ) {
      try { socket.close(); } catch {}
      throw error("PAIRING_BINDING_MISMATCH", "broker welcome did not match the paired identity/digests/epochs");
    }

    let closed = false;
    const sessionEpoch = welcome.session_epoch;
    const onMessage = async (raw) => {
      if (closed) return;
      let frame;
      try {
        const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
        frame = JSON.parse(text);
        const response = await this.dispatchBrokerRequest(frame, {
          dispatch,
          sessionEpoch,
          liveStack,
        });
        socket.send(JSON.stringify(response));
      } catch (caught) {
        const response = responseFrame({
          sessionEpoch,
          requestId: frame?.request_id ?? "invalid-request",
          deliveryId: frame?.delivery_id ?? "invalid-delivery",
          status: "failed",
          error: {
            code: caught?.code ?? "BROKER_FRAME_INVALID",
            message: "broker request was rejected before an authorized replay",
          },
        });
        try { socket.send(JSON.stringify(response)); } catch {}
      }
    };
    socket.on("message", onMessage);

    return Object.freeze({
      contract_version: NATIVE_PLUGIN_DELIVERY_V1,
      status: "connected",
      broker_origin: brokerOrigin,
      remote_mcp_url: credential.remote_mcp_url,
      credential_id: credential.credential_id,
      session_epoch: sessionEpoch,
      close: async () => {
        closed = true;
        socket.off?.("message", onMessage);
        try { socket.close(); } catch {}
      },
    });
  }
}

export function assessPluginDeliveryGate({
  brokerOrigin = null,
  paired = false,
  endpointReachabilityVerified = false,
  chatgptToolsListVerified = false,
  directReadOnlyAgentEvidenceVerified = false,
} = {}) {
  if (!brokerOrigin) {
    return {
      status: "BLOCKED_APPROVED_REMOTE_ENDPOINT_REQUIRED",
      ready: false,
    };
  }
  if (!paired) {
    return { status: "BLOCKED_PAIRING_REQUIRED", ready: false };
  }
  if (!endpointReachabilityVerified) {
    return {
      status: "BLOCKED_REMOTE_ENDPOINT_UNVERIFIED",
      ready: false,
    };
  }
  if (!chatgptToolsListVerified) {
    return {
      status: "BLOCKED_CLIENT_DISCOVERY_UNPROVEN",
      ready: false,
    };
  }
  if (!directReadOnlyAgentEvidenceVerified) {
    return {
      status: "BLOCKED_REAL_AGENT_BEHAVIOR_UNPROVEN",
      ready: false,
    };
  }
  return { status: "READ_ONLY_AGENT_INTEGRATION_PASS", ready: true };
}

export const __test = Object.freeze({
  exactBindingMatches,
  requestFingerprint,
  websocketUrlForOrigin,
  collectPathLikeStrings,
  normalizeWindowsPathLexical,
  pairingProof,
  sanitizePairingResponse,
});
