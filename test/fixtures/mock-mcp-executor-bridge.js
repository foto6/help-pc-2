import { TOOL_REGISTRY_LIST } from "../../src/native-registry.js";

const actions = [...new Set(TOOL_REGISTRY_LIST.map((tool) => tool.executorAction))];

export async function createExecutorBridge() {
  return {
    desktopId: "stdio-test-desktop",
    dryRun: false,
    readCapabilities: async () => ({
      contract_version: "pc_executor.capabilities.v1",
      digest: "stdio-executor-cap-v1",
      actions,
    }),
    invoke: async (request) => ({
      request_id: request.request_id,
      action: request.action,
      ok: true,
      status: "completed",
      started_at: "2026-09-28T00:00:00.000Z",
      finished_at: "2026-09-28T00:00:00.001Z",
      data: { action: request.action, stdio: true },
      error: null,
      error_kind: null,
      dry_run: request.dry_run,
    }),
  };
}
