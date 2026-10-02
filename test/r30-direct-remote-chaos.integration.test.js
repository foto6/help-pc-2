import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import {
  createConfiguredNativeMcpRuntime,
  startDirectRemoteMcpServer,
  relayDigestJson,
} from "../src/index.js";
import {
  TEST_RELAY_CONTROL_TOKEN,
  TEST_RELAY_DEVICE_ID,
  connectDevice,
  createRelayState,
  deviceCapabilities,
  relayEnv,
  respond,
  startRelay,
} from "./support/native-relay-fixture.js";

const CLIENT_TOKEN_A = "r30-chaos-client-a-0123456789abcdef-0123456789";
const CLIENT_TOKEN_B = "r30-chaos-client-b-0123456789abcdef-0123456789";

function setRelayEnv(address, controlTimeoutMs = 500) {
  const keys = [
    "PC_NATIVE_RELAY_URL",
    "PC_NATIVE_RELAY_TOKEN",
    "PC_NATIVE_DEVICE_ID",
    "PC_NATIVE_DESKTOP_ID",
    "PC_NATIVE_RELAY_CONTROL_TIMEOUT_MS",
    "PC_NATIVE_EXECUTOR_MODULE",
  ];
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const next = relayEnv(address, {
    PC_NATIVE_RELAY_CONTROL_TIMEOUT_MS: String(controlTimeoutMs),
  });
  for (const [key, value] of Object.entries(next)) process.env[key] = value;
  delete process.env.PC_NATIVE_EXECUTOR_MODULE;
  return () => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function configuredRuntime(address, stateDir, { fetchWrapper = null } = {}) {
  const restore = setRelayEnv(address);
  const originalFetch = globalThis.fetch;
  if (fetchWrapper) globalThis.fetch = fetchWrapper(originalFetch);
  try {
    return await createConfiguredNativeMcpRuntime({
      stateDir,
      mode: "direct-remote",
    });
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
}

async function remoteServer(runtime, token, {
  requestTimeoutMs = 1_500,
  discoveryTimeoutMs = 500,
} = {}) {
  return startDirectRemoteMcpServer({
    runtime,
    clientToken: token,
    deviceAuthorityToken: TEST_RELAY_CONTROL_TOKEN,
    bindHost: "127.0.0.1",
    port: 0,
    publicOrigin: "http://127.0.0.1",
    allowInsecureHttpForTests: true,
    autoTestOrigin: true,
    requestTimeoutMs,
    discoveryTimeoutMs,
  });
}

async function connectClient(remote, token) {
  const transport = new StreamableHTTPClientTransport(new URL(remote.url), {
    authProvider: { token: async () => token },
  });
  const client = new Client(
    { name: "r30-chaos-client", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await client.connect(transport);
  return client;
}

function structured(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  const text = result?.content?.find((item) => item.type === "text")?.text;
  return text ? JSON.parse(text) : null;
}

async function harness(t, options = {}) {
  const state = createRelayState();
  let relayInfo = await startRelay(t, { state, autoCleanup: false });
  let relay = relayInfo.relay;
  let address = relayInfo.address;
  let peer = await connectDevice(address);
  const stateDir = mkdtempSync(join(tmpdir(), "r30-direct-chaos-"));
  let configured = await configuredRuntime(address, stateDir, options);
  let remote = await remoteServer(configured.runtime, CLIENT_TOKEN_A, options);
  const clients = [];
  t.after(async () => {
    for (const client of clients) await client.close().catch(() => {});
    await remote?.close().catch(() => {});
    await configured?.runtime?.close().catch(() => {});
    peer?.close();
    await relay?.stop().catch(() => {});
    rmSync(stateDir, { recursive: true, force: true });
  });
  return {
    state,
    stateDir,
    get relay() { return relay; },
    get address() { return address; },
    get peer() { return peer; },
    get configured() { return configured; },
    get remote() { return remote; },
    async client(token = CLIENT_TOKEN_A) {
      const client = await connectClient(remote, token);
      clients.push(client);
      return client;
    },
    async replacePeer(next) {
      peer?.close();
      peer = next;
    },
    async restartRemote(token = CLIENT_TOKEN_A) {
      await remote.close();
      remote = await remoteServer(configured.runtime, token, options);
      return remote;
    },
    async restartRuntime(token = CLIENT_TOKEN_A) {
      await remote.close();
      await configured.runtime.close();
      configured = await configuredRuntime(address, stateDir, options);
      remote = await remoteServer(configured.runtime, token, options);
      return { configured, remote };
    },
    async restartRelay({ epoch = peer?.epoch ?? "epoch-final-control-0001" } = {}) {
      const port = Number(new URL(address.url).port);
      peer?.close();
      await relay.stop();
      relayInfo = await startRelay(t, { state, port, autoCleanup: false });
      relay = relayInfo.relay;
      address = relayInfo.address;
      peer = await connectDevice(address, { epoch });
      return { relay, address, peer };
    },
  };
}

test("stable side-effect identity survives MCP reconnect and duplicate call without replay", async (t) => {
  const h = await harness(t);
  const client1 = await h.client();
  const args = {
    request_id: "r30-stable-write-1",
    path: "C:\\tmp\\r30-stable.txt",
    text: "once",
    overwrite: true,
  };
  const pending = client1.callTool({ name: "file.write", arguments: args });
  const frame = await h.peer.nextRequest();
  assert.equal(frame.payload.request_id, args.request_id);
  respond(h.peer, frame, { data: { written: true, bytes: 4 } });
  assert.equal(structured(await pending).status, "completed");

  await client1.close();
  const client2 = await h.client();
  const duplicate = structured(await client2.callTool({ name: "file.write", arguments: args }));
  assert.equal(duplicate.status, "completed");
  assert.equal(h.state.listDeliveries().filter((item) => item.request_id === args.request_id).length, 1);
  await assert.rejects(h.peer.nextRequest(150), /message timeout/);
});

test("lost device acknowledgement after side-effect dispatch stays reconciliation-only across reconnect", async (t) => {
  const h = await harness(t);
  const client = await h.client();
  const args = {
    request_id: "r30-lost-ack-write",
    path: "C:\\tmp\\r30-lost-ack.txt",
    text: "once",
    overwrite: true,
  };
  const pending = client.callTool({ name: "file.write", arguments: args });
  const frame = await h.peer.nextRequest();
  assert.equal(frame.payload.request_id, args.request_id);
  const epoch = h.peer.epoch;
  h.peer.close();

  const first = structured(await pending);
  assert.equal(first.status, "reconciliation_required");
  assert.equal(h.state.deliveryByRequestId(args.request_id).status, "reconciliation_required");
  assert.equal(h.state.deliveryByRequestId(args.request_id).result?.automatic_replay, false);

  const reconnected = await connectDevice(h.address, { epoch: epoch + "-reconnect" });
  await h.replacePeer(reconnected);
  await client.close();
  await h.restartRuntime(CLIENT_TOKEN_A);
  const recoveredClient = await h.client();
  const retry = structured(await recoveredClient.callTool({ name: "file.write", arguments: args }));
  assert.equal(retry.status, "reconciliation_required");
  await assert.rejects(h.peer.nextRequest(150), /message timeout/);
});

test("direct MCP host restart plus client-token rotation preserves completed request identity", async (t) => {
  const h = await harness(t);
  const client = await h.client();
  const args = {
    request_id: "r30-host-restart-write",
    path: "C:\\tmp\\r30-host-restart.txt",
    text: "once",
  };
  const pending = client.callTool({ name: "file.write", arguments: args });
  const frame = await h.peer.nextRequest();
  respond(h.peer, frame, { data: { written: true, bytes: 4 } });
  assert.equal(structured(await pending).status, "completed");
  await client.close();

  await h.restartRemote(CLIENT_TOKEN_B);
  const oldCredential = await fetch(h.remote.health_url, {
    headers: { authorization: `Bearer ${CLIENT_TOKEN_A}` },
  });
  assert.equal(oldCredential.status, 401);

  const rotated = await h.client(CLIENT_TOKEN_B);
  const duplicate = structured(await rotated.callTool({ name: "file.write", arguments: args }));
  assert.equal(duplicate.status, "completed");
  await assert.rejects(h.peer.nextRequest(150), /message timeout/);
});

test("relay restart with preserved state and epoch does not replay a completed side effect", async (t) => {
  const h = await harness(t);
  const client = await h.client();
  const args = {
    request_id: "r30-relay-restart-write",
    path: "C:\\tmp\\r30-relay-restart.txt",
    text: "once",
  };
  const pending = client.callTool({ name: "file.write", arguments: args });
  const frame = await h.peer.nextRequest();
  respond(h.peer, frame, { data: { written: true, bytes: 4 } });
  assert.equal(structured(await pending).status, "completed");

  const epoch = h.peer.epoch;
  await h.restartRelay({ epoch: epoch + "-relay-restart" });
  await client.close();
  await h.restartRuntime(CLIENT_TOKEN_A);
  const restartedClient = await h.client();
  const duplicate = structured(await restartedClient.callTool({ name: "file.write", arguments: args }));
  assert.equal(duplicate.status, "completed");
  await assert.rejects(h.peer.nextRequest(150), /message timeout/);
});

test("device offline and stale epoch produce bounded BLOCKED diagnostics without dispatch", async (t) => {
  const h = await harness(t, { discoveryTimeoutMs: 300 });
  const epoch = h.peer.epoch;
  h.peer.close();
  await new Promise((resolve) => setTimeout(resolve, 30));

  const started = performance.now();
  const offlineResponse = await fetch(h.remote.health_url, {
    headers: { authorization: `Bearer ${CLIENT_TOKEN_A}` },
  });
  const elapsed = performance.now() - started;
  assert.equal(offlineResponse.status, 503);
  assert.ok(elapsed < 1_500, `offline discovery exceeded bound: ${elapsed}`);
  const offline = await offlineResponse.json();
  assert.equal(offline.status, "BLOCKED");
  assert.equal(offline.executor_responsive, false);

  const next = await connectDevice(h.address, { epoch: epoch + "-new" });
  await h.replacePeer(next);
  const stale = await fetch(h.remote.health_url, {
    headers: { authorization: `Bearer ${CLIENT_TOKEN_A}` },
  });
  assert.equal(stale.status, 503);
  const staleBody = await stale.json();
  assert.equal(staleBody.status, "BLOCKED");
  assert.equal(staleBody.reason, "STALE_DEVICE_SESSION");
  assert.equal(h.state.listDeliveries().length, 0);
});

test("capability drift is rejected before remote tool dispatch", async (t) => {
  const h = await harness(t);
  const client = await h.client();
  const current = h.state.deviceView(TEST_RELAY_DEVICE_ID, true);
  const record = h.state.state.devices.find((item) => item.deviceId === TEST_RELAY_DEVICE_ID);
  const drifted = deviceCapabilities({ digest: "f".repeat(64) });
  record.capabilities = structuredClone(drifted);
  record.capabilitiesDigest = relayDigestJson(drifted);
  record.lastSessionEpoch = current.last_session_epoch;

  await assert.rejects(client.callTool({
    name: "device.ping",
    arguments: { request_id: "r30-capability-drift" },
  }));
  assert.equal(h.state.deliveryByRequestId("r30-capability-drift"), null);
  await assert.rejects(h.peer.nextRequest(150), /message timeout/);
});

test("oversized device result is bounded by the MCP host instead of escaping the remote lane", async (t) => {
  const h = await harness(t);
  const client = await h.client();
  const pending = client.callTool({
    name: "file.read",
    arguments: {
      request_id: "r30-large-read",
      path: "C:\\tmp\\large.txt",
      length: 100000,
    },
  });
  const frame = await h.peer.nextRequest();
  respond(h.peer, frame, { data: { text: "x".repeat(300_000), next_cursor: null } });
  const result = structured(await pending);
  assert.equal(result.status, "completed");
  assert.equal(result.data.truncated, true);
  assert.equal(result.data.reason, "MCP_RESULT_BOUND");
});

test("hung side effect hits direct response deadline and durable relay state becomes reconciliation_required", async (t) => {
  const h = await harness(t, { requestTimeoutMs: 500 });
  const client = await h.client();
  const args = {
    request_id: "r30-hung-side-effect",
    path: "C:\\tmp\\hung.txt",
    text: "once",
  };
  const started = performance.now();
  const pending = client.callTool({ name: "file.write", arguments: args });
  const frame = await h.peer.nextRequest();
  assert.equal(frame.payload.request_id, args.request_id);

  await assert.rejects(pending);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 2_000, `remote request timeout exceeded bound: ${elapsed}`);

  for (let i = 0; i < 100; i += 1) {
    if (h.state.deliveryByRequestId(args.request_id)?.status === "reconciliation_required") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const delivery = h.state.deliveryByRequestId(args.request_id);
  assert.equal(delivery.status, "reconciliation_required");
  assert.equal(delivery.result?.automatic_replay, false);

  const retry = structured(await client.callTool({ name: "file.write", arguments: args }));
  assert.equal(retry.status, "reconciliation_required");
  await assert.rejects(h.peer.nextRequest(150), /message timeout/);
});
