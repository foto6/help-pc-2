import {
  canonicalSha256,
  ConformanceValidationError,
  parseVisionVerificationInputV1,
  parseVisionVerificationResultV1,
} from "./conformance.js";

export const VISION_SEMANTIC_UI_DELTA_V1 = "vision.semantic_ui_delta.v1";
export const VISION_OBSERVATION_CONSISTENCY_V1 = "vision.observation_consistency.v1";

const HEX64 = /^[0-9a-f]{64}$/;
const CONSISTENCY_STATUSES = new Set(["consistent", "degraded", "conflict", "stale"]);
const FINDING_SEVERITIES = new Set(["info", "degraded", "conflict", "stale"]);
const TARGET_RELATIONS = new Set(["matched", "appeared", "disappeared", "ambiguous", "missing"]);
const TARGET_RESOLUTION = new Set(["unique", "ambiguous", "missing"]);
const CONSISTENCY_PRECEDENCE = Object.freeze({ info: 0, degraded: 1, conflict: 2, stale: 3 });

function object(value, where) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConformanceValidationError(`${where} must be an object`);
  return value;
}
function exactKeys(value, expected, where) {
  const actual = Object.keys(object(value, where)).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new ConformanceValidationError(`${where} keys mismatch`);
  }
}
function text(value, where, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !value) throw new ConformanceValidationError(`${where} must be a non-empty string`);
  return value;
}
function bool(value, where) {
  if (typeof value !== "boolean") throw new ConformanceValidationError(`${where} must be boolean`);
  return value;
}
function integer(value, where, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) throw new ConformanceValidationError(`${where} must be an integer >= ${minimum}`);
  return value;
}
function finite(value, where, minimum = null) {
  if (typeof value !== "number" || !Number.isFinite(value) || (minimum !== null && value < minimum)) throw new ConformanceValidationError(`${where} must be finite`);
  return value;
}
function digest(value, where, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  const parsed = text(value, where);
  if (!HEX64.test(parsed)) throw new ConformanceValidationError(`${where} must be lowercase sha256 hex`);
  return parsed;
}
function array(value, where) {
  if (!Array.isArray(value)) throw new ConformanceValidationError(`${where} must be an array`);
  return value;
}
function stringArray(value, where) {
  return Object.freeze(array(value, where).map((item, index) => text(item, `${where}[${index}]`)));
}
function target(value, where) {
  if (value === null) return null;
  const root = object(value, where);
  exactKeys(root, ["element_id", "node_id", "automation_id"], where);
  return Object.freeze({
    element_id: text(root.element_id, `${where}.element_id`),
    node_id: text(root.node_id, `${where}.node_id`, { nullable: true }),
    automation_id: text(root.automation_id, `${where}.automation_id`, { nullable: true }),
  });
}
function sameTarget(left, right) {
  if (left === null || right === null) return left === right;
  return left.element_id === right.element_id && left.node_id === right.node_id && left.automation_id === right.automation_id;
}
function assertExpectedTarget(actual, expected, where) {
  if (expected === null || expected === undefined) return;
  const parsed = target(expected, "expected target identity");
  if (!sameTarget(actual, parsed)) throw new ConformanceValidationError(`${where} target binding mismatch`, "VISION_SENSOR_BINDING_MISMATCH");
}
function parseSnapshotIdentity(value, where) {
  const root = object(value, where);
  exactKeys(root, ["captured_at_ms", "display_id", "frame_id", "image_digest", "screen_bounds", "sequence", "window_ids"], where);
  const screen = object(root.screen_bounds, `${where}.screen_bounds`);
  exactKeys(screen, ["x", "y", "width", "height"], `${where}.screen_bounds`);
  for (const key of ["x", "y", "width", "height"]) finite(screen[key], `${where}.screen_bounds.${key}`);
  return Object.freeze({
    captured_at_ms: integer(root.captured_at_ms, `${where}.captured_at_ms`),
    display_id: text(root.display_id, `${where}.display_id`),
    frame_id: text(root.frame_id, `${where}.frame_id`),
    image_digest: text(root.image_digest, `${where}.image_digest`),
    screen_bounds: Object.freeze(structuredClone(screen)),
    sequence: integer(root.sequence, `${where}.sequence`),
    window_ids: stringArray(root.window_ids, `${where}.window_ids`),
  });
}
function parseDeltaProvenance(value, where) {
  const root = object(value, where);
  exactKeys(root, ["captured_at_ms", "display_id", "frame_id", "image_digest", "screen_bounds", "sequence", "window_ids"], where);
  return parseSnapshotIdentity(root, where);
}
function bindingError(error) {
  const wrapped = new Error(`Vision sensor evidence failed conformance: ${error?.message ?? error}`);
  wrapped.name = "VisionSensorEvidenceError";
  wrapped.code = error?.code ?? "VISION_SENSOR_EVIDENCE_INVALID";
  wrapped.category = "sensor_evidence_invalid";
  wrapped.retryable = false;
  wrapped.dispatchState = "not_dispatched";
  wrapped.outcomeUncertain = false;
  wrapped.cause = error;
  return wrapped;
}

