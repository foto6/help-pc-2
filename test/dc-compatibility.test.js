import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DC_COMPATIBILITY_REGISTRY_V1,
  DC_COMPATIBILITY_REGISTRY_DIGEST,
  DC_COMPATIBILITY_REGISTRY_LIST,
  DC_VENDOR_NON_EQUIVALENTS,
  DESKTOP_COMMANDER_REFERENCE_VERSION,
  DesktopCommanderCompatibilitySurface,
  JsonDcCompatibilityStore,
  desktopCommanderCompatibilityManifestV1,
  normalizeDesktopCommanderError,
} from "../src/index.js";

const REQUIRED_NAMES = [
  "list_devices", "ping", "shutdown", "get_config", "set_config_value",
  "read_file", "read_multiple_files", "write_file", "write_pdf",
  "create_directory", "list_directory", "move_file",
  "start_search", "get_more_search_results", "stop_search", "list_searches",
  "get_file_info", "edit_block", "start_process", "read_process_output",
  "interact_with_process", "force_terminate", "list_sessions",
  "list_processes", "kill_process", "who_am_i", "get_usage_stats",
  "get_recent_tool_calls",
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
  assert.equal(DESKTOP_COMMANDER_REFERENCE_VERSION, "0.2.51");
  assert.deepEqual(
    DC_VENDOR_NON_EQUIVALENTS.map((entry) => entry.name).sort(),
    ["get_prompts", "give_feedback_to_desktop_commander"].sort(),
  );
  assert.match(DC_COMPATIBILITY_REGISTRY_DIGEST, /^[0-9a-f]{64}$/);
  assert.deepEqual(DC_COMPATIBILITY_REGISTRY_LIST.map((tool) => tool.name).sort(), REQUIRED_NAMES);
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
  const processReadVariant = processRead.capability_variants.find((variant) => variant.id === "pc_core_process");
  assert.deepEqual(processReadVariant.missing_executor_actions, ["process.read_output"]);
});


test("future mutable/PDF/batch/search capabilities become available from the live manifest without host-side fallback", async () => {
  const manifest = desktopCommanderCompatibilityManifestV1({
    nativeManifest: await new FakeFacade({
      actions: [
        "device.shutdown", "config.set", "fs.read_many", "pdf.write",
        "search.start", "search.read", "search.list", "search.stop",
        "identity.get", "metrics.get", "audit.history",
      ],
    }).capabilities(),
  });
  const status = Object.fromEntries(manifest.tools.map((tool) => [tool.name, tool.available]));
  for (const name of [
    "shutdown", "set_config_value", "read_multiple_files", "write_pdf",
    "start_search", "get_more_search_results", "list_searches", "stop_search",
    "who_am_i", "get_usage_stats", "get_recent_tool_calls",
  ]) {
    assert.equal(status[name], true, name);
  }
});

test("current green PC Core capability set exposes every required compatibility tool except PDF", async () => {
  const currentActions = [
    "device.info", "health.get", "config.get", "config.set", "device.shutdown",
    "fs.read_text", "fs.read_many", "fs.write_text", "fs.append_text", "fs.mkdir", "fs.list", "fs.move", "fs.stat", "fs.hash", "fs.edit_text",
    "search.start", "search.read", "search.list", "search.stop",
    "shell.session.start", "shell.session.read", "shell.session.write_stdin", "shell.session.terminate",
    "process.managed.list", "process.list", "system.process.kill",
    "identity.get", "metrics.get", "audit.history",
  ];
  const facade = new FakeFacade({ actions: currentActions });
  const manifest = desktopCommanderCompatibilityManifestV1({ nativeManifest: await facade.capabilities() });
  const status = Object.fromEntries(manifest.tools.map((tool) => [tool.name, tool]));
  for (const name of REQUIRED_NAMES.filter((name) => name !== "write_pdf")) {
    assert.equal(status[name].available, true, name);
    assert.equal(status[name].availability_reason, "available", name);
  }
  assert.equal(status.write_pdf.available, false);
  assert.equal(status.write_pdf.availability_reason, "required_native_capability_unavailable");
  assert.deepEqual(status.write_pdf.capability_variants[0].missing_executor_actions, ["pdf.write"]);
});

