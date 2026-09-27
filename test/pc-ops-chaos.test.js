import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CursorOracle,
  DurableAppendOracle,
  HashedFileOracle,
  ManagedOperationOracle,
  NativeCutoverOracle,
  RequestLedger,
  boundedText,
  canonicalize,
  guardProtectedOperation,
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
  assert.equal(p.relay.head, "e083eea1b4d36a41ee74c11b7ec00f4062b38c39");
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


function nativeRequest(id = "native-1", extra = {}) {
  return {
    version: "pc_executor.ops.v1",
    id,
    action: "fs.write_text",
    params: { path: "E:\\work\\state.json", text: "{}" },
    ...extra,
  };
}

function boundNative(id, extra = {}) {
  const oracle = new NativeCutoverOracle();
  const raw = nativeRequest(id, extra);
  assert.equal(oracle.receive(raw).disposition, "accepted");
  oracle.bind(id, { contextDigest: "ctx-a", observationEpoch: "epoch-1" });
  return { oracle, raw };
}

test("native MCP disconnect after dispatch never blind replays uncertain effect", () => {
  const { oracle, raw } = boundNative("mcp-disconnect");
  assert.equal(
    oracle.dispatch(raw.id, { contextDigest: "ctx-a", observationEpoch: "epoch-1" }).disposition,
    "dispatched",
  );
  oracle.observeEffect(raw.id);

  // Disconnect destroys only the live transport. Durable state survives.
  const afterReconnect = new NativeCutoverOracle(oracle.snapshot());
  assert.equal(afterReconnect.receive(raw).disposition, "duplicate");
  assert.equal(afterReconnect.reconcile(raw.id, "unknown"), "reconcile_only");
  assert.deepEqual(
    afterReconnect.dispatch(raw.id, { contextDigest: "ctx-a", observationEpoch: "epoch-1" }),
    {
      disposition: "fail_closed",
      code: "RECONCILIATION_REQUIRED",
      record: afterReconnect.get(raw.id),
    },
  );
  assert.equal(afterReconnect.get(raw.id).effectCount, 1);
  assert.equal(afterReconnect.get(raw.id).dispatchAttempts, 1);
});

test("Control Plane restart preserves dispatch boundary and journal unknown fails closed", () => {
  const { oracle, raw } = boundNative("cp-restart");
  oracle.dispatch(raw.id, { contextDigest: "ctx-a", observationEpoch: "epoch-1" });

  const restarted = new NativeCutoverOracle(oracle.snapshot());
  assert.equal(restarted.reconcile(raw.id, "unknown"), "reconcile_only");
  assert.equal(
    restarted.dispatch(raw.id, { contextDigest: "ctx-a", observationEpoch: "epoch-1" }).code,
    "RECONCILIATION_REQUIRED",
  );
  assert.equal(restarted.get(raw.id).dispatchAttempts, 1);
  assert.equal(restarted.get(raw.id).effectCount, 0);
});

test("Executor restart permits one bounded redispatch only after durable not_started evidence", () => {
  const { oracle, raw } = boundNative("executor-restart");
  oracle.dispatch(raw.id, { contextDigest: "ctx-a", observationEpoch: "epoch-1" });

  const restarted = new NativeCutoverOracle(oracle.snapshot());
  assert.equal(restarted.reconcile(raw.id, "not_started"), "redispatch_once");
  assert.equal(
    restarted.dispatch(raw.id, { contextDigest: "ctx-a", observationEpoch: "epoch-1" }).disposition,
    "dispatched",
  );
  restarted.observeEffect(raw.id);
  assert.equal(restarted.get(raw.id).dispatchAttempts, 2);
  assert.equal(restarted.get(raw.id).effectCount, 1);
  assert.equal(
    restarted.dispatch(raw.id, { contextDigest: "ctx-a", observationEpoch: "epoch-1" }).code,
    "RECONCILIATION_REQUIRED",
  );
});

test("stale execution context binding rejects before side-effect dispatch", () => {
  const { oracle, raw } = boundNative("stale-context");
  const rejected = oracle.dispatch(raw.id, { contextDigest: "ctx-replaced", observationEpoch: "epoch-1" });
  assert.equal(rejected.disposition, "fail_closed");
  assert.equal(rejected.code, "STALE_CONTEXT_BINDING");
  assert.equal(oracle.get(raw.id).dispatchAttempts, 0);
  assert.equal(oracle.get(raw.id).effectCount, 0);
});

test("native duplicate request id is idempotent only for identical canonical payload", () => {
  const oracle = new NativeCutoverOracle();
  const first = nativeRequest("native-dup");
  const same = structuredClone(first);
  const changed = nativeRequest("native-dup", { params: { path: "E:\\work\\other.json", text: "{}" } });

  assert.equal(oracle.receive(first).disposition, "accepted");
  assert.equal(oracle.receive(same).disposition, "duplicate");
  assert.equal(oracle.receive(changed).disposition, "conflict");
  assert.equal(oracle.get(first.id).dispatchAttempts, 0);
});

