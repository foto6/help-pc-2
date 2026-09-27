import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CursorOracle,
  DurableAppendOracle,
  HashedFileOracle,
  RequestLedger,
  boundedText,
  canonicalize,
  requestIdentity,
  requireSemanticTarget,
  sha256,
} from "./support/pc-ops-chaos-model.js";

function request(id = "r1", extra = {}) {
  return { version: "pc_relay.request.v2", id, action: "shell.run", params: { argv: ["echo", "ok"] }, timeout_ms: 5000, ...extra };
}

const restartCases = [
  ["received", "unknown", "dispatch_once"],
  ["dispatch_started", "unknown", "reconcile_only"],
  ["dispatch_started", "completed", "reconcile_only"],
  ["dispatch_started", "not_started", "redispatch_once"],
  ["effect_observed", "unknown", "reconcile_only"],
  ["result_durable", "completed", "reconcile_only"],
  ["published", "completed", "reconcile_only"],
];

test("request identity is canonical and stable", () => {
  const a = request("same", { params: { cwd: "C:/tmp", argv: ["echo", "ok"] } });
  const b = { timeout_ms: 5000, action: "shell.run", version: "pc_relay.request.v2", params: { argv: ["echo", "ok"], cwd: "C:/tmp" }, id: "same" };
  assert.equal(requestIdentity(a), requestIdentity(b));
  assert.equal(requestIdentity(a), requestIdentity(structuredClone(a)));
});

test("duplicate request id is idempotent only for identical payload", () => {
  const ledger = new RequestLedger();
  assert.equal(ledger.receive(request("dup")).disposition, "accepted");
  assert.equal(ledger.receive(request("dup")).disposition, "duplicate");
  assert.equal(ledger.receive(request("dup", { timeout_ms: 6000 })).disposition, "conflict");
});

for (const [phase, outcome, expected] of restartCases) {
  test(`restart recovery ${phase}/${outcome} => ${expected}`, () => {
    const ledger = new RequestLedger(); const raw = request(`restart-${phase}-${outcome}`); ledger.receive(raw);
    if (phase === "dispatch_started") ledger.transition(raw.id, phase, { sideEffects: 1 });
    else if (phase !== "received") ledger.transition(raw.id, phase, { sideEffects: 1 });
    const recovered = new RequestLedger(ledger.snapshot());
    assert.equal(recovered.recover(raw.id, outcome), expected);
  });
}

test("uncertain/completed recovery never blind replays a side effect", () => {
  for (const outcome of ["unknown", "completed"]) {
    const ledger = new RequestLedger(); const raw = request(`once-${outcome}`); ledger.receive(raw); ledger.dispatch(raw.id);
    const recovered = new RequestLedger(ledger.snapshot());
    assert.equal(recovered.recover(raw.id, outcome), "reconcile_only");
    assert.throws(() => recovered.dispatch(raw.id), /duplicate side effect/);
  }
});

test("cursor is monotonic and rotation invalidates old epochs", () => {
  const cursor = new CursorOracle({ streamId: "proc-1" });
  const start = cursor.token(); const after = cursor.advance(10);
  assert.equal(cursor.validate(start), "replayable"); assert.equal(cursor.validate(after), "current");
  const rotated = cursor.rotate(); assert.equal(cursor.validate(after), "stale"); assert.equal(cursor.validate(rotated), "current");
});

test("expected hash prevents write-after-stat races and moved files fail closed", () => {
  const file = new HashedFileOracle("v1"); const first = file.stat();
  file.externalWrite("v2"); assert.deepEqual(file.write("candidate", { expectedSha256: first.sha256 }), { ok: false, code: "EXPECTED_HASH_MISMATCH" });
  const second = file.stat(); file.moveAway(); assert.deepEqual(file.write("candidate", { expectedSha256: second.sha256 }), { ok: false, code: "EXPECTED_HASH_MISMATCH" });
});

test("append operation id survives crash/restart without duplicate content", () => {
  const first = new DurableAppendOracle(); first.append("op-1", "alpha");
  const restarted = new DurableAppendOracle(first.snapshot()); const duplicate = restarted.append("op-1", "alpha");
  assert.equal(duplicate.duplicate, true); assert.deepEqual(duplicate.lines, ["alpha"]);
});

test("output bounding is deterministic", () => {
  const value = boundedText("x".repeat(1024), 64);
  assert.equal(value.bytes, 1024); assert.equal(value.truncated, true); assert.equal(Buffer.byteLength(value.text), 64);
});

test("coordinate-only fallback is rejected by the chaos oracle", () => {
  assert.deepEqual(requireSemanticTarget({ type: "mouse.click", input: { x: 10, y: 20 } }), { ok: false, code: "RAW_COORDINATE_FALLBACK_FORBIDDEN" });
  assert.deepEqual(requireSemanticTarget({ type: "vision.target.invoke", input: { target: { digest: "abc" } } }), { ok: true });
});

test("frozen producer evidence stays exact-head bound", () => {
  const p = JSON.parse(readFileSync(new URL("../conformance/pc-ops-chaos/PROVENANCE.v1.json", import.meta.url), "utf8"));
  assert.equal(p.version, "pc_ops.chaos_provenance.v1");
  assert.equal(p.control_plane.head, "f082a7e837392240788d7474123c90095891e153");
  assert.equal(p.relay.head, "fcea28ec18a7e3a72e43a62c2782b5a51414a32f");
  assert.equal(p.executor.head, "2cc1e40f792a3d74560b726a0d246c90b7f077e9");
  assert.equal(["pending_producer_artifacts", "pending_exact_head_green"].includes(p.gateway.status), true);
  for (const producer of [p.control_plane, p.relay, p.executor]) assert.equal(producer.ci.conclusion, "success");
});

test("CHAOS_MATRIX.v1 canonical digest is stable", () => {
  const matrix = JSON.parse(readFileSync(new URL("../conformance/pc-ops-chaos/CHAOS_MATRIX.v1.json", import.meta.url), "utf8"));
  const expected = matrix.matrix_sha256; const body = structuredClone(matrix); delete body.matrix_sha256;
  assert.equal(sha256(body), expected);
  assert.equal(canonicalize(body), canonicalize(JSON.parse(JSON.stringify(body))));
  assert.equal(matrix.cases.some((c) => c.status === "BLOCKED"), true);
  assert.equal(matrix.cases.some((c) => c.status === "PENDING"), true);
  assert.equal(matrix.cases.some((c) => c.status === "PASS"), true);
});
