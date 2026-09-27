import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DC_COMPATIBILITY_REGISTRY_V1,
  DC_COMPATIBILITY_REGISTRY_DIGEST,
  DC_COMPATIBILITY_REGISTRY_LIST,
  DC_VENDOR_SPECIFIC_EXCLUSIONS,
  DesktopCommanderCompatibilitySurface,
  JsonDcCompatibilityStore,
  desktopCommanderCompatibilityManifestV1,
  normalizeDesktopCommanderError,
} from "../src/index.js";

const REQUIRED_NAMES = [
  "create_directory",
  "edit_block",
  "force_terminate",
  "get_config",
  "get_file_info",
  "get_more_search_results",
  "get_recent_tool_calls",
  "get_usage_stats",
  "interact_with_process",
  "kill_process",
  "list_devices",
  "list_directory",
  "list_processes",
  "list_searches",
  "list_sessions",
  "move_file",
  "ping",
  "read_file",
  "read_multiple_files",
  "read_process_output",
  "set_config_value",
  "shutdown",
  "start_process",
  "start_search",
  "stop_search",
  "who_am_i",
  "write_file",
  "write_pdf",
].sort();

function completed(data, stream = null) {
  return {
    contract_version: "pc.native.response.v1",
    status: "completed",
    data,
    error: null,
    stream,
  };
}

function failed(code, message, category = "execution") {
  return {
    contract_version: "pc.native.response.v1",
    status: "error",
    data: null,
    error: { code, category, message, retryable: false, details: null },
    stream: null,
  };
}

class FakeFacade {
  constructor({ actions = [], handler = async () => completed({}) } = {}) {
    this.actions = actions;
    this.handler = handler;
    this.calls = [];
  }

  async capabilities() {
    return {
      contract_version: "pc.native.tool_registry.v1",
      protocol_version: "pc.native.control.v1",
      registry_digest: "native-registry",
      executor: {
        contract_version: "pc_executor.capabilities.v1",
        digest: "exec-digest",
        actions: [...this.actions],
      },
    };
  }

  async invoke(envelope) {
    this.calls.push(structuredClone(envelope));
    return this.handler(envelope, this.calls.length - 1);
  }
}

function request(tool, args = {}, requestId = "req-1", sessionId = "session-1") {
  return {
    request_id: requestId,
    session_id: sessionId,
    tool,
    arguments: args,
  };
}

test("compatibility registry is versioned, exact, and MCP-host consumable without MCP framing", async () => {
  assert.equal(DC_COMPATIBILITY_REGISTRY_V1, "pc.desktop_commander.compat_registry.v1");
  assert.match(DC_COMPATIBILITY_REGISTRY_DIGEST, /^[0-9a-f]{64}$/);
  assert.deepEqual(DC_COMPATIBILITY_REGISTRY_LIST.map((tool) => tool.name).sort(), REQUIRED_NAMES);
  assert.deepEqual(
    [...DC_VENDOR_SPECIFIC_EXCLUSIONS].sort(),
    ["get_prompts", "give_feedback_to_desktop_commander"],
  );
  for (const tool of DC_COMPATIBILITY_REGISTRY_LIST) {
    assert.equal(tool.native_protocol, "pc.native.control.v1");
    assert.equal(tool.input_schema.type, "object");
    assert.ok(Array.isArray(tool.native_tools));
    assert.ok(tool.capability_variants.length >= 1);
  }

  const manifest = desktopCommanderCompatibilityManifestV1({
    nativeManifest: await new FakeFacade({
      actions: ["fs.read_text", "fs.write_text", "fs.append_text", "fs.hash", "fs.edit_text", "process.start", "process.list", "process.terminate"],
    }).capabilities(),
  });
  const processRead = manifest.tools.find((tool) => tool.name === "read_process_output");
  assert.equal(processRead.available, false);
  assert.deepEqual(processRead.capability_variants[0].missing_executor_actions, ["process.read_output"]);
});

