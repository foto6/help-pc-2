import test from "node:test";
import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  ControlPlane,
  HelpPc1Adapter,
  NativeControlFacade,
  NativeMcpRuntime,
  TOOL_REGISTRY_DIGEST,
  TOOL_REGISTRY_LIST,
  DC_COMPATIBILITY_REGISTRY_DIGEST,
  DC_COMPATIBILITY_REGISTRY_LIST,
  startNativeMcpHttpServer,
} from "../src/index.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

function success(request, data = {}) {
  return {
    request_id: request.request_id,
    action: request.action,
    ok: true,
    status: "completed",
    started_at: "2026-09-28T00:00:00.000Z",
    finished_at: "2026-09-28T00:00:00.001Z",
    data,
    error: null,
    error_kind: null,
    dry_run: request.dry_run,
  };
}

async function createHarness({ invoke, readEvidence = null } = {}) {
  const calls = [];
  const caps = { value: "executor-cap-v1" };
  const adapter = new HelpPc1Adapter({
    dryRun: false,
    invoke: async (request, context) => {
      calls.push({ request: structuredClone(request), context });
      return invoke ? invoke(request, context) : success(request, { ok: true });
    },
    readEvidence,
  });
  const controlPlane = new ControlPlane({ providers: [adapter] });
  const facade = new NativeControlFacade({
    controlPlane,
    capabilityProvider: async () => ({
      contract_version: "pc_executor.capabilities.v1",
      digest: caps.value,
      actions: [...new Set(TOOL_REGISTRY_LIST.map((tool) => tool.executorAction))],
    }),
  });
  const runtime = await NativeMcpRuntime.create({ facade, desktopId: "desktop-mcp-test" });
  const http = await startNativeMcpHttpServer({ runtime, token: TOKEN, port: 0 });
  return {
    calls,
    caps,
    controlPlane,
    facade,
    runtime,
    http,
    close: async () => {
      await http.close();
      await runtime.close();
    },
  };
}

function makeClient(url, { modern = true, token = TOKEN } = {}) {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    authProvider: { token: async () => token },
  });
  const client = new Client(
    { name: "pc-native-mcp-test-client", version: "1.0.0" },
    modern ? { versionNegotiation: { mode: "auto" } } : undefined,
  );
  return { client, transport };
}

function structured(result) {
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  const text = result.content?.find((item) => item.type === "text")?.text;
  return text ? JSON.parse(text) : null;
}

test("official modern client negotiates 2026-07-28, lists native plus versioned DC compatibility tools, and delegates native calls", async (t) => {
  let sideEffects = 0;
  const h = await createHarness({
    invoke: async (request) => {
      if (request.action === "fs.stat") return success(request, { path: request.params.path, size: 7 });
      if (request.action === "fs.write_text") {
        sideEffects += 1;
        return success(request, { written: true });
      }
      return success(request, { ok: true });
    },
  });
  t.after(h.close);

  const { client, transport } = makeClient(h.http.url, { modern: true });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal(client.getProtocolEra(), "modern");
  assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");

  const listed = await client.listTools();
  const expectedToolNames = [
    ...TOOL_REGISTRY_LIST.map((tool) => tool.name),
    ...DC_COMPATIBILITY_REGISTRY_LIST.map((tool) => tool.name),
  ].sort();
  assert.equal(listed.tools.length, expectedToolNames.length);
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), expectedToolNames);
  const readTool = listed.tools.find((tool) => tool.name === "file.read");
  assert.equal(readTool._meta["pc.native/registry_digest"], TOOL_REGISTRY_DIGEST);
  assert.equal(readTool._meta["pc.native/protocol_version"], "pc.native.control.v1");
  assert.equal(readTool._meta["pc.native/executor_digest"], "executor-cap-v1");
  assert.equal(readTool.inputSchema.additionalProperties, false);
  const compatReadTool = listed.tools.find((tool) => tool.name === "read_file");
  assert.equal(
    compatReadTool._meta["pc.desktop_commander/compat_registry_contract"],
    "pc.desktop_commander.compat_registry.v1",
  );
  assert.equal(
    compatReadTool._meta["pc.desktop_commander/compat_registry_digest"],
    DC_COMPATIBILITY_REGISTRY_DIGEST,
  );
  assert.equal(compatReadTool._meta["pc.desktop_commander/native_registry_digest"], TOOL_REGISTRY_DIGEST);
  assert.equal(compatReadTool._meta["pc.desktop_commander/executor_digest"], "executor-cap-v1");
  assert.equal(compatReadTool._meta["pc.desktop_commander/available"], true);
  assert.equal(compatReadTool.inputSchema.additionalProperties, false);

  const read = await client.callTool({
    name: "file.info",
    arguments: { request_id: "read-1", path: "C:\\tmp\\a.txt" },
  });
  assert.equal(read.isError, false);
  assert.equal(structured(read).status, "completed");
  assert.equal(structured(read).data.size, 7);
  assert.equal(h.calls.at(-1).request.action, "fs.stat");

  const writeArgs = {
    request_id: "write-once",
    path: "C:\\tmp\\out.txt",
    text: "hello",
    overwrite: true,
  };
  const first = await client.callTool({ name: "file.write", arguments: writeArgs });
  const duplicate = await client.callTool({ name: "file.write", arguments: writeArgs });
  assert.equal(structured(first).status, "completed");
  assert.equal(structured(duplicate).status, "completed");
  assert.equal(sideEffects, 1);
});


