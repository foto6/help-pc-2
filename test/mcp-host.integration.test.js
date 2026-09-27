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

test("official modern client negotiates 2026-07-28, lists exact native tools, and delegates read/write calls", async (t) => {
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
  assert.equal(listed.tools.length, TOOL_REGISTRY_LIST.length);
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    TOOL_REGISTRY_LIST.map((tool) => tool.name).sort(),
  );
  const readTool = listed.tools.find((tool) => tool.name === "file.read");
  assert.equal(readTool._meta["pc.native/registry_digest"], TOOL_REGISTRY_DIGEST);
  assert.equal(readTool._meta["pc.native/protocol_version"], "pc.native.control.v1");
  assert.equal(readTool._meta["pc.native/executor_digest"], "executor-cap-v1");
  assert.equal(readTool.inputSchema.additionalProperties, false);

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
