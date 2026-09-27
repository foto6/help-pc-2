import test from "node:test";
import assert from "node:assert/strict";
import {
  ControlPlane,
  FunctionProvider,
  HelpPc1Adapter,
  Vision2Adapter,
  createRpcHandler,
  mcpToolDefinitions,
} from "../src/index.js";

function ids() {
  let n = 0;
  return () => `id-${++n}`;
}

function plane({ invoke = async () => ({ ok: true }), policy } = {}) {
  return new ControlPlane({
    providers: [new FunctionProvider("fake", invoke)],
    policy,
    idFactory: ids(),
    clock: (() => {
      let n = 0;
      return () => `2026-09-27T06:10:${String(n++).padStart(2, "0")}Z`;
    })(),
  });
}

test("desktop ownership is exclusive across sessions", () => {
  const cp = plane();
  const first = cp.createSession({ desktopId: "desktop-A" });
  assert.throws(
    () => cp.createSession({ desktopId: "desktop-A" }),
    (error) => error.code === "DESKTOP_OWNED",
  );
  cp.releaseDesktop(first.id);
  const second = cp.createSession({ desktopId: "desktop-A" });
  assert.equal(cp.snapshot().desktopOwners[0][1], second.id);
});

test("idempotency returns the original action and executes once", async () => {
  let calls = 0;
  const cp = plane({ invoke: async () => ({ calls: ++calls }) });
  const session = cp.createSession({ desktopId: "desktop-A" });
  const spec = { provider: "fake", type: "mouse.click", idempotencyKey: "click-1" };
  const first = cp.enqueueAction(session.id, spec);
  const duplicate = cp.enqueueAction(session.id, spec);
  assert.equal(duplicate.id, first.id);
  await cp.drain();
  assert.equal(calls, 1);
  assert.equal(cp.getAction(first.id).status, "succeeded");
});

test("credential and CAPTCHA automation is prohibited", () => {
  const cp = plane();
  const session = cp.createSession({ desktopId: "desktop-A" });
  assert.throws(() => cp.enqueueAction(session.id, { provider: "fake", type: "captcha.solve" }), /not supported/);
  assert.throws(() => cp.enqueueAction(session.id, { provider: "fake", type: "credential.fill" }), /not supported/);
});

test("destructive actions are disabled by default and require confirmation when enabled", async () => {
  const blocked = plane();
  const blockedSession = blocked.createSession({ desktopId: "desktop-A" });
  assert.throws(
    () => blocked.enqueueAction(blockedSession.id, { provider: "fake", type: "file.delete", destructive: true }),
    (error) => error.code === "DESTRUCTIVE_DISABLED",
  );

  const cp = plane({ policy: { permissions: ["desktop.control", "destructive"], allowDestructive: true } });
  const session = cp.createSession({ desktopId: "desktop-A", permissions: ["desktop.control", "destructive"] });
  const action = cp.enqueueAction(session.id, {
    provider: "fake",
    type: "file.delete",
    destructive: true,
    permission: "destructive",
  });
  assert.equal(action.status, "awaiting_confirmation");
  assert.equal(await cp.processNext(), null);
  cp.confirmAction(action.id, { approvedBy: "operator" });
  const finished = await cp.processNext();
  assert.equal(finished.status, "succeeded");
  assert.equal(finished.confirmedBy, "operator");
});

test("queued and running actions can be cancelled", async () => {
  let started;
  const startedPromise = new Promise((resolve) => (started = resolve));
  const cp = plane({
    invoke: (_request) =>
      new Promise((resolve, reject) => {
        started();
        _request.signal.addEventListener("abort", () => reject(_request.signal.reason ?? new Error("aborted")), { once: true });
      }),
  });
  const session = cp.createSession({ desktopId: "desktop-A" });
  const queued = cp.enqueueAction(session.id, { provider: "fake", type: "keyboard.type", resource: "keyboard" });
  cp.cancelAction(queued.id);
  assert.equal(cp.getAction(queued.id).status, "cancelled");

  const running = cp.enqueueAction(session.id, { provider: "fake", type: "mouse.move", resource: "mouse" });
  const processing = cp.processNext();
  await startedPromise;
  cp.cancelAction(running.id, "operator_stop");
  const finished = await processing;
  assert.equal(finished.status, "cancelled");
});

