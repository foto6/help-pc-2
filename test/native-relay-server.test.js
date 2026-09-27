import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import {
  JsonRelayStateStore,
  NativeRelayServer,
  NativeRelayState,
  REMOTE_FRAME_VERSION,
  decodeRelayFrame,
  relayDigestJson,
  encodeRelayFrame,
  relaySha256Hex,
} from "../src/index.js";

const CONTROL_TOKEN = "control-token-0123456789abcdef-0123456789abcdef";

function credential(byte = "a", generation = 1) {
  return {
    generation,
    secret: Buffer.alloc(32, byte),
  };
}

function helloPayload(capabilities = { registry_version: "capabilities.v1", tools: ["safe.test"] }) {
  return {
    protocol_version: REMOTE_FRAME_VERSION,
    hello_nonce: "hello-nonce-0001",
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

async function connectDevice(serverAddress, {
  deviceId = "device-1",
  epoch = "epoch-device-0001",
  token = credential("a", 1),
  capabilities,
} = {}) {
  const ws = new WebSocket(serverAddress.websocket_url, {
    perMessageDeflate: false,
  });
  const queue = makeQueue(ws);
  await once(ws, "open");
  let outboundSequence = 1;
  ws.send(encodeRelayFrame({
    deviceId,
    sessionEpoch: epoch,
    sequence: outboundSequence,
    type: "hello",
    payload: helloPayload(capabilities),
    credential: token,
  }));
  const rawWelcome = await queue.next();
  const welcome = decodeRelayFrame(rawWelcome, {
    credentials: token,
    expectedDeviceId: deviceId,
    expectedSessionEpoch: epoch,
  });
  assert.equal(welcome.type, "welcome");
  assert.deepEqual(welcome.payload, {
    protocol_version: REMOTE_FRAME_VERSION,
    hello_nonce: "hello-nonce-0001",
    accepted: true,
  });
  return {
    ws,
    queue,
    deviceId,
    epoch,
    token,
    get sequence() { return outboundSequence; },
    setCredential(next) { this.token = next; },
    send(type, payload, overrideToken = null) {
      outboundSequence += 1;
      const raw = encodeRelayFrame({
        deviceId,
        sessionEpoch: epoch,
        sequence: outboundSequence,
        type,
        payload,
        credential: overrideToken ?? this.token,
      });
      ws.send(raw);
      return raw;
    },
    decode(raw, overrideToken = null) {
      return decodeRelayFrame(raw, {
        credentials: overrideToken ?? this.token,
        expectedDeviceId: deviceId,
        expectedSessionEpoch: epoch,
      });
    },
    close() {
      try { ws.close(); } catch {}
    },
  };
}

async function makeRelay(t, {
  state = new NativeRelayState(),
  token = credential("a", 1),
  deviceId = "device-1",
  server = {},
} = {}) {
  state.registerDevice({
    deviceId,
    generation: token.generation,
    secret: token.secret,
    metadata: { label: "test-device" },
  });
  const relay = new NativeRelayServer({
    state,
    controlToken: CONTROL_TOKEN,
    port: 0,
    heartbeatIntervalMs: 60_000,
    heartbeatTimeoutMs: 120_000,
    idleTimeoutMs: 120_000,
    ...server,
  });
  const address = await relay.start();
  t.after(async () => {
    await relay.stop();
  });
  return { relay, address, token, deviceId };
}

test("pinned help-pc-1 protocol byte vector is exact", () => {
  const fixture = JSON.parse(readFileSync(
    new URL("./fixtures/pc-remote-transport-vector-v1.json", import.meta.url),
    "utf8",
  ));
  assert.equal(
    fixture.contract_source.commit,
    "8df29aad32a6cb142dff6721f92fca74a080e441",
  );
  const raw = encodeRelayFrame({
    deviceId: fixture.frame.device_id,
    sessionEpoch: fixture.frame.session_epoch,
    sequence: fixture.frame.sequence,
    type: fixture.frame.type,
    payload: fixture.frame.payload,
    credential: {
      generation: fixture.token.generation,
      secret: Buffer.from(fixture.token.secret_base64, "base64"),
    },
  });
  assert.equal(raw, fixture.encoded_utf8);
});

test("authenticated websocket registers one sanitized online device", async (t) => {
  const { relay, address, token } = await makeRelay(t);
  const peer = await connectDevice(address, { token });
  t.after(() => peer.close());

  const devices = relay.listDevices();
  assert.equal(devices.length, 1);
  assert.equal(devices[0].device_id, "device-1");
  assert.equal(devices[0].online, true);
  assert.ok(devices[0].capabilities_digest);
  const serialized = JSON.stringify(devices);
  assert.equal(serialized.includes("secret"), false);
  assert.equal(serialized.includes(token.secret.toString("base64")), false);

  const unauth = await fetch(`${address.url}/v1/relay/health`);
  assert.equal(unauth.status, 401);
  const health = await fetch(`${address.url}/v1/relay/health`, {
    headers: { authorization: `Bearer ${CONTROL_TOKEN}` },
  });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).protocol_version, REMOTE_FRAME_VERSION);
});

