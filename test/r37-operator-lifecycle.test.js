import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ControlPlane,
  HelpPc1Adapter,
  NativeControlFacade,
  NativeMcpRuntime,
  TOOL_REGISTRY,
} from "../src/index.js";
import {
  JsonR37OperatorLifecycleStore,
  R37_CUTOVER_READINESS_V1,
  R37_DIRECT_HOST_REHEARSAL_V1,
  R37_OPERATOR_LIFECYCLE_V1,
  R37_PINNED_AUTHORITY_SHA,
  R37_PINNED_AUTHORITY_VERSION,
  R37_STATES,
  R37OperatorLifecycle,
  R37OperatorLifecycleError,
  evaluateR37CutoverReadiness,
  evaluateR37DirectHostRehearsal,
} from "../src/r37-operator-lifecycle.js";

function tempState() {
  const dir = mkdtempSync(join(tmpdir(), "pc-r37-"));
  const path = join(dir, "operator-lifecycle-r37.json");
  return {
    dir,
    path,
    store: new JsonR37OperatorLifecycleStore(path),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function lifecycle(options = {}) {
  let now = options.now ?? 1_000;
  const instance = new R37OperatorLifecycle({
    store: options.store ?? null,
    authoritySha: options.authoritySha ?? "authority-sha",
    authorityVersion: options.authorityVersion ?? "relay-v1",
    probes: options.probes ?? {},
    clock: () => now,
  });
  return {
    instance,
    tick(value = 1) { now += value; },
  };
}

function component(status = "RUNNING", available = true, version = "v1") {
  return { status, available, version };
}

function allProbes(overrides = {}) {
  return {
    nativeMcpHost: async () => component("RUNNING", true, "mcp-v1"),
    controlService: async () => component("RUNNING", true, "control-v1"),
    executor: async () => ({ ...component("RUNNING", true, "executor-v1"), sha: "executor-sha" }),
    githubRelayFallback: async () => component("RUNNING", true, "relay-v1"),
    directLane: async () => component("RUNNING", true, "direct-v1"),
    reconciliation: async () => ({ required: false }),
    ...overrides,
  };
}

function rehearsal(overrides = {}) {
  return {
    actual_direct_host_run: true,
    relay_fallback_enabled: false,
    direct_host_available: true,
    read_only_status: "completed",
    reversible_operation_status: "completed",
    rollback_status: "completed",
    fixture_restored: true,
    automatic_replay: false,
    ...overrides,
  };
}

test("R37 contract version is exact", () => {
  assert.equal(R37_OPERATOR_LIFECYCLE_V1, "native_mcp.operator_lifecycle.r37.v1");
});

test("R37 exposes exactly the required operator states", () => {
  assert.deepEqual(R37_STATES, [
    "RUNNING",
    "PAUSED",
    "DRAINING",
    "RECONCILIATION_REQUIRED",
  ]);
});

test("R37 default lifecycle starts RUNNING without cutover or replay authority", () => {
  const h = lifecycle();
  const state = h.instance.snapshot();
  assert.equal(state.operator_state, "RUNNING");
  assert.equal(state.automatic_side_effect_replay, false);
  assert.equal(state.live_pc_control_cutover, false);
  assert.equal(state.authority.lane, "github_relay");
});

test("R37 one status snapshot reports every required component and authority", async () => {
  const h = lifecycle({ probes: allProbes() });
  const status = await h.instance.status();
  assert.equal(status.contract_version, R37_OPERATOR_LIFECYCLE_V1);
  assert.equal(status.operator_state, "RUNNING");
  assert.equal(status.components.native_mcp_host.status, "RUNNING");
  assert.equal(status.components.control_service.status, "RUNNING");
  assert.equal(status.components.executor.status, "RUNNING");
  assert.equal(status.components.github_relay_fallback.status, "RUNNING");
  assert.equal(status.components.direct_lane.available, true);
  assert.equal(status.reconciliation_required, false);
  assert.equal(status.authority.sha, "authority-sha");
  assert.equal(status.authority.version, "relay-v1");
  assert.equal(status.components.github_relay_fallback.current_authority, true);
});

test("R37 status digest is deterministic for fixed state and probes", async () => {
  const a = lifecycle({ probes: allProbes(), now: 1000 });
  const b = lifecycle({ probes: allProbes(), now: 1000 });
  assert.equal((await a.instance.status()).status_digest, (await b.instance.status()).status_digest);
});

test("R37 pause transitions RUNNING to PAUSED", () => {
  const h = lifecycle();
  const state = h.instance.pause("maintenance");
  assert.equal(state.operator_state, "PAUSED");
  assert.equal(state.pause_reason, "maintenance");
});

test("R37 pause is idempotent", () => {
  const h = lifecycle();
  const first = h.instance.pause("maintenance");
  const second = h.instance.pause("maintenance");
  assert.equal(second.generation, first.generation);
});

test("R37 PAUSED preserves read-only admission", () => {
  const h = lifecycle();
  h.instance.pause("maintenance");
  assert.equal(h.instance.assertSideEffectAdmission({ effect: "read_only" }), true);
});

test("R37 PAUSED blocks side-effect dispatch", () => {
  const h = lifecycle();
  h.instance.pause("maintenance");
  assert.throws(
    () => h.instance.assertSideEffectAdmission({ effect: "side_effect", requestId: "r1" }),
    (error) => error.code === "R37_SIDE_EFFECT_DISPATCH_PAUSED" && error.state === "PAUSED",
  );
});

test("R37 drain transitions RUNNING to DRAINING", () => {
  const h = lifecycle();
  assert.equal(h.instance.drain().operator_state, "DRAINING");
});

test("R37 drain is idempotent", () => {
  const h = lifecycle();
  const first = h.instance.drain();
  const second = h.instance.drain();
  assert.equal(second.generation, first.generation);
});

test("R37 DRAINING blocks new side-effect dispatch", () => {
  const h = lifecycle();
  h.instance.drain();
  assert.throws(
    () => h.instance.assertSideEffectAdmission({ effect: "side_effect" }),
    (error) => error.code === "R37_SIDE_EFFECT_DISPATCH_PAUSED" && error.state === "DRAINING",
  );
});

test("R37 resume explicitly transitions PAUSED to RUNNING", () => {
  const h = lifecycle();
  h.instance.pause("maintenance");
  assert.equal(h.instance.resume().operator_state, "RUNNING");
});

test("R37 resume is idempotent in RUNNING", () => {
  const h = lifecycle();
  const before = h.instance.snapshot();
  const after = h.instance.resume();
  assert.equal(after.generation, before.generation);
});

test("R37 requireReconciliation enters RECONCILIATION_REQUIRED", () => {
  const h = lifecycle();
  const state = h.instance.requireReconciliation("req-1");
  assert.equal(state.operator_state, "RECONCILIATION_REQUIRED");
  assert.equal(state.reconciliation.required, true);
  assert.deepEqual(state.reconciliation.request_ids, ["req-1"]);
});

test("R37 reconciliation request ids are deduplicated", () => {
  const h = lifecycle();
  const first = h.instance.requireReconciliation("req-1");
  const second = h.instance.requireReconciliation("req-1");
  assert.equal(second.generation, first.generation);
  assert.deepEqual(second.reconciliation.request_ids, ["req-1"]);
});

test("R37 reconciliation request ids are stable and sorted", () => {
  const h = lifecycle();
  h.instance.requireReconciliation("req-b");
  const state = h.instance.requireReconciliation("req-a");
  assert.deepEqual(state.reconciliation.request_ids, ["req-a", "req-b"]);
});

test("R37 reconciliation state blocks side-effect dispatch", () => {
  const h = lifecycle();
  h.instance.requireReconciliation("req-1");
  assert.throws(
    () => h.instance.assertSideEffectAdmission({ effect: "side_effect", requestId: "req-2" }),
    (error) => error.code === "R37_RECONCILIATION_REQUIRED",
  );
});

test("R37 resume refuses unknown side effects and never authorizes replay", () => {
  const h = lifecycle();
  h.instance.requireReconciliation("req-unknown");
  assert.throws(
    () => h.instance.resume(),
    (error) => error.code === "R37_RECONCILIATION_REQUIRED"
      && error.details.automatic_replay === false,
  );
});

test("R37 clearing one of several reconciliations stays blocked", () => {
  const h = lifecycle();
  h.instance.requireReconciliation("req-a");
  h.instance.requireReconciliation("req-b");
  const state = h.instance.clearReconciliation("req-a");
  assert.equal(state.operator_state, "RECONCILIATION_REQUIRED");
  assert.deepEqual(state.reconciliation.request_ids, ["req-b"]);
});

test("R37 clearing final reconciliation moves to PAUSED not RUNNING", () => {
  const h = lifecycle();
  h.instance.requireReconciliation("req-a");
  const state = h.instance.clearReconciliation("req-a");
  assert.equal(state.operator_state, "PAUSED");
  assert.equal(state.reconciliation.required, false);
});

test("R37 requires explicit resume after reconciliation is cleared", () => {
  const h = lifecycle();
  h.instance.requireReconciliation("req-a");
  h.instance.clearReconciliation("req-a");
  assert.throws(
    () => h.instance.assertSideEffectAdmission({ effect: "side_effect" }),
    (error) => error.code === "R37_SIDE_EFFECT_DISPATCH_PAUSED",
  );
  assert.equal(h.instance.resume().operator_state, "RUNNING");
});

test("R37 lifecycle state persists PAUSED across cold restart", () => {
  const t = tempState();
  try {
    const first = lifecycle({ store: t.store });
    first.instance.pause("reboot-test");
    const restarted = lifecycle({ store: new JsonR37OperatorLifecycleStore(t.path) });
    assert.equal(restarted.instance.snapshot().operator_state, "PAUSED");
    assert.equal(restarted.instance.snapshot().pause_reason, "reboot-test");
  } finally {
    t.cleanup();
  }
});

test("R37 reconciliation requirement persists across cold restart", () => {
  const t = tempState();
  try {
    const first = lifecycle({ store: t.store });
    first.instance.requireReconciliation("req-reboot");
    const restarted = lifecycle({ store: new JsonR37OperatorLifecycleStore(t.path) });
    assert.equal(restarted.instance.snapshot().operator_state, "RECONCILIATION_REQUIRED");
    assert.deepEqual(restarted.instance.snapshot().reconciliation.request_ids, ["req-reboot"]);
  } finally {
    t.cleanup();
  }
});

test("R37 corrupted state fails closed on cold start", () => {
  const t = tempState();
  try {
    writeFileSync(t.path, "{not-json", "utf8");
    assert.throws(
      () => lifecycle({ store: new JsonR37OperatorLifecycleStore(t.path) }),
      (error) => error.code === "R37_STATE_CORRUPTED",
    );
  } finally {
    t.cleanup();
  }
});

test("R37 wrong persisted contract version fails closed", () => {
  const t = tempState();
  try {
    const first = lifecycle({ store: t.store });
    const state = first.instance.snapshot();
    state.contract_version = "native_mcp.operator_lifecycle.r38.v1";
    writeFileSync(t.path, JSON.stringify(state), "utf8");
    assert.throws(
      () => lifecycle({ store: new JsonR37OperatorLifecycleStore(t.path) }),
      (error) => error.code === "R37_STATE_CORRUPTED",
    );
  } finally {
    t.cleanup();
  }
});

test("R37 authority SHA and version persist across restart", () => {
  const t = tempState();
  try {
    lifecycle({
      store: t.store,
      authoritySha: "sha-r37",
      authorityVersion: "relay-r37",
    });
    const restarted = lifecycle({ store: new JsonR37OperatorLifecycleStore(t.path) });
    assert.equal(restarted.instance.snapshot().authority.sha, "sha-r37");
    assert.equal(restarted.instance.snapshot().authority.version, "relay-r37");
  } finally {
    t.cleanup();
  }
});

test("R37 probe failures remain read-only and surface UNKNOWN", async () => {
  const error = new Error("no host");
  error.code = "HOST_DOWN";
  const h = lifecycle({
    probes: allProbes({
      directLane: async () => { throw error; },
    }),
  });
  const status = await h.instance.status();
  assert.equal(status.components.direct_lane.status, "UNKNOWN");
  assert.equal(status.components.direct_lane.available, false);
  assert.equal(status.components.direct_lane.detail, "HOST_DOWN");
});

test("R37 external reconciliation probe projects RECONCILIATION_REQUIRED without replay", async () => {
  const h = lifecycle({
    probes: allProbes({
      reconciliation: async () => ({ required: true }),
    }),
  });
  const status = await h.instance.status();
  assert.equal(status.operator_state, "RECONCILIATION_REQUIRED");
  assert.equal(status.reconciliation_required, true);
  assert.equal(status.automatic_side_effect_replay, false);
});

test("R37 direct-host unavailable rehearsal fails closed with exact blocker", () => {
  const result = evaluateR37DirectHostRehearsal({
    actual_direct_host_run: false,
    relay_fallback_enabled: false,
    direct_host_available: false,
    automatic_replay: false,
    blocker_code: "DIRECT_HOST_MACHINE_OFFLINE",
  });
  assert.equal(result.contract_version, R37_DIRECT_HOST_REHEARSAL_V1);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.blockers[0].code, "DIRECT_HOST_MACHINE_OFFLINE");
});

test("R37 rehearsal rejects enabled relay fallback", () => {
  const result = evaluateR37DirectHostRehearsal(rehearsal({
    relay_fallback_enabled: true,
  }));
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.blockers.some((b) => b.code === "RELAY_FALLBACK_NOT_DISABLED"), true);
});

