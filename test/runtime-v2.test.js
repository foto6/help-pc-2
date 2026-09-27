import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ControlPlane,
  FakeExecutorAdapter,
  FakeVisionObservationAdapter,
  FunctionProvider,
  FunctionVerificationProvider,
  JsonStateStore,
  JsonlAuditTimeline,
  StateCorruptionError,
  createSimulationRuntime,
} from "../src/index.js";
import fixture from "./fixtures/grounded_target_v1.json" with { type: "json" };

function ids(prefix = "id") { let n = 0; return () => `${prefix}-${++n}`; }
function tempPaths() {
  const dir = mkdtempSync(join(tmpdir(), "pc-control-v2-"));
  return { dir, state: join(dir, "state.json"), audit: join(dir, "audit.jsonl") };
}
function successProvider(name = "fake") { return new FunctionProvider(name, async () => ({ ok: true })); }

test("durable state survives restart and suppresses duplicate idempotency key", () => {
  const paths = tempPaths();
  const store = new JsonStateStore(paths.state);
  const provider = successProvider();
  const first = new ControlPlane({ providers: [provider], store, idFactory: ids("first") });
  const session = first.createSession({ desktopId: "desktop-A" });
  const action = first.enqueueAction(session.id, { provider: "fake", type: "keyboard.press", idempotencyKey: "stable-key" });

  const second = new ControlPlane({ providers: [provider], store, idFactory: ids("second") });
  const duplicate = second.enqueueAction(session.id, { provider: "fake", type: "keyboard.press", idempotencyKey: "stable-key" });
  assert.equal(duplicate.id, action.id);
  assert.equal(second.getSession(session.id).desktopId, "desktop-A");
  assert.equal(second.listActions().length, 1);
});

test("explicit lifecycle traverses leased/executing/verifying/succeeded", async () => {
  let resolveExecution;
  let resolveVerification;
  const executionStarted = new Promise((resolve) => { resolveExecution = resolve; });
  const verificationStarted = new Promise((resolve) => { resolveVerification = resolve; });
  let finishExecution;
  let finishVerification;
  const provider = new FunctionProvider("fake", async () => {
    resolveExecution();
    return new Promise((resolve) => { finishExecution = () => resolve({ ok: true, operation: "done" }); });
  });
  const verifier = new FunctionVerificationProvider("observer", async () => {
    resolveVerification();
    return new Promise((resolve) => { finishVerification = () => resolve({ ok: true, observation: { changed: true } }); });
  });
  const cp = new ControlPlane({ providers: [provider], verificationProviders: [verifier], idFactory: ids() });
  const session = cp.createSession({ desktopId: "desktop-A" });
  const action = cp.enqueueAction(session.id, { provider: "fake", type: "uia.invoke", verification: { provider: "observer", type: "post_action.observe" } });
  const lease = cp.leaseNext({ workerId: "worker-1" });
  assert.equal(lease.status, "leased");
  const executing = cp.executeLeased(action.id, { workerId: "worker-1" });
  await executionStarted;
  assert.equal(cp.getAction(action.id).status, "executing");
  finishExecution();
  await verificationStarted;
  assert.equal(cp.getAction(action.id).status, "verifying");
  finishVerification();
  assert.equal((await executing).status, "succeeded");
});

test("resource lanes include keyboard/mouse, observation, shell and custom resource locks", () => {
  const cp = new ControlPlane({ providers: [successProvider()], idFactory: ids() });
  const session = cp.createSession({ desktopId: "desk" });
  const mouse = cp.enqueueAction(session.id, { provider: "fake", type: "mouse.click" });
  const inspect = cp.enqueueAction(session.id, { provider: "fake", type: "uia.inspect" });
  const shell = cp.enqueueAction(session.id, { provider: "fake", type: "shell.run" });
  const custom = cp.enqueueAction(session.id, { provider: "fake", type: "custom.read", resource: "gpu-0" });
  assert.ok(mouse.lanes.includes("keyboard-mouse:desk"));
  assert.ok(inspect.lanes.includes("observation:desk"));
  assert.ok(shell.lanes.includes("shell:desk"));
  assert.ok(custom.lanes.includes("resource:gpu-0"));
  assert.equal(cp.leaseNext({ workerId: "m" }).id, mouse.id);
  assert.equal(cp.leaseNext({ workerId: "o" }).id, inspect.id);
  assert.equal(cp.leaseNext({ workerId: "s" }).id, shell.id);
  assert.equal(cp.leaseNext({ workerId: "c" }).id, custom.id);
});

test("policy_blocked structured error becomes blocked and never retries", async () => {
  let calls = 0;
  const provider = new FunctionProvider("fake", async () => {
    calls += 1;
    throw Object.assign(new Error("policy says no"), { code: "policy_blocked", category: "policy_blocked", retryable: true });
  });
  const cp = new ControlPlane({ providers: [provider], idFactory: ids() });
  const session = cp.createSession({ desktopId: "desktop-A" });
  const action = cp.enqueueAction(session.id, { provider: "fake", type: "uia.invoke", maxAttempts: 5 });
  const result = await cp.processNext();
  assert.equal(result.status, "blocked");
  assert.equal(result.attempts, 1);
  assert.equal(calls, 1);
  assert.equal(await cp.processNext(), null);
  assert.equal(cp.getAction(action.id).status, "blocked");
});

