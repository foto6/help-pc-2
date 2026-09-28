import test from "node:test";
import assert from "node:assert/strict";
import {
  FULL_COMPAT_AUDIT_V1, FullCompatibilityAuditError,
  assertPinnedNativeManifest, fullCompatibilityAuditV1,
} from "../src/full-compat-observability.js";
import {
  NATIVE_CONTROL_PROTOCOL_V1, NATIVE_TOOL_REGISTRY_V1, TOOL_REGISTRY_LIST,
  TOOL_REGISTRY_DIGEST, nativeCapabilityManifestV1,
} from "../src/native-registry.js";
import {
  PC_FROZEN_REGISTRY_V1, PC_PARITY_REGISTRY_V1, PC_NATIVE_WIRE_ROUTES,
  PINNED_PC_FROZEN_DIGEST, routeNativeExecutorTool,
} from "../src/native-relay-registry-route.js";
import {
  DC_COMPATIBILITY_REGISTRY_LIST, DC_VENDOR_NON_EQUIVALENTS,
} from "../src/dc-compatibility-registry.js";
import {
  DesktopCommanderCompatibilitySurface, normalizeDesktopCommanderError,
} from "../src/dc-compatibility.js";

const ALL_ACTIONS = [...new Set([
  ...TOOL_REGISTRY_LIST.map((tool) => tool.executorAction),
  ...DC_COMPATIBILITY_REGISTRY_LIST.flatMap((tool) =>
    tool.capability_variants.flatMap((variant) => variant.executor_actions)),
])].sort();

function manifest(actions = ALL_ACTIONS) {
  return nativeCapabilityManifestV1({
    executorCapabilities: {
      contract_version: "pc_executor.capabilities.v1",
      digest: "sha256:fixture-executor-immutable",
      actions,
    },
  });
}
function nativeResponse(envelope, { status = "completed", data = {}, error = null } = {}) {
  return {
    contract_version: "pc.native.response.v1",
    request_id: envelope.request_id,
    session_id: envelope.session_id,
    status,
    data,
    error,
    stream: null,
  };
}
function request(tool, args, requestId = "logical-r16") {
  return {
    contract_version: "pc.desktop_commander.compat_request.v1",
    request_id: requestId,
    session_id: "session-r16",
    tool,
    arguments: args,
  };
}
function fakeFacade(actions, handler) {
  const calls = [];
  return {
    calls,
    capabilities: async () => manifest(actions),
    async invoke(envelope) {
      calls.push(structuredClone(envelope));
      return handler(envelope);
    },
  };
}

test("R16 audit freezes exactly 62 routed native tools, 28 mandatory DC and 2 explicit exclusions", () => {
  const audit = fullCompatibilityAuditV1({ nativeManifest: manifest() });
  assert.equal(audit.contract_version, FULL_COMPAT_AUDIT_V1);
  assert.equal(audit.protocol_version, NATIVE_CONTROL_PROTOCOL_V1);
  assert.equal(audit.control_registry_digest, TOOL_REGISTRY_DIGEST);
  assert.equal(audit.pc_frozen_registry_digest, PINNED_PC_FROZEN_DIGEST);
  assert.match(audit.route_digest, /^[0-9a-f]{64}$/);
  assert.equal(audit.executor_digest, "sha256:fixture-executor-immutable");
  assert.equal(audit.native_routes.total, 62);
  assert.equal(audit.native_routes.frozen, 37);
  assert.equal(audit.native_routes.parity, 25);
  assert.equal(new Set(audit.native_routes.rows.map((row) => row.name)).size, 62);
  assert.equal(audit.public_catalog.mandatory, 28);
  assert.deepEqual([...audit.public_catalog.vendor_non_equivalents].sort(),
    ["get_prompts", "give_feedback_to_desktop_commander"].sort());
  assert.equal(audit.public_catalog.mandatory + audit.public_catalog.vendor_non_equivalents.length, 30);
  assert.equal(audit.public_catalog.available, 28);
  assert.equal(DC_VENDOR_NON_EQUIVALENTS.length, 2);
});