export function parseVisionSemanticUiDeltaV1(payload, { verificationInput = null, targetIdentity = null } = {}) {
  const root = object(payload, "semantic delta");
  exactKeys(root, ["binding", "changes", "contract_version", "matching", "provenance", "summary", "unavailable_signals"], "semantic delta");
  if (text(root.contract_version, "semantic delta.contract_version") !== VISION_SEMANTIC_UI_DELTA_V1) {
    throw new ConformanceValidationError("unsupported semantic delta version", "VISION_SEMANTIC_DELTA_VERSION_MISMATCH");
  }

  const binding = object(root.binding, "semantic delta.binding");
  exactKeys(binding, ["after_snapshot_sha256", "before_snapshot_sha256", "target", "verification_context_digest", "verification_input_digest"], "semantic delta.binding");
  const parsedBinding = Object.freeze({
    after_snapshot_sha256: digest(binding.after_snapshot_sha256, "semantic delta.binding.after_snapshot_sha256"),
    before_snapshot_sha256: digest(binding.before_snapshot_sha256, "semantic delta.binding.before_snapshot_sha256"),
    target: target(binding.target, "semantic delta.binding.target"),
    verification_context_digest: digest(binding.verification_context_digest, "semantic delta.binding.verification_context_digest"),
    verification_input_digest: digest(binding.verification_input_digest, "semantic delta.binding.verification_input_digest", { nullable: true }),
  });

  const changes = object(root.changes, "semantic delta.changes");
  const changeKeys = ["appeared", "capability", "disappeared", "focus", "geometry", "selection", "state", "text", "value", "window"];
  exactKeys(changes, changeKeys, "semantic delta.changes");
  for (const key of changeKeys) array(changes[key], `semantic delta.changes.${key}`);

  const matching = object(root.matching, "semantic delta.matching");
  exactKeys(matching, ["ambiguous", "matches"], "semantic delta.matching");
  array(matching.ambiguous, "semantic delta.matching.ambiguous");
  array(matching.matches, "semantic delta.matching.matches");

  const provenance = object(root.provenance, "semantic delta.provenance");
  exactKeys(provenance, ["after", "before", "changes"], "semantic delta.provenance");
  const before = parseDeltaProvenance(provenance.before, "semantic delta.provenance.before");
  const after = parseDeltaProvenance(provenance.after, "semantic delta.provenance.after");
  stringArray(provenance.changes, "semantic delta.provenance.changes");

  const summary = object(root.summary, "semantic delta.summary");
  exactKeys(summary, [
    "capture_only", "geometry_tolerance_px", "meaningful_change_count", "ordering_only",
    "semantically_meaningful", "stale", "stale_reasons", "target_relation", "target_semantically_changed",
  ], "semantic delta.summary");
  bool(summary.capture_only, "semantic delta.summary.capture_only");
  finite(summary.geometry_tolerance_px, "semantic delta.summary.geometry_tolerance_px", 0);
  integer(summary.meaningful_change_count, "semantic delta.summary.meaningful_change_count");
  bool(summary.ordering_only, "semantic delta.summary.ordering_only");
  bool(summary.semantically_meaningful, "semantic delta.summary.semantically_meaningful");
  bool(summary.stale, "semantic delta.summary.stale");
  const staleReasons = stringArray(summary.stale_reasons, "semantic delta.summary.stale_reasons");
  const targetRelation = text(summary.target_relation, "semantic delta.summary.target_relation");
  if (!TARGET_RELATIONS.has(targetRelation)) throw new ConformanceValidationError("unsupported semantic delta target_relation");
  if (summary.target_semantically_changed !== null && typeof summary.target_semantically_changed !== "boolean") {
    throw new ConformanceValidationError("semantic delta target_semantically_changed must be boolean or null");
  }
  if (summary.stale !== (staleReasons.length > 0)) throw new ConformanceValidationError("semantic delta stale/reasons mismatch");

  const unavailable = stringArray(root.unavailable_signals, "semantic delta.unavailable_signals");
  if (JSON.stringify(unavailable) !== JSON.stringify(["capabilities", "focus", "selection"])) {
    throw new ConformanceValidationError("semantic delta unavailable_signals changed");
  }

  assertExpectedTarget(parsedBinding.target, targetIdentity, "semantic delta");
  if (verificationInput !== null) {
    const parsedInput = parseVisionVerificationInputV1(verificationInput);
    const beforeDigest = canonicalSha256(verificationInput.before);
    const afterDigest = canonicalSha256(verificationInput.after);
    if (parsedBinding.before_snapshot_sha256 !== beforeDigest || parsedBinding.after_snapshot_sha256 !== afterDigest) {
      throw new ConformanceValidationError("semantic delta snapshot binding mismatch", "VISION_SENSOR_BINDING_MISMATCH");
    }
    if (parsedBinding.verification_input_digest !== parsedInput.canonicalDigest) {
      throw new ConformanceValidationError("semantic delta verification input binding mismatch", "VISION_SENSOR_BINDING_MISMATCH");
    }
    if (before.frame_id !== parsedInput.before.frame_id || before.sequence !== parsedInput.before.sequence || before.image_digest !== parsedInput.before.image_digest) {
      throw new ConformanceValidationError("semantic delta before provenance mismatch", "VISION_SENSOR_BINDING_MISMATCH");
    }
    if (after.frame_id !== parsedInput.after.frame_id || after.sequence !== parsedInput.after.sequence || after.image_digest !== parsedInput.after.image_digest) {
      throw new ConformanceValidationError("semantic delta after provenance mismatch", "VISION_SENSOR_BINDING_MISMATCH");
    }
  }

  return Object.freeze({
    contract_version: VISION_SEMANTIC_UI_DELTA_V1,
    binding: parsedBinding,
    summary: Object.freeze(structuredClone(summary)),
    canonicalDigest: canonicalSha256(root),
    raw: structuredClone(root),
  });
}

