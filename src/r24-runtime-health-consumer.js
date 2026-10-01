import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { adapterNameForAction } from "./r23-health.js";

export const R24_RUNTIME_HEALTH_V1 = "pc_executor.runtime_health.v1";
export const R25_R24_CONSUMER_V1 = "pc.native.r25.r24_runtime_health_consumer.v1";
export const R25_R24_PIN_V1 = "pc.native.r25.r24_runtime_health_pin.v1";

export const R24_PRODUCER_PIN = Object.freeze({
  producer_repository: "foto6/help-pc-1",
  producer_branch: "agent/pc-executor-r24-runtime-health-20261001",
  producer_sha: "60ba0ce92bf2f3cdd89e3213dba40793c6a90d8b",
  producer_workflow_run: 36806258696,
  producer_contract: R24_RUNTIME_HEALTH_V1,
  source_blobs: Object.freeze({
    runtime_health_source: "6b7a7bfd84e02855de468e87a621e349527f52d6",
    schema: "62d691862c4c66088bdb55b5fe35193529b6532f",
    producer_consumer_manifest: "54b8ff1548529403d775cd4f4f5ffff997fe6d39",
    fixture: "aee3ce093250a0ca3659496c20ccb37940ec76cb",
  }),
});

const REQUIRED_ADAPTERS = Object.freeze([
  "uia",
  "screenshot",
  "windows",
  "shell",
  "clipboard",
  "input",
  "outcome_journal",
  "search",
  "process",
]);

const ADAPTER_STATES = new Set(["responsive", "degraded", "unhealthy", "unknown"]);
const CIRCUIT_STATES = new Set(["closed", "open", "half_open"]);
const JOURNAL_STATES = new Set(["healthy", "corrupt", "unknown", "unconfigured"]);

export class R24RuntimeHealthConsumerError extends Error {
  constructor(code, message = code, details = null) {
    super(message);
    this.name = "R24RuntimeHealthConsumerError";
    this.code = code;
    this.category = "producer_health";
    this.retryable = false;
    this.details = details;
  }
}

function fail(code, message = code, details = null) {
  throw new R24RuntimeHealthConsumerError(code, message, details);
}

function exactKeys(value, expected, where) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("R24_HEALTH_SCHEMA_DRIFT", `${where} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    fail("R24_HEALTH_SCHEMA_DRIFT", `${where} keys drifted`, { expected: required, actual });
  }
}

function integer(value, minimum, where) {
  if (!Number.isInteger(value) || typeof value === "boolean" || value < minimum) {
    fail("R24_HEALTH_SCHEMA_DRIFT", `${where} must be an integer >= ${minimum}`);
  }
  return value;
}

function nullableString(value, where) {
  if (value !== null && typeof value !== "string") {
    fail("R24_HEALTH_SCHEMA_DRIFT", `${where} must be string|null`);
  }
}

function isoTimestamp(value, where) {
  if (typeof value !== "string" || !value) {
    fail("R24_HEALTH_SCHEMA_DRIFT", `${where} must be a non-empty timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail("R24_HEALTH_SCHEMA_DRIFT", `${where} is not parseable`);
  return parsed;
}

function validateGeneration(value, where, { requireKnown = false } = {}) {
  exactKeys(value, ["executor_process_id", "operations_generation_id"], where);
  integer(value.executor_process_id, 1, `${where}.executor_process_id`);
  nullableString(value.operations_generation_id, `${where}.operations_generation_id`);
  if (requireKnown && (!value.operations_generation_id || !value.operations_generation_id.trim())) {
    fail("R24_HEALTH_GENERATION_UNKNOWN", "R24 operations generation is unknown");
  }
  return {
    executor_process_id: value.executor_process_id,
    operations_generation_id: value.operations_generation_id,
  };
}

function validateCircuit(value, where) {
  exactKeys(value, [
    "state",
    "timeout_threshold",
    "consecutive_timeouts",
    "opened_at",
    "cooldown_ms",
  ], where);
  if (!CIRCUIT_STATES.has(value.state)) {
    fail("R24_HEALTH_SCHEMA_DRIFT", `${where}.state is invalid`);
  }
  integer(value.timeout_threshold, 1, `${where}.timeout_threshold`);
  integer(value.consecutive_timeouts, 0, `${where}.consecutive_timeouts`);
  nullableString(value.opened_at, `${where}.opened_at`);
  if (value.opened_at !== null) isoTimestamp(value.opened_at, `${where}.opened_at`);
  integer(value.cooldown_ms, 1, `${where}.cooldown_ms`);
}

