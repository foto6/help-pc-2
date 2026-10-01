import test from "node:test";
import assert from "node:assert/strict";
import {
  ControlPlane,
  FunctionProvider,
  HelpPc1Adapter,
  R23AdapterCircuitRegistry,
  R23HealthSupervisor,
  NativeRelayState,
  NativeRelayServer,
  NativeRelayExecutorProvider,
  R23_HEALTH_V1,
  R23_LAUNCHER_LIVENESS_V1,
  launcherLivenessDecision,
} from "../src/index.js";

function ids(prefix = "r23") {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

test("process alive with stale queue progress becomes UNHEALTHY", async () => {
  let now = 1_000;
  const snapshot = {
    queue: ["a-1"],
    actions: [{
      id: "a-1",
      correlationId: "req-1",
      status: "queued",
      executionAttempts: 0,
      reconciliationAttempts: 0,
      createdAtMs: 900,
      updatedAt: "2026-10-01T00:00:00.000Z",
    }],
  };
  const supervisor = new R23HealthSupervisor({
    clock: () => now,
    controlPlane: { snapshot: () => structuredClone(snapshot) },
    processAlive: () => true,
    staleProgressMs: 100,
    staleResultMs: 1_000,
    canaryTimeoutMs: 100,
    transportProbe: async () => ({
      process_alive: true,
      transport_connected: true,
      queue_progressing: true,
      executor_responsive: true,
      last_progress_at_ms: now,
      last_successful_result_at_ms: now,
    }),
  });
  await supervisor.probeTransport();
  await supervisor.runCanary({
    sessionId: "session-a",
    invoke: async ({ requestId }) => ({
      contract_version: "pc.native.response.v1",
      request_id: requestId,
      status: "completed",
      data: {},
    }),
  });
  supervisor.noteRequest();
  supervisor.noteResult();
  assert.equal(supervisor.snapshot().status, "HEALTHY");
  now += 101;
  const stale = supervisor.snapshot();
  assert.equal(stale.process_alive, true);
  assert.equal(stale.transport_connected, true);
  assert.equal(stale.queue_progressing, false);
  assert.equal(stale.status, "UNHEALTHY");
});

test("adapter circuit breaker isolates UIA timeout from shell and screenshot health", async () => {
  const registry = new R23AdapterCircuitRegistry({
    failureThreshold: 2,
    cooldownMs: 1_000,
    timeouts: { uia: 25, shell: 100, screenshot: 100 },
  });
  const hang = () => new Promise(() => {});
  for (let i = 0; i < 2; i += 1) {
    await assert.rejects(
      registry.run({
        action: "uia.snapshot",
        effect: "read_only",
        operation: hang,
      }),
      (error) => error.code === "ADAPTER_TIMEOUT"
        && error.dispatchState === "not_dispatched"
        && error.outcomeUncertain === false,
    );
  }
  await assert.rejects(
    registry.run({
      action: "uia.snapshot",
      effect: "read_only",
      operation: async () => "should-not-run",
    }),
    (error) => error.code === "ADAPTER_CIRCUIT_OPEN"
      && error.dispatchState === "not_dispatched",
  );
  assert.equal(await registry.run({
    action: "shell.run",
    effect: "read_only",
    operation: async () => "shell-ok",
  }), "shell-ok");
  assert.equal(await registry.run({
    action: "screenshot.capture",
    effect: "read_only",
    operation: async () => "screen-ok",
  }), "screen-ok");
  const health = registry.snapshot().adapters;
  assert.equal(health.uia.status, "UNHEALTHY");
  assert.equal(health.shell.status, "HEALTHY");
  assert.equal(health.screenshot.status, "HEALTHY");
});

test("timed-out side effect is UNKNOWN and breaker cannot authorize blind replay", async () => {
  const registry = new R23AdapterCircuitRegistry({
    failureThreshold: 1,
    cooldownMs: 5_000,
    timeouts: { uia: 25 },
  });
  await assert.rejects(
    registry.run({
      action: "uia.invoke",
      effect: "side_effect",
      operation: () => new Promise(() => {}),
    }),
    (error) => error.code === "ADAPTER_TIMEOUT"
      && error.dispatchState === "unknown"
      && error.outcomeUncertain === true
      && error.automaticReplay === false,
  );
  await assert.rejects(
    registry.run({
      action: "uia.invoke",
      effect: "side_effect",
      operation: async () => "must-not-dispatch",
    }),
    (error) => error.code === "ADAPTER_CIRCUIT_OPEN"
      && error.dispatchState === "not_dispatched"
      && error.automaticReplay === false,
  );
});

test("health canary exact lane cannot advance an earlier queued side effect", async () => {
  const calls = [];
  const provider = new FunctionProvider("synthetic", async (request) => {
    calls.push(request.tool);
    return { ok: true };
  });
  const cp = new ControlPlane({ providers: [provider], idFactory: ids("lane") });
  const session = cp.createSession({ desktopId: "desktop-r23" });
  const mutation = cp.enqueueAction(session.id, {
    provider: "synthetic",
    type: "mouse.move",
    input: { x: 10, y: 20 },
    metadata: { effect: "side_effect" },
  });
  const canary = cp.enqueueAction(session.id, {
    provider: "synthetic",
    type: "health.get",
    permission: "desktop.observe",
    metadata: { effect: "read_only" },
  });
  const result = await cp.processSpecificReadOnly(canary.id);
  assert.equal(result.status, "succeeded");
  assert.deepEqual(calls, ["health.get"]);
  assert.equal(cp.getAction(mutation.id).status, "queued");
  assert.equal(cp.getAction(canary.id).status, "succeeded");
});

test("restart after a timed-out side effect reconciles journal evidence without a second execute", async () => {
  let invokes = 0;
  let evidenceReads = 0;
  const governor = new R23AdapterCircuitRegistry({
    failureThreshold: 1,
    cooldownMs: 5_000,
    timeouts: { input: 25, outcome_journal: 100 },
  });
  const adapter = new HelpPc1Adapter({
    dryRun: false,
    healthGovernor: governor,
    invoke: async (_request, context) => {
      invokes += 1;
      return new Promise((_resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(
          Object.assign(new Error("aborted after dispatch"), { code: "CANCELLED" }),
        ), { once: true });
      });
    },
    readEvidence: async (request) => {
      evidenceReads += 1;
      return {
        outcome: "succeeded",
        source: "synthetic-journal",
        requestId: request.request_id,
        result: {
          request_id: request.request_id,
          action: request.action,
          ok: true,
          status: "completed",
          data: { reconciled: true },
          dry_run: false,
        },
      };
    },
  });
  const cp1 = new ControlPlane({ providers: [adapter], idFactory: ids("crash") });
  const session = cp1.createSession({ desktopId: "desktop-r23" });
  const action = cp1.enqueueAction(session.id, {
    provider: "help-pc-1",
    type: "mouse.click",
    input: { x: 1, y: 1 },
    correlationId: "side-effect-r23",
    idempotencyKey: "side-effect-r23",
    maxReconciliationAttempts: 2,
    metadata: { effect: "side_effect" },
  });
  const first = await cp1.processNext();
  assert.equal(first.status, "uncertain_outcome");
  assert.equal(invokes, 1);

  const cp2 = new ControlPlane({
    providers: [adapter],
    snapshot: cp1.snapshot(),
    idFactory: ids("reboot"),
  });
  const reconciled = await cp2.processNext();
  assert.equal(invokes, 1, "restart/reconcile must not execute the mutation again");
  assert.equal(evidenceReads, 1);
  assert.equal(reconciled.status, "succeeded");
  assert.ok(reconciled.reconciliationAttempts >= 1);
  assert.equal(cp2.getAction(action.id).executionAttempts, 1);
  assert.equal(cp2.getActionStatus(action.id).lifecycle.lifecycle_state, "reconciled");
});

