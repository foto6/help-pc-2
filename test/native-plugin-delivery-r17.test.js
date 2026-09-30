import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  NATIVE_PLUGIN_BROKER_FRAME_V1,
  NATIVE_PLUGIN_PAIRING_RESPONSE_V1,
  NativePluginBrokerConnector,
  assessPluginDeliveryGate,
  assertCurrentLiveStack,
  assertNoProtectedPathArguments,
  buildCurrentDeviceBinding,
  validateApprovedBrokerOrigin,
} from "../src/native-plugin-delivery.js";
import { canonicalJson } from "../src/native-registry.js";
import {
  PINNED_CONTROL_NATIVE_DIGEST,
  PINNED_PC_FROZEN_DIGEST,
} from "../src/native-relay-registry-route.js";

const NOW = 1_800_000_000_000;
const EXECUTOR_DIGEST = "e".repeat(64);
const CAPABILITY_DIGEST = "c".repeat(64);
const BROKER_IDENTITY = "b".repeat(64);
const CALLER_DIGEST = "a".repeat(64);
const ORIGIN = "https://broker.example.test";
const HOST = "broker.example.test";
const SESSION_EPOCH = "broker-session-r17-0001";

function digest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function live(overrides = {}) {
  return {
    live_probe: true,
    pc_core: "ready",
    relay: "ready",
    control: "ready",
    mcp_host: "ready",
    device_epoch: "device-epoch-r17",
    process_epoch: "process-epoch-r17",
    observed_at_epoch_ms: NOW,
    ...overrides,
  };
}

function binding(overrides = {}) {
  return buildCurrentDeviceBinding({
    deviceId: "device-r17",
    desktopId: "desktop-r17",
    executorDigest: EXECUTOR_DIGEST,
    capabilityDigest: CAPABILITY_DIGEST,
    liveStack: live(),
    now: NOW,
    ...overrides,
  });
}

class SecureStore {
  secure = true;
  value = null;
  async put(value) { this.value = structuredClone(value); }
  async get() { return this.value ? structuredClone(this.value) : null; }
  async delete() { this.value = null; }
}

class DurableStore {
  durable = true;
  values = new Map();
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async get(key) {
    const value = this.values.get(key);
    return value ? structuredClone(value) : null;
  }
}

function pairingResponse(currentBinding, overrides = {}) {
  return {
    contract_version: NATIVE_PLUGIN_PAIRING_RESPONSE_V1,
    accepted: true,
    broker_origin: ORIGIN,
    broker_identity_digest: BROKER_IDENTITY,
    authorized_caller_digest: CALLER_DIGEST,
    binding: structuredClone(currentBinding),
    remote_mcp: {
      transport: "streamable-http",
      url: ORIGIN + "/mcp/native-pc-r17",
    },
    credential: {
      id: "credential-r17",
      token: "short-lived-token-r17-abcdefghijklmnopqrstuvwxyz",
      expires_at_epoch_ms: NOW + 60_000,
    },
    ...overrides,
  };
}

function pairArgs(overrides = {}) {
  return {
    consent: { granted: true, id: "consent-r17" },
    pairingCode: "PAIR-CODE-R17-123456",
    deviceId: "device-r17",
    desktopId: "desktop-r17",
    executorDigest: EXECUTOR_DIGEST,
    capabilityDigest: CAPABILITY_DIGEST,
    liveStack: live(),
    ...overrides,
  };
}

function connector(overrides = {}) {
  return new NativePluginBrokerConnector({
    enabled: true,
    brokerOrigin: ORIGIN,
    approvedHostname: HOST,
    secureStore: new SecureStore(),
    deliveryStore: new DurableStore(),
    protectedRoots: [String.raw`E:\manhwa`],
    now: () => NOW,
    randomBytesImpl: (size) => Buffer.alloc(size, 7),
    ...overrides,
  });
}

