import test from "node:test";
import assert from "node:assert/strict";
import {
  DC_COMPATIBILITY_REGISTRY_LIST,
  DesktopCommanderCompatibilitySurface,
  desktopCommanderToolDefinition,
} from "../src/index.js";

function fakeFacade({ listed = [{ pid: 42117, ppid: 312, name: "python.exe" }] } = {}) {
  const calls = [];
  return {
    calls,
    async capabilities() {
      return {
        contract_version: "pc.native.tool_registry.v1",
        protocol_version: "pc.native.control.v1",
        registry_digest: "frozen-native-registry",
        executor: {
          contract_version: "pc_executor.capabilities.v1",
          digest: "exact-test-producer-digest",
          actions: ["process.list", "system.process.kill", "process.managed.list"],
        },
      };
    },
    async invoke(envelope) {
      calls.push(structuredClone(envelope));
      if (envelope.tool === "system.process.list") {
        return {
          contract_version: "pc.native.response.v1",
          status: "completed",
          data: { processes: structuredClone(listed) },
          error: null,
          stream: { bounded: true, limit: 1, next_cursor: null },
        };
      }
      if (envelope.tool === "system.process.kill") {
        assert.deepEqual(envelope.arguments, {
          pid: 42117,
          expected_name: "python.exe",
        });
        return {
          contract_version: "pc.native.response.v1",
          status: "completed",
          data: { terminated: true, pid: 42117 },
          error: null, stream: null,
        };
      }
      throw new Error("Unexpected or dangerous native route " + envelope.tool);
    },
  };
}

const request = {
  request_id: "r21-os-kill-unique",
  session_id: "private-test-session",
  tool: "kill_process",
  arguments: { pid: 42117 },
};

test("R21 OS-kill registry uses system.process.list, not managed process.list", () => {
  const tool = desktopCommanderToolDefinition("kill_process");
  assert.equal(tool.capability_variants[0].id, "pc_core_safe_identity");
  assert.deepEqual(tool.capability_variants[0].executor_actions,
    ["process.list", "system.process.kill"]);
  assert.deepEqual(tool.capability_variants[0].native_tools,
    ["system.process.list", "system.process.kill"]);
  assert.equal(DC_COMPATIBILITY_REGISTRY_LIST.length, 28);
});

test("R21 actual frozen Python wire names: OS process listing precedes exact-PID kill", async () => {
  const facade = fakeFacade();
  const surface = new DesktopCommanderCompatibilitySurface({ facade });
  const result = await surface.invoke(request);
  assert.equal(result.status, "completed");
  assert.equal(result.data.pid, 42117);
  assert.equal(result.data.terminated, true);
  assert.deepEqual(facade.calls.map(c => c.tool),
    ["system.process.list", "system.process.kill"]);
  assert.deepEqual(facade.calls[0].arguments, { pid: 42117 });
  assert.deepEqual(facade.calls[0].page, { limit: 1 });
  assert.deepEqual(facade.calls[1].arguments,
    { pid: 42117, expected_name: "python.exe" });
  assert.equal(facade.calls[0].request_id, "r21-os-kill-unique:lookup");
  assert.equal(facade.calls[1].request_id, "r21-os-kill-unique:kill");
});

test("R21 fail closed: wrong returned OS PID never authorizes an arbitrary first-result kill", async () => {
  const facade = fakeFacade({
    listed: [{ pid: 42118, ppid: 312, name: "python.exe" }],
  });
  const result = await new DesktopCommanderCompatibilitySurface({ facade }).invoke(request);
  assert.equal(result.status, "error");
  assert.equal(result.error.code, "PROCESS_NOT_FOUND");
  assert.deepEqual(facade.calls.map(c => c.tool), ["system.process.list"]);
});

test("R21 fail closed: empty process-list and missing executable identity never call kill", async () => {
  for (const listed of [[], [{ pid: 42117, ppid: 312, name: "" }]]) {
    const facade = fakeFacade({ listed });
    const result = await new DesktopCommanderCompatibilitySurface({ facade }).invoke(request);
    assert.equal(result.status, "error");
    assert.equal(result.error.code, "PROCESS_NOT_FOUND");
    assert.deepEqual(facade.calls.map(c => c.tool), ["system.process.list"]);
  }
});
