import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocket } from "ws";
import {
  NativeRelayServer,
  NativeRelayState,
  NATIVE_CONTROL_PROTOCOL_V1,
  NATIVE_RESPONSE_V1,
  REMOTE_FRAME_VERSION,
  decodeRelayFrame,
  encodeRelayFrame,
  nativeCapabilityManifestV1,
  relayDigestJson,
} from "../../src/index.js";

export const TEST_RELAY_CONTROL_TOKEN = "final-control-relay-token-0123456789abcdef-0123456789";
export const TEST_RELAY_DEVICE_ID = "final-control-device-1";
export const TEST_EXECUTOR_DIGEST = "e".repeat(64);
export const TEST_DEVICE_TOKEN = Object.freeze({
  generation: 1,
  secret: Buffer.alloc(32, "q"),
});

export const FINAL_PC_ACTIONS = Object.freeze([
  "device.info",
  "health.get",
  "config.get",
  "config.set",
  "identity.who_am_i",
  "agent.shutdown",
  "fs.read_text",
  "fs.read_bytes",
  "log.tail",
  "fs.read_multiple",
  "fs.write_text",
  "fs.append_text",
  "pdf.write",
  "fs.edit_text",
  "fs.list",
  "fs.move",
  "fs.mkdir",
  "fs.stat",
  "fs.hash",
  "search.start",
  "search.read",
  "search.stop",
  "search.list",
  "process.start",
  "shell.session.start",
  "process.read_output",
  "shell.session.read",
  "shell.session.write_stdin",
  "process.managed.list",
  "process.status",
  "process.terminate",
  "process.list",
  "process.inspect",
  "system.process.kill",
  "diagnostics.usage_stats",
  "diagnostics.recent_tool_calls",
]);

export function executorCapabilities({
  digest = TEST_EXECUTOR_DIGEST,
  actions = FINAL_PC_ACTIONS,
} = {}) {
  return {
    contract_version: "pc_executor.capabilities.v1",
    digest,
    actions: [...actions],
  };
}

export function deviceCapabilities(options = {}) {
  return nativeCapabilityManifestV1({
    executorCapabilities: executorCapabilities(options),
  });
}

function helloPayload(capabilities) {
  return {
    protocol_version: REMOTE_FRAME_VERSION,
    hello_nonce: "final-control-hello-0001",
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

export function createRelayState() {
  const state = new NativeRelayState();
  state.registerDevice({
    deviceId: TEST_RELAY_DEVICE_ID,
    generation: TEST_DEVICE_TOKEN.generation,
    secret: TEST_DEVICE_TOKEN.secret,
    metadata: { label: "final-control-e2e" },
  });
  return state;
}

export async function startRelay(t, {
  state = createRelayState(),
  port = 0,
  autoCleanup = true,
} = {}) {
  const relay = new NativeRelayServer({
    state,
    controlToken: TEST_RELAY_CONTROL_TOKEN,
    host: "127.0.0.1",
    port,
    heartbeatIntervalMs: 60_000,
    heartbeatTimeoutMs: 120_000,
    idleTimeoutMs: 120_000,
  });
  const address = await relay.start();
  if (autoCleanup) {
    t.after(async () => {
      await relay.stop().catch(() => {});
    });
  }
  return { relay, address, state };
}

export async function connectDevice(address, {
  epoch = "epoch-final-control-0001",
  capabilities = deviceCapabilities(),
  token = TEST_DEVICE_TOKEN,
} = {}) {
  const ws = new WebSocket(address.websocket_url, { perMessageDeflate: false });
  const queue = makeQueue(ws);
  await once(ws, "open");
  let sequence = 1;
  ws.send(encodeRelayFrame({
    deviceId: TEST_RELAY_DEVICE_ID,
    sessionEpoch: epoch,
    sequence,
    type: "hello",
    payload: helloPayload(capabilities),
    credential: token,
  }));
  const welcome = decodeRelayFrame(await queue.next(), {
    credentials: token,
    expectedDeviceId: TEST_RELAY_DEVICE_ID,
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
        deviceId: TEST_RELAY_DEVICE_ID,
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
        expectedDeviceId: TEST_RELAY_DEVICE_ID,
        expectedSessionEpoch: epoch,
      });
    },
    async nextRequest(timeoutMs = 2_000) {
      const frame = this.decode(await queue.next(timeoutMs));
      assert.equal(frame.type, "request");
      assert.equal(frame.payload.request_version, NATIVE_CONTROL_PROTOCOL_V1);
      assert.equal(frame.payload.body.contract_version, NATIVE_CONTROL_PROTOCOL_V1);
      return frame;
    },
    async nextFrame(timeoutMs = 2_000) {
      return this.decode(await queue.next(timeoutMs));
    },
    close() {
      try { ws.terminate(); } catch {}
    },
  };
}

export function nativeResponse(frame, {
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

export function respond(peer, frame, options = {}) {
  peer.send("response", nativeResponse(frame, options));
}

export function relayEnv(address, extra = {}) {
  return {
    PC_NATIVE_RELAY_URL: address.url,
    PC_NATIVE_RELAY_TOKEN: TEST_RELAY_CONTROL_TOKEN,
    PC_NATIVE_DEVICE_ID: TEST_RELAY_DEVICE_ID,
    PC_NATIVE_DESKTOP_ID: "final-control-desktop",
    ...extra,
  };
}
