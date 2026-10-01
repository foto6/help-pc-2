import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { ControlPlane, FunctionProvider } from "../src/index.js";

function deterministicIds() {
  let value = 0;
  return () => `r23-soak-${++value}`;
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

test("R23 >=1000 mixed-request soak stays bounded and recovers stalls/restarts without replay", async () => {
  const total = 1_200;
  const executionCounts = new Map();
  const sideEffectCounts = new Map();
  let safeReadRetries = 0;
  let unknownInjected = 0;
  let evidenceReads = 0;
  let restarts = 0;
  const latencies = [];
  const recoveryLatencies = [];
  let maxQueueDepth = 0;

  const provider = new FunctionProvider("synthetic-r23", async (request) => {
    const index = request.input.index;
    const count = (executionCounts.get(request.requestId) ?? 0) + 1;
    executionCounts.set(request.requestId, count);
    if (request.tool === "mouse.move") {
      sideEffectCounts.set(request.requestId,
        (sideEffectCounts.get(request.requestId) ?? 0) + 1);
      if (index % 300 === 0) {
        unknownInjected += 1;
        const error = new Error("synthetic post-dispatch acknowledgement loss");
        error.code = "SYNTHETIC_UNKNOWN";
        error.category = "uncertain_outcome";
        error.retryable = false;
        error.dispatchState = "unknown";
        error.outcomeUncertain = true;
        throw error;
      }
      return { ok: true, index, mutation: "synthetic-only" };
    }
    if (index % 97 === 0 && count === 1) {
      safeReadRetries += 1;
      const error = new Error("synthetic read-only pre-dispatch stall");
      error.code = "SYNTHETIC_READ_STALL";
      error.category = "transient";
      error.retryable = true;
      error.dispatchState = "not_dispatched";
      error.outcomeUncertain = false;
      throw error;
    }
    return { ok: true, index, observed: true };
  }, {
    readEvidence: async (request) => {
      evidenceReads += 1;
      return {
        outcome: "succeeded",
        source: "synthetic-r23-journal",
        requestId: request.requestId,
        result: { ok: true, reconciled: true },
      };
    },
  });

  const idFactory = deterministicIds();
  let cp = new ControlPlane({ providers: [provider], idFactory });
  const session = cp.createSession({ desktopId: "r23-soak-desktop" });
  const initialHeap = process.memoryUsage().heapUsed;
  const initialHandles = process._getActiveHandles?.().length ?? 0;
  const initialRequests = process._getActiveRequests?.().length ?? 0;

  for (let index = 1; index <= total; index += 1) {
    const sideEffect = index % 25 === 0;
    const requestId = `soak-request-${index}`;
    const started = performance.now();
    const action = cp.enqueueAction(session.id, {
      provider: "synthetic-r23",
      type: sideEffect ? "mouse.move" : "screen.read",
      permission: sideEffect ? "desktop.control" : "desktop.observe",
      input: { index },
      idempotencyKey: requestId,
      correlationId: requestId,
      maxAttempts: 2,
      maxReconciliationAttempts: 2,
      metadata: { effect: sideEffect ? "side_effect" : "read_only" },
    });
    maxQueueDepth = Math.max(maxQueueDepth, cp.snapshot().queue.length);

    for (let tick = 0; tick < 5; tick += 1) {
      const before = performance.now();
      const result = await cp.processNext({ workerId: "r23-soak-worker" });
      if (result?.reconciliationAttempts > 0) {
        recoveryLatencies.push(performance.now() - before);
      }
      const status = cp.getAction(action.id).status;
      if (["succeeded", "failed", "blocked", "cancelled"].includes(status)) break;
    }

    const terminal = cp.getAction(action.id);
    assert.equal(terminal.status, "succeeded", requestId);
    latencies.push(performance.now() - started);

    if (index % 250 === 0 && index < total) {
      const snapshot = cp.snapshot();
      assert.equal(snapshot.queue.length, 0);
      cp = new ControlPlane({
        providers: [provider],
        snapshot,
        idFactory,
        recoverOnStart: true,
      });
      restarts += 1;
      assert.equal(cp.listSessions().filter((item) => item.status === "active").length, 1);
    }
  }

  const finalSnapshot = cp.snapshot();
  const finalHeap = process.memoryUsage().heapUsed;
  const finalHandles = process._getActiveHandles?.().length ?? initialHandles;
  const finalRequests = process._getActiveRequests?.().length ?? initialRequests;
  const heapGrowth = Math.max(0, finalHeap - initialHeap);
  const handleGrowth = Math.max(0, finalHandles - initialHandles);
  const requestGrowth = Math.max(0, finalRequests - initialRequests);

  assert.equal(finalSnapshot.queue.length, 0);
  assert.equal(maxQueueDepth, 1);
  assert.equal(finalSnapshot.actions.length, total);
  assert.equal(restarts, 4);
  assert.ok(safeReadRetries >= 10);
  assert.ok(unknownInjected >= 2);
  assert.equal(evidenceReads, unknownInjected);
  assert.ok(heapGrowth < 96 * 1024 * 1024,
    `heap growth exceeded soak bound: ${heapGrowth}`);
  assert.ok(handleGrowth <= 5, `active handle growth exceeded bound: ${handleGrowth}`);
  assert.ok(requestGrowth <= 5, `active request growth exceeded bound: ${requestGrowth}`);

  for (const [requestId, count] of sideEffectCounts) {
    assert.equal(count, 1, `side effect replayed: ${requestId}`);
  }

  const evidence = {
    contract_version: "pc.native.r23.soak_evidence.v1",
    requests: total,
    read_only_requests: total - Math.floor(total / 25),
    synthetic_side_effect_requests: Math.floor(total / 25),
    injected_safe_read_stalls: safeReadRetries,
    injected_unknown_side_effects: unknownInjected,
    journal_reconciliations: evidenceReads,
    synthetic_restarts: restarts,
    max_queue_depth: maxQueueDepth,
    final_queue_depth: finalSnapshot.queue.length,
    retained_action_records: finalSnapshot.actions.length,
    elapsed_sum_ms: Math.round(latencies.reduce((sum, value) => sum + value, 0) * 1000) / 1000,
    p50_request_ms: Math.round(percentile(latencies, 0.50) * 1000) / 1000,
    p95_request_ms: Math.round(percentile(latencies, 0.95) * 1000) / 1000,
    max_reconciliation_tick_ms: Math.round(Math.max(0, ...recoveryLatencies) * 1000) / 1000,
    heap_growth_bytes: heapGrowth,
    active_handle_growth: handleGrowth,
    active_request_growth: requestGrowth,
    side_effect_max_execution_count: Math.max(0, ...sideEffectCounts.values()),
    automatic_replay: false,
  };
  console.log("R23_SOAK_EVIDENCE " + JSON.stringify(evidence));
});