test("retryable failures are requeued up to maxAttempts", async () => {
  let calls = 0;
  const cp = plane({
    invoke: async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error("temporary transport failure");
        error.retryable = true;
        error.code = "TEMPORARY";
        throw error;
      }
      return { ok: true };
    },
  });
  const session = cp.createSession({ desktopId: "desktop-A" });
  const action = cp.enqueueAction(session.id, { provider: "fake", type: "screen.read", maxAttempts: 2 });
  const first = await cp.processNext();
  assert.equal(first.status, "queued");
  const second = await cp.processNext();
  assert.equal(second.status, "succeeded");
  assert.equal(second.attempts, 2);
  assert.equal(cp.getAction(action.id).result.ok, true);
});

test("resource locks prevent overlapping execution on the same resource", async () => {
  let releaseFirst;
  let call = 0;
  const cp = plane({
    invoke: async () => {
      call += 1;
      if (call === 1) await new Promise((resolve) => (releaseFirst = resolve));
      return { call };
    },
  });
  const session = cp.createSession({ desktopId: "desktop-A" });
  cp.enqueueAction(session.id, { provider: "fake", type: "mouse.move", resource: "pointer" });
  cp.enqueueAction(session.id, { provider: "fake", type: "mouse.click", resource: "pointer" });
  const first = cp.processNext();
  await Promise.resolve();
  assert.equal(await cp.processNext(), null);
  releaseFirst();
  await first;
  assert.equal((await cp.processNext()).status, "succeeded");
});

test("snapshot recovery requeues orphaned running work and clears locks", () => {
  const cp = plane();
  const session = cp.createSession({ desktopId: "desktop-A" });
  const action = cp.enqueueAction(session.id, { provider: "fake", type: "screen.read", resource: "screen" });
  const snapshot = cp.snapshot();
  snapshot.actions.find((item) => item.id === action.id).status = "running";
  snapshot.actions.find((item) => item.id === action.id).attempts = 1;
  snapshot.queue = [];
  snapshot.resourceLocks = [["screen", action.id]];

  const restored = new ControlPlane({
    providers: [new FunctionProvider("fake", async () => ({ ok: true }))],
    idFactory: ids(),
    snapshot,
  });
  const recovered = restored.recover();
  assert.equal(recovered[0].status, "queued");
  assert.equal(restored.snapshot().resourceLocks.length, 0);
  assert.deepEqual(restored.snapshot().queue, [action.id]);
});

test("audit log is append-only and ordered", async () => {
  const cp = plane();
  const session = cp.createSession({ desktopId: "desktop-A" });
  const action = cp.enqueueAction(session.id, { provider: "fake", type: "screen.read" });
  await cp.processNext();
  const audit = cp.getAuditLog();
  assert.deepEqual(audit.map((entry) => entry.sequence), [...audit.keys()].map((i) => i + 1));
  assert.ok(audit.some((entry) => entry.event === "action.succeeded" && entry.actionId === action.id));
  assert.ok(Object.isFrozen(audit[0]) === false, "read copies are mutable without affecting the stored log");
  audit[0].event = "tampered";
  assert.notEqual(cp.getAuditLog()[0].event, "tampered");
});

test("help-pc-1 and vision-2 adapters keep provider boundaries explicit", async () => {
  const calls = [];
  const help = new HelpPc1Adapter({ invoke: async (request) => (calls.push(["help", request]), { ok: true }) });
  const vision = new Vision2Adapter({ invoke: async (request) => (calls.push(["vision", request]), { seen: true }) });
  const cp = new ControlPlane({ providers: [help, vision], idFactory: ids() });
  const session = cp.createSession({ desktopId: "desktop-A" });
  cp.enqueueAction(session.id, { provider: "help-pc-1", type: "mouse.click", input: { x: 10, y: 20 } });
  cp.enqueueAction(session.id, { provider: "vision-2", type: "screen.describe", permission: "desktop.observe" });
  await cp.drain();
  assert.deepEqual(calls.map(([name]) => name), ["help", "vision"]);
  assert.equal(calls[0][1].tool, "mouse.click");
  assert.equal(calls[1][1].tool, "screen.describe");
});

test("RPC and MCP surfaces are transport-neutral", async () => {
  const cp = plane();
  const rpc = createRpcHandler(cp);
  const session = await rpc("session.create", { desktopId: "desktop-A" });
  const action = await rpc("action.enqueue", {
    sessionId: session.id,
    action: { provider: "fake", type: "screen.read", permission: "desktop.control" },
  });
  assert.equal((await rpc("action.processNext")).id, action.id);
  assert.ok(mcpToolDefinitions().some((tool) => tool.name === "action_enqueue" && tool.rpcMethod === "action.enqueue"));
});