test("all 62 aliases preserve exact Executor action and effect; native UI observations stay read-only", () => {
  const rows = fullCompatibilityAuditV1({ nativeManifest: manifest() }).native_routes.rows;
  const source = new Map(TOOL_REGISTRY_LIST.map((entry) => [entry.name, entry]));
  assert.deepEqual(rows.map((row) => row.name),
    [...TOOL_REGISTRY_LIST.map((entry) => entry.name)].sort());
  for (const row of rows) {
    const original = source.get(row.name);
    const route = routeNativeExecutorTool(row.name, original.executorAction, original.effect);
    assert.equal(row.executor_action, original.executorAction, row.name);
    assert.equal(row.effect, original.effect, row.name);
    assert.equal(row.wire_tool, route.wireToolName, row.name);
    assert.equal(row.registry_version, route.registryVersion, row.name);
    assert.equal(row.alias, row.wire_tool !== row.name, row.name);
    if (row.registry_version === PC_FROZEN_REGISTRY_V1) assert.equal(row.wire_tool, row.name);
    else assert.equal(row.registry_version, PC_PARITY_REGISTRY_V1);
    assert.throws(
      () => routeNativeExecutorTool(row.name, "forbidden.remap", row.effect),
      (error) => error.code === "NATIVE_WIRE_REGISTRY_MISMATCH",
      row.name,
    );
    assert.throws(
      () => routeNativeExecutorTool(row.name, row.executor_action,
        row.effect === "read_only" ? "side_effect" : "read_only"),
      (error) => error.code === "NATIVE_WIRE_REGISTRY_MISMATCH",
      row.name,
    );
  }
  const uiReads = ["window.list", "screenshot.capture", "uia.find", "system.process.inspect"];
  for (const name of uiReads) assert.equal(source.get(name).effect, "read_only", name);
  const uiEffects = ["uia.invoke", "input.click", "input.type"];
  for (const name of uiEffects) assert.equal(source.get(name).effect, "side_effect", name);
});

test("all public capability variants use registered native routes without read-only effect escalation", () => {
  const known = new Map(TOOL_REGISTRY_LIST.map((tool) => [tool.name, tool]));
  for (const definition of DC_COMPATIBILITY_REGISTRY_LIST) {
    assert.ok(definition.capability_variants.length >= 1);
    for (const variant of definition.capability_variants) {
      const selected = variant.native_tools.map((name) => {
        assert.ok(known.has(name), definition.name + ":" + name);
        return known.get(name);
      });
      if (definition.effect === "read_only") {
        assert.ok(selected.every((tool) => tool.effect === "read_only"), definition.name);
      } else {
        assert.ok(selected.some((tool) => tool.effect === "side_effect"), definition.name);
      }
    }
  }
});

test("malformed protocol, registry and Executor digest/action identity fail closed", () => {
  for (const patch of [
    { contract_version: "pc.native.tool_registry.v2" },
    { protocol_version: "pc.native.control.v2" },
    { registry_digest: "forged-registry" },
    { executor: null },
    { executor: { ...manifest().executor, digest: "" } },
    { executor: { ...manifest().executor, contract_version: "pc_executor.capabilities.v2" } },
    { executor: { ...manifest().executor, actions: ["fs.list", "fs.list"] } },
  ]) {
    const forged = { ...manifest(), ...patch };
    assert.throws(
      () => assertPinnedNativeManifest(forged),
      (error) => error instanceof FullCompatibilityAuditError &&
        ["NATIVE_REGISTRY_IDENTITY_MISMATCH", "EXECUTOR_CAPABILITY_IDENTITY_INVALID"].includes(error.code));
    assert.throws(() => fullCompatibilityAuditV1({ nativeManifest: forged }),
      (error) => error instanceof FullCompatibilityAuditError);
  }
});

