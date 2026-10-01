import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  R24_PRODUCER_PIN,
  R24RuntimeHealthConsumer,
  R24RuntimeHealthConsumerError,
  validateR24ProducerPin,
  validateR24RuntimeHealthEnvelope,
  validateVendoredR24Artifacts,
} from "../src/index.js";

const fixtureUrl = new URL(
  "../conformance/r24_runtime_health_v1/runtime_health.example.json",
  import.meta.url,
);
const pinUrl = new URL(
  "../conformance/r24_runtime_health_v1/pin.json",
  import.meta.url,
);

function fixture() {
  return JSON.parse(readFileSync(fixtureUrl, "utf8"));
}

function pin() {
  return JSON.parse(readFileSync(pinUrl, "utf8"));
}

function clone(value) {
  return structuredClone(value);
}

function setGeneration(payload, value) {
  payload.generation.operations_generation_id = value;
  for (const adapter of Object.values(payload.adapters)) {
    adapter.generation.operations_generation_id = value;
  }
}

function makeJournal(payload, integrity, reason) {
  const top = payload.outcome_journal;
  top.integrity = integrity;
  top.reason = reason;
  if (integrity === "corrupt") {
    top.corruption = { kind: "synthetic-corruption", line_number: 2 };
  } else {
    top.corruption = null;
  }
  const diagnostics = payload.adapters.outcome_journal.diagnostics;
  for (const key of [
    "integrity", "reason", "bytes_checked", "record_count",
    "journal_sha256", "corruption", "bounded", "max_bytes",
  ]) {
    diagnostics[key] = clone(top[key]);
  }
}

function recomputeSummary(payload) {
  payload.summary = { responsive: 0, degraded: 0, unhealthy: 0, unknown: 0 };
  for (const adapter of Object.values(payload.adapters)) {
    payload.summary[adapter.state] += 1;
  }
}

test("vendored R24 schema/fixture/manifest match exact producer blob identities", () => {
  const artifacts = validateVendoredR24Artifacts();
  assert.equal(artifacts.producer_sha, "60ba0ce92bf2f3cdd89e3213dba40793c6a90d8b");
  assert.equal(artifacts.workflow_run, 36806258696);
  assert.equal(artifacts.contract_version, "pc_executor.runtime_health.v1");
  assert.deepEqual(artifacts.source_blobs, R24_PRODUCER_PIN.source_blobs);

  const pinned = pin();
  assert.equal(validateR24ProducerPin(pinned), true);
  assert.equal(pinned.producer_sha, R24_PRODUCER_PIN.producer_sha);
  assert.equal(pinned.release_gate, "NO_LIVE_CUTOVER");
  assert.equal(pinned.runtime_source_sha_wire_attested, false);
});

test("exact R24 cross-repo fixture ingests as source-bound and preserves adapter isolation", () => {
  const payload = fixture();
  const now = Date.parse(payload.observed_at) + 500;
  const consumer = new R24RuntimeHealthConsumer({
    clock: () => now,
    maxAgeMs: 5_000,
  });
  const snapshot = consumer.ingest(payload);

  assert.equal(snapshot.source_state, "SOURCE_BOUND");
  assert.equal(snapshot.system_state, "HEALTHY");
  assert.equal(snapshot.freshness, "fresh");
  assert.equal(snapshot.generation.executor_process_id, 4242);
  assert.equal(snapshot.generation.operations_generation_id, "r24-fixture-generation");
  assert.equal(snapshot.outcome_journal.integrity, "healthy");
  assert.deepEqual(snapshot.adapter_specific_degraded, ["uia"]);
  assert.equal(snapshot.adapters.uia.state, "degraded");
  assert.equal(snapshot.adapters.uia.last_failure_kind, "timeout");
  assert.equal(snapshot.adapters.uia.timeout_count, 1);
  assert.equal(snapshot.adapters.windows.state, "responsive");
  assert.equal(snapshot.adapters.outcome_journal.state, "responsive");

  const uia = consumer.actionReadiness("uia.find", { effect: "read_only" });
  assert.deepEqual(uia, {
    state: "DEGRADED",
    adapter: "uia",
    reason: "R24_UIA_TIMEOUT_DEGRADED",
  });
  const windows = consumer.actionReadiness("window.list", { effect: "read_only" });
  assert.equal(windows.state, "READY");
  assert.equal(windows.adapter, "windows");

  const cutover = consumer.cutoverReadiness();
  assert.equal(cutover.decision, "NO_LIVE_CUTOVER");
  assert.equal(cutover.health_prerequisites_satisfied, true);
  assert.equal(cutover.prerequisites.runtime_producer_sha_attested, false);
  assert.equal(cutover.prerequisites.independent_end_to_end_verified, false);
  assert.equal(cutover.release_ready, false);
});

