import { createHash } from "node:crypto";

export const EXECUTOR_OUTCOME_V1 = "pc_executor.action_outcome.v1";
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

export function parseVisionVerificationInputV1(payload) {
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
    canonicalDigest: canonicalSha256(root),
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

export function parseVisionVerificationResultV1(payload, { verificationInput = null, targetIdentity = null } = {}) {
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
    const input = parseVisionVerificationInputV1(verificationInput);
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
  constructor({ readResult, name = "vision-2", verificationInputResolver = null, targetIdentityResolver = null } = {}) {
    if (typeof readResult !== "function") throw new TypeError("readResult must be a function.");
    if (verificationInputResolver !== null && typeof verificationInputResolver !== "function") throw new TypeError("verificationInputResolver must be a function.");
    if (targetIdentityResolver !== null && typeof targetIdentityResolver !== "function") throw new TypeError("targetIdentityResolver must be a function.");
    this.name = name;
    this.readResult = readResult;
    this.verificationInputResolver = verificationInputResolver;
    this.targetIdentityResolver = targetIdentityResolver;
  }

  async verify(request, context) {
    const raw = await this.readResult(request, context);
    const verificationInput = this.verificationInputResolver
      ? await this.verificationInputResolver(request, context)
      : request?.verification?.input?.verificationInput ?? null;
    const targetIdentity = this.targetIdentityResolver
      ? await this.targetIdentityResolver(request, context)
      : request?.verification?.input?.targetIdentity ?? null;
    if (!verificationInput) throw new ConformanceValidationError("Vision verification-result v1 requires the exact expected verification input");
    const parsed = parseVisionVerificationResultV1(raw, { verificationInput, targetIdentity });
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