test("journal corruption is independently health-fatal without poisoning unrelated adapters", async () => {
  const circuits = new R23AdapterCircuitRegistry();
  circuits.markHealthy("shell", 2);
  circuits.markHealthy("screenshot", 3);
  circuits.markJournalIntegrity("CORRUPT", "EXECUTOR_JOURNAL_BINDING_MISMATCH");
  const supervisor = new R23HealthSupervisor({
    circuitRegistry: circuits,
    processAlive: () => true,
    transportProbe: async () => ({
      process_alive: true,
      transport_connected: true,
      queue_progressing: true,
      executor_responsive: true,
    }),
  });
  await supervisor.probeTransport();
  await supervisor.runCanary({
    sessionId: "journal",
    invoke: async ({ requestId }) => ({ request_id: requestId, status: "completed" }),
  });
  const health = supervisor.snapshot();
  assert.equal(health.contract_version, R23_HEALTH_V1);
  assert.equal(health.status, "UNHEALTHY");
  assert.equal(health.outcome_journal_integrity.status, "CORRUPT");
  assert.equal(health.per_adapter_health.shell.status, "HEALTHY");
  assert.equal(health.per_adapter_health.screenshot.status, "HEALTHY");
});

test("launcher liveness contract never equates PID existence with health", () => {
  const healthy = {
    contract_version: R23_HEALTH_V1,
    status: "HEALTHY",
  };
  const degraded = {
    contract_version: R23_HEALTH_V1,
    status: "DEGRADED",
  };
  const cases = [
    [{ processExists: true, health: degraded }, "RECOVERY_REQUIRED", "FRESHNESS_HANDSHAKE_FAILED"],
    [{ processExists: true, pidIdentityCurrent: false, health: healthy }, "RECOVERY_REQUIRED", "STALE_PID_IDENTITY"],
    [{ processExists: true, duplicateProcess: true, health: healthy }, "RECOVERY_REQUIRED", "DUPLICATE_PROCESS"],
    [{ processExists: true, relayResponsive: false, health: degraded }, "RECOVERY_REQUIRED", "RELAY_UNRESPONSIVE"],
    [{ processExists: true, executorPresent: false, health: degraded }, "RECOVERY_REQUIRED", "EXECUTOR_ABSENT"],
    [{ processExists: true, health: degraded, startupDeadlineExceeded: true }, "RECOVERY_REQUIRED", "STARTUP_CONVERGENCE_TIMEOUT"],
    [{ processExists: true, health: degraded, networkAvailable: false }, "RECOVERY_REQUIRED", "NETWORK_UNAVAILABLE"],
    [{ processExists: true, health: degraded, transportReady: false }, "RECOVERY_REQUIRED", "TRANSPORT_NOT_CONVERGED"],
    [{ processExists: true, health: degraded, journalState: "corrupt" }, "RECOVERY_REQUIRED", "JOURNAL_CORRUPT"],
    [{ processExists: false, health: degraded }, "STOPPED", "PROCESS_ABSENT"],
  ];
  for (const [input, state, reason] of cases) {
    const decision = launcherLivenessDecision(input);
    assert.equal(decision.contract_version, R23_LAUNCHER_LIVENESS_V1);
    assert.equal(decision.state, state);
    assert.equal(decision.already_running_healthy, false);
    assert.ok(decision.reasons.includes(reason));
    assert.equal(decision.recovery.kill_existing_process, false);
    assert.equal(decision.recovery.restart_live_stack, false);
    assert.equal(decision.recovery.automatic_replay, false);
  }
  const ok = launcherLivenessDecision({ processExists: true, health: healthy });
  assert.equal(ok.state, "HEALTHY");
  assert.equal(ok.already_running_healthy, true);
});