function validateAdapter(value, name, rootGeneration) {
  const where = `adapters.${name}`;
  exactKeys(value, [
    "available",
    "state",
    "provider",
    "last_success_at",
    "last_failure_at",
    "last_failure_kind",
    "timeout_count",
    "error_count",
    "bounded_operation_timeout_ms",
    "circuit",
    "generation",
    "diagnostics",
  ], where);
  if (typeof value.available !== "boolean" || !ADAPTER_STATES.has(value.state)
      || typeof value.provider !== "string") {
    fail("R24_HEALTH_SCHEMA_DRIFT", `${where} identity/state is invalid`);
  }
  nullableString(value.last_success_at, `${where}.last_success_at`);
  nullableString(value.last_failure_at, `${where}.last_failure_at`);
  nullableString(value.last_failure_kind, `${where}.last_failure_kind`);
  if (value.last_success_at !== null) isoTimestamp(value.last_success_at, `${where}.last_success_at`);
  if (value.last_failure_at !== null) isoTimestamp(value.last_failure_at, `${where}.last_failure_at`);
  integer(value.timeout_count, 0, `${where}.timeout_count`);
  integer(value.error_count, 0, `${where}.error_count`);
  integer(value.bounded_operation_timeout_ms, 1, `${where}.bounded_operation_timeout_ms`);
  validateCircuit(value.circuit, `${where}.circuit`);
  const generation = validateGeneration(value.generation, `${where}.generation`);
  if (generation.executor_process_id !== rootGeneration.executor_process_id
      || generation.operations_generation_id !== rootGeneration.operations_generation_id) {
    fail("R24_HEALTH_GENERATION_DRIFT", `${where}.generation does not match root generation`, {
      root: rootGeneration,
      adapter: generation,
    });
  }
  if (!value.diagnostics || typeof value.diagnostics !== "object" || Array.isArray(value.diagnostics)) {
    fail("R24_HEALTH_SCHEMA_DRIFT", `${where}.diagnostics must be an object`);
  }
  return structuredClone(value);
}

function validateJournal(value) {
  exactKeys(value, [
    "configured",
    "integrity",
    "reason",
    "bytes_checked",
    "record_count",
    "journal_sha256",
    "corruption",
    "bounded",
    "max_bytes",
  ], "outcome_journal");
  if (typeof value.configured !== "boolean" || !JOURNAL_STATES.has(value.integrity)
      || typeof value.reason !== "string" || value.bounded !== true) {
    fail("R24_HEALTH_SCHEMA_DRIFT", "outcome_journal identity/integrity is invalid");
  }
  integer(value.bytes_checked, 0, "outcome_journal.bytes_checked");
  if (value.record_count !== null) integer(value.record_count, 0, "outcome_journal.record_count");
  if (value.journal_sha256 !== null
      && (typeof value.journal_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.journal_sha256))) {
    fail("R24_HEALTH_SCHEMA_DRIFT", "outcome_journal.journal_sha256 is invalid");
  }
  if (value.corruption !== null
      && (!value.corruption || typeof value.corruption !== "object" || Array.isArray(value.corruption))) {
    fail("R24_HEALTH_SCHEMA_DRIFT", "outcome_journal.corruption is invalid");
  }
  integer(value.max_bytes, 1, "outcome_journal.max_bytes");
  return structuredClone(value);
}

function gitBlobSha(content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return createHash("sha1")
    .update(Buffer.from(`blob ${bytes.length}\0`))
    .update(bytes)
    .digest("hex");
}