test("public availability is observed from pinned Executor actions; missing capabilities never imply fallback", () => {
  const audit = fullCompatibilityAuditV1({ nativeManifest: manifest(["fs.read_text"]) });
  const byName = new Map(audit.public_catalog.tools.map((tool) => [tool.name, tool]));
  for (const name of ["read_multiple_files", "write_pdf", "start_search", "list_sessions",
    "who_am_i", "get_usage_stats", "get_recent_tool_calls"]) {
    assert.equal(byName.get(name).available, false, name);
    assert.equal(byName.get(name).availability_reason, "required_native_capability_unavailable", name);
    assert.equal(byName.get(name).selected_variant, null, name);
  }
  assert.equal(byName.get("read_file").available, true);
  assert.equal(audit.public_catalog.mandatory, 28);
});

test("non-file TOOL_NOT_FOUND, session/search/timeout/unknown never become FILE_NOT_FOUND", () => {
  for (const entry of [
    ["TOOL_NOT_FOUND", "tool", "Missing file permission for an unknown tool", "read_file"],
    ["STALE_SESSION", "session", "Session not found in file journal", "list_devices"],
    ["SEARCH_SESSION_NOT_FOUND", "search", "Search file not found", "get_more_search_results"],
    ["TIMEOUT", "timeout", "Process file offset expired", "read_process_output"],
    ["UNKNOWN_RECONCILE", "idempotency", "Result not found, permission unproven", "write_file"],
    ["DUPLICATE_REQUEST_MISMATCH", "idempotency", "File not found", "move_file"],
  ]) {
    const [code, category, message, tool] = entry;
    const normalized = normalizeDesktopCommanderError({ code, category, message }, { tool });
    assert.equal(normalized.code, code, code);
    assert.equal(normalized.category, category, code);
    assert.notEqual(normalized.code, "FILE_NOT_FOUND", code);
    assert.equal(normalized.retryable, false);
  }
  assert.equal(normalizeDesktopCommanderError(
    { code: "ENOENT", category: "filesystem", message: "No such file" },
    { tool: "read_file" }).code, "FILE_NOT_FOUND");
  assert.equal(normalizeDesktopCommanderError(
    { code: "NOT_FOUND", message: "Not found" }, { tool: "ping" }).code, "NOT_FOUND");
});

test("batch partial-file failures preserve order and non-file error domain without serial fallback", async () => {
  const paths = ["C:\\fixture\\a.txt", "C:\\fixture\\b.txt", "C:\\fixture\\c.txt"];
  const facade = fakeFacade(["fs.read_multiple"], async (env) => nativeResponse(env, { data: {
    results: [
      { path: paths[0], ok: true, text: "A" },
      { path: paths[1], ok: false,
        error: { code: "TOOL_NOT_FOUND", category: "tool", message: "No file tool registered", retryable: false } },
      { path: paths[2], ok: false,
        error: { code: "ENOENT", category: "filesystem", message: "No such file", retryable: false } },
    ],
  }}));
  const surface = new DesktopCommanderCompatibilitySurface({ facade });
  const result = await surface.invoke(request("read_multiple_files", { paths }, "batch-r16"));
  assert.equal(result.status, "completed");
  assert.deepEqual(result.data.results.map((row) => row.path), paths);
  assert.deepEqual(result.data.results.map((row) => row.ok), [true, false, false]);
  assert.equal(result.data.results[1].error.code, "TOOL_NOT_FOUND");
  assert.equal(result.data.results[1].error.category, "tool");
  assert.equal(result.data.results[2].error.code, "FILE_NOT_FOUND");
  assert.equal(result.data.succeeded, 1);
  assert.equal(result.data.failed, 2);
  assert.equal(facade.calls.length, 1);
  assert.equal(facade.calls[0].request_id, "batch-r16");
  assert.equal(facade.calls[0].tool, "file.read_multiple");
});

