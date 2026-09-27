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

function ids() { let n = 0; return () => `id-${++n}`; }
function plane({ invoke = async () => ({ ok: true }), policy } = {}) {
  return new ControlPlane({ providers: [new FunctionProvider("fake", invoke)], policy, idFactory: ids() });
}

test("desktop ownership is exclusive across sessions", () => {
  const cp = plane();
  const first = cp.createSession({ desktopId: "desktop-A" });
  assert.throws(() => cp.createSession({ desktopId: "desktop-A" }), (error) => error.code === "DESKTOP_OWNED");
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

test("destructive actions are disabled by default and confirmation remains compatible", async () => {
  const blocked = plane();
  const blockedSession = blocked.createSession({ desktopId: "desktop-A" });
  assert.throws(() => blocked.enqueueAction(blockedSession.id, { provider: "fake", type: "file.delete", destructive: true }), (error) => error.code === "DESTRUCTIVE_DISABLED");

  const cp = plane({ policy: { permissions: ["desktop.control", "destructive"], allowDestructive: true } });
  const session = cp.createSession({ desktopId: "desktop-A", permissions: ["desktop.control", "destructive"] });
  const action = cp.enqueueAction(session.id, { provider: "fake", type: "file.delete", destructive: true, permission: "destructive" });
  assert.equal(action.status, "awaiting_confirmation");
  assert.equal(await cp.processNext(), null);
  cp.confirmAction(action.id, { approvedBy: "operator" });
  assert.equal((await cp.processNext()).status, "succeeded");
});

test("queued and executing actions can be cancelled", async () => {
  let started;
  const startedPromise = new Promise((resolve) => (started = resolve));
  const cp = plane({
    invoke: (_request) => new Promise((_resolve, reject) => {
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
  assert.equal(cp.getAction(running.id).status, "executing");
  cp.cancelAction(running.id, "operator_stop");
  const finished = await processing;
  assert.equal(finished.status, "cancelled");
});

test("retryable generic failures enter retry_wait and then succeed", async () => {
  let calls = 0;
  const cp = plane({
    invoke: async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("temporary transport failure"), { retryable: true, code: "TEMPORARY", category: "transient" });
      return { ok: true };
    },
  });
  const session = cp.createSession({ desktopId: "desktop-A" });
  const action = cp.enqueueAction(session.id, { provider: "fake", type: "screen.read", maxAttempts: 2 });
  assert.equal((await cp.processNext()).status, "retry_wait");
  const second = await cp.processNext();
  assert.equal(second.status, "succeeded");
  assert.equal(second.attempts, 2);
  assert.equal(cp.getAction(action.id).result.ok, true);
});

test("resource locks prevent overlapping same lane but allow independent observation lane", () => {
  const cp = plane();
  const session = cp.createSession({ desktopId: "desktop-A" });
  const mouse = cp.enqueueAction(session.id, { provider: "fake", type: "mouse.move" });
  const keyboard = cp.enqueueAction(session.id, { provider: "fake", type: "keyboard.press" });
  const screenshot = cp.enqueueAction(session.id, { provider: "fake", type: "screenshot.capture" });
  assert.ok(mouse.lanes.includes("keyboard-mouse:desktop-A"));
  assert.ok(keyboard.lanes.includes("keyboard-mouse:desktop-A"));
  assert.ok(screenshot.lanes.includes("observation:desktop-A"));
  assert.equal(cp.leaseNext({ workerId: "one" }).id, mouse.id);
  assert.equal(cp.leaseNext({ workerId: "two" }).id, screenshot.id);
  assert.equal(cp.leaseNext({ workerId: "three" }), null);
});

test("audit log is ordered and correlation-filterable", async () => {
  const cp = plane();
  const session = cp.createSession({ desktopId: "desktop-A" });
  const action = cp.enqueueAction(session.id, { provider: "fake", type: "screen.read", correlationId: "corr-1" });
  await cp.processNext();
  const audit = cp.getAuditLog({ correlationId: "corr-1" });
  assert.ok(audit.length >= 3);
  assert.ok(audit.every((entry) => entry.correlationId === "corr-1"));
  assert.equal(cp.getAction(action.id).status, "succeeded");
});

test("help-pc-1 exact envelope and vision-2 generic boundary coexist", async () => {
  const calls = [];
  const help = new HelpPc1Adapter({ invoke: async (request) => (calls.push(["help", request]), { ok: true, status: "dry_run" }) });
  const vision = new Vision2Adapter({ invoke: async (request) => (calls.push(["vision", request]), { seen: true }) });
  const cp = new ControlPlane({ providers: [help, vision], idFactory: ids() });
  const session = cp.createSession({ desktopId: "desktop-A" });
  cp.enqueueAction(session.id, { provider: "help-pc-1", type: "mouse.click", input: { x: 10, y: 20 } });
  cp.enqueueAction(session.id, { provider: "vision-2", type: "screen.describe", permission: "desktop.observe" });
  await cp.drain();
  assert.deepEqual(calls[0][1], { request_id: "id-2", action: "mouse.click", params: { x: 10, y: 20 }, dry_run: true });
  assert.equal(calls[1][1].tool, "screen.describe");
});

test("RPC and MCP surfaces expose session/action/status/cancel/audit/metrics without provider coupling", async () => {
  const cp = plane();
  const rpc = createRpcHandler(cp);
  const session = await rpc("session.create", { desktopId: "desktop-A" });
  const action = await rpc("action.enqueue", { sessionId: session.id, action: { provider: "fake", type: "screen.read" } });
  assert.equal((await rpc("action.status", { actionId: action.id })).status, "queued");
  await rpc("action.processNext");
  assert.equal((await rpc("action.get", { actionId: action.id })).status, "succeeded");
  assert.ok((await rpc("audit.list", { correlationId: action.correlationId })).length > 0);
  assert.ok((await rpc("runtime.metrics")).queueLatency.count >= 1);
  const methods = new Set(mcpToolDefinitions().map((tool) => tool.rpcMethod));
  for (const name of ["session.create", "action.enqueue", "action.status", "action.cancel", "audit.list", "runtime.metrics"]) assert.ok(methods.has(name));
});