export function validateR24ProducerPin(pin) {
  exactKeys(pin, [
    "contract_version",
    "producer_repository",
    "producer_branch",
    "producer_sha",
    "producer_workflow_run",
    "producer_contract",
    "source_blobs",
    "vendored_paths",
    "delivery",
    "release_gate",
    "runtime_source_sha_wire_attested",
  ], "R24 pin");
  if (pin.contract_version !== R25_R24_PIN_V1
      || pin.producer_repository !== R24_PRODUCER_PIN.producer_repository
      || pin.producer_branch !== R24_PRODUCER_PIN.producer_branch
      || pin.producer_sha !== R24_PRODUCER_PIN.producer_sha
      || pin.producer_workflow_run !== R24_PRODUCER_PIN.producer_workflow_run
      || pin.producer_contract !== R24_RUNTIME_HEALTH_V1) {
    fail("R24_PRODUCER_SHA_DRIFT", "Pinned R24 producer identity drifted");
  }
  const expected = {
    "src/pc_executor/runtime_health.py": R24_PRODUCER_PIN.source_blobs.runtime_health_source,
    "schemas/pc_executor.runtime_health.v1.schema.json": R24_PRODUCER_PIN.source_blobs.schema,
    "tests/fixtures/runtime_health_v1/manifest.json": R24_PRODUCER_PIN.source_blobs.producer_consumer_manifest,
    "tests/fixtures/runtime_health_v1/runtime_health.example.json": R24_PRODUCER_PIN.source_blobs.fixture,
  };
  exactKeys(pin.source_blobs, Object.keys(expected), "R24 pin.source_blobs");
  for (const [path, sha] of Object.entries(expected)) {
    if (pin.source_blobs[path] !== sha) {
      fail("R24_PRODUCER_BLOB_DRIFT", `Pinned producer blob drifted: ${path}`);
    }
  }
  if (pin.delivery?.native_tool !== "device.health"
      || pin.delivery?.executor_action !== "health.get"
      || pin.delivery?.response_field !== "runtime_health"
      || pin.release_gate !== "NO_LIVE_CUTOVER"
      || pin.runtime_source_sha_wire_attested !== false) {
    fail("R24_PRODUCER_PIN_DRIFT", "R24 delivery/release pin drifted");
  }
  return true;
}

export function validateVendoredR24Artifacts({
  root = dirname(dirname(fileURLToPath(import.meta.url))),
} = {}) {
  const directory = join(root, "conformance", "r24_runtime_health_v1");
  const pin = JSON.parse(readFileSync(join(directory, "pin.json"), "utf8"));
  validateR24ProducerPin(pin);
  const files = [
    ["pc_executor.runtime_health.v1.schema.json", R24_PRODUCER_PIN.source_blobs.schema],
    ["producer-consumer-manifest.json", R24_PRODUCER_PIN.source_blobs.producer_consumer_manifest],
    ["runtime_health.example.json", R24_PRODUCER_PIN.source_blobs.fixture],
  ];
  for (const [name, expected] of files) {
    const actual = gitBlobSha(readFileSync(join(directory, name)));
    if (actual !== expected) {
      fail("R24_VENDORED_BLOB_DRIFT", `Vendored R24 blob drifted: ${name}`, { expected, actual });
    }
  }
  const schema = JSON.parse(readFileSync(join(directory, files[0][0]), "utf8"));
  if (schema.$id !== R24_RUNTIME_HEALTH_V1) {
    fail("R24_HEALTH_SCHEMA_DRIFT", "Vendored R24 schema $id drifted");
  }
  const fixture = JSON.parse(readFileSync(join(directory, files[2][0]), "utf8"));
  validateR24RuntimeHealthEnvelope(fixture, { requireKnownGeneration: true });
  return Object.freeze({
    producer_sha: R24_PRODUCER_PIN.producer_sha,
    workflow_run: R24_PRODUCER_PIN.producer_workflow_run,
    contract_version: R24_RUNTIME_HEALTH_V1,
    source_blobs: structuredClone(R24_PRODUCER_PIN.source_blobs),
  });
}

export function validateR24RuntimeHealthEnvelope(payload, { requireKnownGeneration = true } = {}) {
  exactKeys(payload, [
    "contract_version",
    "observed_at",
    "complete",
    "probe_budget_ms",
    "elapsed_ms",
    "generation",
    "adapters",
    "outcome_journal",
    "summary",
  ], "runtime_health");
  if (payload.contract_version !== R24_RUNTIME_HEALTH_V1 || typeof payload.complete !== "boolean") {
    fail("R24_HEALTH_SCHEMA_DRIFT", "runtime_health contract/version changed");
  }
  const observedAtMs = isoTimestamp(payload.observed_at, "runtime_health.observed_at");
  integer(payload.probe_budget_ms, 1, "runtime_health.probe_budget_ms");
  integer(payload.elapsed_ms, 0, "runtime_health.elapsed_ms");
  const generation = validateGeneration(
    payload.generation,
    "runtime_health.generation",
    { requireKnown: requireKnownGeneration },
  );
  exactKeys(payload.adapters, REQUIRED_ADAPTERS, "runtime_health.adapters");
  const adapters = {};
  for (const name of REQUIRED_ADAPTERS) {
    adapters[name] = validateAdapter(payload.adapters[name], name, generation);
  }
  const outcomeJournal = validateJournal(payload.outcome_journal);
  exactKeys(payload.summary, ["responsive", "degraded", "unhealthy", "unknown"], "runtime_health.summary");
  const computed = { responsive: 0, degraded: 0, unhealthy: 0, unknown: 0 };
  for (const entry of Object.values(adapters)) computed[entry.state] += 1;
  for (const key of Object.keys(computed)) {
    integer(payload.summary[key], 0, `runtime_health.summary.${key}`);
    if (payload.summary[key] !== computed[key]) {
      fail("R24_HEALTH_SUMMARY_DRIFT", "runtime_health summary does not match adapters", {
        expected: computed,
        actual: payload.summary,
      });
    }
  }
  return {
    observedAtMs,
    generation,
    adapters,
    outcomeJournal,
    complete: payload.complete,
    probeBudgetMs: payload.probe_budget_ms,
    elapsedMs: payload.elapsed_ms,
    summary: structuredClone(payload.summary),
  };
}