test("malformed partial batch and cursor continuation fail as error rather than fabricated success", async () => {
  const paths = ["C:\\fixture\\a.txt", "C:\\fixture\\b.txt"];
  const facade = fakeFacade(["fs.read_multiple"], async (env) => nativeResponse(env, {
    data: { results: [{ path: paths[0], ok: true, text: "A" }, { path: paths[1] }] },
  }));
  const surface = new DesktopCommanderCompatibilitySurface({ facade });
  const bad = await surface.invoke(request("read_multiple_files", { paths }));
  assert.equal(bad.status, "error");
  assert.equal(bad.error.code, "NATIVE_RESULT_INVALID");
  assert.equal(facade.calls.length, 1);

  const pageFacade = fakeFacade(["fs.list"], async (env) => nativeResponse(env, {
    data: { entries: [{ path: "C:\\fixture\\sub.txt", kind: "file" }], has_more: true, next_offset: 0 },
  }));
  const pageSurface = new DesktopCommanderCompatibilitySurface({ facade: pageFacade });
  const loop = await pageSurface.invoke(request("list_directory", { path: "C:\\fixture", depth: 1 }));
  assert.equal(loop.status, "error");
  assert.equal(loop.error.code, "NATIVE_RESULT_INVALID");
  assert.equal(pageFacade.calls.length, 1);
});

test("facade response schema and request/session identity drift fail closed", async () => {
  for (const corruption of [
    { contract_version: "pc.native.response.v2" },
    { request_id: "another-logical-request" },
    { session_id: "stale-session" },
    { status: "unknown-success" },
  ]) {
    const facade = fakeFacade(["fs.read_text"], async (env) => ({
      ...nativeResponse(env, { data: { text: "safe" } }), ...corruption,
    }));
    const surface = new DesktopCommanderCompatibilitySurface({ facade });
    const result = await surface.invoke(request("read_file", { path: "C:\\fixture\\a.txt" }));
    assert.equal(result.status, "error");
    assert.equal(result.error.code, "NATIVE_RESULT_INVALID");
    assert.equal(result.error.retryable, false);
    assert.equal(facade.calls.length, 1);
  }
});

test("UNKNOWN side-effect completion retains one durable request identity; lookup only, never replacement dispatch", async () => {
  const requests = new Map();
  let providerDispatches = 0;
  const facade = fakeFacade(["fs.write_text"], async (env) => {
    const key = env.session_id + ":" + env.request_id;
    if (!requests.has(key)) {
      providerDispatches += 1;
      requests.set(key, nativeResponse(env, {
        status: "reconciliation_required",
        data: { action_id: "journal-action-1", lookup_required: true, action_status: "uncertain_outcome" },
      }));
    }
    return structuredClone(requests.get(key));
  });
  const surface = new DesktopCommanderCompatibilitySurface({ facade });
  const args = { path: "C:\\fixture\\once.txt", content: "non-destructive fixture text" };
  const first = await surface.invoke(request("write_file", args, "side-effect-one"));
  const second = await surface.invoke(request("write_file", args, "side-effect-one"));
  assert.equal(first.status, "reconciliation_required");
  assert.equal(second.status, "reconciliation_required");
  assert.equal(first.data.lookup_required, true);
  assert.equal(first.data.automatic_replay, false);
  assert.equal(second.data.action_id, "journal-action-1");
  assert.equal(providerDispatches, 1);
  assert.deepEqual(facade.calls.map((call) => call.request_id),
    ["side-effect-one", "side-effect-one"]);
  assert.deepEqual(facade.calls.map((call) => call.tool), ["file.write", "file.write"]);
});