test("R37 rehearsal requires live direct-host provenance", () => {
  const result = evaluateR37DirectHostRehearsal(rehearsal({
    actual_direct_host_run: false,
  }));
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.blockers.some((b) => b.code === "LIVE_DIRECT_HOST_RUN_NOT_PROVEN"), true);
});

test("R37 rehearsal requires read-only request proof", () => {
  const result = evaluateR37DirectHostRehearsal(rehearsal({
    read_only_status: "failed",
  }));
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.blockers.some((b) => b.code === "DIRECT_READ_ONLY_REQUEST_NOT_PROVEN"), true);
});

test("R37 rehearsal requires reversible mutation proof", () => {
  const result = evaluateR37DirectHostRehearsal(rehearsal({
    reversible_operation_status: "failed",
  }));
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.blockers.some((b) => b.code === "REVERSIBLE_LOCAL_OPERATION_NOT_PROVEN"), true);
});

test("R37 rehearsal requires rollback and fixture restoration", () => {
  const result = evaluateR37DirectHostRehearsal(rehearsal({
    rollback_status: "failed",
    fixture_restored: false,
  }));
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.blockers.some((b) => b.code === "REVERSIBLE_OPERATION_ROLLBACK_NOT_PROVEN"), true);
});

test("R37 rehearsal passes only complete direct proof with fallback disabled", () => {
  const result = evaluateR37DirectHostRehearsal(rehearsal());
  assert.equal(result.status, "PASS");
  assert.equal(result.blockers.length, 0);
  assert.equal(result.production_cutover_performed, false);
});