function requestFrame({
  requestId = "request-r17",
  deliveryId = "delivery-r17",
  semantics = "read_only",
  body = {
    method: "tools/call",
    params: {
      name: "device.info",
      arguments: {},
    },
  },
  sessionEpoch = SESSION_EPOCH,
} = {}) {
  return {
    contract_version: NATIVE_PLUGIN_BROKER_FRAME_V1,
    type: "request",
    session_epoch: sessionEpoch,
    request_id: requestId,
    delivery_id: deliveryId,
    semantics,
    body,
    body_sha256: digest(body),
  };
}

test("approved broker endpoint is HTTPS/443, exact-host, non-local, and credential free", () => {
  assert.equal(
    validateApprovedBrokerOrigin(ORIGIN, { approvedHostname: HOST }),
    ORIGIN,
  );
  for (const [value, approved] of [
    ["http://broker.example.test", HOST],
    ["https://localhost", "localhost"],
    ["https://127.0.0.1", "127.0.0.1"],
    ["https://broker.example.test:8443", HOST],
    ["https://user:pass@broker.example.test", HOST],
    ["https://broker.example.test/?token=secret", HOST],
    [ORIGIN, "other.example.test"],
  ]) {
    assert.throws(
      () => validateApprovedBrokerOrigin(value, { approvedHostname: approved }),
      (caught) => caught.code === "INVALID_HOST",
    );
  }
});

test("remote delivery is opt-in and refuses missing secure pairing state", async () => {
  const disabled = new NativePluginBrokerConnector({
    brokerOrigin: ORIGIN,
    approvedHostname: HOST,
  });
  await assert.rejects(
    disabled.registrationCandidate(),
    (caught) => caught.code === "REMOTE_PLUGIN_DISABLED",
  );

  const enabled = connector();
  await assert.rejects(
    enabled.registrationCandidate(),
    (caught) => caught.code === "UNPAIRED",
  );
});

test("pairing HTTP 401 is explicit and never stores credentials", async () => {
  const store = new SecureStore();
  const subject = connector({
    secureStore: store,
    fetchImpl: async () => new Response("{}", { status: 401 }),
  });
  await assert.rejects(
    subject.pair(pairArgs()),
    (caught) => caught.code === "PAIRING_UNAUTHORIZED",
  );
  assert.equal(await store.get(), null);
});

test("offline pairing broker fails closed without creating local pairing", async () => {
  const store = new SecureStore();
  const subject = connector({
    secureStore: store,
    fetchImpl: async () => { throw new Error("offline"); },
  });
  await assert.rejects(
    subject.pair(pairArgs()),
    (caught) => caught.code === "BROKER_OFFLINE" && caught.retryable === true,
  );
  assert.equal(await store.get(), null);
});

test("pairing proof sends no raw code, binds 37+25 routes, and redacts bearer", async () => {
  const store = new SecureStore();
  const seen = [];
  const subject = connector({
    secureStore: store,
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      seen.push({ url: String(url), body });
      return Response.json(pairingResponse(body.binding));
    },
  });

  const result = await subject.pair(pairArgs());
  assert.equal(result.status, "paired");
  assert.equal(result.plugin_identity, "pc-control");
  assert.equal(result.pairing.binding.control_registry_digest, PINNED_CONTROL_NATIVE_DIGEST);
  assert.equal(result.pairing.binding.pc_frozen_registry_digest, PINNED_PC_FROZEN_DIGEST);
  assert.deepEqual(result.pairing.binding.route_counts, {
    frozen: 37,
    parity: 25,
    total: 62,
  });

  const serializedRequest = JSON.stringify(seen);
  assert.equal(serializedRequest.includes("PAIR-CODE-R17-123456"), false);
  assert.match(seen[0].body.pairing_proof, /^[0-9a-f]{64}$/);

  const stored = await store.get();
  assert.equal(stored.token, "short-lived-token-r17-abcdefghijklmnopqrstuvwxyz");
  const publicResult = JSON.stringify(result);
  assert.equal(publicResult.includes(stored.token), false);

  const candidate = await subject.registrationCandidate({
    localBinding: result.pairing.binding,
  });
  assert.equal(candidate.publish_allowed, false);
  assert.equal(candidate.plugin_identity, "pc-control");
  assert.equal(candidate.mcp.transport, "streamable-http");
  assert.equal(candidate.mcp.url, ORIGIN + "/mcp/native-pc-r17");
  assert.equal(JSON.stringify(candidate).includes(stored.token), false);
});

