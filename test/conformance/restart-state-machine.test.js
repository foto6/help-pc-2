import test from "node:test";
import assert from "node:assert/strict";
import {
  ControlPlane,
  FunctionProvider,
  FunctionVerificationProvider,
} from "../../src/index.js";

function ids() {
  let n = 0;
  return () => `id-${++n}`;
}

function buildBoundarySnapshot(status, { provisionalUnknown = false } = {}) {
  const provider = new FunctionProvider("fake", async () => ({ ok: true }));
  const verifier = new FunctionVerificationProvider("vision-2", async () => ({ ok: false, category: "inconclusive", retryable: true }));
  const cp = new ControlPlane({ providers: [provider], verificationProviders: [verifier], idFactory: ids(), recoverOnStart: false });
  const session = cp.createSession({ desktopId: "desk" });
  const action = cp.enqueueAction(session.id, {
    provider: "fake",
    type: "uia.invoke",
    verification: { provider: "vision-2", type: "observe" },
    maxReconciliationAttempts: 5,
    maxVerificationAttempts: 5,
  });
  const snapshot = cp.snapshot();
  const stored = snapshot.actions.find((item) => item.id === action.id);
  stored.status = status;
  stored.executionAttempts = ["executing", "verifying", "uncertain_outcome", "reconciling", "reconciliation_wait", "succeeded", "failed", "blocked", "cancelled"].includes(status) ? 1 : 0;
  stored.attempts = stored.executionAttempts;
  stored.verificationAttempts = ["verifying", "reconciling", "reconciliation_wait", "succeeded"].includes(status) ? 1 : 0;
  stored.reconciliationAttempts = ["reconciling", "reconciliation_wait"].includes(status) ? 1 : 0;
  stored.executionOutcome = ["verifying", "reconciling", "reconciliation_wait", "succeeded"].includes(status) ? "succeeded" : null;
  stored.executorEvidence = provisionalUnknown ? {
    contract: "pc_executor.action_outcome.v1",
    outcome: "unknown",
    effectState: "unknown",
    requestId: action.id,
    action: action.type,
  } : null;
  stored.uncertainty = ["uncertain_outcome", "reconciling", "reconciliation_wait"].includes(status) ? {
    reason: "fixture",
    since: "2026-09-27T09:00:00.000Z",
    executionAttempt: 1,
    cancellationRequested: false,
  } : null;
  snapshot.queue = ["uncertain_outcome", "reconciliation_wait"].includes(status) ? [action.id] : [];
  snapshot.resourceLocks = [];
  if (status === "leased") {
    stored.lease = {
      mode: "execute",
      workerId: "dead",
      lanes: stored.lanes,
      acquiredAt: "2026-09-27T09:00:00.000Z",
      acquiredAtMs: 1,
      expiresAt: "2099-01-01T00:00:00.000Z",
      expiresAtMs: 4070908800000,
    };
    snapshot.resourceLocks = stored.lanes.map((lane) => [lane, action.id]);
  } else if (["executing", "verifying"].includes(status)) {
    stored.lease = {
      mode: "execute",
      workerId: "dead",
      lanes: stored.lanes,
      acquiredAt: "2026-09-27T09:00:00.000Z",
      acquiredAtMs: 1,
      expiresAt: "2099-01-01T00:00:00.000Z",
      expiresAtMs: 4070908800000,
    };
  } else if (status === "reconciling") {
    const lanes = [...new Set([...stored.lanes, "observation:desk"])];
    stored.lease = {
      mode: "reconcile",
      workerId: "dead",
      lanes,
      acquiredAt: "2026-09-27T09:00:00.000Z",
      acquiredAtMs: 1,
      expiresAt: "2099-01-01T00:00:00.000Z",
      expiresAtMs: 4070908800000,
    };
  } else {
    stored.lease = null;
  }
  return { snapshot, actionId: action.id };
}

function restart(snapshot, executeCounter = { count: 0 }) {
  return new ControlPlane({
    providers: [new FunctionProvider("fake", async () => { executeCounter.count += 1; return { ok: true }; })],
    verificationProviders: [new FunctionVerificationProvider("vision-2", async () => ({ ok: false, category: "inconclusive", retryable: true }))],
    snapshot,
    idFactory: ids(),
  });
}

