import { readFileSync } from "node:fs";
import {
  canonicalSha256,
  executorJournalExecutionId,
} from "../../src/index.js";

const EXEC_BASE = new URL(
  "../../conformance/frozen/executor/d0ccb0f390474fc3fc091e51c25f7ef8771b0f09/tests/fixtures/",
  import.meta.url,
);
const VISION_BASE = new URL(
  "../../conformance/frozen/vision/df9a84590a4a9d8fe8dfdec9ff195fe4821397f6/tests/fixtures/",
  import.meta.url,
);

export const TARGET = Object.freeze({
  element_id: "uia:save-button",
  node_id: "save-button",
  automation_id: "save",
});

export function readExecutorJson(relative) {
  return JSON.parse(readFileSync(new URL(relative, EXEC_BASE), "utf8"));
}

export function readVisionJson(relative) {
  return JSON.parse(readFileSync(new URL(relative, VISION_BASE), "utf8"));
}

export function readVisionText(relative) {
  return readFileSync(new URL(relative, VISION_BASE), "utf8").trimEnd();
}

export function verificationInput() {
  return readVisionJson("post_action_verification_result_v1/verification_input.json");
}

export function bindOutcome(name, request, fields = {}) {
  const payload = readExecutorJson(name);
  payload.request_id = request.request_id;
  payload.action = request.action;
  if (fields.effect_state !== undefined) payload.effect_state = fields.effect_state;
  if (fields.reason !== undefined) payload.reason = fields.reason;
  return payload;
}

export function completedResult(request) {
  return {
    request_id: request.request_id,
    action: request.action,
    ok: true,
    status: "completed",
    started_at: "2026-09-27T12:00:00.000Z",
    finished_at: "2026-09-27T12:00:00.001Z",
    data: {},
    error: null,
    error_kind: null,
    dry_run: false,
    outcome_evidence: bindOutcome("action_outcome_v1.json", request),
  };
}

export function unknownDispatchError() {
  const error = new Error("transport lost after dispatch");
  error.code = "EXECUTOR_TIMEOUT";
  error.category = "timeout";
  error.dispatchState = "unknown";
  error.outcomeUncertain = true;
  return error;
}

export function bindJournalLookup(name, { requestId, action, executionAttempt }) {
  const payload = readExecutorJson(`outcome_journal_v1/${name}`);
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
  payload.latest_valid_record = payload.history.length ? structuredClone(payload.history.at(-1)) : null;
  payload.latest_valid_evidence = payload.latest_valid_record ? structuredClone(payload.latest_valid_record.evidence) : null;
  payload.provenance.matched_records = payload.history.length;
  return payload;
}

function frameProvenance(snapshot) {
  const frame = snapshot.frame;
  const windowIds = [...new Set(snapshot.uia_nodes.map((node) => node.window_id).filter(Boolean))].sort();
  return {
    captured_at_ms: frame.captured_at_ms,
    display_id: frame.display_id,
    frame_id: frame.frame_id,
    image_digest: frame.image_digest,
    screen_bounds: structuredClone(frame.screen_bounds),
    sequence: frame.sequence,
    window_ids: windowIds,
  };
}

export function bindSemanticDelta(name, input = verificationInput(), target = TARGET) {
  const payload = readVisionJson(`semantic_delta_v1/${name}`);
  payload.binding.before_snapshot_sha256 = canonicalSha256(input.before);
  payload.binding.after_snapshot_sha256 = canonicalSha256(input.after);
  payload.binding.verification_input_digest = canonicalSha256(input);
  payload.binding.target = structuredClone(target);
  payload.provenance.before = frameProvenance(input.before);
  payload.provenance.after = frameProvenance(input.after);
  return payload;
}

export function bindObservationConsistency(name, {
  input = verificationInput(),
  semanticDelta,
  target = TARGET,
} = {}) {
  const payload = readVisionJson(`observation_consistency_v1/${name}`);
  payload.binding.snapshot_sha256 = canonicalSha256(input.after);
  payload.binding.verification_input_digest = canonicalSha256(input);
  payload.binding.semantic_delta_sha256 = semanticDelta ? canonicalSha256(semanticDelta) : null;
  payload.binding.target = structuredClone(target);
  payload.identity.snapshot = frameProvenance(input.after);
  return payload;
}

export function sensorBundle({
  consistency = "matching_save_flow.json",
  delta = "save_success.json",
  verification = "verified.json",
  target = TARGET,
} = {}) {
  const input = verificationInput();
  const semanticDelta = bindSemanticDelta(delta, input, target);
  const observationConsistency = bindObservationConsistency(consistency, {
    input,
    semanticDelta,
    target,
  });
  const verificationResult = readVisionJson(`post_action_verification_result_v1/${verification}`);
  return { semanticDelta, observationConsistency, verificationResult };
}

export function wrongTargetBundle() {
  const target = { element_id: "uia:other", node_id: "other", automation_id: "other" };
  return sensorBundle({ target });
}
