import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { createRpcHandler, mcpToolDefinitions } from "./api.js";
import { TERMINAL_ACTION_STATUSES } from "./schemas.js";

const TERMINAL = TERMINAL_ACTION_STATUSES;

function toolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value && typeof value === "object" ? value : { value },
    isError: false,
  };
}

function toolError(error) {
  const value = {
    ok: false,
    error: {
      name: error?.name ?? "Error",
      code: error?.code ?? "TOOL_ERROR",
      message: String(error?.message ?? error),
      category: error?.category ?? null,
    },
  };
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    isError: true,
  };
}

function normalizeArgs(args) {
  if (args === undefined || args === null) return {};
  if (typeof args !== "object" || Array.isArray(args)) throw new TypeError("Tool arguments must be an object.");
  return args;
}

export const CONVENIENCE_TOOLS = Object.freeze([
  {
    name: "pc_health",
    description: "Read-only health/status for the PC Control gateway and local Executor process.",
    inputSchema: { type: "object", additionalProperties: false },
  },
  {
    name: "pc_shell_run",
    description: "Run one allowlisted argv-based shell action through PC Control -> preflight -> PC Executor. Never accepts a raw shell string.",
    inputSchema: {
      type: "object",
      required: ["argv"],
      additionalProperties: false,
      properties: {
        argv: { type: "array", minItems: 1, maxItems: 64, items: { type: "string" } },
        cwd: { type: ["string", "null"] },
        timeoutMs: { type: "integer", minimum: 1, maximum: 300000, default: 60000 },
        idempotencyKey: { type: ["string", "null"] },
        desktopId: { type: ["string", "null"] },
      },
    },
  },
]);

export class PcControlMcpGateway {
  constructor(runtime, { workerId = "pc-control-mcp", maxProcessSteps = 12 } = {}) {
    if (!runtime?.controlPlane) throw new TypeError("runtime.controlPlane is required.");
    this.runtime = runtime;
    this.controlPlane = runtime.controlPlane;
    this.rpc = createRpcHandler(this.controlPlane);
    this.workerId = workerId;
    this.maxProcessSteps = maxProcessSteps;
    this.rpcTools = mcpToolDefinitions();
    this.rpcByTool = new Map(this.rpcTools.map((tool) => [tool.name, tool.rpcMethod]));
  }

  listTools() {
    return [...CONVENIENCE_TOOLS, ...this.rpcTools.map(({ rpcMethod: _rpcMethod, ...tool }) => tool)];
  }

  async callTool(name, args = {}) {
    const input = normalizeArgs(args);
    try {
      if (name === "pc_health") return toolResult(this.health());
      if (name === "pc_shell_run") return toolResult(await this.#shellRun(input));
      const method = this.rpcByTool.get(name);
      if (!method) {
        const error = new Error(`Unknown tool '${name}'.`);
        error.code = "METHOD_NOT_FOUND";
        throw error;
      }
      return toolResult(await this.rpc(method, input));
    } catch (error) {
      return toolError(error);
    }
  }

  health() {
    const actions = this.controlPlane.listActions();
    const active = actions.filter((action) => !TERMINAL.has(action.status));
    return {
      ok: true,
      contract: "pc_control.gateway.health.v1",
      live: this.runtime.live === true,
      desktopId: this.runtime.desktopId ?? null,
      dataDir: this.runtime.dataDir ?? null,
      executor: this.runtime.executorClient?.status?.() ?? null,
      sessions: this.controlPlane.listSessions().length,
      actions: {
        total: actions.length,
        active: active.length,
        activeIds: active.map((action) => action.id),
      },
      metrics: this.controlPlane.getMetrics(),
    };
  }

  #ensureGatewaySession(desktopId) {
    const wanted = desktopId || this.runtime.desktopId || "local-desktop";
    const existing = this.controlPlane.listSessions().find(
      (session) => session.status === "active" && session.desktopId === wanted && session.principal === "pc-control-mcp",
    );
    if (existing) return existing;
    return this.controlPlane.createSession({
      desktopId: wanted,
      principal: "pc-control-mcp",
      permissions: ["desktop.observe", "desktop.control"],
      claimDesktop: false,
    });
  }