test("read_file translates positive offsets to bounded native line ranges", async () => {
  const facade = new FakeFacade({
    actions: ["fs.read_text"],
    handler: async (envelope) => {
      assert.equal(envelope.tool, "file.read");
      assert.deepEqual(envelope.arguments, {
        path: "C:\\tmp\\alpha.txt",
        start_line: 6,
        end_line: 8,
        max_bytes: 256 * 1024,
      });
      assert.deepEqual(envelope.page, { limit: 3 });
      return completed({
        path: envelope.arguments.path,
        text: "six\nseven\neight\n",
        returned_bytes: 16,
        truncated: false,
        next_line: 9,
        file_bytes: 40,
        sha256: "a".repeat(64),
      });
    },
  });
  const surface = new DesktopCommanderCompatibilitySurface({ facade });
  const result = await surface.invoke(request("read_file", {
    path: "C:\\tmp\\alpha.txt",
    offset: 5,
    length: 3,
  }));
  assert.equal(result.status, "completed");
  assert.equal(result.data.content, "six\nseven\neight\n");
  assert.equal(result.data.offset, 5);
  assert.equal(result.data.length, 3);
  assert.equal(result.data.next_line, 9);
});

test("read_file negative offset preserves Desktop Commander tail semantics and ignores length", async () => {
  const facade = new FakeFacade({
    actions: ["fs.read_text"],
    handler: async (envelope) => {
      assert.deepEqual(envelope.arguments, {
        path: "C:\\tmp\\tail.txt",
        tail_lines: 20,
        max_bytes: 256 * 1024,
      });
      return completed({ path: envelope.arguments.path, text: "tail", tail_lines: 20 });
    },
  });
  const surface = new DesktopCommanderCompatibilitySurface({ facade });
  const result = await surface.invoke(request("read_file", {
    path: "C:\\tmp\\tail.txt",
    offset: -20,
    length: 2,
  }));
  assert.equal(result.status, "completed");
  assert.equal(result.data.offset, -20);
  assert.equal(result.data.length, 20);
  assert.equal(result.data.content, "tail");
});

test("read_multiple_files is a deterministic batch with per-file success and error", async () => {
  const facade = new FakeFacade({
    actions: ["fs.read_text"],
    handler: async (envelope) => {
      const path = envelope.arguments.path;
      if (path.endsWith("missing.txt")) return failed("ENOENT", "No such file", "filesystem");
      return completed({ path, text: path.endsWith("a.txt") ? "A" : "B", returned_bytes: 1 });
    },
  });
  const surface = new DesktopCommanderCompatibilitySurface({ facade });
  const result = await surface.invoke(request("read_multiple_files", {
    paths: ["C:\\tmp\\a.txt", "C:\\tmp\\missing.txt", "C:\\tmp\\b.txt"],
  }, "batch-7"));
  assert.equal(result.status, "completed");
  assert.equal(result.data.count, 3);
  assert.equal(result.data.succeeded, 2);
  assert.equal(result.data.failed, 1);
  assert.deepEqual(result.data.results.map((item) => item.path), [
    "C:\\tmp\\a.txt",
    "C:\\tmp\\missing.txt",
    "C:\\tmp\\b.txt",
  ]);
  assert.equal(result.data.results[1].error.code, "FILE_NOT_FOUND");
  assert.deepEqual(facade.calls.map((call) => call.request_id), [
    "batch-7:file:0",
    "batch-7:file:1",
    "batch-7:file:2",
  ]);
});

test("edit_block hashes first then performs one atomic exact replacement with count precondition", async () => {
  const seen = [];
  const facade = new FakeFacade({
    actions: ["fs.hash", "fs.edit_text"],
    handler: async (envelope) => {
      seen.push(envelope);
      if (envelope.tool === "file.hash") {
        return completed({ path: envelope.arguments.path, sha256: "b".repeat(64) });
      }
      assert.equal(envelope.tool, "file.edit");
      assert.deepEqual(envelope.arguments, {
        path: "C:\\tmp\\edit.txt",
        old_text: "old",
        new_text: "new",
        expected_replacements: 2,
        expected_current_hash: "b".repeat(64),
      });
      return completed({
        path: envelope.arguments.path,
        replacements: 2,
        bytes: 7,
        sha256: "c".repeat(64),
        atomic_replace: true,
      });
    },
  });
  const surface = new DesktopCommanderCompatibilitySurface({ facade });
  const result = await surface.invoke(request("edit_block", {
    path: "C:\\tmp\\edit.txt",
    old_string: "old",
    new_string: "new",
    expected_replacements: 2,
  }, "edit-1"));
  assert.equal(result.status, "completed");
  assert.equal(result.data.replacements, 2);
  assert.equal(result.data.atomic_replace, true);
  assert.deepEqual(seen.map((call) => call.request_id), ["edit-1:hash", "edit-1:edit"]);
});