export function parseVisionObservationConsistencyV1(payload, {
  afterSnapshot = null,
  verificationInput = null,
  semanticDelta = null,
  targetIdentity = null,
} = {}) {
  const root = object(payload, "observation consistency");
  exactKeys(root, ["binding", "checks", "contract_version", "identity", "status"], "observation consistency");
  if (text(root.contract_version, "observation consistency.contract_version") !== VISION_OBSERVATION_CONSISTENCY_V1) {
    throw new ConformanceValidationError("unsupported observation consistency version", "VISION_OBSERVATION_CONSISTENCY_VERSION_MISMATCH");
  }
  const status = text(root.status, "observation consistency.status");
  if (!CONSISTENCY_STATUSES.has(status)) throw new ConformanceValidationError("unsupported observation consistency status");

  const binding = object(root.binding, "observation consistency.binding");
  exactKeys(binding, ["capture_evidence_sha256", "semantic_delta_sha256", "snapshot_sha256", "target", "verification_input_digest"], "observation consistency.binding");
  const parsedBinding = Object.freeze({
    capture_evidence_sha256: digest(binding.capture_evidence_sha256, "observation consistency.binding.capture_evidence_sha256"),
    semantic_delta_sha256: digest(binding.semantic_delta_sha256, "observation consistency.binding.semantic_delta_sha256", { nullable: true }),
    snapshot_sha256: digest(binding.snapshot_sha256, "observation consistency.binding.snapshot_sha256"),
    target: target(binding.target, "observation consistency.binding.target"),
    verification_input_digest: digest(binding.verification_input_digest, "observation consistency.binding.verification_input_digest", { nullable: true }),
  });

  const checks = object(root.checks, "observation consistency.checks");
  exactKeys(checks, ["findings", "limitations", "screenshot_provenance_changed", "target_resolution"], "observation consistency.checks");
  bool(checks.screenshot_provenance_changed, "observation consistency.checks.screenshot_provenance_changed");
  const limitations = stringArray(checks.limitations, "observation consistency.checks.limitations");
  if (!limitations.includes("screenshot_content_not_semantically_interpreted")) throw new ConformanceValidationError("observation consistency screenshot limitation missing");
  const findings = array(checks.findings, "observation consistency.checks.findings").map((item, index) => {
    const finding = object(item, `observation consistency.checks.findings[${index}]`);
    exactKeys(finding, ["code", "sensors", "severity"], `observation consistency.checks.findings[${index}]`);
    const severity = text(finding.severity, `observation consistency.checks.findings[${index}].severity`);
    if (!FINDING_SEVERITIES.has(severity)) throw new ConformanceValidationError("unsupported observation finding severity");
    return Object.freeze({
      code: text(finding.code, `observation consistency.checks.findings[${index}].code`),
      sensors: stringArray(finding.sensors, `observation consistency.checks.findings[${index}].sensors`),
      severity,
    });
  });
  const targetResolution = object(checks.target_resolution, "observation consistency.checks.target_resolution");
  exactKeys(targetResolution, ["node_ids", "status"], "observation consistency.checks.target_resolution");
  stringArray(targetResolution.node_ids, "observation consistency.checks.target_resolution.node_ids");
  const resolutionStatus = text(targetResolution.status, "observation consistency.checks.target_resolution.status");
  if (!TARGET_RESOLUTION.has(resolutionStatus)) throw new ConformanceValidationError("unsupported target resolution status");

  let strongest = 0;
  for (const finding of findings) strongest = Math.max(strongest, CONSISTENCY_PRECEDENCE[finding.severity]);
  const derivedStatus = strongest === 3 ? "stale" : strongest === 2 ? "conflict" : strongest === 1 ? "degraded" : "consistent";
  if (status !== derivedStatus) throw new ConformanceValidationError("observation consistency status/findings mismatch");

  const identity = object(root.identity, "observation consistency.identity");
  exactKeys(identity, ["capture", "snapshot", "uia"], "observation consistency.identity");
  const snapshotIdentity = parseSnapshotIdentity(identity.snapshot, "observation consistency.identity.snapshot");
  const capture = object(identity.capture, "observation consistency.identity.capture");
  exactKeys(capture, [
    "available", "capture_id", "captured_at_ms", "coordinate_space", "display_geometry", "height",
    "previous_screenshot_sha256", "process_id", "screenshot_sha256", "sequence", "source_head",
    "width", "window_id",
  ], "observation consistency.identity.capture");
  bool(capture.available, "observation consistency.identity.capture.available");
  text(capture.coordinate_space, "observation consistency.identity.capture.coordinate_space");
  array(capture.display_geometry, "observation consistency.identity.capture.display_geometry");
  integer(capture.captured_at_ms, "observation consistency.identity.capture.captured_at_ms");
  integer(capture.sequence, "observation consistency.identity.capture.sequence");
  integer(capture.width, "observation consistency.identity.capture.width", 1);
  integer(capture.height, "observation consistency.identity.capture.height", 1);
  if (capture.capture_id !== null) text(capture.capture_id, "observation consistency.identity.capture.capture_id");
  if (capture.screenshot_sha256 !== null) digest(capture.screenshot_sha256, "observation consistency.identity.capture.screenshot_sha256");
  if (capture.previous_screenshot_sha256 !== null) digest(capture.previous_screenshot_sha256, "observation consistency.identity.capture.previous_screenshot_sha256");
  if (capture.process_id !== null) integer(capture.process_id, "observation consistency.identity.capture.process_id");
  if (capture.window_id !== null) text(capture.window_id, "observation consistency.identity.capture.window_id");
  text(capture.source_head, "observation consistency.identity.capture.source_head");

  const uia = object(identity.uia, "observation consistency.identity.uia");
  exactKeys(uia, ["process_id", "snapshot_id", "source_head", "window_id"], "observation consistency.identity.uia");
  if (uia.process_id !== null) integer(uia.process_id, "observation consistency.identity.uia.process_id");
  text(uia.snapshot_id, "observation consistency.identity.uia.snapshot_id");
  text(uia.source_head, "observation consistency.identity.uia.source_head");
  if (uia.window_id !== null) text(uia.window_id, "observation consistency.identity.uia.window_id");

  assertExpectedTarget(parsedBinding.target, targetIdentity, "observation consistency");
  if (afterSnapshot !== null) {
    if (parsedBinding.snapshot_sha256 !== canonicalSha256(afterSnapshot)) {
      throw new ConformanceValidationError("observation consistency snapshot binding mismatch", "VISION_SENSOR_BINDING_MISMATCH");
    }
    const frame = object(afterSnapshot.frame, "expected after snapshot.frame");
    if (
      snapshotIdentity.frame_id !== frame.frame_id ||
      snapshotIdentity.sequence !== frame.sequence ||
      snapshotIdentity.image_digest !== frame.image_digest ||
      snapshotIdentity.display_id !== frame.display_id ||
      snapshotIdentity.captured_at_ms !== frame.captured_at_ms
    ) throw new ConformanceValidationError("observation consistency snapshot identity mismatch", "VISION_SENSOR_BINDING_MISMATCH");
  }
  if (verificationInput !== null) {
    const parsedInput = parseVisionVerificationInputV1(verificationInput);
    if (parsedBinding.verification_input_digest !== parsedInput.canonicalDigest) {
      throw new ConformanceValidationError("observation consistency verification input binding mismatch", "VISION_SENSOR_BINDING_MISMATCH");
    }
  }
  if (semanticDelta !== null) {
    if (parsedBinding.semantic_delta_sha256 !== canonicalSha256(semanticDelta)) {
      throw new ConformanceValidationError("observation consistency semantic delta binding mismatch", "VISION_SENSOR_BINDING_MISMATCH");
    }
  }

  return Object.freeze({
    contract_version: VISION_OBSERVATION_CONSISTENCY_V1,
    status,
    binding: parsedBinding,
    findings: Object.freeze(findings),
    targetResolution: Object.freeze(structuredClone(targetResolution)),
    canonicalDigest: canonicalSha256(root),
    raw: structuredClone(root),
  });
}

