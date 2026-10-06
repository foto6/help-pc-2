import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  R31_ACTIVE_SOURCE_AUTHORITY_CONTRACT,
  R31_ACTIVE_SOURCE_OBSERVED_HEAD,
  validateR31SourcePin,
} from "../src/pc-control-direct-candidate.js";
import {
  R37_STATES,
  R37OperatorLifecycle,
  R37OperatorLifecycleError,
} from "../src/r37-operator-lifecycle.js";

function sourceText(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("R38 classifies the reported drift as accepted successor lineage, not arbitrary hash rewrite", () => {
  const lineage = JSON.parse(sourceText("conformance/r38_source_pin_recovery/lineage.json"));
  assert.equal(lineage.contract_version, "native_mcp.source_pin_recovery.r38.v1");
  assert.equal(lineage.classification, "LEGITIMATE_ACCEPTED_SUCCESSOR_STALE_CONSUMER_PIN");
  assert.equal(lineage.failing_ci.run_id, 37398892815);
  assert.equal(lineage.failing_ci.failure_code, "R31_SOURCE_BLOB_DRIFT");
  assert.equal(lineage.root_cause.direct_remote_change.old_blob, "cb6d74888514d3262d206df4f3cbd13a1f8899e2");
  assert.equal(lineage.root_cause.direct_remote_change.new_blob, "8df50ca3792091625d4de1143b4625ae2f970ecd");
  assert.equal(lineage.root_cause.direct_remote_change.commit, "7f643b4f1f803b637e1b377ac4989bc79d03c4dd");
  assert.equal(lineage.root_cause.direct_remote_change.old_expression, "/[s/]/.test(value)");
  assert.equal(lineage.root_cause.direct_remote_change.new_expression, "/[\\s/]/.test(value)");
});

test("R38 active source authority validates exact accepted bytes", () => {
  const pin = validateR31SourcePin();
  assert.equal(pin.contract_version, R31_ACTIVE_SOURCE_AUTHORITY_CONTRACT);
  assert.equal(pin.lineage_observed_head, R31_ACTIVE_SOURCE_OBSERVED_HEAD);
  assert.equal(pin.active_blobs["src/direct-remote-mcp.js"], "8df50ca3792091625d4de1143b4625ae2f970ecd");
  assert.equal(pin.active_blobs["src/mcp-host.js"], "3026902f00adf1b453645a28689ecd72f4308ee4");
  assert.equal(pin.active_blobs["src/mcp-runtime-config.js"], "a6f09571e8ffe5cd10acfbcd8b489e9a07d5b600");
  assert.equal(pin.active_blobs["src/native-relay-provider.js"], "7dc50fa87102f6bf21b1e612c3c8d283044a3fb4");
  assert.equal(pin.safety_invariants.automatic_replay, false);
  assert.equal(pin.safety_invariants.current_authority, "github_relay");
  assert.equal(pin.recovery_acceptance.status, "accepted");
  assert.equal(pin.recovery_acceptance.ci_run_id, 37405176472);
  assert.equal(pin.recovery_acceptance.head_sha, "5241858a029d293f7d200045c585adefc37dde5b");
  assert.equal(pin.recovery_acceptance.ubuntu_job.conclusion, "success");
  assert.equal(pin.recovery_acceptance.windows_job.conclusion, "success");
});

test("R38 same metadata with wrong checkout blob fails before readiness generation", () => {
  const pin = validateR31SourcePin();
  assert.throws(
    () => validateR31SourcePin({
      pin,
      readText: (path) => path === "src/direct-remote-mcp.js"
        ? sourceText(path).replace("/[\\s/]/.test(value)", "/[s/]/.test(value)")
        : sourceText(path),
    }),
    (error) =>
      error?.code === "R31_SOURCE_BLOB_DRIFT"
      && error?.details?.path === "src/direct-remote-mcp.js"
      && error?.details?.expected === "8df50ca3792091625d4de1143b4625ae2f970ecd",
  );
});

test("R38 preserves exact R37 lifecycle state vocabulary", () => {
  assert.deepEqual(R37_STATES, [
    "RUNNING",
    "PAUSED",
    "DRAINING",
    "RECONCILIATION_REQUIRED",
  ]);
});

test("R38 preserves explicit idempotent resume and no replay after unknown outcome", () => {
  const lifecycle = new R37OperatorLifecycle({
    authoritySha: "authority-sha",
    authorityVersion: "authority-v1",
    clock: () => 1000,
  });
  const paused = lifecycle.pause("maintenance");
  assert.equal(paused.operator_state, "PAUSED");
  const resumed = lifecycle.resume();
  assert.equal(resumed.operator_state, "RUNNING");
  const resumedAgain = lifecycle.resume();
  assert.equal(resumedAgain.generation, resumed.generation);

  lifecycle.requireReconciliation("unknown-request");
  assert.throws(
    () => lifecycle.resume(),
    (error) =>
      error instanceof R37OperatorLifecycleError
      && error.code === "R37_RECONCILIATION_REQUIRED"
      && error.details.automatic_replay === false,
  );
  assert.equal(lifecycle.snapshot().automatic_side_effect_replay, false);
});

test("R38 keeps one status surface for host/control/executor/relay/direct/reconciliation/authority", async () => {
  const lifecycle = new R37OperatorLifecycle({
    authoritySha: "relay-authority-sha",
    authorityVersion: "relay-authority-v1",
    probes: {
      nativeMcpHost: async () => ({ status: "RUNNING", available: true, version: "mcp-v1" }),
      controlService: async () => ({ status: "RUNNING", available: true, version: "control-v1" }),
      executor: async () => ({ status: "RUNNING", available: true, version: "executor-v1", sha: "executor-sha" }),
      githubRelayFallback: async () => ({ status: "RUNNING", available: true, version: "relay-v1" }),
      directLane: async () => ({ status: "PAUSED", available: true, version: "direct-v1" }),
      reconciliation: async () => ({ required: false }),
    },
    clock: () => 1000,
  });
  const status = await lifecycle.status();
  assert.equal(status.components.native_mcp_host.status, "RUNNING");
  assert.equal(status.components.control_service.status, "RUNNING");
  assert.equal(status.components.executor.status, "RUNNING");
  assert.equal(status.components.github_relay_fallback.status, "RUNNING");
  assert.equal(status.components.direct_lane.status, "PAUSED");
  assert.equal(status.reconciliation_required, false);
  assert.equal(status.authority.sha, "relay-authority-sha");
  assert.equal(status.authority.version, "relay-authority-v1");
  assert.equal(status.automatic_side_effect_replay, false);
});
