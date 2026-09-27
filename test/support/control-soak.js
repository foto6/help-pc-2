import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  ControlPlane,
  HelpPc1Adapter,
  VisionVerificationResultV1Adapter,
  adaptExecutorActionOutcomeV1,
} from "../../src/index.js";
import { bindFrozenJournalLookup } from "./journal-fixtures.js";

const EXECUTOR_BASE = new URL("../../conformance/frozen/executor/606074456ca00681fac30a40ee28f7bb0f67c79c/tests/fixtures/", import.meta.url);
const VISION_BASE = new URL("../../conformance/frozen/vision/f20e2c2e35cbcb9b675c9c1a0568de2e40b5eb82/tests/fixtures/post_action_verification_result_v1/", import.meta.url);
const readExecutor = (name) => JSON.parse(readFileSync(new URL(name, EXECUTOR_BASE), "utf8"));
const readVision = (name) => JSON.parse(readFileSync(new URL(name, VISION_BASE), "utf8"));
const verificationInputText = readFileSync(new URL("verification_input.json", VISION_BASE), "utf8").trimEnd();
const verificationInput = JSON.parse(verificationInputText);

const TERMINAL = new Set(["succeeded", "failed", "blocked", "cancelled"]);
const SIDE_EFFECT_ACTIONS = [
  "vision.target.invoke",
  "uia.invoke",
  "uia.focus",
  "uia.set_value",
  "mouse.click",
  "keyboard.press",
  "keyboard.type_text",
  "clipboard.set",
  "shell.run",
];
const PLAN_NAMES = [
  "not_started_retry_completed",
  "completed_verified",
  "completed_stale_verified",
  "completed_inconclusive_verified",
  "completed_failed_verification",
  "unknown_verified",
  "unknown_evidence_not_started",
  "malformed_executor_evidence",
  "legacy_completed",
  "completed_malformed_vision",
  "unknown_evidence_completed",
  "policy_blocked_not_started",
  "completed_stale_inconclusive_verified",
  "completed_verified_alt",
];