test("request routes to exactly one live session and duplicate delivery does not redeliver", async (t) => {
  const { relay, address, token } = await makeRelay(t);
  const peer = await connectDevice(address, { token });
  t.after(() => peer.close());

  const input = {
    device_id: "device-1",
    request_id: "req-route-1",
    request_version: "control.request.v1",
    delivery_id: "delivery-route-1",
    semantics: "side_effecting",
    body: { opaque: { operation: "not-interpreted" } },
  };
  const pending = relay.dispatchRequest(input, { waitTimeoutMs: 2_000 });
  const requestFrame = peer.decode(await peer.queue.next());
  assert.equal(requestFrame.type, "request");
  assert.deepEqual(requestFrame.payload, {
    request_id: input.request_id,
    request_version: input.request_version,
    delivery_id: input.delivery_id,
    semantics: input.semantics,
    body: input.body,
  });

  peer.send("response", {
    request_id: input.request_id,
    request_version: input.request_version,
    status: "OK",
    body: { ok: true },
    stream: null,
  });
  const completed = await pending;
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.result.body, { ok: true });

  const duplicate = await relay.dispatchRequest(input);
  assert.deepEqual(duplicate, completed);
  await assert.rejects(peer.queue.next(100), /timeout/);
});

test("disconnect after side-effect dispatch becomes reconciliation-required and never redelivers", async (t) => {
  const { relay, address, token } = await makeRelay(t);
  const peer = await connectDevice(address, { token });

  const input = {
    device_id: "device-1",
    request_id: "req-loss-1",
    request_version: "control.request.v1",
    delivery_id: "delivery-loss-1",
    semantics: "side_effecting",
    body: { opaque: "once" },
  };
  const pending = relay.dispatchRequest(input, { waitTimeoutMs: 2_000 });
  const frame = peer.decode(await peer.queue.next());
  assert.equal(frame.type, "request");
  peer.ws.close();
  const result = await pending;
  assert.equal(result.status, "reconciliation_required");
  assert.equal(result.automatic_replay, false);

  const replay = await relay.dispatchRequest(input);
  assert.equal(replay.status, "reconciliation_required");
});

test("reconnect uses a new epoch and repeated old epoch is rejected", async (t) => {
  const { relay, address, token } = await makeRelay(t);
  const first = await connectDevice(address, {
    token,
    epoch: "epoch-reconnect-0001",
  });
  first.close();
  await once(first.ws, "close");

  const second = await connectDevice(address, {
    token,
    epoch: "epoch-reconnect-0002",
  });
  t.after(() => second.close());
  assert.equal(relay.listDevices()[0].last_session_epoch, "epoch-reconnect-0002");

  const stale = new WebSocket(address.websocket_url);
  const queue = makeQueue(stale);
  await once(stale, "open");
  stale.send(encodeRelayFrame({
    deviceId: "device-1",
    sessionEpoch: "epoch-reconnect-0001",
    sequence: 1,
    type: "hello",
    payload: helloPayload(),
    credential: token,
  }));
  await assert.rejects(queue.next(1_000), /closed/);
});