test("journal unknown never grants replay authority", () => {
  const { oracle, raw } = boundNative("journal-unknown");
  oracle.dispatch(raw.id, { contextDigest: "ctx-a", observationEpoch: "epoch-1" });
  assert.equal(oracle.reconcile(raw.id, "unknown"), "reconcile_only");
  assert.equal(
    oracle.dispatch(raw.id, { contextDigest: "ctx-a", observationEpoch: "epoch-1" }).code,
    "RECONCILIATION_REQUIRED",
  );
  assert.equal(oracle.get(raw.id).dispatchAttempts, 1);
});

test("result lost after side effect reconciles completed without a second effect", () => {
  const { oracle, raw } = boundNative("lost-result");
  oracle.dispatch(raw.id, { contextDigest: "ctx-a", observationEpoch: "epoch-1" });
  oracle.observeEffect(raw.id);
  oracle.loseResult(raw.id);

  const restarted = new NativeCutoverOracle(oracle.snapshot());
  assert.equal(restarted.reconcile(raw.id, "completed"), "reconcile_only");
  assert.equal(
    restarted.dispatch(raw.id, { contextDigest: "ctx-a", observationEpoch: "epoch-1" }).code,
    "RECONCILIATION_REQUIRED",
  );
  assert.equal(restarted.get(raw.id).effectCount, 1);
  assert.equal(restarted.get(raw.id).resultLost, true);
});

for (const kind of ["process", "shell.session"]) {
  test(`managed ${kind} reconnect reuses durable operation and remote handle`, () => {
    const operations = new ManagedOperationOracle();
    const operationId = `${kind}-build-1`;
    assert.equal(operations.begin(operationId, kind).disposition, "created");
    assert.equal(operations.dispatchStart(operationId).disposition, "dispatched");
    operations.bindHandle(operationId, `${kind}:remote-1`);

    const restarted = new ManagedOperationOracle(operations.snapshot());
    const duplicateStart = restarted.begin(operationId, kind);
    assert.equal(duplicateStart.disposition, "existing");
    assert.equal(duplicateStart.operation.actionId, `start:${operationId}`);
    assert.equal(restarted.reconnect(operationId, `${kind}:remote-1`).disposition, "reconnected");
    assert.equal(restarted.startDispatches, 1);
    assert.equal(restarted.dispatchStart(operationId).code, "START_ALREADY_DISPATCHED");
  });
}

test("managed reconnect fails closed when remote handle is unknown or replaced", () => {
  const operations = new ManagedOperationOracle();
  operations.begin("proc-unknown", "process");
  operations.dispatchStart("proc-unknown");
  assert.equal(operations.reconnect("proc-unknown", "process:remote-1").code, "REMOTE_HANDLE_UNPROVEN");

  operations.bindHandle("proc-unknown", "process:remote-1");
  assert.equal(operations.reconnect("proc-unknown", "process:remote-2").code, "REMOTE_HANDLE_MISMATCH");
  assert.equal(operations.startDispatches, 1);
});

test("UI observation epoch change before dispatch fails closed", () => {
  const { oracle, raw } = boundNative("epoch-before");
  const rejected = oracle.dispatch(raw.id, { contextDigest: "ctx-a", observationEpoch: "epoch-2" });
  assert.equal(rejected.code, "STALE_OBSERVATION_EPOCH");
  assert.equal(oracle.get(raw.id).dispatchAttempts, 0);
  assert.equal(oracle.get(raw.id).effectCount, 0);
});

test("UI observation epoch change after side effect authorizes reverify only", () => {
  const { oracle, raw } = boundNative("epoch-after");
  oracle.dispatch(raw.id, { contextDigest: "ctx-a", observationEpoch: "epoch-1" });
  oracle.observeEffect(raw.id);
  assert.equal(oracle.verificationDecision(raw.id, "epoch-2"), "recapture_reverify_only");
  assert.equal(
    oracle.dispatch(raw.id, { contextDigest: "ctx-a", observationEpoch: "epoch-2" }).code,
    "STALE_OBSERVATION_EPOCH",
  );
  assert.equal(oracle.get(raw.id).effectCount, 1);
});

test("E:\\manhwa protected root and descendants reject before dispatch and are never accessed", () => {
  const candidates = [
    "E:\\manhwa",
    "E:\\manhwa\\chapter-1",
    "e:/MANHWA/secret.txt",
    "E:\\work\\..\\manhwa\\blocked.txt",
  ];
  for (const path of candidates) {
    const accessed = [];
    let dispatches = 0;
    const result = guardProtectedOperation(
      { action: "fs.read_text", params: { path } },
      {
        onPathAccess: (...args) => accessed.push(args),
        onDispatch: () => { dispatches += 1; },
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, "PC_OPS_PROTECTED_PATH");
    assert.deepEqual(accessed, []);
    assert.equal(dispatches, 0);
  }
});

test("protected cwd is rejected before process dispatch and no path access hook runs", () => {
  const accessed = [];
  let dispatches = 0;
  const result = guardProtectedOperation(
    { action: "process.start", params: { argv: ["git", "status"], cwd: "E:\\manhwa\\repo" } },
    {
      onPathAccess: (...args) => accessed.push(args),
      onDispatch: () => { dispatches += 1; },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "PC_OPS_PROTECTED_PATH");
  assert.deepEqual(accessed, []);
  assert.equal(dispatches, 0);
});
