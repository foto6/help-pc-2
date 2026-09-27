import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  ControlPlane,
  HelpPc1Adapter,
} from "../src/index.js";
import {
  bindPreflightResult,
  frozenCapabilities,
  mutateCapabilities,
} from "./support/preflight-fixtures.js";
import { bindFrozenJournalLookup } from "./support/journal-fixtures.js";

const OUTCOME = JSON.parse(readFileSync(new URL(
  "../conformance/frozen/executor/606074456ca00681fac30a40ee28f7bb0f67c79c/tests/fixtures/action_outcome_v1.json",
  import.meta.url,
), "utf8"));

function ids() {
  let n = 0;
  return () => `wave7-${++n}`;
}

function completed(request) {
  const evidence = structuredClone(OUTCOME);
  evidence.request_id = request.request_id;
  evidence.action = request.action;
  return {
    request_id: request.request_id,
    action: request.action,
    ok: true,
    status: "completed",
    started_at: "2026-09-27T11:30:00.000Z",
    finished_at: "2026-09-27T11:30:00.001Z",
    data: {},
    error: null,
    error_kind: null,
    dry_run: false,
    outcome_evidence: evidence,
  };
}

function runtime({
  preflightNames = ["ready.result.json"],
  capabilities = [frozenCapabilities()],
  maxPreflightAttempts = 3,
  actionType = "keyboard.press",
  input = { key: "enter" },
  preflightFn = null,
  capabilitiesFn = null,
  idempotencyKey = "wave7-action",
} = {}) {
  const counters = { preflight: 0, capabilities: 0, execution: 0 };
  const preflightQueue = [...preflightNames];
  const capabilityQueue = capabilities.map(structuredClone);
  let cp = null;

  const adapter = new HelpPc1Adapter({
    dryRun: false,
    invoke: async (request) => {
      counters.execution += 1;
      return completed(request);
    },
    readCapabilities: async (request, context) => {
      counters.capabilities += 1;
      if (capabilitiesFn) return capabilitiesFn(request, context, counters, cp);
      const index = Math.min(counters.capabilities - 1, capabilityQueue.length - 1);
      return structuredClone(capabilityQueue[index]);
    },
    preflight: async (request, context) => {
      counters.preflight += 1;
      if (preflightFn) return preflightFn(request, context, counters, cp);
      const name = preflightQueue.length > 1 ? preflightQueue.shift() : preflightQueue[0];
      return bindPreflightResult(name, {
        requestId: request.request.request_id,
        action: request.request.action,
        capabilitiesDigest: context.capabilitiesDigest,
      });
    },
  });

  cp = new ControlPlane({ providers: [adapter], idFactory: ids() });
  const session = cp.createSession({ desktopId: "wave7-desktop" });
  const action = cp.enqueueAction(session.id, {
    provider: "help-pc-1",
    type: actionType,
    input,
    idempotencyKey,
    maxAttempts: 2,
    maxPreflightAttempts,
  });
  return { cp, session, action, adapter, counters };
}

async function processUntilStable(cp, limit = 12) {
  let latest = null;
  for (let i = 0; i < limit; i += 1) {
    const next = await cp.processNext({ workerId: `worker-${i}` });
    if (!next) break;
    latest = next;
    if (["succeeded", "failed", "blocked", "cancelled"].includes(next.status)) break;
  }
  return latest;
}

test("ready preflight persists attestation and executes only after fresh capability check", async () => {
  const ctx = runtime();
  const preflighted = await ctx.cp.processNext();
  assert.equal(preflighted.status, "queued");
  assert.equal(preflighted.preflightStatus, "ready");
  assert.match(preflighted.preflightAttestationDigest, /^[0-9a-f]{64}$/);
  assert.equal(preflighted.preflightCapabilitiesDigest, frozenCapabilities().attestation.digest);
  assert.equal(preflighted.executionAttempts, 0);
  assert.equal(ctx.counters.execution, 0);

  const final = await ctx.cp.processNext();
  assert.equal(final.status, "succeeded");
  assert.equal(final.preflightAttempts, 1);
  assert.equal(final.executionAttempts, 1);
  assert.equal(ctx.counters.preflight, 1);
  assert.equal(ctx.counters.capabilities, 2);
  assert.equal(ctx.counters.execution, 1);
});