test("pairing rejects changed epoch or digest before credential persistence", async () => {
  for (const mutation of [
    (value) => { value.binding.device_epoch = "rebooted-device-epoch"; },
    (value) => { value.binding.executor_digest = "d".repeat(64); },
    (value) => { value.binding.control_registry_digest = "f".repeat(64); },
  ]) {
    const store = new SecureStore();
    const subject = connector({
      secureStore: store,
      fetchImpl: async (_url, options) => {
        const request = JSON.parse(options.body);
        const response = pairingResponse(request.binding);
        mutation(response);
        return Response.json(response);
      },
    });
    await assert.rejects(
      subject.pair(pairArgs()),
      (caught) => caught.code === "PAIRING_BINDING_MISMATCH",
    );
    assert.equal(await store.get(), null);
  }
});

test("reboot partial stack and historical readiness never authorize pairing or dispatch", async () => {
  for (const bad of [
    live({ live_probe: false }),
    live({ relay: "backoff" }),
    live({ control: "missing" }),
    live({ mcp_host: "stopped" }),
    live({ observed_at_epoch_ms: NOW - 31_000 }),
  ]) {
    assert.throws(
      () => assertCurrentLiveStack(bad, { now: NOW }),
      (caught) => caught.code === "LOCAL_STACK_NOT_READY",
    );
  }

  const subject = connector();
  await assert.rejects(
    subject.dispatchBrokerRequest(requestFrame(), {
      dispatch: async () => ({ ok: true }),
      sessionEpoch: SESSION_EPOCH,
      liveStack: live({ relay: "backoff" }),
    }),
    (caught) => caught.code === "LOCAL_STACK_NOT_READY",
  );
});

test("protected path is rejected lexically before dispatch and without filesystem access", async () => {
  assert.throws(
    () => assertNoProtectedPathArguments(
      { params: { arguments: { path: String.raw`E:\manhwa\fixture.txt` } } },
      [String.raw`E:\manhwa`],
    ),
    (caught) => caught.code === "PROTECTED_PATH",
  );

  const subject = connector();
  let dispatches = 0;
  const body = {
    method: "tools/call",
    params: {
      name: "file.read",
      arguments: { path: String.raw`E:/manhwa/fixture.txt` },
    },
  };
  await assert.rejects(
    subject.dispatchBrokerRequest(requestFrame({ body }), {
      dispatch: async () => { dispatches += 1; },
      sessionEpoch: SESSION_EPOCH,
      liveStack: live(),
    }),
    (caught) => caught.code === "PROTECTED_PATH",
  );
  assert.equal(dispatches, 0);
});

test("duplicate request is served from durable result and conflicting reuse is rejected", async () => {
  const subject = connector();
  let dispatches = 0;
  const frame = requestFrame();
  const first = await subject.dispatchBrokerRequest(frame, {
    dispatch: async () => {
      dispatches += 1;
      return { direct_native: true, value: "ok" };
    },
    sessionEpoch: SESSION_EPOCH,
    liveStack: live(),
  });
  const duplicate = await subject.dispatchBrokerRequest(frame, {
    dispatch: async () => {
      dispatches += 1;
      throw new Error("must not redispatch");
    },
    sessionEpoch: SESSION_EPOCH,
    liveStack: live(),
  });
  assert.equal(first.status, "completed");
  assert.deepEqual(duplicate, first);
  assert.equal(dispatches, 1);

  const conflictingBody = {
    method: "tools/call",
    params: { name: "device.ping", arguments: {} },
  };
  const conflict = await subject.dispatchBrokerRequest(
    requestFrame({ body: conflictingBody }),
    {
      dispatch: async () => {
        dispatches += 1;
      },
      sessionEpoch: SESSION_EPOCH,
      liveStack: live(),
    },
  );
  assert.equal(conflict.status, "failed");
  assert.equal(conflict.error.code, "DELIVERY_ID_CONFLICT");
  assert.equal(dispatches, 1);
});

