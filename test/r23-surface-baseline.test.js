import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  TOOL_REGISTRY_DIGEST,
  TOOL_REGISTRY_LIST,
  DC_COMPATIBILITY_REGISTRY_LIST,
  DC_VENDOR_NON_EQUIVALENTS,
  NativeMcpRuntime,
  mcpToolSchema,
  mcpCompatibilityToolSchema,
} from "../src/index.js";
import {
  PC_NATIVE_WIRE_ROUTES,
  PINNED_PC_FROZEN_DIGEST,
  PINNED_CONTROL_NATIVE_DIGEST,
  routeNativeExecutorTool,
} from "../src/native-relay-registry-route.js";
import { __test as facadeTest } from "../src/native-facade.js";

const baseline = JSON.parse(readFileSync(
  new URL("../conformance/R23_R22_SURFACE_BASELINE.json", import.meta.url),
  "utf8",
));

test("R23 re-encodes the exact R22 62-route surface without action/effect/alias drift", () => {
  assert.equal(baseline.baseline_sha, "47f54210128488171e34186182d6d2e382ba7552");
  assert.equal(baseline.control_registry_digest, PINNED_CONTROL_NATIVE_DIGEST);
  assert.equal(TOOL_REGISTRY_DIGEST, baseline.control_registry_digest);
  assert.equal(PINNED_PC_FROZEN_DIGEST, baseline.frozen_registry_digest);
  assert.deepEqual(baseline.route_counts, { total: 62, frozen: 37, parity: 25 });
  assert.equal(TOOL_REGISTRY_LIST.length, 62);
  assert.equal(PC_NATIVE_WIRE_ROUTES.length, 62);

  const current = TOOL_REGISTRY_LIST
    .map((tool) => {
      const route = routeNativeExecutorTool(tool.name, tool.executorAction, tool.effect);
      return {
        name: tool.name,
        executor_action: tool.executorAction,
        effect: tool.effect,
        registry: route.registryVersion,
        wire_tool: route.wireToolName,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(current, baseline.native_routes);
});

test("R23 preserves the exact R22 public 28 mandatory / 30 catalog semantics", () => {
  const current = DC_COMPATIBILITY_REGISTRY_LIST
    .map((tool) => ({ name: tool.name, effect: tool.effect }))
    .sort((a, b) => a.name.localeCompare(b.name));
  assert.equal(current.length, baseline.public_compatibility.mandatory_count);
  assert.equal(current.length + DC_VENDOR_NON_EQUIVALENTS.length,
    baseline.public_compatibility.catalog_count);
  assert.deepEqual(current, baseline.public_compatibility.tools);
  assert.deepEqual(
    DC_VENDOR_NON_EQUIVALENTS.map((entry) => entry.name).sort(),
    [...baseline.public_compatibility.vendor_non_equivalents].sort(),
  );
});

test("R22 numeric/schema bounds remain strict on R23", () => {
  const fileRead = mcpToolSchema("file.read");
  assert.equal(fileRead.safeParse({
    path: "C:\\synthetic\\file.txt",
    page: { limit: baseline.bounds.native_page_max },
  }).success, true);
  assert.equal(fileRead.safeParse({
    path: "C:\\synthetic\\file.txt",
    page: { limit: baseline.bounds.native_page_max + 1 },
  }).success, false);

  const processRead = mcpToolSchema("process.read_output");
  assert.equal(processRead.safeParse({
    handle_id: "synthetic-handle",
    max_bytes: 1_048_576,
  }).success, true);
  assert.equal(processRead.safeParse({
    handle_id: "synthetic-handle",
    max_bytes: 1_048_577,
  }).success, false);

  const shellRun = mcpToolSchema("shell.run");
  assert.equal(shellRun.safeParse({
    command: "echo synthetic",
    timeout_ms: 300_000,
  }).success, true);
  assert.equal(shellRun.safeParse({
    command: "echo synthetic",
    timeout_ms: 300_001,
  }).success, false);

  const compatRead = mcpCompatibilityToolSchema("read_file");
  assert.equal(compatRead.safeParse({
    path: "C:\\synthetic\\file.txt",
    length: 1_000,
  }).success, true);
  assert.equal(compatRead.safeParse({
    path: "C:\\synthetic\\file.txt",
    length: 1_001,
  }).success, false);

  assert.equal(mcpToolSchema("device.ping").safeParse({ unexpected: true }).success, false);
});

test("R22 MCP output bound and protected-path pre-dispatch gate remain encoded", () => {
  const runtime = new NativeMcpRuntime({
    facade: {},
    desktopId: "synthetic",
    initialManifest: {},
  });
  assert.equal(runtime.maxToolResultBytes, baseline.bounds.mcp_result_max_bytes);
  assert.equal(baseline.bounds.executor_process_output_request_max_bytes, 65_536);
  assert.equal(baseline.safety.automatic_side_effect_replay, false);
  assert.equal(baseline.safety.credential_entry_allowed, false);
  assert.equal(baseline.safety.captcha_entry_allowed, false);
  // Pure lexical policy check only; this test performs no filesystem access.
  assert.equal(facadeTest.hasProtectedPath({ path: "E:\\manhwa\\never-accessed.txt" }), true);
});
