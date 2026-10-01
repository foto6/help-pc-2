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
  R24RuntimeHealthConsumer,
  TOOL_REGISTRY_LIST,
  startNativeMcpHttpServer,
} from "../src/index.js";

const TOKEN = "r25-r24-health-token-0123456789abcdef012345";
const fixtureUrl = new URL(
  "../conformance/r24_runtime_health_v1/runtime_health.example.json",
  import.meta.url,
);

function fixture() {
  return JSON.parse(readFileSync(fixtureUrl, "utf8"));
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

function recomputeSummary(payload) {
  payload.summary = { responsive: 0, degraded: 0, unhealthy: 0, unknown: 0 };
  for (const adapter of Object.values(payload.adapters)) {
    payload.summary[adapter.state] += 1;
  }
}

test("MCP ingests exact R24 device.health and blocks only unhealthy UIA lane", async (t) => {
  let currentHealth = fixture();
  const now = Date.parse(currentHealth.observed_at) + 500;
  const calls = [];
  const circuits = new R23AdapterCircuitRegistry({ clock: () => now });
  const consumer = new R24RuntimeHealthConsumer({
    clock: () => now,
    maxAgeMs: 5_000,
  });

  const adapter = new HelpPc1Adapter({
    dryRun: false,
    healthGovernor: circuits,
    invoke: async (request, context) => {
      calls.push({
        action: request.action,
        logical_request_id: context.logicalRequestId,
      });
      if (["system.health", "health.get"].includes(request.action)) {
        return success(request, {
          status: "ok",
          runtime_health: structuredClone(currentHealth),
        });
      }
      if (request.action === "window.list") {
        return success(request, { windows: [], has_more: false });
      }
      if (request.action === "uia.find") {
        return success(request, { matches: [], has_more: false });
      }
      throw new Error("unexpected action: " + request.action);
    },
  });

  const controlPlane = new ControlPlane({ providers: [adapter] });
  const facade = new NativeControlFacade({
    controlPlane,
    capabilityProvider: async () => ({
      contract_version: "pc_executor.capabilities.v1",
      digest: "r25-r24-executor-fixture",
      actions: [...new Set(TOOL_REGISTRY_LIST.map((tool) => tool.executorAction))],
    }),
  });
  const supervisor = new R23HealthSupervisor({
    clock: () => now,
    controlPlane,
    circuitRegistry: circuits,
    producerHealthConsumer: consumer,
    transportProbe: async () => ({
      process_alive: true,
      transport_connected: true,
      queue_progressing: true,
      executor_responsive: true,
      last_progress_at_ms: now,
      last_successful_result_at_ms: now,
    }),
  });
  const runtime = await NativeMcpRuntime.create({
    facade,
    desktopId: "desktop-r25-r24",
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
    { name: "r25-r24-health-test", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  t.after(() => client.close());
  await client.connect(transport);

  const firstHealth = structured(await client.callTool({
    name: "device.health",
    arguments: { request_id: "r25-health-exact" },
  }));
  assert.equal(firstHealth.status, "completed");
  assert.equal(firstHealth.data.r25_runtime_health_ingestion.accepted, true);
  assert.equal(
    firstHealth.data.r25_runtime_health_ingestion.producer_sha,
    "60ba0ce92bf2f3cdd89e3213dba40793c6a90d8b",
  );
  assert.equal(firstHealth.data.r23_health.producer_runtime_health.source_state, "SOURCE_BOUND");
  assert.equal(firstHealth.data.r23_health.producer_runtime_health.system_state, "HEALTHY");
  assert.deepEqual(
    firstHealth.data.r23_health.producer_runtime_health.adapter_specific_degraded,
    ["uia"],
  );
  assert.equal(firstHealth.data.r23_health.cutover_readiness.decision, "NO_LIVE_CUTOVER");
  assert.equal(firstHealth.data.r23_health.cutover_readiness.release_ready, false);

  const windowsBefore = calls.filter((entry) => entry.action === "window.list").length;
  const windows = structured(await client.callTool({
    name: "window.list",
    arguments: { request_id: "r25-window-good" },
  }));
  assert.equal(windows.status, "completed");
  assert.equal(calls.filter((entry) => entry.action === "window.list").length, windowsBefore + 1);

  currentHealth = fixture();
  currentHealth.adapters.uia.state = "unhealthy";
  currentHealth.adapters.uia.last_failure_kind = "timeout";
  currentHealth.adapters.uia.timeout_count = 3;
  currentHealth.adapters.uia.circuit.state = "open";
  currentHealth.adapters.uia.circuit.consecutive_timeouts = 3;
  recomputeSummary(currentHealth);

  const unhealthyHealth = structured(await client.callTool({
    name: "device.health",
    arguments: { request_id: "r25-health-uia-unhealthy" },
  }));
  assert.equal(unhealthyHealth.status, "completed");
  assert.deepEqual(
    unhealthyHealth.data.r23_health.producer_runtime_health.adapter_specific_unhealthy,
    ["uia"],
  );
  // Global system remains healthy because only one independent adapter lane is unhealthy.
  assert.equal(unhealthyHealth.data.r23_health.producer_runtime_health.system_state, "HEALTHY");

  const uiaBefore = calls.filter((entry) => entry.action === "uia.find").length;
  const blocked = structured(await client.callTool({
    name: "uia.find",
    arguments: { request_id: "r25-uia-blocked", max_results: 1 },
  }));
  assert.equal(blocked.status, "error");
  assert.equal(blocked.error.code, "R24_ACTION_HEALTH_BLOCKED");
  assert.equal(blocked.error.details.adapter, "uia");
  assert.equal(blocked.error.details.reason, "R24_UIA_UNHEALTHY");
  assert.equal(calls.filter((entry) => entry.action === "uia.find").length, uiaBefore);

  const windowsAfter = structured(await client.callTool({
    name: "window.list",
    arguments: { request_id: "r25-window-after-uia" },
  }));
  assert.equal(windowsAfter.status, "completed");
  assert.equal(calls.filter((entry) => entry.action === "window.list").length, windowsBefore + 2);

  assert.equal(controlPlane.snapshot().queue.length, 0);
  assert.ok(calls.filter((entry) => entry.action === "health.get").length >= 2);
});