export class R24RuntimeHealthConsumer {
  constructor({
    clock = Date.now,
    maxAgeMs = 15_000,
    maxFutureSkewMs = 2_000,
    producerSha = R24_PRODUCER_PIN.producer_sha,
    artifacts = null,
  } = {}) {
    if (producerSha !== R24_PRODUCER_PIN.producer_sha) {
      fail("R24_PRODUCER_SHA_DRIFT", "Configured R24 producer SHA does not match pinned SHA");
    }
    if (!Number.isInteger(maxAgeMs) || maxAgeMs < 100 || maxAgeMs > 300_000
        || !Number.isInteger(maxFutureSkewMs) || maxFutureSkewMs < 0 || maxFutureSkewMs > 60_000) {
      throw new TypeError("R24 health freshness bounds are invalid");
    }
    this.clock = clock;
    this.maxAgeMs = maxAgeMs;
    this.maxFutureSkewMs = maxFutureSkewMs;
    this.artifacts = artifacts ?? validateVendoredR24Artifacts();
    this.last = null;
    this.lastError = null;
  }

  ingest(payload) {
    try {
      const validated = validateR24RuntimeHealthEnvelope(payload, { requireKnownGeneration: false });
      const now = this.clock();
      const ageMs = now - validated.observedAtMs;
      let freshness = "fresh";
      let sourceState = "SOURCE_BOUND";
      if (ageMs > this.maxAgeMs) {
        freshness = "stale";
        sourceState = "STALE";
      } else if (ageMs < -this.maxFutureSkewMs) {
        freshness = "future";
        sourceState = "UNKNOWN";
      } else if (!validated.complete) {
        sourceState = "INCOMPLETE";
      } else if (!validated.generation.operations_generation_id) {
        sourceState = "UNKNOWN_GENERATION";
      }

      const degraded = [];
      const unhealthy = [];
      const unknown = [];
      for (const [name, entry] of Object.entries(validated.adapters)) {
        if (entry.state === "degraded") degraded.push(name);
        else if (entry.state === "unhealthy") unhealthy.push(name);
        else if (entry.state === "unknown") unknown.push(name);
      }

      let systemState = "HEALTHY";
      if (sourceState !== "SOURCE_BOUND") systemState = "UNKNOWN";
      else if (validated.outcomeJournal.integrity === "corrupt") systemState = "UNHEALTHY";
      else if (validated.outcomeJournal.integrity !== "healthy") systemState = "DEGRADED";

      const snapshot = {
        contract_version: R25_R24_CONSUMER_V1,
        producer_contract: R24_RUNTIME_HEALTH_V1,
        producer_repository: R24_PRODUCER_PIN.producer_repository,
        producer_sha: R24_PRODUCER_PIN.producer_sha,
        producer_workflow_run: R24_PRODUCER_PIN.producer_workflow_run,
        producer_sha_wire_attested: false,
        vendored_artifacts_verified: true,
        source_state: sourceState,
        system_state: systemState,
        freshness,
        age_ms: Math.max(0, ageMs),
        observed_at: payload.observed_at,
        complete: validated.complete,
        generation: validated.generation,
        adapters: validated.adapters,
        adapter_specific_degraded: degraded,
        adapter_specific_unhealthy: unhealthy,
        adapter_specific_unknown: unknown,
        outcome_journal: validated.outcomeJournal,
        summary: validated.summary,
        cutover: {
          decision: "NO_LIVE_CUTOVER",
          health_contract_valid: true,
          producer_pin_valid: true,
          producer_health_fresh: freshness === "fresh",
          generation_known: Boolean(validated.generation.operations_generation_id),
          journal_healthy: validated.outcomeJournal.integrity === "healthy",
          runtime_producer_sha_attested: false,
          independent_end_to_end_verified: false,
        },
      };
      this.last = snapshot;
      this.lastError = null;
      return structuredClone(snapshot);
    } catch (error) {
      this.lastError = {
        code: error?.code ?? "R24_HEALTH_INVALID",
        observed_at_ms: this.clock(),
      };
      throw error;
    }
  }

