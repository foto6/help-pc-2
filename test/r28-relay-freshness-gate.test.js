import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  R28_FRESHNESS_GATE_V1,
  R28_PRODUCER_PIN,
  evaluateR28RelayFreshness,
  validateR28HealthSnapshot,
} from "../src/index.js";

function gitBlobSha1(bytes) {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return createHash("sha1")
    .update(Buffer.from(`blob ${body.length}\0`))
    .update(body)
    .digest("hex");
}

function producer() {
  return {
    repository: R28_PRODUCER_PIN.repository,
    branch: R28_PRODUCER_PIN.branch,
    sha: R28_PRODUCER_PIN.sha,
    workflow_run: R28_PRODUCER_PIN.workflow_run,
    source_blobs: { ...R28_PRODUCER_PIN.source_blobs },
  };
}

function health(overrides = {}) {
  return {
    health_version: "pc_relay.health.v1",
    pid: 15056,
    branch: "agent/pc-github-relay",
    live: true,
    status: "healthy",
    phase: "idle",
    updated_at_unix: 1000,
    started_at_unix: 900,
    last_sync_at_unix: 999,
    last_cycle_completed_at_unix: 1000,
    last_result_published_at_unix: 998,
    local_head: "a".repeat(40),
    remote_head: "a".repeat(40),
    request_count: 576,
    result_count: 576,
    backlog_count: 0,
    current_request_id: null,
    last_error: null,
    last_reconciliation_request_id: null,
    reconciliation_required: false,
    ...overrides,
  };
}

function processes() {
  return [
    { pid: 4612, parent_pid: 9484, role: "launcher_wrapper" },
    { pid: 15056, parent_pid: 4612, role: "relay_runtime" },
  ];
}

function input(overrides = {}) {
  return {
    producer: producer(),
    health: health(),
    previous_health: null,
    observed_remote_head: "a".repeat(40),
    processes: processes(),
    pending_unknown_effects: 0,
    ...overrides,
  };
}

test("R28 vendored producer schema and pin are byte-identical to exact producer blobs", () => {
  const schema = readFileSync(
    new URL("../conformance/r28_relay_freshness/pc_relay.health.v1.schema.json", import.meta.url),
  );
  const pin = readFileSync(
    new URL("../conformance/r28_relay_freshness/producer-pin.r2.json", import.meta.url),
  );
  assert.equal(gitBlobSha1(schema), R28_PRODUCER_PIN.source_blobs.health_schema);
  assert.equal(gitBlobSha1(pin), R28_PRODUCER_PIN.source_blobs.producer_pin);
});

test("healthy exact evidence accepts normal py wrapper -> python runtime chain", () => {
  const result = evaluateR28RelayFreshness(input(), { nowUnix: 1005 });
  assert.equal(result.contract_version, R28_FRESHNESS_GATE_V1);
  assert.equal(result.decision, "HEALTHY");
  assert.equal(result.usable_for_mutation, true);
  assert.equal(result.blockers.length, 0);
  assert.equal(result.live_cutover_authorized, false);
  assert.equal(result.automatic_restart_authorized, false);
  assert.equal(result.automatic_kill_authorized, false);
  assert.equal(result.automatic_replay_authorized, false);
});

test("PID/process presence without durable health is MISSING_EVIDENCE, never healthy", () => {
  const result = evaluateR28RelayFreshness(input({ health: null }), { nowUnix: 1005 });
  assert.equal(result.decision, "MISSING_EVIDENCE");
  assert.equal(result.usable_for_mutation, false);
  assert.ok(result.blockers.some((item) => item.code === "MISSING_HEALTH_EVIDENCE"));
});

