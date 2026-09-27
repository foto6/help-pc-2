import test from "node:test";
import assert from "node:assert/strict";
import { createSimulationRuntime } from "../src/simulation.js";
import { PcControlMcpGateway, createMcpJsonRpcHandler } from "../src/mcp-gateway.js";

function makeGateway() {
  const simulated = createSimulationRuntime();
  const runtime = {
    controlPlane: simulated.controlPlane,
    executorClient: { status: () => ({ running: true, pid: 1234, pending: 0 }) },
    live: false,
    desktopId: "test-desktop",
    dataDir: "memory://test",
  };
  return { gateway: new PcControlMcpGateway(runtime), runtime, simulated };
}

test("gateway exposes convenience and control-plane tools", () => {
  const { gateway } = makeGateway();
  const names = gateway.listTools().map((tool) => tool.name);
  assert.ok(names.includes("pc_health"));
  assert.ok(names.includes("pc_shell_run"));
  assert.ok(names.includes("session_create"));
  assert.ok(names.includes("action_enqueue"));
  assert.ok(names.includes("runtime_metrics"));
});

test("pc_shell_run executes through ControlPlane provider path", async () => {
  const { gateway, simulated } = makeGateway();
  const result = await gateway.callTool("pc_shell_run", {
    argv: ["git", "status"],
    cwd: null,
    timeoutMs: 5000,
    idempotencyKey: "shell-test-1",
  });

  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.contract, "pc_control.gateway.shell_result.v1");
  assert.equal(result.structuredContent.status, "succeeded");
  assert.equal(result.structuredContent.terminal, true);
  assert.equal(result.structuredContent.executionAttempts, 1);
  assert.equal(simulated.executor.calls.length, 1);
  assert.equal(simulated.executor.calls[0].action, "shell.run");
  assert.deepEqual(simulated.executor.calls[0].params.argv, ["git", "status"]);
});

test("pc_shell_run refuses to process unrelated unfinished durable work", async () => {
  const { gateway, runtime } = makeGateway();
  const session = runtime.controlPlane.createSession({
    desktopId: "test-desktop",
    principal: "test",
    claimDesktop: false,
  });
  runtime.controlPlane.enqueueAction(session.id, {
    provider: "help-pc-1",
    type: "shell.run",
    input: { argv: ["git", "status"] },
    permission: "desktop.control",
    requiresDesktop: false,
  });

  const result = await gateway.callTool("pc_shell_run", {
    argv: ["git", "status"],
  });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, "GATEWAY_BUSY");
  assert.equal(simulatedActionCount(runtime.controlPlane), 1);
});

function simulatedActionCount(controlPlane) {
  return controlPlane.listActions().length;
}

test("JSON-RPC initialize/list/call works without side effects", async () => {
  const { gateway } = makeGateway();
  const handle = createMcpJsonRpcHandler(gateway);

  const init = await handle({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  });
  assert.equal(init.result.serverInfo.name, "pc-control-mcp-gateway");
  assert.equal(init.result.protocolVersion, "2025-06-18");

  const list = await handle({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  assert.ok(list.result.tools.some((tool) => tool.name === "pc_shell_run"));

  const health = await handle({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "pc_health", arguments: {} },
  });
  assert.equal(health.result.isError, false);
  assert.equal(health.result.structuredContent.contract, "pc_control.gateway.health.v1");
});

test("unknown tools fail closed", async () => {
  const { gateway } = makeGateway();
  const result = await gateway.callTool("definitely_not_a_tool", {});
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, "METHOD_NOT_FOUND");
});
