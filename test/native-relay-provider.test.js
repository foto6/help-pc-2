import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import {
  ControlPlane,
  HelpPc1Adapter,
  JsonRelayStateStore,
  NativeControlFacade,
  NativeRelayExecutorProvider,
  NativeRelayServer,
  NativeRelayState,
  NATIVE_CONTROL_PROTOCOL_V1,
  NATIVE_RELAY_PROVIDER_IDENTITY,
  NATIVE_RESPONSE_V1,
  REMOTE_FRAME_VERSION,
  TOOL_REGISTRY_DIGEST,
  createNativeRelayExecutorBridge,
  decodeRelayFrame,
  encodeRelayFrame,
  nativeCapabilityManifestV1,
  relayDigestJson,
  relaySha256Hex,
  toolDefinition,
} from "../src/index.js";

const CONTROL_TOKEN = "provider-control-token-0123456789abcdef-0123456789";
const DEVICE_ID = "provider-device-1";
const EXECUTOR_DIGEST = "d".repeat(64);
const DEVICE_TOKEN = { generation: 1, secret: Buffer.alloc(32, "p") };
const CURRENT_WIRE = JSON.parse(readFileSync(
  new URL("./fixtures/pc-remote-transport-vector-v1.json", import.meta.url),
  "utf8",
));

function executorCapabilities(digest = EXECUTOR_DIGEST) {
  return {
    contract_version: "pc_executor.capabilities.v1",
    digest,
    actions: [
      "fs.stat",
      "fs.read_text",
      "fs.write_text",
      "system.health",
    ],
  };
}

function deviceCapabilities(digest = EXECUTOR_DIGEST) {
  return nativeCapabilityManifestV1({
    executorCapabilities: executorCapabilities(digest),
  });
}

function helloPayload(capabilities = deviceCapabilities()) {
  return {
    protocol_version: REMOTE_FRAME_VERSION,
    hello_nonce: "provider-hello-0001",
    capabilities,
    capabilities_digest: relayDigestJson(capabilities),
    limits: {
      max_frame_bytes: 1_048_576,
      max_request_bytes: 524_288,
      max_chunk_bytes: 65_536,
      max_stream_bytes: 8_388_608,
    },
  };
}

function makeQueue(ws) {
  const messages = [];
  const waiters = [];
  ws.on("message", (data) => {
    const next = waiters.shift();
    if (next) next.resolve(Buffer.from(data));
    else messages.push(Buffer.from(data));
  });
  ws.on("close", (code, reason) => {
    while (waiters.length) {
      waiters.shift().reject(new Error(`closed:${code}:${String(reason)}`));
    }
  });
  return {
    next(timeoutMs = 2_000) {
      if (messages.length) return Promise.resolve(messages.shift());
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject };
        waiters.push(waiter);
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error("message timeout"));
        }, timeoutMs);
        waiter.resolve = (value) => {
          clearTimeout(timer);
          resolve(value);
        };
        waiter.reject = (error) => {
          clearTimeout(timer);
          reject(error);
        };
      });
    },
  };
}

async function connectDevice(address, {
  epoch = "epoch-provider-0001",
  capabilities = deviceCapabilities(),
  token = DEVICE_TOKEN,
} = {}) {
  const ws = new WebSocket(address.websocket_url, { perMessageDeflate: false });
  const queue = makeQueue(ws);
  await once(ws, "open");
  let sequence = 1;
  ws.send(encodeRelayFrame({
    deviceId: DEVICE_ID,
    sessionEpoch: epoch,
    sequence,
    type: "hello",
    payload: helloPayload(capabilities),
    credential: token,
  }));
  const welcome = decodeRelayFrame(await queue.next(), {
    credentials: token,
    expectedDeviceId: DEVICE_ID,
    expectedSessionEpoch: epoch,
  });
  assert.equal(welcome.type, "welcome");
  return {
    ws,
    queue,
    epoch,
    token,
    send(type, payload) {
      sequence += 1;
      ws.send(encodeRelayFrame({
        deviceId: DEVICE_ID,
        sessionEpoch: epoch,
        sequence,
        type,
        payload,
        credential: token,
      }));
    },
    decode(raw) {
      return decodeRelayFrame(raw, {
        credentials: token,
        expectedDeviceId: DEVICE_ID,
        expectedSessionEpoch: epoch,
      });
    },
    close() {
      try { ws.terminate(); } catch {}
    },
  };
}

