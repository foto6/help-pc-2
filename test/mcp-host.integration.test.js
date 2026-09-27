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

async function createHarness({ invoke, readEvidence = null, actions = null } = {}) {
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
      actions: actions ?? [...new Set(TOOL_REGISTRY_LIST.map((tool) => tool.executorAction))],
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
    actions: [
      "fs.read_text", "fs.read_multiple", "fs.hash", "fs.edit_text", "fs.write_text",
      "process.start", "process.read", "process.list", "process.terminate",
    ],
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
        case "fs.read_multiple":
          return success(request, {
            results: request.params.paths.map((path) => path.endsWith("missing.txt")
              ? {
                path,
                ok: false,
                error: { code: "ENOENT", category: "filesystem", message: "No such file" },
              }
              : {
                path,
                ok: true,
                data: { path, content: path.endsWith("b.txt") ? "B" : "A" },
              }),
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
    arguments: { request_id: "dc-start", command: "mock-command", timeout_ms: 1000 },
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


test("Desktop Commander tools/list exposes current capability availability and fails closed for missing mutable/PDF/batch/meta actions", async (t) => {
  const currentActions = [
    "device.info", "health.get", "config.get",
    "fs.read_text", "fs.write_text", "fs.append_text", "fs.mkdir", "fs.list",
    "fs.move", "fs.stat", "fs.hash", "fs.edit_text",
    "process.start", "process.read_output", "process.managed.list",
    "process.terminate", "process.list", "system.process.kill",
  ];
  const h = await createHarness({
    actions: currentActions,
    invoke: async (request) => {
      if (request.action === "device.info") {
        return success(request, {
          device_id: "local",
          platform: "Windows",
          generation_id: "gen-1",
          auth_token: "must-be-redacted",
        });
      }
      if (request.action === "health.get") return success(request, { status: "ok" });
      if (request.action === "config.get") return success(request, {
        mutable: false,
        limits: { max_text_read_bytes: 262144 },
        secret_token: "must-be-redacted",
      });
      return success(request, { ok: true });
    },
  });
  t.after(h.close);
  const { client, transport } = makeClient(h.http.url);
  t.after(() => client.close());
  await client.connect(transport);

  const listed = await client.listTools();
  const compat = (name) => listed.tools.find((tool) => tool.name === name);
  for (const name of ["list_devices", "ping", "get_config", "read_file", "write_file",
    "create_directory", "list_directory", "move_file", "get_file_info", "edit_block",
    "start_process", "read_process_output", "list_sessions", "list_processes", "kill_process"]) {
    assert.equal(compat(name)._meta["pc.desktop_commander/available"], true, name);
    assert.equal(compat(name)._meta["pc.desktop_commander/reference_version"], "0.2.51");
    assert.equal(typeof compat(name)._meta["pc.desktop_commander/selected_variant"], "string");
  }
  for (const name of ["shutdown", "set_config_value", "read_multiple_files", "write_pdf",
    "interact_with_process", "who_am_i", "get_usage_stats", "get_recent_tool_calls",
    "start_search", "get_more_search_results", "stop_search", "list_searches"]) {
    assert.equal(compat(name)._meta["pc.desktop_commander/available"], false, name);
    assert.equal(
      compat(name)._meta["pc.desktop_commander/availability_reason"],
      "required_native_capability_unavailable",
    );
  }

  const devices = structured(await client.callTool({
    name: "list_devices",
    arguments: { request_id: "dc-devices" },
  }));
  assert.equal(devices.status, "completed");
  assert.equal(devices.data.devices[0].device_id, "local");
  assert.equal(Object.hasOwn(devices.data.devices[0], "auth_token"), false);

  const ping = structured(await client.callTool({
    name: "ping",
    arguments: { request_id: "dc-ping" },
  }));
  assert.equal(ping.status, "completed");
  assert.equal(ping.data.pong, true);

  const config = structured(await client.callTool({
    name: "get_config",
    arguments: { request_id: "dc-config" },
  }));
  assert.equal(config.status, "completed");
  assert.equal(config.data.mutable, false);
  assert.equal(Object.hasOwn(config.data, "secret_token"), false);

  const callsBeforeUnavailable = h.calls.length;
  for (const [name, args] of [
    ["shutdown", {}],
    ["set_config_value", { key: "telemetryEnabled", value: false }],
    ["read_multiple_files", { paths: ["C:\\tmp\\a.txt"] }],
    ["write_pdf", { path: "C:\\tmp\\out.pdf", content: "# test" }],
    ["who_am_i", {}],
    ["get_usage_stats", {}],
    ["get_recent_tool_calls", {}],
  ]) {
    const result = structured(await client.callTool({
      name,
      arguments: { request_id: "unavailable-" + name, ...args },
    }));
    assert.equal(result.status, "error", name);
    assert.equal(result.error.code, "CAPABILITY_UNAVAILABLE", name);
  }
  assert.equal(h.calls.length, callsBeforeUnavailable);
});

test("official MCP current finalized PC Core exposes admin/batch/shutdown/PDF capabilities", async (t) => {
  const actions = [
    "device.info", "health.get", "config.get", "config.set", "agent.shutdown",
    "fs.read_text", "fs.read_multiple", "fs.write_text", "fs.append_text", "fs.mkdir", "fs.list", "fs.move", "fs.stat", "fs.hash", "fs.edit_text", "pdf.write",
    "search.start", "search.read", "search.list", "search.stop",
    "shell.session.start", "shell.session.read", "shell.session.write_stdin", "shell.session.terminate",
    "process.managed.list", "process.list", "system.process.kill",
    "identity.who_am_i", "diagnostics.usage_stats", "diagnostics.recent_tool_calls",
  ];
  const seen = [];
  const h = await createHarness({
    actions,
    invoke: async (request) => {
      seen.push(structuredClone(request));
      if (request.action === "config.set") return success(request, { key: request.params.key, config: { [request.params.key]: request.params.value }, revision: "a".repeat(64) });
      if (request.action === "fs.read_multiple") return success(request, {
        results: request.params.paths.map((path, index) => ({ path, ok: true, text: String(index), encoding: "utf-8", returned_bytes: 1, file_bytes: 1, truncated: false, sha256: "b".repeat(64) })),
        count: request.params.paths.length,
        returned_bytes: request.params.paths.length,
      });
      if (request.action === "agent.shutdown") return success(request, { shutdown_requested: true, scope: "current_device_agent" });
      if (request.action === "pdf.write") return success(request, { output_path: request.params.output_path ?? request.params.path, page_count: 1, bytes: 128 });
      return success(request, {});
    },
  });
  t.after(h.close);
  const { client, transport } = makeClient(h.http.url);
  t.after(() => client.close());
  await client.connect(transport);

  const listed = await client.listTools();
  const compat = (name) => listed.tools.find((tool) => tool.name === name);
  const required = [
    "list_devices", "ping", "shutdown", "get_config", "set_config_value", "read_file", "read_multiple_files", "write_file",
    "create_directory", "list_directory", "move_file", "start_search", "get_more_search_results", "stop_search", "list_searches",
    "get_file_info", "edit_block", "start_process", "read_process_output", "interact_with_process", "force_terminate", "list_sessions",
    "list_processes", "kill_process", "who_am_i", "get_usage_stats", "get_recent_tool_calls", "write_pdf",
  ];
  for (const name of required) {
    assert.equal(compat(name)._meta["pc.desktop_commander/available"], true, name);
    assert.equal(compat(name)._meta["pc.desktop_commander/executor_digest"], "executor-cap-v1", name);
  }
  assert.equal(compat("get_prompts"), undefined);
  assert.equal(compat("give_feedback_to_desktop_commander"), undefined);
  assert.deepEqual(
    compat("read_file")._meta["pc.desktop_commander/vendor_non_equivalents"].map((entry) => entry.name).sort(),
    ["get_prompts", "give_feedback_to_desktop_commander"].sort(),
  );

  const changed = structured(await client.callTool({
    name: "set_config_value",
    arguments: { request_id: "core-config-set", key: "batch_read.max_aggregate_bytes", value: 524288 },
  }));
  assert.equal(changed.status, "completed");
  assert.equal(changed.data.key, "batch_read.max_aggregate_bytes");

  const batch = structured(await client.callTool({
    name: "read_multiple_files",
    arguments: { request_id: "core-batch", paths: ["C:\\tmp\\a.txt", "C:\\tmp\\b.txt"] },
  }));
  assert.equal(batch.status, "completed");
  assert.deepEqual(batch.data.results.map((item) => item.path), ["C:\\tmp\\a.txt", "C:\\tmp\\b.txt"]);
  assert.deepEqual(batch.data.results.map((item) => item.ok), [true, true]);

  const pdf = structured(await client.callTool({
    name: "write_pdf",
    arguments: { request_id: "core-pdf", path: "C:\\tmp\\out.pdf", content: "# native pdf" },
  }));
  assert.equal(pdf.status, "completed");
  assert.equal(pdf.data.output_path, "C:\\tmp\\out.pdf");
  assert.deepEqual(
    seen.filter((item) => item.action === "pdf.write")[0].params,
    { path: "C:\\tmp\\out.pdf", content: "# native pdf" },
  );

  const shutdown = structured(await client.callTool({ name: "shutdown", arguments: { request_id: "core-shutdown" } }));
  assert.equal(shutdown.status, "completed");
  assert.equal(shutdown.data.native.shutdown_requested, true);
  assert.deepEqual(seen.filter((item) => item.action === "agent.shutdown")[0].params, {});
});

test("official MCP filesystem compatibility category stays Executor-bound and bounded", async (t) => {
  const seen = [];
  const h = await createHarness({
    actions: ["fs.mkdir", "fs.list", "fs.move", "fs.stat", "fs.hash"],
    invoke: async (request) => {
      seen.push(structuredClone(request));
      switch (request.action) {
        case "fs.mkdir":
          return success(request, { path: request.params.path, created: true });
        case "fs.list":
          return success(request, {
            path: request.params.path,
            entries: [{ name: "a.txt", path: request.params.path + "\\a.txt", kind: "file" }],
            has_more: false,
            next_cursor: null,
          });
        case "fs.move":
          return success(request, {
            source: request.params.source,
            destination: request.params.destination,
          });
        case "fs.stat":
          return success(request, {
            path: request.params.path,
            kind: "file",
            bytes: 9,
            modified_ns: 11,
            symlink: false,
          });
        case "fs.hash":
          return success(request, { path: request.params.path, sha256: "d".repeat(64) });
        default:
          return success(request, {});
      }
    },
  });
  t.after(h.close);
  const { client, transport } = makeClient(h.http.url);
  t.after(() => client.close());
  await client.connect(transport);

  const made = structured(await client.callTool({
    name: "create_directory",
    arguments: { request_id: "dc-mkdir", path: "C:\\tmp\\folder" },
  }));
  assert.equal(made.status, "completed");

  const listed = structured(await client.callTool({
    name: "list_directory",
    arguments: { request_id: "dc-ls", path: "C:\\tmp\\folder", depth: 2 },
  }));
  assert.equal(listed.status, "completed");
  assert.equal(listed.data.count, 1);

  const moved = structured(await client.callTool({
    name: "move_file",
    arguments: {
      request_id: "dc-move",
      source: "C:\\tmp\\folder\\a.txt",
      destination: "C:\\tmp\\folder\\b.txt",
    },
  }));
  assert.equal(moved.status, "completed");

  const info = structured(await client.callTool({
    name: "get_file_info",
    arguments: { request_id: "dc-info", path: "C:\\tmp\\folder\\b.txt" },
  }));
  assert.equal(info.status, "completed");
  assert.equal(info.data.size, 9);
  assert.equal(info.data.sha256, "d".repeat(64));
  assert.deepEqual(
    seen.map((item) => item.action),
    ["fs.mkdir", "fs.list", "fs.move", "fs.stat", "fs.hash"],
  );
});

test("official MCP stateful search compatibility preserves handles, tail pagination, list and stop", async (t) => {
  const seen = [];
  const h = await createHarness({
    actions: ["search.start", "search.read", "search.list", "search.stop"],
    invoke: async (request) => {
      seen.push(structuredClone(request));
      switch (request.action) {
        case "search.start":
          return success(request, {
            search_id: "search-42",
            status: "running",
            result_count: 0,
            runtime_ms: 1,
          });
        case "search.read":
          return success(request, {
            search_id: request.params.search_id,
            status: "completed",
            result_count: 2,
            runtime_ms: 7,
            results: [
              { path: "C:\\tmp\\a.txt" },
              { path: "C:\\tmp\\b.txt" },
            ],
          });
        case "search.list":
          return success(request, {
            searches: [{
              search_id: "search-42",
              search_type: "files",
              pattern: "txt",
              status: "completed",
              runtime_ms: 7,
              result_count: 2,
            }],
          });
        case "search.stop":
          return success(request, {
            search_id: request.params.search_id,
            already_finished: true,
            status: "completed",
          });
        default:
          throw new Error("unexpected search action");
      }
    },
  });
  t.after(h.close);
  const { client, transport } = makeClient(h.http.url);
  t.after(() => client.close());
  await client.connect(transport);

  const started = structured(await client.callTool({
    name: "start_search",
    arguments: {
      request_id: "dc-search-start",
      path: "C:\\tmp",
      pattern: "txt",
      searchType: "files",
      literalSearch: true,
      ignoreCase: true,
      includeHidden: false,
      maxResults: 25,
      contextLines: 5,
      timeout_ms: 5000,
    },
  }));
  assert.equal(started.status, "completed");
  assert.equal(started.data.sessionId, "search-42");

  const tail = structured(await client.callTool({
    name: "get_more_search_results",
    arguments: {
      request_id: "dc-search-tail",
      sessionId: "search-42",
      offset: -2,
      length: 1,
    },
  }));
  assert.equal(tail.status, "completed");
  assert.equal(tail.data.length, null);
  assert.equal(tail.data.results.length, 2);
  const readCall = seen.find((item) => item.action === "search.read");
  assert.deepEqual(readCall.params, { search_id: "search-42", offset: -2 });

  const listed = structured(await client.callTool({
    name: "list_searches",
    arguments: { request_id: "dc-search-list" },
  }));
  assert.equal(listed.data.searches[0].sessionId, "search-42");
  assert.equal(listed.data.searches[0].result_count, 2);

  const stopped = structured(await client.callTool({
    name: "stop_search",
    arguments: { request_id: "dc-search-stop", sessionId: "search-42" },
  }));
  assert.equal(stopped.status, "completed");
  assert.equal(stopped.data.already_finished, true);
});

test("official MCP process/system and sanitized meta compatibility delegate through current PC Core contracts", async (t) => {
  let outputReads = 0;
  const h = await createHarness({
    actions: [
      "shell.session.start", "shell.session.read", "shell.session.write_stdin", "shell.session.terminate",
      "process.managed.list", "process.list", "system.process.kill",
      "identity.who_am_i", "diagnostics.usage_stats", "diagnostics.recent_tool_calls",
    ],
    invoke: async (request) => {
      switch (request.action) {
        case "shell.session.start":
          assert.deepEqual(request.params.argv, ["python", "-i"]);
          return success(request, { handle_id: "handle-88", session_id: "handle-88", pid: 88, kind: "session" });
        case "shell.session.read":
          outputReads += 1;
          if (outputReads === 2) {
            assert.deepEqual(request.params.cursor, {
              version: "pc_executor.stream_cursor.v1", handle_id: "handle-88", stdout_offset: 1, stderr_offset: 0,
            });
          }
          return success(request, {
            handle_id: "handle-88",
            stdout: outputReads === 1 ? "one\n" : "two\n",
            stderr: "",
            cursor: { version: "pc_executor.stream_cursor.v1", handle_id: "handle-88", stdout_offset: outputReads, stderr_offset: 0 },
            running: outputReads === 1,
            returncode: outputReads === 1 ? null : 0,
          });
        case "process.managed.list":
          return success(request, {
            handles: [{ handle_id: "handle-88", pid: 88, kind: "session", status: "finished", running: false, returncode: 0 }],
          });
        case "shell.session.write_stdin":
          assert.deepEqual(request.params, {
            session_id: "handle-88", text: "x", append_newline: false, sensitive: false,
          });
          return success(request, { session_id: "handle-88", written_bytes: 1 });
        case "shell.session.terminate":
          return success(request, { handle_id: "handle-88", already_exited: true, returncode: 0 });
        case "process.list":
          return success(request, {
            processes: [{ pid: request.params.pid ?? 321, ppid: 1, name: "worker.exe" }],
            has_more: false,
          });
        case "system.process.kill":
          assert.equal(request.params.expected_name, "worker.exe");
          return success(request, { terminated: true });
        case "identity.who_am_i":
          return success(request, {
            controller: "pc_executor", device_id: "device-1", session_epoch: "epoch-1", transport: "native_remote",
            auth_token: "redact-me",
          });
        case "diagnostics.usage_stats":
          return success(request, { available: true, sanitized: true, completed_calls: 12, actions: { "fs.read_text": 4 }, secret_key: "redact-me" });
        case "diagnostics.recent_tool_calls":
          return success(request, {
            contract_version: "pc_executor.audit_history.v1",
            available: true,
            sanitized: true,
            events: [{ action: "read_file", phase: "completed", timestamp: "2026-09-28T00:00:00Z", credential: "redact-me" }],
          });
        default:
          throw new Error("unexpected action " + request.action);
      }
    },
  });
  t.after(h.close);
  const { client, transport } = makeClient(h.http.url);
  t.after(() => client.close());
  await client.connect(transport);

  const started = structured(await client.callTool({
    name: "start_process",
    arguments: { request_id: "full-proc-start", command: "python -i", timeout_ms: 1000 },
  }));
  assert.equal(started.status, "completed");
  assert.equal(started.data.pid, 88);
  assert.equal(started.data.native_variant, "pc_core_interactive_session");

  const one = structured(await client.callTool({
    name: "read_process_output",
    arguments: { request_id: "full-proc-read1", pid: 88, timeout_ms: 10, length: 10 },
  }));
  const two = structured(await client.callTool({
    name: "read_process_output",
    arguments: { request_id: "full-proc-read2", pid: 88, timeout_ms: 10, length: 10 },
  }));
  assert.equal(one.data.output, "one\n");
  assert.equal(two.data.output, "two\n");
  assert.equal(two.data.running, false);

  const interacted = structured(await client.callTool({
    name: "interact_with_process",
    arguments: { request_id: "full-proc-input", pid: 88, input: "x", timeout_ms: 10 },
  }));
  assert.equal(interacted.status, "completed");
  assert.equal(interacted.data.native_variant, "pc_core_session");

  const sessions = structured(await client.callTool({
    name: "list_sessions",
    arguments: { request_id: "full-proc-list" },
  }));
  assert.equal(sessions.data.sessions[0].status, "finished");

  const processes = structured(await client.callTool({
    name: "list_processes",
    arguments: { request_id: "full-system-list" },
  }));
  assert.equal(processes.data.processes[0].name, "worker.exe");

  const providerCallsBeforeKill = h.calls.length;
  const killed = structured(await client.callTool({
    name: "kill_process",
    arguments: { request_id: "full-system-kill", pid: 321 },
  }));
  assert.equal(killed.status, "error");
  assert.equal(killed.error.code, "PROCESS_ERROR");
  assert.match(killed.error.message, /destructive actions are disabled/i);
  const killProviderCalls = h.calls.slice(providerCallsBeforeKill);
  assert.deepEqual(killProviderCalls.map((item) => item.request.action), ["process.list"]);

  const stopped = structured(await client.callTool({
    name: "force_terminate",
    arguments: { request_id: "full-proc-stop", pid: 88 },
  }));
  assert.equal(stopped.data.terminated, true);

  const who = structured(await client.callTool({
    name: "who_am_i",
    arguments: { request_id: "full-who" },
  }));
  assert.equal(who.data.controller, "pc_executor");
  assert.equal(Object.hasOwn(who.data, "auth_token"), false);

  const usage = structured(await client.callTool({
    name: "get_usage_stats",
    arguments: { request_id: "full-usage" },
  }));
  assert.equal(usage.data.completed_calls, 12);
  assert.equal(usage.data.connector_billing_available, false);
  assert.equal(Object.hasOwn(usage.data, "secret_key"), false);

  const recent = structured(await client.callTool({
    name: "get_recent_tool_calls",
    arguments: { request_id: "full-recent", maxResults: 10, toolName: "read_file" },
  }));
  assert.equal(recent.data.calls[0].action, "read_file");
  assert.equal(Object.hasOwn(recent.data.calls[0], "credential"), false);
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
