import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  R24_PRODUCER_PIN,
} from "./r24-runtime-health-consumer.js";
import {
  R26_PRODUCER_PIN,
  validateR26Progress,
  validateR26Liveness,
} from "./r26-relay-progress-consumer.js";

export const R28_CUTOVER_AUTHORITY_V1 = "pc.native.r28.cutover_authority.v1";
export const R28_HANDOFF_V1 = "pc.native.r28.cutover_handoff.v1";
export const BRIDGE_R24_LIVE_PREFLIGHT_V1 = "bridge.r24_live_preflight.v1";
export const RELAY_R27_PROGRESS_EVIDENCE_V1 = "pc_relay.progress_evidence.v1";

export const R28_DECISIONS = Object.freeze([
  "READY_FOR_EXPLICIT_CUTOVER",
  "BLOCKED",
  "RECONCILIATION_REQUIRED",
]);

export const R28_AUTHORITIES = Object.freeze({
  native_r27: Object.freeze({
    repository: "foto6/help-pc-2",
    sha: "75b2794821160b240c7eef1410a81fddbe795948",
    ci_run: 36864305617,
  }),
  bridge_r24: Object.freeze({
    repository: "foto6/WebAIBridge",
    branch: "agent/bridge-r24-live-preflight-20261001",
    sha: "4ff6315241df16bcfa4750b15f3a3a315296dc50",
    ci_run: 36865003806,
    contract: BRIDGE_R24_LIVE_PREFLIGHT_V1,
  }),
  relay_r27: Object.freeze({
    repository: "foto6/help-pc-1",
    branch: "agent/pc-relay-r27-evidence-delivery-20261001",
    sha: "91600c19763ca8a0871d078a3f15ac97fb4f039a",
    ci_run: 36866129515,
    contract: RELAY_R27_PROGRESS_EVIDENCE_V1,
  }),
  executor_r24: Object.freeze({
    repository: R24_PRODUCER_PIN.producer_repository,
    branch: R24_PRODUCER_PIN.producer_branch,
    sha: R24_PRODUCER_PIN.producer_sha,
    ci_run: R24_PRODUCER_PIN.producer_workflow_run,
  }),
  relay_r26: Object.freeze({
    repository: R26_PRODUCER_PIN.repository,
    branch: R26_PRODUCER_PIN.branch,
    sha: R26_PRODUCER_PIN.sha,
    ci_run: R26_PRODUCER_PIN.workflow_run,
  }),
});

const BRIDGE_REQUIRED_GATES = Object.freeze([
  "process_identity",
  "source_provenance",
  "config_provenance",
  "port_ownership",
  "status_responsiveness",
  "health_responsiveness",
  "queue_quiescence",
  "cdp_readonly_probe",
  "durable_state",
  "r23_candidate_manifest",
]);
const BRIDGE_OBSERVATION_KEYS = Object.freeze([
  "processIdentity",
  "sourceProvenance",
  "configProvenance",
  "portOwnership",
  "status",
  "health",
  "queue",
  "cdp",
  "durableState",
  "r23Manifest",
]);
const BRIDGE_GATE_STATES = new Set(["PASS", "DEGRADED", "BLOCK", "UNKNOWN"]);
const RELAY_ERROR_CLASSES = new Set([
  "missing_snapshot",
  "oversized_snapshot",
  "invalid_json",
  "unknown_version",
  "schema_invalid",
  "source_identity_invalid",
  "stale_snapshot",
  "future_snapshot",
  "atomic_binding_invalid",
  "read_error",
]);

export class R28EvidenceError extends Error {
  constructor(code, message = code, details = null) {
    super(message);
    this.name = "R28EvidenceError";
    this.code = code;
    this.category = "cutover_evidence";
    this.retryable = false;
    this.details = details;
  }
}

