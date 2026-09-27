import { readFileSync } from "node:fs";
import {
  canonicalSha256,
  executorJournalExecutionId,
} from "../../src/index.js";

const EXECUTOR_HEAD = "2cc1e40f792a3d74560b726a0d246c90b7f077e9";
const VISION_HEAD = "51b96fb41cb72cdfc4a03129d14b9afc5fe750fd";
const EXEC_BASE = new URL(
  `../../conformance/frozen/executor/${EXECUTOR_HEAD}/tests/fixtures/`,
  import.meta.url,
);
const VISION_BASE = new URL(
  `../../conformance/frozen/vision/${VISION_HEAD}/tests/fixtures/`,
  import.meta.url,
);

export const TARGET_IDENTITY = Object.freeze({
  element_id: "uia:save-button",
  node_id: "save-button",
  automation_id: "save",
});

export function readExecutorCurrentJson(relative) {
  return JSON.parse(readFileSync(new URL(relative, EXEC_BASE), "utf8"));
}

export function readVisionCurrentJson(relative) {
  return JSON.parse(readFileSync(new URL(relative, VISION_BASE), "utf8"));
}

export function readVisionCurrentText(relative) {
  return readFileSync(new URL(relative, VISION_BASE), "utf8").trimEnd();
}

export function verificationInput() {
  return readVisionCurrentJson("post_action_verification_result_v1/verification_input.json");
}

export function observationEpochCorpus() {
  return readVisionCurrentJson("observation_epoch_v1/scenarios.json");
}
export function currentCapabilities() {
  return readExecutorCurrentJson("preflight_v1/capabilities.json");
}

export function bindCurrentPreflightResult(name, { requestId, action, capabilitiesDigest }) {
  const payload = readExecutorCurrentJson(`preflight_v1/${name}`);
  payload.request_id = requestId;
  payload.action = action;
  if (capabilitiesDigest) payload.capabilities_digest = capabilitiesDigest;
  return payload;
}


export function groundedTargetFromSnapshot(snapshot) {
  const grounded = snapshot.grounded.find((item) => item.element_id === TARGET_IDENTITY.element_id);
  if (!grounded) throw new Error("save target missing from snapshot fixture");
  return {
    contract_version: "vision.grounded_target.v1",
    frame: {
      frame_id: snapshot.frame.frame_id,
      sequence: snapshot.frame.sequence,
      captured_at_ms: snapshot.frame.captured_at_ms,
      image_digest: snapshot.frame.image_digest,
      display_id: snapshot.frame.display_id,
    },
    target: {
      element_id: grounded.element_id,
      node_id: grounded.node_id,
      automation_id: grounded.automation_id,
      role: grounded.role,
      name: grounded.name,
      confidence: grounded.confidence,
      sources: [...grounded.sources],
      bounds_screen: structuredClone(grounded.bounds_screen),
      click_point_screen: structuredClone(grounded.click_point_screen),
    },
  };
}

function recomputeContext(payload) {
  if (payload.target) {
    const targetBody = {
      automation_id: payload.target.automation_id,
      control_type: payload.target.control_type,
      class_name: payload.target.class_name,
      native_handle: payload.target.native_handle,
      runtime_id: payload.target.runtime_id,
    };
    payload.target.identity_digest = canonicalSha256(targetBody);
  }
  const body = structuredClone(payload);
  delete body.context_digest;
  payload.context_digest = canonicalSha256(body);
  return payload;
}

export function executionContextBinding(requestId, {
  action = "vision.target.invoke",
  processId = 42,
  processStartEpochMs = 1000,
  windowHandle = 77,
  displayId = "display:a",
  captureId = "shot:wave9",
  runtimeId = [1, 2, 3],
} = {}) {
  const payload = readExecutorCurrentJson("execution_context_binding_v1/uia.binding.json");
  payload.request_id = requestId;
  payload.action = action;
  payload.process.process_id = processId;
  payload.process.start_epoch_ms = processStartEpochMs;
  payload.window.window_handle = windowHandle;
  payload.display.display_id = displayId;
  payload.display.capture_id = captureId;
  payload.target.runtime_id = [...runtimeId];
  return recomputeContext(payload);
}

