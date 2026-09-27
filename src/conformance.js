import { createHash } from "node:crypto";

export const EXECUTOR_OUTCOME_V1 = "pc_executor.action_outcome.v1";
export const EXECUTOR_OUTCOME_JOURNAL_RECORD_V1 = "pc_executor.outcome_journal.record.v1";
export const EXECUTOR_OUTCOME_JOURNAL_LOOKUP_V1 = "pc_executor.outcome_journal.lookup.v1";
export const VISION_VERIFICATION_INPUT_V1 = "vision.post_action_verification_input.v1";
export const VISION_VERIFICATION_RESULT_V1 = "vision.post_action_verification_result.v1";
export const VISION_PERCEPTION_SNAPSHOT_V2 = "vision.perception_snapshot.v2";

const EXECUTOR_STATES = new Set(["not_started", "completed", "unknown"]);
const EXECUTOR_ACTIONS = new Set([
  "vision.target.invoke",
  "uia.invoke",
  "uia.focus",
  "uia.set_value",
  "mouse.click",
  "keyboard.press",
  "keyboard.type_text",
  "clipboard.set",
  "shell.run",
]);
const EXECUTOR_REASONS = new Set([
  "dispatch_started",
  "completed",
  "dry_run",
  "stale_target",
  "ambiguous_target",
  "policy_blocked",
  "timeout",
  "cancelled",
  "transient",
  "executor_failure",
]);
const VISION_STATUSES = new Set(["verified", "failed", "stale", "inconclusive"]);
const HEX64 = /^[0-9a-f]{64}$/;

export class ConformanceValidationError extends Error {
  constructor(message, code = "CONFORMANCE_VALIDATION_FAILED") {
    super(message);
    this.name = "ConformanceValidationError";
    this.code = code;
  }
}

function object(value, where) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConformanceValidationError(`${where} must be an object`);
  return value;
}

function exactKeys(value, expected, where) {
  const actual = Object.keys(object(value, where)).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    const actualSet = new Set(actual);
    const wantedSet = new Set(wanted);
    const missing = wanted.filter((key) => !actualSet.has(key));
    const extra = actual.filter((key) => !wantedSet.has(key));
    throw new ConformanceValidationError(`${where} keys mismatch; missing=${JSON.stringify(missing)}, extra=${JSON.stringify(extra)}`);
  }
}

function string(value, where, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !value) throw new ConformanceValidationError(`${where} must be a non-empty string`);
  return value;
}

function boolean(value, where) {
  if (typeof value !== "boolean") throw new ConformanceValidationError(`${where} must be a boolean`);
  return value;
}

function integer(value, where, { minimum = null } = {}) {
  if (!Number.isInteger(value) || (minimum !== null && value < minimum)) throw new ConformanceValidationError(`${where} must be an integer`);
  return value;
}

function number(value, where, { minimum = 0, maximum = 1, nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ConformanceValidationError(`${where} must be a finite number in [${minimum}, ${maximum}]`);
  }
  return value;
}