test("R37 cutover readiness stays blocked on blocked rehearsal", async () => {
  const h = lifecycle({ probes: allProbes() });
  const status = await h.instance.status();
  const direct = evaluateR37DirectHostRehearsal({
    actual_direct_host_run: false,
    relay_fallback_enabled: false,
    direct_host_available: false,
    automatic_replay: false,
    blocker_code: "DIRECT_HOST_MACHINE_OFFLINE",
  });
  const result = evaluateR37CutoverReadiness({
    lifecycleStatus: status,
    directHostRehearsal: direct,
    sourceSha: "source",
    ciConclusion: "success",
  });
  assert.equal(result.contract_version, R37_CUTOVER_READINESS_V1);
  assert.equal(result.cutover_ready, false);
  assert.equal(result.current_authority, "github_relay");
});

test("R37 cutover readiness never changes authority automatically", async () => {
  const h = lifecycle({ probes: allProbes() });
  const result = evaluateR37CutoverReadiness({
    lifecycleStatus: await h.instance.status(),
    directHostRehearsal: evaluateR37DirectHostRehearsal(rehearsal()),
    sourceSha: "source",
    ciConclusion: "success",
  });
  assert.equal(result.cutover_ready, true);
  assert.equal(result.current_authority_changed, false);
  assert.equal(result.production_cutover_performed, false);
});