function registerState(store = null) {
  const state = new NativeRelayState({ store });
  state.registerDevice({
    deviceId: DEVICE_ID,
    generation: DEVICE_TOKEN.generation,
    secret: DEVICE_TOKEN.secret,
    metadata: { label: "provider-test" },
  });
  return state;
}

async function startRelay(t, {
  state = registerState(),
  port = 0,
  autoCleanup = true,
} = {}) {
  const relay = new NativeRelayServer({
    state,
    controlToken: CONTROL_TOKEN,
    host: "127.0.0.1",
    port,
    heartbeatIntervalMs: 60_000,
    heartbeatTimeoutMs: 120_000,
    idleTimeoutMs: 120_000,
  });
  const address = await relay.start();
  if (autoCleanup) {
    t.after(async () => {
      await relay.stop();
    });
  }
  return { relay, address, state };
}

function provider(address, options = {}) {
  return new NativeRelayExecutorProvider({
    relayUrl: address.url,
    relayToken: CONTROL_TOKEN,
    deviceId: DEVICE_ID,
    waitTimeoutMs: 2_000,
    ...options,
  });
}

function contextFor(logicalRequestId, nativeTool, {
  sessionId = "native-session-1",
  executorDigest = EXECUTOR_DIGEST,
  signal = undefined,
} = {}) {
  return {
    logicalRequestId,
    ...(signal ? { signal } : {}),
    actionMetadata: {
      native_tool: nativeTool,
      effect: toolDefinition(nativeTool).effect,
      native_session_id: sessionId,
      native_request_id: logicalRequestId,
      native_executor_digest: executorDigest,
    },
  };
}

function bridgeRequest(controlActionId, nativeTool, params = {}) {
  return {
    request_id: controlActionId,
    action: toolDefinition(nativeTool).executorAction,
    params,
    dry_run: false,
  };
}

function nativeResponse(frame, {
  status = "completed",
  data = {},
  error = null,
  stream = null,
} = {}) {
  return {
    request_id: frame.payload.request_id,
    request_version: frame.payload.request_version,
    status: "OK",
    body: {
      contract_version: NATIVE_RESPONSE_V1,
      request_id: frame.payload.request_id,
      session_id: frame.payload.body.session_id,
      status,
      data,
      error,
      stream,
    },
    stream: null,
  };
}

async function receiveRequest(peer) {
  const frame = peer.decode(await peer.queue.next());
  assert.equal(frame.type, "request");
  assert.equal(frame.payload.request_version, NATIVE_CONTROL_PROTOCOL_V1);
  assert.equal(frame.payload.body.contract_version, NATIVE_CONTROL_PROTOCOL_V1);
  return frame;
}

test("provider pins current PC transport fixture and publishes package/module identity", async (t) => {
  assert.equal(
    CURRENT_WIRE.contract_source.commit,
    "b62da531ac045c2ccd3b4c6b82da7bb55cb93b8c",
  );
  assert.equal(JSON.parse(CURRENT_WIRE.encoded_utf8).version, REMOTE_FRAME_VERSION);
  assert.deepEqual(NATIVE_RELAY_PROVIDER_IDENTITY, {
    package: "pc-control-plane",
    package_version: "0.9.0",
    module: "src/native-relay-provider.js",
    factory_export: "createExecutorBridge",
    provider_contract: "pc.native.relay.executor_bridge.v1",
    relay_api: "pc.native.relay.control_api.v1",
    device_transport: "pc_remote_transport.frame.v1",
  });

  const { address } = await startRelay(t);
  const bridge = createNativeRelayExecutorBridge({
    relayUrl: address.url,
    relayToken: CONTROL_TOKEN,
    deviceId: DEVICE_ID,
  });
  const serialized = JSON.stringify(bridge);
  assert.equal(serialized.includes(CONTROL_TOKEN), false);
  assert.equal(typeof bridge.invoke, "function");
  assert.equal(typeof bridge.readCapabilities, "function");
  assert.equal(typeof bridge.readEvidence, "function");
  assert.equal(bridge.preflight, undefined);
  assert.equal(bridge.bindExecutionContext, undefined);
});

