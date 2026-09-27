import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  ControlPlane,
  HelpPc1Adapter,
  VisionVerificationResultV1Adapter,
} from "../src/index.js";
import {
  bindFrozenJournalLookup,
  missingJournalLookup,
} from "./support/journal-fixtures.js";

const VISION_BASE = new URL(
  "../conformance/frozen/vision/f20e2c2e35cbcb9b675c9c1a0568de2e40b5eb82/tests/fixtures/post_action_verification_result_v1/",
  import.meta.url,
);
const OUTCOME_BASE = new URL(
  "../conformance/frozen/executor/606074456ca00681fac30a40ee28f7bb0f67c79c/tests/fixtures/",
  import.meta.url,
);
const verificationInputText = readFileSync(new URL("verification_input.json", VISION_BASE), "utf8").trimEnd();
const verificationInput = JSON.parse(verificationInputText);
const readVision = (status) => JSON.parse(readFileSync(new URL(`${status}.json`, VISION_BASE), "utf8"));
const completedOutcomeTemplate = JSON.parse(readFileSync(new URL("action_outcome_v1.json", OUTCOME_BASE), "utf8"));

function ids() {
  let n = 0;
  return () => `journal-wave6-${++n}`;
}

function completedResult(request) {
  const evidence = structuredClone(completedOutcomeTemplate);
  evidence.request_id = request.request_id;
  evidence.action = request.action;
  return {
    request_id: request.request_id,
    action: request.action,
    ok: true,
    status: "completed",
    started_at: "2026-09-27T11:00:00.000Z",
    finished_at: "2026-09-27T11:00:00.001Z",
    data: {},
    error: null,
    error_kind: null,
    dry_run: false,
    outcome_evidence: evidence,
  };
}

function visionAdapter(statuses, counters) {
  const queue = [...statuses];
  return new VisionVerificationResultV1Adapter({
    verificationInputResolver: async () => verificationInput,
    verificationInputCanonicalJsonResolver: async () => verificationInputText,
    readResult: async () => {
      counters.observations += 1;
      const status = queue.length > 1 ? queue.shift() : queue[0];
      return readVision(status ?? "verified");
    },
  });
}

function buildInterrupted({
  lookupFactory,
  verificationStatuses = ["verified"],
  maxAttempts = 2,
  maxVerificationAttempts = 3,
  maxReconciliationAttempts = 3,
} = {}) {
  const counters = { sideEffects: 0, journalReads: 0, observations: 0 };
  let actionId = null;
  const adapter = new HelpPc1Adapter({
    dryRun: false,
    invoke: async (request) => {
      counters.sideEffects += 1;
      assert.equal(counters.sideEffects <= 1, true, "journal recovery caused duplicate side effect");
      return completedResult(request);
    },
    readEvidence: async (request) => {
      counters.journalReads += 1;
      return lookupFactory ? lookupFactory(request) : null;
    },
  });
  const verifier = visionAdapter(verificationStatuses, counters);
  const initial = new ControlPlane({
    providers: [adapter],
    verificationProviders: [verifier],
    idFactory: ids(),
  });
  const session = initial.createSession({ desktopId: "journal-desktop" });
  const action = initial.enqueueAction(session.id, {
    provider: "help-pc-1",
    type: "keyboard.press",
    input: { key: "enter" },
    idempotencyKey: "journal-logical-action",
    maxAttempts,
    maxVerificationAttempts,
    maxReconciliationAttempts,
    verification: { provider: "vision-2", type: "post_action.verify", input: {} },
  });
  actionId = action.id;
  const leased = initial.leaseNext({ workerId: "crashed-worker", leaseMs: 30_000 });
  assert.equal(leased.id, action.id);

  const snapshot = initial.snapshot();
  const stored = snapshot.actions.find((item) => item.id === action.id);
  stored.status = "executing";
  stored.executionAttempts = 1;
  stored.attempts = 1;
  stored.executionCorrelation = adapter.executionCorrelation(stored, 1);
  stored.executionOutcome = null;
  stored.executorEvidence = null;
  stored.updatedAt = stored.executingAt = "2026-09-27T11:00:00.000Z";

  const recovered = new ControlPlane({
    providers: [adapter],
    verificationProviders: [verifier],
    snapshot,
    idFactory: ids(),
  });
  assert.equal(recovered.getAction(action.id).status, "uncertain_outcome");
  assert.equal(recovered.getAction(action.id).executionCorrelation.executionAttempt, 1);
  return { cp: recovered, actionId, counters };
}

