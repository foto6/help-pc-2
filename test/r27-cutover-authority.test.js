import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  R27_AUTHORITIES,
  R27_CUTOVER_AUTHORITY_V1,
  R27_COORDINATOR_HANDOFF_V1,
  buildR27CoordinatorHandoff,
  evaluateR27CutoverAuthority,
  loadBridgeR23AuthorityPin,
  validateBridgeR23AuthorityPin,
} from "../src/index.js";

const fixtures = JSON.parse(readFileSync(
  new URL("../conformance/r27_cutover_authority/decision-fixtures.json", import.meta.url),
  "utf8",
));

function clone(value) {
  return structuredClone(value);
}

function setPath(target, path, value) {
  const parts = path.split(".");
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    if (!cursor || typeof cursor !== "object") {
      throw new Error("invalid fixture patch path: " + path);
    }
    cursor = cursor[part];
  }
  cursor[parts.at(-1)] = clone(value);
}

function fixtureCase(name) {
  const spec = fixtures.cases.find((item) => item.name === name);
  assert.ok(spec, "missing fixture " + name);
  const input = clone(fixtures.base_ready_input);
  for (const patch of spec.patches) setPath(input, patch.path, patch.value);
  return { spec, input };
}

test("R27 exact Bridge R23 authority pin validates immutable source/artifact identities", () => {
  const pin = loadBridgeR23AuthorityPin();
  assert.equal(validateBridgeR23AuthorityPin(pin), true);
  assert.equal(pin.bridge_sha, R27_AUTHORITIES.bridge_r23.sha);
  assert.equal(pin.bridge_ci_run, 36861515420);
  assert.equal(pin.ci_artifacts.ubuntu.artifact_id, 11161244146);
  assert.equal(
    pin.ci_artifacts.ubuntu.archive_digest,
    "sha256:63f9a62a9bb2d83d1c3eee3eca9a169bd342e3ec15b9944294f7ce46cda7f8af",
  );
  assert.equal(pin.ci_artifacts.windows.artifact_id, 11161923643);
  assert.equal(
    pin.ci_artifacts.windows.archive_digest,
    "sha256:fa87af539c857c7bd35b5a77b47ea1ec234a151e0c4a2b74849b39b9fe4618be",
  );
  assert.deepEqual(
    pin.rehearsal_contract.rollback_stages,
    ["before_stop", "state_validation_failure", "after_start", "after_health_failure", "after_first_assignment"],
  );
  assert.deepEqual(
    pin.rehearsal_contract.required_faults,
    ["occupied_port", "stale_pid", "nonresponsive_status", "code_reload_required", "hung_cdp", "pending_assignment"],
  );
});

test("deterministic decision fixtures cover READY, BLOCKED and RECONCILIATION_REQUIRED", () => {
  assert.equal(fixtures.contract_version, "pc.native.r27.cutover_decision_fixtures.v1");
  const seen = new Set();
  for (const spec of fixtures.cases) {
    const { input } = fixtureCase(spec.name);
    const result = evaluateR27CutoverAuthority(input, {
      clock: () => fixtures.clock_ms,
    });
    seen.add(result.decision);
    assert.equal(result.contract_version, R27_CUTOVER_AUTHORITY_V1, spec.name);
    assert.equal(result.decision, spec.expected, spec.name);
    assert.equal(result.release_gate, "NO_LIVE_CUTOVER", spec.name);
    assert.equal(result.live_cutover_performed, false, spec.name);
    assert.equal(result.automatic_replay_authorized, false, spec.name);
    assert.equal(result.automatic_restart_authorized, false, spec.name);
    assert.equal(result.automatic_kill_authorized, false, spec.name);
    assert.equal(result.read_only_diagnostics_allowed, true, spec.name);
  }
  assert.deepEqual(
    [...seen].sort(),
    ["BLOCKED", "READY_FOR_EXPLICIT_CUTOVER", "RECONCILIATION_REQUIRED"].sort(),
  );
});