test("real relay discovery preserves signed public credential policy boolean without leaking credentials", async (t) => {
  const { address } = await startRelay(t);
  // R9 real-PC manifest has exactly this explicitly non-secret boolean.
  // Previously publicDevice recursively redacted it into "[REDACTED]",
  // breaking the digest checked by NativeRelayExecutorProvider at startup.
  const capabilities = {
    ...deviceCapabilities(),
    tool_parity: { safety: { credential_entry_allowed: false } },
  };
  const peer = await connectDevice(address, { capabilities });
  t.after(() => peer.close());

  const response = await fetch(new URL("/v1/relay/devices", address.url), {
    headers: { authorization: `Bearer ${CONTROL_TOKEN}` },
  });
  assert.equal(response.status, 200);
  const discovery = await response.json();
  const publicDevice = discovery.devices.find((item) => item.device_id === DEVICE_ID);
  assert.equal(publicDevice.online, true);
  assert.equal(publicDevice.capabilities.tool_parity.safety.credential_entry_allowed, false);
  assert.equal(typeof publicDevice.capabilities.tool_parity.safety.credential_entry_allowed, "boolean");
  assert.equal(relayDigestJson(publicDevice.capabilities), publicDevice.capabilities_digest);
  assert.equal(publicDevice.capabilities_digest, relayDigestJson(capabilities));

  const p = provider(address);
  const executor = await p.readCapabilities();
  assert.equal(executor.digest, EXECUTOR_DIGEST);
});

test("public relay redaction exception is path- and type-specific; metadata stays private", () => {
  const state = new NativeRelayState();
  state.registerDevice({
    deviceId: DEVICE_ID,
    generation: DEVICE_TOKEN.generation,
    secret: DEVICE_TOKEN.secret,
    metadata: {
      credential_entry_allowed: false,
      token: "fixture-private",
      tool_parity: { safety: { credential_entry_allowed: false } },
    },
  });
  const capabilities = {
    ...deviceCapabilities(),
    tool_parity: {
      safety: {
        credential_entry_allowed: false,
        credential_debug: "fixture-private",
        authorization: "fixture-private",
      },
    },
    arbitrary: { credential_entry_allowed: true },
  };
  state.beginSession({
    deviceId: DEVICE_ID,
    sessionEpoch: "epoch-public-redaction-0001",
    capabilities,
    capabilitiesDigest: relayDigestJson(capabilities),
    limits: {},
  });
  const view = state.deviceView(DEVICE_ID, true);
  assert.equal(view.capabilities.tool_parity.safety.credential_entry_allowed, false);
  assert.equal(view.capabilities.tool_parity.safety.credential_debug, "[REDACTED]");
  assert.equal(view.capabilities.tool_parity.safety.authorization, "[REDACTED]");
  assert.equal(view.capabilities.arbitrary.credential_entry_allowed, "[REDACTED]");
  assert.equal(view.metadata.credential_entry_allowed, "[REDACTED]");
  assert.equal(view.metadata.token, "[REDACTED]");
  assert.equal(view.metadata.tool_parity.safety.credential_entry_allowed, "[REDACTED]");

  // Malformed type never qualifies for the one public-boolean exception.
  const wrongType = { ...capabilities, tool_parity: { safety: { credential_entry_allowed: "secret" } } };
  state.beginSession({
    deviceId: DEVICE_ID,
    sessionEpoch: "epoch-public-redaction-0002",
    capabilities: wrongType,
    capabilitiesDigest: relayDigestJson(wrongType),
    limits: {},
  });
  assert.equal(
    state.deviceView(DEVICE_ID, true).capabilities.tool_parity.safety.credential_entry_allowed,
    "[REDACTED]",
  );
});

test("provider accepts only authenticated loopback relay control origins", () => {
  assert.throws(
    () => new NativeRelayExecutorProvider({
      relayUrl: "http://0.0.0.0:9999",
      relayToken: CONTROL_TOKEN,
      deviceId: DEVICE_ID,
    }),
    /loopback/,
  );
  assert.throws(
    () => new NativeRelayExecutorProvider({
      relayUrl: "http://user:secret@127.0.0.1:9999",
      relayToken: CONTROL_TOKEN,
      deviceId: DEVICE_ID,
    }),
    /credentials/,
  );
});