test("unknown side-effect outcome is reconciliation-only and never blindly redispatched", async () => {
  const subject = connector();
  let dispatches = 0;
  const frame = requestFrame({
    requestId: "write-r17",
    deliveryId: "delivery-write-r17",
    semantics: "side_effecting",
    body: {
      method: "tools/call",
      params: {
        name: "file.write",
        arguments: { path: String.raw`C:\Temp\r17-fixture.txt`, text: "once" },
      },
    },
  });
  const dispatch = async () => {
    dispatches += 1;
    const caught = new Error("result lost after dispatch");
    caught.code = "UNKNOWN_RECONCILE";
    caught.dispatchState = "unknown";
    caught.outcomeUncertain = true;
    throw caught;
  };

  const first = await subject.dispatchBrokerRequest(frame, {
    dispatch,
    sessionEpoch: SESSION_EPOCH,
    liveStack: live(),
  });
  const duplicate = await subject.dispatchBrokerRequest(frame, {
    dispatch,
    sessionEpoch: SESSION_EPOCH,
    liveStack: live(),
  });
  assert.equal(first.status, "reconciliation_required");
  assert.equal(first.error.code, "UNKNOWN_RECONCILE");
  assert.equal(first.automatic_replay, false);
  assert.deepEqual(duplicate, first);
  assert.equal(dispatches, 1);
});

class FakeSocket extends EventEmitter {
  constructor({ welcomeMutator = null } = {}) {
    super();
    this.sent = [];
    this.closed = false;
    this.welcomeMutator = welcomeMutator;
    queueMicrotask(() => this.emit("open"));
  }

  send(raw) {
    const parsed = JSON.parse(String(raw));
    this.sent.push(parsed);
    if (parsed.type === "hello") {
      const welcome = {
        contract_version: NATIVE_PLUGIN_BROKER_FRAME_V1,
        type: "welcome",
        accepted: true,
        connection_nonce: parsed.connection_nonce,
        session_epoch: SESSION_EPOCH,
        broker_identity_digest: BROKER_IDENTITY,
        authorized_caller_digest: CALLER_DIGEST,
        binding: structuredClone(parsed.binding),
      };
      this.welcomeMutator?.(welcome);
      queueMicrotask(() => this.emit("message", JSON.stringify(welcome)));
    }
  }

  close() {
    this.closed = true;
    this.emit("close");
  }
}

async function pairedConnector({
  socketFactory,
  bindingMutation = null,
} = {}) {
  const store = new SecureStore();
  const currentBinding = binding();
  const record = {
    contract_version: "pc.native.chatgpt.plugin_delivery.v1",
    credential_id: "credential-r17",
    token: "short-lived-token-r17-abcdefghijklmnopqrstuvwxyz",
    expires_at_epoch_ms: NOW + 60_000,
    broker_origin: ORIGIN,
    remote_mcp_url: ORIGIN + "/mcp/native-pc-r17",
    broker_identity_digest: BROKER_IDENTITY,
    authorized_caller_digest: CALLER_DIGEST,
    binding: structuredClone(currentBinding),
  };
  bindingMutation?.(record.binding);
  await store.put(record);
  const delivery = new DurableStore();
  let socketOptions = null;
  let socketUrl = null;
  const subject = connector({
    secureStore: store,
    deliveryStore: delivery,
    websocketFactory: (url, options) => {
      socketUrl = url;
      socketOptions = structuredClone(options);
      return socketFactory();
    },
  });
  return { subject, store, delivery, currentBinding, getSocketOptions: () => socketOptions, getSocketUrl: () => socketUrl };
}

