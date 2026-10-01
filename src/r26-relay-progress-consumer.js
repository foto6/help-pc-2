import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const R26_PROGRESS_V1 = "pc_relay.progress.v1";
export const R26_LIVENESS_V1 = "pc_relay.liveness_probe.v1";
export const R26_CONSUMER_V1 = "pc.native.r26.relay_progress_consumer.v1";
export const R26_PIN_V1 = "pc.native.r26.relay_progress_pin.v1";

export const R26_PRODUCER_PIN = Object.freeze({
  repository: "foto6/help-pc-1",
  branch: "agent/pc-relay-r26-progress-health-20261001",
  sha: "96d453bcdc866bfd26c06ad88e2ec0c033fbccdd",
  workflow_run: 36833819136,
  manifest_source_base_sha: "4ce8901221ad994ae5b44299d6601e1c9cc6a047",
  source_blobs: Object.freeze({
    progress_source: "c00ccc58f75de463898cd26bb6c4cfeab25a2ca6",
    relay_script: "022cef2a800772c755f34a75faa76b7f54589c94",
    launcher: "7f0add5fb528526336a6caa1f534c2551983f653",
    progress_schema: "04b8da53f638a244a668c8f0a9be4c9b165e1c5e",
    liveness_schema: "7990e850ef2c143a3d718bd15101c142feb80e1e",
    producer_manifest: "b96441e6d164af3554acdcdf77b9ea9eabc3abaf",
    progress_fixture: "4025cb31ae48e0032215bd38edf1c2acaf5d90e1",
  }),
});

const LIVENESS_STATES = new Set([
  "unknown",
  "no_process",
  "alive_unknown",
  "duplicate_processes_ambiguous",
  "stale_record_no_process",
  "alive_ambiguous_identity",
  "healthy_progressing",
  "alive_stalled",
  "progress_record_current",
  "stalled_record",
]);
const CYCLE_STATES = new Set([
  "starting",
  "publishing_pending",
  "fetching",
  "rebasing",
  "scanning",
  "executing",
  "publishing",
  "sleeping",
  "recovering",
  "error",
  "stopped",
]);
const ERROR_CLASSES = new Set([
  "none",
  "transient_network",
  "transient_git_lock",
  "remote_advanced",
  "rebase_conflict",
  "git_auth_or_permission",
  "checkout_dirty",
  "request_invalid",
  "executor_error",
  "publish_error",
  "unknown",
]);

export class R26RelayProgressConsumerError extends Error {
  constructor(code, message = code, details = null) {
    super(message);
    this.name = "R26RelayProgressConsumerError";
    this.code = code;
    this.category = "relay_progress_health";
    this.retryable = false;
    this.details = details;
  }
}

function fail(code, message = code, details = null) {
  throw new R26RelayProgressConsumerError(code, message, details);
}