test("read-only request preserves facade request_id through relay and returns provider result", async (t) => {
  const { address } = await startRelay(t);
  const peer = await connectDevice(address);
  t.after(() => peer.close());
  const p = provider(address);

  const caps = await p.readCapabilities();
  assert.equal(caps.digest, EXECUTOR_DIGEST);

  const pending = p.invoke(
    bridgeRequest("control-action-read", "file.info", { path: "C:\\tmp\\a.txt" }),
    contextFor("facade-read-1", "file.info"),
  );
  const frame = await receiveRequest(peer);
  assert.equal(frame.payload.request_id, "facade-read-1");
  assert.notEqual(frame.payload.delivery_id, frame.payload.request_id);
  assert.equal(frame.payload.body.request_id, "facade-read-1");
  assert.equal(frame.payload.body.session_id, "native-session-1");
  assert.equal(frame.payload.body.tool, "file.info");
  assert.equal(frame.payload.semantics, "read_only");

  peer.send("response", nativeResponse(frame, {
    data: { path: "C:\\tmp\\a.txt", size: 7 },
  }));
  const result = await pending;
  assert.equal(result.request_id, "control-action-read");
  assert.equal(result.action, "fs.stat");
  assert.equal(result.ok, true);
  assert.equal(result.data.size, 7);
  assert.equal(result.relay_delivery.logical_request_id, "facade-read-1");
});

test("real authenticated relay routes frozen v1 unchanged and parity-only rootless actions by explicit registry", async (t) => {
  const { address } = await startRelay(t);
  const capabilities = nativeCapabilityManifestV1({
    executorCapabilities: {
      contract_version: "pc_executor.capabilities.v1",
      digest: EXECUTOR_DIGEST,
      actions: ["device.info", "health.get", "config.get", "fs.stat"],
    },
  });
  const peer = await connectDevice(address, { capabilities });
  t.after(() => peer.close());
  const p = provider(address);
  await p.readCapabilities();

  for (const [name, wire, action] of [
    ["device.info", "device.info", "device.info"],
    ["device.ping", "device.health", "health.get"],
    ["config.get", "device.get_config", "config.get"],
  ]) {
    const rid = "r15-route-" + name.replaceAll(".", "-");
    const pending = p.invoke(bridgeRequest("control-" + rid, name), contextFor(rid, name));
    const frame = await receiveRequest(peer);
    assert.equal(frame.payload.request_id, rid);
    assert.equal(frame.payload.body.request_id, rid);
    assert.equal(frame.payload.body.registry_version, "pc.native.parity_tool_registry.v1");
    assert.equal(frame.payload.body.tool, wire);
    assert.equal(frame.payload.semantics, "read_only");
    assert.deepEqual(frame.payload.body.arguments, {});
    peer.send("response", nativeResponse(frame, { data: { routed: true } }));
    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(result.request_id, "control-" + rid);
    assert.equal(result.action, action);
  }

  const legacyPending = p.invoke(
    bridgeRequest("control-frozen-exact", "file.info", { path: "C:\\fixture\\known.txt" }),
    contextFor("r15-frozen-exact", "file.info"),
  );
  const frozen = await receiveRequest(peer);
  assert.equal(frozen.payload.body.registry_version, undefined,
    "frozen v1 must remain byte-compatible, with no injected version field");
  assert.equal(frozen.payload.body.tool, "file.info");
  assert.equal(frozen.payload.semantics, "read_only");
  peer.send("response", nativeResponse(frozen, { data: { size: 5 } }));
  const success = await legacyPending;
  assert.equal(success.ok, true);
  assert.equal(success.action, "fs.stat");
});

test("side effect completes once and duplicate same logical request never redelivers", async (t) => {
  const { address } = await startRelay(t);
  const peer = await connectDevice(address);
  t.after(() => peer.close());
  const p = provider(address);
  await p.readCapabilities();

  const request = bridgeRequest("control-action-write", "file.write", {
    path: "C:\\tmp\\out.txt",
    text: "once",
  });
  const context = contextFor("facade-write-once", "file.write");
  const firstPending = p.invoke(request, context);
  const frame = await receiveRequest(peer);
  assert.equal(frame.payload.semantics, "side_effecting");
  peer.send("response", nativeResponse(frame, {
    data: { written: true, bytes: 4 },
  }));
  const first = await firstPending;
  assert.equal(first.ok, true);

  const duplicate = await p.invoke(request, context);
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.data.bytes, 4);
  await assert.rejects(peer.queue.next(150), /timeout/);
});