test("changed producer SHA or source blob identity fails before health acceptance", () => {
  const changedSha = pin();
  changedSha.producer_sha = "0".repeat(40);
  assert.throws(
    () => validateR24ProducerPin(changedSha),
    (error) => error instanceof R24RuntimeHealthConsumerError
      && error.code === "R24_PRODUCER_SHA_DRIFT",
  );

  const changedBlob = pin();
  changedBlob.source_blobs["schemas/pc_executor.runtime_health.v1.schema.json"] = "0".repeat(40);
  assert.throws(
    () => validateR24ProducerPin(changedBlob),
    (error) => error instanceof R24RuntimeHealthConsumerError
      && error.code === "R24_PRODUCER_BLOB_DRIFT",
  );

  assert.throws(
    () => new R24RuntimeHealthConsumer({ producerSha: "f".repeat(40) }),
    (error) => error instanceof R24RuntimeHealthConsumerError
      && error.code === "R24_PRODUCER_SHA_DRIFT",
  );
});

test("schema drift and generation mismatch fail closed", () => {
  const schemaDrift = fixture();
  schemaDrift.contract_version = "pc_executor.runtime_health.v2";
  assert.throws(
    () => validateR24RuntimeHealthEnvelope(schemaDrift),
    (error) => error.code === "R24_HEALTH_SCHEMA_DRIFT",
  );

  const extraField = fixture();
  extraField.untrusted = true;
  assert.throws(
    () => validateR24RuntimeHealthEnvelope(extraField),
    (error) => error.code === "R24_HEALTH_SCHEMA_DRIFT",
  );

  const generationDrift = fixture();
  generationDrift.adapters.uia.generation.executor_process_id = 9999;
  assert.throws(
    () => validateR24RuntimeHealthEnvelope(generationDrift),
    (error) => error.code === "R24_HEALTH_GENERATION_DRIFT",
  );
});

test("stale producer health becomes UNKNOWN dynamically and blocks actions", () => {
  const payload = fixture();
  let now = Date.parse(payload.observed_at) + 100;
  const consumer = new R24RuntimeHealthConsumer({
    clock: () => now,
    maxAgeMs: 1_000,
  });
  consumer.ingest(payload);
  assert.equal(consumer.snapshot().source_state, "SOURCE_BOUND");

  now += 1_001;
  const stale = consumer.snapshot();
  assert.equal(stale.source_state, "STALE");
  assert.equal(stale.system_state, "UNKNOWN");
  assert.equal(stale.freshness, "stale");
  assert.deepEqual(
    consumer.actionReadiness("window.list", { effect: "read_only" }),
    {
      state: "BLOCKED",
      adapter: "windows",
      reason: "R24_PRODUCER_HEALTH_STALE",
    },
  );
  assert.equal(consumer.cutoverReadiness().release_ready, false);
  assert.equal(consumer.cutoverReadiness().prerequisites.fresh_runtime_health, false);
});