function fail(code, message = code, details = null) {
  throw new R28EvidenceError(code, message, details);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function exactKeys(value, expected, where) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("R28_SCHEMA_DRIFT", `${where} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("R28_SCHEMA_DRIFT", `${where} keys drifted`, { expected: wanted, actual });
  }
}

function isHex(value, length) {
  return typeof value === "string"
    && new RegExp(`^[0-9a-f]{${length}}$`).test(value);
}

function finite(value, minimum = -Infinity) {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= minimum;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Canonical(value) {
  return sha256Bytes(Buffer.from(canonicalJson(value), "utf8"));
}

function gitBlobSha(content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const canonical = Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
  return createHash("sha1")
    .update(Buffer.from(`blob ${canonical.length}\0`))
    .update(canonical)
    .digest("hex");
}

function sourceDigests(content) {
  const lf = Buffer.from(content.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
  const crlf = Buffer.from(lf.toString("utf8").replace(/\n/g, "\r\n"), "utf8");
  return Object.freeze([...new Set([sha256Bytes(lf), sha256Bytes(crlf)])]);
}

function parseIsoMs(value, where) {
  if (typeof value !== "string" || !value) fail("R28_SCHEMA_DRIFT", `${where} missing`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail("R28_SCHEMA_DRIFT", `${where} invalid`);
  return parsed;
}

function sourceBindingGate(binding, expected, clock) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    return { ok: false, reason: "source_binding_missing" };
  }
  const ageOk = Number.isFinite(Number(binding.observed_at_ms))
    && Number.isFinite(Number(binding.max_age_ms))
    && Number(binding.max_age_ms) > 0
    && clock() >= Number(binding.observed_at_ms)
    && clock() - Number(binding.observed_at_ms) <= Number(binding.max_age_ms);
  const ok = binding.verified === true
    && binding.repository === expected.repository
    && binding.branch === expected.branch
    && binding.sha === expected.sha
    && Number(binding.ci_run) === Number(expected.ci_run)
    && ageOk;
  return {
    ok,
    reason: ok ? "exact_fresh_source_binding" : "source_binding_mismatch_or_stale",
  };
}

export function loadR28Pins({
  root = dirname(dirname(fileURLToPath(import.meta.url))),
} = {}) {
  const bridgeDir = join(root, "conformance", "r28_bridge_r24");
  const relayDir = join(root, "conformance", "r28_relay_r27");
  const bridgePin = JSON.parse(readFileSync(join(bridgeDir, "pin.json"), "utf8"));
  const relayPin = JSON.parse(readFileSync(join(relayDir, "pin.json"), "utf8"));
  return { root, bridgeDir, relayDir, bridgePin, relayPin };
}

export function validateR28PinnedArtifacts(options = {}) {
  const { bridgeDir, relayDir, bridgePin, relayPin } = loadR28Pins(options);

  exactKeys(bridgePin, [
    "contract_version", "producer_repository", "producer_branch", "producer_sha",
    "producer_ci_run", "live_contract", "schema_authority", "source_blobs",
    "ci_artifacts", "required_gate_ids", "allowed_gate_states", "release_gate",
  ], "Bridge R24 pin");
  if (bridgePin.contract_version !== "pc.native.r28.bridge_r24_authority_pin.v1"
      || bridgePin.producer_repository !== R28_AUTHORITIES.bridge_r24.repository
      || bridgePin.producer_branch !== R28_AUTHORITIES.bridge_r24.branch
      || bridgePin.producer_sha !== R28_AUTHORITIES.bridge_r24.sha
      || bridgePin.producer_ci_run !== R28_AUTHORITIES.bridge_r24.ci_run
      || bridgePin.live_contract !== BRIDGE_R24_LIVE_PREFLIGHT_V1
      || bridgePin.release_gate !== "NO_LIVE_CUTOVER"
      || bridgePin.schema_authority?.standalone_json_schema_published !== false) {
    fail("R28_BRIDGE_PRODUCER_DRIFT", "Bridge R24 producer pin drifted");
  }

  const bridgeVendored = {
    "app/live-preflight-r24.js": ["live-preflight-r24.js", "4e5d2c9765ed51848564e85582d990872a7349b5"],
    "app/r24-live-preflight-contract.test.js": ["r24-live-preflight-contract.test.js", "17b14b318dba64da03b4affc904da5e7392ec856"],
    "app/r24-live-preflight-fixtures.js": ["r24-live-preflight-fixtures.js", "ab6f7b9284077568593ca0ed9f1321a75d77cc16"],
    "app/r24-readiness-report.js": ["r24-readiness-report.js", "a561986d9ff526422c35253ba05c4b3165c35c63"],
  };
  for (const [producerPath, [vendoredName, expectedBlob]] of Object.entries(bridgeVendored)) {
    if (bridgePin.source_blobs?.[producerPath] !== expectedBlob) {
      fail("R28_BRIDGE_BLOB_DRIFT", `Bridge source blob drifted: ${producerPath}`);
    }
    const actual = gitBlobSha(readFileSync(join(bridgeDir, vendoredName)));
    if (actual !== expectedBlob) {
      fail("R28_BRIDGE_VENDORED_BLOB_DRIFT", `Vendored Bridge source drifted: ${vendoredName}`);
    }
  }
  if (JSON.stringify(bridgePin.required_gate_ids) !== JSON.stringify(BRIDGE_REQUIRED_GATES)
      || JSON.stringify(bridgePin.allowed_gate_states) !== JSON.stringify(["PASS", "DEGRADED", "BLOCK", "UNKNOWN"])) {
    fail("R28_BRIDGE_CONTRACT_DRIFT", "Bridge R24 gate contract drifted");
  }

  exactKeys(relayPin, [
    "contract_version", "producer_repository", "producer_branch", "producer_sha",
    "producer_ci_run", "evidence_contract", "manifest_contract", "upstream_r26_start_sha",
    "upstream_r26_ci", "source_blobs", "delivery", "release_gate",
  ], "Relay R27 pin");
  if (relayPin.contract_version !== "pc.native.r28.relay_r27_authority_pin.v1"
      || relayPin.producer_repository !== R28_AUTHORITIES.relay_r27.repository
      || relayPin.producer_branch !== R28_AUTHORITIES.relay_r27.branch
      || relayPin.producer_sha !== R28_AUTHORITIES.relay_r27.sha
      || relayPin.producer_ci_run !== R28_AUTHORITIES.relay_r27.ci_run
      || relayPin.evidence_contract !== RELAY_R27_PROGRESS_EVIDENCE_V1
      || relayPin.manifest_contract !== "pc_relay.progress_evidence.consumer_manifest.v1"
      || relayPin.upstream_r26_start_sha !== R28_AUTHORITIES.relay_r26.sha
      || relayPin.upstream_r26_ci !== R28_AUTHORITIES.relay_r26.ci_run
      || relayPin.release_gate !== "NO_LIVE_CUTOVER") {
    fail("R28_RELAY_PRODUCER_DRIFT", "Relay R27 producer pin drifted");
  }

  const relayVendored = {
    "schemas/pc_relay.progress_evidence.v1.schema.json": ["pc_relay.progress_evidence.v1.schema.json", "73962a7a51e01f72c8e58f240339f4bb4d30714d"],
    "schemas/pc_relay.progress.v1.schema.json": ["pc_relay.progress.v1.schema.json", "04b8da53f638a244a668c8f0a9be4c9b165e1c5e"],
    "schemas/pc_relay.liveness_probe.v1.schema.json": ["pc_relay.liveness_probe.v1.schema.json", "7990e850ef2c143a3d718bd15101c142feb80e1e"],
    "conformance/pc_relay.progress_evidence.v1/manifest.json": ["producer-manifest.json", "20904979c5d3f392ab649f2380d6cd0a30908a27"],
    "tests/fixtures/relay_progress_evidence_v1/evidence.example.json": ["evidence.example.json", "1c75abe63a5cf5af1531d6a21371d437cfa8a178"],
    "src/pc_relay/evidence.py": ["evidence.py", "665684b937b7e1d2e06ef3541bc535082b6a47a2"],
    "tools/read_relay_progress_evidence.py": ["read_relay_progress_evidence.py", "bba58cf4e6baa9d5ecc4e5435e6b684cd5272314"],
  };
  for (const [producerPath, [vendoredName, expectedBlob]] of Object.entries(relayVendored)) {
    if (relayPin.source_blobs?.[producerPath] !== expectedBlob) {
      fail("R28_RELAY_BLOB_DRIFT", `Relay source blob drifted: ${producerPath}`);
    }
    const actual = gitBlobSha(readFileSync(join(relayDir, vendoredName)));
    if (actual !== expectedBlob) {
      fail("R28_RELAY_VENDORED_BLOB_DRIFT", `Vendored Relay source drifted: ${vendoredName}`);
    }
  }

  const schema = JSON.parse(readFileSync(join(relayDir, "pc_relay.progress_evidence.v1.schema.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(relayDir, "producer-manifest.json"), "utf8"));
  if (schema.$id !== RELAY_R27_PROGRESS_EVIDENCE_V1
      || manifest.schema !== "pc_relay.progress_evidence.consumer_manifest.v1"
      || manifest.producer_repository !== R28_AUTHORITIES.relay_r27.repository
      || manifest.producer_branch !== R28_AUTHORITIES.relay_r27.branch
      || manifest.exact_start_sha !== R28_AUTHORITIES.relay_r26.sha
      || manifest.upstream_r26_ci !== R28_AUTHORITIES.relay_r26.ci_run
      || manifest.envelope_contract_version !== RELAY_R27_PROGRESS_EVIDENCE_V1
      || manifest.live_cutover_authorized !== false
      || manifest.delivery?.queue_side_effects !== false
      || manifest.delivery?.acknowledges_requests !== false
      || manifest.delivery?.creates_leases !== false
      || manifest.delivery?.triggers_retry !== false
      || manifest.delivery?.triggers_replay !== false
      || manifest.unknown_semantics?.replay_authorized_by_reader !== false) {
    fail("R28_RELAY_MANIFEST_DRIFT", "Relay R27 consumer manifest drifted");
  }
  const manifestBlobs = Object.fromEntries(manifest.source_blobs.map((item) => [item.path, item.git_blob_sha]));
  for (const [path, expected] of Object.entries(relayPin.source_blobs)) {
    if (manifestBlobs[path] !== undefined && manifestBlobs[path] !== expected) {
      fail("R28_RELAY_MANIFEST_BLOB_DRIFT", `Relay manifest blob drifted: ${path}`);
    }
  }

  const readerSource = readFileSync(join(relayDir, "read_relay_progress_evidence.py"));
  const evidenceSource = readFileSync(join(relayDir, "evidence.py"));
  return Object.freeze({
    bridge: clone(bridgePin),
    relay: clone(relayPin),
    relay_delivery_digests: Object.freeze({
      reader_script_sha256: sourceDigests(readerSource),
      evidence_module_sha256: sourceDigests(evidenceSource),
    }),
  });
}

function validateBridgeObservation(value, where) {
  exactKeys(value, ["source", "state", "observedAt", "budgetMs", "reason", "data"], where);
  if (typeof value.source !== "string" || !BRIDGE_GATE_STATES.has(value.state)
      || typeof value.reason !== "string"
      || !value.data || typeof value.data !== "object" || Array.isArray(value.data)) {
    fail("R28_BRIDGE_SCHEMA_DRIFT", `${where} malformed`);
  }
  parseIsoMs(value.observedAt, `${where}.observedAt`);
  if (value.budgetMs !== null && (!finite(value.budgetMs, 0))) {
    fail("R28_BRIDGE_SCHEMA_DRIFT", `${where}.budgetMs invalid`);
  }
}

export function consumeBridgeR24Evidence(snapshot, {
  clock = Date.now,
  maxAgeMs = 15_000,
  producerBinding,
  artifacts = validateR28PinnedArtifacts(),
} = {}) {
  const source = sourceBindingGate(producerBinding, R28_AUTHORITIES.bridge_r24, clock);
  exactKeys(snapshot, [
    "schema", "object", "collectedAt", "candidate", "budgets", "expectations",
    "observations", "gates", "decision", "releaseGate", "readyForExplicitCutover",
    "blockers", "safety", "stoppingRules",
  ], "Bridge R24 snapshot");
  if (snapshot.schema !== BRIDGE_R24_LIVE_PREFLIGHT_V1
      || snapshot.object !== BRIDGE_R24_LIVE_PREFLIGHT_V1
      || !["READY_FOR_EXPLICIT_CUTOVER", "DEGRADED", "BLOCKED"].includes(snapshot.decision)
      || snapshot.releaseGate !== "NO_LIVE_DEPLOY"
      || typeof snapshot.readyForExplicitCutover !== "boolean") {
    fail("R28_BRIDGE_SCHEMA_DRIFT", "Bridge R24 snapshot identity drifted");
  }
  const collectedMs = parseIsoMs(snapshot.collectedAt, "Bridge R24 collectedAt");
  const ageMs = clock() - collectedMs;
  const fresh = ageMs >= 0 && ageMs <= maxAgeMs;

  exactKeys(snapshot.candidate, [
    "r23SourceSha", "r23SourceBranch", "r23ManifestSha256",
  ], "Bridge R24 candidate");
  if (snapshot.candidate.r23SourceSha !== "dac4dd0edd35cdbf96d5c03344acd94f899a6aba"
      || snapshot.candidate.r23SourceBranch !== "agent/bridge-r23-cutover-rehearsal-20261001"
      || !isHex(snapshot.candidate.r23ManifestSha256, 64)) {
    fail("R28_BRIDGE_CANDIDATE_DRIFT", "Bridge R24 candidate binding drifted");
  }

  exactKeys(snapshot.budgets, ["httpMs", "cdpMs", "osMs", "freshnessMs", "fileMs"], "Bridge R24 budgets");
  for (const [key, value] of Object.entries(snapshot.budgets)) {
    if (!finite(value, 1)) fail("R28_BRIDGE_SCHEMA_DRIFT", `Bridge R24 budget invalid: ${key}`);
  }
  exactKeys(snapshot.expectations, [
    "pid", "commandFingerprint", "port", "sourceSha", "sourceBranch", "configDigest",
  ], "Bridge R24 expectations");
  if (!Number.isInteger(snapshot.expectations.pid) || snapshot.expectations.pid < 1
      || !isHex(snapshot.expectations.commandFingerprint, 64)
      || !Number.isInteger(snapshot.expectations.port) || snapshot.expectations.port < 1
      || !isHex(snapshot.expectations.sourceSha, 40)
      || typeof snapshot.expectations.sourceBranch !== "string" || !snapshot.expectations.sourceBranch
      || !isHex(snapshot.expectations.configDigest, 64)) {
    fail("R28_BRIDGE_EXPECTATION_UNKNOWN", "Bridge R24 exact expectations are missing or malformed");
  }

  exactKeys(snapshot.observations, BRIDGE_OBSERVATION_KEYS, "Bridge R24 observations");
  for (const key of BRIDGE_OBSERVATION_KEYS) {
    validateBridgeObservation(snapshot.observations[key], `Bridge R24 observations.${key}`);
  }

  if (!Array.isArray(snapshot.gates) || snapshot.gates.length !== BRIDGE_REQUIRED_GATES.length) {
    fail("R28_BRIDGE_SCHEMA_DRIFT", "Bridge R24 gate set is incomplete");
  }
  const byId = new Map();
  for (const row of snapshot.gates) {
    exactKeys(row, ["id", "state", "ok", "reason", "source", "observedAt", "evidence"], "Bridge R24 gate");
    if (!BRIDGE_REQUIRED_GATES.includes(row.id) || byId.has(row.id)
        || !BRIDGE_GATE_STATES.has(row.state)
        || typeof row.ok !== "boolean"
        || (row.state === "PASS") !== row.ok
        || typeof row.reason !== "string"
        || typeof row.source !== "string"
        || !row.evidence || typeof row.evidence !== "object" || Array.isArray(row.evidence)) {
      fail("R28_BRIDGE_SCHEMA_DRIFT", "Bridge R24 gate is malformed or duplicated");
    }
    parseIsoMs(row.observedAt, `Bridge R24 gate ${row.id} observedAt`);
    byId.set(row.id, row);
  }
  if (BRIDGE_REQUIRED_GATES.some((id) => !byId.has(id))) {
    fail("R28_BRIDGE_SCHEMA_DRIFT", "Bridge R24 required gate missing");
  }
  if (!Array.isArray(snapshot.blockers) || !Array.isArray(snapshot.stoppingRules)) {
    fail("R28_BRIDGE_SCHEMA_DRIFT", "Bridge R24 blockers/stoppingRules malformed");
  }

  exactKeys(snapshot.safety, [
    "readOnly", "methodsAllowed", "providerMutationPerformed", "bridgeMutationPerformed",
    "processMutationPerformed", "filesWrittenByCollector", "tabsCreated",
    "conversationsCreated", "assignmentsDispatched", "migrationsApplied", "secretsIncluded",
  ], "Bridge R24 safety");
  const safetyOk = snapshot.safety.readOnly === true
    && JSON.stringify(snapshot.safety.methodsAllowed) === JSON.stringify(["GET"])
    && snapshot.safety.providerMutationPerformed === false
    && snapshot.safety.bridgeMutationPerformed === false
    && snapshot.safety.processMutationPerformed === false
    && snapshot.safety.filesWrittenByCollector === false
    && snapshot.safety.tabsCreated === false
    && snapshot.safety.conversationsCreated === false
    && snapshot.safety.assignmentsDispatched === false
    && snapshot.safety.migrationsApplied === false
    && snapshot.safety.secretsIncluded === false;

  const allGatesPass = BRIDGE_REQUIRED_GATES.every((id) => {
    const row = byId.get(id);
    return row.state === "PASS" && row.ok === true;
  });
  const allObservationsPass = BRIDGE_OBSERVATION_KEYS.every(
    (key) => snapshot.observations[key].state === "PASS",
  );
  const queueGate = byId.get("queue_quiescence");
  const statusGate = byId.get("status_responsiveness");
  const cdpGate = byId.get("cdp_readonly_probe");
  const processGate = byId.get("process_identity");
  const codeReloadRequired = statusGate?.evidence?.summary?.codeReloadRequired;
  const queueQuiescent = queueGate?.evidence?.quiescent === true
    && Number(queueGate?.evidence?.activeTaskCount ?? 0) === 0
    && Number(queueGate?.evidence?.activeAssignmentCount ?? 0) === 0
    && Number(queueGate?.evidence?.activeOutboxCount ?? 0) === 0;
  const processUnambiguous = processGate?.evidence?.ambiguous !== true;
  const cdpHealthy = cdpGate?.state === "PASS";
  const ready = source.ok
    && fresh
    && safetyOk
    && allGatesPass
    && allObservationsPass
    && snapshot.decision === "READY_FOR_EXPLICIT_CUTOVER"
    && snapshot.readyForExplicitCutover === true
    && snapshot.blockers.length === 0
    && queueQuiescent
    && codeReloadRequired === false
    && processUnambiguous
    && cdpHealthy;

  return {
    contract_version: "pc.native.r28.bridge_r24_evidence.v1",
    producer: clone(R28_AUTHORITIES.bridge_r24),
    producer_binding_valid: source.ok,
    producer_binding_reason: source.reason,
    artifacts_verified: Boolean(artifacts?.bridge),
    source_state: fresh ? "FRESH" : "STALE",
    age_ms: Math.max(0, ageMs),
    producer_decision: snapshot.decision,
    ready,
    all_required_gates_pass: allGatesPass,
    all_required_observations_pass: allObservationsPass,
    queue_quiescent: queueQuiescent,
    code_reload_required: codeReloadRequired,
    process_unambiguous: processUnambiguous,
    cdp_healthy: cdpHealthy,
    safety_read_only: safetyOk,
    gates: clone(snapshot.gates),
    blockers: ready ? [] : [
      ...(!source.ok ? ["bridge_r24_producer_binding_invalid"] : []),
      ...(!fresh ? ["bridge_r24_snapshot_stale"] : []),
      ...(!safetyOk ? ["bridge_r24_safety_invalid"] : []),
      ...(!allGatesPass ? ["bridge_r24_gate_not_pass"] : []),
      ...(!allObservationsPass ? ["bridge_r24_observation_not_pass"] : []),
      ...(!queueQuiescent ? ["bridge_queue_not_quiescent"] : []),
      ...(codeReloadRequired !== false ? ["bridge_code_reload_required_or_unknown"] : []),
      ...(!processUnambiguous ? ["bridge_process_ownership_ambiguous"] : []),
      ...(!cdpHealthy ? ["bridge_cdp_not_healthy"] : []),
    ],
  };
}

function validateRelayDeliverySource(source, approved) {
  exactKeys(source, [
    "repository", "mechanism", "reader_script_sha256", "evidence_module_sha256",
  ], "Relay R27 delivery_source");
  const readerOk = approved.reader_script_sha256.includes(source.reader_script_sha256);
  const moduleOk = approved.evidence_module_sha256.includes(source.evidence_module_sha256);
  return source.repository === R28_AUTHORITIES.relay_r27.repository
    && source.mechanism === "bounded_local_file_stdio"
    && readerOk
    && moduleOk;
}

function validateRelayDeliverySemantics(value) {
  exactKeys(value, [
    "read_only", "queue_acknowledged", "lease_created", "retry_triggered", "replay_triggered",
  ], "Relay R27 delivery_semantics");
  return value.read_only === true
    && value.queue_acknowledged === false
    && value.lease_created === false
    && value.retry_triggered === false
    && value.replay_triggered === false;
}

function validateRelayBinding(binding, progress, liveness) {
  exactKeys(binding, [
    "relay_startup_head", "relay_script_sha256", "process_pid", "process_started_at_unix",
    "process_instance_id", "loop_generation_id", "loop_epoch", "progress_recorded_at_unix",
  ], "Relay R27 binding");
  const process = progress.process;
  return binding.relay_startup_head === progress.source.startup_head
    && binding.relay_script_sha256 === progress.source.relay_script_sha256
    && binding.process_pid === process.pid
    && binding.process_started_at_unix === process.started_at_unix
    && binding.process_instance_id === process.instance_id
    && binding.loop_generation_id === progress.loop_generation_id
    && binding.loop_epoch === progress.loop_epoch
    && binding.progress_recorded_at_unix === progress.recorded_at_unix
    && liveness.process_pid === binding.process_pid
    && liveness.loop_generation_id === binding.loop_generation_id
    && liveness.loop_epoch === binding.loop_epoch;
}

export function consumeRelayR27Evidence(envelope, {
  clock = Date.now,
  maxAgeMs = 15_000,
  maxFutureSkewMs = 5_000,
  producerBinding,
  artifacts = validateR28PinnedArtifacts(),
} = {}) {
  const source = sourceBindingGate(producerBinding, R28_AUTHORITIES.relay_r27, clock);
  exactKeys(envelope, [
    "contract_version", "status", "observed_at_unix", "delivery_source",
    "delivery_semantics", "binding", "progress_sha256", "progress", "liveness",
    "error", "evidence_sha256",
  ], "Relay R27 envelope");
  if (envelope.contract_version !== RELAY_R27_PROGRESS_EVIDENCE_V1
      || !["ok", "blocked"].includes(envelope.status)
      || !finite(envelope.observed_at_unix, 0)
      || !isHex(envelope.evidence_sha256, 64)) {
    fail("R28_RELAY_SCHEMA_DRIFT", "Relay R27 evidence identity drifted");
  }
  const deliverySourceOk = validateRelayDeliverySource(
    envelope.delivery_source,
    artifacts.relay_delivery_digests,
  );
  const deliverySemanticsOk = validateRelayDeliverySemantics(envelope.delivery_semantics);
  const withoutDigest = { ...envelope };
  delete withoutDigest.evidence_sha256;
  const evidenceDigestOk = sha256Canonical(withoutDigest) === envelope.evidence_sha256;

  const observedMs = envelope.observed_at_unix * 1000;
  const ageMs = clock() - observedMs;
  const fresh = ageMs >= -maxFutureSkewMs && ageMs <= maxAgeMs;

  if (envelope.status === "blocked") {
    if (envelope.binding !== null || envelope.progress_sha256 !== null
        || envelope.progress !== null || envelope.liveness !== null
        || !envelope.error || typeof envelope.error !== "object") {
      fail("R28_RELAY_SCHEMA_DRIFT", "Blocked Relay evidence contains partial progress/liveness");
    }
    exactKeys(envelope.error, ["classification", "reason", "retryable"], "Relay R27 error");
    if (!RELAY_ERROR_CLASSES.has(envelope.error.classification)
        || typeof envelope.error.reason !== "string"
        || envelope.error.reason.length < 1 || envelope.error.reason.length > 256
        || envelope.error.retryable !== false) {
      fail("R28_RELAY_SCHEMA_DRIFT", "Blocked Relay evidence error malformed");
    }
    return {
      contract_version: "pc.native.r28.relay_r27_evidence.v1",
      producer: clone(R28_AUTHORITIES.relay_r27),
      producer_binding_valid: source.ok,
      artifacts_verified: Boolean(artifacts?.relay),
      delivery_source_valid: deliverySourceOk,
      delivery_semantics_valid: deliverySemanticsOk,
      evidence_digest_valid: evidenceDigestOk,
      source_state: fresh ? "FRESH" : "STALE",
      status: "blocked",
      ready: false,
      classification: envelope.error.classification,
      liveness_state: null,
      queue_quiescent: false,
      process_unambiguous: false,
      replay_authorized: false,
      blockers: [
        "relay_r27_status_blocked",
        ...(!source.ok ? ["relay_r27_producer_binding_invalid"] : []),
        ...(!deliverySourceOk ? ["relay_r27_delivery_digest_mismatch"] : []),
        ...(!deliverySemanticsOk ? ["relay_r27_delivery_semantics_invalid"] : []),
        ...(!evidenceDigestOk ? ["relay_r27_evidence_digest_mismatch"] : []),
        ...(!fresh ? ["relay_r27_evidence_stale_or_future"] : []),
      ],
    };
  }

  if (!envelope.binding || !envelope.progress || !envelope.liveness
      || !isHex(envelope.progress_sha256, 64) || envelope.error !== null) {
    fail("R28_RELAY_SCHEMA_DRIFT", "Successful Relay evidence is incomplete");
  }
  validateR26Progress(envelope.progress, { requirePinnedProducer: true });
  validateR26Liveness(envelope.liveness);
  const bindingOk = validateRelayBinding(envelope.binding, envelope.progress, envelope.liveness);
  const progressDigestOk = sha256Canonical(envelope.progress) === envelope.progress_sha256;
  const healthy = envelope.liveness.state === "healthy_progressing";
  const processUnambiguous = Array.isArray(envelope.liveness.observed_pids)
    && envelope.liveness.observed_pids.length === 1
    && envelope.liveness.observed_pids[0] === envelope.binding.process_pid;
  const queueQuiescent = envelope.progress.queue?.pending_count === 0;
  const ready = source.ok
    && deliverySourceOk
    && deliverySemanticsOk
    && evidenceDigestOk
    && progressDigestOk
    && bindingOk
    && fresh
    && healthy
    && processUnambiguous
    && queueQuiescent;

  return {
    contract_version: "pc.native.r28.relay_r27_evidence.v1",
    producer: clone(R28_AUTHORITIES.relay_r27),
    producer_binding_valid: source.ok,
    artifacts_verified: Boolean(artifacts?.relay),
    delivery_source_valid: deliverySourceOk,
    delivery_semantics_valid: deliverySemanticsOk,
    evidence_digest_valid: evidenceDigestOk,
    progress_digest_valid: progressDigestOk,
    atomic_binding_valid: bindingOk,
    source_state: fresh ? "FRESH" : "STALE",
    age_ms: Math.max(0, ageMs),
    status: "ok",
    ready,
    classification: ready ? "healthy_progressing" : "blocked",
    liveness_state: envelope.liveness.state,
    queue_quiescent: queueQuiescent,
    queue_pending_count: envelope.progress.queue?.pending_count ?? null,
    process_unambiguous: processUnambiguous,
    process_pid: envelope.binding.process_pid,
    process_instance_id: envelope.binding.process_instance_id,
    loop_generation_id: envelope.binding.loop_generation_id,
    loop_epoch: envelope.binding.loop_epoch,
    replay_authorized: false,
    blockers: ready ? [] : [
      ...(!source.ok ? ["relay_r27_producer_binding_invalid"] : []),
      ...(!deliverySourceOk ? ["relay_r27_delivery_digest_mismatch"] : []),
      ...(!deliverySemanticsOk ? ["relay_r27_delivery_semantics_invalid"] : []),
      ...(!evidenceDigestOk ? ["relay_r27_evidence_digest_mismatch"] : []),
      ...(!progressDigestOk ? ["relay_r27_progress_digest_mismatch"] : []),
      ...(!bindingOk ? ["relay_r27_atomic_binding_invalid"] : []),
      ...(!fresh ? ["relay_r27_evidence_stale_or_future"] : []),
      ...(!healthy ? ["relay_liveness_not_healthy_progressing"] : []),
      ...(!processUnambiguous ? ["relay_process_identity_ambiguous"] : []),
      ...(!queueQuiescent ? ["relay_queue_not_quiescent"] : []),
    ],
  };
}

function validateR25(snapshot, requiredAdapters, producerBinding, clock) {
  const source = sourceBindingGate(producerBinding, R28_AUTHORITIES.executor_r24, clock);
  const authority = snapshot?.contract_version === "pc.native.r25.r24_runtime_health_consumer.v1"
    && snapshot?.producer_contract === "pc_executor.runtime_health.v1"
    && snapshot?.producer_repository === R28_AUTHORITIES.executor_r24.repository
    && snapshot?.producer_sha === R28_AUTHORITIES.executor_r24.sha
    && snapshot?.producer_workflow_run === R28_AUTHORITIES.executor_r24.ci_run
    && snapshot?.vendored_artifacts_verified === true;
  const fresh = snapshot?.source_state === "SOURCE_BOUND"
    && snapshot?.freshness === "fresh"
    && snapshot?.complete === true
    && snapshot?.cutover?.producer_health_fresh === true;
  const generation = Number.isInteger(snapshot?.generation?.executor_process_id)
    && snapshot.generation.executor_process_id > 0
    && typeof snapshot?.generation?.operations_generation_id === "string"
    && snapshot.generation.operations_generation_id.length > 0
    && snapshot?.cutover?.generation_known === true;
  const journal = snapshot?.outcome_journal?.configured === true
    && snapshot?.outcome_journal?.integrity === "healthy"
    && snapshot?.cutover?.journal_healthy === true;
  const adapterFailures = [];
  for (const name of requiredAdapters) {
    const row = snapshot?.adapters?.[name];
    if (!(row?.available === true && row?.state === "responsive" && row?.circuit?.state === "closed")) {
      adapterFailures.push(name);
    }
  }
  const system = snapshot?.system_state === "HEALTHY";
  const ready = source.ok && authority && fresh && generation && journal
    && adapterFailures.length === 0 && system;
  return {
    ready,
    source_binding_valid: source.ok,
    authority_valid: authority,
    fresh,
    generation_known: generation,
    journal_healthy: journal,
    required_adapters_healthy: adapterFailures.length === 0,
    adapter_failures: adapterFailures,
    system_healthy: system,
  };
}

function decisionGate(id, ok, reason, evidence = {}) {
  return { id, state: ok ? "PASS" : "BLOCKED", ok: Boolean(ok), reason, evidence: clone(evidence) };
}

export function evaluateR28CutoverAuthority(input, {
  clock = Date.now,
  artifacts = validateR28PinnedArtifacts(),
} = {}) {
  exactKeys(input, [
    "bridge_r24_evidence",
    "bridge_r24_producer_binding",
    "relay_r27_evidence",
    "relay_r27_producer_binding",
    "r25_runtime_health",
    "r25_runtime_producer_binding",
    "unknown_side_effects",
    "required_native_adapters",
  ], "R28 authority input");
  if (!Array.isArray(input.required_native_adapters)
      || input.required_native_adapters.some((item) => typeof item !== "string" || !item)) {
    fail("R28_SCHEMA_DRIFT", "required_native_adapters malformed");
  }
  const unknown = input.unknown_side_effects;
  if (!unknown || !Number.isInteger(unknown.count) || unknown.count < 0
      || !Array.isArray(unknown.ids) || unknown.ids.length !== unknown.count
      || unknown.ids.some((id) => typeof id !== "string" || !id)) {
    fail("R28_SCHEMA_DRIFT", "unknown_side_effects malformed");
  }

  let bridge;
  try {
    bridge = consumeBridgeR24Evidence(input.bridge_r24_evidence, {
      clock,
      producerBinding: input.bridge_r24_producer_binding,
      artifacts,
    });
  } catch (error) {
    bridge = {
      ready: false,
      blockers: [error?.code ?? "R28_BRIDGE_EVIDENCE_INVALID"],
      validation_error: error?.code ?? "R28_BRIDGE_EVIDENCE_INVALID",
    };
  }

  let relay;
  try {
    relay = consumeRelayR27Evidence(input.relay_r27_evidence, {
      clock,
      producerBinding: input.relay_r27_producer_binding,
      artifacts,
    });
  } catch (error) {
    relay = {
      ready: false,
      replay_authorized: false,
      blockers: [error?.code ?? "R28_RELAY_EVIDENCE_INVALID"],
      validation_error: error?.code ?? "R28_RELAY_EVIDENCE_INVALID",
    };
  }

  const r25 = validateR25(
    input.r25_runtime_health,
    input.required_native_adapters,
    input.r25_runtime_producer_binding,
    clock,
  );
  const reconciliationRequired = unknown.count > 0;
  const gates = [
    decisionGate("bridge_r24_exact_live_evidence", bridge.ready === true,
      bridge.ready ? "exact_fresh_bridge_r24_all_pass" : "bridge_r24_not_ready", bridge),
    decisionGate("relay_r27_exact_progress_evidence", relay.ready === true,
      relay.ready ? "exact_fresh_relay_r27_healthy_progressing" : "relay_r27_not_ready", relay),
    decisionGate("r25_runtime_health_and_journal", r25.ready === true,
      r25.ready ? "r25_runtime_and_journal_acceptable" : "r25_runtime_or_journal_not_acceptable", r25),
    decisionGate("unknown_side_effect_reconciliation", !reconciliationRequired,
      reconciliationRequired ? "unknown_side_effect_requires_reconciliation" : "no_unknown_side_effects",
      { count: unknown.count, ids: clone(unknown.ids), automatic_replay: false }),
  ];
  const blockers = gates.filter((row) => !row.ok);
  const decision = reconciliationRequired
    ? "RECONCILIATION_REQUIRED"
    : blockers.length > 0
      ? "BLOCKED"
      : "READY_FOR_EXPLICIT_CUTOVER";

  return {
    contract_version: R28_CUTOVER_AUTHORITY_V1,
    decision,
    release_gate: "NO_LIVE_CUTOVER",
    explicit_cutover_preconditions_met: decision === "READY_FOR_EXPLICIT_CUTOVER",
    live_cutover_authorized: false,
    mutation_execution_authorized: false,
    live_cutover_performed: false,
    automatic_replay_authorized: false,
    automatic_restart_authorized: false,
    automatic_kill_authorized: false,
    read_only_diagnostics_allowed: true,
    gates,
    blockers: blockers.map((row) => ({ gate: row.id, reason: row.reason })),
    evidence: { bridge_r24: bridge, relay_r27: relay, r25 },
    authorities: clone(R28_AUTHORITIES),
    stopping_rules: [
      "STOP on any moving producer SHA, producer-binding mismatch, schema/manifest/blob drift, or evidence digest mismatch.",
      "STOP unless Bridge R24 evidence is fresh and every required producer gate and observation is PASS.",
      "STOP on any Bridge UNKNOWN/DEGRADED/BLOCK evidence, ambiguous process ownership, non-quiescent queue, code reload requirement, stale status/health, or unhealthy CDP.",
      "STOP unless Relay R27 evidence status is ok, delivery source digests match approved exact source bytes, atomic binding/digests validate, evidence is fresh, and liveness is healthy_progressing.",
      "STOP on relay duplicate/ambiguous process identity or any relay pending queue item.",
      "STOP if R25 runtime health, generation, outcome journal, producer binding, or required adapter health is unacceptable.",
      "STOP and return RECONCILIATION_REQUIRED for any UNKNOWN side effect. Liveness recovery never authorizes replay.",
      "Read-only diagnostics remain allowed while cutover/mutation readiness is blocked.",
      "This gate contains no executable live cutover, restart, kill, service-change, repoint, or deployment action.",
    ],
  };
}

export function buildR28CoordinatorHandoff(result, {
  generatedAt = new Date().toISOString(),
} = {}) {
  if (!result || result.contract_version !== R28_CUTOVER_AUTHORITY_V1
      || !R28_DECISIONS.includes(result.decision)) {
    fail("R28_HANDOFF_INPUT_INVALID", "R28 handoff requires a valid decision");
  }
  const handoff = {
    contract_version: R28_HANDOFF_V1,
    generated_at: generatedAt,
    decision: result.decision,
    release_gate: "NO_LIVE_CUTOVER",
    authorities: clone(R28_AUTHORITIES),
    blockers: clone(result.blockers),
    stopping_rules: clone(result.stopping_rules),
    read_only_diagnostics_allowed: true,
    live_cutover_authorized: false,
    mutation_execution_authorized: false,
    automatic_replay_authorized: false,
    automatic_restart_authorized: false,
    automatic_kill_authorized: false,
    executable_live_cutover_action: null,
    executable_commands: [],
  };
  handoff.digest = sha256Canonical(handoff);
  return handoff;
}
