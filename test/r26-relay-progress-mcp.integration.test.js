import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import {
  ControlPlane,
  HelpPc1Adapter,
  NativeControlFacade,
  NativeMcpRuntime,
  R23AdapterCircuitRegistry,
  R23HealthSupervisor,
  R26_PRODUCER_PIN,
  R26RelayProgressConsumer,
  TOOL_REGISTRY_LIST,
  startNativeMcpHttpServer,
} from "../src/index.js";

const TOKEN = "r26-relay-progress-token-0123456789abcdef012345";
const fixtureUrl = new URL(
  "../conformance/r26_relay_progress_v1/progress.example.json",
  import.meta.url,
);

function progressFixture() {
  const value = JSON.parse(readFileSync(fixtureUrl, "utf8"));
  value.source.branch = R26_PRODUCER_PIN.branch;
  value.source.startup_head = R26_PRODUCER_PIN.sha;
  value.source.relay_script_sha256 = R26_PRODUCER_PIN.relay_script_sha256;
  return value;
}

function livenessFor(progress, state = "healthy_progressing", observed_pids = [progress.process.pid]) {
  const probe = progress.recorded_at_unix + 1;
  const cycleBase = progress.last_successful_cycle_at_unix ?? progress.process.started_at_unix;
  const reasons = {
    healthy_progressing: "cycle_and_queue_progress_within_bound",
    alive_stalled: "pending_queue_has_no_result_progress",
    duplicate_processes_ambiguous: "multiple_matching_relay_processes",
  };
  return {
    contract_version: "pc_relay.liveness_probe.v1",
    state,
    reason: reasons[state] ?? "synthetic_exact_schema_state",
    observed_pids,
    progress_age_seconds: probe - progress.recorded_at_unix,
    queue_progress_age_seconds: probe - progress.queue.last_progress_at_unix,
    successful_cycle_age_seconds: probe - cycleBase,
    consecutive_cycle_failures: progress.consecutive_cycle_failures,
    pending_count: progress.queue.pending_count,
    loop_generation_id: progress.loop_generation_id,
    loop_epoch: progress.loop_epoch,
    process_pid: progress.process.pid,
    last_error_classification: progress.last_error?.classification ?? null,
  };
}

function success(request, data = {}) {
  return {
    request_id: request.request_id,
    action: request.action,
    ok: true,
    status: "completed",
    started_at: "2026-10-01T00:00:00.000Z",
    finished_at: "2026-10-01T00:00:00.001Z",
    data,
    error: null,
    error_kind: null,
    dry_run: request.dry_run,
  };
}

function structured(result) {
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  const text = result.content?.find((item) => item.type === "text")?.text;
  return text ? JSON.parse(text) : null;
}

test("MCP blocks mutations on degraded R26 relay health while read-only diagnostics remain available", async (t) => {
  const progress = progressFixture();
  const now = (progress.recorded_at_unix + 2) * 1000;
  let probePayload = {
    progress,
    liveness: livenessFor(progress, "alive_stalled"),
    pending_unknown_effects: 0,
  };
  const calls = [];

  const adapter = new HelpPc1Adapter({
    dryRun: false,
    invoke: async (request) => {
      calls.push(request.action);
      if (request.action === "window.list") return success(request, { windows: [] });
      if (request.action === "shell.run") return success(request, { exit_code: 0, stdout: "ok" });
      if (["system.health", "health.get"].includes(request.action)) {
        return success(request, { status: "ok" });
      }
      throw new Error("unexpected action " + request.action);
    },
  });
  const controlPlane = new ControlPlane({ providers: [adapter] });
  const facade = new NativeControlFacade({
    controlPlane,
    capabilityProvider: async () => ({
      contract_version: "pc_executor.capabilities.v1",
      digest: "r26-relay-progress-executor",
      actions: [...new Set(TOOL_REGISTRY_LIST.map((tool) => tool.executorAction))],
    }),
  });
  const consumer = new R26RelayProgressConsumer({
    clock: () => now,
    maxEvidenceAgeMs: 5_000,
  });
  const supervisor = new R23HealthSupervisor({
    clock: () => now,
    controlPlane,
    circuitRegistry: new R23AdapterCircuitRegistry({ clock: () => now }),
    relayProgressConsumer: consumer,
    relayProgressProbe: async () => structuredClone(probePayload),
  });
  const runtime = await NativeMcpRuntime.create({
    facade,
    desktopId: "desktop-r26-progress",
    healthSupervisor: supervisor,
  });
  const http = await startNativeMcpHttpServer({ runtime, token: TOKEN, port: 0 });
  t.after(async () => {
    await http.close();
    await runtime.close();
  });

  const transport = new StreamableHTTPClientTransport(new URL(http.url), {
    authProvider: { token: async () => TOKEN },
  });
  const client = new Client(
    { name: "r26-relay-progress-test", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  t.after(() => client.close());
  await client.connect(transport);

  const readOnly = structured(await client.callTool({
    name: "window.list",
    arguments: { request_id: "r26-window-stalled" },
  }));
  assert.equal(readOnly.status, "completed");
  assert.equal(calls.filter((action) => action === "window.list").length, 1);

  const shellBefore = calls.filter((action) => action === "shell.run").length;
  const blocked = structured(await client.callTool({
    name: "shell.run",
    arguments: { request_id: "r26-shell-stalled", command: "synthetic" },
  }));
  assert.equal(blocked.status, "error");
  assert.equal(blocked.error.code, "R26_RELAY_PROGRESS_BLOCKED");
  assert.equal(blocked.error.details.reason, "R26_RELAY_ALIVE_STALLED");
  assert.equal(blocked.error.details.automatic_replay, false);
  assert.equal(calls.filter((action) => action === "shell.run").length, shellBefore);

  probePayload = {
    progress,
    liveness: livenessFor(progress, "healthy_progressing"),
    pending_unknown_effects: 0,
  };
  const allowed = structured(await client.callTool({
    name: "shell.run",
    arguments: { request_id: "r26-shell-healthy", command: "synthetic" },
  }));
  assert.equal(allowed.status, "completed");
  assert.equal(calls.filter((action) => action === "shell.run").length, shellBefore + 1);

  probePayload = {
    progress,
    liveness: livenessFor(progress, "healthy_progressing"),
    pending_unknown_effects: 1,
  };
  const unknownBlocked = structured(await client.callTool({
    name: "shell.run",
    arguments: { request_id: "r26-shell-unknown", command: "synthetic" },
  }));
  assert.equal(unknownBlocked.status, "error");
  assert.equal(unknownBlocked.error.code, "R26_RECONCILIATION_REQUIRED");
  assert.equal(unknownBlocked.error.details.automatic_replay, false);
  assert.equal(calls.filter((action) => action === "shell.run").length, shellBefore + 1);

  const health = supervisor.snapshot();
  assert.equal(health.relay_progress_health.classification, "reconciliation_required");
  assert.equal(health.relay_progress_health.pending_unknown_effects, 1);
  assert.equal(health.relay_progress_health.recovery.auto_restart, false);
  assert.equal(health.relay_progress_health.recovery.auto_kill, false);
  assert.equal(health.cutover_readiness.decision, "NO_LIVE_CUTOVER");
  assert.equal(health.cutover_readiness.release_ready, false);
});
