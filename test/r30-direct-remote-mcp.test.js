import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import {
  DIRECT_REMOTE_HEALTH_V1,
  PRODUCTION_BRIDGE_CONTRACT,
  assertCredentialSeparation,
  createConfiguredNativeMcpRuntime,
  startDirectRemoteMcpServer,
} from "../src/index.js";
import {
  TEST_RELAY_CONTROL_TOKEN,
  connectDevice,
  createRelayState,
  relayEnv,
  startRelay,
} from "./support/native-relay-fixture.js";

const CLIENT_TOKEN = "r30-client-token-0123456789abcdef-0123456789";
const WRONG_TOKEN = "r30-wrong-token-0123456789abcdef-0123456789";

function setRelayEnv(address) {
  const keys = [
    "PC_NATIVE_RELAY_URL",
    "PC_NATIVE_RELAY_TOKEN",
    "PC_NATIVE_DEVICE_ID",
    "PC_NATIVE_DESKTOP_ID",
    "PC_NATIVE_RELAY_CONTROL_TIMEOUT_MS",
    "PC_NATIVE_EXECUTOR_MODULE",
  ];
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const next = relayEnv(address, { PC_NATIVE_RELAY_CONTROL_TIMEOUT_MS: "500" });
  for (const [key, value] of Object.entries(next)) process.env[key] = value;
  delete process.env.PC_NATIVE_EXECUTOR_MODULE;
  return () => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function harness(t) {
  const state = createRelayState();
  const { relay, address } = await startRelay(t, { state, autoCleanup: false });
  const peer = await connectDevice(address);
  const restore = setRelayEnv(address);
  const stateDir = mkdtempSync(join(tmpdir(), "r30-direct-remote-"));
  let configured;
  try {
    configured = await createConfiguredNativeMcpRuntime({
      stateDir,
      mode: "direct-remote",
    });
  } finally {
    restore();
  }
  assert.equal(configured.moduleIdentity.contract_version, PRODUCTION_BRIDGE_CONTRACT);
  const remote = await startDirectRemoteMcpServer({
    runtime: configured.runtime,
    clientToken: CLIENT_TOKEN,
    deviceAuthorityToken: TEST_RELAY_CONTROL_TOKEN,
    bindHost: "127.0.0.1",
    port: 0,
    publicOrigin: "http://127.0.0.1",
    allowInsecureHttpForTests: true,
    autoTestOrigin: true,
    requestTimeoutMs: 2_000,
    discoveryTimeoutMs: 500,
  });
  t.after(async () => {
    await remote.close().catch(() => {});
    await configured.runtime.close().catch(() => {});
    peer.close();
    await relay.stop().catch(() => {});
    rmSync(stateDir, { recursive: true, force: true });
  });
  return { state, relay, address, peer, configured, remote, stateDir };
}

async function clientFor(remote, token = CLIENT_TOKEN) {
  const transport = new StreamableHTTPClientTransport(new URL(remote.url), {
    authProvider: { token: async () => token },
  });
  const client = new Client(
    { name: "r30-direct-remote-test", version: "1.0.0" },
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

test("direct remote transport uses official MCP initialize/list and discovery does not claim desktop", async (t) => {
  const h = await harness(t);
  assert.equal(h.configured.facade.debugSnapshot().sessions.length, 0);

  const client = await clientFor(h.remote);
  t.after(() => client.close().catch(() => {}));
  const listed = await client.listTools();
  assert.ok(listed.tools.length > 30);
  assert.equal(h.configured.facade.debugSnapshot().sessions.length, 0);

  const write = listed.tools.find((tool) => tool.name === "file.write");
  assert.equal(write._meta["pc.native/stable_request_id_required_for_side_effects"], true);
  const serialized = JSON.stringify(listed);
  assert.equal(serialized.includes(CLIENT_TOKEN), false);
  assert.equal(serialized.includes(TEST_RELAY_CONTROL_TOKEN), false);
});

test("direct remote side effects require stable request_id before any relay dispatch", async (t) => {
  const h = await harness(t);
  const client = await clientFor(h.remote);
  t.after(() => client.close().catch(() => {}));

  const result = structured(await client.callTool({
    name: "file.write",
    arguments: { path: "C:\\tmp\\r30.txt", text: "once" },
  }));
  assert.equal(result.status, "error");
  assert.equal(result.error.code, "REMOTE_STABLE_REQUEST_ID_REQUIRED");
  assert.equal(h.state.listDeliveries().length, 0);
});

test("authenticated health is bounded and reports no secrets or desktop ownership claim", async (t) => {
  const h = await harness(t);
  const response = await fetch(h.remote.health_url, {
    headers: { authorization: `Bearer ${CLIENT_TOKEN}` },
  });
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.contract_version, DIRECT_REMOTE_HEALTH_V1);
  assert.ok(["HEALTHY", "DEGRADED"].includes(health.status));
  assert.equal(health.source_ready, true);
  assert.equal(health.actual_remote_chatgpt_tool_exposed, false);
  assert.equal(health.client_credential_authority, "direct_remote_mcp");
  assert.equal(health.device_credential_authority, "native_remote_relay");
  assert.equal(JSON.stringify(health).includes(CLIENT_TOKEN), false);
  assert.equal(JSON.stringify(health).includes(TEST_RELAY_CONTROL_TOKEN), false);
  assert.equal(h.configured.facade.debugSnapshot().sessions.length, 0);
});

test("wrong token, Host confusion and Origin confusion fail closed", async (t) => {
  const h = await harness(t);

  const wrongToken = await fetch(h.remote.health_url, {
    headers: { authorization: `Bearer ${WRONG_TOKEN}` },
  });
  assert.equal(wrongToken.status, 401);

  const wrongHost = await fetch(h.remote.health_url, {
    headers: {
      authorization: `Bearer ${CLIENT_TOKEN}`,
      host: "evil.invalid",
    },
  });
  assert.equal(wrongHost.status, 421);

  const wrongOrigin = await fetch(h.remote.health_url, {
    headers: {
      authorization: `Bearer ${CLIENT_TOKEN}`,
      origin: "https://evil.invalid",
    },
  });
  assert.equal(wrongOrigin.status, 403);

  const diagnostics = h.remote.diagnostics();
  assert.ok(diagnostics.auth_failures >= 1);
  assert.ok(diagnostics.host_failures >= 1);
  assert.ok(diagnostics.origin_failures >= 1);
  assert.equal(JSON.stringify(diagnostics).includes(CLIENT_TOKEN), false);
});

test("remote bind and credential authority fail closed unless explicitly separated and authorized", async () => {
  assert.throws(
    () => assertCredentialSeparation(CLIENT_TOKEN, CLIENT_TOKEN),
    (error) => error.code === "CREDENTIAL_AUTHORITY_COLLISION",
  );
  await assert.rejects(
    startDirectRemoteMcpServer({
      runtime: {},
      clientToken: CLIENT_TOKEN,
      deviceAuthorityToken: TEST_RELAY_CONTROL_TOKEN,
      bindHost: "0.0.0.0",
      port: 0,
      publicOrigin: "https://mcp.example.test",
    }),
    (error) => error.code === "REMOTE_BIND_NOT_AUTHORIZED",
  );
});
