import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const REMOTE_FRAME_VERSION = "pc_remote_transport.frame.v1";
export const DEFAULT_RELAY_LIMITS = Object.freeze({
  maxFrameBytes: 1_048_576,
  maxRequestBytes: 524_288,
  maxChunkBytes: 65_536,
  maxStreamBytes: 8_388_608,
});

export const REMOTE_FRAME_TYPES = new Set([
  "hello",
  "welcome",
  "heartbeat",
  "heartbeat_ack",
  "request",
  "response",
  "stream_chunk",
  "stream_end",
  "reconcile_required",
  "error",
  "token.rotate",
  "token.rotated",
]);

const REQUEST_VERSION_RE = /^[A-Za-z0-9._-]{1,80}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,120}$/;
const DEVICE_ID_RE = /^[A-Za-z0-9._:-]{1,120}$/;
const SESSION_EPOCH_RE = /^[A-Za-z0-9._:-]{8,160}$/;
const HEX_64_RE = /^[0-9a-f]{64}$/;

export class RelayProtocolError extends Error {
  constructor(message, code = "PROTOCOL_ERROR") {
    super(message);
    this.name = "RelayProtocolError";
    this.code = code;
  }
}

export class RelayAuthenticationError extends RelayProtocolError {
  constructor(message) {
    super(message, "AUTHENTICATION_ERROR");
    this.name = "RelayAuthenticationError";
  }
}

export class RelayReplayError extends RelayProtocolError {
  constructor(message) {
    super(message, "REPLAY_ERROR");
    this.name = "RelayReplayError";
  }
}

