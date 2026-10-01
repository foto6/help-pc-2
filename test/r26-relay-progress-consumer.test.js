import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  R26_PRODUCER_PIN,
  R26RelayProgressConsumer,
  R26RelayProgressConsumerError,
  validateR26ProducerPin,
  validateR26Progress,
  validateR26Liveness,
  validateVendoredR26Artifacts,
} from "../src/index.js";

const fixtureUrl = new URL(
  "../conformance/r26_relay_progress_v1/progress.example.json",
  import.meta.url,
);
const pinUrl = new URL(
  "../conformance/r26_relay_progress_v1/pin.json",
  import.meta.url,
);

function progressFixture() {
  const value = JSON.parse(readFileSync(fixtureUrl, "utf8"));
  value.source.branch = R26_PRODUCER_PIN.branch;
  value.source.startup_head = R26_PRODUCER_PIN.sha;
  return value;
}

function pinFixture() {
  return JSON.parse(readFileSync(pinUrl, "utf8"));
}

function livenessFor(progress, {
  state = "healthy_progressing",
  reason = "cycle_and_queue_progress_within_bound",
  observed_pids = [progress.process.pid],
  probe_at_unix = progress.recorded_at_unix + 1,
} = {}) {
  const cycleBase = progress.last_successful_cycle_at_unix
    ?? progress.process.started_at_unix;
  return {
    contract_version: "pc_relay.liveness_probe.v1",
    state,
    reason,
    observed_pids,
    progress_age_seconds: Math.max(0, probe_at_unix - progress.recorded_at_unix),
    queue_progress_age_seconds: Math.max(0, probe_at_unix - progress.queue.last_progress_at_unix),
    successful_cycle_age_seconds: Math.max(0, probe_at_unix - cycleBase),
    consecutive_cycle_failures: progress.consecutive_cycle_failures,
    pending_count: progress.queue.pending_count,
    loop_generation_id: progress.loop_generation_id,
    loop_epoch: progress.loop_epoch,
    process_pid: progress.process.pid,
    last_error_classification: progress.last_error?.classification ?? null,
  };
}

test("R26 vendored schemas/manifest/fixture pin exact producer blob identities", () => {
  const artifacts = validateVendoredR26Artifacts();
  assert.equal(artifacts.producer_sha, "96d453bcdc866bfd26c06ad88e2ec0c033fbccdd");
  assert.equal(artifacts.workflow_run, 36833819136);
  assert.equal(artifacts.progress_contract, "pc_relay.progress.v1");
  assert.equal(artifacts.liveness_contract, "pc_relay.liveness_probe.v1");
  assert.deepEqual(artifacts.source_blobs, R26_PRODUCER_PIN.source_blobs);
  assert.equal(validateR26ProducerPin(pinFixture()), true);
});

test("healthy_progressing exact producer evidence authorizes mutation readiness", () => {
  const progress = progressFixture();
  const liveness = livenessFor(progress);
  const now = (progress.recorded_at_unix + 2) * 1000;
  const consumer = new R26RelayProgressConsumer({
    clock: () => now,
    maxEvidenceAgeMs: 5_000,
  });
  const snapshot = consumer.ingest({ progress, liveness });

  assert.equal(snapshot.source_state, "SOURCE_BOUND");
  assert.equal(snapshot.classification, "healthy_progressing");
  assert.equal(snapshot.liveness_state, "healthy_progressing");
  assert.equal(snapshot.queue.pending_count, 1);
  assert.equal(snapshot.queue.oldest_pending_age_seconds, 4.5);
  assert.equal(snapshot.queue.queue_progress_age_seconds, 5);
  assert.equal(snapshot.progress.successful_cycle_age_seconds, 1);
  assert.equal(snapshot.progress.last_result_committed_at_unix, 1790820010);
  assert.equal(snapshot.loop.generation_id, "r26-fixture-generation");
  assert.equal(snapshot.loop.epoch, 17);
  assert.equal(snapshot.error.classification, null);
  assert.equal(snapshot.recovery.auto_restart, false);
  assert.equal(snapshot.recovery.auto_kill, false);
  assert.equal(snapshot.recovery.automatic_replay, false);
  assert.equal(snapshot.cutover.decision, "NO_LIVE_CUTOVER");

  assert.deepEqual(consumer.readiness({ effect: "side_effect" }), {
    state: "READY",
    reason: "R26_RELAY_HEALTHY_PROGRESSING",
    liveness_state: "healthy_progressing",
    automatic_replay: false,
  });
});

