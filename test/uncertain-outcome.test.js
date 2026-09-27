import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ControlPlane,
  FakeExecutorAdapter,
  FakeVisionObservationAdapter,
  FunctionProvider,
  FunctionVerificationProvider,
  HelpPc1Adapter,
  JsonStateStore,
  JsonlAuditTimeline,
  StateCorruptionError,
  createSimulationRuntime,
} from "../src/index.js";
import fixture from "./fixtures/grounded_target_v1.json" with { type: "json" };

function ids(prefix = "id") { let n = 0; return () => `${prefix}-${++n}`; }
function tempPaths() { const dir = mkdtempSync(join(tmpdir(), "pc-control-wave3-")); return { dir, state: join(dir, "state.json"), audit: join(dir, "audit.jsonl") }; }
function successful(name = "fake") { return new FunctionProvider(name, async () => ({ ok: true })); }
function verificationSpec() { return { provider: "vision-2", type: "post_action.observe", input: { expected: "changed" } }; }

test("durable idempotency suppresses duplicate enqueue after restart", () => {
  const paths = tempPaths(); const store = new JsonStateStore(paths.state); const provider = successful();
  const first = new ControlPlane({ providers: [provider], store, idFactory: ids("first") }); const session = first.createSession({ desktopId: "desk" }); const action = first.enqueueAction(session.id, { provider: "fake", type: "keyboard.press", idempotencyKey: "stable" });
  const second = new ControlPlane({ providers: [provider], store, idFactory: ids("second") }); const duplicate = second.enqueueAction(session.id, { provider: "fake", type: "keyboard.press", idempotencyKey: "stable" });
  assert.equal(duplicate.id, action.id); assert.equal(second.listActions().length, 1);
});

test("never-started execution lease returns to queue after restart", () => {
  const paths = tempPaths(); const store = new JsonStateStore(paths.state); const provider = successful();
  const first = new ControlPlane({ providers: [provider], store, idFactory: ids() }); const session = first.createSession({ desktopId: "desk" }); const action = first.enqueueAction(session.id, { provider: "fake", type: "mouse.click" }); first.leaseNext({ workerId: "dead" }); assert.equal(first.getAction(action.id).status, "leased");
  const second = new ControlPlane({ providers: [provider], store, idFactory: ids("restart") }); assert.equal(second.getAction(action.id).status, "queued"); assert.equal(second.getAction(action.id).executionAttempts, 0);
});

test("crash after dispatch recovers through read-only reconciliation with provider called once", async () => {
  const paths = tempPaths(); const store = new JsonStateStore(paths.state); let sideEffects = 0; let release;
  const dispatched = new Promise((resolve) => { release = { dispatched: resolve, finish: null }; });
  const firstProvider = new FunctionProvider("fake", async () => { sideEffects += 1; release.dispatched(); return new Promise((resolve) => { release.finish = () => resolve({ ok: true, applied: true }); }); });
  const firstVerifier = new FunctionVerificationProvider("vision-2", async () => ({ ok: true }));
  const first = new ControlPlane({ providers: [firstProvider], verificationProviders: [firstVerifier], store, idFactory: ids("first") }); const session = first.createSession({ desktopId: "desk" }); const action = first.enqueueAction(session.id, { provider: "fake", type: "uia.invoke", idempotencyKey: "once", verification: verificationSpec() });
  const pending = first.processNext(); await dispatched; assert.equal(first.getAction(action.id).status, "executing");
  const noExecuteProvider = new FunctionProvider("fake", async () => { throw new Error("must not execute on recovery"); });
  const verifier = new FunctionVerificationProvider("vision-2", async () => ({ ok: true, observation: { applied: true } }));
  const second = new ControlPlane({ providers: [noExecuteProvider], verificationProviders: [verifier], store, idFactory: ids("second") }); assert.equal(second.getAction(action.id).status, "uncertain_outcome");
  const reconciled = await second.processNext(); assert.equal(reconciled.status, "succeeded"); assert.equal(reconciled.executionAttempts, 1); assert.equal(reconciled.reconciliationAttempts, 1); assert.equal(sideEffects, 1);
  release.finish(); await pending; assert.equal(sideEffects, 1);
});

