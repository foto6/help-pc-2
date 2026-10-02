import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PcControlDirectCandidateGateway,
  evaluateR31Readiness,
  runReadOnlyCanary,
} from "../src/pc-control-direct-candidate.js";
import {
  createConfiguredNativeMcpRuntime,
  startDirectRemoteMcpServer,
} from "../src/index.js";
import {
  TEST_RELAY_CONTROL_TOKEN,
  connectDevice,
  createRelayState,
  relayEnv,
  respond,
  startRelay,
} from "./support/native-relay-fixture.js";

const DIRECT_TOKEN = "r31-real-direct-token-0123456789abcdef-0123456789";
const WRONG_TOKEN = "r31-real-wrong-token-0123456789abcdef-0123456789";

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

async function createHarness(t) {
  const state = createRelayState();
  const { relay, address } = await startRelay(t, { state, autoCleanup: false });
  let peer = await connectDevice(address);
  const restore = setRelayEnv(address);
  const stateDir = mkdtempSync(join(tmpdir(), "r31-direct-gateway-"));
  let configured;
  try {
    configured = await createConfiguredNativeMcpRuntime({
      stateDir,
      mode: "direct-remote",
    });
  } finally {
    restore();
  }
  const remote = await startDirectRemoteMcpServer({
    runtime: configured.runtime,
    clientToken: DIRECT_TOKEN,
    deviceAuthorityToken: TEST_RELAY_CONTROL_TOKEN,
    bindHost: "127.0.0.1",
    port: 0,
    publicOrigin: "http://127.0.0.1",
    allowInsecureHttpForTests: true,
    autoTestOrigin: true,
    requestTimeoutMs: 2_000,
    discoveryTimeoutMs: 500,
  });

  const gateways = [];
  const gateway = (token = DIRECT_TOKEN, mode = "read_only_canary") => {
    const item = new PcControlDirectCandidateGateway({
      endpoint: remote.url,
      token,
      allowInsecureHttpForTests: true,
      connectTimeoutMs: 1_000,
      requestTimeoutMs: 2_000,
      mode,
    });
    gateways.push(item);
    return item;
  };

  t.after(async () => {
    for (const item of gateways) await item.close().catch(() => {});
    await remote.close().catch(() => {});
    await configured.runtime.close().catch(() => {});
    peer.close();
    await relay.stop().catch(() => {});
    rmSync(stateDir, { recursive: true, force: true });
  });

  return {
    state,
    relay,
    address,
    configured,
    remote,
    gateway,
    get peer() { return peer; },
    replacePeer(next) {
      peer = next;
    },
  };
}

async function respondToCanary(peer, expected = ["device.ping", "device.info"]) {
  for (const name of expected) {
    const frame = await peer.nextRequest();
    assert.equal(frame.payload.body.tool, name === "device.ping" ? "device.health" : "device.info");
    respond(peer, frame, {
      data: name === "device.ping"
        ? { healthy: true }
        : { device_id: "fixture-device", generation_id: "fixture-generation" },
    });
  }
}

test("R31 gateway consumes the real R30 MCP lane and emits a stable plugin-facing surface", async (t) => {
  const h = await createHarness(t);
  const direct = h.gateway();
  const surface = await direct.describe();

  assert.equal(surface.contract_version, "pc.control.plugin_surface.v1");
  assert.equal(surface.source_lane, "direct_mcp_candidate");
  assert.ok(["HEALTHY", "DEGRADED"].includes(surface.health.status));
  assert.equal(surface.health.transport_connected, true);
  assert.equal(surface.health.executor_responsive, true);
  assert.equal(typeof surface.capabilities.native_registry_digest, "string");
  assert.equal(typeof surface.capabilities.executor_digest, "string");
  assert.equal(surface.capabilities.explicit_side_effect_request_id_required, true);
  assert.equal(surface.capabilities.reconciliation_status, "reconciliation_required");
  assert.equal(surface.capabilities.automatic_replay, false);
  assert.ok(surface.tools.some((tool) => tool.name === "device.ping" && tool.effect === "read_only"));
  assert.ok(surface.tools.some((tool) => tool.name === "file.write" && tool.effect === "side_effect"));
  assert.equal(JSON.stringify(surface).includes(DIRECT_TOKEN), false);
  assert.equal(JSON.stringify(surface).includes(TEST_RELAY_CONTROL_TOKEN), false);
});

