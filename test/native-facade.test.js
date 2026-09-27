import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ControlPlane,
  HelpPc1Adapter,
  JsonStateStore,
  NativeControlFacade,
  JsonFacadeStateStore,
  NativeFacadeError,
  NATIVE_CONTROL_PROTOCOL_V1,
} from "../src/index.js";

function tempPaths() {
  const root = mkdtempSync(join(tmpdir(), "pc-native-mcp-"));
  return {
    root,
    control: join(root, "control.json"),
    facade: join(root, "facade.json"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function success(request, data = {}) {
  return {
    request_id: request.request_id,
    action: request.action,
    ok: true,
    status: "completed",
    started_at: "2026-09-27T00:00:00.000Z",
    finished_at: "2026-09-27T00:00:00.001Z",
    data,
    error: null,
    error_kind: null,
    dry_run: request.dry_run,
  };
}

function capabilityProvider(valueRef) {
  return async () => ({
    contract_version: "pc_executor.capabilities.v1",
    digest: valueRef.value,
    actions: ["fs.read_text", "fs.write_text", "process.start", "process.read", "process.terminate"],
  });
}

async function clientFor(facade) {
  const manifest = await facade.capabilities();
  return {
    protocol_version: manifest.protocol_version,
    registry_digest: manifest.registry_digest,
    executor_digest: manifest.executor?.digest ?? null,
  };
}

async function open(facade, desktopId = "desktop-A") {
  return facade.openSession({ desktopId, client: await clientFor(facade) });
}

function envelope(sessionId, requestId, tool, args = {}, page = undefined) {
  return {
    contract_version: NATIVE_CONTROL_PROTOCOL_V1,
    session_id: sessionId,
    request_id: requestId,
    tool,
    arguments: args,
    ...(page === undefined ? {} : { page }),
  };
}

test("capability negotiation fails closed on registry/schema mismatch", async () => {
  const caps = { value: "exec-v1" };
  const cp = new ControlPlane({ providers: [new HelpPc1Adapter({ invoke: async (request) => success(request) })] });
  const facade = new NativeControlFacade({ controlPlane: cp, capabilityProvider: capabilityProvider(caps) });
  const manifest = await facade.capabilities();
  await assert.rejects(
    facade.openSession({
      desktopId: "desk",
      client: { protocol_version: manifest.protocol_version, registry_digest: "wrong", executor_digest: "exec-v1" },
    }),
    (error) => error instanceof NativeFacadeError && error.code === "CAPABILITY_MISMATCH",
  );
  assert.equal(cp.listSessions().length, 0);
});

test("duplicate request IDs return the same durable action and side effect executes once", async () => {
  let calls = 0;
  const caps = { value: "exec-v1" };
  const adapter = new HelpPc1Adapter({ dryRun: false, invoke: async (request) => {
    calls += 1;
    return success(request, { written: true });
  } });
  const cp = new ControlPlane({ providers: [adapter] });
  const facade = new NativeControlFacade({ controlPlane: cp, capabilityProvider: capabilityProvider(caps) });
  const session = await open(facade);
  const req = envelope(session.session_id, "req-1", "file.write", { path: "C:\\tmp\\a.txt", text: "x" });
  const first = await facade.invoke(req);
  const duplicate = await facade.invoke(req);
  assert.equal(first.status, "completed");
  assert.deepEqual(duplicate, first);
  assert.equal(calls, 1);

  await assert.rejects(
    facade.invoke(envelope(session.session_id, "req-1", "file.write", { path: "C:\\tmp\\a.txt", text: "different" })),
    (error) => error.code === "DUPLICATE_REQUEST_MISMATCH",
  );
  assert.equal(calls, 1);
});

test("control restart preserves request identity and cannot redispatch a completed side effect", async (t) => {
  const paths = tempPaths();
  t.after(paths.cleanup);
  let sideEffects = 0;
  const caps = { value: "exec-v1" };
  const firstAdapter = new HelpPc1Adapter({ dryRun: false, invoke: async (request) => {
    sideEffects += 1;
    return success(request, { written: true });
  } });
  const firstCp = new ControlPlane({ providers: [firstAdapter], store: new JsonStateStore(paths.control) });
  const firstFacade = new NativeControlFacade({
    controlPlane: firstCp,
    store: new JsonFacadeStateStore(paths.facade),
    capabilityProvider: capabilityProvider(caps),
  });
  const session = await open(firstFacade);
  const req = envelope(session.session_id, "restart-1", "file.write", { path: "C:\\tmp\\restart.txt", text: "once" });
  assert.equal((await firstFacade.invoke(req)).status, "completed");
  assert.equal(sideEffects, 1);

  const secondAdapter = new HelpPc1Adapter({ dryRun: false, invoke: async () => {
    throw new Error("must not redispatch");
  } });
  const secondCp = new ControlPlane({ providers: [secondAdapter], store: new JsonStateStore(paths.control) });
  const secondFacade = new NativeControlFacade({
    controlPlane: secondCp,
    store: new JsonFacadeStateStore(paths.facade),
    capabilityProvider: capabilityProvider(caps),
  });
  const replay = await secondFacade.invoke(req);
  assert.equal(replay.status, "completed");
  assert.equal(sideEffects, 1);
});

test("executor restart after unknown outcome uses reconciliation lookup and never blind re-executes", async (t) => {
  const paths = tempPaths();
  t.after(paths.cleanup);
  let sideEffects = 0;
  const caps = { value: "exec-v1" };
  const firstAdapter = new HelpPc1Adapter({
    dryRun: false,
    invoke: async (request) => {
      sideEffects += 1;
      return {
        request_id: request.request_id,
        action: request.action,
        ok: false,
        status: "timeout",
        error: "result lost after dispatch",
        error_kind: "timeout",
        dry_run: false,
      };
    },
    readEvidence: async () => ({ outcome: "unknown", source: "old-executor" }),
  });
  const firstCp = new ControlPlane({ providers: [firstAdapter], store: new JsonStateStore(paths.control) });
  const firstFacade = new NativeControlFacade({
    controlPlane: firstCp,
    store: new JsonFacadeStateStore(paths.facade),
    capabilityProvider: capabilityProvider(caps),
  });
  const session = await open(firstFacade);
  const req = envelope(session.session_id, "lost-result", "file.write", { path: "C:\\tmp\\lost.txt", text: "once" });
  const uncertain = await firstFacade.invoke(req);
  assert.equal(uncertain.status, "reconciliation_required");
  assert.equal(sideEffects, 1);

  const secondAdapter = new HelpPc1Adapter({
    dryRun: false,
    invoke: async () => { throw new Error("must not execute on restart"); },
    readEvidence: async () => ({ outcome: "succeeded", source: "executor-journal" }),
  });
  const secondCp = new ControlPlane({ providers: [secondAdapter], store: new JsonStateStore(paths.control) });
  const secondFacade = new NativeControlFacade({
    controlPlane: secondCp,
    store: new JsonFacadeStateStore(paths.facade),
    capabilityProvider: capabilityProvider(caps),
  });
  const reconciled = await secondFacade.invoke(req);
  assert.equal(reconciled.status, "completed");
  assert.equal(sideEffects, 1);
});

test("connection/result loss remains lookup-only and repeated request cannot duplicate side effect", async () => {
  let sideEffects = 0;
  let evidence = "unknown";
  const caps = { value: "exec-v1" };
  const adapter = new HelpPc1Adapter({
    dryRun: false,
    invoke: async (request) => {
      sideEffects += 1;
      return {
        request_id: request.request_id,
        action: request.action,
        ok: false,
        status: "timeout",
        error: "socket dropped after dispatch",
        error_kind: "timeout",
        dry_run: false,
      };
    },
    readEvidence: async () => ({ outcome: evidence, source: "journal" }),
  });
  const cp = new ControlPlane({ providers: [adapter] });
  const facade = new NativeControlFacade({ controlPlane: cp, capabilityProvider: capabilityProvider(caps) });
  const session = await open(facade);
  const req = envelope(session.session_id, "drop-1", "file.write", { path: "C:\\tmp\\drop.txt", text: "once" });
  assert.equal((await facade.invoke(req)).status, "reconciliation_required");
  assert.equal(sideEffects, 1);
  evidence = "succeeded";
  assert.equal((await facade.invoke(req)).status, "completed");
  assert.equal(sideEffects, 1);
});

test("stale session, malformed cursor and protected path all fail before executor dispatch", async () => {
  let calls = 0;
  const caps = { value: "exec-v1" };
  const cp = new ControlPlane({ providers: [new HelpPc1Adapter({ invoke: async (request) => {
    calls += 1;
    return success(request);
  } })] });
  const facade = new NativeControlFacade({ controlPlane: cp, capabilityProvider: capabilityProvider(caps) });
  const session = await open(facade);

  await assert.rejects(
    facade.invoke(envelope(session.session_id, "cursor-1", "file.read", { path: "C:\\tmp\\a.txt" }, { limit: 10, cursor: "@@not-a-cursor@@" })),
    (error) => error.code === "MALFORMED_STREAM_CURSOR",
  );
  await assert.rejects(
    facade.invoke(envelope(session.session_id, "protected-1", "file.read", { path: "E:\\manhwa\\secret.txt" })),
    (error) => error.code === "PROTECTED_PATH_BLOCKED",
  );
  assert.equal(calls, 0);
  assert.equal(cp.listActions().length, 0);

  facade.closeSession(session.session_id);
  await assert.rejects(
    facade.invoke(envelope(session.session_id, "stale-1", "device.health")),
    (error) => error.code === "STALE_SESSION",
  );
  assert.equal(calls, 0);
});

test("capability drift marks the session stale before dispatch", async () => {
  let calls = 0;
  const caps = { value: "exec-v1" };
  const cp = new ControlPlane({ providers: [new HelpPc1Adapter({ invoke: async (request) => {
    calls += 1;
    return success(request);
  } })] });
  const facade = new NativeControlFacade({ controlPlane: cp, capabilityProvider: capabilityProvider(caps) });
  const session = await open(facade);
  caps.value = "exec-v2";
  await assert.rejects(
    facade.invoke(envelope(session.session_id, "drift-1", "device.health")),
    (error) => error.code === "CAPABILITY_DRIFT",
  );
  assert.equal(calls, 0);
});

test("bounded streaming wraps executor cursor and validates continuation ownership", async () => {
  const seen = [];
  const caps = { value: "exec-v1" };
  const cp = new ControlPlane({ providers: [new HelpPc1Adapter({ invoke: async (request) => {
    seen.push(request);
    return success(request, request.params.cursor
      ? { items: ["c"], next_cursor: null }
      : { items: ["a", "b"], next_cursor: "executor-cursor-2" });
  } })] });
  const facade = new NativeControlFacade({ controlPlane: cp, capabilityProvider: capabilityProvider(caps), maxPageSize: 2 });
  const session = await open(facade);
  const first = await facade.invoke(envelope(session.session_id, "page-1", "file.list", { path: "C:\\tmp" }, { limit: 2 }));
  assert.equal(first.status, "completed");
  assert.deepEqual(first.data.items, ["a", "b"]);
  assert.equal(typeof first.stream.next_cursor, "string");
  assert.equal(seen[0].params.limit, 2);

  const second = await facade.invoke(envelope(session.session_id, "page-2", "file.list", { path: "C:\\tmp" }, { limit: 2, cursor: first.stream.next_cursor }));
  assert.equal(second.status, "completed");
  assert.deepEqual(second.data.items, ["c"]);
  assert.equal(seen[1].params.cursor, "executor-cursor-2");

  await assert.rejects(
    facade.invoke(envelope(session.session_id, "page-3", "file.list", { path: "C:\\tmp" }, { limit: 3 })),
    (error) => error.code === "PAGE_LIMIT_EXCEEDED",
  );
});

test("process handles are session-bound and become stale after termination", async () => {
  const caps = { value: "exec-v1" };
  const cp = new ControlPlane({ providers: [new HelpPc1Adapter({ invoke: async (request) => {
    if (request.action === "process.start") return success(request, { process_handle: "proc-1" });
    if (request.action === "process.read") return success(request, { items: ["out"], next_cursor: null });
    return success(request, { terminated: true });
  } })] });
  const facade = new NativeControlFacade({ controlPlane: cp, capabilityProvider: capabilityProvider(caps) });
  const session = await open(facade);
  assert.equal((await facade.invoke(envelope(session.session_id, "p-start", "process.start", { command: "echo hi" }))).data.process_handle, "proc-1");
  assert.equal((await facade.invoke(envelope(session.session_id, "p-read", "process.read", { handle: "proc-1" }))).status, "completed");
  assert.equal((await facade.invoke(envelope(session.session_id, "p-stop", "process.terminate", { handle: "proc-1" }))).status, "completed");
  await assert.rejects(
    facade.invoke(envelope(session.session_id, "p-read-2", "process.read", { handle: "proc-1" })),
    (error) => error.code === "STALE_PROCESS_HANDLE",
  );
});

test("cancelled request aborts in-flight dispatch and never creates a second executor call", async () => {
  let calls = 0;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const caps = { value: "exec-v1" };
  const adapter = new HelpPc1Adapter({
    dryRun: false,
    invoke: async (_request, context) => {
      calls += 1;
      started();
      return new Promise((_resolve, reject) => {
        context.signal.addEventListener("abort", () => {
          const error = new Error("cancelled after dispatch");
          error.code = "CANCELLED";
          error.dispatchState = "unknown";
          error.outcomeUncertain = true;
          reject(error);
        }, { once: true });
      });
    },
    readEvidence: async () => ({ outcome: "unknown", source: "journal" }),
  });
  const cp = new ControlPlane({ providers: [adapter] });
  const facade = new NativeControlFacade({ controlPlane: cp, capabilityProvider: capabilityProvider(caps) });
  const session = await open(facade);
  const req = envelope(session.session_id, "cancel-1", "process.interact", { handle: "fake", input: "x" });

  facade.state.handles.push({ handle: "fake", sessionId: session.session_id, tool: "process.start", status: "open" });
  const pending = facade.invoke(req);
  await ready;
  const cancelView = facade.cancelRequest({ sessionId: session.session_id, requestId: "cancel-1", reason: "operator_cancel" });
  assert.ok(["pending", "reconciliation_required", "cancelled"].includes(cancelView.status));
  const after = await pending;
  assert.equal(after.status, "reconciliation_required");
  assert.equal(calls, 1);
  const duplicate = await facade.invoke(req);
  assert.equal(duplicate.status, "reconciliation_required");
  assert.equal(calls, 1);
});