export class RelayStaleEpochError extends RelayProtocolError {
  constructor(message) {
    super(message, "STALE_EPOCH");
    this.name = "RelayStaleEpochError";
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object" && !Buffer.isBuffer(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  return createHash("sha256").update(bytes).digest("hex");
}

export function digestJson(value) {
  return sha256Hex(Buffer.from(canonicalJson(value), "utf8"));
}

export function normalizeCredential({ generation, secret }) {
  if (!Number.isInteger(generation) || generation <= 0) {
    throw new TypeError("token generation must be a positive integer");
  }
  const bytes = Buffer.isBuffer(secret)
    ? Buffer.from(secret)
    : typeof secret === "string"
      ? Buffer.from(secret, "base64")
      : null;
  if (!bytes || bytes.length < 32) {
    throw new TypeError("token secret must contain at least 32 bytes");
  }
  return { generation, secret: bytes };
}

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function validateUnsigned(frame) {
  const keys = ["version", "device_id", "session_epoch", "sequence", "type", "payload"];
  if (!exactKeys(frame, keys)) throw new RelayProtocolError("frame keys mismatch");
  if (frame.version !== REMOTE_FRAME_VERSION) {
    throw new RelayProtocolError("unsupported frame version", "SCHEMA_VERSION_MISMATCH");
  }
  if (typeof frame.device_id !== "string" || !DEVICE_ID_RE.test(frame.device_id)) {
    throw new RelayProtocolError("invalid device_id");
  }
  if (typeof frame.session_epoch !== "string" || !SESSION_EPOCH_RE.test(frame.session_epoch)) {
    throw new RelayProtocolError("invalid session_epoch");
  }
  if (!Number.isInteger(frame.sequence) || frame.sequence <= 0) {
    throw new RelayProtocolError("sequence must be a positive integer");
  }
  if (!REMOTE_FRAME_TYPES.has(frame.type)) {
    throw new RelayProtocolError("unsupported frame type");
  }
  if (!frame.payload || typeof frame.payload !== "object" || Array.isArray(frame.payload)) {
    throw new RelayProtocolError("payload must be an object");
  }
}

function signable(frameWithoutAuth, generation) {
  return Buffer.from(canonicalJson({
    ...frameWithoutAuth,
    token_generation: generation,
  }), "utf8");
}

export function encodeRelayFrame({
  deviceId,
  sessionEpoch,
  sequence,
  type,
  payload,
  credential,
  maxFrameBytes = DEFAULT_RELAY_LIMITS.maxFrameBytes,
}) {
  const token = normalizeCredential(credential);
  const unsigned = {
    version: REMOTE_FRAME_VERSION,
    device_id: deviceId,
    session_epoch: sessionEpoch,
    sequence,
    type,
    payload,
  };
  validateUnsigned(unsigned);
  const tag = createHmac("sha256", token.secret)
    .update(signable(unsigned, token.generation))
    .digest("hex");
  const raw = canonicalJson({
    ...unsigned,
    auth: {
      scheme: "hmac-sha256",
      token_generation: token.generation,
      tag,
    },
  });
  if (Buffer.byteLength(raw, "utf8") > maxFrameBytes) {
    throw new RelayProtocolError("frame exceeds maximum size", "FRAME_TOO_LARGE");
  }
  return raw;
}

export function parseRelayEnvelope(raw, {
  maxFrameBytes = DEFAULT_RELAY_LIMITS.maxFrameBytes,
} = {}) {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), "utf8");
  if (bytes.length > maxFrameBytes) {
    throw new RelayProtocolError("frame exceeds maximum size", "FRAME_TOO_LARGE");
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new RelayProtocolError("invalid JSON frame");
  }
  if (!exactKeys(parsed, ["version", "device_id", "session_epoch", "sequence", "type", "payload", "auth"])) {
    throw new RelayProtocolError("frame keys mismatch");
  }
  if (!exactKeys(parsed.auth, ["scheme", "token_generation", "tag"])) {
    throw new RelayAuthenticationError("invalid auth envelope");
  }
  if (parsed.auth.scheme !== "hmac-sha256") {
    throw new RelayAuthenticationError("unsupported auth scheme");
  }
  if (!Number.isInteger(parsed.auth.token_generation) || parsed.auth.token_generation <= 0) {
    throw new RelayAuthenticationError("invalid token generation");
  }
  if (typeof parsed.auth.tag !== "string" || !HEX_64_RE.test(parsed.auth.tag)) {
    throw new RelayAuthenticationError("invalid authentication tag");
  }
  const unsigned = {
    version: parsed.version,
    device_id: parsed.device_id,
    session_epoch: parsed.session_epoch,
    sequence: parsed.sequence,
    type: parsed.type,
    payload: parsed.payload,
  };
  validateUnsigned(unsigned);
  return { parsed, unsigned };
}

export function decodeRelayFrame(raw, {
  credentials,
  expectedDeviceId,
  expectedSessionEpoch,
  maxFrameBytes = DEFAULT_RELAY_LIMITS.maxFrameBytes,
}) {
  const { parsed, unsigned } = parseRelayEnvelope(raw, { maxFrameBytes });
  if (parsed.device_id !== expectedDeviceId) {
    throw new RelayAuthenticationError("device identity mismatch");
  }
  if (parsed.session_epoch !== expectedSessionEpoch) {
    throw new RelayStaleEpochError("stale or foreign session epoch");
  }
  const candidates = Array.isArray(credentials) ? credentials : [credentials];
  const credential = candidates
    .filter(Boolean)
    .map(normalizeCredential)
    .find((item) => item.generation === parsed.auth.token_generation);
  if (!credential) throw new RelayAuthenticationError("token generation mismatch");
  const expected = createHmac("sha256", credential.secret)
    .update(signable(unsigned, credential.generation))
    .digest();
  const actual = Buffer.from(parsed.auth.tag, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new RelayAuthenticationError("authentication tag mismatch");
  }
  return {
    ...unsigned,
    token_generation: credential.generation,
  };
}

export class ReplayGuard {
  constructor(initialSequence = 0) {
    this.lastSequence = initialSequence;
  }

