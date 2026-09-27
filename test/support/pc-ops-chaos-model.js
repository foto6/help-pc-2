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