test("forged device and duplicate inbound frame are rejected", async (t) => {
  const { address, token } = await makeRelay(t);
  const forged = new WebSocket(address.websocket_url);
  const forgedQueue = makeQueue(forged);
  await once(forged, "open");
  forged.send(encodeRelayFrame({
    deviceId: "forged-device",
    sessionEpoch: "epoch-forged-0001",
    sequence: 1,
    type: "hello",
    payload: helloPayload(),
    credential: token,
  }));
  await assert.rejects(forgedQueue.next(1_000), /closed/);

  const peer = await connectDevice(address, {
    token,
    epoch: "epoch-replay-0001",
  });
  const raw = peer.send("heartbeat", { last_inbound_sequence: 1 });
  const ack = peer.decode(await peer.queue.next());
  assert.equal(ack.type, "heartbeat_ack");
  peer.ws.send(raw);
  await once(peer.ws, "close");
});

test("reordered stream chunk fails closed and read-only delivery is not replayed", async (t) => {
  const { relay, address, token } = await makeRelay(t);
  const peer = await connectDevice(address, {
    token,
    epoch: "epoch-stream-0001",
  });
  const input = {
    device_id: "device-1",
    request_id: "req-stream-1",
    request_version: "control.request.v1",
    delivery_id: "delivery-stream-1",
    semantics: "read_only",
    body: { read: "opaque" },
  };
  const pending = relay.dispatchRequest(input, { waitTimeoutMs: 2_000 });
  assert.equal(peer.decode(await peer.queue.next()).type, "request");

  const data = Buffer.from("abcd");
  const digest = relaySha256Hex(data);
  peer.send("response", {
    request_id: input.request_id,
    request_version: input.request_version,
    status: "OK",
    body: { metadata: true },
    stream: {
      stream_id: `${input.request_id}:${digest.slice(0, 16)}`,
      kind: "process_output",
      total_bytes: data.length,
      chunk_bytes: 2,
      chunk_count: 2,
      sha256: digest,
    },
  });
  const second = data.subarray(2);
  peer.send("stream_chunk", {
    request_id: input.request_id,
    stream_id: `${input.request_id}:${digest.slice(0, 16)}`,
    index: 1,
    chunk_count: 2,
    byte_count: second.length,
    sha256: relaySha256Hex(second),
    data_b64: second.toString("base64"),
  });
  const result = await pending;
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "DEVICE_CONNECTION_LOST");
});

test("ordered chunks are bounded, digested, and returned to the originating delivery", async (t) => {
  const { relay, address, token } = await makeRelay(t);
  const peer = await connectDevice(address, {
    token,
    epoch: "epoch-stream-good1",
  });
  t.after(() => peer.close());
  const input = {
    device_id: "device-1",
    request_id: "req-stream-good",
    request_version: "control.request.v1",
    delivery_id: "delivery-stream-good",
    semantics: "read_only",
    body: { read: "opaque" },
  };
  const pending = relay.dispatchRequest(input, { waitTimeoutMs: 2_000 });
  assert.equal(peer.decode(await peer.queue.next()).type, "request");
  const data = Buffer.from("abcdef");
  const digest = relaySha256Hex(data);
  const streamId = `${input.request_id}:${digest.slice(0, 16)}`;
  peer.send("response", {
    request_id: input.request_id,
    request_version: input.request_version,
    status: "OK",
    body: { metadata: true },
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
      request_id: input.request_id,
      stream_id: streamId,
      index,
      chunk_count: 2,
      byte_count: chunk.length,
      sha256: relaySha256Hex(chunk),
      data_b64: chunk.toString("base64"),
    });
  }
  peer.send("stream_end", {
    request_id: input.request_id,
    stream_id: streamId,
    chunk_count: 2,
    total_bytes: data.length,
    sha256: digest,
  });
  const result = await pending;
  assert.equal(result.status, "completed");
  assert.equal(
    Buffer.from(result.result.stream.data_b64, "base64").toString("utf8"),
    "abcdef",
  );
});

test("credential rotation overlaps until acknowledged, then old generation is rejected", async (t) => {
  const { relay, address, token } = await makeRelay(t);
  const peer = await connectDevice(address, {
    token,
    epoch: "epoch-rotate-0001",
  });
  const next = credential("b", 2);
  const rotationPromise = relay.rotateDeviceCredential({
    deviceId: "device-1",
    newGeneration: 2,
    newSecret: next.secret,
    overlapMs: 10_000,
    waitTimeoutMs: 2_000,
  });
  const rotationFrame = peer.decode(await peer.queue.next(), token);
  assert.equal(rotationFrame.type, "token.rotate");
  assert.equal(rotationFrame.payload.new_generation, 2);
  peer.setCredential(next);
  peer.send("token.rotated", { generation: 2 });
  const rotation = await rotationPromise;
  assert.equal(rotation.acknowledged, true);
  assert.equal(relay.listDevices()[0].previous_generation_expires_at_ms, null);

  peer.send("heartbeat", { last_inbound_sequence: 1 }, token);
  await once(peer.ws, "close");
});