test("producer SHA, branch, schema and liveness/progress drift fail closed", () => {
  const wrongSha = progressFixture();
  wrongSha.source.startup_head = "0".repeat(40);
  assert.throws(
    () => validateR26Progress(wrongSha),
    (error) => error instanceof R26RelayProgressConsumerError
      && error.code === "R26_PRODUCER_SHA_DRIFT",
  );

  const wrongBranch = progressFixture();
  wrongBranch.source.branch = "agent/not-r26";
  assert.throws(
    () => validateR26Progress(wrongBranch),
    (error) => error.code === "R26_PRODUCER_SHA_DRIFT",
  );

  const schema = progressFixture();
  schema.contract_version = "pc_relay.progress.v2";
  assert.throws(
    () => validateR26Progress(schema),
    (error) => error.code === "R26_SCHEMA_DRIFT",
  );

  const progress = progressFixture();
  const liveness = livenessFor(progress);
  liveness.loop_epoch += 1;
  const consumer = new R26RelayProgressConsumer({
    clock: () => (progress.recorded_at_unix + 2) * 1000,
  });
  assert.throws(
    () => consumer.ingest({ progress, liveness }),
    (error) => error.code === "R26_LIVENESS_PROGRESS_DRIFT",
  );

  const changedPin = pinFixture();
  changedPin.producer_sha = "f".repeat(40);
  assert.throws(
    () => validateR26ProducerPin(changedPin),
    (error) => error.code === "R26_PRODUCER_SHA_DRIFT",
  );
});

test("alive_stalled blocks mutations but allows bounded read-only diagnostics", () => {
  const progress = progressFixture();
  const probeAt = progress.recorded_at_unix + 20;
  const liveness = livenessFor(progress, {
    state: "alive_stalled",
    reason: "pending_queue_has_no_result_progress",
    probe_at_unix: probeAt,
  });
  const consumer = new R26RelayProgressConsumer({
    clock: () => probeAt * 1000,
    maxEvidenceAgeMs: 5_000,
  });
  const snapshot = consumer.ingest({ progress, liveness });
  assert.equal(snapshot.classification, "alive_stalled");
  assert.equal(snapshot.queue.queue_progress_age_seconds, 24);
  assert.deepEqual(consumer.readiness({ effect: "side_effect" }), {
    state: "BLOCKED",
    reason: "R26_RELAY_ALIVE_STALLED",
    liveness_state: "alive_stalled",
    automatic_replay: false,
  });
  assert.deepEqual(consumer.readiness({ effect: "read_only" }), {
    state: "DIAGNOSTIC_ONLY",
    reason: "alive_stalled",
    liveness_state: "alive_stalled",
    automatic_replay: false,
  });
});

for (const [state, reason, observed] of [
  ["duplicate_processes_ambiguous", "multiple_matching_relay_processes", [4242, 4243]],
  ["alive_ambiguous_identity", "progress_pid_does_not_match_observed_process", [9999]],
  ["stale_record_no_process", "progress_record_exists_but_process_absent", []],
]) {
  test(`${state} preserves producer semantics and never auto-recovers ownership`, () => {
    const progress = progressFixture();
    const liveness = livenessFor(progress, {
      state,
      reason,
      observed_pids: observed,
    });
    const consumer = new R26RelayProgressConsumer({
      clock: () => (progress.recorded_at_unix + 2) * 1000,
    });
    const snapshot = consumer.ingest({ progress, liveness });
    assert.equal(snapshot.liveness_state, state);
    assert.equal(snapshot.classification, state);
    assert.equal(snapshot.recovery.auto_restart, false);
    assert.equal(snapshot.recovery.auto_kill, false);
    assert.equal(snapshot.recovery.automatic_replay, false);
    assert.equal(consumer.readiness({ effect: "side_effect" }).state, "BLOCKED");
    assert.equal(consumer.readiness({ effect: "read_only" }).state, "DIAGNOSTIC_ONLY");
  });
}