test("edit_block replacement-count failure is normalized and does not trigger a fallback write", async () => {
  const facade = new FakeFacade({
    actions: ["fs.hash", "fs.edit_text", "fs.write_text"],
    handler: async (envelope) => {
      if (envelope.tool === "file.hash") return completed({ sha256: "d".repeat(64) });
      if (envelope.tool === "file.edit") {
        return failed("EXECUTOR_BLOCKED", "fs.edit_text replacement count mismatch: expected 1, observed 2", "policy_blocked");
      }
      throw new Error("fallback mutation must not occur");
    },
  });
  const surface = new DesktopCommanderCompatibilitySurface({ facade });
  const result = await surface.invoke(request("edit_block", {
    path: "C:\\tmp\\conflict.txt",
    old_string: "x",
    new_string: "y",
  }));
  assert.equal(result.status, "error");
  assert.equal(result.error.code, "REPLACEMENT_CONFLICT");
  assert.deepEqual(facade.calls.map((call) => call.tool), ["file.hash", "file.edit"]);
});

test("write_file uses explicit rewrite/append native actions and enforces byte bounds", async () => {
  const facade = new FakeFacade({
    actions: ["fs.write_text", "fs.append_text"],
    handler: async (envelope) => completed({
      path: envelope.arguments.path,
      bytes: Buffer.byteLength(envelope.arguments.text),
    }),
  });
  const surface = new DesktopCommanderCompatibilitySurface({ facade, maxTextBytes: 8 });
  const rewrite = await surface.invoke(request("write_file", {
    path: "C:\\tmp\\write.txt",
    content: "abc",
    mode: "rewrite",
  }, "write-1"));
  const append = await surface.invoke(request("write_file", {
    path: "C:\\tmp\\write.txt",
    content: "de",
    mode: "append",
  }, "write-2"));
  assert.equal(rewrite.status, "completed");
  assert.equal(append.status, "completed");
  assert.equal(facade.calls[0].tool, "file.write");
  assert.deepEqual(facade.calls[0].arguments, { path: "C:\\tmp\\write.txt", text: "abc", overwrite: true });
  assert.equal(facade.calls[1].tool, "file.append");
  assert.deepEqual(facade.calls[1].arguments, { path: "C:\\tmp\\write.txt", text: "de", create: true });

  const bounded = await surface.invoke(request("write_file", {
    path: "C:\\tmp\\large.txt",
    content: "123456789",
  }, "write-3"));
  assert.equal(bounded.status, "error");
  assert.equal(bounded.error.code, "RANGE_ERROR");
  assert.equal(facade.calls.length, 2);
});

test("missing variant capability is explicit CAPABILITY_UNAVAILABLE and never dispatches", async () => {
  const facade = new FakeFacade({ actions: ["fs.write_text"] });
  const surface = new DesktopCommanderCompatibilitySurface({ facade });
  const result = await surface.invoke(request("write_file", {
    path: "C:\\tmp\\append.txt",
    content: "x",
    mode: "append",
  }));
  assert.equal(result.status, "error");
  assert.equal(result.error.code, "CAPABILITY_UNAVAILABLE");
  assert.deepEqual(result.error.details.missing_executor_actions, ["fs.append_text"]);
  assert.equal(facade.calls.length, 0);
});