  accept(sequence) {
    if (!Number.isInteger(sequence) || sequence <= this.lastSequence) {
      throw new RelayReplayError("replayed or reordered frame sequence");
    }
    this.lastSequence = sequence;
  }
}

export function validateRequestPayload(payload, {
  maxRequestBytes = DEFAULT_RELAY_LIMITS.maxRequestBytes,
} = {}) {
  const expected = ["request_id", "request_version", "delivery_id", "semantics", "body"];
  if (!exactKeys(payload, expected)) {
    throw new RelayProtocolError("request payload keys mismatch");
  }
  if (typeof payload.request_id !== "string" || !REQUEST_ID_RE.test(payload.request_id)) {
    throw new RelayProtocolError("invalid request_id");
  }
  if (typeof payload.request_version !== "string" || !REQUEST_VERSION_RE.test(payload.request_version)) {
    throw new RelayProtocolError("invalid request_version");
  }
  if (typeof payload.delivery_id !== "string" || !REQUEST_ID_RE.test(payload.delivery_id)) {
    throw new RelayProtocolError("invalid delivery_id");
  }
  if (!["read_only", "side_effecting"].includes(payload.semantics)) {
    throw new RelayProtocolError("semantics must be read_only or side_effecting");
  }
  if (!payload.body || typeof payload.body !== "object" || Array.isArray(payload.body)) {
    throw new RelayProtocolError("request body must be an object");
  }
  if (Buffer.byteLength(canonicalJson(payload.body), "utf8") > maxRequestBytes) {
    throw new RelayProtocolError("request body exceeds maximum size", "REQUEST_TOO_LARGE");
  }
  return structuredClone(payload);
}

export function requestFingerprint(payload) {
  return digestJson({
    request_id: payload.request_id,
    request_version: payload.request_version,
    semantics: payload.semantics,
    body: payload.body,
  });
}

function validateStreamManifest(manifest, maxStreamBytes) {
  if (!exactKeys(manifest, ["stream_id", "kind", "total_bytes", "chunk_bytes", "chunk_count", "sha256"])) {
    throw new RelayProtocolError("invalid stream manifest");
  }
  if (typeof manifest.stream_id !== "string" || !manifest.stream_id) {
    throw new RelayProtocolError("invalid stream_id");
  }
  if (typeof manifest.kind !== "string" || !manifest.kind) {
    throw new RelayProtocolError("invalid stream kind");
  }
  if (!Number.isInteger(manifest.total_bytes) || manifest.total_bytes < 0 || manifest.total_bytes > maxStreamBytes) {
    throw new RelayProtocolError("stream size out of bounds");
  }
  if (!Number.isInteger(manifest.chunk_bytes)
    || manifest.chunk_bytes < 1
    || manifest.chunk_bytes > DEFAULT_RELAY_LIMITS.maxChunkBytes) {
    throw new RelayProtocolError("chunk size out of bounds");
  }
  if (!Number.isInteger(manifest.chunk_count) || manifest.chunk_count < 0) {
    throw new RelayProtocolError("chunk_count out of bounds");
  }
  const expectedCount = manifest.total_bytes
    ? Math.ceil(manifest.total_bytes / manifest.chunk_bytes)
    : 0;
  if (manifest.chunk_count !== expectedCount) {
    throw new RelayProtocolError("chunk_count inconsistent with stream size");
  }
  if (typeof manifest.sha256 !== "string" || !HEX_64_RE.test(manifest.sha256)) {
    throw new RelayProtocolError("invalid stream digest");
  }
}

export class StreamAssembler {
  constructor(manifest, {
    maxStreamBytes = DEFAULT_RELAY_LIMITS.maxStreamBytes,
  } = {}) {
    validateStreamManifest(manifest, maxStreamBytes);
    this.manifest = structuredClone(manifest);
    this.nextIndex = 0;
    this.parts = [];
    this.bytes = 0;
  }