function success(req, data = {}) {
  return {
    request_id: req.request_id,
    action: req.action,
    ok: true,
    status: "completed",
    dry_run: false,
    data,
    started_at: "2026-10-06T00:00:00Z",
    finished_at: "2026-10-06T00:00:01Z",
    error: null,
    error_kind: null,
  };
}

async function facadeFixture(operatorLifecycle) {
  const state = { effectCalls: 0, readOnlyCalls: 0 };
  const controlPlane = new ControlPlane({
    providers: [new HelpPc1Adapter({
      dryRun: false,
      invoke: async (req) => {
        if (req.action === "fs.write_text") state.effectCalls += 1;
        else state.readOnlyCalls += 1;
        return success(req, { ok: true });
      },
    })],
  });
  const facade = new NativeControlFacade({
    controlPlane,
    capabilityProvider: async () => ({
      contract_version: "pc_executor.capabilities.v1",
      digest: "r37-executor",
      actions: ["fs.write_text", "health.get"],
    }),
    operatorLifecycle,
  });
  const runtime = await NativeMcpRuntime.create({
    facade,
    desktopId: "r37-desktop",
  });
  return { state, controlPlane, facade, runtime };
}

const ctx = () => ({ mcpReq: { id: 3701 } });

test("R37 PAUSED facade still allows read-only device.ping", async (t) => {
  const h = lifecycle();
  h.instance.pause("operator");
  const f = await facadeFixture(h.instance);
  t.after(() => f.runtime.close());
  const result = await f.runtime.callNativeTool(TOOL_REGISTRY["device.ping"], {}, ctx());
  assert.equal(result.structuredContent.status, "completed");
  assert.equal(f.state.effectCalls, 0);
  assert.equal(f.state.readOnlyCalls, 1);
});

