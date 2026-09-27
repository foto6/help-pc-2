import { createHash } from "node:crypto";

export const CHAOS_MODEL_VERSION = "pc_ops.chaos_model.v1";

export function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  const bytes = typeof value === "string" ? value : canonicalize(value);
  return createHash("sha256").update(bytes).digest("hex");
}

export function requestIdentity(request) {
  const body = structuredClone(request);
  delete body.request_sha256;
  return sha256(body);
}

export class RequestLedger {
  constructor(snapshot = null) {
    this.records = new Map(snapshot?.records ?? []);
  }
  snapshot() { return { version: CHAOS_MODEL_VERSION, records: [...this.records.entries()] }; }
  receive(request) {
    const digest = requestIdentity(request);
    const existing = this.records.get(request.id);
    if (!existing) {
      const record = { id: request.id, digest, phase: "received", sideEffects: 0, result: null };
      this.records.set(request.id, record);
      return { disposition: "accepted", record: structuredClone(record) };
    }
    if (existing.digest !== digest) return { disposition: "conflict", record: structuredClone(existing) };
    return { disposition: "duplicate", record: structuredClone(existing) };
  }
  transition(id, phase, patch = {}) {
    const current = this.records.get(id);
    if (!current) throw new Error(`missing request ${id}`);
    Object.assign(current, patch, { phase });
    return structuredClone(current);
  }
  recover(id, outcome = "unknown") {
    const current = this.records.get(id);
    if (!current) throw new Error(`missing request ${id}`);
    if (["dispatch_started", "effect_observed", "result_durable", "published"].includes(current.phase)) {
      if (outcome === "not_started" && current.phase === "dispatch_started") return "redispatch_once";
      return "reconcile_only";
    }
    return "dispatch_once";
  }
  dispatch(id) {
    const current = this.records.get(id);
    if (!current) throw new Error(`missing request ${id}`);
    if (current.sideEffects > 0 || ["effect_observed", "result_durable", "published"].includes(current.phase)) throw new Error("duplicate side effect");
    current.phase = "dispatch_started";
    current.sideEffects += 1;
    return structuredClone(current);
  }
}

export class CursorOracle {
  constructor({ streamId, epoch = 1, offset = 0 } = {}) { this.streamId = streamId; this.epoch = epoch; this.offset = offset; }
  token() { return `${this.streamId}:${this.epoch}:${this.offset}`; }
  advance(bytes) { if (!Number.isInteger(bytes) || bytes < 0) throw new TypeError("bytes"); this.offset += bytes; return this.token(); }
  rotate() { this.epoch += 1; this.offset = 0; return this.token(); }
  validate(token) {
    const [streamId, rawEpoch, rawOffset] = String(token).split(":");
    const epoch = Number(rawEpoch); const offset = Number(rawOffset);
    if (streamId !== this.streamId || epoch !== this.epoch || !Number.isInteger(offset) || offset < 0 || offset > this.offset) return "stale";
    return offset === this.offset ? "current" : "replayable";
  }
}

export class HashedFileOracle {
  constructor(text = "") { this.exists = true; this.text = text; this.generation = 1; }
  stat() { return this.exists ? { generation: this.generation, sha256: sha256(this.text), bytes: Buffer.byteLength(this.text) } : null; }
  externalWrite(text) { if (!this.exists) throw new Error("missing"); this.text = text; this.generation += 1; }
  moveAway() { this.exists = false; this.generation += 1; }
  write(text, { expectedSha256 = null, createOnly = false, overwrite = false } = {}) {
    if (createOnly && this.exists) return { ok: false, code: "ALREADY_EXISTS" };
    if (!this.exists && expectedSha256) return { ok: false, code: "EXPECTED_HASH_MISMATCH" };
    if (this.exists && expectedSha256 && this.stat().sha256 !== expectedSha256) return { ok: false, code: "EXPECTED_HASH_MISMATCH" };
    if (this.exists && !overwrite && !expectedSha256 && !createOnly) return { ok: false, code: "WRITE_POLICY_REQUIRED" };
    this.exists = true; this.text = text; this.generation += 1;
    return { ok: true, stat: this.stat() };
  }
}