test("duplicate logical request with different payload fails conflict without a second device dispatch", async (t) => {
  const { address } = await startRelay(t);
  const peer = await connectDevice(address);
  t.after(() => peer.close());
  const p = provider(address);
  await p.readCapabilities();
  const context = contextFor("facade-conflict", "file.write");

  const firstPending = p.invoke(
    bridgeRequest("control-conflict", "file.write", { path: "C:\\tmp\\x.txt", text: "a" }),
    context,
  );
  const frame = await receiveRequest(peer);
  peer.send("response", nativeResponse(frame, { data: { written: true } }));
  await firstPending;

  await assert.rejects(
    p.invoke(
      bridgeRequest("control-conflict", "file.write", { path: "C:\\tmp\\x.txt", text: "b" }),
      context,
    ),
    (error) => error.code === "DELIVERY_ID_CONFLICT" && error.dispatchState === "not_dispatched",
  );
  await assert.rejects(peer.queue.next(150), /timeout/);
});

test("disconnect after side-effect dispatch maps exactly to UNKNOWN_RECONCILE and lookup never redispatches", async (t) => {
  const { address } = await startRelay(t);
  const peer = await connectDevice(address);
  const p = provider(address);
  await p.readCapabilities();

  const request = bridgeRequest("control-loss", "file.write", {
    path: "C:\\tmp\\loss.txt",
    text: "once",
  });
  const context = contextFor("facade-loss-1", "file.write");
  const pending = p.invoke(request, context);
  const frame = await receiveRequest(peer);
  assert.equal(frame.payload.request_id, "facade-loss-1");
  peer.ws.close();
  await once(peer.ws, "close");

  await assert.rejects(
    pending,
    (error) => error.code === "UNKNOWN_RECONCILE"
      && error.dispatchState === "unknown"
      && error.outcomeUncertain === true
      && error.automaticReplay === false,
  );
  const evidence = await p.readEvidence(
    { request_id: "control-loss", action: "fs.write_text", execution_attempt: 1 },
    context,
  );
  assert.equal(evidence.outcome, "unknown");
  assert.equal(evidence.reason, "UNKNOWN_RECONCILE");
  assert.equal(evidence.automaticReplay, false);
});

test("result loss is recovered by relay lookup without sending a second device request", async (t) => {
  const { address } = await startRelay(t);
  const peer = await connectDevice(address);
  t.after(() => peer.close());
  let losePostResponse = true;
  const lossyFetch = async (...args) => {
    const response = await fetch(...args);
    const url = new URL(String(args[0]));
    const method = args[1]?.method ?? "GET";
    if (losePostResponse && method === "POST" && url.pathname === "/v1/relay/request") {
      losePostResponse = false;
      await response.clone().json();
      throw new Error("simulated result loss");
    }
    return response;
  };
  const p = provider(address, { fetchImpl: lossyFetch });
  await p.readCapabilities();

  const context = contextFor("facade-result-loss", "file.write");
  const pending = p.invoke(
    bridgeRequest("control-result-loss", "file.write", {
      path: "C:\\tmp\\result-loss.txt",
      text: "once",
    }),
    context,
  );
  const frame = await receiveRequest(peer);
  peer.send("response", nativeResponse(frame, { data: { written: true } }));

  await assert.rejects(
    pending,
    (error) => error.code === "RELAY_CONTROL_UNAVAILABLE"
      && error.dispatchState === "unknown"
      && error.outcomeUncertain === true,
  );
  const evidence = await p.readEvidence(
    { request_id: "control-result-loss", action: "fs.write_text", execution_attempt: 1 },
    context,
  );
  assert.equal(evidence.outcome, "succeeded");
  await assert.rejects(peer.queue.next(150), /timeout/);
});