test("outbound WSS connector uses short-lived bearer only in TLS handshake and validates welcome binding", async () => {
  let socket = null;
  const state = await pairedConnector({
    socketFactory: () => {
      socket = new FakeSocket();
      return socket;
    },
  });
  const handle = await state.subject.connect({
    deviceId: "device-r17",
    desktopId: "desktop-r17",
    executorDigest: EXECUTOR_DIGEST,
    capabilityDigest: CAPABILITY_DIGEST,
    liveStack: live(),
    dispatch: async () => ({ ok: true }),
  });

  assert.equal(state.getSocketUrl(), "wss://broker.example.test/v1/native-pc/device");
  assert.equal(
    state.getSocketOptions().headers.Authorization,
    "Bearer short-lived-token-r17-abcdefghijklmnopqrstuvwxyz",
  );
  assert.equal(state.getSocketOptions().origin, ORIGIN);
  assert.equal(handle.status, "connected");
  assert.equal(handle.remote_mcp_url, ORIGIN + "/mcp/native-pc-r17");

  const hello = socket.sent[0];
  assert.equal(hello.type, "hello");
  const serializedHello = JSON.stringify(hello);
  assert.equal(serializedHello.includes("short-lived-token"), false);
  assert.equal(JSON.stringify(handle).includes("short-lived-token"), false);
  await handle.close();
});

test("outbound connector rejects stale pairing epoch and broker welcome digest mismatch", async () => {
  const stale = await pairedConnector({
    socketFactory: () => new FakeSocket(),
    bindingMutation: (value) => { value.device_epoch = "old-device-epoch"; },
  });
  await assert.rejects(
    stale.subject.connect({
      deviceId: "device-r17",
      desktopId: "desktop-r17",
      executorDigest: EXECUTOR_DIGEST,
      capabilityDigest: CAPABILITY_DIGEST,
      liveStack: live(),
      dispatch: async () => ({ ok: true }),
    }),
    (caught) => caught.code === "PAIRING_BINDING_MISMATCH",
  );

  let badWelcomeSocket = null;
  const mismatch = await pairedConnector({
    socketFactory: () => {
      badWelcomeSocket = new FakeSocket({
        welcomeMutator: (welcome) => {
          welcome.broker_identity_digest = "d".repeat(64);
        },
      });
      return badWelcomeSocket;
    },
  });
  await assert.rejects(
    mismatch.subject.connect({
      deviceId: "device-r17",
      desktopId: "desktop-r17",
      executorDigest: EXECUTOR_DIGEST,
      capabilityDigest: CAPABILITY_DIGEST,
      liveStack: live(),
      dispatch: async () => ({ ok: true }),
    }),
    (caught) => caught.code === "PAIRING_BINDING_MISMATCH",
  );
  assert.equal(badWelcomeSocket.closed, true);
});

test("outbound connector reports offline socket construction without altering pairing", async () => {
  const state = await pairedConnector({
    socketFactory: () => { throw new Error("offline"); },
  });
  await assert.rejects(
    state.subject.connect({
      deviceId: "device-r17",
      desktopId: "desktop-r17",
      executorDigest: EXECUTOR_DIGEST,
      capabilityDigest: CAPABILITY_DIGEST,
      liveStack: live(),
      dispatch: async () => ({ ok: true }),
    }),
    (caught) => caught.code === "BROKER_OFFLINE",
  );
  assert.ok(await state.store.get());
});

test("delivery gate remains BLOCKED without a real approved endpoint and agent evidence", () => {
  assert.deepEqual(assessPluginDeliveryGate(), {
    status: "BLOCKED_APPROVED_REMOTE_ENDPOINT_REQUIRED",
    ready: false,
  });
  assert.deepEqual(
    assessPluginDeliveryGate({
      brokerOrigin: ORIGIN,
      paired: true,
      endpointReachabilityVerified: true,
      chatgptToolsListVerified: false,
      directReadOnlyAgentEvidenceVerified: false,
    }),
    {
      status: "BLOCKED_CLIENT_DISCOVERY_UNPROVEN",
      ready: false,
    },
  );
  assert.deepEqual(
    assessPluginDeliveryGate({
      brokerOrigin: ORIGIN,
      paired: true,
      endpointReachabilityVerified: true,
      chatgptToolsListVerified: true,
      directReadOnlyAgentEvidenceVerified: true,
    }),
    {
      status: "READ_ONLY_AGENT_INTEGRATION_PASS",
      ready: true,
    },
  );
});
