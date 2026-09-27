import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { normalizeCredential } from "./native-relay-protocol.js";

const STORE_VERSION = 1;
const DEVICE_ID_RE = /^[A-Za-z0-9._:-]{1,120}$/;
const ACTIVE_DELIVERY = new Set(["dispatched", "streaming"]);

export class RelayStateError extends Error {
  constructor(message, code = "RELAY_STATE_ERROR") {
    super(message);
    this.name = "RelayStateError";
    this.code = code;
  }
}

export class JsonRelayStateStore {
  constructor(path) {
    if (typeof path !== "string" || !path) throw new TypeError("state path is required");
    this.path = path;
  }

  load() {
    if (!existsSync(this.path)) return null;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8"));
    } catch (error) {
      throw new RelayStateError(
        `Relay state is corrupted: ${error.message}`,
        "RELAY_STATE_CORRUPTED",
      );
    }
    if (parsed?.version !== STORE_VERSION
      || !Array.isArray(parsed.devices)
      || !Array.isArray(parsed.deliveries)) {
      throw new RelayStateError("Relay state schema is invalid.", "RELAY_STATE_CORRUPTED");
    }
    return parsed;
  }

  save(snapshot) {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(temp, `${JSON.stringify(snapshot, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      renameSync(temp, this.path);
    } catch (error) {
      try { unlinkSync(temp); } catch {}
      throw error;
    }
  }
}

function defaultState() {
  return { version: STORE_VERSION, devices: [], deliveries: [] };
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function redactSensitive(value) {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (/(secret|token|password|credential|authorization|auth)/i.test(key)) {
      result[key] = "[REDACTED]";
    } else {
      result[key] = redactSensitive(item);
    }
  }
  return result;
}

function encodeSecret(secret) {
  return Buffer.from(secret).toString("base64");
}

function decodeCredential(value) {
  return normalizeCredential({
    generation: value.generation,
    secret: Buffer.from(value.secret_b64, "base64"),
  });
}

function publicDevice(record, online = null) {
  return {
    device_id: record.deviceId,
    credential_generation: record.currentCredential.generation,
    status: record.status,
    online,
    last_session_epoch: record.lastSessionEpoch ?? null,
    last_seen_at_ms: record.lastSeenAtMs ?? null,
    capabilities_digest: record.capabilitiesDigest ?? null,
    capabilities: redactSensitive(clone(record.capabilities ?? null)),
    limits: clone(record.limits ?? null),
    previous_generation_expires_at_ms: record.previousCredential?.validUntilMs ?? null,
    metadata: redactSensitive(clone(record.metadata ?? {})),
  };
}

function publicDelivery(record) {
  return {
    delivery_id: record.deliveryId,
    request_id: record.requestId,
    request_version: record.requestVersion,
    semantics: record.semantics,
    device_id: record.deviceId,
    status: record.status,
    session_epoch: record.sessionEpoch ?? null,
    created_at_ms: record.createdAtMs,
    updated_at_ms: record.updatedAtMs,
    result: clone(record.result ?? null),
    error: clone(record.error ?? null),
    reconciliation_reason: record.reconciliationReason ?? null,
    automatic_replay: false,
  };
}

export class NativeRelayState {
  constructor({
    store = null,
    maxDevices = 256,
    maxDeliveries = 4096,
    clock = Date.now,
  } = {}) {
    if (!Number.isInteger(maxDevices) || maxDevices < 1) {
      throw new TypeError("maxDevices must be a positive integer");
    }
    if (!Number.isInteger(maxDeliveries) || maxDeliveries < 1) {
      throw new TypeError("maxDeliveries must be a positive integer");
    }
    this.store = store;
    this.maxDevices = maxDevices;
    this.maxDeliveries = maxDeliveries;
    this.clock = clock;
    this.state = store?.load() ?? defaultState();
    this.#normalizeAfterRestart();
  }

  #persist() {
    this.store?.save(this.state);
  }

  #normalizeAfterRestart() {
    let changed = false;
    for (const delivery of this.state.deliveries) {
      if (!ACTIVE_DELIVERY.has(delivery.status)) continue;
      delivery.updatedAtMs = this.clock();
      if (delivery.semantics === "side_effecting") {
        delivery.status = "reconciliation_required";
        delivery.reconciliationReason = "relay_restart_after_dispatch";
        delivery.result = {
          status: "UNKNOWN_RECONCILE",
          automatic_replay: false,
        };
      } else {
        delivery.status = "failed";
        delivery.error = {
          code: "RESULT_LOST_AFTER_RELAY_RESTART",
          message: "Read-only delivery result was lost across relay restart.",
          retryable: true,
        };
      }
      changed = true;
    }
    if (changed) this.#persist();
  }

  #device(deviceId) {
    const record = this.state.devices.find((item) => item.deviceId === deviceId);
    if (!record) throw new RelayStateError("Unknown device.", "DEVICE_NOT_FOUND");
    return record;
  }

  registerDevice({
    deviceId,
    generation = 1,
    secret,
    metadata = {},
  }) {
    if (typeof deviceId !== "string" || !DEVICE_ID_RE.test(deviceId)) {
      throw new RelayStateError("Invalid device ID.", "INVALID_DEVICE_ID");
    }
    if (this.state.devices.some((item) => item.deviceId === deviceId)) {
      throw new RelayStateError("Device already exists.", "DEVICE_ALREADY_EXISTS");
    }
    if (this.state.devices.length >= this.maxDevices) {
      throw new RelayStateError("Device registry quota reached.", "DEVICE_QUOTA_EXCEEDED");
    }
    const credential = normalizeCredential({ generation, secret });
    const now = this.clock();
    const record = {
      deviceId,
      status: "active",
      currentCredential: {
        generation: credential.generation,
        secret_b64: encodeSecret(credential.secret),
      },
      previousCredential: null,
      lastSessionEpoch: null,
      recentSessionEpochs: [],
      lastSeenAtMs: null,
      capabilitiesDigest: null,
      capabilities: null,
      limits: null,
      metadata: clone(metadata),
      createdAtMs: now,
      updatedAtMs: now,
    };
    this.state.devices.push(record);
    this.#persist();
    return publicDevice(record, false);
  }

  credentialCandidates(deviceId) {
    const record = this.#device(deviceId);
    if (record.status === "revoked") {
      throw new RelayStateError("Device credential is revoked.", "DEVICE_REVOKED");
    }
    const now = this.clock();
    if (record.previousCredential && record.previousCredential.validUntilMs <= now) {
      record.previousCredential = null;
      record.updatedAtMs = now;
      this.#persist();
    }
    const candidates = [decodeCredential(record.currentCredential)];
    if (record.previousCredential) {
      candidates.push(decodeCredential(record.previousCredential));
    }
    return candidates;
  }

  currentCredential(deviceId) {
    const record = this.#device(deviceId);
    if (record.status === "revoked") {
      throw new RelayStateError("Device credential is revoked.", "DEVICE_REVOKED");
    }
    return decodeCredential(record.currentCredential);
  }

  beginSession({
    deviceId,
    sessionEpoch,
    capabilitiesDigest,
    capabilities,
    limits,
  }) {
    const record = this.#device(deviceId);
    if (record.status === "revoked") {
      throw new RelayStateError("Device is revoked.", "DEVICE_REVOKED");
    }
    const recentEpochs = Array.isArray(record.recentSessionEpochs)
      ? record.recentSessionEpochs
      : record.lastSessionEpoch
        ? [record.lastSessionEpoch]
        : [];
    if (recentEpochs.includes(sessionEpoch)) {
      throw new RelayStateError(
        "Session epoch was already used.",
        "STALE_SESSION_EPOCH",
      );
    }
    const now = this.clock();
    recentEpochs.push(sessionEpoch);
    record.recentSessionEpochs = recentEpochs.slice(-16);
    record.lastSessionEpoch = sessionEpoch;
    record.lastSeenAtMs = now;
    record.capabilitiesDigest = capabilitiesDigest;
    record.capabilities = clone(capabilities);
    record.limits = clone(limits);
    record.updatedAtMs = now;
    this.#persist();
    return publicDevice(record, true);
  }

  noteSeen(deviceId) {
    const record = this.#device(deviceId);
    const now = this.clock();
    record.lastSeenAtMs = now;
    record.updatedAtMs = now;
    this.#persist();
  }

  rotateCredential({
    deviceId,
    newGeneration,
    newSecret,
    overlapMs,
  }) {
    const record = this.#device(deviceId);
    if (record.status === "revoked") {
      throw new RelayStateError("Device is revoked.", "DEVICE_REVOKED");
    }
    const next = normalizeCredential({
      generation: newGeneration,
      secret: newSecret,
    });
    if (next.generation !== record.currentCredential.generation + 1) {
      throw new RelayStateError(
        "Token generation must advance by exactly one.",
        "TOKEN_GENERATION_MISMATCH",
      );
    }
    if (!Number.isInteger(overlapMs) || overlapMs < 0 || overlapMs > 86_400_000) {
      throw new RelayStateError("Invalid credential overlap.", "INVALID_OVERLAP");
    }
    const now = this.clock();
    record.previousCredential = {
      ...record.currentCredential,
      validUntilMs: now + overlapMs,
    };
    record.currentCredential = {
      generation: next.generation,
      secret_b64: encodeSecret(next.secret),
    };
    record.updatedAtMs = now;
    this.#persist();
    return {
      device_id: deviceId,
      generation: next.generation,
      overlap_until_ms: record.previousCredential.validUntilMs,
    };
  }

  completeRotation(deviceId, generation) {
    const record = this.#device(deviceId);
    if (record.currentCredential.generation !== generation) {
      throw new RelayStateError("Unexpected rotation acknowledgement.", "TOKEN_GENERATION_MISMATCH");
    }
    record.previousCredential = null;
    record.updatedAtMs = this.clock();
    this.#persist();
    return {
      device_id: deviceId,
      generation,
      overlap_until_ms: null,
    };
  }

  revokeDevice(deviceId) {
    const record = this.#device(deviceId);
    record.status = "revoked";
    record.previousCredential = null;
    record.updatedAtMs = this.clock();
    this.#persist();
    return publicDevice(record, false);
  }

  deviceView(deviceId, online = null) {
    return publicDevice(this.#device(deviceId), online);
  }

  listDevices(onlineLookup = () => false) {
    return this.state.devices.map(
      (record) => publicDevice(record, Boolean(onlineLookup(record.deviceId))),
    );
  }

  #pruneDeliveries() {
    if (this.state.deliveries.length < this.maxDeliveries) return;
    const removable = this.state.deliveries
      .filter((item) => !ACTIVE_DELIVERY.has(item.status))
      .sort((a, b) => a.updatedAtMs - b.updatedAtMs);
    while (this.state.deliveries.length >= this.maxDeliveries && removable.length) {
      const victim = removable.shift();
      const index = this.state.deliveries.indexOf(victim);
      if (index >= 0) this.state.deliveries.splice(index, 1);
    }
    if (this.state.deliveries.length >= this.maxDeliveries) {
      throw new RelayStateError("Delivery registry quota reached.", "DELIVERY_QUOTA_EXCEEDED");
    }
  }

  createDelivery({
    deviceId,
    requestId,
    requestVersion,
    deliveryId,
    semantics,
    fingerprint,
    sessionEpoch,
  }) {
    const duplicate = this.state.deliveries.find(
      (item) => item.deliveryId === deliveryId,
    );
    if (duplicate) {
      if (duplicate.fingerprint !== fingerprint
        || duplicate.requestId !== requestId
        || duplicate.deviceId !== deviceId) {
        throw new RelayStateError(
          "delivery_id was reused for different content.",
          "DELIVERY_ID_CONFLICT",
        );
      }
      return { record: duplicate, duplicate: true };
    }
    const requestCollision = this.state.deliveries.find(
      (item) => item.requestId === requestId,
    );
    if (requestCollision) {
      throw new RelayStateError(
        "request_id is already tracked under another delivery.",
        "REQUEST_ID_CONFLICT",
      );
    }
    this.#pruneDeliveries();
    const now = this.clock();
    const record = {
      deviceId,
      requestId,
      requestVersion,
      deliveryId,
      semantics,
      fingerprint,
      sessionEpoch,
      status: "dispatched",
      createdAtMs: now,
      updatedAtMs: now,
      result: null,
      error: null,
      reconciliationReason: null,
    };
    this.state.deliveries.push(record);
    this.#persist();
    return { record, duplicate: false };
  }

  deliveryById(deliveryId) {
    return this.state.deliveries.find((item) => item.deliveryId === deliveryId) ?? null;
  }

  deliveryByRequestId(requestId) {
    return this.state.deliveries.find((item) => item.requestId === requestId) ?? null;
  }

  markStreaming(deliveryId) {
    const record = this.deliveryById(deliveryId);
    if (!record) throw new RelayStateError("Unknown delivery.", "DELIVERY_NOT_FOUND");
    record.status = "streaming";
    record.updatedAtMs = this.clock();
    this.#persist();
    return publicDelivery(record);
  }

  completeDelivery(deliveryId, result) {
    const record = this.deliveryById(deliveryId);
    if (!record) throw new RelayStateError("Unknown delivery.", "DELIVERY_NOT_FOUND");
    record.status = "completed";
    record.result = clone(result);
    record.error = null;
    record.reconciliationReason = null;
    record.updatedAtMs = this.clock();
    this.#persist();
    return publicDelivery(record);
  }

  failDelivery(deliveryId, error) {
    const record = this.deliveryById(deliveryId);
    if (!record) throw new RelayStateError("Unknown delivery.", "DELIVERY_NOT_FOUND");
    record.status = "failed";
    record.error = clone(error);
    record.updatedAtMs = this.clock();
    this.#persist();
    return publicDelivery(record);
  }

  cancelDelivery(deliveryId, reason = "cancelled_by_control") {
    const record = this.deliveryById(deliveryId);
    if (!record) throw new RelayStateError("Unknown delivery.", "DELIVERY_NOT_FOUND");
    if (!ACTIVE_DELIVERY.has(record.status)) return publicDelivery(record);
    record.updatedAtMs = this.clock();
    if (record.semantics === "side_effecting") {
      record.status = "reconciliation_required";
      record.reconciliationReason = reason;
      record.result = {
        status: "UNKNOWN_RECONCILE",
        automatic_replay: false,
      };
    } else {
      record.status = "cancelled";
      record.result = {
        status: "CANCELLED",
        automatic_replay: false,
      };
    }
    this.#persist();
    return publicDelivery(record);
  }

  requireReconciliation(deliveryId, reason, result = null) {
    const record = this.deliveryById(deliveryId);
    if (!record) throw new RelayStateError("Unknown delivery.", "DELIVERY_NOT_FOUND");
    record.status = "reconciliation_required";
    record.reconciliationReason = reason;
    record.result = clone(result ?? {
      status: "UNKNOWN_RECONCILE",
      automatic_replay: false,
    });
    record.updatedAtMs = this.clock();
    this.#persist();
    return publicDelivery(record);
  }

  deliveryView(deliveryId) {
    const record = this.deliveryById(deliveryId);
    return record ? publicDelivery(record) : null;
  }

  listDeliveries() {
    return this.state.deliveries.map(publicDelivery);
  }
}