test("immediate device revocation closes session and discovery exposes no credential material", async (t) => {
  const { relay, address, token } = await makeRelay(t);
  const peer = await connectDevice(address, {
    token,
    epoch: "epoch-revoke-0001",
  });
  const closed = once(peer.ws, "close");
  const view = relay.revokeDevice("device-1");
  assert.equal(view.status, "revoked");
  await closed;
  const serialized = JSON.stringify(relay.listDevices());
  assert.equal(serialized.includes(token.secret.toString("base64")), false);
  assert.equal(serialized.includes("secret_b64"), false);
});

test("durable restart converts unresolved side effect to reconciliation and read-only to retryable failure", () => {
  const root = mkdtempSync(join(tmpdir(), "pc-native-relay-state-"));
  try {
    const path = join(root, "relay.json");
    const store = new JsonRelayStateStore(path);
    const first = new NativeRelayState({ store });
    first.registerDevice({
      deviceId: "device-1",
      generation: 1,
      secret: credential("z").secret,
    });
    first.createDelivery({
      deviceId: "device-1",
      requestId: "req-restart-side",
      requestVersion: "control.request.v1",
      deliveryId: "delivery-restart-side",
      semantics: "side_effecting",
      fingerprint: "fp-side",
      sessionEpoch: "epoch-restart-0001",
    });
    first.createDelivery({
      deviceId: "device-1",
      requestId: "req-restart-read",
      requestVersion: "control.request.v1",
      deliveryId: "delivery-restart-read",
      semantics: "read_only",
      fingerprint: "fp-read",
      sessionEpoch: "epoch-restart-0001",
    });

    const restarted = new NativeRelayState({
      store: new JsonRelayStateStore(path),
    });
    assert.equal(
      restarted.deliveryView("delivery-restart-side").status,
      "reconciliation_required",
    );
    const readOnly = restarted.deliveryView("delivery-restart-read");
    assert.equal(readOnly.status, "failed");
    assert.equal(readOnly.error.code, "RESULT_LOST_AFTER_RELAY_RESTART");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("relay cancellation never claims an already-dispatched side effect was cancelled", async (t) => {
  const { relay, address, token } = await makeRelay(t);
  const peer = await connectDevice(address, {
    token,
    epoch: "epoch-cancel-0001",
  });
  t.after(() => peer.close());
  const input = {
    device_id: "device-1",
    request_id: "req-cancel-side",
    request_version: "control.request.v1",
    delivery_id: "delivery-cancel-side",
    semantics: "side_effecting",
    body: { opaque: "side-effect" },
  };
  const pending = relay.dispatchRequest(input, { waitTimeoutMs: 2_000 });
  assert.equal(peer.decode(await peer.queue.next()).type, "request");
  const cancelled = relay.cancelRequest({
    deliveryId: input.delivery_id,
    reason: "operator_cancel",
  });
  assert.equal(cancelled.status, "reconciliation_required");
  assert.equal(cancelled.automatic_replay, false);
  assert.equal((await pending).status, "reconciliation_required");
  await assert.rejects(peer.queue.next(100), /timeout/);
});

test("discovery recursively redacts secret-shaped capability and metadata fields", () => {
  const state = new NativeRelayState();
  state.registerDevice({
    deviceId: "device-redact",
    generation: 1,
    secret: credential("r").secret,
    metadata: {
      label: "safe",
      api_token: "must-not-appear",
      nested: { password: "must-not-appear-either" },
    },
  });
  const internal = state.state.devices[0];
  internal.capabilities = {
    tools: ["opaque"],
    auth: { bearer: "hidden" },
    nested: { clientSecret: "hidden-too" },
  };
  const view = state.deviceView("device-redact", false);
  const serialized = JSON.stringify(view);
  assert.equal(serialized.includes("must-not-appear"), false);
  assert.equal(serialized.includes("hidden-too"), false);
  assert.equal(view.metadata.api_token, "[REDACTED]");
  assert.equal(view.capabilities.auth, "[REDACTED]");
});