test("one-command canary logic uses only selected read-only tools and synthetic CI evidence cannot advance readiness", async (t) => {
  const h = await createHarness(t);
  const direct = h.gateway();

  const responder = respondToCanary(h.peer);
  const { surface, evidence } = await runReadOnlyCanary({
    gateway: direct,
    tools: ["device.ping", "device.info"],
    evidenceOrigin: "synthetic_ci",
  });
  await responder;

  assert.equal(evidence.status, "PASS");
  assert.equal(evidence.side_effect_calls, 0);
  assert.equal(evidence.replay_authorized, false);
  assert.equal(evidence.calls.length, 2);
  assert.ok(evidence.calls.every((call) => call.effect === "read_only"));
  assert.equal(JSON.stringify(evidence).includes("fixture-generation"), false);

  const authority = structuredClone(surface);
  authority.source_lane = "github_relay";
  const readiness = evaluateR31Readiness({
    sourceReady: true,
    authoritySurface: authority,
    candidateSurface: surface,
    canaryEvidence: evidence,
  });
  assert.equal(readiness.state, "SOURCE_READY");
  assert.equal(readiness.current_authority, "github_relay");
  assert.equal(readiness.actual_pc_control_cutover, false);
});

test("gateway reconnect keeps read-only candidate operation bounded without changing authority", async (t) => {
  const h = await createHarness(t);
  const first = h.gateway();

  const firstResponder = (async () => {
    const frame = await h.peer.nextRequest();
    respond(h.peer, frame, { data: { healthy: true } });
  })();
  const one = await first.callTool({ name: "device.ping", arguments: {} });
  await firstResponder;
  assert.equal(one.status, "completed");
  await first.close();

  const second = h.gateway();
  const secondResponder = (async () => {
    const frame = await h.peer.nextRequest();
    respond(h.peer, frame, { data: { healthy: true } });
  })();
  const two = await second.callTool({ name: "device.ping", arguments: {} });
  await secondResponder;
  assert.equal(two.status, "completed");
  assert.equal(two.fallback_authorized, false);
});

test("real R30 auth mismatch fails closed before tool discovery", async (t) => {
  const h = await createHarness(t);
  const direct = h.gateway(WRONG_TOKEN);
  await assert.rejects(
    direct.describe(),
    (error) => error.code === "DIRECT_AUTH_MISMATCH",
  );
  assert.equal(h.state.listDeliveries().length, 0);
});

test("real direct candidate preserves UNKNOWN reconciliation and never authorizes fallback", async (t) => {
  const h = await createHarness(t);
  const direct = h.gateway(DIRECT_TOKEN, "explicit_plugin_candidate");
  const args = {
    request_id: "r31-real-unknown-write",
    path: "C:\\tmp\\r31-unknown.txt",
    text: "once",
  };

  const pending = direct.callTool({ name: "file.write", arguments: args });
  const frame = await h.peer.nextRequest();
  assert.equal(frame.payload.request_id, args.request_id);
  h.peer.close();

  const result = await pending;
  assert.equal(result.status, "reconciliation_required");
  assert.equal(result.request_id, args.request_id);
  assert.equal(result.automatic_replay, false);
  assert.equal(result.fallback_authorized, false);
  const delivery = h.state.deliveryByRequestId(args.request_id);
  assert.equal(delivery.status, "reconciliation_required");
  assert.equal(delivery.result?.automatic_replay, false);
});

test("stale direct capability identity blocks candidate use before new dispatch", async (t) => {
  const h = await createHarness(t);
  const direct = h.gateway();
  await direct.describe();

  const record = h.state.state.devices.find((item) => item.deviceId);
  record.capabilities = {
    ...record.capabilities,
    executor: {
      ...record.capabilities.executor,
      digest: "f".repeat(64),
    },
  };
  // Deliberately preserve the old signed digest so discovery detects the drift
  // rather than accepting arbitrary translated data.
  await assert.rejects(
    direct.listTools(),
    (error) => [
      "DIRECT_LANE_UNAVAILABLE",
      "DIRECT_CAPABILITY_INCONSISTENT",
    ].includes(error.code),
  );
  assert.equal(h.state.listDeliveries().length, 0);
});

test("direct lane unavailable remains a blocker; no GitHub authority fallback is performed by the candidate adapter", async (t) => {
  const h = await createHarness(t);
  const direct = h.gateway();
  await h.remote.close();

  await assert.rejects(
    direct.health(),
    (error) => error.code === "DIRECT_LANE_UNAVAILABLE",
  );
  assert.equal(h.state.listDeliveries().length, 0);
});