test("unknown operations generation fails closed without fabricating process identity", () => {
  const payload = fixture();
  setGeneration(payload, null);
  const consumer = new R24RuntimeHealthConsumer({
    clock: () => Date.parse(payload.observed_at) + 100,
  });
  const snapshot = consumer.ingest(payload);
  assert.equal(snapshot.source_state, "UNKNOWN_GENERATION");
  assert.equal(snapshot.system_state, "UNKNOWN");
  assert.deepEqual(
    consumer.actionReadiness("window.list", { effect: "read_only" }),
    {
      state: "BLOCKED",
      adapter: "windows",
      reason: "R24_PRODUCER_GENERATION_UNKNOWN",
    },
  );
});

test("corrupt outcome journal blocks side effects but does not poison unrelated read-only lanes", () => {
  const payload = fixture();
  makeJournal(payload, "corrupt", "integrity_failure");
  payload.adapters.outcome_journal.state = "degraded";
  recomputeSummary(payload);

  const consumer = new R24RuntimeHealthConsumer({
    clock: () => Date.parse(payload.observed_at) + 100,
  });
  const snapshot = consumer.ingest(payload);
  assert.equal(snapshot.system_state, "UNHEALTHY");
  assert.equal(snapshot.outcome_journal.integrity, "corrupt");

  const write = consumer.actionReadiness("shell.run", { effect: "side_effect" });
  assert.equal(write.state, "BLOCKED");
  assert.equal(write.reason, "R24_OUTCOME_JOURNAL_CORRUPT");

  const windows = consumer.actionReadiness("window.list", { effect: "read_only" });
  assert.equal(windows.state, "READY");
  assert.equal(windows.adapter, "windows");
});

test("UIA unhealthy blocks UIA only; shell/windows/screenshot/outcome remain independent", () => {
  const payload = fixture();
  for (const name of ["shell", "windows", "screenshot", "outcome_journal"]) {
    payload.adapters[name].state = "responsive";
    payload.adapters[name].available = true;
  }
  payload.adapters.uia.state = "unhealthy";
  payload.adapters.uia.last_failure_kind = "timeout";
  payload.adapters.uia.timeout_count = 3;
  payload.adapters.uia.circuit.state = "open";
  payload.adapters.uia.circuit.consecutive_timeouts = 3;
  recomputeSummary(payload);

  const consumer = new R24RuntimeHealthConsumer({
    clock: () => Date.parse(payload.observed_at) + 100,
  });
  const snapshot = consumer.ingest(payload);
  assert.equal(snapshot.system_state, "HEALTHY");
  assert.deepEqual(snapshot.adapter_specific_unhealthy, ["uia"]);

  assert.deepEqual(
    consumer.actionReadiness("uia.find", { effect: "read_only" }),
    { state: "BLOCKED", adapter: "uia", reason: "R24_UIA_UNHEALTHY" },
  );
  assert.equal(consumer.actionReadiness("window.list", { effect: "read_only" }).state, "READY");
  assert.equal(consumer.actionReadiness("screenshot.capture", { effect: "read_only" }).state, "READY");
  assert.equal(consumer.actionReadiness("shell.run", { effect: "side_effect" }).state, "READY");
  assert.equal(consumer.actionReadiness("outcome.lookup", { effect: "read_only" }).state, "READY");
});

test("malformed UIA timeout and journal duplication cannot be accepted as trusted evidence", () => {
  const badTimeout = fixture();
  badTimeout.adapters.uia.timeout_count = 0;
  assert.throws(
    () => validateR24RuntimeHealthEnvelope(badTimeout),
    (error) => error.code === "R24_HEALTH_UIA_TIMEOUT_DRIFT",
  );

  const journalDrift = fixture();
  journalDrift.adapters.outcome_journal.diagnostics.integrity = "corrupt";
  assert.throws(
    () => validateR24RuntimeHealthEnvelope(journalDrift),
    (error) => error.code === "R24_HEALTH_JOURNAL_DRIFT",
  );
});