test("exact observed incident: alive process + stale local HEAD + remote advance fails STALE", () => {
  const staleLocal = "be374169e51309bbc943f68e7965f23f53c85380";
  const remote = "e29d3746d2fbdc35b26e4b0725a63b78100a07c6";
  const snapshot = health({
    updated_at_unix: 900,
    local_head: staleLocal,
    remote_head: staleLocal,
    request_count: 576,
    result_count: 554,
    backlog_count: 22,
  });
  const result = evaluateR28RelayFreshness(input({
    health: snapshot,
    observed_remote_head: remote,
  }), { nowUnix: 1000 });
  assert.equal(result.decision, "STALE");
  assert.equal(result.usable_for_mutation, false);
  assert.ok(result.blockers.some((item) => item.code === "HEALTH_STALE"));
  assert.ok(result.blockers.some((item) => item.code === "REMOTE_HEAD_OBSERVATION_DRIFT"));
  assert.ok(result.blockers.some((item) => item.code === "LOCAL_HEAD_STALE"));
});

test("two relay runtimes are ownership ambiguity, but wrapper+one runtime is not", () => {
  const result = evaluateR28RelayFreshness(input({
    processes: [
      ...processes(),
      { pid: 16000, parent_pid: 4612, role: "relay_runtime" },
    ],
  }), { nowUnix: 1005 });
  assert.equal(result.decision, "BLOCKED");
  assert.ok(result.blockers.some((item) => item.code === "RELAY_RUNTIME_OWNERSHIP_AMBIGUOUS"));
});

test("interrupted side effect or durable UNKNOWN requires reconciliation and never replay", () => {
  for (const variant of [
    input({ health: health({ reconciliation_required: true, last_reconciliation_request_id: "req-1" }) }),
    input({ pending_unknown_effects: 1 }),
  ]) {
    const result = evaluateR28RelayFreshness(variant, { nowUnix: 1005 });
    assert.equal(result.decision, "RECONCILIATION_REQUIRED");
    assert.equal(result.usable_for_mutation, false);
    assert.equal(result.automatic_replay_authorized, false);
    assert.equal(result.automatic_restart_authorized, false);
  }
});

test("bounded long-running phase gets 150s freshness budget but then becomes stale", () => {
  const running = health({
    phase: "execute_request",
    updated_at_unix: 900,
    last_cycle_completed_at_unix: 899,
  });
  const ok = evaluateR28RelayFreshness(input({ health: running }), { nowUnix: 1020 });
  assert.equal(ok.decision, "HEALTHY");
  assert.equal(ok.freshness_budget_seconds, 150);

  const stale = evaluateR28RelayFreshness(input({ health: running }), { nowUnix: 1051 });
  assert.equal(stale.decision, "STALE");
  assert.ok(stale.blockers.some((item) => item.code === "HEALTH_STALE"));
});

test("impossible monotonicity is blocked", () => {
  const previous = health({ updated_at_unix: 1000, result_count: 570, request_count: 576, backlog_count: 6 });
  const current = health({ updated_at_unix: 1001, result_count: 569, request_count: 576, backlog_count: 7 });
  const result = evaluateR28RelayFreshness(input({
    health: current,
    previous_health: previous,
  }), { nowUnix: 1002 });
  assert.equal(result.decision, "BLOCKED");
  assert.ok(result.blockers.some((item) => item.code === "IMPOSSIBLE_MONOTONICITY"));
});

test("producer SHA/blob drift fails closed even when runtime health looks good", () => {
  const drifted = producer();
  drifted.sha = "f".repeat(40);
  const result = evaluateR28RelayFreshness(input({ producer: drifted }), { nowUnix: 1005 });
  assert.equal(result.decision, "BLOCKED");
  assert.equal(result.producer_pin_valid, false);
  assert.ok(result.blockers.some((item) => item.code === "PRODUCER_PIN_DRIFT"));
});

test("health validator rejects impossible queue accounting and future timestamps", () => {
  assert.deepEqual(
    validateR28HealthSnapshot(health({ request_count: 10, result_count: 9, backlog_count: 0 })),
    { ok: false, code: "QUEUE_COUNTER_INCONSISTENT" },
  );
  assert.equal(
    validateR28HealthSnapshot(health({ last_sync_at_unix: 1001 })).code,
    "IMPOSSIBLE_TIME_ORDER",
  );
});