test("process lifecycle survives compatibility restart, repeated reads, finish, list and termination", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dc-compat-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let readCount = 0;
  const facade = new FakeFacade({
    actions: ["process.start", "process.read", "process.list", "process.terminate"],
    handler: async (envelope) => {
      if (envelope.tool === "process.start") {
        return completed({ process_handle: "proc-h-1", pid: 4242, running: true });
      }
      if (envelope.tool === "process.read") {
        readCount += 1;
        if (readCount === 1) {
          assert.equal(envelope.page.cursor, undefined);
          return completed({ items: ["first"], running: true, returncode: null }, {
            bounded: true,
            limit: envelope.page.limit,
            next_cursor: "native-cursor-1",
          });
        }
        assert.equal(envelope.page.cursor, "native-cursor-1");
        return completed({ items: ["second"], running: false, returncode: 0 }, {
          bounded: true,
          limit: envelope.page.limit,
          next_cursor: null,
        });
      }
      if (envelope.tool === "process.list") return completed({ processes: [] });
      if (envelope.tool === "process.terminate") return completed({ already_exited: true, returncode: 0 });
      throw new Error(`unexpected native tool ${envelope.tool}`);
    },
  });
  const storePath = join(root, "compat.json");
  let surface = new DesktopCommanderCompatibilitySurface({
    facade,
    store: new JsonDcCompatibilityStore(storePath),
  });
  const started = await surface.invoke(request("start_process", { command: "node task.js" }, "proc-start"));
  assert.equal(started.status, "completed");
  assert.equal(started.data.pid, 4242);

  surface = new DesktopCommanderCompatibilitySurface({
    facade,
    store: new JsonDcCompatibilityStore(storePath),
  });
  const first = await surface.invoke(request("read_process_output", {
    pid: 4242,
    offset: 0,
    length: 20,
  }, "proc-read-1"));
  assert.equal(first.data.output, "first");
  assert.equal(first.data.running, true);

  const second = await surface.invoke(request("read_process_output", {
    pid: 4242,
    offset: 0,
    length: 20,
  }, "proc-read-2"));
  assert.equal(second.data.output, "second");
  assert.equal(second.data.running, false);
  assert.equal(second.data.status, "finished");
  assert.equal(second.data.returncode, 0);

  const listed = await surface.invoke(request("list_sessions", {}, "proc-list"));
  assert.equal(listed.status, "completed");
  assert.deepEqual(listed.data.sessions, [{
    pid: 4242,
    running: false,
    status: "finished",
    returncode: 0,
    process_handle: "proc-h-1",
  }]);

  const terminated = await surface.invoke(request("force_terminate", { pid: 4242 }, "proc-stop"));
  assert.equal(terminated.status, "completed");
  assert.equal(terminated.data.terminated, true);
  assert.equal(terminated.data.already_exited, true);

  const callsBeforeStale = facade.calls.length;
  const stale = await surface.invoke(request("read_process_output", { pid: 4242 }, "proc-read-stale"));
  assert.equal(stale.status, "error");
  assert.equal(stale.error.code, "STALE_HANDLE");
  assert.equal(facade.calls.length, callsBeforeStale);
});

test("normalized compatibility errors cover access, stale handle, range, replacement and process failures", () => {
  const cases = [
    [{ code: "EACCES", message: "access denied" }, "ACCESS_DENIED"],
    [{ code: "STALE_PROCESS_HANDLE", message: "stale handle" }, "STALE_HANDLE"],
    [{ code: "PAGE_LIMIT_EXCEEDED", message: "bounds exceeded" }, "RANGE_ERROR"],
    [{ code: "EXECUTOR_BLOCKED", message: "replacement count mismatch" }, "REPLACEMENT_CONFLICT"],
    [{ code: "EXECUTOR_FAILED", message: "process spawn failed" }, "PROCESS_ERROR"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizeDesktopCommanderError(input).code, expected);
  }
});