test("lease expiry releases locks and requeues never-started work", () => {
  let now = 1_000;
  const cp = new ControlPlane({ providers: [successProvider()], idFactory: ids(), clock: () => now });
  const session = cp.createSession({ desktopId: "desktop-A" });
  const action = cp.enqueueAction(session.id, { provider: "fake", type: "mouse.click" });
  cp.leaseNext({ workerId: "dead-worker", leaseMs: 10 });
  assert.equal(cp.getAction(action.id).status, "leased");
  now = 1_011;
  const recovered = cp.recoverExpiredLeases();
  assert.equal(recovered[0].status, "queued");
  assert.equal(cp.snapshot().resourceLocks.length, 0);
  assert.equal(cp.getMetrics().leaseExpiries, 1);
});

test("process crash recovery moves interrupted executing work to retry_wait", async () => {
  const paths = tempPaths();
  const store = new JsonStateStore(paths.state);
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const provider = new FunctionProvider("fake", async (request) => {
    started();
    return new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason ?? new Error("aborted")), { once: true }));
  });
  const first = new ControlPlane({ providers: [provider], store, idFactory: ids("first") });
  const session = first.createSession({ desktopId: "desktop-A" });
  const action = first.enqueueAction(session.id, { provider: "fake", type: "mouse.click", maxAttempts: 3 });
  const pending = first.processNext();
  await startedPromise;
  assert.equal(first.getAction(action.id).status, "executing");

  const second = new ControlPlane({ providers: [successProvider()], store, idFactory: ids("second") });
  assert.equal(second.getAction(action.id).status, "retry_wait");
  assert.equal(second.getAction(action.id).attempts, 1);
  first.cancelAction(action.id, "test_cleanup");
  await pending;
});

test("cancellation race during execution terminates cancelled without retry", async () => {
  let start;
  const started = new Promise((resolve) => { start = resolve; });
  let calls = 0;
  const provider = new FunctionProvider("fake", async (request) => {
    calls += 1; start();
    return new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { code: "CANCELLED", category: "cancelled", retryable: true })), { once: true }));
  });
  const cp = new ControlPlane({ providers: [provider], idFactory: ids() });
  const session = cp.createSession({ desktopId: "desktop-A" });
  const action = cp.enqueueAction(session.id, { provider: "fake", type: "keyboard.press", maxAttempts: 3 });
  const pending = cp.processNext();
  await started;
  cp.cancelAction(action.id, "operator_stop");
  const result = await pending;
  assert.equal(result.status, "cancelled");
  assert.equal(result.attempts, 1);
  assert.equal(calls, 1);
  assert.equal(cp.getMetrics().cancellations, 1);
});

test("corrupted persisted state fails closed", () => {
  const paths = tempPaths();
  writeFileSync(paths.state, "{not-json", "utf8");
  const store = new JsonStateStore(paths.state);
  assert.throws(() => new ControlPlane({ providers: [successProvider()], store }), StateCorruptionError);
});

test("durable audit timeline redacts sensitive metadata and carries correlation id", async () => {
  const paths = tempPaths();
  const auditTimeline = new JsonlAuditTimeline(paths.audit);
  const cp = new ControlPlane({ providers: [successProvider()], auditTimeline, idFactory: ids() });
  const session = cp.createSession({ desktopId: "desktop-A" });
  const action = cp.enqueueAction(session.id, { provider: "fake", type: "screen.read", correlationId: "corr-audit" });
  await cp.processNext();
  auditTimeline.append({ event: "test", correlationId: "corr-audit", metadata: { token: "abc", nested: { password: "secret", safe: "ok" } } });
  const entries = auditTimeline.read();
  assert.ok(entries.some((entry) => entry.correlationId === action.correlationId));
  const last = entries.at(-1);
  assert.equal(last.metadata.token, "[REDACTED]");
  assert.equal(last.metadata.nested.password, "[REDACTED]");
  assert.equal(last.metadata.nested.safe, "ok");
});