function exactKeys(value, expected, where) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("R26_SCHEMA_DRIFT", `${where} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("R26_SCHEMA_DRIFT", `${where} keys drifted`, { expected: wanted, actual });
  }
}

function number(value, minimum, where) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    fail("R26_SCHEMA_DRIFT", `${where} must be a finite number >= ${minimum}`);
  }
  return value;
}

function integer(value, minimum, where) {
  if (!Number.isInteger(value) || typeof value === "boolean" || value < minimum) {
    fail("R26_SCHEMA_DRIFT", `${where} must be an integer >= ${minimum}`);
  }
  return value;
}

function nullableNumber(value, minimum, where) {
  if (value !== null) number(value, minimum, where);
}

function nullableInteger(value, minimum, where) {
  if (value !== null) integer(value, minimum, where);
}

function nullableString(value, maximum, where) {
  if (value !== null && (typeof value !== "string" || value.length > maximum)) {
    fail("R26_SCHEMA_DRIFT", `${where} must be string|null with max length ${maximum}`);
  }
}

function boundedString(value, minimum, maximum, where) {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    fail("R26_SCHEMA_DRIFT", `${where} length is invalid`);
  }
  return value;
}

function canonicalGitBlobSha(content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const canonical = Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
  return createHash("sha1")
    .update(Buffer.from(`blob ${canonical.length}\0`))
    .update(canonical)
    .digest("hex");
}

export function validateR26ProducerPin(pin) {
  exactKeys(pin, [
    "contract_version",
    "producer_repository",
    "producer_branch",
    "producer_sha",
    "producer_workflow_run",
    "manifest_source_base_sha",
    "progress_contract",
    "liveness_contract",
    "source_blobs",
    "vendored_paths",
    "runtime_delivery",
    "release_gate",
    "runtime_producer_sha_wire_attested",
  ], "R26 pin");
  if (pin.contract_version !== R26_PIN_V1
      || pin.producer_repository !== R26_PRODUCER_PIN.repository
      || pin.producer_branch !== R26_PRODUCER_PIN.branch
      || pin.producer_sha !== R26_PRODUCER_PIN.sha
      || pin.producer_workflow_run !== R26_PRODUCER_PIN.workflow_run
      || pin.manifest_source_base_sha !== R26_PRODUCER_PIN.manifest_source_base_sha
      || pin.progress_contract !== R26_PROGRESS_V1
      || pin.liveness_contract !== R26_LIVENESS_V1) {
    fail("R26_PRODUCER_SHA_DRIFT", "Pinned relay producer identity drifted");
  }
  const expected = {
    "src/pc_relay/progress.py": R26_PRODUCER_PIN.source_blobs.progress_source,
    "tools/github_relay.py": R26_PRODUCER_PIN.source_blobs.relay_script,
    "tools/start_pc_control_relay.ps1": R26_PRODUCER_PIN.source_blobs.launcher,
    "schemas/pc_relay.progress.v1.schema.json": R26_PRODUCER_PIN.source_blobs.progress_schema,
    "schemas/pc_relay.liveness_probe.v1.schema.json": R26_PRODUCER_PIN.source_blobs.liveness_schema,
    "tests/fixtures/relay_progress_v1/manifest.json": R26_PRODUCER_PIN.source_blobs.producer_manifest,
    "tests/fixtures/relay_progress_v1/progress.example.json": R26_PRODUCER_PIN.source_blobs.progress_fixture,
  };
  exactKeys(pin.source_blobs, Object.keys(expected), "R26 pin.source_blobs");
  for (const [path, sha] of Object.entries(expected)) {
    if (pin.source_blobs[path] !== sha) {
      fail("R26_PRODUCER_BLOB_DRIFT", `Pinned relay producer blob drifted: ${path}`);
    }
  }
  if (pin.runtime_delivery?.progress_path !== ".pc-relay/progress.v1.json"
      || pin.runtime_delivery?.committed_to_git !== false
      || typeof pin.runtime_delivery?.read_only_probe !== "string"
      || pin.release_gate !== "NO_LIVE_CUTOVER"
      || pin.runtime_producer_sha_wire_attested !== false) {
    fail("R26_PRODUCER_PIN_DRIFT", "R26 runtime-delivery or release pin drifted");
  }
  return true;
}

export function validateVendoredR26Artifacts({
  root = dirname(dirname(fileURLToPath(import.meta.url))),
} = {}) {
  const directory = join(root, "conformance", "r26_relay_progress_v1");
  const pin = JSON.parse(readFileSync(join(directory, "pin.json"), "utf8"));
  validateR26ProducerPin(pin);
  const files = [
    ["pc_relay.progress.v1.schema.json", R26_PRODUCER_PIN.source_blobs.progress_schema],
    ["pc_relay.liveness_probe.v1.schema.json", R26_PRODUCER_PIN.source_blobs.liveness_schema],
    ["producer-consumer-manifest.json", R26_PRODUCER_PIN.source_blobs.producer_manifest],
    ["progress.example.json", R26_PRODUCER_PIN.source_blobs.progress_fixture],
  ];
  for (const [name, expected] of files) {
    const actual = canonicalGitBlobSha(readFileSync(join(directory, name)));
    if (actual !== expected) {
      fail("R26_VENDORED_BLOB_DRIFT", `Vendored R26 blob drifted: ${name}`, { expected, actual });
    }
  }
  const progressSchema = JSON.parse(readFileSync(join(directory, files[0][0]), "utf8"));
  const livenessSchema = JSON.parse(readFileSync(join(directory, files[1][0]), "utf8"));
  if (progressSchema.$id !== R26_PROGRESS_V1 || livenessSchema.$id !== R26_LIVENESS_V1) {
    fail("R26_SCHEMA_DRIFT", "Vendored relay schema IDs drifted");
  }
  const fixture = JSON.parse(readFileSync(join(directory, files[3][0]), "utf8"));
  validateR26Progress(fixture, { requirePinnedProducer: false });
  return Object.freeze({
    producer_sha: R26_PRODUCER_PIN.sha,
    workflow_run: R26_PRODUCER_PIN.workflow_run,
    progress_contract: R26_PROGRESS_V1,
    liveness_contract: R26_LIVENESS_V1,
    source_blobs: structuredClone(R26_PRODUCER_PIN.source_blobs),
  });
}

export function validateR26Progress(payload, { requirePinnedProducer = true } = {}) {
  exactKeys(payload, [
    "contract_version", "source", "process", "loop_generation_id", "loop_epoch",
    "last_fetch_success", "last_request_observed", "last_result_committed",
    "last_successful_cycle_at_unix", "consecutive_cycle_failures", "queue",
    "current_cycle", "last_error", "limits", "recorded_at_unix",
  ], "progress");
  if (payload.contract_version !== R26_PROGRESS_V1) fail("R26_SCHEMA_DRIFT", "progress contract drifted");

  exactKeys(payload.source, ["repository", "branch", "startup_head", "relay_script_sha256"], "progress.source");
  if (payload.source.repository !== R26_PRODUCER_PIN.repository) {
    fail("R26_PRODUCER_IDENTITY_DRIFT", "progress repository is not the pinned producer");
  }
  boundedString(payload.source.branch, 1, 256, "progress.source.branch");
  if (!/^(?:[0-9a-f]{40}|unknown)$/.test(payload.source.startup_head)
      || !/^[0-9a-f]{64}$/.test(payload.source.relay_script_sha256)) {
    fail("R26_SCHEMA_DRIFT", "progress source hashes are invalid");
  }
  if (requirePinnedProducer
      && (payload.source.branch !== R26_PRODUCER_PIN.branch
          || payload.source.startup_head !== R26_PRODUCER_PIN.sha)) {
    fail("R26_PRODUCER_SHA_DRIFT", "running relay progress is not bound to exact R26 producer", {
      expected_branch: R26_PRODUCER_PIN.branch,
      expected_sha: R26_PRODUCER_PIN.sha,
      actual_branch: payload.source.branch,
      actual_sha: payload.source.startup_head,
    });
  }

  exactKeys(payload.process, ["pid", "started_at_unix", "instance_id"], "progress.process");
  integer(payload.process.pid, 1, "progress.process.pid");
  number(payload.process.started_at_unix, 0, "progress.process.started_at_unix");
  boundedString(payload.process.instance_id, 1, 128, "progress.process.instance_id");
  boundedString(payload.loop_generation_id, 1, 128, "progress.loop_generation_id");
  integer(payload.loop_epoch, 0, "progress.loop_epoch");

  if (payload.last_fetch_success !== null) {
    exactKeys(payload.last_fetch_success, ["at_unix", "remote_head"], "progress.last_fetch_success");
    number(payload.last_fetch_success.at_unix, 0, "progress.last_fetch_success.at_unix");
    if (payload.last_fetch_success.remote_head !== null
        && !/^[0-9a-f]{40}$/.test(payload.last_fetch_success.remote_head)) {
      fail("R26_SCHEMA_DRIFT", "progress last_fetch_success.remote_head is invalid");
    }
  }
  if (payload.last_request_observed !== null) {
    exactKeys(payload.last_request_observed, ["id", "action", "at_unix"], "progress.last_request_observed");
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(payload.last_request_observed.id)) {
      fail("R26_SCHEMA_DRIFT", "progress request id is invalid");
    }
    nullableString(payload.last_request_observed.action, 128, "progress.last_request_observed.action");
    number(payload.last_request_observed.at_unix, 0, "progress.last_request_observed.at_unix");
  }
  if (payload.last_result_committed !== null) {
    exactKeys(payload.last_result_committed, ["id", "at_unix", "commit_sha"], "progress.last_result_committed");
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(payload.last_result_committed.id)) {
      fail("R26_SCHEMA_DRIFT", "progress result id is invalid");
    }
    number(payload.last_result_committed.at_unix, 0, "progress.last_result_committed.at_unix");
    if (payload.last_result_committed.commit_sha !== null
        && !/^[0-9a-f]{40}$/.test(payload.last_result_committed.commit_sha)) {
      fail("R26_SCHEMA_DRIFT", "progress result commit SHA is invalid");
    }
  }
  nullableNumber(payload.last_successful_cycle_at_unix, 0, "progress.last_successful_cycle_at_unix");
  integer(payload.consecutive_cycle_failures, 0, "progress.consecutive_cycle_failures");

  exactKeys(payload.queue, [
    "pending_count", "oldest_pending_request_id", "oldest_pending_age_seconds", "last_progress_at_unix",
  ], "progress.queue");
  integer(payload.queue.pending_count, 0, "progress.queue.pending_count");
  nullableString(payload.queue.oldest_pending_request_id, 80, "progress.queue.oldest_pending_request_id");
  nullableNumber(payload.queue.oldest_pending_age_seconds, 0, "progress.queue.oldest_pending_age_seconds");
  number(payload.queue.last_progress_at_unix, 0, "progress.queue.last_progress_at_unix");

  exactKeys(payload.current_cycle, ["state", "started_at_unix", "updated_at_unix", "deadline_at_unix"], "progress.current_cycle");
  if (!CYCLE_STATES.has(payload.current_cycle.state)) fail("R26_SCHEMA_DRIFT", "progress cycle state is invalid");
  number(payload.current_cycle.started_at_unix, 0, "progress.current_cycle.started_at_unix");
  number(payload.current_cycle.updated_at_unix, 0, "progress.current_cycle.updated_at_unix");
  nullableNumber(payload.current_cycle.deadline_at_unix, 0, "progress.current_cycle.deadline_at_unix");

  let boundedError = null;
  if (payload.last_error !== null) {
    exactKeys(payload.last_error, [
      "classification", "retryable", "operation", "returncode", "message", "at_unix",
    ], "progress.last_error");
    if (!ERROR_CLASSES.has(payload.last_error.classification)
        || typeof payload.last_error.retryable !== "boolean") {
      fail("R26_SCHEMA_DRIFT", "progress error classification is invalid");
    }
    boundedString(payload.last_error.operation, 1, 64, "progress.last_error.operation");
    if (payload.last_error.returncode !== null) integer(payload.last_error.returncode, -2147483648, "progress.last_error.returncode");
    if (typeof payload.last_error.message !== "string" || payload.last_error.message.length > 512) {
      fail("R26_SCHEMA_DRIFT", "progress error message is unbounded");
    }
    number(payload.last_error.at_unix, 0, "progress.last_error.at_unix");
    boundedError = {
      classification: payload.last_error.classification,
      retryable: payload.last_error.retryable,
      operation: payload.last_error.operation,
      returncode: payload.last_error.returncode,
      at_unix: payload.last_error.at_unix,
    };
  }

  exactKeys(payload.limits, ["max_batch_per_cycle", "max_error_chars", "poll_seconds"], "progress.limits");
  integer(payload.limits.max_batch_per_cycle, 1, "progress.limits.max_batch_per_cycle");
  integer(payload.limits.max_error_chars, 1, "progress.limits.max_error_chars");
  number(payload.limits.poll_seconds, 0.1, "progress.limits.poll_seconds");
  if (payload.limits.max_batch_per_cycle > 1024 || payload.limits.max_error_chars > 4096
      || payload.limits.poll_seconds > 3600) {
    fail("R26_SCHEMA_DRIFT", "progress limits exceed producer schema bounds");
  }
  number(payload.recorded_at_unix, 0, "progress.recorded_at_unix");

  return {
    source: structuredClone(payload.source),
    process: structuredClone(payload.process),
    loop_generation_id: payload.loop_generation_id,
    loop_epoch: payload.loop_epoch,
    last_fetch_success: structuredClone(payload.last_fetch_success),
    last_request_observed: structuredClone(payload.last_request_observed),
    last_result_committed: structuredClone(payload.last_result_committed),
    last_successful_cycle_at_unix: payload.last_successful_cycle_at_unix,
    consecutive_cycle_failures: payload.consecutive_cycle_failures,
    queue: structuredClone(payload.queue),
    current_cycle: structuredClone(payload.current_cycle),
    last_error: boundedError,
    limits: structuredClone(payload.limits),
    recorded_at_unix: payload.recorded_at_unix,
  };
}

export function validateR26Liveness(payload) {
  exactKeys(payload, [
    "contract_version", "state", "reason", "observed_pids", "progress_age_seconds",
    "queue_progress_age_seconds", "successful_cycle_age_seconds",
    "consecutive_cycle_failures", "pending_count", "loop_generation_id",
    "loop_epoch", "process_pid", "last_error_classification",
  ], "liveness");
  if (payload.contract_version !== R26_LIVENESS_V1 || !LIVENESS_STATES.has(payload.state)) {
    fail("R26_SCHEMA_DRIFT", "liveness contract/state drifted");
  }
  boundedString(payload.reason, 1, 256, "liveness.reason");
  if (payload.observed_pids !== null) {
    if (!Array.isArray(payload.observed_pids) || payload.observed_pids.length > 64
        || new Set(payload.observed_pids).size !== payload.observed_pids.length) {
      fail("R26_SCHEMA_DRIFT", "liveness observed_pids is invalid");
    }
    for (const pid of payload.observed_pids) integer(pid, 1, "liveness.observed_pids[]");
  }
  nullableNumber(payload.progress_age_seconds, 0, "liveness.progress_age_seconds");
  nullableNumber(payload.queue_progress_age_seconds, 0, "liveness.queue_progress_age_seconds");
  nullableNumber(payload.successful_cycle_age_seconds, 0, "liveness.successful_cycle_age_seconds");
  nullableInteger(payload.consecutive_cycle_failures, 0, "liveness.consecutive_cycle_failures");
  nullableInteger(payload.pending_count, 0, "liveness.pending_count");
  nullableString(payload.loop_generation_id, 128, "liveness.loop_generation_id");
  nullableInteger(payload.loop_epoch, 0, "liveness.loop_epoch");
  nullableInteger(payload.process_pid, 1, "liveness.process_pid");
  if (payload.last_error_classification !== null && !ERROR_CLASSES.has(payload.last_error_classification)) {
    fail("R26_SCHEMA_DRIFT", "liveness last_error_classification is invalid");
  }
  return structuredClone(payload);
}

function approxEqual(left, right, tolerance = 0.01) {
  return Math.abs(left - right) <= tolerance;
}

function bindLivenessToProgress(progress, liveness) {
  if (liveness.process_pid !== progress.process.pid
      || liveness.loop_generation_id !== progress.loop_generation_id
      || liveness.loop_epoch !== progress.loop_epoch
      || liveness.pending_count !== progress.queue.pending_count
      || liveness.consecutive_cycle_failures !== progress.consecutive_cycle_failures
      || liveness.last_error_classification !== (progress.last_error?.classification ?? null)) {
    fail("R26_LIVENESS_PROGRESS_DRIFT", "liveness identity/counters do not match progress record");
  }
  if (liveness.progress_age_seconds === null) {
    fail("R26_LIVENESS_PROGRESS_DRIFT", "progress-backed liveness requires progress_age_seconds");
  }
  const probeAt = progress.recorded_at_unix + liveness.progress_age_seconds;
  const expectedQueueAge = Math.max(0, probeAt - progress.queue.last_progress_at_unix);
  const cycleBase = progress.last_successful_cycle_at_unix ?? progress.process.started_at_unix;
  const expectedCycleAge = Math.max(0, probeAt - cycleBase);
  if (liveness.queue_progress_age_seconds === null
      || !approxEqual(liveness.queue_progress_age_seconds, expectedQueueAge)
      || liveness.successful_cycle_age_seconds === null
      || !approxEqual(liveness.successful_cycle_age_seconds, expectedCycleAge)) {
    fail("R26_LIVENESS_PROGRESS_DRIFT", "liveness ages do not bind to progress timestamps", {
      expected_queue_age: expectedQueueAge,
      actual_queue_age: liveness.queue_progress_age_seconds,
      expected_cycle_age: expectedCycleAge,
      actual_cycle_age: liveness.successful_cycle_age_seconds,
    });
  }
  return probeAt;
}

function safeClassification(state, pendingUnknownEffects) {
  if (pendingUnknownEffects > 0) return "reconciliation_required";
  if ([
    "healthy_progressing",
    "alive_stalled",
    "duplicate_processes_ambiguous",
    "alive_ambiguous_identity",
    "stale_record_no_process",
  ].includes(state)) return state;
  return state;
}

export class R26RelayProgressConsumer {
  constructor({
    clock = Date.now,
    maxEvidenceAgeMs = 15_000,
    producerSha = R26_PRODUCER_PIN.sha,
    artifacts = null,
  } = {}) {
    if (producerSha !== R26_PRODUCER_PIN.sha) {
      fail("R26_PRODUCER_SHA_DRIFT", "Configured relay producer SHA does not match exact R26 pin");
    }
    if (!Number.isInteger(maxEvidenceAgeMs) || maxEvidenceAgeMs < 100 || maxEvidenceAgeMs > 300_000) {
      throw new TypeError("R26 maxEvidenceAgeMs must be 100..300000");
    }
    this.clock = clock;
    this.maxEvidenceAgeMs = maxEvidenceAgeMs;
    this.artifacts = artifacts ?? validateVendoredR26Artifacts();
    this.last = null;
    this.lastError = null;
    this.previousIdentity = null;
  }

  ingest({ progress, liveness, pending_unknown_effects = 0 } = {}) {
    try {
      const p = validateR26Progress(progress, { requirePinnedProducer: true });
      const l = validateR26Liveness(liveness);
      integer(pending_unknown_effects, 0, "pending_unknown_effects");
      const probeAtUnix = bindLivenessToProgress(p, l);
      const receivedAtMs = this.clock();
      const probeAgeMs = Math.max(0, receivedAtMs - probeAtUnix * 1000);
      const prior = this.previousIdentity;
      const identity = {
        process_pid: p.process.pid,
        process_instance_id: p.process.instance_id,
        loop_generation_id: p.loop_generation_id,
        loop_epoch: p.loop_epoch,
      };
      const restartObserved = Boolean(prior && (
        prior.process_pid !== identity.process_pid
        || prior.process_instance_id !== identity.process_instance_id
        || prior.loop_generation_id !== identity.loop_generation_id
        || identity.loop_epoch < prior.loop_epoch
      ));
      this.previousIdentity = structuredClone(identity);

      let sourceState = "SOURCE_BOUND";
      if (probeAgeMs > this.maxEvidenceAgeMs) sourceState = "STALE";
      const reconciliationRequired = pending_unknown_effects > 0;
      const classification = safeClassification(l.state, pending_unknown_effects);
      const snapshot = {
        contract_version: R26_CONSUMER_V1,
        producer_repository: R26_PRODUCER_PIN.repository,
        producer_branch: R26_PRODUCER_PIN.branch,
        producer_sha: R26_PRODUCER_PIN.sha,
        producer_workflow_run: R26_PRODUCER_PIN.workflow_run,
        producer_sha_wire_attested: true,
        vendored_artifacts_verified: true,
        source_state: sourceState,
        classification,
        liveness_state: l.state,
        liveness_reason: l.reason,
        received_at_ms: receivedAtMs,
        probe_at_unix: probeAtUnix,
        evidence_age_ms: probeAgeMs,
        restart_observed: restartObserved,
        reconciliation_required: reconciliationRequired,
        pending_unknown_effects,
        process: {
          pid: p.process.pid,
          instance_id: p.process.instance_id,
          started_at_unix: p.process.started_at_unix,
          observed_pids: structuredClone(l.observed_pids),
        },
        loop: {
          generation_id: p.loop_generation_id,
          epoch: p.loop_epoch,
        },
        queue: {
          pending_count: p.queue.pending_count,
          oldest_pending_age_seconds: p.queue.oldest_pending_age_seconds,
          queue_progress_age_seconds: l.queue_progress_age_seconds,
          last_progress_at_unix: p.queue.last_progress_at_unix,
        },
        progress: {
          progress_age_seconds: l.progress_age_seconds,
          successful_cycle_age_seconds: l.successful_cycle_age_seconds,
          last_successful_cycle_at_unix: p.last_successful_cycle_at_unix,
          last_result_committed_at_unix: p.last_result_committed?.at_unix ?? null,
          last_result_committed_id: p.last_result_committed?.id ?? null,
          consecutive_cycle_failures: p.consecutive_cycle_failures,
          current_cycle_state: p.current_cycle.state,
        },
        error: p.last_error ? structuredClone(p.last_error) : {
          classification: l.last_error_classification,
          retryable: null,
          operation: null,
          returncode: null,
          at_unix: null,
        },
        recovery: {
          auto_restart: false,
          auto_kill: false,
          automatic_replay: false,
          replay_authorized_after_liveness_recovery: false,
        },
        cutover: {
          decision: "NO_LIVE_CUTOVER",
          exact_producer_pin: true,
          fresh_evidence: sourceState === "SOURCE_BOUND",
          healthy_progressing: l.state === "healthy_progressing",
          ambiguous_ownership: ["duplicate_processes_ambiguous", "alive_ambiguous_identity"].includes(l.state),
          reconciliation_required: reconciliationRequired,
          independent_end_to_end_verified: false,
          release_ready: false,
        },
      };
      this.last = snapshot;
      this.lastError = null;
      return structuredClone(snapshot);
    } catch (error) {
      this.last = null;
      this.lastError = {
        code: error?.code ?? "R26_RELAY_PROGRESS_INVALID",
        observed_at_ms: this.clock(),
      };
      throw error;
    }
  }

  noteError(code = "R26_RELAY_PROGRESS_UNAVAILABLE") {
    this.last = null;
    this.lastError = { code, observed_at_ms: this.clock() };
  }

  snapshot() {
    if (!this.last) {
      return {
        contract_version: R26_CONSUMER_V1,
        producer_repository: R26_PRODUCER_PIN.repository,
        producer_branch: R26_PRODUCER_PIN.branch,
        producer_sha: R26_PRODUCER_PIN.sha,
        producer_sha_wire_attested: false,
        vendored_artifacts_verified: true,
        source_state: this.lastError ? "INVALID" : "UNKNOWN",
        classification: this.lastError ? "producer_evidence_invalid" : "producer_evidence_unknown",
        liveness_state: null,
        reconciliation_required: false,
        pending_unknown_effects: 0,
        last_error: this.lastError ? structuredClone(this.lastError) : null,
        recovery: {
          auto_restart: false,
          auto_kill: false,
          automatic_replay: false,
          replay_authorized_after_liveness_recovery: false,
        },
        cutover: {
          decision: "NO_LIVE_CUTOVER",
          exact_producer_pin: true,
          fresh_evidence: false,
          healthy_progressing: false,
          ambiguous_ownership: false,
          reconciliation_required: false,
          independent_end_to_end_verified: false,
          release_ready: false,
        },
      };
    }
    const snapshot = structuredClone(this.last);
    const ageMs = Math.max(0, this.clock() - snapshot.probe_at_unix * 1000);
    snapshot.evidence_age_ms = ageMs;
    if (ageMs > this.maxEvidenceAgeMs) {
      snapshot.source_state = "STALE";
      snapshot.classification = snapshot.reconciliation_required
        ? "reconciliation_required"
        : "stale_producer_evidence";
      snapshot.cutover.fresh_evidence = false;
    }
    return snapshot;
  }

  readiness({ effect = "read_only" } = {}) {
    const snapshot = this.snapshot();
    if (effect !== "side_effect") {
      return {
        state: snapshot.source_state === "SOURCE_BOUND"
            && snapshot.liveness_state === "healthy_progressing"
          ? "READY"
          : "DIAGNOSTIC_ONLY",
        reason: snapshot.classification,
        liveness_state: snapshot.liveness_state,
        automatic_replay: false,
      };
    }
    if (snapshot.reconciliation_required) {
      return {
        state: "BLOCKED",
        reason: "R26_RECONCILIATION_REQUIRED",
        liveness_state: snapshot.liveness_state,
        automatic_replay: false,
      };
    }
    if (snapshot.source_state !== "SOURCE_BOUND") {
      return {
        state: "BLOCKED",
        reason: snapshot.source_state === "STALE"
          ? "R26_RELAY_PROGRESS_STALE"
          : "R26_RELAY_PROGRESS_UNKNOWN",
        liveness_state: snapshot.liveness_state,
        automatic_replay: false,
      };
    }
    if (snapshot.liveness_state !== "healthy_progressing") {
      const reason = {
        alive_stalled: "R26_RELAY_ALIVE_STALLED",
        duplicate_processes_ambiguous: "R26_RELAY_DUPLICATE_PROCESSES_AMBIGUOUS",
        alive_ambiguous_identity: "R26_RELAY_ALIVE_AMBIGUOUS_IDENTITY",
        stale_record_no_process: "R26_RELAY_STALE_RECORD_NO_PROCESS",
      }[snapshot.liveness_state] ?? "R26_RELAY_NOT_HEALTHY_PROGRESSING";
      return { state: "BLOCKED", reason, liveness_state: snapshot.liveness_state, automatic_replay: false };
    }
    return {
      state: "READY",
      reason: "R26_RELAY_HEALTHY_PROGRESSING",
      liveness_state: snapshot.liveness_state,
      automatic_replay: false,
    };
  }

  cutoverReadiness() {
    const snapshot = this.snapshot();
    return {
      decision: "NO_LIVE_CUTOVER",
      prerequisites: {
        exact_producer_pin: true,
        fresh_evidence: snapshot.source_state === "SOURCE_BOUND",
        healthy_progressing: snapshot.liveness_state === "healthy_progressing",
        no_ambiguous_ownership: !["duplicate_processes_ambiguous", "alive_ambiguous_identity"].includes(snapshot.liveness_state),
        no_pending_unknown_effects: !snapshot.reconciliation_required,
        independent_end_to_end_verified: false,
      },
      health_prerequisites_satisfied:
        snapshot.source_state === "SOURCE_BOUND"
        && snapshot.liveness_state === "healthy_progressing"
        && !snapshot.reconciliation_required,
      release_ready: false,
    };
  }
}
