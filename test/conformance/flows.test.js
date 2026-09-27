import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ControlPlane,
  HelpPc1Adapter,
  VisionVerificationResultV1Adapter,
} from "../../src/index.js";

const readJson = (relative) => JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8"));
const execBase = "../../conformance/frozen/executor/606074456ca00681fac30a40ee28f7bb0f67c79c/tests/fixtures/";
const visionBase = "../../conformance/frozen/vision/f20e2c2e35cbcb9b675c9c1a0568de2e40b5eb82/tests/fixtures/post_action_verification_result_v1/";
const verificationInput = readJson(visionBase + "verification_input.json");
const verificationInputCanonicalJson = readFileSync(new URL(visionBase + "verification_input.json", import.meta.url), "utf8").trimEnd();

function ids() {
  let n = 0;
  return () => `id-${++n}`;
}

function bindOutcome(name, request, { reason = null } = {}) {
  const payload = readJson(execBase + name);
  payload.request_id = request.request_id;
  payload.action = request.action;
  if (reason !== null) payload.reason = reason;
  return payload;
}

function resultWithOutcome(request, name, fields = {}) {
  return {
    request_id: request.request_id,
    action: request.action,
    ok: fields.ok ?? true,
    status: fields.status ?? "completed",
    started_at: "2026-09-27T09:00:00.000Z",
    finished_at: "2026-09-27T09:00:00.001Z",
    data: {},
    error: fields.error ?? null,
    error_kind: fields.error_kind ?? null,
    dry_run: fields.dry_run ?? false,
    outcome_evidence: bindOutcome(name, request, { reason: fields.reason ?? null }),
  };
}

function verification(statuses, counter) {
  const queue = [...statuses];
  return new VisionVerificationResultV1Adapter({
    readResult: async () => {
      counter.count += 1;
      return readJson(visionBase + queue.shift() + ".json");
    },
  });
}

function spec(extra = {}) {
  return {
    provider: "help-pc-1",
    type: "vision.target.invoke",
    input: { target: { contract_version: "vision.grounded_target.v1" } },
    verification: {
      provider: "vision-2",
      type: "post_action.verify",
      input: { verificationInput, verificationInputCanonicalJson },
    },
    ...extra,
  };
}

test("flow a: not_started retryable pre-dispatch error permits bounded execution retry", async () => {
  let calls = 0;
  const adapter = new HelpPc1Adapter({
    dryRun: false,
    invoke: async (request) => {
      calls += 1;
      if (calls === 1) {
        return resultWithOutcome(request, "action_outcome_v1_not_started.json", {
          ok: false,
          status: "transient",
          error: "transport unavailable before effect",
          error_kind: "transient",
          reason: "transient",
        });
      }
      return resultWithOutcome(request, "action_outcome_v1.json");
    },
  });
  const cp = new ControlPlane({ providers: [adapter], idFactory: ids() });
  const session = cp.createSession({ desktopId: "desk" });
  const action = cp.enqueueAction(session.id, {
    provider: "help-pc-1",
    type: "keyboard.press",
    input: { key: "enter" },
    maxAttempts: 2,
  });
  const first = await cp.processNext();
  assert.equal(first.status, "retry_wait");
  assert.equal(first.executionAttempts, 1);
  const second = await cp.processNext();
  assert.equal(second.status, "succeeded");
  assert.equal(second.executionAttempts, 2);
  assert.equal(calls, 2);
  assert.equal(cp.getAction(action.id).attempts, 2);
});

test("flow b: completed outcome only re-verifies after stale; executor never executes again", async () => {
  let calls = 0;
  const adapter = new HelpPc1Adapter({
    dryRun: false,
    invoke: async (request) => {
      calls += 1;
      return resultWithOutcome(request, "action_outcome_v1.json");
    },
  });
  const verifyCalls = { count: 0 };
  const cp = new ControlPlane({
    providers: [adapter],
    verificationProviders: [verification(["stale", "verified"], verifyCalls)],
    idFactory: ids(),
  });
  const session = cp.createSession({ desktopId: "desk" });
  const action = cp.enqueueAction(session.id, spec({ maxVerificationAttempts: 2, maxReconciliationAttempts: 2 }));
  assert.equal((await cp.processNext()).status, "reconciliation_wait");
  const final = await cp.processNext();
  assert.equal(final.status, "succeeded");
  assert.equal(calls, 1);
  assert.equal(final.executionAttempts, 1);
  assert.equal(final.verificationAttempts, 2);
  assert.equal(final.reconciliationAttempts, 1);
  assert.equal(verifyCalls.count, 2);
  assert.equal(cp.getAction(action.id).status, "succeeded");
});

test("flow c: unknown outcome enters read-only evidence/verification reconciliation", async () => {
  let calls = 0;
  let evidenceCalls = 0;
  const adapter = new HelpPc1Adapter({
    dryRun: false,
    invoke: async (request) => {
      calls += 1;
      return resultWithOutcome(request, "action_outcome_v1_unknown.json", {
        ok: false,
        status: "timeout",
        error: "deadline",
        error_kind: "timeout",
        reason: "timeout",
      });
    },
    readEvidence: async (request) => {
      evidenceCalls += 1;
      return bindOutcome("action_outcome_v1_unknown.json", {
        request_id: request.request_id,
        action: request.action,
      });
    },
  });
  const verifyCalls = { count: 0 };
  const cp = new ControlPlane({
    providers: [adapter],
    verificationProviders: [verification(["verified"], verifyCalls)],
    idFactory: ids(),
  });
  const session = cp.createSession({ desktopId: "desk" });
  const action = cp.enqueueAction(session.id, spec());
  const uncertain = await cp.processNext();
  assert.equal(uncertain.status, "uncertain_outcome");
  const final = await cp.processNext();
  assert.equal(final.status, "succeeded");
  assert.equal(calls, 1);
  assert.equal(evidenceCalls, 1);
  assert.equal(verifyCalls.count, 1);
  assert.equal(final.executionAttempts, 1);
  assert.equal(final.verificationAttempts, 1);
  assert.equal(final.reconciliationAttempts, 1);
  assert.equal(cp.getAction(action.id).status, "succeeded");
});