test("R37 PAUSED facade blocks a new side-effect before provider invocation", async (t) => {
  const h = lifecycle();
  h.instance.pause("operator");
  const f = await facadeFixture(h.instance);
  t.after(() => f.runtime.close());
  const result = await f.runtime.callNativeTool(TOOL_REGISTRY["file.write"], {
    request_id: "r37-paused-new",
    path: "C:\\Temp\\r37-paused.txt",
    text: "test",
  }, ctx());
  assert.equal(result.structuredContent.status, "error");
  assert.equal(result.structuredContent.error.code, "R37_SIDE_EFFECT_DISPATCH_PAUSED");
  assert.equal(f.state.effectCalls, 0);
});

test("R37 explicit resume enables a later new side effect", async (t) => {
  const h = lifecycle();
  h.instance.pause("operator");
  h.instance.resume();
  const f = await facadeFixture(h.instance);
  t.after(() => f.runtime.close());
  const result = await f.runtime.callNativeTool(TOOL_REGISTRY["file.write"], {
    request_id: "r37-resumed",
    path: "C:\\Temp\\r37-resumed.txt",
    text: "test",
  }, ctx());
  assert.equal(result.structuredContent.status, "completed");
  assert.equal(f.state.effectCalls, 1);
});

test("R37 completed duplicate remains cached after pause without replay", async (t) => {
  const h = lifecycle();
  const f = await facadeFixture(h.instance);
  t.after(() => f.runtime.close());
  const args = {
    request_id: "r37-duplicate",
    path: "C:\\Temp\\r37-duplicate.txt",
    text: "once",
  };
  const first = await f.runtime.callNativeTool(TOOL_REGISTRY["file.write"], args, ctx());
  assert.equal(first.structuredContent.status, "completed");
  assert.equal(f.state.effectCalls, 1);
  h.instance.pause("operator");
  const duplicate = await f.runtime.callNativeTool(TOOL_REGISTRY["file.write"], args, ctx());
  assert.equal(duplicate.structuredContent.status, "completed");
  assert.equal(f.state.effectCalls, 1);
});

test("R37 reconciliation-required facade blocks new side effect", async (t) => {
  const h = lifecycle();
  h.instance.requireReconciliation("unknown-1");
  const f = await facadeFixture(h.instance);
  t.after(() => f.runtime.close());
  const result = await f.runtime.callNativeTool(TOOL_REGISTRY["file.write"], {
    request_id: "r37-after-unknown",
    path: "C:\\Temp\\r37-never.txt",
    text: "never",
  }, ctx());
  assert.equal(result.structuredContent.status, "error");
  assert.equal(result.structuredContent.error.code, "R37_RECONCILIATION_REQUIRED");
  assert.equal(f.state.effectCalls, 0);
});

