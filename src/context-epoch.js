import {
  canonicalSha256,
  ConformanceValidationError,
} from "./conformance.js";

export const EXECUTOR_EXECUTION_CONTEXT_BINDING_V1 = "pc_executor.execution_context_binding.v1";
export const EXECUTOR_EXECUTION_CONTEXT_VALIDATION_V1 = "pc_executor.execution_context_validation.v1";
export const VISION_OBSERVATION_EPOCH_V1 = "vision.observation_epoch.v1";
export const VISION_TARGET_LIVENESS_V1 = "vision.target_liveness.v1";

const HEX64 = /^[0-9a-f]{64}$/;
const UIA_ACTIONS = new Set(["vision.target.invoke", "uia.invoke", "uia.focus", "uia.set_value"]);
const FOREGROUND_ACTIONS = new Set(["mouse.click", "keyboard.press", "keyboard.type_text", "clipboard.set"]);
const SHELL_ACTIONS = new Set(["shell.run"]);
const AUTHORITY = Object.freeze({
  uia: new Set(["request.identity", "process.process_id", "process.start_epoch_ms", "window.window_handle", "target.identity_digest"]),
  foreground: new Set(["request.identity", "process.process_id", "process.start_epoch_ms", "window.window_handle", "display.display_id"]),
  shell: new Set(["request.identity", "shell.executable", "shell.cwd_path_digest", "shell.cwd_file_identity"]),
});
const EPOCH_RELATIONS = new Set(["initial", "same", "replaced", "stale"]);
const ROOT_BASES = new Set(["root_roles", "window_process_fallback"]);