  accept(payload) {
    if (!exactKeys(payload, ["stream_id", "index", "chunk_count", "byte_count", "sha256", "data_b64"])) {
      throw new RelayProtocolError("invalid stream chunk");
    }
    if (payload.stream_id !== this.manifest.stream_id) {
      throw new RelayProtocolError("stream_id mismatch");
    }
    if (payload.chunk_count !== this.manifest.chunk_count) {
      throw new RelayProtocolError("chunk_count mismatch");
    }
    if (payload.index !== this.nextIndex) {
      throw new RelayReplayError("reordered or duplicate stream chunk");
    }
    let chunk;
    try {
      chunk = Buffer.from(String(payload.data_b64), "base64");
    } catch {
      throw new RelayProtocolError("invalid chunk base64");
    }
    if (chunk.toString("base64") !== String(payload.data_b64)) {
      throw new RelayProtocolError("invalid chunk base64");
    }
    if (payload.byte_count !== chunk.length) {
      throw new RelayProtocolError("chunk byte count mismatch");
    }
    if (payload.sha256 !== sha256Hex(chunk)) {
      throw new RelayProtocolError("chunk digest mismatch");
    }
    if (chunk.length > this.manifest.chunk_bytes) {
      throw new RelayProtocolError("chunk exceeds chunk bound");
    }
    this.parts.push(chunk);
    this.bytes += chunk.length;
    if (this.bytes > this.manifest.total_bytes) {
      throw new RelayProtocolError("stream exceeds declared size");
    }
    this.nextIndex += 1;
  }

  finish(payload) {
    if (!exactKeys(payload, ["stream_id", "chunk_count", "total_bytes", "sha256"])) {
      throw new RelayProtocolError("invalid stream end");
    }
    if (payload.stream_id !== this.manifest.stream_id) {
      throw new RelayProtocolError("stream_id mismatch");
    }
    if (payload.chunk_count !== this.manifest.chunk_count
      || this.nextIndex !== this.manifest.chunk_count) {
      throw new RelayProtocolError("stream ended before all chunks");
    }
    const data = Buffer.concat(this.parts);
    if (payload.total_bytes !== data.length || data.length !== this.manifest.total_bytes) {
      throw new RelayProtocolError("stream total byte count mismatch");
    }
    if (payload.sha256 !== this.manifest.sha256 || sha256Hex(data) !== this.manifest.sha256) {
      throw new RelayProtocolError("stream digest mismatch");
    }
    return data;
  }
}

export function assertHelloPayload(payload) {
  if (!exactKeys(payload, [
    "protocol_version",
    "hello_nonce",
    "capabilities",
    "capabilities_digest",
    "limits",
  ])) {
    throw new RelayProtocolError("invalid hello payload");
  }
  if (payload.protocol_version !== REMOTE_FRAME_VERSION) {
    throw new RelayProtocolError("hello protocol mismatch", "SCHEMA_VERSION_MISMATCH");
  }
  if (typeof payload.hello_nonce !== "string" || !REQUEST_ID_RE.test(payload.hello_nonce)) {
    throw new RelayProtocolError("invalid hello nonce");
  }
  if (!payload.capabilities || typeof payload.capabilities !== "object" || Array.isArray(payload.capabilities)) {
    throw new RelayProtocolError("invalid capability advertisement");
  }
  if (payload.capabilities_digest !== digestJson(payload.capabilities)) {
    throw new RelayProtocolError("capability digest mismatch", "CAPABILITY_DIGEST_MISMATCH");
  }
  if (!payload.limits || typeof payload.limits !== "object" || Array.isArray(payload.limits)) {
    throw new RelayProtocolError("invalid device limits");
  }
  for (const key of ["max_frame_bytes", "max_request_bytes", "max_chunk_bytes", "max_stream_bytes"]) {
    if (!Number.isInteger(payload.limits[key]) || payload.limits[key] <= 0) {
      throw new RelayProtocolError("invalid device limits");
    }
  }
  return structuredClone(payload);
}