for (const status of ["stale", "inconclusive"]) {
  test(`flow ${status === "stale" ? "d" : "e"}: ${status} result causes bounded reverify only`, async () => {
    let calls = 0;
    const adapter = new HelpPc1Adapter({
      dryRun: false,
      invoke: async (request) => {
        calls += 1;
        return resultWithOutcome(request, "action_outcome_v1.json");
      },
    });
    const verifyCalls = { count: 0 };
    const cp = new ControlPlane({
      providers: [adapter],
      verificationProviders: [verification([status, "verified"], verifyCalls)],
      idFactory: ids(),
    });
    const session = cp.createSession({ desktopId: "desk" });
    cp.enqueueAction(session.id, spec({ maxVerificationAttempts: 2, maxReconciliationAttempts: 2 }));
    assert.equal((await cp.processNext()).status, "reconciliation_wait");
    const final = await cp.processNext();
    assert.equal(final.status, "succeeded");
    assert.equal(calls, 1);
    assert.equal(verifyCalls.count, 2);
    assert.equal(final.executionAttempts, 1);
  });
}

test("flow f: failed verification terminates without implicit duplicate side effect", async () => {
  let calls = 0;
  const adapter = new HelpPc1Adapter({
    dryRun: false,
    invoke: async (request) => {
      calls += 1;
      return resultWithOutcome(request, "action_outcome_v1.json");
    },
  });
  const verifyCalls = { count: 0 };
  const cp = new ControlPlane({
    providers: [adapter],
    verificationProviders: [verification(["failed"], verifyCalls)],
    idFactory: ids(),
  });
  const session = cp.createSession({ desktopId: "desk" });
  cp.enqueueAction(session.id, spec());
  const final = await cp.processNext();
  assert.equal(final.status, "failed");
  assert.equal(final.error.code, "VISION_VERIFICATION_FAILED");
  assert.equal(calls, 1);
  assert.equal(verifyCalls.count, 1);
  assert.equal(await cp.processNext(), null);
});

test("flow g: verified result succeeds original logical action", async () => {
  let calls = 0;
  const adapter = new HelpPc1Adapter({
    dryRun: false,
    invoke: async (request) => {
      calls += 1;
      return resultWithOutcome(request, "action_outcome_v1.json");
    },
  });
  const verifyCalls = { count: 0 };
  const cp = new ControlPlane({
    providers: [adapter],
    verificationProviders: [verification(["verified"], verifyCalls)],
    idFactory: ids(),
  });
  const session = cp.createSession({ desktopId: "desk" });
  const action = cp.enqueueAction(session.id, spec({ idempotencyKey: "logical-action" }));
  const final = await cp.processNext();
  assert.equal(final.status, "succeeded");
  assert.equal(final.id, action.id);
  assert.equal(calls, 1);
  assert.equal(verifyCalls.count, 1);
});

test("deterministic cross-repo E2E report matches frozen report fixture", async () => {
  let sideEffectProviderCalls = 0;
  let executorEvidenceCalls = 0;
  const adapter = new HelpPc1Adapter({
    dryRun: false,
    invoke: async (request) => {
      sideEffectProviderCalls += 1;
      return resultWithOutcome(request, "action_outcome_v1_unknown.json", {
        ok: false,
        status: "timeout",
        error: "deadline",
        error_kind: "timeout",
        reason: "timeout",
      });
    },
    readEvidence: async (request) => {
      executorEvidenceCalls += 1;
      return bindOutcome("action_outcome_v1_unknown.json", {
        request_id: request.request_id,
        action: request.action,
      });
    },
  });
  const observations = { count: 0 };
  const cp = new ControlPlane({
    providers: [adapter],
    verificationProviders: [verification(["verified"], observations)],
    idFactory: ids(),
  });
  const session = cp.createSession({ desktopId: "desk" });
  const action = cp.enqueueAction(session.id, spec({ correlationId: "cross-repo-report" }));
  assert.equal((await cp.processNext()).status, "uncertain_outcome");
  const final = await cp.processNext();
  const transitionTrace = cp.getAuditLog({ correlationId: action.correlationId }).map((entry) =>
    entry.event === "action.leased" ? `${entry.event}:${entry.mode}` : entry.event
  );
  const actual = {
    schema: "pc_control.cross_repo_reconciliation_e2e_report.v1",
    executor_head: "606074456ca00681fac30a40ee28f7bb0f67c79c",
    vision_head: "f20e2c2e35cbcb9b675c9c1a0568de2e40b5eb82",
    scenario: "unknown-outcome-read-only-verification-success",
    terminalStatus: final.status,
    counters: {
      executionAttempts: final.executionAttempts,
      verificationAttempts: final.verificationAttempts,
      reconciliationAttempts: final.reconciliationAttempts,
      sideEffectProviderCalls,
      executorEvidenceCalls,
      observationCalls: observations.count,
    },
    transitionTrace,
  };
  const expected = readJson("../../conformance/reports/frozen-pc-reconciliation-e2e.json");
  assert.deepEqual(actual, expected);
});
