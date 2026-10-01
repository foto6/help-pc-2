import test from "node:test";
import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  ControlPlane,
  HelpPc1Adapter,
  NativeControlFacade,
  NativeMcpRuntime,
  R23AdapterCircuitRegistry,
  R23HealthSupervisor,
  R23_HEALTH_V1,
  TOOL_REGISTRY_LIST,
  startNativeMcpHttpServer,
} from "../src/index.js";

const TOKEN = "r23-health-token-0123456789abcdef0123456789";

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

test("MCP advertises adapter health and device.health runs only bounded read-only canary", async (t) => {
  const calls = [];
  const circuits = new R23AdapterCircuitRegistry({
    failureThreshold: 1,
    cooldownMs: 60_000,
    timeouts: { uia: 100, shell: 100, executor: 100 },
  });
  circuits.markFailure("uia", "ADAPTER_TIMEOUT", { timeout: true });
  circuits.markHealthy("shell", 1);

  const adapter = new HelpPc1Adapter({
    dryRun: false,
    healthGovernor: circuits,
    invoke: async (request) => {
      calls.push({ request_id: request.request_id, action: request.action });
      if (request.action === "system.health") {
        return success(request, { executor: "alive" });
      }
      if (request.action === "health.get") {
        return success(request, { canary: "pong" });
      }
      throw new Error("unexpected native action: " + request.action);
    },
  });
  const controlPlane = new ControlPlane({ providers: [adapter] });
  const facade = new NativeControlFacade({
    controlPlane,
    capabilityProvider: async () => ({
      contract_version: "pc_executor.capabilities.v1",
      digest: "r23-mcp-health-executor",
      actions: [...new Set(TOOL_REGISTRY_LIST.map((tool) => tool.executorAction))],
    }),
  });
  const healthSupervisor = new R23HealthSupervisor({
    controlPlane,
    circuitRegistry: circuits,
    transportProbe: async () => ({
      process_alive: true,
      transport_connected: true,
      queue_progressing: true,
      executor_responsive: true,
      last_progress_at_ms: Date.now(),
      last_successful_result_at_ms: Date.now(),
    }),
  });
  const runtime = await NativeMcpRuntime.create({
    facade,
    desktopId: "desktop-r23-health",
    healthSupervisor,
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
    { name: "r23-health-test", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  t.after(() => client.close());
  await client.connect(transport);

  const listed = await client.listTools();
  const uia = listed.tools.find((tool) => tool.name === "uia.find");
  const shell = listed.tools.find((tool) => tool.name === "shell.run");
  assert.equal(uia._meta["pc.native/r23_health_contract"], R23_HEALTH_V1);
  assert.equal(uia._meta["pc.native/r23_adapter_health"].status, "UNHEALTHY");
  assert.equal(uia._meta["pc.native/r23_adapter_health"].circuit_state, "OPEN");
  assert.equal(shell._meta["pc.native/r23_adapter_health"].status, "HEALTHY");

  const result = await client.callTool({
    name: "device.health",
    arguments: { request_id: "r23-device-health" },
  });
  const body = structured(result);
  assert.equal(body.status, "completed");
  assert.equal(body.data.executor, "alive");
  assert.equal(body.data.r23_health.contract_version, R23_HEALTH_V1);
  assert.equal(body.data.r23_health.process_alive, true);
  assert.equal(body.data.r23_health.transport_connected, true);
  assert.equal(body.data.r23_health.queue_progressing, true);
  assert.equal(body.data.r23_health.executor_responsive, true);
  assert.equal(body.data.r23_health.per_adapter_health.uia.status, "UNHEALTHY");
  assert.equal(body.data.r23_health.per_adapter_health.shell.status, "HEALTHY");
  assert.deepEqual(calls.map((item) => item.action), ["system.health", "health.get"]);
  assert.equal(controlPlane.snapshot().queue.length, 0);
  assert.ok(calls[1].request_id.startsWith("r23-canary:"));
});