test("write_pdf is explicit capability unavailable and never dispatches without pdf.write", async () => {
  const facade = new FakeFacade({ actions: ["fs.write_text"] });
  const surface = new DesktopCommanderCompatibilitySurface({ facade });
  const result = await surface.invoke(request("write_pdf", {
    path: "C:\\tmp\\out.pdf",
    content: "# document",
  }, "pdf-gap"));
  assert.equal(result.status, "error");
  assert.equal(result.error.code, "CAPABILITY_UNAVAILABLE");
  assert.equal(facade.calls.length, 0);
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
      assert.equal(envelope.page, undefined);
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

test("read_multiple_files uses one true-batch native action with deterministic per-file records", async () => {
  const paths = ["C:\tmp\a.txt", "C:\tmp\missing.txt", "C:\tmp\b.txt"];
  const facade = new FakeFacade({
    actions: ["fs.read_many"],
    handler: async (envelope) => {
      assert.equal(envelope.tool, "file.read_many");
      assert.deepEqual(envelope.arguments, { paths });
      return completed({
        results: [
          { path: paths[0], ok: true, text: "A", encoding: "utf-8", returned_bytes: 1, file_bytes: 1, truncated: false, sha256: "a".repeat(64) },
          { path: paths[1], ok: false, error: { code: "NOT_FOUND" } },
          { path: paths[2], ok: true, text: "B", encoding: "utf-8", returned_bytes: 1, file_bytes: 1, truncated: false, sha256: "b".repeat(64) },
        ],
      });
    },
  });
  const surface = new DesktopCommanderCompatibilitySurface({ facade });
  const result = await surface.invoke(request("read_multiple_files", { paths }, "batch-7"));
  assert.equal(result.status, "completed");
  assert.equal(result.data.count, 3);
  assert.equal(result.data.succeeded, 2);
  assert.equal(result.data.failed, 1);
  assert.deepEqual(result.data.results.map((item) => item.path), paths);
  assert.equal(result.data.results[1].error.code, "FILE_NOT_FOUND");
  assert.equal(facade.calls.length, 1);
  assert.equal(facade.calls[0].request_id, "batch-7");
});

test("read_multiple_files fails closed without fs.read_many and never composes serial reads", async () => {
  const facade = new FakeFacade({ actions: ["fs.read_text"] });
  const surface = new DesktopCommanderCompatibilitySurface({ facade });
  const result = await surface.invoke(request("read_multiple_files", {
    paths: ["C:\tmp\a.txt", "C:\tmp\b.txt"],
  }, "batch-unavailable"));
  assert.equal(result.status, "error");
  assert.equal(result.error.code, "CAPABILITY_UNAVAILABLE");
  assert.equal(facade.calls.length, 0);
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

test("current PC Core process/session and sanitized meta contracts are translated exactly", async () => {
  let reads = 0;
  const facade = new FakeFacade({
    actions: [
      "shell.session.start", "shell.session.read", "shell.session.write_stdin", "shell.session.terminate",
      "process.managed.list", "metrics.get", "audit.history", "identity.get",
    ],
    handler: async (envelope) => {
      if (envelope.tool === "shell.session.start") {
        assert.deepEqual(envelope.arguments.argv, ["python", "-i"]);
        return completed({ handle_id: "session-h-1", session_id: "session-h-1", pid: 7331, kind: "session" });
      }
      if (envelope.tool === "shell.session.read") {
        reads += 1;
        if (reads === 2) assert.deepEqual(envelope.arguments.cursor, { version: "cursor-v1", handle_id: "session-h-1", stdout_offset: 3, stderr_offset: 0 });
        return completed({
          stdout: reads === 1 ? ">>> " : "ok\n>>> ",
          stderr: "",
          cursor: { version: "cursor-v1", handle_id: "session-h-1", stdout_offset: reads * 3, stderr_offset: 0 },
          running: true,
          returncode: null,
        });
      }
      if (envelope.tool === "shell.session.write_stdin") {
        assert.deepEqual(envelope.arguments, {
          session_id: "session-h-1", text: "print('ok')", append_newline: false, sensitive: false,
        });
        return completed({ session_id: "session-h-1", written_bytes: 11 });
      }
      if (envelope.tool === "process.managed.list") return completed({ handles: [{ handle_id: "session-h-1", pid: 7331, kind: "session", running: true }] });
      if (envelope.tool === "shell.session.terminate") return completed({ handle_id: "session-h-1", already_exited: false, returncode: 0 });
      if (envelope.tool === "metrics.get") return completed({ available: true, sanitized: true, actions: { "shell.session.start": 1 }, outcomes: { succeeded: 1 } });
      if (envelope.tool === "audit.recent") return completed({ contract_version: "pc_executor.audit_history.v1", sanitized: true, events: [{ action: "fs.read_text", phase: "completed", timestamp: "2026-09-28T00:00:00Z" }] });
      if (envelope.tool === "identity.get") return completed({ controller: "pc_executor", device_id: "device-1", session_epoch: "epoch-1", transport: "native_remote" });
      throw new Error(`unexpected native tool ${envelope.tool}`);
    },
  });
  const surface = new DesktopCommanderCompatibilitySurface({ facade });
  const started = await surface.invoke(request("start_process", { command: "python -i" }, "core-start"));
  assert.equal(started.status, "completed");
  assert.equal(started.data.native_variant, "pc_core_interactive_session");
  assert.equal(started.data.pid, 7331);

  const first = await surface.invoke(request("read_process_output", { pid: 7331, offset: 0, length: 20 }, "core-read-1"));
  const second = await surface.invoke(request("read_process_output", { pid: 7331, offset: 0, length: 20 }, "core-read-2"));
  assert.equal(first.data.output, ">>> ");
  assert.equal(second.data.output, "ok\n>>> ");

  const interacted = await surface.invoke(request("interact_with_process", { pid: 7331, input: "print('ok')" }, "core-input"));
  assert.equal(interacted.status, "completed");
  assert.equal(interacted.data.native_variant, "pc_core_session");

  const sessions = await surface.invoke(request("list_sessions", {}, "core-list"));
  assert.equal(sessions.data.sessions[0].pid, 7331);

  const identity = await surface.invoke(request("who_am_i", {}, "core-id"));
  assert.equal(identity.data.controller, "pc_executor");
  const usage = await surface.invoke(request("get_usage_stats", {}, "core-metrics"));
  assert.equal(usage.data.sanitized, true);
  assert.equal(usage.data.connector_billing_available, false);
  const recent = await surface.invoke(request("get_recent_tool_calls", { maxResults: 10, toolName: "fs.read_text" }, "core-audit"));
  assert.equal(recent.data.calls.length, 1);
  assert.equal(recent.data.calls[0].action, "fs.read_text");

  const stopped = await surface.invoke(request("force_terminate", { pid: 7331 }, "core-stop"));
  assert.equal(stopped.status, "completed");
  assert.equal(stopped.data.returncode, 0);
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