test("durable relay restart keeps uncertain side effect reconciliation-only", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "relay-provider-restart-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const statePath = join(root, "relay-state.json");
  const state = registerState(new JsonRelayStateStore(statePath));
  const first = await startRelay(t, { state, autoCleanup: false });
  const port = Number(new URL(first.address.url).port);
  const peer = await connectDevice(first.address);
  const p = provider(first.address);
  await p.readCapabilities();

  const context = contextFor("facade-restart-loss", "file.write");
  const pending = p.invoke(
    bridgeRequest("control-restart-loss", "file.write", {
      path: "C:\\tmp\\restart.txt",
      text: "once",
    }),
    context,
  );
  await receiveRequest(peer);
  await first.relay.stop();
  await assert.rejects(pending);
  try { peer.close(); } catch {}

  const restartedState = new NativeRelayState({
    store: new JsonRelayStateStore(statePath),
  });
  const second = await startRelay(t, {
    state: restartedState,
    port,
    autoCleanup: true,
  });
  assert.equal(second.address.url, first.address.url);
  const evidence = await p.readEvidence(
    { request_id: "control-restart-loss", action: "fs.write_text", execution_attempt: 1 },
    context,
  );
  assert.equal(evidence.outcome, "unknown");
  assert.equal(evidence.reason, "UNKNOWN_RECONCILE");
  assert.equal(evidence.automaticReplay, false);
});

test("bound provider rejects stale session epoch and capability digest drift before dispatch", async (t) => {
  const { relay, address, state } = await startRelay(t);
  const firstPeer = await connectDevice(address, { epoch: "epoch-bind-0001" });
  const p = provider(address);
  await p.readCapabilities();

  firstPeer.close();
  await once(firstPeer.ws, "close");
  const secondPeer = await connectDevice(address, { epoch: "epoch-bind-0002" });
  t.after(() => secondPeer.close());
  await assert.rejects(
    p.readCapabilities(),
    (error) => error.code === "STALE_DEVICE_SESSION" && error.dispatchState === "not_dispatched",
  );

  const fresh = provider(address);
  await fresh.readCapabilities();
  const internal = state.state.devices.find((item) => item.deviceId === DEVICE_ID);
  internal.capabilities = deviceCapabilities("e".repeat(64));
  internal.capabilitiesDigest = relayDigestJson(internal.capabilities);
  await assert.rejects(
    fresh.readCapabilities(),
    (error) => error.code === "CAPABILITY_DRIFT" && error.dispatchState === "not_dispatched",
  );
  assert.equal(relay.listDevices()[0].online, true);
});

test("cancellation race after side-effect dispatch is reconciliation-required, never proven cancelled", async (t) => {
  const { address } = await startRelay(t);
  const peer = await connectDevice(address);
  t.after(() => peer.close());
  const p = provider(address);
  await p.readCapabilities();

  const controller = new AbortController();
  const context = contextFor("facade-cancel-race", "file.write", {
    signal: controller.signal,
  });
  const pending = p.invoke(
    bridgeRequest("control-cancel-race", "file.write", {
      path: "C:\\tmp\\cancel-race.txt",
      text: "once",
    }),
    context,
  );
  await receiveRequest(peer);
  controller.abort();

  await assert.rejects(
    pending,
    (error) => error.code === "UNKNOWN_RECONCILE"
      && error.dispatchState === "unknown"
      && error.automaticReplay === false,
  );
  const evidence = await p.readEvidence(
    { request_id: "control-cancel-race", action: "fs.write_text", execution_attempt: 1 },
    contextFor("facade-cancel-race", "file.write"),
  );
  assert.equal(evidence.outcome, "unknown");
  assert.equal(evidence.reason, "UNKNOWN_RECONCILE");
});

test("already-aborted request is cancelled before relay dispatch", async (t) => {
  const { address } = await startRelay(t);
  const peer = await connectDevice(address);
  t.after(() => peer.close());
  const p = provider(address);
  await p.readCapabilities();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    p.invoke(
      bridgeRequest("control-pre-cancel", "file.write", {
        path: "C:\\tmp\\pre-cancel.txt",
        text: "never",
      }),
      contextFor("facade-pre-cancel", "file.write", { signal: controller.signal }),
    ),
    (error) => error.code === "CANCELLED" && error.dispatchState === "not_dispatched",
  );
  await assert.rejects(peer.queue.next(150), /timeout/);
});