  snapshot() {
    return this.last ? structuredClone(this.last) : {
      contract_version: R25_R24_CONSUMER_V1,
      producer_contract: R24_RUNTIME_HEALTH_V1,
      producer_repository: R24_PRODUCER_PIN.producer_repository,
      producer_sha: R24_PRODUCER_PIN.producer_sha,
      producer_sha_wire_attested: false,
      vendored_artifacts_verified: true,
      source_state: this.lastError ? "INVALID" : "UNKNOWN",
      system_state: "UNKNOWN",
      freshness: "unknown",
      last_error: this.lastError ? structuredClone(this.lastError) : null,
      adapter_specific_degraded: [],
      adapter_specific_unhealthy: [],
      adapter_specific_unknown: [...REQUIRED_ADAPTERS],
      cutover: {
        decision: "NO_LIVE_CUTOVER",
        health_contract_valid: false,
        producer_pin_valid: true,
        producer_health_fresh: false,
        generation_known: false,
        journal_healthy: false,
        runtime_producer_sha_attested: false,
        independent_end_to_end_verified: false,
      },
    };
  }

  actionReadiness(action, { effect = "read_only" } = {}) {
    const source = this.snapshot();
    const adapter = adapterNameForAction(action);
    if (!this.last || source.source_state !== "SOURCE_BOUND") {
      return {
        state: "BLOCKED",
        adapter,
        reason: source.source_state === "STALE"
          ? "R24_PRODUCER_HEALTH_STALE"
          : source.source_state === "UNKNOWN_GENERATION"
            ? "R24_PRODUCER_GENERATION_UNKNOWN"
            : "R24_PRODUCER_HEALTH_UNKNOWN",
      };
    }
    if (effect === "side_effect" && source.outcome_journal.integrity !== "healthy") {
      return {
        state: "BLOCKED",
        adapter,
        reason: source.outcome_journal.integrity === "corrupt"
          ? "R24_OUTCOME_JOURNAL_CORRUPT"
          : "R24_OUTCOME_JOURNAL_UNTRUSTED",
      };
    }
    if (!Object.hasOwn(source.adapters, adapter)) {
      return { state: "READY", adapter, reason: "NO_R24_ADAPTER_GATE" };
    }
    const entry = source.adapters[adapter];
    if (!entry.available || entry.state === "unhealthy" || entry.circuit.state === "open") {
      return {
        state: "BLOCKED",
        adapter,
        reason: adapter === "uia"
          ? "R24_UIA_UNHEALTHY"
          : "R24_ADAPTER_UNHEALTHY",
      };
    }
    if (entry.state === "unknown") {
      return { state: "BLOCKED", adapter, reason: "R24_ADAPTER_HEALTH_UNKNOWN" };
    }
    if (entry.state === "degraded") {
      return {
        state: "DEGRADED",
        adapter,
        reason: adapter === "uia" && entry.last_failure_kind === "timeout"
          ? "R24_UIA_TIMEOUT_DEGRADED"
          : "R24_ADAPTER_DEGRADED",
      };
    }
    return { state: "READY", adapter, reason: "R24_ADAPTER_RESPONSIVE" };
  }

  cutoverReadiness() {
    const snapshot = this.snapshot();
    const prerequisites = {
      exact_producer_pin: snapshot.cutover?.producer_pin_valid === true,
      valid_runtime_health_contract: snapshot.cutover?.health_contract_valid === true,
      fresh_runtime_health: snapshot.cutover?.producer_health_fresh === true,
      known_generation: snapshot.cutover?.generation_known === true,
      healthy_outcome_journal: snapshot.cutover?.journal_healthy === true,
      runtime_producer_sha_attested: false,
      independent_end_to_end_verified: false,
    };
    return {
      decision: "NO_LIVE_CUTOVER",
      prerequisites,
      health_prerequisites_satisfied: Object.entries(prerequisites)
        .filter(([key]) => !["runtime_producer_sha_attested", "independent_end_to_end_verified"].includes(key))
        .every(([, value]) => value === true),
      release_ready: false,
    };
  }
}
