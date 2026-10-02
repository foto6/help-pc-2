import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import {
  R29_BLOCKED,
  R29_PRODUCER_PIN,
  R29_QA_V1,
  R29_READY,
  assessR29WatchdogState,
  classifyR29HealthScenario,
  evaluateR29RelayCutoverQa,
  inspectR29ProducerSafety,
  logicalRelayCount,
  validateR29VendoredProducerBlobs,
} from "../src/index.js";

function committedBlobSha(path) {
  return execFileSync("git", ["rev-parse", `HEAD:${path}`], { encoding: "utf8" }).trim();
}

function committedBlobIdentities() {
  return Object.fromEntries(
    Object.values(R29_PRODUCER_PIN.source_blobs)
      .map((item) => [item.vendored_path, committedBlobSha(item.vendored_path)]),
  );
}

test("R29 is pinned to the exact help-pc-1 producer SHA and green CI run", () => {
  assert.equal(R29_PRODUCER_PIN.producer.repository, "foto6/help-pc-1");
  assert.equal(R29_PRODUCER_PIN.producer.branch, "agent/pc-relay-watchdog-cutover-candidate-20261002");
  assert.equal(R29_PRODUCER_PIN.producer.sha, "6f44216e7e5fbf9fe3ae635f302c3c33887e0930");
  assert.equal(R29_PRODUCER_PIN.producer.exact_head_ci_run, 36967056910);
  assert.equal(R29_PRODUCER_PIN.producer.exact_head_ci_conclusion, "SUCCESS");
  assert.equal(R29_PRODUCER_PIN.live_cutover_authorized, false);
});

test("every vendored R29 producer file is the same committed Git blob as the exact producer", () => {
  const identities = committedBlobIdentities();
  const verified = validateR29VendoredProducerBlobs(identities);
  assert.deepEqual(verified, { ok: true, failures: [] });
  assert.equal(validateR29VendoredProducerBlobs().ok, false);
  for (const item of Object.values(R29_PRODUCER_PIN.source_blobs)) {
    assert.equal(committedBlobSha(item.vendored_path), item.git_blob_sha1, item.vendored_path);
  }
});

test("real 2026-10-01 incident is STALE despite process existence", () => {
  const fixture = JSON.parse(readFileSync(
    new URL("../conformance/r29_relay_cutover_qa/producer/incident_2026-10-01.json", import.meta.url),
    "utf8",
  ));
  const stale = fixture.scenarios.find((item) => item.name === "recorded_stale_sync");
  assert.equal(stale.process_exists, true);
  assert.equal(stale.snapshot.status, "healthy");
  assert.equal(classifyR29HealthScenario(stale), "STALE");

  const processOnly = {
    process_exists: true,
    logical_process_count: 1,
    health_pid_observed: false,
    snapshot: null,
    now_unix: stale.now_unix,
  };
  assert.equal(classifyR29HealthScenario(processOnly), "PROCESS_EXISTS");
  assert.notEqual(classifyR29HealthScenario(processOnly), "HEALTHY");
});

test("healthy progress and unknown post-reboot side effect separate cleanly", () => {
  const fixture = JSON.parse(readFileSync(
    new URL("../conformance/r29_relay_cutover_qa/producer/incident_2026-10-01.json", import.meta.url),
    "utf8",
  ));
  const healthy = fixture.scenarios.find((item) => item.name === "healthy_after_forward_progress");
  const unknown = fixture.scenarios.find((item) => item.name === "unknown_side_effect_after_reboot");
  assert.equal(classifyR29HealthScenario(healthy), "HEALTHY");
  assert.equal(classifyR29HealthScenario(unknown), "RECONCILIATION_REQUIRED");
  assert.equal(unknown.snapshot.last_reconciliation_request_id, "unknown-side-effect");
});

test("normal py.exe -> python runtime tree is one logical relay, independent second runtime is duplicate", () => {
  const chain = [
    { image: "py.exe", pid: 4612, parent_pid: 1000 },
    { image: "python3.13.exe", pid: 15056, parent_pid: 4612 },
  ];
  assert.equal(logicalRelayCount(chain), 1);
  assert.equal(logicalRelayCount([
    ...chain,
    { image: "python3.13.exe", pid: 16000, parent_pid: 2000 },
  ]), 2);
});

test("startup failure, degraded/process-only, stale, duplicate and reconciliation all stay blocked", () => {
  for (const state of [
    "PROCESS_MISSING",
    "PROCESS_EXISTS",
    "STALE",
    "DUPLICATE_AMBIGUOUS",
    "RECONCILIATION_REQUIRED",
  ]) {
    const assessed = assessR29WatchdogState(state);
    assert.equal(assessed.cutover_precondition, "BLOCK", state);
    assert.equal(assessed.startup_or_recovery_allowed, false, state);
    assert.equal(assessed.live_cutover_authorized, false, state);
  }
  const healthy = assessR29WatchdogState("HEALTHY");
  assert.equal(healthy.cutover_precondition, "PASS");
  assert.equal(healthy.live_cutover_authorized, false);
});

test("independent static safety inspection passes every source-bound gate", () => {
  const safety = inspectR29ProducerSafety({ committedBlobIdentities: committedBlobIdentities() });
  assert.equal(safety.source_blob_count, 15);
  assert.equal(safety.incident_logical_process_count, 1);
  assert.deepEqual(safety.scenario_states, {
    recorded_stale_sync: "STALE",
    healthy_after_forward_progress: "HEALTHY",
    unknown_side_effect_after_reboot: "RECONCILIATION_REQUIRED",
  });
  assert.equal(safety.gates.length >= 10, true);
  assert.deepEqual(safety.gates.filter((item) => !item.ok), []);
});

test("R29 report reaches decision readiness without authorizing live cutover or mutation", () => {
  const result = evaluateR29RelayCutoverQa({ committedBlobIdentities: committedBlobIdentities() });
  assert.equal(result.contract_version, R29_QA_V1);
  assert.equal(result.decision, R29_READY);
  assert.notEqual(result.decision, R29_BLOCKED);
  assert.equal(result.producer_source_bound, true);
  assert.equal(result.blockers.length, 0);
  assert.equal(result.live_cutover_authorized, false);
  assert.equal(result.mutation_execution_authorized, false);
  assert.equal(result.autostart_apply_authorized, false);
  assert.equal(result.automatic_replay_authorized, false);
  assert.equal(result.automatic_process_kill_authorized, false);
  assert.equal(result.release_gate, "NO_LIVE_CUTOVER");
});

test("R29 implementation has no executable process-control primitive", () => {
  const source = readFileSync(new URL("../src/r29-relay-cutover-qa.js", import.meta.url), "utf8");
  const report = readFileSync(new URL("../tools/r29-relay-cutover-qa-report.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawn\s*\(|execFile\s*\(|process\.kill\s*\(/);
  for (const text of [source, report]) {
    assert.doesNotMatch(text, /process\.kill\s*\(|Stop-Process|taskkill|Restart-Service|Start-Service|Stop-Service/i);
    assert.doesNotMatch(text, /powershell(?:\.exe)?\s+-|schtasks\s+\/|sc\.exe\s+/i);
  }
  assert.match(report, /execFileSync\("git", \["rev-parse", `HEAD:/);
});
