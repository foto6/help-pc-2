import { readFileSync } from "node:fs";
import {
  EXECUTOR_OUTCOME_JOURNAL_LOOKUP_V1,
  canonicalSha256,
  executorJournalExecutionId,
} from "../../src/index.js";

const BASE = new URL(
  "../../conformance/frozen/executor/06217fe4246d0191ac3c93e69aac855bdd6e4136/tests/fixtures/outcome_journal_v1/",
  import.meta.url,
);

export function readFrozenJournalFixture(name) {
  return JSON.parse(readFileSync(new URL(name, BASE), "utf8"));
}

export function bindFrozenJournalLookup(name, { requestId, action, executionAttempt }) {
  const payload = readFrozenJournalFixture(name);
  payload.request_id = requestId;
  payload.requestId = requestId;
  payload.action = action;
  payload.execution_attempt = executionAttempt;

  let previous = null;
  for (const record of payload.history) {
    record.request_id = requestId;
    record.action = action;
    record.execution_attempt = executionAttempt;
    record.execution_id = executorJournalExecutionId(requestId, action, executionAttempt);
    record.evidence.request_id = requestId;
    record.evidence.action = action;
    record.previous_record_sha256 = previous;
    const body = structuredClone(record);
    delete body.record_sha256;
    record.record_sha256 = canonicalSha256(body);
    previous = record.record_sha256;
  }

  payload.latest_valid_record = payload.history.length
    ? structuredClone(payload.history.at(-1))
    : null;
  payload.latest_valid_evidence = payload.latest_valid_record
    ? structuredClone(payload.latest_valid_record.evidence)
    : null;
  payload.provenance.matched_records = payload.history.length;
  return payload;
}

export function missingJournalLookup({ requestId, action, executionAttempt }) {
  return {
    contract_version: EXECUTOR_OUTCOME_JOURNAL_LOOKUP_V1,
    source: "help-pc-1.outcome-journal",
    request_id: requestId,
    requestId,
    action,
    execution_attempt: executionAttempt,
    outcome: "unknown",
    reason: "no_evidence",
    replay_authorized: false,
    latest_valid_evidence: null,
    latest_valid_record: null,
    history: [],
    provenance: {
      record_contract_version: "pc_executor.outcome_journal.record.v1",
      total_valid_records: 0,
      matched_records: 0,
      journal_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      integrity: "clean",
      corruption: null,
    },
  };
}