function trace(cp, actionId) {
  return cp.getAuditLog()
    .filter((entry) => entry.actionId === actionId)
    .map((entry) => ({
      event: entry.event,
      mode: entry.mode ?? null,
      reason: entry.reason ?? null,
      executionAttempt: entry.executionAttempt ?? null,
      reconciliationAttempt: entry.reconciliationAttempt ?? null,
      verificationAttempt: entry.verificationAttempt ?? null,
    }));
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

test("journal terminal completed after restart never reexecutes and verifies only", async () => {
  const ctx = buildInterrupted({
    lookupFactory: (request) => bindFrozenJournalLookup("completed.lookup.json", {
      requestId: request.request_id,
      action: request.action,
      executionAttempt: request.execution_attempt,
    }),
  });
  const final = await ctx.cp.processNext();
  assert.equal(final.status, "succeeded");
  assert.equal(final.executionAttempts, 1);
  assert.equal(final.reconciliationAttempts, 1);
  assert.equal(final.verificationAttempts, 1);
  assert.deepEqual(ctx.counters, { sideEffects: 0, journalReads: 1, observations: 1 });
});

test("journal provisional unknown reconciles read-only before Vision", async () => {
  const ctx = buildInterrupted({
    lookupFactory: (request) => bindFrozenJournalLookup("unknown.lookup.json", {
      requestId: request.request_id,
      action: request.action,
      executionAttempt: request.execution_attempt,
    }),
  });
  const final = await ctx.cp.processNext();
  assert.equal(final.status, "succeeded");
  assert.equal(final.executionAttempts, 1);
  assert.equal(ctx.counters.sideEffects, 0);
  assert.equal(ctx.counters.journalReads, 1);
  assert.equal(ctx.counters.observations, 1);
});

test("journal missing remains conservative and may only verify", async () => {
  const ctx = buildInterrupted({ lookupFactory: () => null });
  const final = await ctx.cp.processNext();
  assert.equal(final.status, "succeeded");
  assert.equal(final.executionAttempts, 1);
  assert.equal(ctx.counters.sideEffects, 0);
  assert.equal(ctx.counters.journalReads, 1);
  assert.equal(ctx.counters.observations, 1);
});

test("truncated journal tail stays read-only through stale/inconclusive/verified", async () => {
  const ctx = buildInterrupted({
    lookupFactory: (request) => bindFrozenJournalLookup("truncated_tail.lookup.json", {
      requestId: request.request_id,
      action: request.action,
      executionAttempt: request.execution_attempt,
    }),
    verificationStatuses: ["stale", "inconclusive", "verified"],
  });
  assert.equal((await ctx.cp.processNext()).status, "reconciliation_wait");
  assert.equal((await ctx.cp.processNext()).status, "reconciliation_wait");
  const final = await ctx.cp.processNext();
  assert.equal(final.status, "succeeded");
  assert.equal(final.executionAttempts, 1);
  assert.equal(final.verificationAttempts, 3);
  assert.equal(final.reconciliationAttempts, 3);
  assert.deepEqual(ctx.counters, { sideEffects: 0, journalReads: 3, observations: 3 });
});

test("clean journal not_started permits existing bounded retry policy, not journal replay authority", async () => {
  const ctx = buildInterrupted({
    lookupFactory: (request) => bindFrozenJournalLookup("not_started.lookup.json", {
      requestId: request.request_id,
      action: request.action,
      executionAttempt: request.execution_attempt,
    }),
    maxAttempts: 2,
  });
  const reconciled = await ctx.cp.processNext();
  assert.equal(reconciled.status, "retry_wait");
  assert.equal(reconciled.executionAttempts, 1);
  assert.equal(ctx.counters.sideEffects, 0);
  const final = await ctx.cp.processNext();
  assert.equal(final.status, "succeeded");
  assert.equal(final.executionAttempts, 2);
  assert.equal(ctx.counters.sideEffects, 1);
  assert.equal(ctx.counters.journalReads, 1);
});

test("journal not_started cannot exceed bounded execution-attempt budget", async () => {
  const ctx = buildInterrupted({
    lookupFactory: (request) => bindFrozenJournalLookup("not_started.lookup.json", {
      requestId: request.request_id,
      action: request.action,
      executionAttempt: request.execution_attempt,
    }),
    maxAttempts: 1,
  });
  const final = await ctx.cp.processNext();
  assert.equal(final.status, "failed");
  assert.equal(final.executionAttempts, 1);
  assert.equal(ctx.counters.sideEffects, 0);
  assert.equal(await ctx.cp.processNext(), null);
});

test("journal request/action binding conflict blocks fail-closed before Vision", async () => {
  const ctx = buildInterrupted({
    lookupFactory: (request) => bindFrozenJournalLookup("completed.lookup.json", {
      requestId: `${request.request_id}-other`,
      action: request.action,
      executionAttempt: request.execution_attempt,
    }),
  });
  const final = await ctx.cp.processNext();
  assert.equal(final.status, "blocked");
  assert.equal(final.error.category, "journal_evidence_invalid");
  assert.equal(ctx.counters.sideEffects, 0);
  assert.equal(ctx.counters.observations, 0);
});

test("unknown journal lookup version blocks fail-closed before Vision", async () => {
  const ctx = buildInterrupted({
    lookupFactory: (request) => {
      const payload = bindFrozenJournalLookup("completed.lookup.json", {
        requestId: request.request_id,
        action: request.action,
        executionAttempt: request.execution_attempt,
      });
      payload.contract_version = "pc_executor.outcome_journal.lookup.v2";
      return payload;
    },
  });
  const final = await ctx.cp.processNext();
  assert.equal(final.status, "blocked");
  assert.equal(final.error.category, "journal_evidence_invalid");
  assert.equal(ctx.counters.sideEffects, 0);
  assert.equal(ctx.counters.observations, 0);
});

test("stale journal unknown followed by Vision stale/inconclusive/verified never reexecutes", async () => {
  const ctx = buildInterrupted({
    lookupFactory: (request) => bindFrozenJournalLookup("unknown.lookup.json", {
      requestId: request.request_id,
      action: request.action,
      executionAttempt: request.execution_attempt,
    }),
    verificationStatuses: ["stale", "inconclusive", "verified"],
  });
  assert.equal((await ctx.cp.processNext()).status, "reconciliation_wait");
  assert.equal((await ctx.cp.processNext()).status, "reconciliation_wait");
  const final = await ctx.cp.processNext();
  assert.equal(final.status, "succeeded");
  assert.equal(final.executionAttempts, 1);
  assert.equal(ctx.counters.sideEffects, 0);
  assert.equal(ctx.counters.journalReads, 3);
  assert.equal(ctx.counters.observations, 3);
});

test("journal recovery deterministic report matches frozen cross-repo report", async () => {
  const scenarios = [];

  for (const [name, fixture, statuses] of [
    ["completed", "completed.lookup.json", ["verified"]],
    ["unknown", "unknown.lookup.json", ["verified"]],
    ["truncated", "truncated_tail.lookup.json", ["stale", "inconclusive", "verified"]],
  ]) {
    const ctx = buildInterrupted({
      lookupFactory: (request) => bindFrozenJournalLookup(fixture, {
        requestId: request.request_id,
        action: request.action,
        executionAttempt: request.execution_attempt,
      }),
      verificationStatuses: statuses,
    });
    let final;
    for (let i = 0; i < 4; i += 1) {
      final = await ctx.cp.processNext();
      if (!final || ["succeeded", "failed", "blocked", "cancelled"].includes(final.status)) break;
    }
    const evidenceSummary = {
      status: final.status,
      executionAttempts: final.executionAttempts,
      verificationAttempts: final.verificationAttempts,
      reconciliationAttempts: final.reconciliationAttempts,
      sideEffectProviderCalls: ctx.counters.sideEffects,
      journalReads: ctx.counters.journalReads,
      observationCalls: ctx.counters.observations,
    };
    const transitionTrace = trace(ctx.cp, ctx.actionId);
    scenarios.push({
      name,
      ...evidenceSummary,
      transitionHash: hash(transitionTrace),
      evidenceHash: hash(evidenceSummary),
    });
  }

  const reportBase = {
    schema: "pc_control.executor_journal_recovery_report.v1",
    executorHead: "06217fe4246d0191ac3c93e69aac855bdd6e4136",
    controlBaseHead: "1e279e53a40adee973975944de1e17847496ebc4",
    scenarios,
  };
  const actual = {
    ...reportBase,
    aggregateTransitionEvidenceHash: hash(reportBase),
  };
  const expected = JSON.parse(
    readFileSync(new URL("../conformance/reports/executor-journal-recovery-v1.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(actual, expected);
});