export function contextMismatchValidation(binding, mismatches) {
  const payload = readExecutorCurrentJson("execution_context_binding_v1/context_mismatch.validation.json");
  payload.binding_digest = binding.context_digest;
  payload.mismatches = [...new Set(mismatches)].sort();
  return payload;
}

function outcome(name, requestId, action, reason = null) {
  const payload = readExecutorCurrentJson(name);
  payload.request_id = requestId;
  payload.action = action;
  if (reason !== null) payload.reason = reason;
  return payload;
}

export function contextMismatchResult(request, binding, mismatches) {
  return {
    request_id: request.request_id,
    action: request.action,
    ok: false,
    status: "blocked",
    started_at: "2026-09-27T13:00:00.000Z",
    finished_at: "2026-09-27T13:00:00.001Z",
    data: {
      execution_context_validation: contextMismatchValidation(binding, mismatches),
    },
    error: `context_mismatch: ${mismatches.join(", ")}`,
    error_kind: "policy_blocked",
    dry_run: false,
    outcome_evidence: outcome("action_outcome_v1_not_started.json", request.request_id, request.action, "policy_blocked"),
  };
}

export function completedResult(request) {
  return {
    request_id: request.request_id,
    action: request.action,
    ok: true,
    status: "completed",
    started_at: "2026-09-27T13:00:00.000Z",
    finished_at: "2026-09-27T13:00:00.001Z",
    data: {},
    error: null,
    error_kind: null,
    dry_run: false,
    outcome_evidence: outcome("action_outcome_v1.json", request.request_id, request.action, "completed"),
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
  const payload = readExecutorCurrentJson(`outcome_journal_v1/${name}`);
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

export function bindSemanticDelta(name, input = verificationInput(), target = TARGET_IDENTITY) {
  const payload = readVisionCurrentJson(`semantic_delta_v1/${name}`);
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
  target = TARGET_IDENTITY,
} = {}) {
  const payload = readVisionCurrentJson(`observation_consistency_v1/${name}`);
  payload.binding.snapshot_sha256 = canonicalSha256(input.after);
  payload.binding.verification_input_digest = canonicalSha256(input);
  payload.binding.semantic_delta_sha256 = semanticDelta ? canonicalSha256(semanticDelta) : null;
  payload.binding.target = structuredClone(target);
  payload.identity.snapshot = frameProvenance(input.after);
  return payload;
}

function displayFingerprint(snapshot) {
  return canonicalSha256({
    display_id: snapshot.frame.display_id,
    screen_bounds: {
      x: Number(snapshot.frame.screen_bounds.x),
      y: Number(snapshot.frame.screen_bounds.y),
      width: Number(snapshot.frame.screen_bounds.width),
      height: Number(snapshot.frame.screen_bounds.height),
    },
    image_width: snapshot.frame.image_width,
    image_height: snapshot.frame.image_height,
  });
}

function stableIdentity(snapshot, {
  processId,
  processStartEpochMs,
  windowId,
  captureSourceId,
  coordinateSpace,
  rootFingerprint,
}) {
  return {
    process_id: processId,
    process_start_epoch_ms: processStartEpochMs,
    window_id: windowId,
    display_fingerprint: displayFingerprint(snapshot),
    capture_source_id: captureSourceId,
    coordinate_space: coordinateSpace,
    root_uia_fingerprint: rootFingerprint,
    root_fingerprint_basis: "window_process_fallback",
  };
}

export function observationEpoch(snapshot, {
  previousEpoch = null,
  processId = 42,
  processStartEpochMs = 1000,
  windowId = "hwnd:77",
  captureSourceId = `foto6/help-pc-1@${EXECUTOR_HEAD}`,
  coordinateSpace = "physical_screen_px",
  captureId = null,
  replacementReasons = [],
} = {}) {
  const rootFingerprint = canonicalSha256({ window_id: windowId, process_id: processId });
  const stable = stableIdentity(snapshot, {
    processId,
    processStartEpochMs,
    windowId,
    captureSourceId,
    coordinateSpace,
    rootFingerprint,
  });
  const stableDigest = canonicalSha256(stable);
  const relation = previousEpoch === null ? "initial" : replacementReasons.length ? "replaced" : "same";
  const ordinal = previousEpoch === null ? 0 : relation === "replaced" ? previousEpoch.ordinal + 1 : previousEpoch.ordinal;
  const predecessor = previousEpoch?.epoch_id ?? null;
  const epochId = previousEpoch !== null && relation === "same"
    ? previousEpoch.epoch_id
    : `epoch:${canonicalSha256({
        stable_identity_sha256: stableDigest,
        ordinal,
        predecessor_epoch_id: predecessor,
      })}`;
  return {
    contract_version: "vision.observation_epoch.v1",
    epoch_id: epochId,
    ordinal,
    relation,
    predecessor_epoch_id: predecessor,
    snapshot_sha256: canonicalSha256(snapshot),
    frame: {
      frame_id: snapshot.frame.frame_id,
      sequence: snapshot.frame.sequence,
      captured_at_ms: snapshot.frame.captured_at_ms,
      image_digest: snapshot.frame.image_digest,
      display_id: snapshot.frame.display_id,
    },
    stable_identity_sha256: stableDigest,
    stable_identity: stable,
    provenance: {
      process_id: processId,
      process_start_epoch_ms: processStartEpochMs,
      window_id: windowId,
      capture_source_id: captureSourceId,
      coordinate_space: coordinateSpace,
      capture_id: captureId,
      capture_sha256: null,
      root_uia_fingerprint: rootFingerprint,
      root_fingerprint_basis: "window_process_fallback",
    },
    transition_reasons: [...new Set(replacementReasons)].sort(),
  };
}

export function targetLivenessLease(target, epoch, {
  maxSequenceDelta = 10,
  maxAgeMs = 10_000,
} = {}) {
  return {
    contract_version: "vision.target_liveness.v1",
    target_sha256: canonicalSha256(target),
    epoch_id: epoch.epoch_id,
    epoch_ordinal: epoch.ordinal,
    issued_frame_id: target.frame.frame_id,
    issued_sequence: target.frame.sequence,
    issued_at_ms: target.frame.captured_at_ms,
    max_sequence_delta: maxSequenceDelta,
    max_age_ms: maxAgeMs,
  };
}

export function epochPair(mode = "same") {
  const input = verificationInput();
  const before = observationEpoch(input.before, { captureId: "capture:before" });
  let options = { previousEpoch: before, captureId: "capture:after" };
  if (mode === "process_restart") {
    options = { ...options, processStartEpochMs: 2000, replacementReasons: ["process_start_epoch_changed"] };
  } else if (mode === "window_replaced") {
    options = { ...options, windowId: "hwnd:78", replacementReasons: ["root_uia_replaced", "window_identity_changed"] };
  } else if (mode === "display_changed") {
    options = { ...options, replacementReasons: ["display_provenance_changed"] };
  }
  const after = observationEpoch(input.after, options);
  return { before, after };
}

export function sensorEpochBundle({
  epochMode = "same",
  consistency = "matching_save_flow.json",
  delta = "save_success.json",
  verification = "verified.json",
  reacquireAfterEpochChange = false,
} = {}) {
  const input = verificationInput();
  const semanticDelta = bindSemanticDelta(delta, input, TARGET_IDENTITY);
  const observationConsistency = bindObservationConsistency(consistency, {
    input,
    semanticDelta,
    target: TARGET_IDENTITY,
  });
  const verificationResult = readVisionCurrentJson(`post_action_verification_result_v1/${verification}`);
  const { before, after } = epochPair(epochMode);
  const originalTarget = groundedTargetFromSnapshot(input.before);
  if (!reacquireAfterEpochChange) {
    return {
      semanticDelta,
      observationConsistency,
      observationEpoch: after,
      targetLiveness: targetLivenessLease(originalTarget, before),
      verificationResult,
    };
  }
  const reacquiredTarget = groundedTargetFromSnapshot(input.after);
  return {
    groundedTarget: reacquiredTarget,
    semanticDelta,
    observationConsistency,
    observationEpoch: after,
    targetLiveness: targetLivenessLease(reacquiredTarget, after),
    verificationResult,
  };
}