for (const [name, status] of [
  ["blocked.result.json", "blocked"],
  ["unsupported.result.json", "unsupported"],
  ["invalid_request.result.json", "invalid_request"],
]) {
  test(`${status} preflight is terminal and never executes`, async () => {
    const ctx = runtime({ preflightNames: [name] });
    const final = await ctx.cp.processNext();
    assert.equal(final.status, "blocked");
    assert.equal(final.executionAttempts, 0);
    assert.equal(ctx.counters.execution, 0);
    assert.equal(await ctx.cp.processNext(), null);
  });
}

for (const [name, status] of [
  ["stale_observation.result.json", "stale_observation"],
  ["ambiguous_target.result.json", "ambiguous_target"],
]) {
  test(`${status} performs bounded read-only re-preflight before one execute`, async () => {
    const ctx = runtime({ preflightNames: [name, "ready.result.json"] });
    const first = await ctx.cp.processNext();
    assert.equal(first.status, "preflight_wait");
    assert.equal(first.executionAttempts, 0);
    assert.equal(first.observationAttempts, 1);
    assert.equal(ctx.counters.execution, 0);

    const second = await ctx.cp.processNext();
    assert.equal(second.status, "queued");
    assert.equal(second.preflightStatus, "ready");
    assert.equal(second.executionAttempts, 0);

    const final = await ctx.cp.processNext();
    assert.equal(final.status, "succeeded");
    assert.equal(final.preflightAttempts, 2);
    assert.equal(final.observationAttempts, 1);
    assert.equal(final.executionAttempts, 1);
    assert.equal(ctx.counters.execution, 1);
  });
}

test("preflight timeout retries read-only and never increments executionAttempts", async () => {
  let calls = 0;
  const ctx = runtime({
    preflightFn: (request, context) => {
      calls += 1;
      if (calls === 1) {
        const error = new Error("preflight timeout");
        error.code = "PREFLIGHT_TIMEOUT";
        error.category = "preflight_timeout";
        error.retryable = true;
        throw error;
      }
      return bindPreflightResult("ready.result.json", {
        requestId: request.request.request_id,
        action: request.request.action,
        capabilitiesDigest: context.capabilitiesDigest,
      });
    },
  });
  assert.equal((await ctx.cp.processNext()).status, "preflight_wait");
  assert.equal(ctx.cp.getAction(ctx.action.id).executionAttempts, 0);
  assert.equal((await ctx.cp.processNext()).status, "queued");
  const final = await ctx.cp.processNext();
  assert.equal(final.status, "succeeded");
  assert.equal(final.preflightAttempts, 2);
  assert.equal(final.executionAttempts, 1);
  assert.equal(ctx.counters.execution, 1);
});

test("ready attestation followed by capability drift requires re-preflight before execution", async () => {
  const drifted = mutateCapabilities((payload) => {
    payload.safety.coordinate_fallback_enabled = true;
  });
  const ctx = runtime({ capabilities: [frozenCapabilities(), drifted, drifted, drifted] });

  assert.equal((await ctx.cp.processNext()).status, "queued");
  const drift = await ctx.cp.processNext();
  assert.equal(drift.status, "preflight_wait");
  assert.equal(drift.executionAttempts, 0);
  assert.equal(drift.capabilityDriftCount, 1);
  assert.equal(ctx.counters.execution, 0);

  assert.equal((await ctx.cp.processNext()).status, "queued");
  const final = await ctx.cp.processNext();
  assert.equal(final.status, "succeeded");
  assert.equal(final.preflightAttempts, 2);
  assert.equal(final.capabilityDriftCount, 1);
  assert.equal(final.executionAttempts, 1);
  assert.equal(ctx.counters.execution, 1);
});

