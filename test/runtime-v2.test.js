import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlane, FunctionProvider, FunctionVerificationProvider, JsonStateStore, StateCorruptionError, createSimulationRuntime } from "../src/index.js";
function ids() { let n = 0; return () => `id-${++n}`; }
function tempState() { const dir = mkdtempSync(join(tmpdir(), "pc-control-v2-")); return join(dir, "state.json"); }

test("v2 snapshot migration separates legacy attempts into executionAttempts and recovers executing as uncertain", () => {
  const snapshot = { version: 2, sessions: [{ id: "s1", desktopId: "desk", principal: "p", permissions: ["desktop.control"], status: "active", createdAt: "2026-01-01T00:00:00Z" }], desktopOwners: [["desk", "s1"]], actions: [{ id: "a1", sessionId: "s1", desktopId: "desk", provider: "fake", type: "mouse.click", input: {}, resource: null, permission: "desktop.control", idempotencyKey: "k", maxAttempts: 3, attempts: 1, confirmationRequired: false, destructive: false, requiresDesktop: true, metadata: {}, status: "executing", cancellationRequested: false, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:01Z" }], queue: [], idempotency: [["s1:k", "a1"]], resourceLocks: [["keyboard-mouse:desk", "a1"]], audit: [], auditSequence: 0, metrics: {} };
  const cp = new ControlPlane({ providers: [new FunctionProvider("fake", async () => ({ ok: true }))], snapshot }); const action = cp.getAction("a1"); assert.equal(action.status, "uncertain_outcome"); assert.equal(action.executionAttempts, 1); assert.equal(action.verificationAttempts, 0); assert.equal(action.reconciliationAttempts, 0); assert.equal(action.attempts, 1);
});

test("known successful execution with stale verifier increments verification not execution", async () => {
  let executions = 0; const provider = new FunctionProvider("fake", async () => { executions += 1; return { ok: true }; }); let verifies = 0; const verifier = new FunctionVerificationProvider("observer", async () => { verifies += 1; return verifies === 1 ? { ok: false, category: "stale_observation", retryable: true } : { ok: true }; });
  const cp = new ControlPlane({ providers: [provider], verificationProviders: [verifier], idFactory: ids() }); const session = cp.createSession({ desktopId: "desk" }); cp.enqueueAction(session.id, { provider: "fake", type: "uia.invoke", verification: { provider: "observer", type: "observe" }, maxVerificationAttempts: 2 }); assert.equal((await cp.processNext()).status, "reconciliation_wait"); const final = await cp.processNext(); assert.equal(final.status, "succeeded"); assert.equal(executions, 1); assert.equal(final.executionAttempts, 1); assert.equal(final.verificationAttempts, 2); assert.equal(final.reconciliationAttempts, 1);
});

test("dry-run simulation remains default for fake executor", async () => { const { controlPlane, executor } = createSimulationRuntime({ idFactory: ids() }); const session = controlPlane.createSession({ desktopId: "desk" }); controlPlane.enqueueAction(session.id, { provider: "help-pc-1", type: "keyboard.press", input: { key: "enter" } }); const result = await controlPlane.processNext(); assert.equal(result.status, "succeeded"); assert.equal(executor.calls[0].dry_run, true); });

test("version 3 state persists distinct counters", async () => { const state = tempState(); const store = new JsonStateStore(state); const provider = new FunctionProvider("fake", async () => ({ ok: true })); const cp = new ControlPlane({ providers: [provider], store, idFactory: ids() }); const session = cp.createSession({ desktopId: "desk" }); const action = cp.enqueueAction(session.id, { provider: "fake", type: "screen.read" }); await cp.processNext(); const restored = new ControlPlane({ providers: [provider], store, idFactory: ids() }); assert.equal(restored.getAction(action.id).executionAttempts, 1); assert.equal(restored.snapshot().version, 3); });

test("corrupt version 3 state still fails closed", () => { const state = tempState(); writeFileSync(state, "not-json", "utf8"); assert.throws(() => new ControlPlane({ providers: [new FunctionProvider("fake", async () => ({ ok: true }))], store: new JsonStateStore(state) }), StateCorruptionError); });
