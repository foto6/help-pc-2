import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  DC_COMPATIBILITY_REGISTRY_LIST,
  PRODUCTION_BRIDGE_CONTRACT,
  createConfiguredNativeMcpRuntime,
  startNativeMcpHttpServer,
  relayDigestJson,
} from "../src/index.js";
import {
  TEST_EXECUTOR_DIGEST,
  TEST_RELAY_CONTROL_TOKEN,
  TEST_RELAY_DEVICE_ID,
  connectDevice,
  createRelayState,
  deviceCapabilities,
  relayEnv,
  respond,
  startRelay,
} from "./support/native-relay-fixture.js";

const MCP_TOKEN = "final-mcp-token-0123456789abcdef-0123456789";

function structured(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  const text = result?.content?.find((item) => item.type === "text")?.text;
  return text ? JSON.parse(text) : null;
}

function setProductionRelayEnv(address) {
  const keys = [
    "PC_NATIVE_RELAY_URL",
    "PC_NATIVE_RELAY_TOKEN",
    "PC_NATIVE_DEVICE_ID",
    "PC_NATIVE_DESKTOP_ID",
    "PC_NATIVE_EXECUTOR_MODULE",
  ];
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const next = relayEnv(address);
  for (const [key, value] of Object.entries(next)) process.env[key] = value;
  delete process.env.PC_NATIVE_EXECUTOR_MODULE;
  return () => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function createHarness(t, {
  state = createRelayState(),
  port = 0,
  providerFetchWrapper = null,
} = {}) {
  const { relay, address } = await startRelay(t, { state, port, autoCleanup: false });
  const peer = await connectDevice(address);
  const restoreEnv = setProductionRelayEnv(address);
  const stateDir = mkdtempSync(join(tmpdir(), "final-control-e2e-"));
  const originalFetch = globalThis.fetch;
  if (providerFetchWrapper) globalThis.fetch = providerFetchWrapper(originalFetch);
  let configured;
  try {
    configured = await createConfiguredNativeMcpRuntime({ stateDir, mode: "http" });
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
  assert.equal(configured.moduleIdentity.contract_version, PRODUCTION_BRIDGE_CONTRACT);
  assert.equal(configured.moduleIdentity.built_in, true);
  assert.equal(configured.moduleIdentity.module, "src/native-relay-provider.js");

  const http = await startNativeMcpHttpServer({
    runtime: configured.runtime,
    token: MCP_TOKEN,
    port: 0,
  });
  const transport = new StreamableHTTPClientTransport(new URL(http.url), {
    authProvider: { token: async () => MCP_TOKEN },
  });
  const client = new Client(
    { name: "final-control-relay-e2e", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await client.connect(transport);

  t.after(async () => {
    await client.close().catch(() => {});
    await http.close().catch(() => {});
    await configured.runtime.close().catch(() => {});
    peer.close();
    await relay.stop().catch(() => {});
    rmSync(stateDir, { recursive: true, force: true });
  });

  return { state, relay, address, peer, configured, http, client };
}

test("final production chain exposes 28 DC tools and preserves one logical request through read/write duplicates", async (t) => {
  const h = await createHarness(t);
  const listed = await h.client.listTools();
  const names = new Set(listed.tools.map((tool) => tool.name));
  const compatTool = (name) => listed.tools.find((tool) => tool.name === name);
  assert.equal(DC_COMPATIBILITY_REGISTRY_LIST.length, 28);
  for (const tool of DC_COMPATIBILITY_REGISTRY_LIST) {
    assert.equal(names.has(tool.name), true, tool.name);
    assert.equal(compatTool(tool.name)._meta["pc.desktop_commander/available"], true, tool.name);
  }
  assert.equal(names.has("get_prompts"), false);
  assert.equal(names.has("give_feedback_to_desktop_commander"), false);
  assert.equal(compatTool("write_pdf")._meta["pc.desktop_commander/available"], true);

  const readMeta = compatTool("read_file")._meta;
  assert.equal(readMeta["pc.desktop_commander/selected_variant"], "pc_core_full");
  assert.deepEqual(
    readMeta["pc.desktop_commander/capability_variants"]
      .find((variant) => variant.id === "pc_core_full").executor_actions,
    ["fs.read_text", "fs.read_bytes", "log.tail"],
  );
  const sessionsMeta = compatTool("list_sessions")._meta;
  assert.deepEqual(
    sessionsMeta["pc.desktop_commander/capability_variants"]
      .find((variant) => variant.id === "pc_core").executor_actions,
    ["process.managed.list", "process.status"],
  );
  const processesMeta = compatTool("list_processes")._meta;
  assert.deepEqual(
    processesMeta["pc.desktop_commander/capability_variants"]
      .find((variant) => variant.id === "pc_core").executor_actions,
    ["process.list", "process.inspect"],
  );

  const readId = "final-e2e-read";
  const readPending = h.client.callTool({
    name: "device.ping",
    arguments: { request_id: readId },
  });
  const readFrame = await h.peer.nextRequest();
  assert.equal(readFrame.payload.request_id, readId);
  assert.equal(readFrame.payload.body.request_id, readId);
  assert.equal(readFrame.payload.body.registry_version, "pc.native.parity_tool_registry.v1");
  assert.equal(readFrame.payload.body.tool, "device.health");
  assert.notEqual(readFrame.payload.delivery_id, readId);
  respond(h.peer, readFrame, { data: { healthy: true } });
  const read = structured(await readPending);
  assert.equal(read.status, "completed");
  assert.equal(read.data.healthy, true);

  const shutdownId = "final-e2e-shutdown";
  const shutdownPending = h.client.callTool({
    name: "shutdown",
    arguments: { request_id: shutdownId },
  });
  const infoFrame = await h.peer.nextRequest();
  assert.equal(infoFrame.payload.request_id, shutdownId + ":generation");
  assert.equal(infoFrame.payload.body.registry_version, "pc.native.parity_tool_registry.v1");
  assert.equal(infoFrame.payload.body.tool, "device.info");
  respond(h.peer, infoFrame, { data: { device_id: "local", generation_id: "generation-final-1" } });
  const shutdownFrame = await h.peer.nextRequest();
  assert.equal(shutdownFrame.payload.request_id, shutdownId);
  assert.equal(shutdownFrame.payload.body.registry_version, "pc.native.parity_tool_registry.v1");
  assert.equal(shutdownFrame.payload.body.tool, "agent.shutdown");
  assert.deepEqual(shutdownFrame.payload.body.arguments, {
    device_id: TEST_RELAY_DEVICE_ID,
    session_id: shutdownFrame.payload.body.session_id,
    session_epoch: h.peer.epoch,
    generation_id: "generation-final-1",
  });
  respond(h.peer, shutdownFrame, { data: { shutdown_requested: true } });
  const shutdown = structured(await shutdownPending);
  assert.equal(shutdown.status, "completed");
  assert.equal(shutdown.data.native.shutdown_requested, true);

  const writeArgs = {
    request_id: "final-e2e-write",
    path: "C:\\tmp\\final-e2e.txt",
    content: "once",
    mode: "rewrite",
  };
  const writePending = h.client.callTool({ name: "write_file", arguments: writeArgs });
  const writeFrame = await h.peer.nextRequest();
  assert.equal(writeFrame.payload.request_id, writeArgs.request_id);
  assert.equal(writeFrame.payload.body.request_id, writeArgs.request_id);
  assert.equal(writeFrame.payload.body.tool, "file.write");
  respond(h.peer, writeFrame, { data: { written: true, bytes: 4 } });
  const first = structured(await writePending);
  assert.equal(first.status, "completed");

  const duplicate = structured(await h.client.callTool({ name: "write_file", arguments: writeArgs }));
  assert.equal(duplicate.status, "completed");
  await assert.rejects(h.peer.nextRequest(150), /message timeout/);

  const conflict = structured(await h.client.callTool({
    name: "write_file",
    arguments: { ...writeArgs, content: "different" },
  }));
  assert.equal(conflict.status, "error");
  assert.equal(conflict.error.code, "DUPLICATE_REQUEST_MISMATCH");
  await assert.rejects(h.peer.nextRequest(150), /message timeout/);
});

test("disconnect after side-effect dispatch surfaces reconciliation_required with automatic replay disabled", async (t) => {
  const h = await createHarness(t);
  const requestId = "final-e2e-disconnect";
  const pending = h.client.callTool({
    name: "file.write",
    arguments: {
      request_id: requestId,
      path: "C:\\tmp\\unknown.txt",
      text: "once",
    },
  });
  const frame = await h.peer.nextRequest();
  assert.equal(frame.payload.request_id, requestId);
  h.peer.close();

  const result = structured(await pending);
  assert.equal(result.status, "reconciliation_required");
  const delivery = h.state.deliveryByRequestId(requestId);
  assert.equal(delivery.status, "reconciliation_required");
  assert.equal(delivery.result?.automatic_replay, false);
});


test("lost relay result surfaces UNKNOWN then same logical request recovers cached success without replay", async (t) => {
  let losePostResponse = true;
  const h = await createHarness(t, {
    providerFetchWrapper: (realFetch) => async (...args) => {
      const response = await realFetch(...args);
      const url = new URL(String(args[0]));
      const method = args[1]?.method ?? "GET";
      if (losePostResponse && method === "POST" && url.pathname === "/v1/relay/request") {
        losePostResponse = false;
        await response.clone().json();
        throw new Error("simulated final-candidate result loss");
      }
      return response;
    },
  });

  const args = {
    request_id: "final-e2e-result-loss",
    path: "C:\tmp\result-loss.txt",
    content: "once",
    mode: "rewrite",
  };
  const pending = h.client.callTool({ name: "write_file", arguments: args });
  const frame = await h.peer.nextRequest();
  assert.equal(frame.payload.request_id, args.request_id);
  respond(h.peer, frame, { data: { written: true, bytes: 4 } });

  const first = structured(await pending);
  assert.equal(first.status, "reconciliation_required");
  assert.equal(h.state.deliveryByRequestId(args.request_id).status, "completed");

  const recovered = structured(await h.client.callTool({ name: "write_file", arguments: args }));
  assert.equal(recovered.status, "completed");
  assert.equal(recovered.data.bytes, 4);
  await assert.rejects(h.peer.nextRequest(150), /message timeout/);
});

test("relay restart after dispatch keeps the same side effect UNKNOWN and never replays", async (t) => {
  const state = createRelayState();
  const h = await createHarness(t, { state });
  const requestId = "final-e2e-restart";
  const pending = h.client.callTool({
    name: "file.write",
    arguments: {
      request_id: requestId,
      path: "C:\\tmp\\restart.txt",
      text: "once",
    },
  });
  await h.peer.nextRequest();
  const port = h.address.port;
  await h.relay.stop();

  const result = structured(await pending);
  assert.equal(result.status, "reconciliation_required");
  const afterStop = state.deliveryByRequestId(requestId);
  assert.equal(afterStop.status, "reconciliation_required");
  assert.equal(afterStop.result?.automatic_replay, false);

  const restarted = await startRelay(t, { state, port, autoCleanup: false });
  t.after(() => restarted.relay.stop().catch(() => {}));
  const delivery = state.deliveryByRequestId(requestId);
  assert.equal(delivery.status, "reconciliation_required");
});

test("production chain fails closed on stale device epoch and capability digest before dispatch", async (t) => {
  const h = await createHarness(t);
  const current = h.state.deviceView(TEST_RELAY_DEVICE_ID, true);
  h.state.beginSession({
    deviceId: TEST_RELAY_DEVICE_ID,
    sessionEpoch: "epoch-final-control-0002",
    capabilitiesDigest: current.capabilities_digest,
    capabilities: current.capabilities,
    limits: current.limits,
  });

  await assert.rejects(h.client.callTool({
    name: "device.ping",
    arguments: { request_id: "final-e2e-stale-epoch" },
  }));
  assert.equal(h.state.deliveryByRequestId("final-e2e-stale-epoch"), null);
  await assert.rejects(h.peer.nextRequest(150), /message timeout/);

  const record = h.state.state.devices.find((item) => item.deviceId === TEST_RELAY_DEVICE_ID);
  record.lastSessionEpoch = h.peer.epoch;
  const drifted = deviceCapabilities({ digest: "f".repeat(64) });
  record.capabilities = structuredClone(drifted);
  record.capabilitiesDigest = relayDigestJson(drifted);

  await assert.rejects(h.client.callTool({
    name: "device.ping",
    arguments: { request_id: "final-e2e-cap-drift" },
  }));
  assert.equal(h.state.deliveryByRequestId("final-e2e-cap-drift"), null);
  await assert.rejects(h.peer.nextRequest(150), /message timeout/);
});

test("cancellation race after relay dispatch stays reconciliation-only and retry does not dispatch again", async (t) => {
  const h = await createHarness(t);
  const args = {
    request_id: "final-e2e-cancel",
    path: "C:\\tmp\\cancel.txt",
    content: "once",
    mode: "rewrite",
  };
  const controller = new AbortController();
  const pending = h.client.callTool(
    { name: "write_file", arguments: args },
    { signal: controller.signal },
  );
  const frame = await h.peer.nextRequest();
  assert.equal(frame.payload.request_id, args.request_id);
  controller.abort();
  await assert.rejects(pending);

  for (let i = 0; i < 50; i += 1) {
    const delivery = h.state.deliveryByRequestId(args.request_id);
    if (delivery?.status === "reconciliation_required") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const delivery = h.state.deliveryByRequestId(args.request_id);
  assert.equal(delivery.status, "reconciliation_required");
  assert.equal(delivery.result?.automatic_replay, false);

  const retry = structured(await h.client.callTool({ name: "write_file", arguments: args }));
  assert.equal(retry.status, "reconciliation_required");
  await assert.rejects(h.peer.nextRequest(150), /message timeout/);
});