test("cached healthy evidence dynamically becomes stale and loses mutation readiness", () => {
  const progress = progressFixture();
  const liveness = livenessFor(progress);
  let now = (progress.recorded_at_unix + 2) * 1000;
  const consumer = new R26RelayProgressConsumer({
    clock: () => now,
    maxEvidenceAgeMs: 5_000,
  });
  consumer.ingest({ progress, liveness });
  assert.equal(consumer.readiness({ effect: "side_effect" }).state, "READY");
  now += 6_000;
  const stale = consumer.snapshot();
  assert.equal(stale.source_state, "STALE");
  assert.equal(stale.classification, "stale_producer_evidence");
  assert.equal(consumer.readiness({ effect: "side_effect" }).reason, "R26_RELAY_PROGRESS_STALE");
  assert.equal(consumer.readiness({ effect: "read_only" }).state, "DIAGNOSTIC_ONLY");
});

test("restart changes loop/process identity but never clears pending UNKNOWN reconciliation", () => {
  const first = progressFixture();
  const firstLive = livenessFor(first);
  let now = (first.recorded_at_unix + 2) * 1000;
  const consumer = new R26RelayProgressConsumer({
    clock: () => now,
    maxEvidenceAgeMs: 10_000,
  });
  consumer.ingest({ progress: first, liveness: firstLive });

  const restarted = progressFixture();
  restarted.process.pid = 5252;
  restarted.process.instance_id = "r26-restarted-instance";
  restarted.process.started_at_unix += 2;
  restarted.loop_generation_id = "r26-restarted-generation";
  restarted.loop_epoch = 1;
  restarted.recorded_at_unix += 3;
  restarted.current_cycle.started_at_unix = restarted.recorded_at_unix;
  restarted.current_cycle.updated_at_unix = restarted.recorded_at_unix;
  restarted.last_successful_cycle_at_unix = restarted.recorded_at_unix;
  restarted.queue.last_progress_at_unix = restarted.recorded_at_unix;
  restarted.queue.oldest_pending_age_seconds = 0.5;
  const live = livenessFor(restarted, {
    observed_pids: [5252],
    probe_at_unix: restarted.recorded_at_unix + 1,
  });
  now = (restarted.recorded_at_unix + 2) * 1000;
  const snapshot = consumer.ingest({
    progress: restarted,
    liveness: live,
    pending_unknown_effects: 1,
  });

  assert.equal(snapshot.restart_observed, true);
  assert.equal(snapshot.classification, "reconciliation_required");
  assert.equal(snapshot.reconciliation_required, true);
  assert.equal(snapshot.pending_unknown_effects, 1);
  assert.deepEqual(consumer.readiness({ effect: "side_effect" }), {
    state: "BLOCKED",
    reason: "R26_RECONCILIATION_REQUIRED",
    liveness_state: "healthy_progressing",
    automatic_replay: false,
  });
  assert.equal(snapshot.recovery.replay_authorized_after_liveness_recovery, false);
});

test("bounded producer error surfaces classification but never raw secret-bearing message", () => {
  const progress = progressFixture();
  progress.last_error = {
    classification: "git_auth_or_permission",
    retryable: false,
    operation: "fetch",
    returncode: 128,
    message: "authorization=super-secret-value",
    at_unix: progress.recorded_at_unix,
  };
  progress.consecutive_cycle_failures = 1;
  const live = livenessFor(progress);
  const consumer = new R26RelayProgressConsumer({
    clock: () => (progress.recorded_at_unix + 2) * 1000,
  });
  const snapshot = consumer.ingest({ progress, liveness: live });
  assert.deepEqual(snapshot.error, {
    classification: "git_auth_or_permission",
    retryable: false,
    operation: "fetch",
    returncode: 128,
    at_unix: progress.recorded_at_unix,
  });
  assert.equal(JSON.stringify(snapshot).includes("super-secret-value"), false);
});

test("liveness schema accepts exact producer states only", () => {
  const progress = progressFixture();
  const liveness = livenessFor(progress);
  assert.equal(validateR26Liveness(liveness).state, "healthy_progressing");
  liveness.state = "healthy";
  assert.throws(
    () => validateR26Liveness(liveness),
    (error) => error.code === "R26_SCHEMA_DRIFT",
  );
});
