import test from "node:test";
import assert from "node:assert/strict";

import {
  ControlPlane,
  HelpPc1Adapter,
  NativeControlFacade,
  NativeMcpRuntime,
  TOOL_REGISTRY,
} from "../src/index.js";
import { createNativeRelayExecutorBridge } from "../src/native-relay-provider.js";
import {
  TEST_RELAY_CONTROL_TOKEN,
  TEST_RELAY_DEVICE_ID,
  connectDevice,
  createRelayState,
  startRelay,
} from "./support/native-relay-fixture.js";

function success(req, data = {}) {
  return {
    request_id: req.request_id,
    action: req.action,
    ok: true,
    status: "completed",
    dry_run: false,
    data,
    started_at: "2026-10-03T00:00:00Z",
    finished_at: "2026-10-03T00:00:01Z",
    error: null,
    error_kind: null,
  };
}

async function fixture() {
  const state = {
    currentEpoch: "epoch-r35-A",
    boundEpoch: "epoch-r35-A",
    effectCalls: 0,
    rebindCalls: 0,
  };
  const controlPlane = new ControlPlane({
    providers: [new HelpPc1Adapter({
      dryRun: false,
      invoke: async (req) => {
        if (["fs.write_text", "process.start", "process.terminate"].includes(req.action)) {
          state.effectCalls += 1;
        }
        if (req.action === "process.start") {
          return success(req, { process_handle: "r35-live-handle" });
        }
        if (req.action === "process.terminate") {
          return success(req, { terminated: true });
        }
        return success(req, { written: true });
      },
    })],
  });
  const identity = () => ({
    deviceId: "r35-device",
    sessionEpoch: state.currentEpoch,
    executorDigest: "r35-executor",
  });
  const facade = new NativeControlFacade({
    controlPlane,
    capabilityProvider: async () => ({
      contract_version: "pc_executor.capabilities.v1",
      digest: "r35-executor",
      actions: ["fs.write_text", "process.start", "process.terminate", "system.health"],
    }),
    deviceIdentityProvider: async () => {
      if (state.boundEpoch !== state.currentEpoch) {
        const error = new Error("stale provider binding");
        error.code = "STALE_DEVICE_SESSION";
        throw error;
      }
      return identity();
    },
    deviceIdentityObserver: async () => identity(),
    deviceIdentityRebinder: async ({ previous, current }) => {
      assert.equal(previous.sessionEpoch, state.boundEpoch);
      assert.equal(current.sessionEpoch, state.currentEpoch);
      assert.equal(previous.deviceId, current.deviceId);
      assert.equal(previous.executorDigest, current.executorDigest);
      state.rebindCalls += 1;
      state.boundEpoch = current.sessionEpoch;
      return identity();
    },
  });
  const runtime = await NativeMcpRuntime.create({
    facade,
    desktopId: "r35-desktop",
  });
  return { state, controlPlane, facade, runtime };
}

const ctx = () => ({ mcpReq: { id: 3501 } });

test("R35 quiescent epoch rebind preserves session and never replays completed mutation", async (t) => {
  const h = await fixture();
  t.after(() => h.runtime.close());
  await h.runtime.ensureFacadeSession();
  const sessionId = h.runtime.facadeSession.session_id;
  const args = {
    request_id: "r35-write-once",
    path: "C:\\Temp\\r35-once.txt",
    text: "once",
  };
  const first = await h.runtime.callNativeTool(TOOL_REGISTRY["file.write"], args, ctx());
  assert.equal(first.structuredContent.status, "completed");
  assert.equal(h.state.effectCalls, 1);

  h.state.currentEpoch = "epoch-r35-B";
  const duplicate = await h.runtime.callNativeTool(TOOL_REGISTRY["file.write"], args, ctx());
  assert.equal(duplicate.structuredContent.status, "completed");
  assert.equal(h.state.effectCalls, 1);
  assert.equal(h.state.rebindCalls, 1);
  assert.equal(h.runtime.facadeSession.session_id, sessionId);

  const session = h.facade.debugSnapshot().sessions.find((item) => item.id === sessionId);
  assert.equal(session.deviceIdentity.sessionEpoch, "epoch-r35-B");
  assert.equal(session.deviceRebindCount, 1);

  const second = await h.runtime.callNativeTool(TOOL_REGISTRY["file.write"], {
    request_id: "r35-write-new",
    path: "C:\\Temp\\r35-new.txt",
    text: "new",
  }, ctx());
  assert.equal(second.structuredContent.status, "completed");
  assert.equal(h.state.effectCalls, 2);
});