test("chunked relay response remains digest-validated and provider exposes assembled transport evidence", async (t) => {
  const { address } = await startRelay(t);
  const peer = await connectDevice(address);
  t.after(() => peer.close());
  const p = provider(address);
  await p.readCapabilities();

  const pending = p.invoke(
    bridgeRequest("control-chunk", "file.read", {
      path: "C:\\tmp\\chunk.txt",
      limit: 3,
    }),
    contextFor("facade-chunk", "file.read"),
  );
  const frame = await receiveRequest(peer);
  const data = Buffer.from("abcdef", "utf8");
  const digest = relaySha256Hex(data);
  const streamId = `${frame.payload.request_id}:${digest.slice(0, 16)}`;
  peer.send("response", {
    ...nativeResponse(frame, {
      data: { text: "abcdef", returned_bytes: 6 },
      stream: {
        bounded: true,
        encoding: "utf-8",
        transport: REMOTE_FRAME_VERSION,
      },
    }),
    stream: {
      stream_id: streamId,
      kind: "file_read",
      total_bytes: data.length,
      chunk_bytes: 3,
      chunk_count: 2,
      sha256: digest,
    },
  });
  for (let index = 0; index < 2; index += 1) {
    const chunk = data.subarray(index * 3, index * 3 + 3);
    peer.send("stream_chunk", {
      request_id: frame.payload.request_id,
      stream_id: streamId,
      index,
      chunk_count: 2,
      byte_count: chunk.length,
      sha256: relaySha256Hex(chunk),
      data_b64: chunk.toString("base64"),
    });
  }
  peer.send("stream_end", {
    request_id: frame.payload.request_id,
    stream_id: streamId,
    chunk_count: 2,
    total_bytes: data.length,
    sha256: digest,
  });

  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.data.text, "abcdef");
  assert.equal(
    Buffer.from(result.relay_delivery.stream.data_b64, "base64").toString("utf8"),
    "abcdef",
  );
});

test("real NativeFacade + HelpPc1Adapter uses relay provider for read-only and uncertain side effect", async (t) => {
  const { address } = await startRelay(t);
  const peer = await connectDevice(address);
  const bridge = createNativeRelayExecutorBridge({
    relayUrl: address.url,
    relayToken: CONTROL_TOKEN,
    deviceId: DEVICE_ID,
    waitTimeoutMs: 2_000,
  });
  const adapter = new HelpPc1Adapter({
    invoke: bridge.invoke,
    dryRun: false,
    readEvidence: bridge.readEvidence,
  });
  const controlPlane = new ControlPlane({ providers: [adapter] });
  let id = 0;
  const facade = new NativeControlFacade({
    controlPlane,
    capabilityProvider: bridge.readCapabilities,
    idFactory: () => `facade-session-${++id}`,
    secretFactory: () => "facade-resume-token",
  });
  const opened = await facade.openSession({
    desktopId: "desktop-relay-provider",
    client: {
      protocol_version: NATIVE_CONTROL_PROTOCOL_V1,
      registry_digest: TOOL_REGISTRY_DIGEST,
      executor_digest: EXECUTOR_DIGEST,
    },
  });

  const readPending = facade.invoke({
    contract_version: NATIVE_CONTROL_PROTOCOL_V1,
    session_id: opened.session_id,
    request_id: "facade-real-read",
    tool: "file.info",
    arguments: { path: "C:\\tmp\\facade.txt" },
  });
  const readFrame = await receiveRequest(peer);
  assert.equal(readFrame.payload.request_id, "facade-real-read");
  assert.equal(readFrame.payload.body.request_id, "facade-real-read");
  peer.send("response", nativeResponse(readFrame, {
    data: { path: "C:\\tmp\\facade.txt", size: 11 },
  }));
  const read = await readPending;
  assert.equal(read.status, "completed");
  assert.equal(read.request_id, "facade-real-read");
  assert.equal(read.data.size, 11);

  const writePending = facade.invoke({
    contract_version: NATIVE_CONTROL_PROTOCOL_V1,
    session_id: opened.session_id,
    request_id: "facade-real-uncertain",
    tool: "file.write",
    arguments: { path: "C:\\tmp\\facade-out.txt", text: "once" },
  });
  const writeFrame = await receiveRequest(peer);
  assert.equal(writeFrame.payload.request_id, "facade-real-uncertain");
  peer.ws.close();
  await once(peer.ws, "close");
  const write = await writePending;
  assert.equal(write.status, "reconciliation_required");
  assert.equal(write.request_id, "facade-real-uncertain");
  assert.equal(write.data.lookup_required, true);

  const action = controlPlane.listActions().find(
    (item) => item.correlationId === "facade-real-uncertain",
  );
  assert.equal(action.metadata.native_request_id, "facade-real-uncertain");
  assert.equal(action.metadata.native_session_id, opened.session_id);
});