test("managed session pagination uses deterministic request children and preserves exact running identity", async () => {
  const state = {
    version: 1,
    processes: [{
      sessionId: "session-r16", pid: 101, handle: "handle-101",
      kind: "session", status: "running", running: true, returncode: null,
      lastCursor: null, startedAtMs: 1, updatedAtMs: 1,
    }],
  };
  const store = {
    load: () => structuredClone(state),
    save: (next) => Object.assign(state, structuredClone(next)),
  };
  const facade = fakeFacade(["process.managed.list", "process.status"], async (env) => {
    const offset = env.arguments.offset;
    if (offset === 0) return nativeResponse(env, {
      data: { handles: [{ handle_id: "unrelated", pid: 999, status: "running" }],
        has_more: true, next_offset: 1 },
    });
    return nativeResponse(env, {
      data: { handles: [{ handle_id: "handle-101", pid: 101, status: "running", running: true }],
        has_more: false },
    });
  });
  const surface = new DesktopCommanderCompatibilitySurface({ facade, store });
  const result = await surface.invoke(request("list_sessions", {}, "sessions-paged"));
  assert.equal(result.status, "completed");
  assert.equal(result.data.count, 1);
  assert.equal(result.data.native_pages_read, 2);
  assert.equal(result.data.native_listing_complete, true);
  assert.equal(result.data.truncated, false);
  assert.equal(result.data.sessions[0].running, true);
  assert.deepEqual(facade.calls.map((row) => row.request_id),
    ["sessions-paged", "sessions-paged:page:1"]);
  assert.deepEqual(facade.calls.map((row) => row.arguments.offset), [0, 1]);
});

test("bounded incomplete native process list never marks an unseen live process finished", async () => {
  const state = {
    version: 1,
    processes: [{
      sessionId: "session-r16", pid: 101, handle: "handle-101",
      kind: "session", status: "running", running: true, returncode: null,
      lastCursor: null, startedAtMs: 1, updatedAtMs: 1,
    }],
  };
  const store = {
    load: () => structuredClone(state),
    save: (next) => Object.assign(state, structuredClone(next)),
  };
  const facade = fakeFacade(["process.managed.list", "process.status"], async (env) => {
    const offset = env.arguments.offset;
    return nativeResponse(env, {
      data: { handles: [{ handle_id: "unrelated-" + offset, pid: 1000 + offset }],
        has_more: true, next_offset: offset + 1 },
    });
  });
  const surface = new DesktopCommanderCompatibilitySurface({ facade, store });
  const result = await surface.invoke(request("list_sessions", {}, "sessions-bounded"));
  assert.equal(result.status, "completed");
  assert.equal(result.data.native_pages_read, 10);
  assert.equal(result.data.native_listing_complete, false);
  assert.equal(result.data.truncated, true);
  assert.equal(result.data.sessions[0].status, "running");
  assert.equal(result.data.sessions[0].running, true);
  assert.equal(facade.calls.length, 10);
  assert.equal(facade.calls.at(-1).request_id, "sessions-bounded:page:9");
});

test("non-progressing native managed-process page is rejected instead of fabricating lifecycle status", async () => {
  const facade = fakeFacade(["process.managed.list", "process.status"], async (env) =>
    nativeResponse(env, {
      data: { handles: [{ handle_id: "one", pid: 900 }], has_more: true, next_offset: 0 },
    }));
  const surface = new DesktopCommanderCompatibilitySurface({ facade });
  const result = await surface.invoke(request("list_sessions", {}, "sessions-stalled"));
  assert.equal(result.status, "error");
  assert.equal(result.error.code, "NATIVE_RESULT_INVALID");
  assert.equal(facade.calls.length, 1);
});

test("forged native registry or Executor capability identity rejects public variant before any provider dispatch", async () => {
  for (const patch of [
    { registry_digest: "forged-native-registry" },
    { protocol_version: "pc.native.control.v2" },
    { executor: { ...manifest().executor, digest: "" } },
  ]) {
    const calls = [];
    const facade = {
      async capabilities() { return { ...manifest(), ...patch }; },
      async invoke(envelope) {
        calls.push(envelope);
        return nativeResponse(envelope);
      },
    };
    const surface = new DesktopCommanderCompatibilitySurface({ facade });
    const outcome = await surface.invoke(
      request("read_file", { path: "C:\\fixture\\identity-only.txt" }, "bad-identity"));
    assert.equal(outcome.status, "error");
    assert.ok(["NATIVE_REGISTRY_IDENTITY_MISMATCH", "EXECUTOR_CAPABILITY_IDENTITY_INVALID"]
      .includes(outcome.error.code));
    assert.equal(outcome.error.retryable, false);
    assert.equal(calls.length, 0);
    await assert.rejects(() => surface.registry(),
      (error) => error instanceof FullCompatibilityAuditError);
  }
});