test("R35 epoch rebind refuses unsettled mutation before provider commit", async (t) => {
  const h = await fixture();
  t.after(() => h.runtime.close());
  await h.runtime.ensureFacadeSession();
  const first = await h.runtime.callNativeTool(TOOL_REGISTRY["file.write"], {
    request_id: "r35-unsettled",
    path: "C:\\Temp\\r35-unsettled.txt",
    text: "once",
  }, ctx());
  assert.equal(first.structuredContent.status, "completed");
  const request = h.facade.state.requests.find((item) => item.requestId === "r35-unsettled");
  const action = h.controlPlane.getAction(request.actionId);
  h.controlPlane.actions.get(action.id).status = "uncertain_outcome";
  request.status = "reconciliation_required";

  h.state.currentEpoch = "epoch-r35-B";
  const blocked = await h.runtime.callNativeTool(TOOL_REGISTRY["file.write"], {
    request_id: "r35-must-not-run",
    path: "C:\\Temp\\r35-never.txt",
    text: "never",
  }, ctx());
  assert.equal(blocked.structuredContent.status, "error");
  assert.equal(blocked.structuredContent.error.code, "STALE_DEVICE_SESSION");
  assert.equal(h.state.rebindCalls, 0);
  assert.equal(h.state.effectCalls, 1);
});

test("R35 epoch rebind refuses live process handle", async (t) => {
  const h = await fixture();
  t.after(() => h.runtime.close());
  await h.runtime.ensureFacadeSession();
  const started = await h.runtime.callNativeTool(TOOL_REGISTRY["process.start"], {
    request_id: "r35-process-start",
    command: "isolated-echo",
  }, ctx());
  assert.equal(started.structuredContent.status, "completed");
  assert.equal(h.state.effectCalls, 1);

  h.state.currentEpoch = "epoch-r35-B";
  const blocked = await h.runtime.callNativeTool(TOOL_REGISTRY["file.write"], {
    request_id: "r35-after-handle",
    path: "C:\\Temp\\r35-never-handle.txt",
    text: "never",
  }, ctx());
  assert.equal(blocked.structuredContent.status, "error");
  assert.equal(blocked.structuredContent.error.code, "STALE_DEVICE_SESSION");
  assert.equal(h.state.rebindCalls, 0);
  assert.equal(h.state.effectCalls, 1);
});

test("R35 relay provider observes new epoch without dispatch and commits only explicitly", async (t) => {
  const state = createRelayState();
  const { address } = await startRelay(t, { state });
  const firstPeer = await connectDevice(address, { epoch: "epoch-r35-provider-A" });
  t.after(() => firstPeer.close());
  const bridge = createNativeRelayExecutorBridge({
    relayUrl: address.url,
    relayToken: TEST_RELAY_CONTROL_TOKEN,
    deviceId: TEST_RELAY_DEVICE_ID,
    desktopId: "r35-provider-desktop",
  });

  const first = await bridge.readDeviceIdentity();
  assert.equal(first.sessionEpoch, "epoch-r35-provider-A");

  const secondPeer = await connectDevice(address, { epoch: "epoch-r35-provider-B" });
  t.after(() => secondPeer.close());
  await assert.rejects(
    bridge.readDeviceIdentity(),
    (error) => error.code === "STALE_DEVICE_SESSION",
  );

  const observed = await bridge.observeDeviceIdentity();
  assert.equal(observed.sessionEpoch, "epoch-r35-provider-B");
  await assert.rejects(
    bridge.readDeviceIdentity(),
    (error) => error.code === "STALE_DEVICE_SESSION",
  );

  const committed = await bridge.rebindDeviceIdentity({
    previous: first,
    current: observed,
  });
  assert.equal(committed.sessionEpoch, "epoch-r35-provider-B");
  assert.equal((await bridge.readDeviceIdentity()).sessionEpoch, "epoch-r35-provider-B");
});