test("relay authentication failures never expose configured bearer token", async (t) => {
  const { address } = await startRelay(t);
  const wrongToken = "wrong-provider-token-0123456789abcdef-012345";
  const p = new NativeRelayExecutorProvider({
    relayUrl: address.url,
    relayToken: wrongToken,
    deviceId: DEVICE_ID,
  });
  let caught = null;
  try {
    await p.readCapabilities();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught);
  assert.equal(caught.code, "AUTH_REQUIRED");
  assert.equal(String(caught.message).includes(wrongToken), false);
  assert.equal(JSON.stringify(caught).includes(wrongToken), false);
});

test("NativeFacade reconciles cached relay result after control response loss without redispatch", async (t) => {
  const { address } = await startRelay(t);
  const peer = await connectDevice(address);
  t.after(() => peer.close());

  let losePostResponse = true;
  const lossyFetch = async (...args) => {
    const response = await fetch(...args);
    const url = new URL(String(args[0]));
    const method = args[1]?.method ?? "GET";
    if (losePostResponse && method === "POST" && url.pathname === "/v1/relay/request") {
      losePostResponse = false;
      await response.clone().json();
      throw new Error("simulated facade response loss");
    }
    return response;
  };
  const bridge = createNativeRelayExecutorBridge({
    relayUrl: address.url,
    relayToken: CONTROL_TOKEN,
    deviceId: DEVICE_ID,
    waitTimeoutMs: 2_000,
    fetchImpl: lossyFetch,
  });
  const adapter = new HelpPc1Adapter({
    invoke: bridge.invoke,
    dryRun: false,
    readEvidence: bridge.readEvidence,
  });
  const controlPlane = new ControlPlane({ providers: [adapter] });
  const facade = new NativeControlFacade({
    controlPlane,
    capabilityProvider: bridge.readCapabilities,
    idFactory: () => "facade-loss-session",
    secretFactory: () => "facade-loss-resume",
  });
  const opened = await facade.openSession({
    desktopId: "desktop-relay-loss",
    client: {
      protocol_version: NATIVE_CONTROL_PROTOCOL_V1,
      registry_digest: TOOL_REGISTRY_DIGEST,
      executor_digest: EXECUTOR_DIGEST,
    },
  });

  const envelope = {
    contract_version: NATIVE_CONTROL_PROTOCOL_V1,
    session_id: opened.session_id,
    request_id: "facade-loss-recover",
    tool: "file.write",
    arguments: { path: "C:\\tmp\\loss-recover.txt", text: "once" },
  };
  const firstPending = facade.invoke(envelope);
  const frame = await receiveRequest(peer);
  peer.send("response", nativeResponse(frame, {
    data: { written: true, bytes: 4 },
  }));

  const first = await firstPending;
  assert.equal(first.status, "reconciliation_required");
  const recovered = await facade.invoke(envelope);
  assert.equal(recovered.status, "completed");
  assert.deepEqual(recovered.data, { written: true, bytes: 4 });
  assert.equal(recovered.request_id, "facade-loss-recover");
  await assert.rejects(peer.queue.next(150), /timeout/);

  const action = controlPlane.listActions().find(
    (item) => item.correlationId === "facade-loss-recover",
  );
  assert.equal(action.executionAttempts, 1);
  assert.equal(action.reconciliationAttempts, 1);
});

test("R18 real loopback relay provides frozen device boot epoch and rejects a different epoch",async t=>{
 const {address}=await startRelay(t);
 const old=await connectDevice(address,{epoch:"epoch-r18-real-0001"});
 t.after(()=>old.close());
 const bridge=createNativeRelayExecutorBridge({
  relayUrl:address.url,relayToken:CONTROL_TOKEN,deviceId:DEVICE_ID,
 });
 const pinned=await bridge.readDeviceIdentity();
 assert.deepEqual(pinned,{
  deviceId:DEVICE_ID,sessionEpoch:"epoch-r18-real-0001",
  executorDigest:EXECUTOR_DIGEST,
 });
 const closed=once(old.ws,"close");
 old.close();
 await closed;
 const fresh=await connectDevice(address,{epoch:"epoch-r18-real-0002"});
 t.after(()=>fresh.close());
 await assert.rejects(bridge.readDeviceIdentity(),
  e=>e.code==="STALE_DEVICE_SESSION");
});