test("extended compatibility tools delegate only through NativeFacade with explicit native mappings", async () => {
  const facade = new FakeFacade({
    actions: [
      "device.info",
      "health.get",
      "config.get",
      "config.set",
      "identity.get",
      "metrics.get",
      "audit.history",
      "fs.mkdir",
      "fs.list",
      "fs.move",
      "fs.stat",
      "search.start",
      "search.read",
      "search.stop",
      "search.list",
      "process.list",
      "system.process.kill",
      "fs.write_pdf",
      "device.shutdown",
    ],
    handler: async (envelope) => {
      switch (envelope.tool) {
        case "compat.device.info":
          return completed({ device_id: "local", platform: "test", generation_id: "gen-1" });
        case "compat.health.get":
          return completed({ status: "ok", managed_processes_live: 1 });
        case "compat.config.get":
          return completed({ mutable: false, limits: { max_text_read_bytes: 1024 } });
        case "compat.config.set":
          return completed({ key: envelope.arguments.key, value: envelope.arguments.value });
        case "compat.fs.mkdir":
          return completed({ path: envelope.arguments.path, created: true });
        case "compat.fs.list":
          return completed({ entries: [{ name: "a.txt", kind: "file" }] });
        case "compat.fs.move":
          return completed({ source: envelope.arguments.source, destination: envelope.arguments.destination });
        case "compat.fs.stat":
          return completed({ path: envelope.arguments.path, size: 7 });
        case "compat.search.start":
          return completed({ search_id: "search-1", status: "running" });
        case "compat.search.read":
          return completed({ results: [{ path: "C:\\tmp\\a.txt" }], status: "running" });
        case "compat.search.stop":
          return completed({ stopped: true });
        case "compat.search.list":
          return completed({ searches: [{ search_id: "search-1", status: "stopped" }] });
        case "compat.process.list_all":
          return completed({ processes: [{ pid: 99, name: "node.exe" }] });
        case "system.process.kill":
          return completed({ killed: true });
        case "compat.file.write_pdf":
          return completed({ path: envelope.arguments.path, output_path: envelope.arguments.output_path ?? envelope.arguments.path });
        case "compat.device.shutdown":
          return completed({ shutting_down: true });
        case "compat.identity.get":
          return completed({ controller: "pc_executor", device_id: "local" });
        case "compat.metrics.get":
          return completed({ available: true, completed_calls: 7 });
        case "compat.audit.history":
          return completed({ events: [{ tool: "read_file", timestamp: "2026-09-28T00:00:01Z" }] });
        default:
          throw new Error(`unexpected native tool ${envelope.tool}`);
      }
    },
  });
  const surface = new DesktopCommanderCompatibilitySurface({ facade, clock: () => 1234 });
  const devices = await surface.invoke(request("list_devices", {}, "ext-devices"));
  assert.equal(devices.status, "completed");
  assert.equal(devices.data.count, 1);
  assert.equal(devices.data.devices[0].device_id, "local");

  const ping = await surface.invoke(request("ping", {}, "ext-ping"));
  assert.equal(ping.data.pong, true);
  assert.equal(ping.data.health.status, "ok");

  const config = await surface.invoke(request("get_config", {}, "ext-config"));
  assert.equal(config.data.mutable, false);

  const setConfig = await surface.invoke(request("set_config_value", {
    key: "telemetryEnabled",
    value: false,
  }, "ext-set-config"));
  assert.equal(setConfig.status, "completed");

  const mkdir = await surface.invoke(request("create_directory", {
    path: "C:\\tmp\\new-dir",
  }, "ext-mkdir"));
  assert.equal(mkdir.data.created, true);

  const listed = await surface.invoke(request("list_directory", {
    path: "C:\\tmp",
    depth: 2,
  }, "ext-list"));
  assert.equal(listed.data.entries[0].name, "a.txt");

  const moved = await surface.invoke(request("move_file", {
    source: "C:\\tmp\\a.txt",
    destination: "C:\\tmp\\b.txt",
  }, "ext-move"));
  assert.equal(moved.status, "completed");

  const info = await surface.invoke(request("get_file_info", {
    path: "C:\\tmp\\b.txt",
  }, "ext-info"));
  assert.equal(info.data.size, 7);

  const startedSearch = await surface.invoke(request("start_search", {
    path: "C:\\tmp",
    pattern: "needle",
    searchType: "content",
    literalSearch: true,
    ignoreCase: false,
    contextLines: 3,
    maxResults: 20,
    timeout_ms: 5000,
  }, "ext-search-start"));
  assert.equal(startedSearch.data.sessionId, "search-1");
  const searchRead = await surface.invoke(request("get_more_search_results", {
    sessionId: "search-1",
    offset: -5,
    length: 2,
  }, "ext-search-read"));
  assert.equal(searchRead.data.sessionId, "search-1");

  const searchStop = await surface.invoke(request("stop_search", {
    sessionId: "search-1",
  }, "ext-search-stop"));
  assert.equal(searchStop.data.stopped, true);

  const searches = await surface.invoke(request("list_searches", {}, "ext-search-list"));
  assert.equal(searches.data.searches.length, 1);

  const processes = await surface.invoke(request("list_processes", {}, "ext-processes"));
  assert.equal(processes.data.processes[0].pid, 99);

  const killed = await surface.invoke(request("kill_process", { pid: 99 }, "ext-kill"));
  assert.equal(killed.data.killed, true);

  const pdf = await surface.invoke(request("write_pdf", {
    path: "C:\\tmp\\input.pdf",
    content: "# Test",
    outputPath: "C:\\tmp\\output.pdf",
  }, "ext-pdf"));
  assert.equal(pdf.data.output_path, "C:\\tmp\\output.pdf");

  const who = await surface.invoke(request("who_am_i", {}, "ext-who"));
  assert.equal(who.data.identity_kind, "native_controller");
  assert.equal(who.data.vendor_account_identity, null);

  const usage = await surface.invoke(request("get_usage_stats", {}, "ext-usage"));
  assert.equal(usage.data.source, "native_operation_metrics");
  assert.equal(usage.data.vendor_billing_telemetry, null);

  const recent = await surface.invoke(request("get_recent_tool_calls", {
    maxResults: 10,
    toolName: "read_file",
    since: "2026-09-28T00:00:00Z",
  }, "ext-recent"));
  assert.equal(recent.data.events[0].tool, "read_file");

  const shutdown = await surface.invoke(request("shutdown", {}, "ext-shutdown"));
  assert.equal(shutdown.data.shutting_down, true);

  const byId = Object.fromEntries(facade.calls.map((call) => [call.request_id, call]));
  assert.equal(byId["ext-ping"].tool, "compat.health.get");
  assert.equal(byId["ext-config"].tool, "compat.config.get");
  assert.deepEqual(byId["ext-search-start"].arguments, {
    path: "C:\\tmp",
    pattern: "needle",
    search_type: "content",
    literal_search: true,
    ignore_case: false,
    include_hidden: false,
    context_lines: 3,
    max_results: 20,
    timeout_ms: 5000,
  });
  assert.deepEqual(byId["ext-search-read"].arguments, {
    search_id: "search-1",
    offset: -5,
    length: 2,
  });
  assert.equal(byId["ext-who"].tool, "compat.identity.get");
  assert.equal(byId["ext-usage"].tool, "compat.metrics.get");
  assert.equal(byId["ext-recent"].tool, "compat.audit.history");
  assert.equal(byId["ext-kill"].tool, "system.process.kill");
  assert.deepEqual(byId["ext-kill"].arguments, {
    pid: 99,
    expected_name: "node.exe",
    exit_code: 1,
  });
  assert.equal(byId["ext-mkdir"].tool, "compat.fs.mkdir");
  assert.equal(byId["ext-list"].tool, "compat.fs.list");
  assert.equal(byId["ext-move"].tool, "compat.fs.move");
  assert.equal(byId["ext-info"].tool, "compat.fs.stat");
});
test("future PC capabilities remain explicit CAPABILITY_UNAVAILABLE with zero dispatch", async () => {
  const facade = new FakeFacade({ actions: ["fs.read_text"] });
  const surface = new DesktopCommanderCompatibilitySurface({ facade });
  const unavailableCalls = [
    ["list_devices", {}],
    ["set_config_value", { key: "x", value: true }],
    ["start_search", { path: "C:\\tmp", pattern: "x" }],
    ["write_pdf", { path: "C:\\tmp\\x.pdf", content: "# x" }],
    ["shutdown", {}],
    ["get_recent_tool_calls", {}],
  ];
  for (let index = 0; index < unavailableCalls.length; index += 1) {
    const [tool, args] = unavailableCalls[index];
    const result = await surface.invoke(request(tool, args, `unavailable-${index}`));
    assert.equal(result.status, "error", tool);
    assert.equal(result.error.code, "CAPABILITY_UNAVAILABLE", tool);
  }
  assert.equal(facade.calls.length, 0);
});

