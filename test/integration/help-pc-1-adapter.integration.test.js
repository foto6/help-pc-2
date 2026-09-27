import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ControlPlane } from "../../src/control-plane.js";
import { HelpPc1Adapter } from "../../src/adapters.js";

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/grounded_target_v1.json", import.meta.url)), "utf8"),
);

function ids() {
  let n = 0;
  return () => `id-${++n}`;
}

function executorSuccess(request) {
  return {
    request_id: request.request_id,
    action: request.action,
    ok: true,
    status: request.dry_run ? "dry_run" : "completed",
    started_at: "2026-09-27T00:00:00Z",
    finished_at: "2026-09-27T00:00:01Z",
    data: {},
    error: null,
    dry_run: request.dry_run,
  };
}

test("vision.target.invoke maps to exact Executor envelope and defaults dry_run true", async () => {
  const calls = [];
  const adapter = new HelpPc1Adapter({
    invoke: async (request, context) => {
      calls.push({ request, context });
      return executorSuccess(request);
    },
  });
  const cp = new ControlPlane({ providers: [adapter], idFactory: ids() });
  const session = cp.createSession({ desktopId: "desktop-A" });
  const action = cp.enqueueAction(session.id, {
    provider: "help-pc-1",
    type: "vision.target.invoke",
    input: { target: fixture },
  });

  const finished = await cp.processNext();

  assert.deepEqual(calls[0].request, {
    request_id: action.id,
    action: "vision.target.invoke",
    params: { target: fixture },
    dry_run: true,
  });
  assert.equal(calls[0].context.attempt, 1);
  assert.ok(calls[0].context.signal instanceof AbortSignal);
  assert.equal(finished.status, "succeeded");
  assert.equal(finished.result.ok, true);
});

test("action payload cannot override adapter dry_run configuration", async () => {
  let envelope;
  const adapter = new HelpPc1Adapter({
    invoke: async (request) => {
      envelope = request;
      return executorSuccess(request);
    },
  });
  const cp = new ControlPlane({ providers: [adapter], idFactory: ids() });
  const session = cp.createSession({ desktopId: "desktop-A" });
  cp.enqueueAction(session.id, {
    provider: "help-pc-1",
    type: "vision.target.invoke",
    input: { target: fixture, dry_run: false },
  });
  await cp.processNext();

  assert.equal(envelope.dry_run, true);
  assert.equal(envelope.params.dry_run, false);
});

test("Executor blocked result fails once and is never retried", async () => {
  let calls = 0;
  const adapter = new HelpPc1Adapter({
    invoke: async (request) => {
      calls += 1;
      return {
        request_id: request.request_id,
        action: request.action,
        ok: false,
        status: "blocked",
        error: "vision target is not actionable through UIA",
        dry_run: request.dry_run,
      };
    },
  });
  const cp = new ControlPlane({ providers: [adapter], idFactory: ids() });
  const session = cp.createSession({ desktopId: "desktop-A" });
  const action = cp.enqueueAction(session.id, {
    provider: "help-pc-1",
    type: "vision.target.invoke",
    input: { target: fixture },
    maxAttempts: 3,
  });

  const finished = await cp.processNext();

  assert.equal(finished.status, "failed");
  assert.equal(finished.attempts, 1);
  assert.equal(finished.error.code, "EXECUTOR_BLOCKED");
  assert.equal(calls, 1);
  assert.equal(await cp.processNext(), null);
  assert.equal(cp.getAction(action.id).attempts, 1);
});

test("malformed Executor result fails closed without retry", async () => {
  let calls = 0;
  const adapter = new HelpPc1Adapter({ invoke: async () => (calls += 1, { ok: true }) });
  const cp = new ControlPlane({ providers: [adapter], idFactory: ids() });
  const session = cp.createSession({ desktopId: "desktop-A" });
  cp.enqueueAction(session.id, {
    provider: "help-pc-1",
    type: "vision.target.invoke",
    input: { target: fixture },
    maxAttempts: 3,
  });

  const finished = await cp.processNext();

  assert.equal(finished.status, "failed");
  assert.equal(finished.attempts, 1);
  assert.equal(finished.error.code, "EXECUTOR_MALFORMED_RESULT");
  assert.equal(calls, 1);
});

test("abort/cancel remains cancelled and is not retried", async () => {
  let started;
  let calls = 0;
  const startedPromise = new Promise((resolve) => {
    started = resolve;
  });
  const adapter = new HelpPc1Adapter({
    invoke: async (_request, { signal }) => {
      calls += 1;
      started();
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
      });
    },
  });
  const cp = new ControlPlane({ providers: [adapter], idFactory: ids() });
  const session = cp.createSession({ desktopId: "desktop-A" });
  const action = cp.enqueueAction(session.id, {
    provider: "help-pc-1",
    type: "vision.target.invoke",
    input: { target: fixture },
    maxAttempts: 3,
  });

  const processing = cp.processNext();
  await startedPromise;
  cp.cancelAction(action.id, "operator_stop");
  const finished = await processing;

  assert.equal(finished.status, "cancelled");
  assert.equal(finished.attempts, 1);
  assert.equal(finished.error, null);
  assert.equal(calls, 1);
  assert.equal(await cp.processNext(), null);
});