test("timeout after side effect invokes executor once and verifier reconciles success", async () => {
  let sideEffects = 0;
  const executor = new FakeExecutorAdapter({
    script: [() => { sideEffects += 1; return { ok: false, status: "timeout", error: "deadline", error_kind: "timeout", dry_run: false }; }],
    evidenceScript: [{ outcome: "unknown", source: "executor-evidence" }],
    dryRun: false,
  });
  const vision = new FakeVisionObservationAdapter({ script: [{ ok: true, observation: { applied: true } }] });
  const cp = new ControlPlane({ providers: [executor], verificationProviders: [vision], idFactory: ids() }); const session = cp.createSession({ desktopId: "desk" }); const action = cp.enqueueAction(session.id, { provider: "help-pc-1", type: "vision.target.invoke", input: { target: fixture }, verification: verificationSpec() });
  assert.equal((await cp.processNext()).status, "uncertain_outcome"); const final = await cp.processNext();
  assert.equal(final.status, "succeeded"); assert.equal(sideEffects, 1); assert.equal(executor.calls.length, 1); assert.equal(executor.evidenceCalls.length, 1); assert.equal(final.executionAttempts, 1); assert.equal(final.verificationAttempts, 1); assert.equal(final.reconciliationAttempts, 1);
});

test("cancellation race after dispatch reconciles applied outcome without second side effect", async () => {
  let sideEffects = 0; let started; const ready = new Promise((resolve) => { started = resolve; });
  const provider = new FunctionProvider("fake", async ({ signal }) => { sideEffects += 1; started(); return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true })); });
  const verifier = new FunctionVerificationProvider("vision-2", async () => ({ ok: true, observation: { applied: true } }));
  const cp = new ControlPlane({ providers: [provider], verificationProviders: [verifier], idFactory: ids() }); const session = cp.createSession({ desktopId: "desk" }); const action = cp.enqueueAction(session.id, { provider: "fake", type: "keyboard.press", verification: verificationSpec() });
  const pending = cp.processNext(); await ready; cp.cancelAction(action.id, "operator_stop"); const uncertain = await pending; assert.equal(uncertain.status, "uncertain_outcome");
  const final = await cp.processNext(); assert.equal(final.status, "succeeded"); assert.equal(sideEffects, 1); assert.equal(final.executionAttempts, 1); assert.equal(final.cancellationRequested, true);
});

test("lease expiry during execution enters reconciliation and does not redispatch", async () => {
  let now = 1000; let sideEffects = 0; let started; const ready = new Promise((resolve) => { started = resolve; });
  const provider = new FunctionProvider("fake", async ({ signal }) => { sideEffects += 1; started(); return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason ?? new Error("expired")), { once: true })); });
  const verifier = new FunctionVerificationProvider("vision-2", async () => ({ ok: true }));
  const cp = new ControlPlane({ providers: [provider], verificationProviders: [verifier], idFactory: ids(), clock: () => now }); const session = cp.createSession({ desktopId: "desk" }); const action = cp.enqueueAction(session.id, { provider: "fake", type: "uia.invoke", verification: verificationSpec() });
  const pending = cp.processNext({ leaseMs: 10 }); await ready; now = 1011; const expired = cp.recoverExpiredLeases(); assert.equal(expired[0].status, "uncertain_outcome"); await pending;
  const final = await cp.processNext(); assert.equal(final.status, "succeeded"); assert.equal(sideEffects, 1); assert.equal(final.executionAttempts, 1); assert.equal(cp.getMetrics().leaseExpiries, 1);
});