test("official MCP client exercises observed Desktop Commander compatibility calls through the real host", async (t) => {
  const readOrder = [];
  let editCalls = 0;
  let writeCalls = 0;
  let processReadCalls = 0;
  const h = await createHarness({
    invoke: async (request) => {
      switch (request.action) {
        case "fs.read_text":
          readOrder.push(request.params.path);
          if (request.params.path.endsWith("missing.txt")) {
            const error = new Error("ENOENT: no such file");
            error.code = "ENOENT";
            error.category = "filesystem";
            error.dispatchState = "not_dispatched";
            error.outcomeUncertain = false;
            error.retryable = false;
            throw error;
          }
          return success(request, {
            path: request.params.path,
            text: request.params.path.endsWith("b.txt") ? "B" : "A",
            returned_bytes: 1,
            next_cursor: null,
          });
        case "fs.hash":
          return success(request, {
            path: request.params.path,
            sha256: "a".repeat(64),
          });
        case "fs.edit_text":
          editCalls += 1;
          return success(request, {
            path: request.params.path,
            replacements: request.params.expected_replacements,
            bytes: 7,
            sha256: "b".repeat(64),
            atomic_replace: true,
          });
        case "fs.write_text":
          writeCalls += 1;
          return success(request, {
            path: request.params.path,
            bytes: Buffer.byteLength(request.params.text, "utf8"),
            sha256: "c".repeat(64),
          });
        case "process.start":
          return success(request, {
            process_handle: "compat-proc-77",
            pid: 77,
            running: true,
            returncode: null,
          });
        case "process.read":
          processReadCalls += 1;
          return processReadCalls === 1
            ? success(request, {
              output: "first chunk\n",
              running: true,
              returncode: null,
              next_cursor: "compat-next-1",
            })
            : success(request, {
              output: "second chunk\n",
              running: false,
              returncode: 0,
              next_cursor: null,
            });
        case "process.list":
          return success(request, {
            items: [{ pid: 77, running: false }],
            next_cursor: null,
          });
        case "process.terminate":
          return success(request, {
            terminated: true,
            already_exited: true,
            returncode: 0,
          });
        default:
          return success(request, { ok: true });
      }
    },
  });
  t.after(h.close);

  const { client, transport } = makeClient(h.http.url);
  t.after(() => client.close());
  await client.connect(transport);

  const listed = await client.listTools();
  const mandatory = [
    "edit_block",
    "read_file",
    "read_multiple_files",
    "write_file",
    "start_process",
    "read_process_output",
    "list_sessions",
    "force_terminate",
  ];
  for (const name of mandatory) {
    const tool = listed.tools.find((item) => item.name === name);
    assert.ok(tool, "missing compatibility tool " + name);
    assert.equal(
      tool._meta["pc.desktop_commander/compat_registry_digest"],
      DC_COMPATIBILITY_REGISTRY_DIGEST,
    );
  }

  const single = structured(await client.callTool({
    name: "read_file",
    arguments: {
      request_id: "dc-read-one",
      path: "C:\\tmp\\a.txt",
      offset: 0,
      length: 10,
    },
  }));
  assert.equal(single.status, "completed");
  assert.equal(single.data.content, "A");

  const batch = structured(await client.callTool({
    name: "read_multiple_files",
    arguments: {
      request_id: "dc-batch",
      paths: ["C:\\tmp\\a.txt", "C:\\tmp\\missing.txt", "C:\\tmp\\b.txt"],
    },
  }));
  assert.equal(batch.status, "completed");
  assert.deepEqual(batch.data.results.map((item) => item.path), [
    "C:\\tmp\\a.txt",
    "C:\\tmp\\missing.txt",
    "C:\\tmp\\b.txt",
  ]);
  assert.deepEqual(batch.data.results.map((item) => item.ok), [true, false, true]);
  assert.equal(batch.data.results[1].error.code, "FILE_NOT_FOUND");
  assert.deepEqual(readOrder.slice(-3), [
    "C:\\tmp\\a.txt",
    "C:\\tmp\\missing.txt",
    "C:\\tmp\\b.txt",
  ]);

  const edit = structured(await client.callTool({
    name: "edit_block",
    arguments: {
      request_id: "dc-edit",
      path: "C:\\tmp\\edit.txt",
      old_string: "before",
      new_string: "after",
      expected_replacements: 1,
    },
  }));
  assert.equal(edit.status, "completed");
  assert.equal(edit.data.replacements, 1);
  assert.equal(editCalls, 1);

  const writeArgs = {
    request_id: "dc-write-once",
    path: "C:\\tmp\\write.txt",
    content: "hello",
    mode: "rewrite",
  };
  const write1 = structured(await client.callTool({ name: "write_file", arguments: writeArgs }));
  const write2 = structured(await client.callTool({ name: "write_file", arguments: writeArgs }));
  assert.equal(write1.status, "completed");
  assert.equal(write2.status, "completed");
  assert.equal(writeCalls, 1);

  const started = structured(await client.callTool({
    name: "start_process",
    arguments: { request_id: "dc-start", command: "mock-command" },
  }));
  assert.equal(started.status, "completed");
  assert.equal(started.data.pid, 77);

  const firstRead = structured(await client.callTool({
    name: "read_process_output",
    arguments: { request_id: "dc-proc-read-1", pid: 77, length: 10 },
  }));
  const secondRead = structured(await client.callTool({
    name: "read_process_output",
    arguments: { request_id: "dc-proc-read-2", pid: 77, length: 10 },
  }));
  assert.equal(firstRead.data.output, "first chunk\n");
  assert.equal(firstRead.data.running, true);
  assert.equal(secondRead.data.output, "second chunk\n");
  assert.equal(secondRead.data.running, false);
  const secondProviderRead = h.calls.filter((item) => item.request.action === "process.read")[1].request;
  assert.equal(secondProviderRead.params.cursor, "compat-next-1");

  const sessions = structured(await client.callTool({
    name: "list_sessions",
    arguments: { request_id: "dc-list-sessions" },
  }));
  assert.equal(sessions.status, "completed");
  assert.equal(sessions.data.sessions[0].pid, 77);
  assert.equal(sessions.data.sessions[0].status, "finished");

  const terminated = structured(await client.callTool({
    name: "force_terminate",
    arguments: { request_id: "dc-terminate", pid: 77 },
  }));
  assert.equal(terminated.status, "completed");
  assert.equal(terminated.data.terminated, true);
});