test("restart boundary: leased never-started work may return to execute queue", () => {
  const { snapshot, actionId } = buildBoundarySnapshot("leased");
  const cp = restart(snapshot);
  assert.equal(cp.getAction(actionId).status, "queued");
  assert.equal(cp.getAction(actionId).executionAttempts, 0);
  assert.equal(cp.leaseNext({ workerId: "next" }).lease.mode, "execute");
});

test("restart boundary: executing becomes uncertain reconciliation, never execution retry", () => {
  const { snapshot, actionId } = buildBoundarySnapshot("executing");
  const cp = restart(snapshot);
  assert.equal(cp.getAction(actionId).status, "uncertain_outcome");
  assert.equal(cp.leaseNext({ workerId: "reconcile" }).lease.mode, "reconcile");
});

test("restart boundary: provisional unknown executing evidence remains uncertain", () => {
  const { snapshot, actionId } = buildBoundarySnapshot("executing", { provisionalUnknown: true });
  const cp = restart(snapshot);
  assert.equal(cp.getAction(actionId).status, "uncertain_outcome");
  assert.equal(cp.getAction(actionId).executorEvidence.outcome, "unknown");
  assert.equal(cp.leaseNext({ workerId: "reconcile" }).lease.mode, "reconcile");
});

for (const [status, expected] of [
  ["uncertain_outcome", "uncertain_outcome"],
  ["reconciling", "reconciliation_wait"],
  ["verifying", "reconciliation_wait"],
  ["reconciliation_wait", "reconciliation_wait"],
]) {
  test(`restart boundary: ${status} resumes read-only as ${expected}`, () => {
    const { snapshot, actionId } = buildBoundarySnapshot(status);
    const cp = restart(snapshot);
    assert.equal(cp.getAction(actionId).status, expected);
    assert.equal(cp.leaseNext({ workerId: "reconcile" }).lease.mode, "reconcile");
  });
}

for (const terminal of ["succeeded", "failed", "blocked", "cancelled"]) {
  test(`restart boundary: terminal ${terminal} remains terminal`, () => {
    const { snapshot, actionId } = buildBoundarySnapshot(terminal);
    const cp = restart(snapshot);
    assert.equal(cp.getAction(actionId).status, terminal);
    assert.equal(cp.leaseNext({ workerId: "none" }), null);
  });
}

function sequences(events, length, prefix = []) {
  if (length === 0) return [prefix];
  return events.flatMap((event) => sequences(events, length - 1, [...prefix, event]));
}

test("bounded state-machine property: uncertain state never transitions back to execute", async () => {
  for (const sequence of sequences(["restart", "process"], 3)) {
    const counter = { count: 0 };
    let { snapshot, actionId } = buildBoundarySnapshot("uncertain_outcome");
    let cp = restart(snapshot, counter);
    for (const event of sequence) {
      if (event === "restart") {
        cp = restart(cp.snapshot(), counter);
      } else {
        await cp.processNext();
      }
      assert.equal(counter.count, 0, `sequence ${sequence.join(",")}`);
      const executionLeases = cp.getAuditLog().filter((entry) => entry.event === "action.leased" && entry.mode === "execute" && entry.actionId === actionId);
      assert.equal(executionLeases.length, 0, `sequence ${sequence.join(",")}`);
    }
  }
});

test("bounded state-machine property: completed/verification state never transitions back to execute", async () => {
  for (const sequence of sequences(["restart", "process"], 3)) {
    const counter = { count: 0 };
    let { snapshot, actionId } = buildBoundarySnapshot("reconciliation_wait");
    let cp = restart(snapshot, counter);
    for (const event of sequence) {
      if (event === "restart") cp = restart(cp.snapshot(), counter);
      else await cp.processNext();
      assert.equal(counter.count, 0, `sequence ${sequence.join(",")}`);
      assert.equal(cp.getAction(actionId).executionAttempts, 1);
      assert.ok(["reconciliation_wait", "uncertain_outcome", "leased", "reconciling"].includes(cp.getAction(actionId).status) || cp.getAction(actionId).status === "failed");
    }
  }
});