test("interact_with_process uses only the durable NativeFacade process handle", async () => {
  const facade = new FakeFacade({
    actions: ["process.start", "process.interact"],
    handler: async (envelope) => {
      if (envelope.tool === "process.start") {
        return completed({ process_handle: "proc-interactive", pid: 5151, running: true });
      }
      if (envelope.tool === "process.interact") {
        assert.deepEqual(envelope.arguments, { handle: "proc-interactive", input: "print(1)\n" });
        return completed({ output: "1\n", running: true });
      }
      throw new Error(`unexpected ${envelope.tool}`);
    },
  });
  const surface = new DesktopCommanderCompatibilitySurface({ facade });
  const started = await surface.invoke(request("start_process", { command: "python -i" }, "interactive-start"));
  assert.equal(started.data.pid, 5151);
  const interacted = await surface.invoke(request("interact_with_process", {
    pid: 5151,
    input: "print(1)\n",
    wait_for_prompt: true,
    timeout_ms: 1000,
  }, "interactive-write"));
  assert.equal(interacted.status, "completed");
  assert.equal(interacted.data.output, "1\n");
});

test("PC-Core fs.read_many is used as one true batch when advertised", async () => {
  const facade = new FakeFacade({
    actions: ["fs.read_many"],
    handler: async (envelope) => {
      assert.equal(envelope.tool, "compat.file.read_many");
      assert.deepEqual(envelope.arguments, {
        paths: ["C:\\tmp\\one.txt", "C:\\tmp\\two.txt"],
      });
      return completed({
        results: [
          {
            path: "C:\\tmp\\one.txt",
            ok: true,
            text: "one",
            returned_bytes: 3,
            file_bytes: 3,
            truncated: false,
            sha256: "1".repeat(64),
          },
          {
            path: "C:\\tmp\\two.txt",
            ok: false,
            error: { code: "FILE_NOT_FOUND" },
          },
        ],
      });
    },
  });
  const surface = new DesktopCommanderCompatibilitySurface({ facade });
  const result = await surface.invoke(request("read_multiple_files", {
    paths: ["C:\\tmp\\one.txt", "C:\\tmp\\two.txt"],
  }, "native-batch"));
  assert.equal(result.status, "completed");
  assert.equal(result.data.count, 2);
  assert.equal(result.data.succeeded, 1);
  assert.equal(result.data.failed, 1);
  assert.equal(result.data.results[0].data.content, "one");
  assert.equal(result.data.results[1].error.code, "FILE_NOT_FOUND");
  assert.equal(facade.calls.length, 1);
  assert.equal(facade.calls[0].request_id, "native-batch");
});