export class VisionSensorReconciliationAdapter {
  constructor({ readEvidence, name = "vision-2" } = {}) {
    if (typeof readEvidence !== "function") throw new TypeError("readEvidence must be a function.");
    this.name = name;
    this.readEvidence = readEvidence;
  }

  async verify(request, context) {
    const verificationInput = request?.verification?.input?.verificationInput ?? null;
    const verificationInputCanonicalJson = request?.verification?.input?.verificationInputCanonicalJson ?? null;
    const targetIdentity = request?.verification?.input?.targetIdentity ?? null;
    if (!verificationInput || typeof verificationInputCanonicalJson !== "string" || !targetIdentity) {
      throw bindingError(new ConformanceValidationError("sensor reconciliation requires exact verification input, canonical JSON, and target identity"));
    }

    try {
      const input = parseVisionVerificationInputV1(verificationInput, { canonicalJsonText: verificationInputCanonicalJson });
      const bundle = object(await this.readEvidence(request, context), "vision sensor evidence bundle");
      exactKeys(bundle, ["semanticDelta", "observationConsistency", "verificationResult"], "vision sensor evidence bundle");

      const delta = parseVisionSemanticUiDeltaV1(bundle.semanticDelta, { verificationInput, targetIdentity });
      const consistency = parseVisionObservationConsistencyV1(bundle.observationConsistency, {
        afterSnapshot: verificationInput.after,
        verificationInput,
        semanticDelta: bundle.semanticDelta,
        targetIdentity,
      });

      const sensorBase = {
        semanticDeltaDigest: delta.canonicalDigest,
        observationConsistencyDigest: consistency.canonicalDigest,
        verificationInputDigest: input.canonicalDigest,
        consistencyStatus: consistency.status,
      };

      if (delta.summary.stale || consistency.status === "stale") {
        return { ok: false, conclusive: false, inconclusive: true, retryable: true, status: "stale", code: "VISION_SENSOR_STALE", category: "stale_observation", ...sensorBase };
      }
      if (consistency.status === "conflict") {
        return { ok: false, conclusive: false, inconclusive: true, retryable: true, status: "inconclusive", code: "VISION_OBSERVATION_CONFLICT", category: "observation_conflict", ...sensorBase };
      }
      if (consistency.status === "degraded") {
        return { ok: false, conclusive: false, inconclusive: true, retryable: true, status: "inconclusive", code: "VISION_OBSERVATION_DEGRADED", category: "observation_degraded", ...sensorBase };
      }

      const result = parseVisionVerificationResultV1(bundle.verificationResult, {
        verificationInput,
        verificationInputCanonicalJson,
        targetIdentity,
      });
      const base = {
        status: result.status,
        binding: structuredClone(result.binding),
        evidence: structuredClone(result.evidence),
        target: result.target ? structuredClone(result.target) : null,
        ...sensorBase,
      };
      if (result.status === "verified") return { ok: true, conclusive: true, ...base };
      if (result.status === "stale") return { ok: false, conclusive: false, inconclusive: true, retryable: true, code: "VISION_VERIFICATION_STALE", category: "stale_observation", ...base };
      if (result.status === "inconclusive") return { ok: false, conclusive: false, inconclusive: true, retryable: true, code: "VISION_VERIFICATION_INCONCLUSIVE", category: "inconclusive", ...base };
      return { ok: false, conclusive: true, retryable: false, code: "VISION_VERIFICATION_FAILED", category: "verification_failed", message: result.evidence.reasons.join(",") || "effect not verified", ...base };
    } catch (error) {
      throw bindingError(error);
    }
  }
}
