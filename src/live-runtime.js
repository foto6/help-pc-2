import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { ControlPlane } from "./control-plane.js";
import { HelpPc1Adapter } from "./adapters.js";
import { JsonStateStore, JsonlAuditTimeline } from "./persistence.js";
import { ExecutorJsonlClient } from "./executor-jsonl-client.js";

function defaultDataDir() {
  const base = process.env.LOCALAPPDATA || process.env.APPDATA || join(homedir(), ".pc-control");
  return join(base, "PcControlGateway");
}

function ensureDataDir(path) {
  mkdirSync(path, { recursive: true });
  return path;
}

export function createLiveControlRuntime({
  live = process.env.PC_CONTROL_LIVE === "1",
  desktopId = process.env.PC_CONTROL_DESKTOP_ID || "local-desktop",
  dataDir = process.env.PC_CONTROL_DATA_DIR || defaultDataDir(),
  executorClient = null,
  statePath = null,
  auditPath = null,
  policy = null,
} = {}) {
  const root = ensureDataDir(dataDir);
  const client = executorClient ?? new ExecutorJsonlClient({ live });
  const requestTimeoutMs = Number(process.env.PC_EXECUTOR_REQUEST_TIMEOUT_MS || 60000);

  const executor = new HelpPc1Adapter({
    dryRun: !live,
    invoke: async (request, context) => client.request({
      request_id: request.request_id,
      action: request.action,
      params: structuredClone(request.params ?? {}),
      dry_run: request.dry_run,
      timeout_ms: requestTimeoutMs,
    }, { signal: context.signal, timeoutMs: requestTimeoutMs }),
    readEvidence: async (request, context) => client.request({
      action: "outcome.lookup",
      params: {
        request_id: request.request_id,
        action: request.action,
        execution_attempt: request.execution_attempt,
      },
      dry_run: true,
      timeout_ms: requestTimeoutMs,
    }, { signal: context.signal, timeoutMs: requestTimeoutMs }),
    readCapabilities: async (_request, context) => client.request({
      action: "capabilities.get",
      params: {},
      dry_run: true,
      timeout_ms: requestTimeoutMs,
    }, { signal: context.signal, timeoutMs: requestTimeoutMs }),
    preflight: async (request, context) => client.request({
      request_id: request.request_id,
      action: "action.preflight",
      params: structuredClone(request),
      dry_run: true,
      timeout_ms: requestTimeoutMs,
    }, { signal: context.signal, timeoutMs: requestTimeoutMs }),
  });

  const store = new JsonStateStore(statePath ?? join(root, "control-state.json"));
  const auditTimeline = new JsonlAuditTimeline(auditPath ?? join(root, "control-audit.jsonl"));
  const controlPlane = new ControlPlane({
    providers: [executor],
    verificationProviders: [],
    policy: policy ?? {
      permissions: ["desktop.observe", "desktop.control"],
      allowDestructive: false,
    },
    store,
    auditTimeline,
    recoverOnStart: true,
  });

  return {
    controlPlane,
    executorClient: client,
    executor,
    live,
    desktopId,
    dataDir: root,
    close() {
      client.stop();
    },
  };
}
