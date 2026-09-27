import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DC_COMPATIBILITY_REGISTRY_V1,
  DC_COMPATIBILITY_REGISTRY_DIGEST,
  DC_COMPATIBILITY_REGISTRY_LIST,
  DesktopCommanderCompatibilitySurface,
  JsonDcCompatibilityStore,
  desktopCommanderCompatibilityManifestV1,
  normalizeDesktopCommanderError,
} from "../src/index.js";

const REQUIRED_NAMES = [
  "edit_block",
  "read_file",
  "read_multiple_files",
  "write_file",
  "start_process",
  "read_process_output",
  "list_sessions",
  "force_terminate",
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
  assert.deepEqual(processRead.capability_variants[0].missing_executor_actions, ["process.read"]);
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