function object(value, where) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConformanceValidationError(`${where} must be an object`);
  return value;
}
function exactKeys(value, expected, where) {
  const actual = Object.keys(object(value, where)).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new ConformanceValidationError(`${where} keys mismatch; expected=${JSON.stringify(wanted)}, actual=${JSON.stringify(actual)}`);
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
function integer(value, where, minimum = 0, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (!Number.isInteger(value) || value < minimum) throw new ConformanceValidationError(`${where} must be an integer >= ${minimum}`);
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
function sortedStrings(value, where, { allowEmpty = true } = {}) {
  const parsed = array(value, where).map((item, index) => text(item, `${where}[${index}]`));
  const canonical = [...new Set(parsed)].sort();
  if (parsed.length !== canonical.length || parsed.some((item, index) => item !== canonical[index])) {
    throw new ConformanceValidationError(`${where} must be sorted and unique`);
  }
  if (!allowEmpty && parsed.length === 0) throw new ConformanceValidationError(`${where} must not be empty`);
  return Object.freeze(parsed);
}
function nullableObject(value, where) {
  return value === null ? null : object(value, where);
}

function parseProcess(value) {
  const raw = nullableObject(value, "binding.process");
  if (raw === null) return null;
  exactKeys(raw, ["process_id", "start_epoch_ms"], "binding.process");
  return Object.freeze({
    process_id: integer(raw.process_id, "binding.process.process_id", 1),
    start_epoch_ms: integer(raw.start_epoch_ms, "binding.process.start_epoch_ms", 0, { nullable: true }),
  });
}
function parseWindow(value) {
  const raw = nullableObject(value, "binding.window");
  if (raw === null) return null;
  exactKeys(raw, ["window_handle"], "binding.window");
  return Object.freeze({ window_handle: integer(raw.window_handle, "binding.window.window_handle", 1) });
}
function parseTarget(value) {
  const raw = nullableObject(value, "binding.target");
  if (raw === null) return null;
  exactKeys(raw, ["automation_id", "class_name", "control_type", "identity_digest", "native_handle", "runtime_id"], "binding.target");
  const runtime = raw.runtime_id === null ? null : array(raw.runtime_id, "binding.target.runtime_id").map((item, index) => integer(item, `binding.target.runtime_id[${index}]`, Number.MIN_SAFE_INTEGER));
  const body = {
    automation_id: text(raw.automation_id, "binding.target.automation_id", { nullable: true }),
    control_type: text(raw.control_type, "binding.target.control_type", { nullable: true }),
    class_name: text(raw.class_name, "binding.target.class_name", { nullable: true }),
    native_handle: integer(raw.native_handle, "binding.target.native_handle", 1, { nullable: true }),
    runtime_id: runtime,
  };
  const identity = digest(raw.identity_digest, "binding.target.identity_digest");
  if (identity !== canonicalSha256(body)) throw new ConformanceValidationError("binding.target.identity_digest mismatch", "EXECUTOR_CONTEXT_DIGEST_MISMATCH");
  return Object.freeze({ ...body, identity_digest: identity });
}
function parseDisplay(value) {
  const raw = nullableObject(value, "binding.display");
  if (raw === null) return null;
  exactKeys(raw, ["capture_id", "display_id"], "binding.display");
  return Object.freeze({
    display_id: text(raw.display_id, "binding.display.display_id", { nullable: true }),
    capture_id: text(raw.capture_id, "binding.display.capture_id", { nullable: true }),
  });
}
function parseShell(value) {
  const raw = nullableObject(value, "binding.shell");
  if (raw === null) return null;
  exactKeys(raw, ["cwd_device", "cwd_inode", "cwd_path_digest", "executable"], "binding.shell");
  return Object.freeze({
    executable: text(raw.executable, "binding.shell.executable"),
    cwd_path_digest: digest(raw.cwd_path_digest, "binding.shell.cwd_path_digest"),
    cwd_device: integer(raw.cwd_device, "binding.shell.cwd_device", 0, { nullable: true }),
    cwd_inode: integer(raw.cwd_inode, "binding.shell.cwd_inode", 0, { nullable: true }),
  });
}

export function parseExecutorExecutionContextBindingV1(payload, { requestId = null, action = null } = {}) {
  const root = object(payload, "execution context binding");
  exactKeys(root, [
    "action", "authoritative_fields", "context_digest", "context_kind", "contract_version",
    "display", "process", "request_id", "shell", "target", "window",
  ], "execution context binding");
  if (text(root.contract_version, "binding.contract_version") !== EXECUTOR_EXECUTION_CONTEXT_BINDING_V1) {
    throw new ConformanceValidationError("unsupported execution context binding version", "EXECUTOR_CONTEXT_VERSION_MISMATCH");
  }
  const parsedAction = text(root.action, "binding.action");
  const parsedRequestId = text(root.request_id, "binding.request_id");
  if (requestId !== null && parsedRequestId !== requestId) throw new ConformanceValidationError("execution context request binding mismatch", "EXECUTOR_CONTEXT_BINDING_MISMATCH");
  if (action !== null && parsedAction !== action) throw new ConformanceValidationError("execution context action binding mismatch", "EXECUTOR_CONTEXT_BINDING_MISMATCH");

  const kind = text(root.context_kind, "binding.context_kind");
  const expectedKind = UIA_ACTIONS.has(parsedAction) ? "uia" : FOREGROUND_ACTIONS.has(parsedAction) ? "foreground" : SHELL_ACTIONS.has(parsedAction) ? "shell" : null;
  if (!expectedKind || kind !== expectedKind) throw new ConformanceValidationError("execution context action/kind mismatch");
  const authority = sortedStrings(root.authoritative_fields, "binding.authoritative_fields", { allowEmpty: false });
  if (!authority.includes("request.identity")) throw new ConformanceValidationError("execution context must make request.identity authoritative");
  if (authority.some((field) => !AUTHORITY[kind].has(field))) throw new ConformanceValidationError("execution context carries unsupported authoritative field");

  const process = parseProcess(root.process);
  const window = parseWindow(root.window);
  const target = parseTarget(root.target);
  const display = parseDisplay(root.display);
  const shell = parseShell(root.shell);

  if (kind === "uia") {
    if (!target || !authority.includes("target.identity_digest") || shell !== null) throw new ConformanceValidationError("UIA execution context semantics invalid");
  } else if (kind === "foreground") {
    if (target !== null || shell !== null || (process === null && window === null)) throw new ConformanceValidationError("foreground execution context semantics invalid");
    if (authority.includes("display.display_id") && parsedAction !== "mouse.click") throw new ConformanceValidationError("display authority is only valid for mouse.click");
  } else if (process !== null || window !== null || target !== null || display !== null || shell === null) {
    throw new ConformanceValidationError("shell execution context semantics invalid");
  }
  if (authority.includes("process.process_id") && process === null) throw new ConformanceValidationError("authoritative process section missing");
  if (authority.includes("process.start_epoch_ms") && (process === null || process.start_epoch_ms === null)) throw new ConformanceValidationError("authoritative process start epoch missing");
  if (authority.includes("window.window_handle") && window === null) throw new ConformanceValidationError("authoritative window missing");
  if (authority.includes("display.display_id") && (display === null || display.display_id === null)) throw new ConformanceValidationError("authoritative display missing");
  if (authority.includes("shell.cwd_file_identity") && (shell === null || shell.cwd_device === null || shell.cwd_inode === null)) throw new ConformanceValidationError("authoritative cwd identity missing");

  const contextDigest = digest(root.context_digest, "binding.context_digest");
  const body = structuredClone(root);
  delete body.context_digest;
  if (contextDigest !== canonicalSha256(body)) throw new ConformanceValidationError("execution context digest mismatch", "EXECUTOR_CONTEXT_DIGEST_MISMATCH");
  return Object.freeze({
    contract_version: EXECUTOR_EXECUTION_CONTEXT_BINDING_V1,
    request_id: parsedRequestId,
    action: parsedAction,
    context_kind: kind,
    authoritative_fields: authority,
    process,
    window,
    target,
    display,
    shell,
    context_digest: contextDigest,
    raw: structuredClone(root),
  });
}

export function parseExecutorExecutionContextValidationV1(payload, { bindingDigest = null } = {}) {
  const root = object(payload, "execution context validation");
  exactKeys(root, [
    "adapter_dispatch_started", "binding_digest", "contract_version", "mismatches",
    "reason", "reexecution_safe", "status",
  ], "execution context validation");
  if (text(root.contract_version, "validation.contract_version") !== EXECUTOR_EXECUTION_CONTEXT_VALIDATION_V1) {
    throw new ConformanceValidationError("unsupported execution context validation version", "EXECUTOR_CONTEXT_VALIDATION_VERSION_MISMATCH");
  }
  const status = text(root.status, "validation.status");
  const reason = text(root.reason, "validation.reason");
  const validationDigest = digest(root.binding_digest, "validation.binding_digest");
  if (bindingDigest !== null && validationDigest !== bindingDigest) throw new ConformanceValidationError("execution context validation binding mismatch", "EXECUTOR_CONTEXT_BINDING_MISMATCH");
  const reexecutionSafe = bool(root.reexecution_safe, "validation.reexecution_safe");
  const dispatchStarted = bool(root.adapter_dispatch_started, "validation.adapter_dispatch_started");
  const mismatches = sortedStrings(root.mismatches, "validation.mismatches");

  if (status === "matched") {
    if (reason !== "context_match" || reexecutionSafe || dispatchStarted || mismatches.length) throw new ConformanceValidationError("matched context validation invariants violated");
  } else if (status === "blocked") {
    if (reason !== "context_mismatch" || !reexecutionSafe || dispatchStarted || mismatches.length === 0) throw new ConformanceValidationError("blocked context validation invariants violated");
  } else throw new ConformanceValidationError("unsupported execution context validation status");

  return Object.freeze({
    contract_version: EXECUTOR_EXECUTION_CONTEXT_VALIDATION_V1,
    status,
    reason,
    binding_digest: validationDigest,
    reexecution_safe: reexecutionSafe,
    adapter_dispatch_started: dispatchStarted,
    mismatches,
    raw: structuredClone(root),
  });
}

function frameBinding(value, where) {
  const root = object(value, where);
  exactKeys(root, ["captured_at_ms", "display_id", "frame_id", "image_digest", "sequence"], where);
  return Object.freeze({
    frame_id: text(root.frame_id, `${where}.frame_id`),
    sequence: integer(root.sequence, `${where}.sequence`),
    captured_at_ms: integer(root.captured_at_ms, `${where}.captured_at_ms`),
    image_digest: text(root.image_digest, `${where}.image_digest`),
    display_id: text(root.display_id, `${where}.display_id`),
  });
}
function parseEpochProvenance(value, where) {
  const root = object(value, where);
  exactKeys(root, [
    "capture_id", "capture_sha256", "capture_source_id", "coordinate_space", "process_id",
    "process_start_epoch_ms", "root_fingerprint_basis", "root_uia_fingerprint", "window_id",
  ], where);
  const basis = text(root.root_fingerprint_basis, `${where}.root_fingerprint_basis`);
  if (!ROOT_BASES.has(basis)) throw new ConformanceValidationError("unsupported root fingerprint basis");
  return Object.freeze({
    process_id: integer(root.process_id, `${where}.process_id`, 1, { nullable: true }),
    process_start_epoch_ms: integer(root.process_start_epoch_ms, `${where}.process_start_epoch_ms`, 0, { nullable: true }),
    window_id: text(root.window_id, `${where}.window_id`, { nullable: true }),
    capture_source_id: text(root.capture_source_id, `${where}.capture_source_id`, { nullable: true }),
    coordinate_space: text(root.coordinate_space, `${where}.coordinate_space`, { nullable: true }),
    capture_id: text(root.capture_id, `${where}.capture_id`, { nullable: true }),
    capture_sha256: digest(root.capture_sha256, `${where}.capture_sha256`, { nullable: true }),
    root_uia_fingerprint: digest(root.root_uia_fingerprint, `${where}.root_uia_fingerprint`),
    root_fingerprint_basis: basis,
  });
}
function parseStableIdentity(value) {
  const root = object(value, "epoch.stable_identity");
  exactKeys(root, [
    "capture_source_id", "coordinate_space", "display_fingerprint", "process_id", "process_start_epoch_ms",
    "root_fingerprint_basis", "root_uia_fingerprint", "window_id",
  ], "epoch.stable_identity");
  const basis = text(root.root_fingerprint_basis, "epoch.stable_identity.root_fingerprint_basis");
  if (!ROOT_BASES.has(basis)) throw new ConformanceValidationError("unsupported stable root fingerprint basis");
  return Object.freeze({
    process_id: integer(root.process_id, "epoch.stable_identity.process_id", 1, { nullable: true }),
    process_start_epoch_ms: integer(root.process_start_epoch_ms, "epoch.stable_identity.process_start_epoch_ms", 0, { nullable: true }),
    window_id: text(root.window_id, "epoch.stable_identity.window_id", { nullable: true }),
    display_fingerprint: digest(root.display_fingerprint, "epoch.stable_identity.display_fingerprint"),
    capture_source_id: text(root.capture_source_id, "epoch.stable_identity.capture_source_id", { nullable: true }),
    coordinate_space: text(root.coordinate_space, "epoch.stable_identity.coordinate_space", { nullable: true }),
    root_uia_fingerprint: digest(root.root_uia_fingerprint, "epoch.stable_identity.root_uia_fingerprint"),
    root_fingerprint_basis: basis,
  });
}

export function parseVisionObservationEpochV1(payload, { snapshot = null, previousEpoch = null } = {}) {
  const root = object(payload, "observation epoch");
  exactKeys(root, [
    "contract_version", "epoch_id", "frame", "ordinal", "predecessor_epoch_id", "provenance",
    "relation", "snapshot_sha256", "stable_identity", "stable_identity_sha256", "transition_reasons",
  ], "observation epoch");
  if (text(root.contract_version, "epoch.contract_version") !== VISION_OBSERVATION_EPOCH_V1) {
    throw new ConformanceValidationError("unsupported observation epoch version", "VISION_EPOCH_VERSION_MISMATCH");
  }
  const epochId = text(root.epoch_id, "epoch.epoch_id");
  if (!epochId.startsWith("epoch:") || !HEX64.test(epochId.slice(6))) throw new ConformanceValidationError("invalid observation epoch id");
  const relation = text(root.relation, "epoch.relation");
  if (!EPOCH_RELATIONS.has(relation)) throw new ConformanceValidationError("unsupported observation epoch relation");
  const ordinal = integer(root.ordinal, "epoch.ordinal");
  const predecessor = text(root.predecessor_epoch_id, "epoch.predecessor_epoch_id", { nullable: true });
  if (predecessor !== null && (!predecessor.startsWith("epoch:") || !HEX64.test(predecessor.slice(6)))) throw new ConformanceValidationError("invalid predecessor epoch id");
  const snapshotDigest = digest(root.snapshot_sha256, "epoch.snapshot_sha256");
  const frame = frameBinding(root.frame, "epoch.frame");
  const stable = parseStableIdentity(root.stable_identity);
  const stableDigest = digest(root.stable_identity_sha256, "epoch.stable_identity_sha256");
  if (stableDigest !== canonicalSha256(stable)) throw new ConformanceValidationError("observation epoch stable identity digest mismatch", "VISION_EPOCH_DIGEST_MISMATCH");
  const provenance = parseEpochProvenance(root.provenance, "epoch.provenance");
  const reasons = sortedStrings(root.transition_reasons, "epoch.transition_reasons");

  if (relation === "initial" && (predecessor !== null || reasons.length)) throw new ConformanceValidationError("initial epoch predecessor/reasons invalid");
  if (relation !== "initial" && predecessor === null) throw new ConformanceValidationError("non-initial epoch requires predecessor");
  if (relation === "same" && reasons.length) throw new ConformanceValidationError("same epoch cannot carry transition reasons");
  if ((relation === "replaced" || relation === "stale") && reasons.length === 0) throw new ConformanceValidationError(`${relation} epoch requires reasons`);
  if (previousEpoch !== null) {
    const previous = parseVisionObservationEpochV1(previousEpoch);
    const expectedReasons = [];
    for (const [field, reason] of [
      ["process_id", "process_identity_changed"],
      ["process_start_epoch_ms", "process_start_epoch_changed"],
      ["window_id", "window_identity_changed"],
      ["display_fingerprint", "display_provenance_changed"],
      ["capture_source_id", "capture_source_changed"],
      ["coordinate_space", "coordinate_space_changed"],
      ["root_uia_fingerprint", "root_uia_replaced"],
    ]) {
      if (previous.stable_identity[field] !== stable[field]) expectedReasons.push(reason);
    }
    if (frame.sequence <= previous.frame.sequence) {
      if (frame.captured_at_ms > previous.frame.captured_at_ms) expectedReasons.push("capture_sequence_reset");
      else expectedReasons.push("observation_not_monotonic");
    } else if (frame.captured_at_ms <= previous.frame.captured_at_ms) {
      expectedReasons.push("capture_timestamp_not_monotonic");
    }
    const canonicalExpectedReasons = [...new Set(expectedReasons)].sort();
    const staleOnly = canonicalExpectedReasons.every((reason) => ["observation_not_monotonic", "capture_timestamp_not_monotonic"].includes(reason));
    const expectedRelation = canonicalExpectedReasons.length === 0 ? "same" : staleOnly ? "stale" : "replaced";
    const expectedOrdinal = expectedRelation === "replaced" ? previous.ordinal + 1 : previous.ordinal;
    const expectedEpochId = ["same", "stale"].includes(expectedRelation)
      ? previous.epoch_id
      : `epoch:${canonicalSha256({
          stable_identity_sha256: stableDigest,
          ordinal: expectedOrdinal,
          predecessor_epoch_id: previous.epoch_id,
        })}`;
    if (
      predecessor !== previous.epoch_id ||
      relation !== expectedRelation ||
      ordinal !== expectedOrdinal ||
      epochId !== expectedEpochId ||
      reasons.length !== canonicalExpectedReasons.length ||
      reasons.some((reason, index) => reason !== canonicalExpectedReasons[index])
    ) throw new ConformanceValidationError("observation epoch transition does not match predecessor evidence", "VISION_EPOCH_TRANSITION_MISMATCH");
  }

  if (snapshot !== null) {
    if (snapshotDigest !== canonicalSha256(snapshot)) throw new ConformanceValidationError("observation epoch snapshot digest mismatch", "VISION_EPOCH_BINDING_MISMATCH");
    const expected = snapshot.frame;
    if (
      frame.frame_id !== expected.frame_id || frame.sequence !== expected.sequence ||
      frame.captured_at_ms !== expected.captured_at_ms || frame.image_digest !== expected.image_digest ||
      frame.display_id !== expected.display_id
    ) throw new ConformanceValidationError("observation epoch frame binding mismatch", "VISION_EPOCH_BINDING_MISMATCH");
  }

  return Object.freeze({
    contract_version: VISION_OBSERVATION_EPOCH_V1,
    epoch_id: epochId,
    ordinal,
    relation,
    predecessor_epoch_id: predecessor,
    snapshot_sha256: snapshotDigest,
    frame,
    stable_identity_sha256: stableDigest,
    stable_identity: stable,
    provenance,
    transition_reasons: reasons,
    canonicalDigest: canonicalSha256(root),
    raw: structuredClone(root),
  });
}

export function parseVisionTargetLivenessV1(payload) {
  const root = object(payload, "target liveness");
  exactKeys(root, [
    "contract_version", "epoch_id", "epoch_ordinal", "issued_at_ms", "issued_frame_id",
    "issued_sequence", "max_age_ms", "max_sequence_delta", "target_sha256",
  ], "target liveness");
  if (text(root.contract_version, "target liveness.contract_version") !== VISION_TARGET_LIVENESS_V1) {
    throw new ConformanceValidationError("unsupported target liveness version", "VISION_LIVENESS_VERSION_MISMATCH");
  }
  const epochId = text(root.epoch_id, "target liveness.epoch_id");
  if (!epochId.startsWith("epoch:") || !HEX64.test(epochId.slice(6))) throw new ConformanceValidationError("invalid target liveness epoch id");
  return Object.freeze({
    contract_version: VISION_TARGET_LIVENESS_V1,
    target_sha256: digest(root.target_sha256, "target liveness.target_sha256"),
    epoch_id: epochId,
    epoch_ordinal: integer(root.epoch_ordinal, "target liveness.epoch_ordinal"),
    issued_frame_id: text(root.issued_frame_id, "target liveness.issued_frame_id"),
    issued_sequence: integer(root.issued_sequence, "target liveness.issued_sequence"),
    issued_at_ms: integer(root.issued_at_ms, "target liveness.issued_at_ms"),
    max_sequence_delta: integer(root.max_sequence_delta, "target liveness.max_sequence_delta"),
    max_age_ms: integer(root.max_age_ms, "target liveness.max_age_ms"),
    raw: structuredClone(root),
  });
}

export function validateVisionTargetLivenessV1(leasePayload, groundedTarget, epochPayload, { nowMs = null } = {}) {
  const lease = parseVisionTargetLivenessV1(leasePayload);
  const epoch = parseVisionObservationEpochV1(epochPayload);
  const target = object(groundedTarget, "grounded target");
  const targetFrame = object(target.frame, "grounded target.frame");
  const reasons = [];
  if (lease.target_sha256 !== canonicalSha256(target)) reasons.push("target_digest_mismatch");
  if (targetFrame.frame_id !== lease.issued_frame_id || targetFrame.sequence !== lease.issued_sequence) reasons.push("target_issue_binding_mismatch");
  if (epoch.epoch_id !== lease.epoch_id || epoch.ordinal !== lease.epoch_ordinal) reasons.push("observation_epoch_changed");
  if (epoch.relation === "stale") reasons.push("observation_epoch_stale");
  const sequenceDelta = epoch.frame.sequence - lease.issued_sequence;
  if (sequenceDelta < 0) reasons.push("sequence_regressed");
  else if (sequenceDelta > lease.max_sequence_delta) reasons.push("sequence_lease_expired");
  const effectiveNow = nowMs === null ? epoch.frame.captured_at_ms : integer(nowMs, "nowMs");
  const ageMs = effectiveNow - lease.issued_at_ms;
  if (ageMs < 0) reasons.push("time_regressed");
  else if (ageMs > lease.max_age_ms) reasons.push("age_lease_expired");
  const canonicalReasons = [...new Set(reasons)].sort();
  return Object.freeze({
    status: canonicalReasons.length ? "stale" : "live",
    reasons: Object.freeze(canonicalReasons),
    epoch_id: epoch.epoch_id,
    sequence: epoch.frame.sequence,
    age_ms: ageMs,
  });
}