test("capability adapter becoming unavailable after ready is bounded and never executes", async () => {
  let capabilityCalls = 0;
  const ctx = runtime({
    maxPreflightAttempts: 2,
    capabilitiesFn: () => {
      capabilityCalls += 1;
      if (capabilityCalls === 1) return frozenCapabilities();
      const error = new Error("capabilities adapter unavailable");
      error.code = "CAPABILITIES_UNAVAILABLE";
      error.category = "capabilities_unavailable";
      error.retryable = true;
      throw error;
    },
  });
  assert.equal((await ctx.cp.processNext()).status, "queued");
  assert.equal((await ctx.cp.processNext()).status, "preflight_wait");
  const final = await ctx.cp.processNext();
  assert.equal(final.status, "blocked");
  assert.equal(final.executionAttempts, 0);
  assert.equal(ctx.counters.execution, 0);
});

test("malformed preflight binding fails closed in Control before execution", async () => {
  const ctx = runtime({
    preflightFn: (request, context) => bindPreflightResult("ready.result.json", {
      requestId: `${request.request.request_id}-other`,
      action: request.request.action,
      capabilitiesDigest: context.capabilitiesDigest,
    }),
  });
  const final = await ctx.cp.processNext();
  assert.equal(final.status, "blocked");
  assert.equal(final.executionAttempts, 0);
  assert.equal(ctx.counters.execution, 0);
  assert.match(final.error.code, /EXECUTOR_PREFLIGHT_BINDING_MISMATCH|PREFLIGHT_INVALID/);
});

test("malformed capabilities attestation fails closed in Control before preflight or execution", async () => {
  const ctx = runtime({
    capabilitiesFn: () => {
      const payload = frozenCapabilities();
      payload.attestation.digest = "0".repeat(64);
      return payload;
    },
  });
  const final = await ctx.cp.processNext();
  assert.equal(final.status, "blocked");
  assert.equal(final.executionAttempts, 0);
  assert.equal(ctx.counters.preflight, 0);
  assert.equal(ctx.counters.execution, 0);
});

test("unsupported shell preflight blocks without shell execution", async () => {
  const ctx = runtime({
    actionType: "shell.run",
    input: { argv: ["git", "status"] },
    preflightNames: ["unsupported.result.json"],
  });
  const final = await ctx.cp.processNext();
  assert.equal(final.status, "blocked");
  assert.equal(final.executionAttempts, 0);
  assert.equal(ctx.counters.execution, 0);
});

test("target disappearance exhausts read-only preflight without side effect", async () => {
  const ctx = runtime({
    actionType: "uia.invoke",
    input: { query: { automation_id: "save" } },
    preflightNames: ["stale_observation.result.json"],
    maxPreflightAttempts: 2,
  });
  assert.equal((await ctx.cp.processNext()).status, "preflight_wait");
  const final = await ctx.cp.processNext();
  assert.equal(final.status, "blocked");
  assert.equal(final.preflightAttempts, 2);
  assert.equal(final.observationAttempts, 2);
  assert.equal(final.executionAttempts, 0);
  assert.equal(ctx.counters.execution, 0);
});

test("cancellation during preflight is terminal and cannot resurrect", async () => {
  const ctx = runtime({
    preflightFn: (request, context, counters, cp) => {
      cp.cancelAction(request.request.request_id, "cancel-during-preflight");
      return bindPreflightResult("ready.result.json", {
        requestId: request.request.request_id,
        action: request.request.action,
        capabilitiesDigest: context.capabilitiesDigest,
      });
    },
  });
  const final = await ctx.cp.processNext();
  assert.equal(final.status, "cancelled");
  assert.equal(final.executionAttempts, 0);
  assert.equal(ctx.counters.execution, 0);
  const restarted = new ControlPlane({ providers: [ctx.adapter], snapshot: ctx.cp.snapshot(), idFactory: ids() });
  assert.equal(restarted.getAction(ctx.action.id).status, "cancelled");
  assert.equal(await restarted.processNext(), null);
});