test("relay process-alive health degrades when an active delivery stops progressing", async (t) => {
  let now = 10_000;
  const state = new NativeRelayState({ clock: () => now });
  const server = new NativeRelayServer({
    state,
    controlToken: "r23-relay-health-control-token-0123456789",
    heartbeatTimeoutMs: 100,
    clock: () => now,
  });
  const started = await server.start();
  t.after(() => server.stop());
  assert.ok(started.url);

  state.createDelivery({
    deviceId: "device-r23",
    requestId: "request-stalled",
    requestVersion: "pc.native.control.v1",
    deliveryId: "delivery-stalled",
    semantics: "read_only",
    fingerprint: "fingerprint-stalled",
    sessionEpoch: "epoch-r23",
  });
  const fresh = server.health();
  assert.equal(fresh.process_alive, true);
  assert.equal(fresh.queue_progressing, true);
  assert.equal(fresh.status, "ok");

  now += 101;
  const stale = server.health();
  assert.equal(stale.process_alive, true);
  assert.equal(stale.pending_deliveries, 1);
  assert.equal(stale.queue_progressing, false);
  assert.equal(stale.oldest_pending_age_ms, 101);
  assert.equal(stale.status, "degraded");
});

test("relay provider exposes process/transport/queue health without dispatching a native request", async (t) => {
  const state = new NativeRelayState();
  const token = "r23-relay-probe-control-token-01234567890123";
  const server = new NativeRelayServer({ state, controlToken: token });
  const started = await server.start();
  t.after(() => server.stop());

  const provider = new NativeRelayExecutorProvider({
    relayUrl: started.url,
    relayToken: token,
    deviceId: "device-not-connected",
    desktopId: "desktop-r23",
  });
  const health = await provider.readTransportHealth();
  assert.equal(health.contract_version, "pc.native.relay.health.v1");
  assert.equal(health.process_alive, true);
  assert.equal(health.transport_connected, false);
  assert.equal(health.queue_progressing, true);
  assert.equal(health.executor_responsive, false);
  assert.equal(health.pending_deliveries, 0);
});
