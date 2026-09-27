import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  ConformanceValidationError,
  adaptExecutorOutcomeJournalLookupV1,
  executorJournalExecutionId,
  parseExecutorOutcomeJournalLookupV1,
} from "../../src/index.js";
import {
  bindFrozenJournalLookup,
  missingJournalLookup,
  readFrozenJournalFixture,
} from "../support/journal-fixtures.js";

const provenance = JSON.parse(
  readFileSync(new URL("../../conformance/JOURNAL_PROVENANCE.json", import.meta.url), "utf8"),
);

test("journal frozen corpus provenance pins exact producer bytes and hashes", () => {
  assert.equal(provenance.producer.commit_sha, "06217fe4246d0191ac3c93e69aac855bdd6e4136");
  assert.equal(provenance.producer.lookup_contract, "pc_executor.outcome_journal.lookup.v1");
  for (const entry of provenance.files) {
    const path = `${provenance.copied_root}/${entry.name}`;
    const blob = execFileSync("git", ["rev-parse", `HEAD:${path}`], { encoding: "utf8" }).trim();
    assert.equal(blob, entry.git_blob_sha1, path);
    const bytes = execFileSync("git", ["show", `HEAD:${path}`]);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256, path);
  }
});

test("authoritative journal lookup fixtures parse with producer semantics", () => {
  const cases = [
    ["completed.lookup.json", "succeeded", "clean"],
    ["unknown.lookup.json", "unknown", "clean"],
    ["not_started.lookup.json", "not_dispatched", "clean"],
    ["truncated_tail.lookup.json", "unknown", "corrupt"],
  ];
  for (const [name, outcome, integrity] of cases) {
    const parsed = parseExecutorOutcomeJournalLookupV1(readFrozenJournalFixture(name));
    assert.equal(parsed.outcome, outcome);
    assert.equal(parsed.provenance.integrity, integrity);
    assert.equal(parsed.replay_authorized, false);
  }
});

test("journal adapter binds request/action/attempt/execution correlation", () => {
  const requestId = "control-action-7";
  const action = "keyboard.press";
  const executionAttempt = 1;
  const lookup = bindFrozenJournalLookup("completed.lookup.json", { requestId, action, executionAttempt });
  const executionId = executorJournalExecutionId(requestId, action, executionAttempt);
  const adapted = adaptExecutorOutcomeJournalLookupV1(lookup, { requestId, action, executionAttempt, executionId });
  assert.equal(adapted.outcome, "succeeded");
  assert.equal(adapted.executionId, executionId);
  assert.equal(adapted.replayAuthorized, false);
  assert.equal(adapted.safeNotStarted, false);
});

test("clean not_started is evidence for existing retry policy but never replay authority", () => {
  const lookup = bindFrozenJournalLookup("not_started.lookup.json", {
    requestId: "control-action-safe",
    action: "keyboard.press",
    executionAttempt: 1,
  });
  const adapted = adaptExecutorOutcomeJournalLookupV1(lookup, {
    requestId: "control-action-safe",
    action: "keyboard.press",
    executionAttempt: 1,
  });
  assert.equal(adapted.outcome, "not_dispatched");
  assert.equal(adapted.safeNotStarted, true);
  assert.equal(adapted.replayAuthorized, false);
});

test("missing journal is a clean unknown lookup", () => {
  const raw = missingJournalLookup({ requestId: "missing", action: "keyboard.press", executionAttempt: 1 });
  const adapted = adaptExecutorOutcomeJournalLookupV1(raw, {
    requestId: "missing",
    action: "keyboard.press",
    executionAttempt: 1,
  });
  assert.equal(adapted.outcome, "unknown");
  assert.equal(adapted.reason, "no_evidence");
  assert.equal(adapted.conservative, true);
});

test("truncated tail stays conservative even with completed safe prefix", () => {
  const lookup = bindFrozenJournalLookup("truncated_tail.lookup.json", {
    requestId: "truncated",
    action: "keyboard.press",
    executionAttempt: 1,
  });
  const adapted = adaptExecutorOutcomeJournalLookupV1(lookup, {
    requestId: "truncated",
    action: "keyboard.press",
    executionAttempt: 1,
  });
  assert.equal(adapted.outcome, "unknown");
  assert.equal(adapted.integrity, "corrupt");
  assert.equal(adapted.corruptionKind, "truncated_tail");
  assert.equal(adapted.safeNotStarted, false);
});

test("journal unknown versions, extras, replay authority and non-truncated corruption fail closed", () => {
  const base = bindFrozenJournalLookup("completed.lookup.json", {
    requestId: "strict",
    action: "keyboard.press",
    executionAttempt: 1,
  });
  const mutations = [
    (p) => { p.contract_version = "pc_executor.outcome_journal.lookup.v2"; },
    (p) => { p.extra = true; },
    (p) => { p.replay_authorized = true; },
    (p) => {
      p.provenance.integrity = "corrupt";
      p.provenance.corruption = {
        kind: "malformed_tail",
        line_number: 2,
        byte_offset: 12,
        detail: "bad hash",
        safe_prefix_bytes: 12,
      };
      p.outcome = "unknown";
      p.reason = "journal_malformed_tail";
    },
  ];
  for (const mutate of mutations) {
    const payload = structuredClone(base);
    mutate(payload);
    assert.throws(() => parseExecutorOutcomeJournalLookupV1(payload), ConformanceValidationError);
  }
});

test("journal evidence for a different logical action fails request/action/attempt binding", () => {
  const raw = bindFrozenJournalLookup("completed.lookup.json", {
    requestId: "other-request",
    action: "keyboard.press",
    executionAttempt: 2,
  });
  assert.throws(
    () => parseExecutorOutcomeJournalLookupV1(raw, {
      requestId: "control-request",
      action: "keyboard.press",
      executionAttempt: 2,
    }),
    (error) => error.code === "EXECUTOR_JOURNAL_BINDING_MISMATCH",
  );
  assert.throws(
    () => parseExecutorOutcomeJournalLookupV1(raw, {
      requestId: "other-request",
      action: "uia.invoke",
      executionAttempt: 2,
    }),
    (error) => error.code === "EXECUTOR_JOURNAL_BINDING_MISMATCH",
  );
  assert.throws(
    () => parseExecutorOutcomeJournalLookupV1(raw, {
      requestId: "other-request",
      action: "keyboard.press",
      executionAttempt: 1,
    }),
    (error) => error.code === "EXECUTOR_JOURNAL_BINDING_MISMATCH",
  );
});

test("journal record execution_id tampering fails strict correlation validation", () => {
  const raw = bindFrozenJournalLookup("unknown.lookup.json", {
    requestId: "execution-bind",
    action: "keyboard.press",
    executionAttempt: 1,
  });
  raw.history[0].execution_id = `exec:${"0".repeat(64)}`;
  raw.latest_valid_record = structuredClone(raw.history[0]);
  assert.throws(
    () => parseExecutorOutcomeJournalLookupV1(raw),
    (error) => error.code === "EXECUTOR_JOURNAL_BINDING_MISMATCH",
  );
});