test("Desktop Commander MCP compatibility preserves reconciliation_required without replay", async (t) => {
  let sideEffects = 0;
  const h = await createHarness({
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
    readEvidence: async () => ({ outcome: "unknown", source: "mock-journal" }),
  });
  t.after(h.close);
  const { client, transport } = makeClient(h.http.url);
  t.after(() => client.close());
  await client.connect(transport);

  const args = {
    request_id: "dc-unknown-write",
    path: "C:\\tmp\\uncertain-dc.txt",
    content: "once",
    mode: "rewrite",
  };
  const first = structured(await client.callTool({ name: "write_file", arguments: args }));
  const second = structured(await client.callTool({ name: "write_file", arguments: args }));
  assert.equal(first.status, "reconciliation_required");
  assert.equal(second.status, "reconciliation_required");
  assert.equal(sideEffects, 1);
});


test("Desktop Commander MCP cancellation reaches the facade and remains reconciliation-only", async (t) => {
  let sideEffects = 0;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const h = await createHarness({
    invoke: async (_request, context) => {
      sideEffects += 1;
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
    readEvidence: async () => ({ outcome: "unknown", source: "mock-journal" }),
  });
  t.after(h.close);
  const { client, transport } = makeClient(h.http.url);
  t.after(() => client.close());
  await client.connect(transport);

  const args = {
    request_id: "dc-cancel-write",
    path: "C:\\tmp\\cancel-dc.txt",
    content: "once",
    mode: "rewrite",
  };
  const controller = new AbortController();
  const pending = client.callTool({ name: "write_file", arguments: args }, { signal: controller.signal });
  await startedPromise;
  controller.abort();
  await assert.rejects(pending);

  for (let i = 0; i < 50; i += 1) {
    const action = h.controlPlane.listActions().find((item) => item.correlationId === "dc-cancel-write");
    if (action && ["uncertain_outcome", "reconciliation_wait", "reconciling"].includes(action.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const retry = structured(await client.callTool({ name: "write_file", arguments: args }));
  assert.equal(retry.status, "reconciliation_required");
  assert.equal(sideEffects, 1);
});

test("Desktop Commander MCP protected path is rejected before provider dispatch", async (t) => {
  const h = await createHarness();
  t.after(h.close);
  const { client, transport } = makeClient(h.http.url);
  t.after(() => client.close());
  await client.connect(transport);

  const result = await client.callTool({
    name: "read_file",
    arguments: {
      request_id: "dc-protected",
      path: "E:\\manhwa\\never.txt",
    },
  });
  const body = structured(result);
  assert.equal(result.isError, true);
  assert.equal(body.error.code, "PROTECTED_PATH_BLOCKED");
  assert.equal(h.calls.length, 0);
  assert.equal(h.controlPlane.listActions().length, 0);
});

test("official 2025-era client follows SDK compatibility path over Streamable HTTP", async (t) => {
  const h = await createHarness({
    invoke: async (request) => success(request, { action: request.action }),
  });
  t.after(h.close);

  const { client, transport } = makeClient(h.http.url, { modern: false });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal(client.getProtocolEra(), "legacy");
  assert.match(client.getNegotiatedProtocolVersion(), /^2025-/);

  const listed = await client.listTools();
  assert.equal(listed.tools.some((tool) => tool.name === "device.health"), true);
  const result = await client.callTool({
    name: "device.health",
    arguments: { request_id: "legacy-health" },
  });
  assert.equal(structured(result).status, "completed");
  assert.equal(h.calls.at(-1).request.action, "system.health");
});

test("HTTP MCP endpoint requires bearer auth and refuses bad credentials", async (t) => {
  const h = await createHarness();
  t.after(h.close);
  const { client, transport } = makeClient(h.http.url, {
    modern: true,
    token: "wrong-wrong-wrong-wrong-wrong-wrong",
  });
  await assert.rejects(client.connect(transport));
  await client.close().catch(() => {});
  assert.equal(h.calls.length, 0);
});

test("strict MCP schema rejects malformed arguments before provider dispatch", async (t) => {
  const h = await createHarness();
  t.after(h.close);
  const { client, transport } = makeClient(h.http.url);
  t.after(() => client.close());
  await client.connect(transport);
  await client.listTools();

  const malformed = await client.callTool({
    name: "file.info",
    arguments: { request_id: "bad-schema", path: "C:\\tmp\\a.txt", unexpected: true },
  });
  assert.equal(malformed.isError, true);
  assert.equal(h.calls.length, 0);
});

test("protected path is rejected by facade and never reaches provider", async (t) => {
  const h = await createHarness();
  t.after(h.close);
  const { client, transport } = makeClient(h.http.url);
  t.after(() => client.close());
  await client.connect(transport);

  const result = await client.callTool({
    name: "file.read",
    arguments: { request_id: "protected", path: "E:\\manhwa\\never.txt" },
  });
  const body = structured(result);
  assert.equal(result.isError, true);
  assert.equal(body.error.code, "PROTECTED_PATH_BLOCKED");
  assert.equal(h.calls.length, 0);
  assert.equal(h.controlPlane.listActions().length, 0);
});

test("capability drift fails closed before native provider dispatch", async (t) => {
  const h = await createHarness();
  t.after(h.close);
  const { client, transport } = makeClient(h.http.url);
  t.after(() => client.close());
  await client.connect(transport);

  h.caps.value = "executor-cap-v2";
  await assert.rejects(
    client.callTool({
      name: "device.health",
      arguments: { request_id: "drift" },
    }),
  );
  assert.equal(h.calls.length, 0);
});

test("unknown side-effect outcome surfaces reconciliation_required and duplicate logical request never re-executes", async (t) => {
  let sideEffects = 0;
  const h = await createHarness({
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
    readEvidence: async () => ({ outcome: "unknown", source: "mock-journal" }),
  });
  t.after(h.close);
  const { client, transport } = makeClient(h.http.url);
  t.after(() => client.close());
  await client.connect(transport);

  const args = {
    request_id: "unknown-write",
    path: "C:\\tmp\\uncertain.txt",
    text: "once",
  };
  const first = await client.callTool({ name: "file.write", arguments: args });
  assert.equal(structured(first).status, "reconciliation_required");
  const duplicate = await client.callTool({ name: "file.write", arguments: args });
  assert.equal(structured(duplicate).status, "reconciliation_required");
  assert.equal(sideEffects, 1);
});

test("official modern client cancellation maps to facade cancellation without duplicate side effect", async (t) => {
  let sideEffects = 0;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const h = await createHarness({
    invoke: async (request, context) => {
      sideEffects += 1;
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
    readEvidence: async () => ({ outcome: "unknown", source: "mock-journal" }),
  });
  t.after(h.close);
  const { client, transport } = makeClient(h.http.url);
  t.after(() => client.close());
  await client.connect(transport);

  const controller = new AbortController();
  const pending = client.callTool({
    name: "file.write",
    arguments: {
      request_id: "cancel-write",
      path: "C:\\tmp\\cancel.txt",
      text: "once",
    },
  }, { signal: controller.signal });
  await startedPromise;
  controller.abort();
  await assert.rejects(pending);

  for (let i = 0; i < 50; i += 1) {
    const action = h.controlPlane.listActions().find((item) => item.correlationId === "cancel-write");
    if (action && ["uncertain_outcome", "reconciliation_wait", "reconciling"].includes(action.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const retry = await client.callTool({
    name: "file.write",
    arguments: {
      request_id: "cancel-write",
      path: "C:\\tmp\\cancel.txt",
      text: "once",
    },
  });
  assert.equal(structured(retry).status, "reconciliation_required");
  assert.equal(sideEffects, 1);
});


test("MCP host preserves bounded native pagination and opaque continuation cursors", async (t) => {
  const seen = [];
  const h = await createHarness({
    invoke: async (request) => {
      seen.push(structuredClone(request));
      if (request.action === "fs.list") {
        return success(request, request.params.cursor
          ? { items: ["second"], next_cursor: null }
          : { items: ["first"], next_cursor: "executor-next" });
      }
      return success(request, { ok: true });
    },
  });
  t.after(h.close);
  const { client, transport } = makeClient(h.http.url);
  t.after(() => client.close());
  await client.connect(transport);

  const first = await client.callTool({
    name: "file.list",
    arguments: {
      request_id: "page-1",
      path: "C:\\tmp",
      page: { limit: 1 },
    },
  });
  const firstBody = structured(first);
  assert.deepEqual(firstBody.data.items, ["first"]);
  assert.equal(typeof firstBody.stream.next_cursor, "string");
  assert.equal(seen[0].params.limit, 1);

  const second = await client.callTool({
    name: "file.list",
    arguments: {
      request_id: "page-2",
      path: "C:\\tmp",
      page: { limit: 1, cursor: firstBody.stream.next_cursor },
    },
  });
  const secondBody = structured(second);
  assert.deepEqual(secondBody.data.items, ["second"]);
  assert.equal(secondBody.stream.next_cursor, null);
  assert.equal(seen[1].params.cursor, "executor-next");
});

test("Streamable HTTP host rejects non-loopback binds", async () => {
  const runtime = {};
  await assert.rejects(
    startNativeMcpHttpServer({
      runtime,
      token: TOKEN,
      host: "0.0.0.0",
      port: 0,
    }),
    /loopback-only/,
  );
});
