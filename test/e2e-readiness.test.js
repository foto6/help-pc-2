import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ControlPlane,
  HelpPc1Adapter,
  VisionSensorReconciliationAdapter,
  canonicalSha256,
} from "../src/index.js";
import {
  bindPreflightResult,
  frozenCapabilities,
  mutateCapabilities,
} from "./support/preflight-fixtures.js";
import {
  TARGET,
  bindJournalLookup,
  completedResult,
  readExecutorJson,
  readVisionJson,
  readVisionText,
  sensorBundle,
  unknownDispatchError,
  verificationInput,
  wrongTargetBundle,
} from "./support/e2e-readiness-fixtures.js";

const EXECUTOR_HEAD = "d0ccb0f390474fc3fc091e51c25f7ef8771b0f09";
const VISION_HEAD = "df9a84590a4a9d8fe8dfdec9ff195fe4821397f6";

function ids(prefix = "wave8") {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

function actionSpec(idempotencyKey = "wave8-logical-action") {
  const input = verificationInput();
  return {
    provider: "help-pc-1",
    type: "vision.target.invoke",
    input: { target: readVisionJson("grounded_target_v1.json") },
    idempotencyKey,
    maxAttempts: 2,
    maxPreflightAttempts: 4,
    maxVerificationAttempts: 4,
    maxReconciliationAttempts: 4,
    verification: {
      provider: "vision-2",
      type: "post_action.verify",
      input: {
        verificationInput: input,
        verificationInputCanonicalJson: readVisionText("post_action_verification_result_v1/verification_input.json"),
        targetIdentity: TARGET,
      },
    },
  };
}

function runtime({
  preflightNames = ["ready.result.json"],
  capabilities = [frozenCapabilities()],
  journalNames = ["unknown.lookup.json"],
  sensorBundles = [sensorBundle()],
  invoke = null,
  preflight = null,
  readJournal = null,
  readSensor = null,
  idempotencyKey = "wave8-logical-action",
} = {}) {
  const counters = {
    capabilities: 0,
    preflight: 0,
    readOnlyReobservations: 0,
    sideEffectProviderCalls: 0,
    journalReads: 0,
    sensorReads: 0,
    readOnlyRecaptures: 0,
  };
  const preflightQueue = [...preflightNames];
  const capabilityQueue = capabilities.map((item) => structuredClone(item));
  const journalQueue = [...journalNames];
  const sensorQueue = sensorBundles.map((item) => structuredClone(item));
  let cp = null;

  const executor = new HelpPc1Adapter({
    dryRun: false,
    invoke: async (request, context) => {
      counters.sideEffectProviderCalls += 1;
      if (invoke) return invoke(request, context, counters, cp);
      return completedResult(request);
    },
    readCapabilities: async () => {
      counters.capabilities += 1;
      const index = Math.min(counters.capabilities - 1, capabilityQueue.length - 1);
      return structuredClone(capabilityQueue[index]);
    },
    preflight: async (request, context) => {
      counters.preflight += 1;
      if (preflight) return preflight(request, context, counters, cp);
      const name = preflightQueue.length > 1 ? preflightQueue.shift() : preflightQueue[0];
      return bindPreflightResult(name, {
        requestId: request.request.request_id,
        action: request.request.action,
        capabilitiesDigest: context.capabilitiesDigest,
      });
    },
    readEvidence: async (request, context) => {
      counters.journalReads += 1;
      if (readJournal) return readJournal(request, context, counters, cp);
      const name = journalQueue.length > 1 ? journalQueue.shift() : journalQueue[0];
      return bindJournalLookup(name, {
        requestId: request.request_id,
        action: request.action,
        executionAttempt: request.execution_attempt,
      });
    },
  });

  const vision = new VisionSensorReconciliationAdapter({
    readEvidence: async (request, context) => {
      counters.sensorReads += 1;
      if (readSensor) return readSensor(request, context, counters, cp);
      const index = Math.min(counters.sensorReads - 1, sensorQueue.length - 1);
      return structuredClone(sensorQueue[index]);
    },
  });

  const makePlane = (snapshot = null) => new ControlPlane({
    providers: [executor],
    verificationProviders: [vision],
    ...(snapshot ? { snapshot } : {}),
    idFactory: ids(snapshot ? "restart" : "wave8"),
  });

  cp = makePlane();
  const session = cp.createSession({ desktopId: "wave8-desktop" });
  const action = cp.enqueueAction(session.id, actionSpec(idempotencyKey));

  return {
    executor,
    vision,
    counters,
    session,
    action,
    get cp() { return cp; },
    restart(snapshot = cp.snapshot()) { cp = makePlane(snapshot); return cp; },
  };
}

async function untilTerminal(ctx, limit = 12) {
  let latest = ctx.cp.getAction(ctx.action.id);
  for (let i = 0; i < limit && !["succeeded", "failed", "blocked", "cancelled"].includes(latest.status); i += 1) {
    const next = await ctx.cp.processNext({ workerId: `wave8-worker-${i}` });
    if (!next) break;
    latest = next;
  }
  return latest;
}

test("ready -> capabilities/preflight -> execute once -> consistent delta -> VERIFIED", async () => {
  const ctx = runtime();
  const ready = await ctx.cp.processNext();
  assert.equal(ready.status, "queued");
  assert.equal(ready.preflightStatus, "ready");
  assert.equal(ready.executionAttempts, 0);

  ctx.restart();
  const final = await ctx.cp.processNext();
  assert.equal(final.status, "succeeded");
  assert.equal(final.executionAttempts, 1);
  assert.equal(final.verificationAttempts, 1);
  assert.equal(ctx.counters.sideEffectProviderCalls, 1);
  assert.equal(ctx.counters.sensorReads, 1);
  assert.equal(final.verificationResult.status, "verified");
  assert.equal(final.verificationResult.consistencyStatus, "consistent");
});

for (const preflightName of ["stale_observation.result.json", "ambiguous_target.result.json"]) {
  test(`${preflightName} reobserves and re-preflights read-only before one execution`, async () => {
    const ctx = runtime({ preflightNames: [preflightName, "ready.result.json"], idempotencyKey: preflightName });
    const first = await ctx.cp.processNext();
    assert.equal(first.status, "preflight_wait");
    assert.equal(first.executionAttempts, 0);
    assert.equal(ctx.counters.sideEffectProviderCalls, 0);

    ctx.restart();
    ctx.counters.readOnlyReobservations += 1;
    assert.equal((await ctx.cp.processNext()).status, "queued");
    const final = await ctx.cp.processNext();
    assert.equal(final.status, "succeeded");
    assert.equal(final.executionAttempts, 1);
    assert.equal(ctx.counters.sideEffectProviderCalls, 1);
    assert.equal(ctx.counters.readOnlyReobservations, 1);
  });
}

test("capability drift after ready forces bounded re-preflight before dispatch", async () => {
  const drifted = mutateCapabilities((payload) => {
    payload.safety.coordinate_fallback_enabled = true;
  });
  const ctx = runtime({ capabilities: [frozenCapabilities(), drifted, drifted, drifted] });
  assert.equal((await ctx.cp.processNext()).status, "queued");
  const drift = await ctx.cp.processNext();
  assert.equal(drift.status, "preflight_wait");
  assert.equal(drift.executionAttempts, 0);
  assert.equal(ctx.counters.sideEffectProviderCalls, 0);
  ctx.restart();
  assert.equal((await ctx.cp.processNext()).status, "queued");
  const final = await ctx.cp.processNext();
  assert.equal(final.status, "succeeded");
  assert.equal(final.preflightAttempts, 2);
  assert.equal(final.capabilityDriftCount, 1);
  assert.equal(ctx.counters.sideEffectProviderCalls, 1);
});

test("unknown outcome journal never reexecutes and reconciles through sensors only", async () => {
  const ctx = runtime({
    invoke: async () => { throw unknownDispatchError(); },
    journalNames: ["unknown.lookup.json"],
  });
  assert.equal((await ctx.cp.processNext()).status, "queued");
  const uncertain = await ctx.cp.processNext();
  assert.equal(uncertain.status, "uncertain_outcome");
  assert.equal(ctx.counters.sideEffectProviderCalls, 1);

  ctx.restart();
  const final = await ctx.cp.processNext();
  assert.equal(final.status, "succeeded");
  assert.equal(final.executionAttempts, 1);
  assert.equal(final.reconciliationAttempts, 1);
  assert.equal(ctx.counters.sideEffectProviderCalls, 1);
  assert.equal(ctx.counters.journalReads, 1);
  assert.equal(ctx.counters.sensorReads, 1);
});

test("completed journal after restart performs verification only", async () => {
  const ctx = runtime({
    invoke: async () => { throw unknownDispatchError(); },
    journalNames: ["completed.lookup.json"],
  });
  assert.equal((await ctx.cp.processNext()).status, "queued");
  assert.equal((await ctx.cp.processNext()).status, "uncertain_outcome");
  ctx.restart();
  const final = await ctx.cp.processNext();
  assert.equal(final.status, "succeeded");
  assert.equal(final.executionAttempts, 1);
  assert.equal(final.reconciliationAttempts, 1);
  assert.equal(ctx.counters.sideEffectProviderCalls, 1);
  assert.equal(ctx.counters.journalReads, 1);
  assert.equal(ctx.counters.sensorReads, 1);
});

for (const [consistency, expectedCode] of [
  ["semantic_delta_contradiction.json", "VISION_OBSERVATION_CONFLICT"],
  ["stale_screenshot.json", "VISION_SENSOR_STALE"],
]) {
  test(`Vision ${consistency} causes read-only recapture/reverify, never side-effect retry`, async () => {
    const ctx = runtime({
      sensorBundles: [
        sensorBundle({ consistency }),
        sensorBundle(),
      ],
      idempotencyKey: consistency,
    });
    assert.equal((await ctx.cp.processNext()).status, "queued");
    const firstVerify = await ctx.cp.processNext();
    assert.equal(firstVerify.status, "reconciliation_wait");
    assert.equal(firstVerify.error.code, expectedCode);
    assert.equal(ctx.counters.sideEffectProviderCalls, 1);

    ctx.restart();
    ctx.counters.readOnlyRecaptures += 1;
    const final = await ctx.cp.processNext();
    assert.equal(final.status, "succeeded");
    assert.equal(final.executionAttempts, 1);
    assert.equal(final.verificationAttempts, 2);
    assert.equal(ctx.counters.sideEffectProviderCalls, 1);
    assert.equal(ctx.counters.readOnlyRecaptures, 1);
  });
}

test("wrong request/action/target bindings fail closed as blocked", async () => {
  const wrongPreflight = runtime({
    preflight: async (request, context) => bindPreflightResult("ready.result.json", {
      requestId: `${request.request.request_id}-wrong`,
      action: request.request.action,
      capabilitiesDigest: context.capabilitiesDigest,
    }),
    idempotencyKey: "wrong-request",
  });
  const preflightBlocked = await wrongPreflight.cp.processNext();
  assert.equal(preflightBlocked.status, "blocked");
  assert.equal(preflightBlocked.executionAttempts, 0);

  const wrongTarget = runtime({
    sensorBundles: [wrongTargetBundle()],
    idempotencyKey: "wrong-target",
  });
  assert.equal((await wrongTarget.cp.processNext()).status, "queued");
  const targetBlocked = await wrongTarget.cp.processNext();
  assert.equal(targetBlocked.status, "blocked");
  assert.equal(targetBlocked.executionAttempts, 1);
  assert.equal(wrongTarget.counters.sideEffectProviderCalls, 1);
  assert.equal(await wrongTarget.cp.processNext(), null);

  const wrongJournal = runtime({
    invoke: async () => { throw unknownDispatchError(); },
    readJournal: async (request) => bindJournalLookup("unknown.lookup.json", {
      requestId: `${request.request_id}-wrong`,
      action: request.action,
      executionAttempt: request.execution_attempt,
    }),
    idempotencyKey: "wrong-journal",
  });
  assert.equal((await wrongJournal.cp.processNext()).status, "queued");
  assert.equal((await wrongJournal.cp.processNext()).status, "uncertain_outcome");
  wrongJournal.restart();
  const journalBlocked = await wrongJournal.cp.processNext();
  assert.equal(journalBlocked.status, "blocked");
  assert.equal(journalBlocked.executionAttempts, 1);
  assert.equal(wrongJournal.counters.sideEffectProviderCalls, 1);
});

function forceBoundary(ctx, status, { verificationRecorded = false } = {}) {
  const snapshot = ctx.cp.snapshot();
  const action = snapshot.actions.find((item) => item.id === ctx.action.id);
  const now = Date.now();
  action.preflightStatus = "ready";
  action.preflightCapabilitiesDigest = frozenCapabilities().attestation.digest;
  action.preflightAttestationDigest = "1".repeat(64);
  action.preflightCapabilities = { digest: frozenCapabilities().attestation.digest };
  action.executionAttempts = 1;
  action.attempts = 1;
  action.executionOutcome = status === "executing" || status === "uncertain_outcome" ? null : "succeeded";
  action.executorEvidence = null;
  action.status = status;
  action.updatedAt = new Date(now).toISOString();
  action.uncertainty = ["uncertain_outcome", "reconciling", "reconciliation_wait"].includes(status)
    ? { reason: "wave8-boundary", since: new Date(now).toISOString(), executionAttempt: 1, cancellationRequested: false }
    : null;
  action.verificationAttempts = ["verifying", "reconciling", "reconciliation_wait"].includes(status) ? 1 : 0;
  action.reconciliationAttempts = ["reconciling", "reconciliation_wait"].includes(status) ? 1 : 0;
  if (verificationRecorded) {
    action.verificationResult = {
      ok: true,
      conclusive: true,
      status: "verified",
      consistencyStatus: "consistent",
    };
  }
  snapshot.queue = ["uncertain_outcome", "reconciliation_wait"].includes(status) ? [action.id] : [];
  snapshot.resourceLocks = [];
  if (["executing", "verifying"].includes(status)) {
    action.lease = {
      mode: "execute",
      workerId: "crashed",
      lanes: action.lanes,
      acquiredAt: new Date(now).toISOString(),
      acquiredAtMs: now,
      expiresAt: new Date(now + 60_000).toISOString(),
      expiresAtMs: now + 60_000,
    };
  } else if (status === "reconciling") {
    const lanes = [...new Set([...action.lanes, `observation:${action.desktopId}`])];
    action.lease = {
      mode: "reconcile",
      workerId: "crashed",
      lanes,
      acquiredAt: new Date(now).toISOString(),
      acquiredAtMs: now,
      expiresAt: new Date(now + 60_000).toISOString(),
      expiresAtMs: now + 60_000,
    };
  } else action.lease = null;
  ctx.counters.sideEffectProviderCalls = 1;
  return snapshot;
}

test("restart at every post-dispatch durable boundary never reexecutes", async () => {
  for (const boundary of [
    ["executing", false],
    ["uncertain_outcome", false],
    ["reconciling", false],
    ["verifying", false],
    ["verifying", true],
  ]) {
    const [status, verificationRecorded] = boundary;
    const ctx = runtime({
      journalNames: ["completed.lookup.json"],
      idempotencyKey: `restart-${status}-${verificationRecorded}`,
    });
    const snapshot = forceBoundary(ctx, status, { verificationRecorded });
    ctx.restart(snapshot);
    const recovered = ctx.cp.getAction(ctx.action.id);
    assert.ok(["uncertain_outcome", "reconciliation_wait"].includes(recovered.status), `${status} -> ${recovered.status}`);
    const final = await untilTerminal(ctx);
    assert.equal(final.status, "succeeded");
    assert.equal(final.executionAttempts, 1);
    assert.equal(ctx.counters.sideEffectProviderCalls, 1);
  }
});

test("restart at preflight_wait and queued-ready remains pre-dispatch", async () => {
  const waiting = runtime({ preflightNames: ["stale_observation.result.json", "ready.result.json"], idempotencyKey: "restart-preflight-wait" });
  assert.equal((await waiting.cp.processNext()).status, "preflight_wait");
  waiting.restart();
  assert.equal(waiting.cp.getAction(waiting.action.id).status, "preflight_wait");
  assert.equal(waiting.counters.sideEffectProviderCalls, 0);

  const ready = runtime({ idempotencyKey: "restart-queued-ready" });
  assert.equal((await ready.cp.processNext()).status, "queued");
  ready.restart();
  const restored = ready.cp.getAction(ready.action.id);
  assert.equal(restored.status, "queued");
  assert.equal(restored.preflightStatus, "ready");
  assert.equal(restored.executionAttempts, 0);
  assert.equal(ready.counters.sideEffectProviderCalls, 0);
});

test("cancellation at every lifecycle phase never creates a duplicate side effect", async () => {
  const preflightWait = runtime({ preflightNames: ["stale_observation.result.json"], idempotencyKey: "cancel-preflight" });
  assert.equal((await preflightWait.cp.processNext()).status, "preflight_wait");
  assert.equal(preflightWait.cp.cancelAction(preflightWait.action.id, "cancel-preflight").status, "cancelled");
  assert.equal(preflightWait.counters.sideEffectProviderCalls, 0);

  const queuedReady = runtime({ idempotencyKey: "cancel-ready" });
  assert.equal((await queuedReady.cp.processNext()).status, "queued");
  assert.equal(queuedReady.cp.cancelAction(queuedReady.action.id, "cancel-ready").status, "cancelled");
  assert.equal(queuedReady.counters.sideEffectProviderCalls, 0);

  for (const [status, recorded] of [
    ["executing", false],
    ["uncertain_outcome", false],
    ["reconciling", false],
    ["verifying", false],
    ["verifying", true],
  ]) {
    const ctx = runtime({
      journalNames: ["completed.lookup.json"],
      idempotencyKey: `cancel-${status}-${recorded}`,
    });
    ctx.restart(forceBoundary(ctx, status, { verificationRecorded: recorded }));
    ctx.cp.cancelAction(ctx.action.id, `cancel-${status}`);
    await untilTerminal(ctx);
    assert.equal(ctx.counters.sideEffectProviderCalls, 1, status);
    assert.equal(ctx.cp.getAction(ctx.action.id).executionAttempts, 1, status);
  }
});

function permutations(events, length, prefix = []) {
  if (length === 0) return [prefix];
  return events.flatMap((event) => permutations(events, length - 1, [...prefix, event]));
}

test("bounded event permutations preserve at-most-one side effect after uncertain dispatch", async () => {
  for (const sequence of permutations(["restart", "process", "cancel"], 3)) {
    const ctx = runtime({
      invoke: async () => { throw unknownDispatchError(); },
      journalNames: ["unknown.lookup.json"],
      sensorBundles: [sensorBundle({ consistency: "semantic_delta_contradiction.json" })],
      idempotencyKey: `perm-${sequence.join("-")}`,
    });
    assert.equal((await ctx.cp.processNext()).status, "queued");
    assert.equal((await ctx.cp.processNext()).status, "uncertain_outcome");
    for (const event of sequence) {
      if (event === "restart") ctx.restart();
      else if (event === "process") await ctx.cp.processNext();
      else ctx.cp.cancelAction(ctx.action.id, "property-cancel");
      assert.equal(ctx.counters.sideEffectProviderCalls, 1, sequence.join(","));
      assert.equal(ctx.cp.getAction(ctx.action.id).executionAttempts, 1, sequence.join(","));
      const duplicateExecuteLeases = ctx.cp.getAuditLog().filter(
        (entry) => entry.actionId === ctx.action.id && entry.event === "action.leased" && entry.mode === "execute",
      );
      assert.equal(duplicateExecuteLeases.length, 1, sequence.join(","));
    }
  }
});

function reportEntry(name, ctx, final) {
  const trace = ctx.cp.getAuditLog({ correlationId: final.correlationId }).map((entry) => ({
    event: entry.event,
    mode: entry.mode ?? null,
    reason: entry.reason ?? null,
    status: entry.status ?? null,
    preflightAttempt: entry.preflightAttempt ?? null,
    executionAttempt: entry.executionAttempt ?? null,
    verificationAttempt: entry.verificationAttempt ?? null,
    reconciliationAttempt: entry.reconciliationAttempt ?? null,
  }));
  const evidence = {
    terminalStatus: final.status,
    preflightAttempts: final.preflightAttempts,
    observationAttempts: final.observationAttempts,
    executionAttempts: final.executionAttempts,
    reconciliationAttempts: final.reconciliationAttempts,
    verificationAttempts: final.verificationAttempts,
    sideEffectProviderCalls: ctx.counters.sideEffectProviderCalls,
    capabilityChecks: ctx.counters.capabilities,
    preflightCalls: ctx.counters.preflight,
    journalReads: ctx.counters.journalReads,
    sensorReads: ctx.counters.sensorReads,
    readOnlyReobservations: ctx.counters.readOnlyReobservations,
    readOnlyRecaptures: ctx.counters.readOnlyRecaptures,
  };
  return {
    name,
    ...evidence,
    transitionTraceHash: canonicalSha256(trace),
    evidenceHash: canonicalSha256(evidence),
  };
}

test("canonical Wave 8 E2E report matches frozen report", async () => {
  const scenarios = [];

  const ready = runtime({ idempotencyKey: "report-ready" });
  await ready.cp.processNext();
  scenarios.push(reportEntry("ready_completed_verified", ready, await ready.cp.processNext()));

  const stale = runtime({
    preflightNames: ["stale_observation.result.json", "ready.result.json"],
    idempotencyKey: "report-stale-preflight",
  });
  await stale.cp.processNext();
  stale.counters.readOnlyReobservations += 1;
  await stale.cp.processNext();
  scenarios.push(reportEntry("stale_preflight_reobserve", stale, await stale.cp.processNext()));

  const drifted = mutateCapabilities((payload) => { payload.safety.coordinate_fallback_enabled = true; });
  const drift = runtime({
    capabilities: [frozenCapabilities(), drifted, drifted, drifted],
    idempotencyKey: "report-drift",
  });
  await drift.cp.processNext();
  await drift.cp.processNext();
  await drift.cp.processNext();
  scenarios.push(reportEntry("capability_drift_repreflight", drift, await drift.cp.processNext()));

  const unknown = runtime({
    invoke: async () => { throw unknownDispatchError(); },
    journalNames: ["unknown.lookup.json"],
    idempotencyKey: "report-unknown",
  });
  await unknown.cp.processNext();
  await unknown.cp.processNext();
  unknown.restart();
  scenarios.push(reportEntry("unknown_journal_reconcile", unknown, await unknown.cp.processNext()));

  const completed = runtime({
    invoke: async () => { throw unknownDispatchError(); },
    journalNames: ["completed.lookup.json"],
    idempotencyKey: "report-completed",
  });
  await completed.cp.processNext();
  await completed.cp.processNext();
  completed.restart();
  scenarios.push(reportEntry("completed_journal_after_restart", completed, await completed.cp.processNext()));

  const conflict = runtime({
    sensorBundles: [sensorBundle({ consistency: "semantic_delta_contradiction.json" }), sensorBundle()],
    idempotencyKey: "report-conflict",
  });
  await conflict.cp.processNext();
  await conflict.cp.processNext();
  conflict.counters.readOnlyRecaptures += 1;
  conflict.restart();
  scenarios.push(reportEntry("vision_conflict_recapture", conflict, await conflict.cp.processNext()));

  const staleVision = runtime({
    sensorBundles: [sensorBundle({ consistency: "stale_screenshot.json" }), sensorBundle()],
    idempotencyKey: "report-stale-vision",
  });
  await staleVision.cp.processNext();
  await staleVision.cp.processNext();
  staleVision.counters.readOnlyRecaptures += 1;
  staleVision.restart();
  scenarios.push(reportEntry("vision_stale_recapture", staleVision, await staleVision.cp.processNext()));

  const targetBad = runtime({ sensorBundles: [wrongTargetBundle()], idempotencyKey: "report-binding" });
  await targetBad.cp.processNext();
  scenarios.push(reportEntry("wrong_target_binding_blocked", targetBad, await targetBad.cp.processNext()));

  const base = {
    schema: "pc_control.e2e_readiness_report.v1",
    executorHead: EXECUTOR_HEAD,
    visionHead: VISION_HEAD,
    scenarios,
  };
  const actual = { ...base, reportHash: canonicalSha256(base) };
  console.log(`WAVE8_E2E_REPORT=${JSON.stringify(actual)}`);
  const expected = JSON.parse(readFileSync(
    new URL("../conformance/reports/e2e-readiness-v1.json", import.meta.url),
    "utf8",
  ));
  assert.deepEqual(actual, expected);
});