export class DurableAppendOracle {
  constructor(snapshot = null) { this.lines = snapshot?.lines ?? []; this.applied = new Set(snapshot?.applied ?? []); }
  snapshot() { return { lines: [...this.lines], applied: [...this.applied] }; }
  append(operationId, line) {
    if (this.applied.has(operationId)) return { duplicate: true, lines: [...this.lines] };
    this.lines.push(line); this.applied.add(operationId);
    return { duplicate: false, lines: [...this.lines] };
  }
}

export function boundedText(text, limitBytes) {
  const input = Buffer.from(String(text), "utf8");
  return { text: input.subarray(0, limitBytes).toString("utf8"), bytes: input.length, truncated: input.length > limitBytes };
}

export function requireSemanticTarget(action) {
  if (/^(mouse|keyboard)\./.test(action.type) && action.input && ("x" in action.input || "y" in action.input) && !action.input.target) {
    return { ok: false, code: "RAW_COORDINATE_FALLBACK_FORBIDDEN" };
  }
  return { ok: true };
}


export const PROTECTED_ROOT = "E:\\manhwa";

function normalizeWindowsPathLexically(value) {
  const raw = String(value ?? "").replaceAll("/", "\\");
  const match = /^([A-Za-z]):\\(.*)$/.exec(raw);
  if (!match) return raw;
  const drive = match[1].toUpperCase();
  const parts = [];
  for (const part of match[2].split("\\")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length) parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `${drive}:\\${parts.join("\\")}`;
}

function operationPaths(operation) {
  const input = operation?.params ?? operation?.input ?? {};
  return ["path", "source", "destination", "cwd"]
    .filter((key) => typeof input[key] === "string")
    .map((key) => ({ key, value: input[key] }));
}

export function isProtectedPath(value) {
  const normalized = normalizeWindowsPathLexically(value).toLowerCase();
  const root = PROTECTED_ROOT.toLowerCase();
  return normalized === root || normalized.startsWith(`${root}\\`);
}

export function guardProtectedOperation(operation, hooks = {}) {
  const paths = operationPaths(operation);
  for (const item of paths) {
    if (isProtectedPath(item.value)) {
      return {
        ok: false,
        code: "PC_OPS_PROTECTED_PATH",
        field: item.key,
        normalized: normalizeWindowsPathLexically(item.value),
      };
    }
  }
  for (const item of paths) hooks.onPathAccess?.(item.key, item.value);
  hooks.onDispatch?.(operation);
  return { ok: true };
}

export class NativeCutoverOracle {
  constructor(snapshot = null) {
    this.records = new Map(snapshot?.records ?? []);
  }

  snapshot() {
    return {
      version: "pc_ops.native_cutover_chaos.v1",
      records: [...this.records.entries()].map(([id, record]) => [id, structuredClone(record)]),
    };
  }

  receive(request) {
    const digest = requestIdentity(request);
    const existing = this.records.get(request.id);
    if (existing) {
      return {
        disposition: existing.digest === digest ? "duplicate" : "conflict",
        record: structuredClone(existing),
      };
    }
    const record = {
      id: request.id,
      digest,
      phase: "received",
      dispatchAttempts: 0,
      effectCount: 0,
      contextDigest: null,
      observationEpoch: null,
      retryAuthorized: false,
      resultDurable: false,
      resultLost: false,
    };
    this.records.set(request.id, record);
    return { disposition: "accepted", record: structuredClone(record) };
  }

  bind(id, { contextDigest, observationEpoch }) {
    const record = this.#get(id);
    if (!contextDigest || !observationEpoch) throw new Error("binding requires contextDigest and observationEpoch");
    record.contextDigest = contextDigest;
    record.observationEpoch = observationEpoch;
    if (record.phase === "received" || record.phase === "ready") record.phase = "ready";
    return structuredClone(record);
  }

  dispatch(id, { contextDigest, observationEpoch }) {
    const record = this.#get(id);
    if (record.contextDigest !== contextDigest) {
      return { disposition: "fail_closed", code: "STALE_CONTEXT_BINDING", record: structuredClone(record) };
    }
    if (record.observationEpoch !== observationEpoch) {
      return { disposition: "fail_closed", code: "STALE_OBSERVATION_EPOCH", record: structuredClone(record) };
    }
    if (!["ready", "received"].includes(record.phase) && !record.retryAuthorized) {
      return { disposition: "fail_closed", code: "RECONCILIATION_REQUIRED", record: structuredClone(record) };
    }
    record.dispatchAttempts += 1;
    record.retryAuthorized = false;
    record.phase = "dispatch_started";
    return { disposition: "dispatched", record: structuredClone(record) };
  }