test("R37 DRAINING facade blocks a new side effect", async (t) => {
  const h = lifecycle();
  h.instance.drain();
  const f = await facadeFixture(h.instance);
  t.after(() => f.runtime.close());
  const result = await f.runtime.callNativeTool(TOOL_REGISTRY["file.write"], {
    request_id: "r37-draining",
    path: "C:\\Temp\\r37-never-draining.txt",
    text: "never",
  }, ctx());
  assert.equal(result.structuredContent.status, "error");
  assert.equal(result.structuredContent.error.code, "R37_SIDE_EFFECT_DISPATCH_PAUSED");
  assert.equal(f.state.effectCalls, 0);
});

test("R37 persisted PAUSED state is honored by a cold-start facade", async (t) => {
  const state = tempState();
  t.after(state.cleanup);
  const first = lifecycle({ store: state.store });
  first.instance.pause("reboot");
  const restarted = lifecycle({
    store: new JsonR37OperatorLifecycleStore(state.path),
  });
  const f = await facadeFixture(restarted.instance);
  t.after(() => f.runtime.close());
  const result = await f.runtime.callNativeTool(TOOL_REGISTRY["file.write"], {
    request_id: "r37-cold-start",
    path: "C:\\Temp\\r37-never-cold.txt",
    text: "never",
  }, ctx());
  assert.equal(result.structuredContent.status, "error");
  assert.equal(f.state.effectCalls, 0);
});

test("R37 blocked rehearsal fixture records the actual direct-host blocker", () => {
  const fixture = JSON.parse(readFileSync(
    new URL("../conformance/r37_operator_lifecycle/direct-host-rehearsal.blocked.json", import.meta.url),
    "utf8",
  ));
  assert.equal(fixture.contract_version, R37_DIRECT_HOST_REHEARSAL_V1);
  assert.equal(fixture.actual_direct_host_run, false);
  assert.equal(fixture.relay_fallback_enabled, false);
  assert.equal(fixture.direct_host_available, false);
  assert.equal(fixture.blocker_code, "DIRECT_HOST_MACHINE_OFFLINE");
  assert.equal(fixture.current_authority, "github_relay");
  assert.equal(fixture.production_cutover_performed, false);
});


test("R37 frozen relay authority pin matches lifecycle defaults", () => {
  const pin = JSON.parse(readFileSync(
    new URL("../conformance/r37_operator_lifecycle/authority-pin.json", import.meta.url),
    "utf8",
  ));
  assert.equal(pin.current_authority, "github_relay");
  assert.equal(pin.relay_producer_pin.sha, R37_PINNED_AUTHORITY_SHA);
  assert.equal(pin.relay_producer_pin.version, R37_PINNED_AUTHORITY_VERSION);
  const state = new R37OperatorLifecycle().snapshot();
  assert.equal(state.authority.sha, R37_PINNED_AUTHORITY_SHA);
  assert.equal(state.authority.version, R37_PINNED_AUTHORITY_VERSION);
  assert.equal(state.authority.verified, true);
});

test("R37 one-command CLI status reports full operator surface", () => {
  const t = tempState();
  try {
    const run = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../tools/r37-operator-lifecycle.js", import.meta.url)),
        "status",
        "--state-file",
        t.path,
      ],
      { encoding: "utf8" },
    );
    assert.equal(run.status, 0, run.stderr);
    const status = JSON.parse(run.stdout);
    assert.equal(status.contract_version, R37_OPERATOR_LIFECYCLE_V1);
    assert.equal(status.operator_state, "RUNNING");
    assert.equal(Object.hasOwn(status.components, "native_mcp_host"), true);
    assert.equal(Object.hasOwn(status.components, "control_service"), true);
    assert.equal(Object.hasOwn(status.components, "executor"), true);
    assert.equal(Object.hasOwn(status.components, "github_relay_fallback"), true);
    assert.equal(Object.hasOwn(status.components, "direct_lane"), true);
    assert.equal(status.reconciliation_required, false);
    assert.equal(status.authority.sha, R37_PINNED_AUTHORITY_SHA);
    assert.equal(status.authority.version, R37_PINNED_AUTHORITY_VERSION);
  } finally {
    t.cleanup();
  }
});