test("version-1 running snapshot migrates and recovers without losing idempotency", () => {
  const snapshot = {
    version: 1,
    sessions: [{ id: "s1", desktopId: "desk", principal: "p", permissions: ["desktop.control"], status: "active", createdAt: "2026-01-01T00:00:00Z" }],
    desktopOwners: [["desk", "s1"]],
    actions: [{ id: "a1", sessionId: "s1", desktopId: "desk", provider: "fake", type: "mouse.click", input: {}, resource: null, permission: "desktop.control", idempotencyKey: "k", maxAttempts: 3, attempts: 1, confirmationRequired: false, confirmedBy: null, destructive: false, requiresDesktop: true, metadata: {}, status: "running", cancellationRequested: false, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:01Z", result: null, error: null }],
    queue: [], idempotency: [["s1:k", "a1"]], resourceLocks: [["mouse", "a1"]], audit: [], auditSequence: 0,
  };
  const cp = new ControlPlane({ providers: [successProvider()], snapshot });
  assert.equal(cp.getAction("a1").status, "retry_wait");
  assert.equal(cp.enqueueAction("s1", { provider: "fake", type: "mouse.click", idempotencyKey: "k" }).id, "a1");
});

test("runtime counters record queue/execution/verification latency and retries", async () => {
  let now = 10_000;
  let calls = 0;
  const provider = new FunctionProvider("fake", async () => {
    now += 5; calls += 1;
    if (calls === 1) throw Object.assign(new Error("timeout"), { code: "timeout", category: "transient", retryable: true });
    return { ok: true };
  });
  const verifier = new FunctionVerificationProvider("observer", async () => { now += 7; return { ok: true }; });
  const cp = new ControlPlane({ providers: [provider], verificationProviders: [verifier], idFactory: ids(), clock: () => now });
  const session = cp.createSession({ desktopId: "desktop-A" });
  cp.enqueueAction(session.id, { provider: "fake", type: "uia.invoke", maxAttempts: 2, verification: { provider: "observer", type: "observe" } });
  now += 11;
  assert.equal((await cp.processNext()).status, "retry_wait");
  now += 3;
  assert.equal((await cp.processNext()).status, "succeeded");
  const metrics = cp.getMetrics();
  assert.equal(metrics.retries, 1);
  assert.equal(metrics.queueLatency.count, 2);
  assert.equal(metrics.executionLatency.count, 2);
  assert.equal(metrics.verificationLatency.count, 1);
  assert.ok(metrics.queueLatency.totalMs >= 14);
});

test("dry-run simulation scenario: grounded-target-verifies-success", async () => {
  const { controlPlane, executor, vision } = createSimulationRuntime({ idFactory: ids() });
  const session = controlPlane.createSession({ desktopId: "desktop-A" });
  const action = controlPlane.enqueueAction(session.id, {
    provider: "help-pc-1",
    type: "vision.target.invoke",
    input: { target: fixture },
    idempotencyKey: "scenario-success",
    verification: { provider: "vision-2", type: "post_action.observe", input: { expected: "save" } },
  });
  const result = await controlPlane.processNext();
  assert.equal(result.status, "succeeded");
  assert.equal(result.verificationResult.ok, true);
  assert.deepEqual(executor.calls[0], { request_id: action.id, action: "vision.target.invoke", params: { target: fixture }, dry_run: true });
  assert.equal(vision.calls[0].verification.type, "post_action.observe");
});

test("failure/recovery scenario: executor-timeout-retry-recovers", async () => {
  const timeout = Object.assign(new Error("executor timeout"), { code: "executor_timeout", category: "transient", retryable: true });
  const { controlPlane } = createSimulationRuntime({ executorScript: [timeout, { ok: true, status: "dry_run", data: {} }], idFactory: ids() });
  const session = controlPlane.createSession({ desktopId: "desktop-A" });
  controlPlane.enqueueAction(session.id, { provider: "help-pc-1", type: "vision.target.invoke", input: { target: fixture }, maxAttempts: 2 });
  assert.equal((await controlPlane.processNext()).status, "retry_wait");
  const recovered = await controlPlane.processNext();
  assert.equal(recovered.status, "succeeded");
  assert.equal(recovered.attempts, 2);
});

test("failure/recovery scenario: stale-target-reobserve-recovers", async () => {
  const { controlPlane } = createSimulationRuntime({
    executorScript: [{ ok: true, status: "dry_run" }, { ok: true, status: "dry_run" }],
    observationScript: [
      { ok: false, code: "stale_target", category: "stale_observation", retryable: true, message: "frame stale" },
      { ok: true, observation: { matched: true, successor: true } },
    ],
    idFactory: ids(),
  });
  const session = controlPlane.createSession({ desktopId: "desktop-A" });
  controlPlane.enqueueAction(session.id, { provider: "help-pc-1", type: "vision.target.invoke", input: { target: fixture }, maxAttempts: 2, verification: { provider: "vision-2", type: "post_action.observe" } });
  assert.equal((await controlPlane.processNext()).status, "retry_wait");
  const recovered = await controlPlane.processNext();
  assert.equal(recovered.status, "succeeded");
  assert.equal(recovered.attempts, 2);
});

test("failure injection: ambiguous target verification fails without automatic retry", async () => {
  const executor = new FakeExecutorAdapter({ script: [{ ok: true, status: "dry_run" }] });
  const vision = new FakeVisionObservationAdapter({ script: [{ ok: false, code: "ambiguous_target", category: "verification_error", retryable: false, message: "ambiguous" }] });
  const cp = new ControlPlane({ providers: [executor], verificationProviders: [vision], idFactory: ids() });
  const session = cp.createSession({ desktopId: "desktop-A" });
  const action = cp.enqueueAction(session.id, { provider: "help-pc-1", type: "vision.target.invoke", input: { target: fixture }, maxAttempts: 3, verification: { provider: "vision-2", type: "post_action.observe" } });
  const result = await cp.processNext();
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "ambiguous_target");
  assert.equal(result.attempts, 1);
  assert.equal(cp.getAction(action.id).attempts, 1);
});