  observeEffect(id) {
    const record = this.#get(id);
    if (record.phase !== "dispatch_started") throw new Error("effect without dispatch");
    if (record.effectCount >= 1) throw new Error("duplicate side effect");
    record.effectCount += 1;
    record.phase = "effect_observed";
    return structuredClone(record);
  }

  loseResult(id) {
    const record = this.#get(id);
    if (record.effectCount !== 1) throw new Error("result loss requires observed effect");
    record.resultLost = true;
    record.resultDurable = false;
    record.phase = "effect_observed";
    return structuredClone(record);
  }

  durableResult(id) {
    const record = this.#get(id);
    if (record.effectCount > 1) throw new Error("duplicate side effect");
    record.resultDurable = true;
    record.resultLost = false;
    record.phase = "result_durable";
    return structuredClone(record);
  }

  reconcile(id, outcome) {
    const record = this.#get(id);
    if (outcome === "not_started" && record.phase === "dispatch_started" && record.effectCount === 0) {
      record.phase = "ready";
      record.retryAuthorized = true;
      return "redispatch_once";
    }
    if (["unknown", "completed"].includes(outcome) && ["dispatch_started", "effect_observed", "result_durable"].includes(record.phase)) {
      return "reconcile_only";
    }
    if (outcome === "completed" && record.effectCount === 1) return "reconcile_only";
    return "fail_closed";
  }

  verificationDecision(id, currentObservationEpoch) {
    const record = this.#get(id);
    if (record.effectCount === 1 && record.observationEpoch !== currentObservationEpoch) {
      return "recapture_reverify_only";
    }
    return record.effectCount === 1 ? "verify_only" : "fail_closed";
  }

  get(id) {
    return structuredClone(this.#get(id));
  }

  #get(id) {
    const record = this.records.get(id);
    if (!record) throw new Error(`missing request ${id}`);
    return record;
  }
}

export class ManagedOperationOracle {
  constructor(snapshot = null) {
    this.operations = new Map(snapshot?.operations ?? []);
    this.startDispatches = snapshot?.startDispatches ?? 0;
  }

  snapshot() {
    return {
      version: "pc_ops.managed_operation_chaos.v1",
      startDispatches: this.startDispatches,
      operations: [...this.operations.entries()].map(([id, value]) => [id, structuredClone(value)]),
    };
  }

  begin(operationId, kind) {
    const existing = this.operations.get(operationId);
    if (existing) return { disposition: "existing", operation: structuredClone(existing) };
    const operation = {
      operationId,
      kind,
      actionId: `start:${operationId}`,
      remoteHandle: null,
      state: "start_pending",
    };
    this.operations.set(operationId, operation);
    return { disposition: "created", operation: structuredClone(operation) };
  }

  dispatchStart(operationId) {
    const operation = this.#get(operationId);
    if (operation.state !== "start_pending") return { disposition: "fail_closed", code: "START_ALREADY_DISPATCHED" };
    this.startDispatches += 1;
    operation.state = "start_dispatched";
    return { disposition: "dispatched", operation: structuredClone(operation) };
  }

  bindHandle(operationId, remoteHandle) {
    const operation = this.#get(operationId);
    if (!remoteHandle) throw new Error("remoteHandle required");
    operation.remoteHandle = remoteHandle;
    operation.state = "attached";
    return structuredClone(operation);
  }

  reconnect(operationId, observedHandle) {
    const operation = this.#get(operationId);
    if (!operation.remoteHandle) return { disposition: "fail_closed", code: "REMOTE_HANDLE_UNPROVEN" };
    if (operation.remoteHandle !== observedHandle) return { disposition: "fail_closed", code: "REMOTE_HANDLE_MISMATCH" };
    return { disposition: "reconnected", operation: structuredClone(operation) };
  }

  get(operationId) {
    return structuredClone(this.#get(operationId));
  }

  #get(operationId) {
    const operation = this.operations.get(operationId);
    if (!operation) throw new Error(`missing operation ${operationId}`);
    return operation;
  }
}