function xorshift32(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function clone(value) {
  return structuredClone(value);
}

function idFactory(seed) {
  let n = 0;
  return () => `soak-${seed.toString(16)}-${++n}`;
}

function boundOutcome(name, request, { reason = null } = {}) {
  const payload = readExecutor(name);
  payload.request_id = request.request_id;
  payload.action = request.action;
  if (reason !== null) payload.reason = reason;
  return payload;
}

function actionResult(request, outcomeName, fields = {}) {
  return {
    request_id: request.request_id,
    action: request.action,
    ok: fields.ok ?? true,
    status: fields.status ?? "completed",
    started_at: "2026-09-27T10:00:00.000Z",
    finished_at: "2026-09-27T10:00:00.001Z",
    data: {},
    error: fields.error ?? null,
    error_kind: fields.error_kind ?? null,
    dry_run: fields.dry_run ?? false,
    outcome_evidence: boundOutcome(outcomeName, request, { reason: fields.reason ?? null }),
  };
}

function sensitiveValuesAreRedacted(value) {
  const pattern = /(password|passwd|secret|token|credential|auth|cookie|captcha|text|value)/i;
  if (Array.isArray(value)) return value.every(sensitiveValuesAreRedacted);
  if (!value || typeof value !== "object") return true;
  for (const [key, item] of Object.entries(value)) {
    if (pattern.test(key) && item !== "[REDACTED]") return false;
    if (!pattern.test(key) && !sensitiveValuesAreRedacted(item)) return false;
  }
  return true;
}

function normalizeAudit(entry) {
  return {
    sequence: entry.sequence,
    event: entry.event,
    actionId: entry.actionId ?? null,
    sessionId: entry.sessionId ?? null,
    correlationId: entry.correlationId ?? null,
    mode: entry.mode ?? null,
    reason: entry.reason ?? null,
    executionAttempt: entry.executionAttempt ?? null,
    verificationAttempt: entry.verificationAttempt ?? null,
    reconciliationAttempt: entry.reconciliationAttempt ?? null,
  };
}

function planVerificationStatuses(plan) {
  switch (plan) {
    case "completed_stale_verified": return ["stale", "verified"];
    case "completed_inconclusive_verified": return ["inconclusive", "verified"];
    case "completed_failed_verification": return ["failed"];
    case "completed_malformed_vision": return ["malformed"];
    case "completed_stale_inconclusive_verified": return ["stale", "inconclusive", "verified"];
    default: return ["verified"];
  }
}

function recordFor(model, actionId) {
  const record = model.records.get(actionId);
  assert.ok(record, `missing soak model record for ${actionId}`);
  return record;
}

function executorProvider(model) {
  return new HelpPc1Adapter({
    dryRun: false,
    invoke: async (request, context) => {
      const record = recordFor(model, request.request_id);
      record.executionProviderCalls += 1;
      assert.equal(record.dispatchBarrier, false, `execute called after dispatch barrier for ${record.actionId}`);
      if (record.executionProviderCalls > 1) {
        assert.equal(record.executionRetryAuthorized, true, `execution retry lacked confirmed not_started evidence for ${record.actionId}`);
      }
      record.executionRetryAuthorized = false;

      const call = record.executionProviderCalls;
      const dispatch = (effect) => {
        record.executionOutcomes.push(effect);
        if (effect !== "not_started") {
          record.sideEffectProviderCalls += 1;
          record.dispatchBarrier = true;
          record.dispatchBoundaryExecutionAttempt = context.executionAttempt;
          assert.ok(record.sideEffectProviderCalls <= 1, `side effect provider duplicated for ${record.actionId}`);
        }
      };

      switch (record.plan) {
        case "not_started_retry_completed":
          if (call === 1) {
            record.executionOutcomes.push("not_started");
            record.executionRetryAuthorized = true;
            return actionResult(request, "action_outcome_v1_not_started.json", {
              ok: false,
              status: "transient",
              error: "pre-dispatch transient",
              error_kind: "transient",
              reason: "transient",
            });
          }
          dispatch("completed");
          return actionResult(request, "action_outcome_v1.json");
        case "unknown_verified":
        case "unknown_evidence_not_started":
        case "unknown_evidence_completed":
          dispatch("unknown");
          return actionResult(request, "action_outcome_v1_unknown.json", {
            ok: false,
            status: "timeout",
            error: "post-dispatch timeout",
            error_kind: "timeout",
            reason: "timeout",
          });
        case "malformed_executor_evidence": {
          dispatch("malformed");
          const result = actionResult(request, "action_outcome_v1.json");
          result.outcome_evidence.extra = true;
          record.malformedExternalEvidenceSeen = true;
          return result;
        }
        case "legacy_completed":
          dispatch("legacy_completed");
          return {
            request_id: request.request_id,
            action: request.action,
            ok: true,
            status: "completed",
            started_at: "2026-09-27T10:00:00.000Z",
            finished_at: "2026-09-27T10:00:00.001Z",
            data: {},
            error: null,
            error_kind: null,
            dry_run: false,
          };
        case "policy_blocked_not_started":
          record.executionOutcomes.push("not_started");
          return actionResult(request, "action_outcome_v1_not_started.json", {
            ok: false,
            status: "blocked",
            error: "policy blocked",
            error_kind: "policy_blocked",
            reason: "policy_blocked",
          });
        default:
          dispatch("completed");
          return actionResult(request, "action_outcome_v1.json");
      }
    },
    readEvidence: async (request) => {
      const record = recordFor(model, request.request_id);
      record.executorEvidenceCalls += 1;
      if (record.plan === "unknown_evidence_not_started") {
        return boundOutcome("action_outcome_v1_not_started.json", request, { reason: "transient" });
      }
      if (record.plan === "unknown_evidence_completed") {
        return bindFrozenJournalLookup("completed.lookup.json", {
          requestId: request.request_id,
          action: request.action,
          executionAttempt: request.execution_attempt,
        });
      }
      if (record.plan === "unknown_verified") {
        return bindFrozenJournalLookup("unknown.lookup.json", {
          requestId: request.request_id,
          action: request.action,
          executionAttempt: request.execution_attempt,
        });
      }
      if (record.plan === "malformed_executor_evidence") {
        const malformed = boundOutcome("action_outcome_v1_unknown.json", request);
        malformed.extra = "fail-closed";
        record.malformedExternalEvidenceSeen = true;
        return malformed;
      }
      return boundOutcome("action_outcome_v1_unknown.json", request);
    },
  });
}

function visionVerifier(model) {
  return new VisionVerificationResultV1Adapter({
    verificationInputResolver: async () => verificationInput,
    verificationInputCanonicalJsonResolver: async () => verificationInputText,
    readResult: async (request) => {
      const record = recordFor(model, request.action.id);
      record.verificationCalls += 1;
      const statuses = record.verificationStatuses;
      const index = Math.min(record.verificationCalls - 1, statuses.length - 1);
      const status = statuses[index];
      if (status === "malformed") {
        const malformed = readVision("verified.json");
        malformed.extra = true;
        record.malformedExternalEvidenceSeen = true;
        return malformed;
      }
      return readVision(`${status}.json`);
    },
  });
}

function createRuntime(model, snapshot = null, { recoverOnStart = true } = {}) {
  return new ControlPlane({
    providers: [executorProvider(model)],
    verificationProviders: [visionVerifier(model)],
    snapshot,
    recoverOnStart,
    clock: () => model.now,
    idFactory: model.nextId,
    defaultLeaseMs: 25,
  });
}

function assertLaneInvariants(snapshot) {
  const lockMap = new Map(snapshot.resourceLocks);
  const actionById = new Map(snapshot.actions.map((action) => [action.id, action]));
  const seen = new Map();
  for (const action of snapshot.actions) {
    if (!action.lease) continue;
    for (const lane of action.lease.lanes) {
      assert.equal(lockMap.get(lane), action.id, `lane ${lane} is not owned by leased action ${action.id}`);
      assert.equal(seen.has(lane), false, `lane ${lane} overlaps ${seen.get(lane)} and ${action.id}`);
      seen.set(lane, action.id);
    }
  }
  for (const [lane, actionId] of lockMap) {
    const action = actionById.get(actionId);
    assert.ok(action?.lease?.lanes.includes(lane), `orphaned lane lock ${lane} -> ${actionId}`);
  }
}

function assertIdempotency(snapshot) {
  const actionById = new Map(snapshot.actions.map((action) => [action.id, action]));
  for (const [scope, actionId] of snapshot.idempotency) {
    const action = actionById.get(actionId);
    assert.ok(action, `idempotency scope ${scope} points to missing action`);
    assert.equal(scope, `${action.sessionId}:${action.idempotencyKey}`);
  }
}

function assertInvariants(cp, model, label) {
  const snapshot = cp.snapshot();
  assertLaneInvariants(snapshot);
  assertIdempotency(snapshot);

  const audit = snapshot.audit;
  for (let i = model.lastAuditCount; i < audit.length; i += 1) {
    const entry = audit[i];
    assert.equal(entry.sequence, i + 1, `audit sequence gap after ${label}`);
    assert.equal(sensitiveValuesAreRedacted(entry), true, `audit metadata not redacted at sequence ${entry.sequence}`);
    const record = entry.actionId ? model.records.get(entry.actionId) : null;
    if (record?.dispatchBarrier && entry.event === "action.leased" && entry.mode === "execute") {
      assert.ok(entry.sequence <= record.dispatchBarrierAuditSequence, `dispatch-barrier action ${entry.actionId} re-entered execute after barrier`);
    }
    if (
      record?.dispatchBarrier &&
      record.dispatchBarrierAuditSequence === Number.MAX_SAFE_INTEGER &&
      entry.event === "action.executing" &&
      entry.executionAttempt === record.dispatchBoundaryExecutionAttempt
    ) {
      record.dispatchBarrierAuditSequence = entry.sequence;
    }
    model.transitionHash.update(JSON.stringify(normalizeAudit(entry)) + "\n");
  }
  model.lastAuditCount = audit.length;

  for (const action of snapshot.actions) {
    const record = model.records.get(action.id);
    if (!record) continue;

    assert.equal(action.executionAttempts, record.executionProviderCalls + record.injectedDispatches, `execution attempt counter drift for ${action.id} after ${label}`);
    assert.ok(record.sideEffectProviderCalls <= 1, `side-effect provider call count exceeded one for ${action.id}`);

    if (record.dispatchBarrier) {
      assert.notEqual(action.lease?.mode, "execute", `dispatch-barrier action ${action.id} regained execute lease`);
    }

    if (action.executionAttempts > 1) {
      assert.equal(record.plan, "not_started_retry_completed", `only not_started plan may retry execution: ${action.id}`);
      assert.equal(record.executionOutcomes[0], "not_started");
      assert.ok(action.executionAttempts <= action.maxAttempts);
    }

    if (record.malformedExternalEvidenceSeen) {
      assert.notEqual(action.status, "retry_wait", `malformed evidence became execution retry for ${action.id}`);
      assert.ok(action.executionAttempts <= 1, `malformed evidence caused duplicate execution for ${action.id}`);
    }

    if (record.terminalStatus !== null) {
      assert.equal(action.status, record.terminalStatus, `terminal action resurrected: ${action.id}`);
    } else if (TERMINAL.has(action.status)) {
      record.terminalStatus = action.status;
    }

    if (record.cancelledTerminal) {
      assert.equal(action.status, "cancelled", `cancelled action resurrected: ${action.id}`);
    }

    assert.ok(action.verificationAttempts >= record.lastVerificationAttempts, `verification counter regressed for ${action.id}`);
    assert.ok(action.reconciliationAttempts >= record.lastReconciliationAttempts, `reconciliation counter regressed for ${action.id}`);
    if (action.executionAttempts === record.lastExecutionAttempts) {
      assert.ok(action.verificationAttempts >= record.lastVerificationAttempts);
      assert.ok(action.reconciliationAttempts >= record.lastReconciliationAttempts);
    }
    record.lastExecutionAttempts = action.executionAttempts;
    record.lastVerificationAttempts = action.verificationAttempts;
    record.lastReconciliationAttempts = action.reconciliationAttempts;
  }

  model.events += 1;
}

function pickAction(cp, rng, predicate) {
  const candidates = cp.listActions().filter(predicate);
  if (!candidates.length) return null;
  return candidates[rng() % candidates.length];
}

function markDispatchBarrier(model, record, action, auditSequence) {
  record.injectedDispatches += 1;
  record.sideEffectProviderCalls += 1;
  record.executionOutcomes.push("unknown");
  record.dispatchBarrier = true;
  record.dispatchBoundaryExecutionAttempt = action.executionAttempts + 1;
  record.dispatchBarrierAuditSequence = auditSequence;
  assert.ok(record.sideEffectProviderCalls <= 1);
}

function injectExecutingRestart(cp, model, rng) {
  const candidate = pickAction(cp, rng, (action) => action.status === "leased" && action.lease?.mode === "execute");
  if (!candidate) return false;
  const record = recordFor(model, candidate.id);
  if (record.dispatchBarrier || record.executionProviderCalls || record.injectedDispatches) return false;

  const snapshot = cp.snapshot();
  const action = snapshot.actions.find((item) => item.id === candidate.id);
  markDispatchBarrier(model, record, action, snapshot.auditSequence);
  action.status = "executing";
  action.executionAttempts += 1;
  action.attempts = action.executionAttempts;
  action.executorEvidence = adaptExecutorActionOutcomeV1(
    boundOutcome("action_outcome_v1_unknown.json", { request_id: action.id, action: action.type }),
    { requestId: action.id, action: action.type },
  );
  action.executionOutcome = null;
  cp = createRuntime(model, snapshot);
  model.restarts += 1;
  return cp;
}

function injectExecutingLeaseExpiry(cp, model, rng) {
  const candidate = pickAction(cp, rng, (action) => action.status === "leased" && action.lease?.mode === "execute");
  if (!candidate) return false;
  const record = recordFor(model, candidate.id);
  if (record.dispatchBarrier || record.executionProviderCalls || record.injectedDispatches) return false;

  const snapshot = cp.snapshot();
  const action = snapshot.actions.find((item) => item.id === candidate.id);
  markDispatchBarrier(model, record, action, snapshot.auditSequence);
  action.status = "executing";
  action.executionAttempts += 1;
  action.attempts = action.executionAttempts;
  action.executorEvidence = adaptExecutorActionOutcomeV1(
    boundOutcome("action_outcome_v1_unknown.json", { request_id: action.id, action: action.type }),
    { requestId: action.id, action: action.type },
  );
  action.executionOutcome = null;
  model.now = Math.max(model.now, action.lease.expiresAtMs + 1);
  cp = createRuntime(model, snapshot, { recoverOnStart: false });
  cp.recoverExpiredLeases();
  model.leaseExpiries += 1;
  return cp;
}

function actionSpec(seed, index, plan) {
  const type = SIDE_EFFECT_ACTIONS[index % SIDE_EFFECT_ACTIONS.length];
  return {
    provider: "help-pc-1",
    type,
    input: { synthetic: index },
    resource: `shared-resource-${index % 19}`,
    idempotencyKey: `soak-${seed.toString(16)}-${index}`,
    maxAttempts: 2,
    maxVerificationAttempts: 3,
    maxReconciliationAttempts: 3,
    retryDelayMs: 0,
    verificationDelayMs: 0,
    verification: {
      provider: "vision-2",
      type: "post_action.verify",
      input: {},
    },
    metadata: { soakPlan: plan, ordinal: index },
  };
}

function registerAction(model, action, spec, plan) {
  model.records.set(action.id, {
    actionId: action.id,
    sessionId: action.sessionId,
    spec: clone(spec),
    plan,
    verificationStatuses: planVerificationStatuses(plan),
    executionProviderCalls: 0,
    injectedDispatches: 0,
    sideEffectProviderCalls: 0,
    executorEvidenceCalls: 0,
    verificationCalls: 0,
    executionOutcomes: [],
    executionRetryAuthorized: false,
    dispatchBarrier: false,
    dispatchBoundaryExecutionAttempt: null,
    dispatchBarrierAuditSequence: Number.MAX_SAFE_INTEGER,
    malformedExternalEvidenceSeen: false,
    terminalStatus: null,
    cancelledTerminal: false,
    lastExecutionAttempts: 0,
    lastVerificationAttempts: 0,
    lastReconciliationAttempts: 0,
  });
}

function restartRuntime(cp, model, rng) {
  const snapshot = cp.snapshot();
  cp = createRuntime(model, snapshot);
  model.restarts += 1;
  const sample = pickAction(cp, rng, (action) => Boolean(action.idempotencyKey));
  if (sample) {
    const record = recordFor(model, sample.id);
    const duplicate = cp.enqueueAction(record.sessionId, record.spec);
    assert.equal(duplicate.id, sample.id, `idempotency failed after restart for ${sample.id}`);
    model.duplicates += 1;
  }
  return cp;
}

function schedulable(cp) {
  return cp.listActions().some((action) =>
    ["queued", "leased", "retry_wait", "uncertain_outcome", "reconciliation_wait"].includes(action.status)
  );
}

export async function runControlStateMachineSoak({ seed, actionCount = 256 } = {}) {
  const rng = xorshift32(seed);
  const model = {
    seed,
    now: Date.UTC(2026, 8, 27, 10, 0, 0),
    nextId: idFactory(seed),
    records: new Map(),
    events: 0,
    restarts: 0,
    duplicates: 0,
    cancellations: 0,
    leaseExpiries: 0,
    lastAuditCount: 0,
    transitionHash: createHash("sha256"),
  };
  let cp = createRuntime(model);

  const sessions = [];
  for (let i = 0; i < 8; i += 1) {
    const session = cp.createSession({ desktopId: `desktop-${seed.toString(16)}-${i}`, principal: `soak-${i}` });
    sessions.push(session);
    assertInvariants(cp, model, "session.create");
  }

  for (let index = 0; index < actionCount; index += 1) {
    const plan = PLAN_NAMES[(index + (rng() % PLAN_NAMES.length)) % PLAN_NAMES.length];
    const spec = actionSpec(seed, index, plan);
    const session = sessions[index % sessions.length];
    const action = cp.enqueueAction(session.id, spec);
    registerAction(model, action, spec, plan);
    assertInvariants(cp, model, "action.enqueue");

    if (index % 4 === 0) {
      const duplicate = cp.enqueueAction(session.id, spec);
      assert.equal(duplicate.id, action.id);
      model.duplicates += 1;
      assertInvariants(cp, model, "action.duplicate");
    }

    if (index % 29 === 0 && action.status === "queued") {
      cp.cancelAction(action.id, "soak_pre_dispatch_cancel");
      recordFor(model, action.id).cancelledTerminal = true;
      model.cancellations += 1;
      assertInvariants(cp, model, "action.cancel");
    }

    if (index % 11 === 0) {
      cp.leaseNext({ workerId: `enqueue-lease-${index}`, leaseMs: 7 });
      assertInvariants(cp, model, "action.lease");
    }

    if (index % 17 === 0) {
      model.now += 11;
      cp.recoverExpiredLeases();
      model.leaseExpiries += 1;
      assertInvariants(cp, model, "clock.advance.expire");
    }

    if (index > 0 && index % 53 === 0) {
      cp = restartRuntime(cp, model, rng);
      assertInvariants(cp, model, "process.restart.enqueue-phase");
    }
  }

  const maxSteps = actionCount * 12;
  for (let step = 0; step < maxSteps && schedulable(cp); step += 1) {
    const op = rng() % 9;
    if (op === 0) {
      cp.leaseNext({ workerId: `worker-${step}`, leaseMs: 13 + (rng() % 17) });
      assertInvariants(cp, model, "lease");
    } else if (op === 1) {
      const leased = pickAction(cp, rng, (action) => action.status === "leased");
      if (leased) await cp.executeLeased(leased.id, { workerId: leased.lease.workerId });
      else await cp.processNext({ workerId: `fallback-${step}` });
      assertInvariants(cp, model, "execute.leased");
    } else if (op === 2) {
      await cp.processNext({ workerId: `process-${step}` });
      assertInvariants(cp, model, "process.next");
    } else if (op === 3) {
      cp = restartRuntime(cp, model, rng);
      assertInvariants(cp, model, "process.restart");
    } else if (op === 4) {
      const candidate = pickAction(cp, rng, (action) =>
        ["queued", "retry_wait"].includes(action.status) ||
        (action.status === "leased" && action.lease?.mode === "execute" && action.executionAttempts === 0)
      );
      if (candidate) {
        cp.cancelAction(candidate.id, "soak_cancel");
        const record = recordFor(model, candidate.id);
        record.cancelledTerminal = true;
        model.cancellations += 1;
      }
      assertInvariants(cp, model, "cancel");
    } else if (op === 5) {
      model.now += 50 + (rng() % 100);
      cp.recoverExpiredLeases();
      model.leaseExpiries += 1;
      assertInvariants(cp, model, "clock.advance");
    } else if (op === 6) {
      const injected = injectExecutingRestart(cp, model, rng);
      if (injected) cp = injected;
      else await cp.processNext({ workerId: `inject-fallback-${step}` });
      assertInvariants(cp, model, "crash.after.dispatch");
    } else if (op === 7) {
      const injected = injectExecutingLeaseExpiry(cp, model, rng);
      if (injected) cp = injected;
      else cp.leaseNext({ workerId: `expiry-fallback-${step}`, leaseMs: 5 });
      assertInvariants(cp, model, "lease.expiry.executing");
    } else {
      const leased = cp.leaseNext({ workerId: `pair-${step}`, leaseMs: 25 });
      if (leased && (rng() & 1)) await cp.executeLeased(leased.id, { workerId: leased.lease.workerId });
      assertInvariants(cp, model, "lease.execute.pair");
    }
  }

  let cleanup = 0;
  while (schedulable(cp) && cleanup < actionCount * 8) {
    const leased = pickAction(cp, rng, (action) => action.status === "leased");
    if (leased) await cp.executeLeased(leased.id, { workerId: leased.lease.workerId });
    else {
      const result = await cp.processNext({ workerId: `cleanup-${cleanup}` });
      if (!result) {
        model.now += 100;
        cp.recoverExpiredLeases();
      }
    }
    cleanup += 1;
    assertInvariants(cp, model, "cleanup");
  }

  assert.equal(cp.listActions().some((action) => action.status === "leased"), false, "soak left leased work behind");

  const actions = cp.listActions();
  const aggregate = {
    seed,
    logicalActions: actionCount,
    events: model.events,
    restarts: model.restarts,
    duplicates: model.duplicates,
    cancellations: model.cancellations,
    leaseExpiryChecks: model.leaseExpiries,
    executionAttempts: actions.reduce((sum, action) => sum + action.executionAttempts, 0),
    verificationAttempts: actions.reduce((sum, action) => sum + action.verificationAttempts, 0),
    reconciliationAttempts: actions.reduce((sum, action) => sum + action.reconciliationAttempts, 0),
    sideEffectProviderCalls: [...model.records.values()].reduce((sum, record) => sum + record.sideEffectProviderCalls, 0),
    executorEvidenceCalls: [...model.records.values()].reduce((sum, record) => sum + record.executorEvidenceCalls, 0),
    observationCalls: [...model.records.values()].reduce((sum, record) => sum + record.verificationCalls, 0),
    terminalActions: actions.filter((action) => TERMINAL.has(action.status)).length,
    quiescentUncertain: actions.filter((action) => action.status === "uncertain_outcome" && action.error?.code === "RECONCILIATION_EXHAUSTED").length,
    malformedEvidenceActions: [...model.records.values()].filter((record) => record.malformedExternalEvidenceSeen).length,
    transitionHash: model.transitionHash.digest("hex"),
  };

  return { report: aggregate, snapshot: cp.snapshot() };
}

export function combineSoakReports(reports, persistenceFaultChecks) {
  const payload = {
    schema: "pc_control.state_machine_fault_soak.v1",
    seeds: reports.map((item) => item.seed),
    logicalActions: reports.reduce((sum, item) => sum + item.logicalActions, 0),
    events: reports.reduce((sum, item) => sum + item.events, 0),
    restarts: reports.reduce((sum, item) => sum + item.restarts, 0),
    duplicates: reports.reduce((sum, item) => sum + item.duplicates, 0),
    cancellations: reports.reduce((sum, item) => sum + item.cancellations, 0),
    leaseExpiryChecks: reports.reduce((sum, item) => sum + item.leaseExpiryChecks, 0),
    persistenceFaultChecks,
    executionAttempts: reports.reduce((sum, item) => sum + item.executionAttempts, 0),
    verificationAttempts: reports.reduce((sum, item) => sum + item.verificationAttempts, 0),
    reconciliationAttempts: reports.reduce((sum, item) => sum + item.reconciliationAttempts, 0),
    sideEffectProviderCalls: reports.reduce((sum, item) => sum + item.sideEffectProviderCalls, 0),
    executorEvidenceCalls: reports.reduce((sum, item) => sum + item.executorEvidenceCalls, 0),
    observationCalls: reports.reduce((sum, item) => sum + item.observationCalls, 0),
    terminalActions: reports.reduce((sum, item) => sum + item.terminalActions, 0),
    quiescentUncertain: reports.reduce((sum, item) => sum + item.quiescentUncertain, 0),
    malformedEvidenceActions: reports.reduce((sum, item) => sum + item.malformedEvidenceActions, 0),
    runTransitionHashes: reports.map((item) => item.transitionHash),
  };
  payload.aggregateTransitionHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return payload;
}