test("READY requires every named Bridge/R25/R26 gate and produces no executable cutover action", () => {
  const { input } = fixtureCase("ready");
  const result = evaluateR27CutoverAuthority(input, { clock: () => fixtures.clock_ms });
  assert.equal(result.decision, "READY_FOR_EXPLICIT_CUTOVER");
  assert.equal(result.blockers.length, 0);
  assert.equal(result.gates.every((item) => item.ok), true);
  assert.equal(result.explicit_cutover_preconditions_met, true);
  assert.equal(result.live_cutover_authorized, false);
  assert.equal(result.mutation_execution_authorized, false);

  const handoff = buildR27CoordinatorHandoff(result, {
    generatedAt: "2026-10-01T13:00:00.000Z",
  });
  assert.equal(handoff.contract_version, R27_COORDINATOR_HANDOFF_V1);
  assert.equal(handoff.decision, "READY_FOR_EXPLICIT_CUTOVER");
  assert.equal(handoff.release_gate, "NO_LIVE_CUTOVER");
  assert.equal(handoff.executable_live_cutover_action, null);
  assert.deepEqual(handoff.executable_commands, []);
  assert.equal(handoff.automatic_replay_authorized, false);
  assert.equal(handoff.automatic_restart_authorized, false);
  assert.equal(handoff.automatic_kill_authorized, false);
  assert.equal(handoff.read_only_diagnostics_allowed, true);
  assert.match(handoff.digest, /^[0-9a-f]{64}$/);
  assert.equal(handoff.authorities.bridge_r23.sha, "7e0d5e07f93990f103358850f8f3c10c1563f83a");
  assert.equal(handoff.authorities.native_r26.sha, "46c50ea85c3cc4db6b0e43fbd2762d0420d1be28");
  assert.equal(handoff.authorities.pc_executor_r24.sha, "60ba0ce92bf2f3cdd89e3213dba40793c6a90d8b");
  assert.equal(handoff.authorities.pc_relay_r26.sha, "96d453bcdc866bfd26c06ad88e2ec0c033fbccdd");
});

test("UNKNOWN side effect has decision precedence and never becomes replay-authorized", () => {
  const { input } = fixtureCase("unknown_side_effect");
  input.bridge_live_preflight.status.responded = false;
  input.r26_relay_progress.liveness_state = "alive_stalled";
  input.r26_relay_progress.classification = "alive_stalled";
  input.r26_relay_progress.cutover.healthy_progressing = false;
  const result = evaluateR27CutoverAuthority(input, { clock: () => fixtures.clock_ms });
  assert.equal(result.decision, "RECONCILIATION_REQUIRED");
  assert.equal(result.automatic_replay_authorized, false);
  assert.ok(result.blockers.some((item) => item.gate === "unknown_side_effect_reconciliation"));
  assert.ok(result.blockers.some((item) => item.gate === "bridge_status_freshness"));
  assert.ok(result.blockers.some((item) => item.gate === "r26_healthy_progressing"));
});

test("Bridge moving SHA, artifact drift and failed rollback rehearsal become BLOCKED decisions", () => {
  const { input } = fixtureCase("ready");
  const basePin = loadBridgeR23AuthorityPin();

  const cases = [
    ["moving_sha", (pin) => { pin.bridge_sha = "0".repeat(40); }],
    ["artifact_digest", (pin) => { pin.ci_artifacts.ubuntu.archive_digest = "sha256:" + "0".repeat(64); }],
    ["failed_rollback", (pin) => { pin.candidate_manifests.ubuntu.rollback.ready = false; }],
    ["schema_drift", (pin) => { pin.extra = true; }],
  ];
  for (const [name, mutate] of cases) {
    const pin = clone(basePin);
    mutate(pin);
    const result = evaluateR27CutoverAuthority(input, {
      clock: () => fixtures.clock_ms,
      bridgePin: pin,
    });
    assert.equal(result.decision, "BLOCKED", name);
    assert.equal(result.read_only_diagnostics_allowed, true, name);
    assert.equal(result.live_cutover_authorized, false, name);
    const authority = result.gates.find((item) => item.id === "bridge_r23_rehearsal_authority");
    assert.equal(authority.ok, false, name);
  }
});

test("all critical single-gate failure fixtures identify at least one blocker", () => {
  for (const spec of fixtures.cases.filter((item) => item.expected === "BLOCKED")) {
    const { input } = fixtureCase(spec.name);
    const result = evaluateR27CutoverAuthority(input, { clock: () => fixtures.clock_ms });
    assert.equal(result.decision, "BLOCKED", spec.name);
    assert.ok(result.blockers.length >= 1, spec.name);
    assert.equal(result.live_cutover_authorized, false, spec.name);
    assert.equal(result.read_only_diagnostics_allowed, true, spec.name);
  }
});

test("coordinator handoff carries required live fields and stopping rules but no live action", () => {
  const { input } = fixtureCase("r26_duplicate_ownership");
  const result = evaluateR27CutoverAuthority(input, { clock: () => fixtures.clock_ms });
  const handoff = buildR27CoordinatorHandoff(result, {
    generatedAt: "2026-10-01T13:00:00.000Z",
  });
  assert.equal(handoff.decision, "BLOCKED");
  assert.equal(handoff.executable_live_cutover_action, null);
  assert.deepEqual(handoff.executable_commands, []);
  assert.ok(handoff.required_live_preflight_fields.some((item) => item.includes("bridge_live_preflight.status")));
  assert.ok(handoff.required_live_preflight_fields.some((item) => item.includes("r25_runtime_health")));
  assert.ok(handoff.required_live_preflight_fields.some((item) => item.includes("r26_relay_progress")));
  assert.ok(handoff.stopping_rules.some((item) => item.includes("UNKNOWN side effect")));
  assert.ok(handoff.stopping_rules.some((item) => item.includes("never kill/restart")));
});