function digest(value, where) {
  const parsed = string(value, where);
  if (!HEX64.test(parsed)) throw new ConformanceValidationError(`${where} must be a lowercase SHA-256 digest`);
  return parsed;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw new ConformanceValidationError("canonical JSON cannot contain non-finite numbers");
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function canonicalSha256(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function gitBlobSha1(content) {
  const bytes = Buffer.from(content, "utf8");
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

export function parseExecutorActionOutcomeV1(payload, { requestId = null, action = null } = {}) {
  const root = object(payload, "executor outcome");
  exactKeys(root, [
    "contract_version",
    "request_id",
    "action",
    "effect_state",
    "dispatch_started",
    "completion_observed",
    "reexecution_safe",
    "reconciliation_required",
    "observed_at",
    "reason",
  ], "executor outcome");
  if (string(root.contract_version, "contract_version") !== EXECUTOR_OUTCOME_V1) throw new ConformanceValidationError("unsupported Executor outcome contract_version");
  const parsed = {
    contract_version: root.contract_version,
    request_id: string(root.request_id, "request_id"),
    action: string(root.action, "action"),
    effect_state: string(root.effect_state, "effect_state"),
    dispatch_started: boolean(root.dispatch_started, "dispatch_started"),
    completion_observed: boolean(root.completion_observed, "completion_observed"),
    reexecution_safe: boolean(root.reexecution_safe, "reexecution_safe"),
    reconciliation_required: boolean(root.reconciliation_required, "reconciliation_required"),
    observed_at: string(root.observed_at, "observed_at"),
    reason: string(root.reason, "reason"),
  };
  if (!EXECUTOR_ACTIONS.has(parsed.action)) throw new ConformanceValidationError("Executor outcome action is not side-effecting in v1");
  if (!EXECUTOR_STATES.has(parsed.effect_state)) throw new ConformanceValidationError("unsupported Executor effect_state");
  if (!EXECUTOR_REASONS.has(parsed.reason)) throw new ConformanceValidationError("unsupported Executor outcome reason");
  if (requestId !== null && parsed.request_id !== requestId) throw new ConformanceValidationError("Executor outcome request_id binding mismatch", "EXECUTOR_OUTCOME_BINDING_MISMATCH");
  if (action !== null && parsed.action !== action) throw new ConformanceValidationError("Executor outcome action binding mismatch", "EXECUTOR_OUTCOME_BINDING_MISMATCH");

  let expected;
  if (parsed.effect_state === "not_started") expected = [false, true, false];
  else if (parsed.effect_state === "completed") {
    if (!parsed.dispatch_started) throw new ConformanceValidationError("completed Executor outcome requires dispatch_started=true");
    expected = [true, false, false];
  } else {
    if (!parsed.dispatch_started) throw new ConformanceValidationError("unknown Executor outcome requires dispatch_started=true");
    expected = [false, false, true];
  }
  const observed = [parsed.completion_observed, parsed.reexecution_safe, parsed.reconciliation_required];
  if (observed.some((value, index) => value !== expected[index])) throw new ConformanceValidationError("Executor outcome flags are inconsistent with effect_state");
  return Object.freeze(structuredClone(parsed));
}

export function adaptExecutorActionOutcomeV1(payload, expected = {}) {
  const parsed = parseExecutorActionOutcomeV1(payload, expected);
  const outcome = parsed.effect_state === "not_started" ? "not_dispatched" : parsed.effect_state === "completed" ? "succeeded" : "unknown";
  return Object.freeze({
    source: "help-pc-1",
    contract: EXECUTOR_OUTCOME_V1,
    requestId: parsed.request_id,
    action: parsed.action,
    outcome,
    effectState: parsed.effect_state,
    reason: parsed.reason,
    dispatchStarted: parsed.dispatch_started,
    completionObserved: parsed.completion_observed,
    reexecutionSafe: parsed.reexecution_safe,
    reconciliationRequired: parsed.reconciliation_required,
    observedAt: parsed.observed_at,
    raw: structuredClone(parsed),
  });
}


export function executorJournalExecutionId(requestId, action, executionAttempt) {
  const request = string(requestId, "journal execution request_id");
  const actionName = string(action, "journal execution action");
  const attempt = integer(executionAttempt, "journal execution_attempt", { minimum: 1 });
  const hash = createHash("sha256");
  hash.update(request, "utf8");
  hash.update(Buffer.from([0]));
  hash.update(actionName, "utf8");
  hash.update(Buffer.from([0]));
  hash.update(String(attempt), "utf8");
  return `exec:${hash.digest("hex")}`;
}

function parseJournalRecordV1(payload, { requestId, action, executionAttempt, executionId } = {}) {
  const root = object(payload, "journal record");
  exactKeys(root, [
    "contract_version", "journal_sequence", "recorded_at", "request_id", "action",
    "execution_id", "execution_attempt", "transition", "evidence",
    "previous_record_sha256", "record_sha256",
  ], "journal record");
  if (string(root.contract_version, "journal record.contract_version") !== EXECUTOR_OUTCOME_JOURNAL_RECORD_V1) {
    throw new ConformanceValidationError("unsupported Executor journal record version", "EXECUTOR_JOURNAL_VERSION_MISMATCH");
  }
  const parsed = {
    contract_version: root.contract_version,
    journal_sequence: integer(root.journal_sequence, "journal record.journal_sequence", { minimum: 1 }),
    recorded_at: string(root.recorded_at, "journal record.recorded_at"),
    request_id: string(root.request_id, "journal record.request_id"),
    action: string(root.action, "journal record.action"),
    execution_id: string(root.execution_id, "journal record.execution_id"),
    execution_attempt: integer(root.execution_attempt, "journal record.execution_attempt", { minimum: 1 }),
    transition: string(root.transition, "journal record.transition"),
    evidence: null,
    previous_record_sha256: root.previous_record_sha256 === null ? null : digest(root.previous_record_sha256, "journal record.previous_record_sha256"),
    record_sha256: digest(root.record_sha256, "journal record.record_sha256"),
  };
  if (!["dispatch_started", "terminal"].includes(parsed.transition)) {
    throw new ConformanceValidationError("unsupported Executor journal transition");
  }
  parsed.evidence = parseExecutorActionOutcomeV1(root.evidence, { requestId: parsed.request_id, action: parsed.action });
  const expectedExecutionId = executorJournalExecutionId(parsed.request_id, parsed.action, parsed.execution_attempt);
  if (parsed.execution_id !== expectedExecutionId) {
    throw new ConformanceValidationError("journal execution_id correlation mismatch", "EXECUTOR_JOURNAL_BINDING_MISMATCH");
  }
  const body = {
    contract_version: parsed.contract_version,
    journal_sequence: parsed.journal_sequence,
    recorded_at: parsed.recorded_at,
    request_id: parsed.request_id,
    action: parsed.action,
    execution_id: parsed.execution_id,
    execution_attempt: parsed.execution_attempt,
    transition: parsed.transition,
    evidence: structuredClone(parsed.evidence),
    previous_record_sha256: parsed.previous_record_sha256,
  };
  if (canonicalSha256(body) !== parsed.record_sha256) {
    throw new ConformanceValidationError("journal record_sha256 mismatch", "EXECUTOR_JOURNAL_INTEGRITY_FAILURE");
  }
  if (parsed.transition === "dispatch_started") {
    if (parsed.evidence.effect_state !== "unknown" || !parsed.evidence.dispatch_started || parsed.evidence.reason !== "dispatch_started") {
      throw new ConformanceValidationError("dispatch_started journal record has inconsistent evidence");
    }
  } else if (parsed.evidence.reason === "dispatch_started") {
    throw new ConformanceValidationError("terminal journal record cannot carry dispatch_started reason");
  }
  if (requestId !== undefined && parsed.request_id !== requestId) {
    throw new ConformanceValidationError("journal record request_id binding mismatch", "EXECUTOR_JOURNAL_BINDING_MISMATCH");
  }
  if (action !== undefined && parsed.action !== action) {
    throw new ConformanceValidationError("journal record action binding mismatch", "EXECUTOR_JOURNAL_BINDING_MISMATCH");
  }
  if (executionAttempt !== undefined && parsed.execution_attempt !== executionAttempt) {
    throw new ConformanceValidationError("journal record execution_attempt binding mismatch", "EXECUTOR_JOURNAL_BINDING_MISMATCH");
  }
  if (executionId !== undefined && parsed.execution_id !== executionId) {
    throw new ConformanceValidationError("journal record execution_id binding mismatch", "EXECUTOR_JOURNAL_BINDING_MISMATCH");
  }
  return Object.freeze(parsed);
}

function parseJournalCorruption(value) {
  if (value === null) return null;
  const root = object(value, "journal provenance.corruption");
  exactKeys(root, ["kind", "line_number", "byte_offset", "detail", "safe_prefix_bytes"], "journal provenance.corruption");
  const parsed = {
    kind: string(root.kind, "journal corruption.kind"),
    line_number: integer(root.line_number, "journal corruption.line_number", { minimum: 0 }),
    byte_offset: integer(root.byte_offset, "journal corruption.byte_offset", { minimum: 0 }),
    detail: string(root.detail, "journal corruption.detail"),
    safe_prefix_bytes: integer(root.safe_prefix_bytes, "journal corruption.safe_prefix_bytes", { minimum: 0 }),
  };
  if (!["truncated_tail", "malformed_tail", "malformed_record", "request_action_conflict"].includes(parsed.kind)) {
    throw new ConformanceValidationError("unsupported journal corruption kind");
  }
  return Object.freeze(parsed);
}

export function parseExecutorOutcomeJournalLookupV1(payload, {
  requestId = null,
  action = null,
  executionAttempt = null,
  executionId = null,
} = {}) {
  const root = object(payload, "outcome journal lookup");
  exactKeys(root, [
    "contract_version", "source", "request_id", "requestId", "action", "execution_attempt",
    "outcome", "reason", "replay_authorized", "latest_valid_evidence",
    "latest_valid_record", "history", "provenance",
  ], "outcome journal lookup");
  if (string(root.contract_version, "journal lookup.contract_version") !== EXECUTOR_OUTCOME_JOURNAL_LOOKUP_V1) {
    throw new ConformanceValidationError("unsupported Executor journal lookup version", "EXECUTOR_JOURNAL_VERSION_MISMATCH");
  }
  if (string(root.source, "journal lookup.source") !== "help-pc-1.outcome-journal") {
    throw new ConformanceValidationError("unsupported Executor journal lookup source");
  }
  const parsedRequestId = string(root.request_id, "journal lookup.request_id");
  if (string(root.requestId, "journal lookup.requestId") !== parsedRequestId) {
    throw new ConformanceValidationError("journal lookup requestId alias mismatch", "EXECUTOR_JOURNAL_BINDING_MISMATCH");
  }
  const parsedAction = string(root.action, "journal lookup.action");
  const parsedAttempt = root.execution_attempt === null
    ? null
    : integer(root.execution_attempt, "journal lookup.execution_attempt", { minimum: 1 });
  const outcome = string(root.outcome, "journal lookup.outcome");
  if (!["succeeded", "unknown", "not_dispatched", "blocked", "cancelled"].includes(outcome)) {
    throw new ConformanceValidationError("unsupported journal lookup outcome");
  }
  if (boolean(root.replay_authorized, "journal lookup.replay_authorized") !== false) {
    throw new ConformanceValidationError("journal lookup must never authorize replay", "EXECUTOR_JOURNAL_REPLAY_AUTHORITY_INVALID");
  }
  if (requestId !== null && parsedRequestId !== requestId) {
    throw new ConformanceValidationError("journal lookup request_id binding mismatch", "EXECUTOR_JOURNAL_BINDING_MISMATCH");
  }
  if (action !== null && parsedAction !== action) {
    throw new ConformanceValidationError("journal lookup action binding mismatch", "EXECUTOR_JOURNAL_BINDING_MISMATCH");
  }
  if (executionAttempt !== null && parsedAttempt !== executionAttempt) {
    throw new ConformanceValidationError("journal lookup execution_attempt binding mismatch", "EXECUTOR_JOURNAL_BINDING_MISMATCH");
  }
  const expectedExecutionId = executionId ?? (
    executionAttempt !== null && requestId !== null && action !== null
      ? executorJournalExecutionId(requestId, action, executionAttempt)
      : null
  );

  if (!Array.isArray(root.history)) throw new ConformanceValidationError("journal lookup history must be an array");
  const history = root.history.map((record, index) => {
    const parsed = parseJournalRecordV1(record, {
      requestId: parsedRequestId,
      action: parsedAction,
      ...(parsedAttempt === null ? {} : { executionAttempt: parsedAttempt }),
      ...(expectedExecutionId === null ? {} : { executionId: expectedExecutionId }),
    });
    if (index > 0) {
      const previous = root.history[index - 1];
      if (parsed.journal_sequence <= previous.journal_sequence) {
        throw new ConformanceValidationError("journal lookup history sequence is not increasing");
      }
      if (parsed.previous_record_sha256 !== previous.record_sha256) {
        throw new ConformanceValidationError("journal lookup history hash chain mismatch", "EXECUTOR_JOURNAL_INTEGRITY_FAILURE");
      }
    }
    return parsed;
  });

  let latestRecord = null;
  if (root.latest_valid_record !== null) {
    latestRecord = parseJournalRecordV1(root.latest_valid_record, {
      requestId: parsedRequestId,
      action: parsedAction,
      ...(parsedAttempt === null ? {} : { executionAttempt: parsedAttempt }),
      ...(expectedExecutionId === null ? {} : { executionId: expectedExecutionId }),
    });
  }
  let latestEvidence = null;
  if (root.latest_valid_evidence !== null) {
    latestEvidence = parseExecutorActionOutcomeV1(root.latest_valid_evidence, { requestId: parsedRequestId, action: parsedAction });
  }
  if ((latestRecord === null) !== (latestEvidence === null)) {
    throw new ConformanceValidationError("journal lookup latest record/evidence nullability mismatch");
  }
  if (history.length === 0 && latestRecord !== null) {
    throw new ConformanceValidationError("journal lookup latest record requires history");
  }
  if (history.length > 0) {
    const last = history.at(-1);
    if (JSON.stringify(last) !== JSON.stringify(latestRecord)) {
      throw new ConformanceValidationError("journal lookup latest_valid_record does not equal history tail");
    }
    if (JSON.stringify(last.evidence) !== JSON.stringify(latestEvidence)) {
      throw new ConformanceValidationError("journal lookup latest_valid_evidence does not equal record evidence");
    }
  }

  const provenance = object(root.provenance, "journal lookup.provenance");
  exactKeys(provenance, [
    "record_contract_version", "total_valid_records", "matched_records",
    "journal_sha256", "integrity", "corruption",
  ], "journal lookup.provenance");
  if (string(provenance.record_contract_version, "journal provenance.record_contract_version") !== EXECUTOR_OUTCOME_JOURNAL_RECORD_V1) {
    throw new ConformanceValidationError("journal provenance record contract version mismatch", "EXECUTOR_JOURNAL_VERSION_MISMATCH");
  }
  const totalValidRecords = integer(provenance.total_valid_records, "journal provenance.total_valid_records", { minimum: 0 });
  const matchedRecords = integer(provenance.matched_records, "journal provenance.matched_records", { minimum: 0 });
  if (matchedRecords !== history.length || totalValidRecords < matchedRecords) {
    throw new ConformanceValidationError("journal provenance record counts are inconsistent");
  }
  const journalSha256 = digest(provenance.journal_sha256, "journal provenance.journal_sha256");
  const integrity = string(provenance.integrity, "journal provenance.integrity");
  if (!["clean", "corrupt"].includes(integrity)) throw new ConformanceValidationError("unsupported journal integrity value");
  const corruption = parseJournalCorruption(provenance.corruption);
  if ((integrity === "corrupt") !== (corruption !== null)) {
    throw new ConformanceValidationError("journal integrity/corruption flags are inconsistent");
  }

  let expectedOutcome = "unknown";
  let expectedReason = "no_evidence";
  if (corruption !== null) {
    expectedOutcome = "unknown";
    expectedReason = `journal_${corruption.kind}`;
  } else if (latestEvidence !== null) {
    if (latestEvidence.effect_state === "completed") expectedOutcome = "succeeded";
    else if (latestEvidence.effect_state === "unknown") expectedOutcome = "unknown";
    else if (latestEvidence.reason === "policy_blocked") expectedOutcome = "blocked";
    else if (latestEvidence.reason === "cancelled") expectedOutcome = "cancelled";
    else expectedOutcome = "not_dispatched";
    expectedReason = latestEvidence.reason;
  }
  if (outcome !== expectedOutcome || string(root.reason, "journal lookup.reason") !== expectedReason) {
    throw new ConformanceValidationError("journal lookup outcome/reason is inconsistent with durable evidence");
  }

  if (corruption !== null && corruption.kind !== "truncated_tail") {
    throw new ConformanceValidationError(
      `journal integrity failure: ${corruption.kind}`,
      "EXECUTOR_JOURNAL_INTEGRITY_FAILURE",
    );
  }

  return Object.freeze({
    contract_version: EXECUTOR_OUTCOME_JOURNAL_LOOKUP_V1,
    source: "help-pc-1.outcome-journal",
    request_id: parsedRequestId,
    action: parsedAction,
    execution_attempt: parsedAttempt,
    outcome,
    reason: root.reason,
    replay_authorized: false,
    latest_valid_evidence: latestEvidence,
    latest_valid_record: latestRecord,
    history: Object.freeze(history),
    provenance: Object.freeze({
      record_contract_version: EXECUTOR_OUTCOME_JOURNAL_RECORD_V1,
      total_valid_records: totalValidRecords,
      matched_records: matchedRecords,
      journal_sha256: journalSha256,
      integrity,
      corruption,
    }),
  });
}

export function adaptExecutorOutcomeJournalLookupV1(payload, expected = {}) {
  const parsed = parseExecutorOutcomeJournalLookupV1(payload, expected);
  const evidence = parsed.latest_valid_evidence;
  const safeNotStarted = (
    parsed.provenance.integrity === "clean" &&
    parsed.outcome === "not_dispatched" &&
    evidence?.effect_state === "not_started" &&
    evidence.reexecution_safe === true &&
    evidence.dispatch_started === false &&
    !["policy_blocked", "cancelled"].includes(evidence.reason)
  );
  return Object.freeze({
    source: parsed.source,
    contract: EXECUTOR_OUTCOME_JOURNAL_LOOKUP_V1,
    requestId: parsed.request_id,
    action: parsed.action,
    executionAttempt: parsed.execution_attempt,
    executionId: parsed.latest_valid_record?.execution_id ?? (
      parsed.execution_attempt === null ? null : executorJournalExecutionId(parsed.request_id, parsed.action, parsed.execution_attempt)
    ),
    outcome: parsed.outcome,
    reason: parsed.reason,
    replayAuthorized: false,
    safeNotStarted,
    conservative: parsed.provenance.integrity === "corrupt" || parsed.outcome === "unknown",
    integrity: parsed.provenance.integrity,
    corruptionKind: parsed.provenance.corruption?.kind ?? null,
    journalSha256: parsed.provenance.journal_sha256,
    latestValidEvidence: evidence ? structuredClone(evidence) : null,
    raw: structuredClone(parsed),
  });
}

function parseFrame(snapshot, where) {
  const root = object(snapshot, where);
  exactKeys(root, ["contract_version", "frame", "uia_nodes", "visual_candidates", "grounded", "state"], where);
  if (string(root.contract_version, `${where}.contract_version`) !== VISION_PERCEPTION_SNAPSHOT_V2) throw new ConformanceValidationError(`${where} has unsupported snapshot version`);
  const frame = object(root.frame, `${where}.frame`);
  exactKeys(frame, ["captured_at_ms", "display_id", "frame_id", "image_digest", "image_height", "image_width", "previous_frame_id", "screen_bounds", "sequence"], `${where}.frame`);
  const screen = object(frame.screen_bounds, `${where}.frame.screen_bounds`);
  exactKeys(screen, ["x", "y", "width", "height"], `${where}.frame.screen_bounds`);
  integer(frame.captured_at_ms, `${where}.frame.captured_at_ms`, { minimum: 0 });
  string(frame.display_id, `${where}.frame.display_id`);
  string(frame.frame_id, `${where}.frame.frame_id`);
  string(frame.image_digest, `${where}.frame.image_digest`);
  integer(frame.image_height, `${where}.frame.image_height`, { minimum: 1 });
  integer(frame.image_width, `${where}.frame.image_width`, { minimum: 1 });
  string(frame.previous_frame_id, `${where}.frame.previous_frame_id`, { nullable: true });
  integer(frame.sequence, `${where}.frame.sequence`, { minimum: 0 });
  for (const key of ["x", "y", "width", "height"]) {
    if (typeof screen[key] !== "number" || !Number.isFinite(screen[key])) throw new ConformanceValidationError(`${where}.frame.screen_bounds.${key} must be finite`);
  }
  for (const key of ["uia_nodes", "visual_candidates", "grounded"]) if (!Array.isArray(root[key])) throw new ConformanceValidationError(`${where}.${key} must be an array`);
  object(root.state, `${where}.state`);
  return {
    frame_id: frame.frame_id,
    sequence: frame.sequence,
    image_digest: frame.image_digest,
    display_id: frame.display_id,
    previous_frame_id: frame.previous_frame_id,
  };
}

function canonicalTextDigest(payload, canonicalJsonText) {
  if (typeof canonicalJsonText !== "string" || !canonicalJsonText.trim()) throw new ConformanceValidationError("canonical verification input JSON must be a non-empty string");
  const text = canonicalJsonText.trimEnd();
  let parsed;
  try { parsed = JSON.parse(text); } catch (error) { throw new ConformanceValidationError(`canonical verification input JSON is invalid: ${error.message}`); }
  if (canonicalJson(parsed) !== canonicalJson(payload)) throw new ConformanceValidationError("canonical verification input JSON does not match verification input object");
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function parseVisionVerificationInputV1(payload, { canonicalJsonText = null } = {}) {
  const root = object(payload, "verification input");
  exactKeys(root, ["contract_version", "before", "after", "expectation"], "verification input");
  if (string(root.contract_version, "verification input.contract_version") !== VISION_VERIFICATION_INPUT_V1) throw new ConformanceValidationError("unsupported Vision verification input version");
  const before = parseFrame(root.before, "verification input.before");
  const after = parseFrame(root.after, "verification input.after");
  if (after.sequence !== before.sequence + 1) throw new ConformanceValidationError("verification input snapshots are not direct sequence successors");
  if (after.previous_frame_id !== before.frame_id) throw new ConformanceValidationError("verification input after.previous_frame_id mismatch");
  if (after.display_id !== before.display_id) throw new ConformanceValidationError("verification input display_id changed");

  const expectation = object(root.expectation, "verification input.expectation");
  exactKeys(expectation, ["require_visual_change", "min_changed_ratio", "max_changed_ratio", "semantic_predicate"], "verification input.expectation");
  const requireVisualChange = boolean(expectation.require_visual_change, "verification input.expectation.require_visual_change");
  const min = number(expectation.min_changed_ratio, "verification input.expectation.min_changed_ratio");
  const max = number(expectation.max_changed_ratio, "verification input.expectation.max_changed_ratio");
  if (min > max) throw new ConformanceValidationError("verification input expectation min_changed_ratio exceeds max_changed_ratio");
  if (expectation.semantic_predicate !== null && typeof expectation.semantic_predicate !== "boolean") throw new ConformanceValidationError("verification input semantic_predicate must be boolean or null");

  return Object.freeze({
    payload: structuredClone(root),
    canonicalDigest: canonicalJsonText === null ? canonicalSha256(root) : canonicalTextDigest(root, canonicalJsonText),
    expectationDigest: canonicalSha256({
      require_visual_change: requireVisualChange,
      min_changed_ratio: min,
      max_changed_ratio: max,
      semantic_predicate: expectation.semantic_predicate,
    }),
    before: Object.freeze(before),
    after: Object.freeze(after),
    expectation: Object.freeze({
      require_visual_change: requireVisualChange,
      min_changed_ratio: min,
      max_changed_ratio: max,
      semantic_predicate: expectation.semantic_predicate,
    }),
  });
}

function frameBinding(value, where) {
  const root = object(value, where);
  exactKeys(root, ["frame_id", "sequence", "image_digest"], where);
  return Object.freeze({
    frame_id: string(root.frame_id, `${where}.frame_id`),
    sequence: integer(root.sequence, `${where}.sequence`, { minimum: 0 }),
    image_digest: string(root.image_digest, `${where}.image_digest`),
  });
}

function canonicalReasons(value, where) {
  if (!Array.isArray(value)) throw new ConformanceValidationError(`${where} must be an array`);
  const parsed = value.map((item, index) => string(item, `${where}[${index}]`));
  const canonical = [...new Set(parsed)].sort();
  if (canonical.length !== parsed.length || canonical.some((item, index) => item !== parsed[index])) throw new ConformanceValidationError(`${where} must be sorted and unique`);
  return Object.freeze(parsed);
}

function sameFrame(left, right) {
  return left.frame_id === right.frame_id && left.sequence === right.sequence && left.image_digest === right.image_digest;
}

export function parseVisionVerificationResultV1(payload, { verificationInput = null, verificationInputCanonicalJson = null, targetIdentity = null } = {}) {
  const root = object(payload, "verification result");
  exactKeys(root, ["contract_version", "status", "binding", "evidence", "target"], "verification result");
  if (string(root.contract_version, "verification result.contract_version") !== VISION_VERIFICATION_RESULT_V1) throw new ConformanceValidationError("unsupported Vision verification result version");
  const status = string(root.status, "verification result.status");
  if (!VISION_STATUSES.has(status)) throw new ConformanceValidationError("unsupported Vision verification result status");

  const binding = object(root.binding, "verification result.binding");
  exactKeys(binding, ["verification_input_digest", "expectation_digest", "before", "after"], "verification result.binding");
  const parsedBinding = {
    verification_input_digest: digest(binding.verification_input_digest, "verification result.binding.verification_input_digest"),
    expectation_digest: digest(binding.expectation_digest, "verification result.binding.expectation_digest"),
    before: frameBinding(binding.before, "verification result.binding.before"),
    after: frameBinding(binding.after, "verification result.binding.after"),
  };

  const evidence = object(root.evidence, "verification result.evidence");
  exactKeys(evidence, ["confidence", "changed_ratio", "semantic_predicate", "reasons", "stale_reasons", "expectation"], "verification result.evidence");
  const confidence = number(evidence.confidence, "verification result.evidence.confidence");
  const changedRatio = number(evidence.changed_ratio, "verification result.evidence.changed_ratio", { nullable: true });
  if (evidence.semantic_predicate !== null && typeof evidence.semantic_predicate !== "boolean") throw new ConformanceValidationError("verification result semantic_predicate must be boolean or null");
  const reasons = canonicalReasons(evidence.reasons, "verification result.evidence.reasons");
  const staleReasons = canonicalReasons(evidence.stale_reasons, "verification result.evidence.stale_reasons");
  const expectation = object(evidence.expectation, "verification result.evidence.expectation");
  exactKeys(expectation, ["require_visual_change", "min_changed_ratio", "max_changed_ratio"], "verification result.evidence.expectation");
  const expectationSummary = {
    require_visual_change: boolean(expectation.require_visual_change, "verification result.evidence.expectation.require_visual_change"),
    min_changed_ratio: number(expectation.min_changed_ratio, "verification result.evidence.expectation.min_changed_ratio"),
    max_changed_ratio: number(expectation.max_changed_ratio, "verification result.evidence.expectation.max_changed_ratio"),
  };
  if (expectationSummary.min_changed_ratio > expectationSummary.max_changed_ratio) throw new ConformanceValidationError("verification result expectation min exceeds max");
  const computedExpectationDigest = canonicalSha256({ ...expectationSummary, semantic_predicate: evidence.semantic_predicate });
  if (parsedBinding.expectation_digest !== computedExpectationDigest) throw new ConformanceValidationError("verification result expectation digest mismatch");

  let target = null;
  if (root.target !== null) {
    const targetRoot = object(root.target, "verification result.target");
    exactKeys(targetRoot, ["element_id", "node_id", "automation_id"], "verification result.target");
    target = Object.freeze({
      element_id: string(targetRoot.element_id, "verification result.target.element_id"),
      node_id: string(targetRoot.node_id, "verification result.target.node_id", { nullable: true }),
      automation_id: string(targetRoot.automation_id, "verification result.target.automation_id", { nullable: true }),
    });
  }

  if (status === "verified") {
    if (changedRatio === null || reasons.length || staleReasons.length) throw new ConformanceValidationError("verified result has inconsistent evidence");
  } else if (status === "failed") {
    if (changedRatio === null || !reasons.length || staleReasons.length) throw new ConformanceValidationError("failed result has inconsistent evidence");
  } else if (status === "stale") {
    if (changedRatio !== null || !staleReasons.length || reasons.length !== staleReasons.length || reasons.some((item, index) => item !== staleReasons[index]) || confidence !== 0) throw new ConformanceValidationError("stale result has inconsistent evidence");
  } else if (status === "inconclusive") {
    if (changedRatio !== null || !reasons.length || staleReasons.length || confidence !== 0) throw new ConformanceValidationError("inconclusive result has inconsistent evidence");
  }

  if (verificationInput !== null) {
    const input = parseVisionVerificationInputV1(verificationInput, { canonicalJsonText: verificationInputCanonicalJson });
    if (parsedBinding.verification_input_digest !== input.canonicalDigest) throw new ConformanceValidationError("verification result is bound to a different canonical input", "VISION_VERIFICATION_BINDING_MISMATCH");
    if (parsedBinding.expectation_digest !== input.expectationDigest) throw new ConformanceValidationError("verification result expectation binding mismatch", "VISION_VERIFICATION_BINDING_MISMATCH");
    if (!sameFrame(parsedBinding.before, input.before)) throw new ConformanceValidationError("verification result before-frame binding mismatch", "VISION_VERIFICATION_BINDING_MISMATCH");
    if (!sameFrame(parsedBinding.after, input.after)) throw new ConformanceValidationError("verification result after-frame binding mismatch", "VISION_VERIFICATION_BINDING_MISMATCH");
    if (
      expectationSummary.require_visual_change !== input.expectation.require_visual_change ||
      expectationSummary.min_changed_ratio !== input.expectation.min_changed_ratio ||
      expectationSummary.max_changed_ratio !== input.expectation.max_changed_ratio ||
      evidence.semantic_predicate !== input.expectation.semantic_predicate
    ) throw new ConformanceValidationError("verification result expectation summary mismatch", "VISION_VERIFICATION_BINDING_MISMATCH");
  }

  if (targetIdentity !== null) {
    const expected = object(targetIdentity, "expected target identity");
    exactKeys(expected, ["element_id", "node_id", "automation_id"], "expected target identity");
    if (!target || target.element_id !== expected.element_id || target.node_id !== expected.node_id || target.automation_id !== expected.automation_id) {
      throw new ConformanceValidationError("verification result target identity mismatch", "VISION_VERIFICATION_BINDING_MISMATCH");
    }
  }

  return Object.freeze({
    contract_version: VISION_VERIFICATION_RESULT_V1,
    status,
    binding: Object.freeze(parsedBinding),
    evidence: Object.freeze({
      confidence,
      changed_ratio: changedRatio,
      semantic_predicate: evidence.semantic_predicate,
      reasons,
      stale_reasons: staleReasons,
      expectation: Object.freeze(expectationSummary),
    }),
    target,
    raw: structuredClone(root),
  });
}

export class VisionVerificationResultV1Adapter {
  constructor({ readResult, name = "vision-2", verificationInputResolver = null, verificationInputCanonicalJsonResolver = null, targetIdentityResolver = null } = {}) {
    if (typeof readResult !== "function") throw new TypeError("readResult must be a function.");
    if (verificationInputResolver !== null && typeof verificationInputResolver !== "function") throw new TypeError("verificationInputResolver must be a function.");
    if (verificationInputCanonicalJsonResolver !== null && typeof verificationInputCanonicalJsonResolver !== "function") throw new TypeError("verificationInputCanonicalJsonResolver must be a function.");
    if (targetIdentityResolver !== null && typeof targetIdentityResolver !== "function") throw new TypeError("targetIdentityResolver must be a function.");
    this.name = name;
    this.readResult = readResult;
    this.verificationInputResolver = verificationInputResolver;
    this.verificationInputCanonicalJsonResolver = verificationInputCanonicalJsonResolver;
    this.targetIdentityResolver = targetIdentityResolver;
  }

  async verify(request, context) {
    const raw = await this.readResult(request, context);
    const verificationInput = this.verificationInputResolver
      ? await this.verificationInputResolver(request, context)
      : request?.verification?.input?.verificationInput ?? null;
    const verificationInputCanonicalJson = this.verificationInputCanonicalJsonResolver
      ? await this.verificationInputCanonicalJsonResolver(request, context)
      : request?.verification?.input?.verificationInputCanonicalJson ?? null;
    const targetIdentity = this.targetIdentityResolver
      ? await this.targetIdentityResolver(request, context)
      : request?.verification?.input?.targetIdentity ?? null;
    if (!verificationInput || !verificationInputCanonicalJson) throw new ConformanceValidationError("Vision verification-result v1 requires the exact expected verification input and canonical JSON transport");
    const parsed = parseVisionVerificationResultV1(raw, { verificationInput, verificationInputCanonicalJson, targetIdentity });
    const base = {
      contractVersion: parsed.contract_version,
      status: parsed.status,
      binding: structuredClone(parsed.binding),
      evidence: structuredClone(parsed.evidence),
      target: parsed.target ? structuredClone(parsed.target) : null,
    };
    if (parsed.status === "verified") return { ok: true, conclusive: true, ...base };
    if (parsed.status === "stale") return { ok: false, conclusive: false, inconclusive: true, retryable: true, code: "VISION_VERIFICATION_STALE", category: "stale_observation", ...base };
    if (parsed.status === "inconclusive") return { ok: false, conclusive: false, inconclusive: true, retryable: true, code: "VISION_VERIFICATION_INCONCLUSIVE", category: "inconclusive", ...base };
    return { ok: false, conclusive: true, retryable: false, code: "VISION_VERIFICATION_FAILED", category: "verification_failed", message: parsed.evidence.reasons.join(",") || "effect not verified", ...base };
  }
}