test("idempotent duplicate survives preflight restart and executes one logical action", async () => {
  const ctx = runtime();
  const duplicate = ctx.cp.enqueueAction(ctx.session.id, {
    provider: "help-pc-1",
    type: "keyboard.press",
    input: { key: "enter" },
    idempotencyKey: "wave7-action",
  });
  assert.equal(duplicate.id, ctx.action.id);
  assert.equal((await ctx.cp.processNext()).status, "queued");

  const restarted = new ControlPlane({ providers: [ctx.adapter], snapshot: ctx.cp.snapshot(), idFactory: ids() });
  const duplicateAfterRestart = restarted.enqueueAction(ctx.session.id, {
    provider: "help-pc-1",
    type: "keyboard.press",
    input: { key: "enter" },
    idempotencyKey: "wave7-action",
  });
  assert.equal(duplicateAfterRestart.id, ctx.action.id);
  const final = await restarted.processNext();
  assert.equal(final.status, "succeeded");
  assert.equal(ctx.counters.execution, 1);
});

test("restart while awaiting re-preflight resumes read-only before execution", async () => {
  const ctx = runtime({ preflightNames: ["stale_observation.result.json", "ready.result.json"] });
  assert.equal((await ctx.cp.processNext()).status, "preflight_wait");
  const restarted = new ControlPlane({ providers: [ctx.adapter], snapshot: ctx.cp.snapshot(), idFactory: ids() });
  assert.equal(restarted.getAction(ctx.action.id).status, "preflight_wait");
  assert.equal((await restarted.processNext()).status, "queued");
  assert.equal(ctx.counters.execution, 0);
  const final = await restarted.processNext();
  assert.equal(final.status, "succeeded");
  assert.equal(ctx.counters.execution, 1);
});

test("restart from in-flight preflight returns to preflight_wait, never execute", () => {
  const ctx = runtime();
  const leased = ctx.cp.leaseNext({ workerId: "crashed-preflight" });
  assert.equal(leased.lease.mode, "preflight");
  const snapshot = ctx.cp.snapshot();
  const action = snapshot.actions.find((item) => item.id === ctx.action.id);
  action.status = "preflighting";
  const restarted = new ControlPlane({ providers: [ctx.adapter], snapshot, idFactory: ids() });
  const recovered = restarted.getAction(ctx.action.id);
  assert.equal(recovered.status, "preflight_wait");
  assert.equal(recovered.executionAttempts, 0);
  assert.equal(ctx.counters.execution, 0);
});

test("non-ready preflight statuses never transition to execute in bounded restart/process sequences", async () => {
  for (const name of ["blocked.result.json", "unsupported.result.json", "invalid_request.result.json", "stale_observation.result.json", "ambiguous_target.result.json"]) {
    const ctx = runtime({ preflightNames: [name], maxPreflightAttempts: 1, idempotencyKey: `property-${name}` });
    let cp = ctx.cp;
    for (const event of ["process", "restart", "process", "restart"]) {
      if (event === "restart") cp = new ControlPlane({ providers: [ctx.adapter], snapshot: cp.snapshot(), idFactory: ids() });
      else await cp.processNext();
      assert.equal(ctx.counters.execution, 0, name);
      assert.equal(cp.getAction(ctx.action.id).executionAttempts, 0, name);
    }
  }
});

test("ready preflight does not weaken at-most-once behavior after uncertain dispatch", async () => {
  let sideEffects = 0;
  const caps = frozenCapabilities();
  const adapter = new HelpPc1Adapter({
    dryRun: false,
    readCapabilities: async () => structuredClone(caps),
    preflight: async (request, context) => bindPreflightResult("ready.result.json", {
      requestId: request.request.request_id,
      action: request.request.action,
      capabilitiesDigest: context.capabilitiesDigest,
    }),
    invoke: async () => {
      sideEffects += 1;
      const error = new Error("transport lost after dispatch");
      error.code = "EXECUTOR_TIMEOUT";
      error.category = "timeout";
      error.dispatchState = "unknown";
      error.outcomeUncertain = true;
      throw error;
    },
    readEvidence: async (request) => bindFrozenJournalLookup("unknown.lookup.json", {
      requestId: request.request_id,
      action: request.action,
      executionAttempt: request.execution_attempt,
    }),
  });
  let cp = new ControlPlane({ providers: [adapter], idFactory: ids() });
  const session = cp.createSession({ desktopId: "uncertain-preflight-desktop" });
  const action = cp.enqueueAction(session.id, {
    provider: "help-pc-1",
    type: "keyboard.press",
    input: { key: "enter" },
    maxReconciliationAttempts: 3,
  });
  assert.equal((await cp.processNext()).status, "queued");
  assert.equal((await cp.processNext()).status, "uncertain_outcome");
  assert.equal(sideEffects, 1);

  for (let i = 0; i < 5; i += 1) {
    cp = new ControlPlane({ providers: [adapter], snapshot: cp.snapshot(), idFactory: ids() });
    await cp.processNext();
    assert.equal(sideEffects, 1);
    assert.equal(cp.getAction(action.id).executionAttempts, 1);
  }
});