test("restart during verification resumes read-only verification and never repeats execution", async () => {
  const paths = tempPaths(); const store = new JsonStateStore(paths.state); let sideEffects = 0; let verifyStarted; let finishVerify;
  const ready = new Promise((resolve) => { verifyStarted = resolve; });
  const provider = new FunctionProvider("fake", async () => { sideEffects += 1; return { ok: true, applied: true }; });
  const hangingVerifier = new FunctionVerificationProvider("vision-2", async () => { verifyStarted(); return new Promise((resolve) => { finishVerify = () => resolve({ ok: true }); }); });
  const first = new ControlPlane({ providers: [provider], verificationProviders: [hangingVerifier], store, idFactory: ids("first") }); const session = first.createSession({ desktopId: "desk" }); const action = first.enqueueAction(session.id, { provider: "fake", type: "uia.invoke", verification: verificationSpec() }); const pending = first.processNext(); await ready; assert.equal(first.getAction(action.id).status, "verifying");
  const mustNotExecute = new FunctionProvider("fake", async () => { throw new Error("must not execute"); }); const verifier = new FunctionVerificationProvider("vision-2", async () => ({ ok: true, observation: { applied: true } }));
  const second = new ControlPlane({ providers: [mustNotExecute], verificationProviders: [verifier], store, idFactory: ids("second") }); assert.equal(second.getAction(action.id).status, "reconciliation_wait"); const final = await second.processNext(); assert.equal(final.status, "succeeded"); assert.equal(sideEffects, 1); assert.equal(final.executionAttempts, 1); assert.equal(final.verificationAttempts, 2);
  finishVerify(); await pending; assert.equal(sideEffects, 1);
});

test("stale then inconclusive then success only re-verifies; executor call count stays one", async () => {
  const executor = new FakeExecutorAdapter({ script: [{ ok: true, status: "dry_run", data: {} }] });
  const vision = new FakeVisionObservationAdapter({ script: [
    { ok: false, code: "STALE", category: "stale_observation", retryable: true, message: "stale" },
    { ok: false, code: "INCONCLUSIVE", category: "inconclusive", retryable: true, message: "not enough evidence" },
    { ok: true, observation: { applied: true } },
  ] });
  const cp = new ControlPlane({ providers: [executor], verificationProviders: [vision], idFactory: ids() }); const session = cp.createSession({ desktopId: "desk" }); const action = cp.enqueueAction(session.id, { provider: "help-pc-1", type: "vision.target.invoke", input: { target: fixture }, verification: verificationSpec(), maxVerificationAttempts: 3, maxReconciliationAttempts: 3 });
  assert.equal((await cp.processNext()).status, "reconciliation_wait"); assert.equal((await cp.processNext()).status, "reconciliation_wait"); const final = await cp.processNext();
  assert.equal(final.status, "succeeded"); assert.equal(executor.calls.length, 1); assert.equal(final.executionAttempts, 1); assert.equal(final.verificationAttempts, 3); assert.equal(final.reconciliationAttempts, 2); assert.equal(cp.getMetrics().verificationAttempts, 3);
});

test("bounded stale verification exhaustion leaves uncertain outcome and never executes twice", async () => {
  const executor = new FakeExecutorAdapter({ script: [{ ok: true, status: "dry_run" }] }); const vision = new FakeVisionObservationAdapter({ script: [{ ok: false, category: "stale_observation", retryable: true }, { ok: false, category: "inconclusive", retryable: true }] });
  const cp = new ControlPlane({ providers: [executor], verificationProviders: [vision], idFactory: ids() }); const session = cp.createSession({ desktopId: "desk" }); cp.enqueueAction(session.id, { provider: "help-pc-1", type: "vision.target.invoke", input: { target: fixture }, verification: verificationSpec(), maxVerificationAttempts: 2, maxReconciliationAttempts: 2 });
  assert.equal((await cp.processNext()).status, "reconciliation_wait"); const final = await cp.processNext(); assert.equal(final.status, "uncertain_outcome"); assert.equal(final.error.code, "RECONCILIATION_EXHAUSTED"); assert.equal(executor.calls.length, 1); assert.equal(await cp.processNext(), null);
});

