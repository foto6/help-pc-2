import test from "node:test";
import assert from "node:assert/strict";
import { DesktopCommanderCompatibilitySurface } from "../src/index.js";

// Model the real producer's rejection boundary, not the translation formula.
// Existing R21 tests separately enforce exact OS PID lookup and no fallback kill.
for (const kind of ["session", "process"]) {
  test(`R22 ${kind}: default/max line reads fit the Python 64KiB contract`, async () => {
    const session = kind === "session";
    const reads = [];
    const facade = {
      async capabilities() {
        return {
          contract_version: "pc.native.tool_registry.v1",
          protocol_version: "pc.native.control.v1",
          registry_digest: "r22-registry",
          executor: {
            contract_version: "pc_executor.capabilities.v1", digest: "r22-executor",
            actions: session
              ? ["shell.session.start", "shell.session.read", "shell.session.write_stdin", "shell.session.terminate", "process.status"]
              : ["process.start", "process.read_output", "process.terminate", "process.status"],
          },
        };
      },
      async invoke(request) {
        let data;
        if (["shell.session.start", "process.start"].includes(request.tool)) {
          data = { handle_id: "owned-r22", session_id: "owned-r22", pid: 32001, kind };
        } else if (["shell.session.read", "process.read_output"].includes(request.tool)) {
          reads.push(request.arguments);
          assert.ok(request.arguments.max_bytes > 0 && request.arguments.max_bytes <= 65536,
            "real Executor would reject this output request before dispatch");
          data = { stdout: "actual output\n", stderr: "", running: true,
            cursor: { version: "cursor-v1", handle_id: "owned-r22", stdout_offset: reads.length * 14, stderr_offset: 0 } };
        } else throw new Error(`Unexpected route ${request.tool}`);
        return { contract_version: "pc.native.response.v1", status: "completed", data, error: null, stream: null };
      },
    };
    const surface = new DesktopCommanderCompatibilitySurface({ facade });
    const invoke = (tool, args, id) => surface.invoke({
      request_id: id, session_id: "r22-session", tool, arguments: args,
    });
    assert.equal((await invoke("start_process", { command: "python -u fixture.py" }, "start")).status, "completed");
    for (const [index, length] of [undefined, 50, 1000].entries()) {
      const response = await invoke("read_process_output", {
        pid: 32001, ...(length === undefined ? {} : { length }),
      }, `read-${index}`);
      assert.equal(response.status, "completed");
      assert.equal(response.data.output, "actual output\n");
    }
    assert.equal(reads.length, 3);
    assert.equal(reads[1].cursor.stdout_offset, 14);
    assert.equal(reads[2].cursor.stdout_offset, 28);
  });
}