test("metrics keep preflight/observation/execution/verification/reconciliation counters separate", async () => {
  const ctx = runtime({ preflightNames: ["stale_observation.result.json", "ready.result.json"] });
  await processUntilStable(ctx.cp);
  const metrics = ctx.cp.getMetrics();
  assert.equal(metrics.preflightAttempts, 2);
  assert.equal(metrics.observationAttempts, 1);
  assert.equal(metrics.executionAttempts, 1);
  assert.equal(metrics.verificationAttempts, 0);
  assert.equal(metrics.reconciliationAttempts, 0);
  assert.equal(metrics.capabilityChecks >= 3, true);
});

test("deterministic preflight recovery report matches frozen report", async () => {
  const scenarios = [];

  for (const scenario of [
    { name: "ready", options: {} },
    { name: "stale_then_ready", options: { preflightNames: ["stale_observation.result.json", "ready.result.json"] } },
    { name: "ambiguous_then_ready", options: { preflightNames: ["ambiguous_target.result.json", "ready.result.json"] } },
    { name: "blocked", options: { preflightNames: ["blocked.result.json"] } },
  ]) {
    const ctx = runtime({ ...scenario.options, idempotencyKey: `report-${scenario.name}` });
    const final = await processUntilStable(ctx.cp);
    const transitionTrace = ctx.cp.getAuditLog()
      .filter((entry) => entry.actionId === ctx.action.id)
      .map((entry) => ({
        event: entry.event,
        mode: entry.mode ?? null,
        reason: entry.reason ?? null,
        preflightAttempt: entry.preflightAttempt ?? null,
        executionAttempt: entry.executionAttempt ?? null,
      }));
    const evidence = {
      status: final.status,
      preflightAttempts: final.preflightAttempts,
      observationAttempts: final.observationAttempts,
      executionAttempts: final.executionAttempts,
      verificationAttempts: final.verificationAttempts,
      reconciliationAttempts: final.reconciliationAttempts,
      sideEffectProviderCalls: ctx.counters.execution,
      capabilityChecks: ctx.counters.capabilities,
      preflightCalls: ctx.counters.preflight,
      attestationDigest: final.preflightAttestationDigest,
      capabilitiesDigest: final.preflightCapabilitiesDigest,
    };
    scenarios.push({
      name: scenario.name,
      ...evidence,
      transitionHash: createHash("sha256").update(JSON.stringify(transitionTrace)).digest("hex"),
      evidenceHash: createHash("sha256").update(JSON.stringify(evidence)).digest("hex"),
    });
  }

  const base = {
    schema: "pc_control.preflight_admission_report.v1",
    executorHead: "d0ccb0f390474fc3fc091e51c25f7ef8771b0f09",
    controlBaseHead: "ead172d3a54eeb861599ec5b0bbf4fd4a51bdfdc",
    scenarios,
  };
  const actual = {
    ...base,
    aggregateTransitionEvidenceHash: createHash("sha256").update(JSON.stringify(base)).digest("hex"),
  };
  const expected = JSON.parse(readFileSync(
    new URL("../conformance/reports/preflight-admission-v1.json", import.meta.url),
    "utf8",
  ));
  assert.deepEqual(actual, expected);
});
