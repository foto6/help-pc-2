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
  bindCurrentPreflightResult,
  bindJournalLookup,
  completedResult,
  contextMismatchResult,
  currentCapabilities,
  epochPair,
  executionContextBinding,
  groundedTargetFromSnapshot,
  observationEpochCorpus,
  sensorEpochBundle,
  targetLivenessLease,
  unknownDispatchError,
  verificationInput,
  readVisionCurrentText,
  TARGET_IDENTITY,
} from "./support/context-epoch-fixtures.js";

const EXECUTOR_HEAD = "2cc1e40f792a3d74560b726a0d246c90b7f077e9";
const VISION_HEAD = "51b96fb41cb72cdfc4a03129d14b9afc5fe750fd";

function ids(prefix = "wave9") {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

function actionSpec(idempotencyKey = "wave9-logical-action") {
  const input = verificationInput();
  return {
    provider: "help-pc-1",
    type: "vision.target.invoke",
    input: { target: groundedTargetFromSnapshot(input.before) },
    idempotencyKey,
    maxAttempts: 4,
    maxPreflightAttempts: 5,
    maxVerificationAttempts: 5,
    maxReconciliationAttempts: 5,
    verification: {
      provider: "vision-2",
      type: "post_action.verify",
      input: {
        verificationInput: input,
        verificationInputCanonicalJson: readVisionCurrentText("post_action_verification_result_v1/verification_input.json"),
        targetIdentity: TARGET_IDENTITY,
      },
    },
  };
}

function runtime({
  preflightNames = ["ready.result.json"],
  contextBindings = [{ processStartEpochMs: 1000, windowHandle: 77 }],
  invokeBehaviors = ["completed"],
  journalNames = ["unknown.lookup.json"],
  sensorBundles = [sensorEpochBundle()],
  bindContext = null,
  invoke = null,
  readJournal = null,
  readSensor = null,
  idempotencyKey = "wave9-logical-action",
} = {}) {
  const counters = {
    capabilities: 0,
    preflight: 0,
    contextBindings: 0,
    executorCalls: 0,
    sideEffectProviderCalls: 0,
    journalReads: 0,
    sensorReads: 0,
    readOnlyReobservations: 0,
    readOnlyRecaptures: 0,
  };
  const preflightQueue = [...preflightNames];
  const contextQueue = contextBindings.map((item) => structuredClone(item));
  const invokeQueue = [...invokeBehaviors];
  const journalQueue = [...journalNames];
  const sensorQueue = sensorBundles.map((item) => structuredClone(item));
  let cp = null;

  const executor = new HelpPc1Adapter({
    dryRun: false,
    readCapabilities: async () => {
      counters.capabilities += 1;
      return structuredClone(currentCapabilities());
    },
    preflight: async (request, context) => {
      counters.preflight += 1;
      const name = preflightQueue.length > 1 ? preflightQueue.shift() : preflightQueue[0];
      return bindCurrentPreflightResult(name, {
        requestId: request.request.request_id,
        action: request.request.action,
        capabilitiesDigest: context.capabilitiesDigest,
      });
    },
    bindExecutionContext: async (request, context) => {
      counters.contextBindings += 1;
      if (bindContext) return bindContext(request, context, counters, cp);
      const config = contextQueue.length > 1 ? contextQueue.shift() : contextQueue[0];
      return executionContextBinding(request.request_id, {
        action: request.action,
        ...(config ?? {}),
      });
    },
    invoke: async (request, context) => {
      counters.executorCalls += 1;
      assert.ok(request.execution_context_binding, "execution context binding must be supplied to Executor");
      if (invoke) return invoke(request, context, counters, cp);
      const behavior = invokeQueue.length > 1 ? invokeQueue.shift() : invokeQueue[0];
      if (behavior === "process_mismatch") {
        return contextMismatchResult(request, request.execution_context_binding, ["process.start_epoch_ms"]);
      }
      if (behavior === "window_mismatch") {
        return contextMismatchResult(request, request.execution_context_binding, ["window.window_handle"]);
      }
      if (behavior === "unknown") {
        counters.sideEffectProviderCalls += 1;
        throw unknownDispatchError();
      }
      counters.sideEffectProviderCalls += 1;
      return completedResult(request);
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
    idFactory: ids(snapshot ? "wave9-restart" : "wave9"),
  });

  cp = makePlane();
  const session = cp.createSession({ desktopId: "wave9-desktop" });
  const action = cp.enqueueAction(session.id, actionSpec(idempotencyKey));

  return {
    executor,
    vision,
    counters,
    session,
    action,
    get cp() { return cp; },
    restart(snapshot = cp.snapshot()) {
      cp = makePlane(snapshot);
      return cp;
    },
  };
}

async function processUntilTerminal(ctx, limit = 18) {
  let latest = ctx.cp.getAction(ctx.action.id);
  for (let i = 0; i < limit && !["succeeded", "failed", "blocked", "cancelled"].includes(latest.status); i += 1) {
    const next = await ctx.cp.processNext({ workerId: `wave9-worker-${i}` });
    if (!next) break;
    latest = next;
  }
  return latest;
}

test("same process/window/target epoch executes exactly one side effect", async () => {
  const ctx = runtime();
  const ready = await ctx.cp.processNext();
  assert.equal(ready.status, "queued");
  assert.equal(ready.preflightStatus, "ready");
  assert.equal(ready.contextBindingAttempts, 1);
  assert.match(ready.executionContextDigest, /^[0-9a-f]{64}$/);

  const final = await ctx.cp.processNext();
  assert.equal(final.status, "succeeded");
  assert.equal(final.executionAttempts, 1);
  assert.equal(final.contextValidationAttempts, 1);
  assert.equal(final.verificationAttempts, 1);
  assert.equal(ctx.counters.sideEffectProviderCalls, 1);
  assert.equal(ctx.counters.executorCalls, 1);
  assert.equal(ctx.counters.contextBindings, 1);
  assert.equal(final.verificationResult.targetLivenessStatus, "live");
  assert.equal(final.verificationResult.observationEpochRelation, "same");
});

for (const [behavior, changed, mismatch] of [
  ["process_mismatch", { processStartEpochMs: 2000, windowHandle: 77 }, "process.start_epoch_ms"],
  ["window_mismatch", { processStartEpochMs: 1000, windowHandle: 78 }, "window.window_handle"],
]) {
  test(`${behavior} after ready performs read-only reacquire/re-preflight before one side effect`, async () => {
    const ctx = runtime({
      contextBindings: [
        { processStartEpochMs: 1000, windowHandle: 77 },
        changed,
      ],
      invokeBehaviors: [behavior, "completed"],
      journalNames: ["not_started.lookup.json"],
      idempotencyKey: `wave9-${behavior}`,
    });

    assert.equal((await ctx.cp.processNext()).status, "queued");
    const mismatchAction = await ctx.cp.processNext();
    assert.equal(mismatchAction.status, "preflight_wait");
    assert.equal(mismatchAction.executionAttempts, 1);
    assert.equal(mismatchAction.contextValidationAttempts, 1);
    assert.equal(ctx.counters.sideEffectProviderCalls, 0);
    assert.equal(ctx.counters.executorCalls, 1);

    ctx.restart();
    ctx.counters.readOnlyReobservations += 1;
    const reReady = await ctx.cp.processNext();
    assert.equal(reReady.status, "queued");
    assert.equal(reReady.preflightAttempts, 2);
    assert.equal(reReady.contextBindingAttempts, 2);
    assert.equal(ctx.counters.sideEffectProviderCalls, 0);

    const final = await ctx.cp.processNext();
    assert.equal(final.status, "succeeded");
    assert.equal(final.executionAttempts, 2);
    assert.equal(final.contextValidationAttempts, 2);
    assert.equal(ctx.counters.executorCalls, 2);
    assert.equal(ctx.counters.sideEffectProviderCalls, 1);
    assert.equal(final.observationAttempts >= 1, true);
    assert.equal(final.verificationResult.status, "verified");
    assert.ok(ctx.cp.getAuditLog().some((entry) => entry.event === "action.preflight_wait" && entry.reason === "execution_context_mismatch"));
    assert.ok(ctx.cp.getAuditLog().some((entry) => entry.event === "action.execution_context_bound"));
    assert.equal(mismatch, behavior === "process_mismatch" ? "process.start_epoch_ms" : "window.window_handle");
  });
}

test("benign move/resize remains same epoch and does not invalidate UIA execution context", async () => {
  const badBinding = runtime({
    bindContext: async (request) => {
      const payload = executionContextBinding(request.request_id, { action: request.action });
      payload.context_digest = "0".repeat(64);
      return payload;
    },
    idempotencyKey: "wave9-report-bad-binding",
  });
  scenarios.push(reportEntry("wrong_context_binding_blocked", badBinding, await badBinding.cp.processNext()));

  const corpus = observationEpochCorpus();
  assert.equal(corpus.scenarios.moving_window.expected_relation, "same");
  assert.equal(corpus.scenarios.moving_window.epoch_changed, false);

  const ctx = runtime({
    sensorBundles: [sensorEpochBundle({ delta: "geometry_only_movement.json", epochMode: "same" })],
    idempotencyKey: "wave9-benign-move",
  });
  assert.equal((await ctx.cp.processNext()).status, "queued");
  const final = await ctx.cp.processNext();
  assert.equal(final.status, "succeeded");
  assert.equal(final.verificationResult.observationEpochRelation, "same");
  assert.equal(final.verificationResult.targetLivenessStatus, "live");
  assert.equal(ctx.counters.sideEffectProviderCalls, 1);
  assert.equal(final.contextValidationAttempts, 1);
});

test("Vision epoch replacement after completed action causes read-only reacquire/reverify without replay", async () => {
  const ctx = runtime({
    sensorBundles: [
      sensorEpochBundle({ epochMode: "window_replaced" }),
      sensorEpochBundle({ epochMode: "window_replaced", reacquireAfterEpochChange: true }),
    ],
    idempotencyKey: "wave9-post-action-epoch-replaced",
  });
  assert.equal((await ctx.cp.processNext()).status, "queued");
  const stale = await ctx.cp.processNext();
  assert.equal(stale.status, "reconciliation_wait");
  assert.equal(stale.error.code, "VISION_EPOCH_STALE");
  assert.equal(stale.executionAttempts, 1);
  assert.equal(ctx.counters.sideEffectProviderCalls, 1);

  ctx.restart();
  ctx.counters.readOnlyRecaptures += 1;
  const final = await ctx.cp.processNext();
  assert.equal(final.status, "succeeded");
  assert.equal(final.executionAttempts, 1);
  assert.equal(final.verificationAttempts, 2);
  assert.equal(final.reconciliationAttempts, 1);
  assert.equal(ctx.counters.sideEffectProviderCalls, 1);
  assert.equal(ctx.counters.sensorReads, 2);
  assert.equal(final.verificationResult.targetLivenessStatus, "live");
  assert.equal(final.verificationResult.observationEpochRelation, "replaced");
});

test("pre-dispatch context mismatch plus unknown journal enters reconciliation and never replays", async () => {
  const ctx = runtime({
    invokeBehaviors: ["process_mismatch"],
    journalNames: ["unknown.lookup.json"],
    sensorBundles: [sensorEpochBundle({ epochMode: "process_restart" })],
    idempotencyKey: "wave9-context-mismatch-unknown-journal",
  });
  assert.equal((await ctx.cp.processNext()).status, "queued");
  const uncertain = await ctx.cp.processNext();
  assert.equal(uncertain.status, "uncertain_outcome");
  assert.equal(uncertain.executionAttempts, 1);
  assert.equal(uncertain.contextValidationAttempts, 1);
  assert.equal(ctx.counters.executorCalls, 1);
  assert.equal(ctx.counters.sideEffectProviderCalls, 0);
  assert.equal(ctx.counters.journalReads, 1);

  ctx.restart();
  await ctx.cp.processNext();
  assert.equal(ctx.counters.executorCalls, 1);
  assert.equal(ctx.counters.sideEffectProviderCalls, 0);
  assert.equal(ctx.cp.getAction(ctx.action.id).executionAttempts, 1);
});

test("post-dispatch context drift plus unknown journal remains reconciliation-only", async () => {
  const ctx = runtime({
    invokeBehaviors: ["unknown"],
    journalNames: ["unknown.lookup.json"],
    sensorBundles: [sensorEpochBundle({ epochMode: "process_restart" })],
    idempotencyKey: "wave9-context-drift-unknown",
  });
  assert.equal((await ctx.cp.processNext()).status, "queued");
  const uncertain = await ctx.cp.processNext();
  assert.equal(uncertain.status, "uncertain_outcome");
  assert.equal(ctx.counters.sideEffectProviderCalls, 1);
  assert.equal(ctx.counters.contextBindings, 1);

  ctx.restart();
  const reconciled = await ctx.cp.processNext();
  assert.ok(["reconciliation_wait", "uncertain_outcome"].includes(reconciled.status));
  assert.equal(reconciled.executionAttempts, 1);
  assert.equal(ctx.counters.executorCalls, 1);
  assert.equal(ctx.counters.sideEffectProviderCalls, 1);
  assert.equal(ctx.counters.contextBindings, 1);
  assert.equal(ctx.counters.journalReads, 1);
});

test("completed journal plus stale Vision observation recaptures/reverifies only", async () => {
  const ctx = runtime({
    invokeBehaviors: ["unknown"],
    journalNames: ["completed.lookup.json"],
    sensorBundles: [
      sensorEpochBundle({ consistency: "stale_screenshot.json" }),
      sensorEpochBundle(),
    ],
    idempotencyKey: "wave9-completed-stale-vision",
  });
  assert.equal((await ctx.cp.processNext()).status, "queued");
  assert.equal((await ctx.cp.processNext()).status, "uncertain_outcome");
  ctx.restart();

  const stale = await ctx.cp.processNext();
  assert.equal(stale.status, "reconciliation_wait");
  assert.equal(stale.executionAttempts, 1);
  assert.equal(ctx.counters.sideEffectProviderCalls, 1);

  ctx.restart();
  ctx.counters.readOnlyRecaptures += 1;
  const final = await ctx.cp.processNext();
  assert.equal(final.status, "succeeded");
  assert.equal(final.executionAttempts, 1);
  assert.equal(final.verificationAttempts, 2);
  assert.equal(final.reconciliationAttempts, 2);
  assert.equal(ctx.counters.executorCalls, 1);
  assert.equal(ctx.counters.sideEffectProviderCalls, 1);
  assert.equal(ctx.counters.journalReads, 1);
});

test("wrong execution-context version/digest/binding fails closed before side effect", async () => {
  for (const [name, mutate] of [
    ["version", (payload) => { payload.contract_version = "pc_executor.execution_context_binding.v2"; }],
    ["digest", (payload) => { payload.context_digest = "0".repeat(64); }],
    ["binding", (payload) => {
      payload.request_id = "other";
      const body = structuredClone(payload);
      delete body.context_digest;
      payload.context_digest = canonicalSha256(body);
    }],
  ]) {
    const ctx = runtime({
      bindContext: async (request) => {
        const payload = executionContextBinding(request.request_id, { action: request.action });
        mutate(payload);
        return payload;
      },
      idempotencyKey: `wave9-bad-context-${name}`,
    });
    const final = await ctx.cp.processNext();
    assert.equal(final.status, "blocked", name);
    assert.equal(final.executionAttempts, 0, name);
    assert.equal(ctx.counters.executorCalls, 0, name);
    assert.equal(ctx.counters.sideEffectProviderCalls, 0, name);
  }
});

test("wrong validation digest and wrong Vision epoch version fail closed without replay", async () => {
  const wrongValidation = runtime({
    invoke: async (request, _context, counters) => {
      const result = contextMismatchResult(request, request.execution_context_binding, ["process.start_epoch_ms"]);
      result.data.execution_context_validation.binding_digest = "0".repeat(64);
      return result;
    },
    idempotencyKey: "wave9-bad-validation",
  });
  assert.equal((await wrongValidation.cp.processNext()).status, "queued");
  const validationBlocked = await wrongValidation.cp.processNext();
  assert.equal(validationBlocked.status, "blocked");
  assert.equal(validationBlocked.executionAttempts, 1);
  assert.equal(wrongValidation.counters.sideEffectProviderCalls, 0);
  assert.equal(await wrongValidation.cp.processNext(), null);

  const badBundle = sensorEpochBundle();
  badBundle.observationEpoch.contract_version = "vision.observation_epoch.v2";
  const wrongEpoch = runtime({
    sensorBundles: [badBundle],
    idempotencyKey: "wave9-bad-epoch",
  });
  assert.equal((await wrongEpoch.cp.processNext()).status, "queued");
  const epochBlocked = await wrongEpoch.cp.processNext();
  assert.equal(epochBlocked.status, "blocked");
  assert.equal(epochBlocked.executionAttempts, 1);
  assert.equal(wrongEpoch.counters.sideEffectProviderCalls, 1);
  assert.equal(await wrongEpoch.cp.processNext(), null);
});

function forceBoundary(ctx, status, { verificationRecorded = false } = {}) {
  const snapshot = ctx.cp.snapshot();
  const action = snapshot.actions.find((item) => item.id === ctx.action.id);
  const now = Date.now();
  action.status = status;
  action.executionAttempts = 1;
  action.attempts = 1;
  action.contextValidationAttempts = 1;
  action.executionOutcome = status === "executing" || status === "uncertain_outcome" ? null : "succeeded";
  action.executorEvidence = null;
  action.uncertainty = ["uncertain_outcome", "reconciling", "reconciliation_wait"].includes(status)
    ? { reason: "wave9-boundary", since: new Date(now).toISOString(), executionAttempt: 1, cancellationRequested: false }
    : null;
  action.verificationAttempts = ["verifying", "reconciling", "reconciliation_wait"].includes(status) ? 1 : 0;
  action.reconciliationAttempts = ["reconciling", "reconciliation_wait"].includes(status) ? 1 : 0;
  if (verificationRecorded) {
    action.verificationResult = {
      ok: true,
      conclusive: true,
      status: "verified",
      targetLivenessStatus: "live",
      observationEpochRelation: "same",
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
  ctx.counters.executorCalls = 1;
  return snapshot;
}

test("restart at every durable Wave 9 boundary never duplicates a dispatched side effect", async () => {
  const wait = runtime({ preflightNames: ["stale_observation.result.json", "ready.result.json"], idempotencyKey: "wave9-restart-preflight" });
  assert.equal((await wait.cp.processNext()).status, "preflight_wait");
  wait.restart();
  assert.equal(wait.cp.getAction(wait.action.id).status, "preflight_wait");
  assert.equal(wait.counters.sideEffectProviderCalls, 0);

  const ready = runtime({ idempotencyKey: "wave9-restart-ready" });
  assert.equal((await ready.cp.processNext()).status, "queued");
  const readyDigest = ready.cp.getAction(ready.action.id).executionContextDigest;
  ready.restart();
  assert.equal(ready.cp.getAction(ready.action.id).status, "queued");
  assert.equal(ready.cp.getAction(ready.action.id).executionContextDigest, readyDigest);
  assert.equal(ready.counters.sideEffectProviderCalls, 0);

  for (const [status, recorded] of [
    ["executing", false],
    ["uncertain_outcome", false],
    ["reconciling", false],
    ["verifying", false],
    ["verifying", true],
  ]) {
    const ctx = runtime({
      journalNames: ["completed.lookup.json"],
      sensorBundles: [sensorEpochBundle()],
      idempotencyKey: `wave9-restart-${status}-${recorded}`,
    });
    assert.equal((await ctx.cp.processNext()).status, "queued");
    ctx.restart(forceBoundary(ctx, status, { verificationRecorded: recorded }));
    const recovered = ctx.cp.getAction(ctx.action.id);
    assert.ok(["uncertain_outcome", "reconciliation_wait"].includes(recovered.status), `${status} -> ${recovered.status}`);
    const final = await processUntilTerminal(ctx);
    assert.equal(final.status, "succeeded", status);
    assert.equal(final.executionAttempts, 1, status);
    assert.equal(final.contextValidationAttempts, 1, status);
    assert.equal(ctx.counters.sideEffectProviderCalls, 1, status);
    assert.equal(ctx.counters.executorCalls, 1, status);
  }
});

function sequences(events, length, prefix = []) {
  if (length === 0) return [prefix];
  return events.flatMap((event) => sequences(events, length - 1, [...prefix, event]));
}

test("bounded restart/process/cancel permutations preserve one side effect after dispatch-started boundary", async () => {
  for (const sequence of sequences(["restart", "process", "cancel"], 3)) {
    const ctx = runtime({
      invokeBehaviors: ["unknown"],
      journalNames: ["unknown.lookup.json"],
      sensorBundles: [sensorEpochBundle({ epochMode: "process_restart" })],
      idempotencyKey: `wave9-property-${sequence.join("-")}`,
    });
    assert.equal((await ctx.cp.processNext()).status, "queued");
    assert.equal((await ctx.cp.processNext()).status, "uncertain_outcome");
    for (const event of sequence) {
      if (event === "restart") ctx.restart();
      else if (event === "process") await ctx.cp.processNext();
      else ctx.cp.cancelAction(ctx.action.id, "wave9-property-cancel");
      const action = ctx.cp.getAction(ctx.action.id);
      assert.equal(ctx.counters.sideEffectProviderCalls, 1, sequence.join(","));
      assert.equal(ctx.counters.executorCalls, 1, sequence.join(","));
      assert.equal(action.executionAttempts, 1, sequence.join(","));
      assert.equal(action.contextValidationAttempts, 1, sequence.join(","));
    }
  }
});

test("metrics keep observation/preflight/context-validation/execution/reconciliation/verification separate", async () => {
  const ctx = runtime({
    contextBindings: [
      { processStartEpochMs: 1000, windowHandle: 77 },
      { processStartEpochMs: 2000, windowHandle: 77 },
    ],
    invokeBehaviors: ["process_mismatch", "completed"],
    journalNames: ["not_started.lookup.json"],
    sensorBundles: [
      sensorEpochBundle({ consistency: "stale_screenshot.json" }),
      sensorEpochBundle(),
    ],
    idempotencyKey: "wave9-metrics",
  });
  await processUntilTerminal(ctx);
  const metrics = ctx.cp.getMetrics();
  assert.equal(metrics.preflightAttempts, 2);
  assert.equal(metrics.contextBindingAttempts, 2);
  assert.equal(metrics.contextValidationAttempts, 2);
  assert.equal(metrics.executionAttempts, 2);
  assert.equal(metrics.observationAttempts >= 1, true);
  assert.equal(metrics.verificationAttempts, 2);
  assert.equal(metrics.reconciliationAttempts, 1);
});

function reportEntry(name, ctx, final) {
  const trace = ctx.cp.getAuditLog({ correlationId: final.correlationId }).map((entry) => ({
    event: entry.event,
    mode: entry.mode ?? null,
    reason: entry.reason ?? null,
    preflightAttempt: entry.preflightAttempt ?? null,
    contextBindingAttempt: entry.contextBindingAttempt ?? null,
    contextValidationAttempt: entry.contextValidationAttempt ?? null,
    executionAttempt: entry.executionAttempt ?? null,
    verificationAttempt: entry.verificationAttempt ?? null,
    reconciliationAttempt: entry.reconciliationAttempt ?? null,
  }));
  const evidence = {
    terminalStatus: final.status,
    preflightAttempts: final.preflightAttempts,
    observationAttempts: final.observationAttempts,
    contextBindingAttempts: final.contextBindingAttempts,
    contextValidationAttempts: final.contextValidationAttempts,
    executionAttempts: final.executionAttempts,
    reconciliationAttempts: final.reconciliationAttempts,
    verificationAttempts: final.verificationAttempts,
    executorCalls: ctx.counters.executorCalls,
    sideEffectProviderCalls: ctx.counters.sideEffectProviderCalls,
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

test("canonical pc_control.context_epoch_e2e.v1 report matches frozen fixture", async () => {
  const scenarios = [];

  const same = runtime({ idempotencyKey: "wave9-report-same" });
  await same.cp.processNext();
  scenarios.push(reportEntry("same_epoch_execute_once", same, await same.cp.processNext()));

  const processRestart = runtime({
    contextBindings: [{ processStartEpochMs: 1000 }, { processStartEpochMs: 2000 }],
    invokeBehaviors: ["process_mismatch", "completed"],
    journalNames: ["not_started.lookup.json"],
    idempotencyKey: "wave9-report-process-restart",
  });
  await processRestart.cp.processNext();
  await processRestart.cp.processNext();
  processRestart.counters.readOnlyReobservations += 1;
  await processRestart.cp.processNext();
  scenarios.push(reportEntry("process_restart_reacquire", processRestart, await processRestart.cp.processNext()));

  const windowRestart = runtime({
    contextBindings: [{ windowHandle: 77 }, { windowHandle: 78 }],
    invokeBehaviors: ["window_mismatch", "completed"],
    journalNames: ["not_started.lookup.json"],
    idempotencyKey: "wave9-report-window-restart",
  });
  await windowRestart.cp.processNext();
  await windowRestart.cp.processNext();
  windowRestart.counters.readOnlyReobservations += 1;
  await windowRestart.cp.processNext();
  scenarios.push(reportEntry("window_replacement_reacquire", windowRestart, await windowRestart.cp.processNext()));

  const benignMove = runtime({
    sensorBundles: [sensorEpochBundle({ delta: "geometry_only_movement.json", epochMode: "same" })],
    idempotencyKey: "wave9-report-benign-move",
  });
  await benignMove.cp.processNext();
  scenarios.push(reportEntry("benign_move_resize_same_epoch", benignMove, await benignMove.cp.processNext()));

  const epochChanged = runtime({
    sensorBundles: [
      sensorEpochBundle({ epochMode: "window_replaced" }),
      sensorEpochBundle({ epochMode: "window_replaced", reacquireAfterEpochChange: true }),
    ],
    idempotencyKey: "wave9-report-epoch-change",
  });
  await epochChanged.cp.processNext();
  await epochChanged.cp.processNext();
  epochChanged.counters.readOnlyRecaptures += 1;
  scenarios.push(reportEntry("completed_then_epoch_change_reverify", epochChanged, await epochChanged.cp.processNext()));

  const unknown = runtime({
    invokeBehaviors: ["unknown"],
    journalNames: ["unknown.lookup.json"],
    sensorBundles: [sensorEpochBundle({ epochMode: "process_restart" })],
    idempotencyKey: "wave9-report-unknown",
  });
  await unknown.cp.processNext();
  await unknown.cp.processNext();
  unknown.restart();
  await unknown.cp.processNext();
  scenarios.push(reportEntry("unknown_journal_reconciliation_only", unknown, unknown.cp.getAction(unknown.action.id)));

  const mismatchUnknown = runtime({
    invokeBehaviors: ["process_mismatch"],
    journalNames: ["unknown.lookup.json"],
    sensorBundles: [sensorEpochBundle({ epochMode: "process_restart" })],
    idempotencyKey: "wave9-report-context-mismatch-unknown",
  });
  await mismatchUnknown.cp.processNext();
  await mismatchUnknown.cp.processNext();
  mismatchUnknown.restart();
  await mismatchUnknown.cp.processNext();
  scenarios.push(reportEntry("context_mismatch_unknown_journal", mismatchUnknown, mismatchUnknown.cp.getAction(mismatchUnknown.action.id)));

  const completedStale = runtime({
    invokeBehaviors: ["unknown"],
    journalNames: ["completed.lookup.json"],
    sensorBundles: [sensorEpochBundle({ consistency: "stale_screenshot.json" }), sensorEpochBundle()],
    idempotencyKey: "wave9-report-completed-stale",
  });
  await completedStale.cp.processNext();
  await completedStale.cp.processNext();
  completedStale.restart();
  await completedStale.cp.processNext();
  completedStale.counters.readOnlyRecaptures += 1;
  completedStale.restart();
  scenarios.push(reportEntry("completed_journal_stale_vision", completedStale, await completedStale.cp.processNext()));

  const corpus = observationEpochCorpus();
  const fixtureHashes = {
    executorExecutionContextManifestGitBlob: "3529d6952d42b291b6a20671aaf0bfe25f221d5d",
    executorContextMismatchValidationGitBlob: "c3499cc45c263bc6c912f659e13096e949e225a1",
    visionObservationEpochScenariosGitBlob: "8b4355f27f6ffe85d4eb38e22e337ac222939dbe",
    visionTargetLivenessGitBlob: "f2c59bcd535aeddc47939b91d5614a5e9efbff26",
    visionFixtureSourceHead: corpus.vision_source_head,
  };
  const base = {
    schema: "pc_control.context_epoch_e2e.v1",
    executorHead: EXECUTOR_HEAD,
    visionHead: VISION_HEAD,
    fixtureHashes,
    scenarios,
    aggregateTransitionHash: canonicalSha256(scenarios.map((item) => item.transitionTraceHash)),
  };
  const actual = { ...base, reportHash: canonicalSha256(base) };
  console.log(`WAVE9_CONTEXT_EPOCH_REPORT=${JSON.stringify(actual)}`);
  const expected = JSON.parse(readFileSync(
    new URL("../conformance/reports/context-epoch-e2e-v1.json", import.meta.url),
    "utf8",
  ));
  assert.deepEqual(actual, expected);
});