  async #shellRun({ argv, cwd = null, timeoutMs = 60000, idempotencyKey = null, desktopId = null }) {
    if (!Array.isArray(argv) || argv.length < 1 || argv.some((part) => typeof part !== "string")) {
      const error = new Error("argv must be a non-empty string array.");
      error.code = "INVALID_ARGUMENT";
      throw error;
    }

    const nonTerminal = this.controlPlane.listActions().filter((action) => !TERMINAL.has(action.status));
    if (nonTerminal.length) {
      const error = new Error("Gateway has unfinished durable actions; reconcile/cancel them before starting a new convenience shell action.");
      error.code = "GATEWAY_BUSY";
      error.details = nonTerminal.map((action) => ({ id: action.id, status: action.status, type: action.type }));
      throw error;
    }

    const session = this.#ensureGatewaySession(desktopId);
    const key = idempotencyKey || `mcp-shell-${randomUUID()}`;
    let action = this.controlPlane.enqueueAction(session.id, {
      provider: "help-pc-1",
      type: "shell.run",
      input: { argv: [...argv], cwd },
      permission: "desktop.control",
      requiresDesktop: false,
      destructive: false,
      confirmation: "none",
      idempotencyKey: key,
      maxAttempts: 1,
      maxPreflightAttempts: 3,
      maxVerificationAttempts: 1,
      maxReconciliationAttempts: 3,
      preflightTimeoutMs: timeoutMs,
      metadata: { source: "pc-control-mcp", convenienceTool: "pc_shell_run" },
    });

    let steps = 0;
    while (!TERMINAL.has(action.status) && steps < this.maxProcessSteps) {
      const processed = await this.controlPlane.processNext({ workerId: this.workerId });
      steps += 1;
      action = this.controlPlane.getAction(action.id);
      if (!processed) break;
      if (["retry_wait", "preflight_wait", "reconciliation_wait", "uncertain_outcome"].includes(action.status)) break;
    }

    return {
      contract: "pc_control.gateway.shell_result.v1",
      actionId: action.id,
      correlationId: action.correlationId,
      status: action.status,
      terminal: TERMINAL.has(action.status),
      preflightStatus: action.preflightStatus ?? null,
      executionAttempts: action.executionAttempts ?? 0,
      preflightAttempts: action.preflightAttempts ?? 0,
      reconciliationAttempts: action.reconciliationAttempts ?? 0,
      executionResult: action.executionResult ?? null,
      executorEvidence: action.executorEvidence ?? null,
      error: action.error ?? null,
      uncertainty: action.uncertainty ?? null,
      steps,
    };
  }
}

export function createMcpJsonRpcHandler(gateway) {
  return async function handle(message) {
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return {
        jsonrpc: "2.0",
        id: message?.id ?? null,
        error: { code: -32600, message: "Invalid JSON-RPC request." },
      };
    }

    const id = message.id;
    try {
      let result;
      switch (message.method) {
        case "initialize":
          result = {
            protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "pc-control-mcp-gateway", version: "0.1.0" },
          };
          break;
        case "ping":
          result = {};
          break;
        case "tools/list":
          result = { tools: gateway.listTools() };
          break;
        case "tools/call":
          result = await gateway.callTool(message.params?.name, message.params?.arguments ?? {});
          break;
        case "notifications/initialized":
          return null;
        default:
          return {
            jsonrpc: "2.0",
            id: id ?? null,
            error: { code: -32601, message: `Method not found: ${message.method}` },
          };
      }
      if (id === undefined || id === null) return null;
      return { jsonrpc: "2.0", id, result };
    } catch (error) {
      if (id === undefined || id === null) return null;
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32603,
          message: String(error?.message ?? error),
          data: { code: error?.code ?? "INTERNAL_ERROR" },
        },
      };
    }
  };
}

export async function serveMcpStdio(gateway, { input = process.stdin, output = process.stdout } = {}) {
  const handle = createMcpJsonRpcHandler(gateway);
  const reader = createInterface({ input, crlfDelay: Infinity });
  for await (const line of reader) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      output.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } })}\n`);
      continue;
    }
    const response = await handle(message);
    if (response) output.write(`${JSON.stringify(response)}\n`);
  }
}