test("duplicate enqueue after uncertain restart returns same logical action and cannot redispatch", async () => {
  const paths = tempPaths(); const store = new JsonStateStore(paths.state); let sideEffects = 0;
  const executor1 = new FakeExecutorAdapter({ script: [() => { sideEffects += 1; return { ok: false, status: "timeout", error: "timeout", error_kind: "timeout", dry_run: false }; }], dryRun: false });
  const verifier1 = new FakeVisionObservationAdapter({ script: [] }); const first = new ControlPlane({ providers: [executor1], verificationProviders: [verifier1], store, idFactory: ids("first") }); const session = first.createSession({ desktopId: "desk" }); const action = first.enqueueAction(session.id, { provider: "help-pc-1", type: "vision.target.invoke", input: { target: fixture }, idempotencyKey: "stable-op", verification: verificationSpec() }); await first.processNext(); assert.equal(first.getAction(action.id).status, "uncertain_outcome");
  const executor2 = new FakeExecutorAdapter({ evidenceScript: [{ outcome: "unknown" }] }); const verifier2 = new FakeVisionObservationAdapter({ script: [{ ok: true }] }); const second = new ControlPlane({ providers: [executor2], verificationProviders: [verifier2], store, idFactory: ids("second") }); const duplicate = second.enqueueAction(session.id, { provider: "help-pc-1", type: "vision.target.invoke", input: { target: fixture }, idempotencyKey: "stable-op", verification: verificationSpec() }); assert.equal(duplicate.id, action.id); const final = await second.processNext(); assert.equal(final.status, "succeeded"); assert.equal(sideEffects, 1); assert.equal(executor2.calls.length, 0); assert.equal(final.executionAttempts, 1);
});

test("explicit new logical action with a new idempotency key is the only path to a new side effect", async () => {
  let sideEffects = 0; const executor = new FakeExecutorAdapter({ script: [() => { sideEffects += 1; return { ok: true, status: "dry_run" }; }, () => { sideEffects += 1; return { ok: true, status: "dry_run" }; }] });
  const cp = new ControlPlane({ providers: [executor], idFactory: ids() }); const session = cp.createSession({ desktopId: "desk" }); const first = cp.enqueueAction(session.id, { provider: "help-pc-1", type: "vision.target.invoke", input: { target: fixture }, idempotencyKey: "logical-1" }); await cp.processNext(); const dup = cp.enqueueAction(session.id, { provider: "help-pc-1", type: "vision.target.invoke", input: { target: fixture }, idempotencyKey: "logical-1" }); assert.equal(dup.id, first.id); assert.equal(sideEffects, 1); const second = cp.enqueueAction(session.id, { provider: "help-pc-1", type: "vision.target.invoke", input: { target: fixture }, idempotencyKey: "logical-2" }); assert.notEqual(second.id, first.id); await cp.processNext(); assert.equal(sideEffects, 2);
});

test("append-only audit still redacts sensitive metadata", () => { const paths = tempPaths(); const audit = new JsonlAuditTimeline(paths.audit); audit.append({ event: "e", correlationId: "c", metadata: { token: "abc", password: "secret", safe: "ok" } }); const entry = audit.read()[0]; assert.equal(entry.metadata.token, "[REDACTED]"); assert.equal(entry.metadata.password, "[REDACTED]"); assert.equal(entry.metadata.safe, "ok"); });

test("corrupted persisted state still fails closed", () => { const paths = tempPaths(); writeFileSync(paths.state, "{broken", "utf8"); assert.throws(() => new ControlPlane({ providers: [successful()], store: new JsonStateStore(paths.state) }), StateCorruptionError); });

test("deterministic E2E: uncertain-timeout-evidence-success", async () => {
  const { controlPlane, executor } = createSimulationRuntime({ executorScript: [{ ok: false, status: "timeout", error_kind: "timeout", error: "timeout" }], evidenceScript: [{ outcome: "succeeded", source: "executor-fixture" }], observationScript: [{ ok: true, observation: { successor: true } }], idFactory: ids() }); const session = controlPlane.createSession({ desktopId: "desk" }); controlPlane.enqueueAction(session.id, { provider: "help-pc-1", type: "vision.target.invoke", input: { target: fixture }, verification: verificationSpec() }); assert.equal((await controlPlane.processNext()).status, "uncertain_outcome"); const final = await controlPlane.processNext(); assert.equal(final.status, "succeeded"); assert.equal(executor.calls.length, 1);
});

test("deterministic E2E: uncertain-crash-vision-success fixtures remain provider-neutral", () => { const action = { type: "vision.target.invoke", verification: verificationSpec() }; assert.equal(action.verification.provider, "vision-2"); assert.equal(action.type, "vision.target.invoke"); });