test("PC-Core process compatibility variants bind published managed-process actions", async () => {
  const facade = new FakeFacade({
    actions: [
      "process.start",
      "process.read_output",
      "process.managed.list",
      "shell.session.write_stdin",
    ],
    handler: async (envelope) => {
      if (envelope.tool === "process.start") {
        return completed({ process_handle: "pc-core-handle", pid: 6161, running: true });
      }
      if (envelope.tool === "compat.process.read_output") {
        assert.equal(envelope.arguments.handle_id, "pc-core-handle");
        return completed({
          stdout: "ready\n",
          stderr: "",
          cursor: { handle_id: "pc-core-handle", stdout_offset: 6, stderr_offset: 0 },
          running: true,
          returncode: null,
        });
      }
      if (envelope.tool === "compat.process.managed.list") {
        return completed({
          handles: [{
            handle_id: "pc-core-handle",
            kind: "process",
            pid: 6161,
            status: "running",
            owned_by_current_gateway: true,
            returncode: null,
          }],
        });
      }
      if (envelope.tool === "compat.shell.session.write_stdin") {
        assert.deepEqual(envelope.arguments, {
          session_id: "pc-core-handle",
          text: "print(1)\n",
          append_newline: false,
          sensitive: false,
        });
        return completed({ session_id: "pc-core-handle", written_bytes: 9 });
      }
      throw new Error(`unexpected ${envelope.tool}`);
    },
  });
  const surface = new DesktopCommanderCompatibilitySurface({ facade });
  const started = await surface.invoke(request("start_process", {
    command: "python -i",
  }, "pc-core-process-start"));
  assert.equal(started.data.pid, 6161);

  const output = await surface.invoke(request("read_process_output", {
    pid: 6161,
    offset: 0,
    length: 20,
    timeout_ms: 1000,
  }, "pc-core-process-read"));
  assert.equal(output.status, "completed");
  assert.equal(output.data.output, "ready\n");

  const sessions = await surface.invoke(request("list_sessions", {}, "pc-core-process-list"));
  assert.equal(sessions.data.sessions[0].pid, 6161);
  assert.equal(sessions.data.sessions[0].running, true);

  const interacted = await surface.invoke(request("interact_with_process", {
    pid: 6161,
    input: "print(1)\n",
  }, "pc-core-process-write"));
  assert.equal(interacted.status, "completed");
  assert.equal(facade.calls.find((call) => call.request_id === "pc-core-process-read").tool, "compat.process.read_output");
  assert.equal(facade.calls.find((call) => call.request_id === "pc-core-process-list").tool, "compat.process.managed.list");
  assert.equal(facade.calls.find((call) => call.request_id === "pc-core-process-write").tool, "compat.shell.session.write_stdin");
});
