import { McpServer } from "@modelcontextprotocol/server";
import {
  NATIVE_CONTROL_PROTOCOL_V1,
  NATIVE_RESPONSE_V1,
  NATIVE_TOOL_REGISTRY_V1,
  TOOL_REGISTRY_LIST,
} from "./native-registry.js";
import {
  mcpToolDescription,
  mcpToolSchema,
  mcpCompatibilityToolDescription,
  mcpCompatibilityToolSchema,
} from "./mcp-tool-schemas.js";
import {
  DC_COMPATIBILITY_REGISTRY_V1,
  DC_COMPATIBILITY_RESPONSE_V1,
  DC_COMPATIBILITY_REGISTRY_DIGEST,
  DC_COMPATIBILITY_REGISTRY_LIST,
  desktopCommanderCompatibilityManifestV1,
} from "./dc-compatibility-registry.js";
import { DesktopCommanderCompatibilitySurface } from "./dc-compatibility.js";

export const MCP_HOST_VERSION = "1.0.0";
export const MCP_MODERN_PROTOCOL = "2026-07-28";

function negotiationClient(manifest) {
  return {
    protocol_version: manifest.protocol_version,
    registry_digest: manifest.registry_digest,
    executor_digest: manifest.executor?.digest ?? null,
  };
}

function facadeErrorResult(error) {
  return {
    contract_version: NATIVE_RESPONSE_V1,
    request_id: null,
    session_id: null,
    status: "error",
    data: null,
    error: {
      code: error?.code ?? "MCP_NATIVE_HOST_ERROR",
      category: error?.category ?? "host",
      message: String(error?.message ?? error),
      retryable: error?.retryable === true,
      details: error?.details ?? null,
    },
    stream: null,
  };
}

function compatibilityErrorResult(error, { requestId = null, sessionId = null, tool = null } = {}) {
  return {
    contract_version: DC_COMPATIBILITY_RESPONSE_V1,
    request_id: requestId,
    session_id: sessionId,
    tool,
    status: "error",
    data: null,
    error: {
      code: error?.code ?? "MCP_DC_COMPATIBILITY_HOST_ERROR",
      category: error?.category ?? "host",
      message: String(error?.message ?? error),
      retryable: error?.retryable === true,
      details: error?.details ?? null,
    },
  };
}

function safeJson(value) {
  try { return JSON.stringify(value); }
  catch { return JSON.stringify({ status: "error", error: { code: "UNSERIALIZABLE_RESULT" } }); }
}

function boundedResult(value, maxBytes) {
  const encoded = safeJson(value);
  if (Buffer.byteLength(encoded, "utf8") <= maxBytes) return value;
  return {
    contract_version: value?.contract_version ?? NATIVE_RESPONSE_V1,
    request_id: value?.request_id ?? null,
    session_id: value?.session_id ?? null,
    status: value?.status ?? "error",
    data: {
      truncated: true,
      reason: "MCP_RESULT_BOUND",
      message: "Result exceeded the MCP host response bound; use pagination/range controls.",
    },
    error: value?.error ?? null,
    stream: value?.stream ?? null,
  };
}

function requestIdentity(toolName, args, ctx) {
  if (typeof args.request_id === "string" && args.request_id) return args.request_id;
  return `mcp:${toolName}:${String(ctx.mcpReq.id)}`;
}

function splitHostArguments(args) {
  const { request_id: _requestId, page, ...nativeArgs } = args;
  return { nativeArgs, page };
}

export class NativeMcpRuntime {
  constructor({
    facade,
    desktopId,
    facadeSession = null,
    initialManifest,
    compatibilitySurface = null,
    serverName = "pc-native-mcp",
    serverVersion = MCP_HOST_VERSION,
    maxToolResultBytes = 256 * 1024,
  }) {
    this.facade = facade;
    this.desktopId = desktopId;
    this.facadeSession = facadeSession;
    this.initialManifest = initialManifest;
    this.compatibilitySurface = compatibilitySurface;
    this.serverName = serverName;
    this.serverVersion = serverVersion;
    this.maxToolResultBytes = maxToolResultBytes;
  }

  static async create({
    facade,
    desktopId = "desktop-A",
    serverName = "pc-native-mcp",
    serverVersion = MCP_HOST_VERSION,
    maxToolResultBytes = 256 * 1024,
    compatibilitySurface = null,
  }) {
    if (!facade) throw new TypeError("facade is required");
    const manifest = await facade.capabilities();
    const snapshot = typeof facade.debugSnapshot === "function" ? facade.debugSnapshot() : null;
    const reusable = snapshot?.sessions
      ?.filter((session) => session.status === "active" && session.desktopId === desktopId)
      ?.sort((a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0))
      ?.at(-1) ?? null;
    const facadeSession = reusable ? {
      session_id: reusable.id,
      resume_token: reusable.resumeToken,
      capability_manifest: manifest,
    } : null;
    const compatibility = compatibilitySurface ?? new DesktopCommanderCompatibilitySurface({ facade });
    return new NativeMcpRuntime({
      facade,
      desktopId,
      facadeSession,
      initialManifest: manifest,
      compatibilitySurface: compatibility,
      serverName,
      serverVersion,
      maxToolResultBytes,
    });
  }

  async ensureCapabilities() {
    const manifest = await this.facade.capabilities();
    const expected = this.initialManifest;
    if (!expected ||
        manifest.protocol_version !== expected.protocol_version ||
        manifest.registry_digest !== expected.registry_digest ||
        (manifest.executor?.digest ?? null) !== (expected.executor?.digest ?? null)) {
      const error = new Error("Native facade capability/schema drift detected.");
      error.code = "CAPABILITY_DRIFT";
      error.category = "capability_mismatch";
      error.retryable = false;
      error.details = {
        expected: {
          protocol_version: expected?.protocol_version ?? null,
          registry_digest: expected?.registry_digest ?? null,
          executor_digest: expected?.executor?.digest ?? null,
        },
        actual: {
          protocol_version: manifest.protocol_version,
          registry_digest: manifest.registry_digest,
          executor_digest: manifest.executor?.digest ?? null,
        },
      };
      throw error;
    }
    return manifest;
  }

  async ensureFacadeSession() {
    const manifest = await this.ensureCapabilities();
    if (!this.facadeSession) {
      this.facadeSession = await this.facade.openSession({
        desktopId: this.desktopId,
        client: negotiationClient(manifest),
      });
    } else {
      await this.facade.reconnectSession({
        sessionId: this.facadeSession.session_id,
        resumeToken: this.facadeSession.resume_token,
        client: negotiationClient(manifest),
      });
    }
    return manifest;
  }

  async callNativeTool(tool, args, ctx) {
    const requestId = requestIdentity(tool.name, args, ctx);
    const { nativeArgs, page } = splitHostArguments(args);
    let response;
    try {
      await this.ensureFacadeSession();
      const request = {
        contract_version: NATIVE_CONTROL_PROTOCOL_V1,
        session_id: this.facadeSession.session_id,
        request_id: requestId,
        tool: tool.name,
        arguments: nativeArgs,
        ...(page === undefined ? {} : { page }),
      };
      response = await this.facade.invoke(request, { signal: ctx.mcpReq.signal });
    } catch (error) {
      response = facadeErrorResult(error);
      response.request_id = requestId;
      response.session_id = this.facadeSession?.session_id ?? null;
    }

    const bounded = boundedResult(response, this.maxToolResultBytes);
    return {
      content: [{ type: "text", text: safeJson(bounded) }],
      structuredContent: bounded,
      isError: bounded.status === "error",
    };
  }

  async callCompatibilityTool(tool, args, ctx) {
    const requestId = requestIdentity(tool.name, args, ctx);
    const { request_id: _requestId, ...compatibilityArguments } = args;
    let response;
    try {
      await this.ensureFacadeSession();
      response = await this.compatibilitySurface.invoke({
        session_id: this.facadeSession.session_id,
        request_id: requestId,
        tool: tool.name,
        arguments: compatibilityArguments,
      }, { signal: ctx.mcpReq.signal });
    } catch (error) {
      response = compatibilityErrorResult(error, {
        requestId,
        sessionId: this.facadeSession?.session_id ?? null,
        tool: tool.name,
      });
    }

    const bounded = boundedResult(response, this.maxToolResultBytes);
    return {
      content: [{ type: "text", text: safeJson(bounded) }],
      structuredContent: bounded,
      isError: bounded.status === "error",
    };
  }

  async createServer(ctx = {}) {
    const manifest = await this.ensureCapabilities();
    const compatibilityManifest = desktopCommanderCompatibilityManifestV1({ nativeManifest: manifest });
    const server = new McpServer(
      { name: this.serverName, version: this.serverVersion },
      { capabilities: { tools: {} } },
    );

    for (const tool of TOOL_REGISTRY_LIST) {
      server.registerTool(
        tool.name,
        {
          description: mcpToolDescription(tool.name),
          inputSchema: mcpToolSchema(tool.name),
          annotations: {
            readOnlyHint: tool.effect === "read_only",
            destructiveHint: tool.destructive === true,
            idempotentHint: tool.effect === "read_only",
            openWorldHint: false,
          },
          _meta: {
            "pc.native/protocol_version": manifest.protocol_version,
            "pc.native/registry_contract": NATIVE_TOOL_REGISTRY_V1,
            "pc.native/registry_digest": manifest.registry_digest,
            "pc.native/executor_digest": manifest.executor?.digest ?? null,
            "pc.native/effect": tool.effect,
            "pc.native/streaming": tool.streaming,
            "pc.native/mcp_era": ctx.era ?? null,
          },
        },
        async (args, callCtx) => this.callNativeTool(tool, args, callCtx),
      );
    }

    const nativeNames = new Set(TOOL_REGISTRY_LIST.map((tool) => tool.name));
    for (const tool of DC_COMPATIBILITY_REGISTRY_LIST) {
      if (nativeNames.has(tool.name)) {
        throw new Error("Native and Desktop Commander compatibility tool names collide: " + tool.name);
      }
      const advertised = compatibilityManifest.tools.find((entry) => entry.name === tool.name);
      server.registerTool(
        tool.name,
        {
          description: mcpCompatibilityToolDescription(tool.name),
          inputSchema: mcpCompatibilityToolSchema(tool.name),
          annotations: {
            readOnlyHint: tool.effect === "read_only",
            destructiveHint: false,
            idempotentHint: tool.effect === "read_only",
            openWorldHint: false,
          },
          _meta: {
            "pc.desktop_commander/compat_registry_contract": DC_COMPATIBILITY_REGISTRY_V1,
            "pc.desktop_commander/compat_registry_digest": DC_COMPATIBILITY_REGISTRY_DIGEST,
            "pc.desktop_commander/native_protocol_version": manifest.protocol_version,
            "pc.desktop_commander/native_registry_digest": manifest.registry_digest,
            "pc.desktop_commander/executor_digest": manifest.executor?.digest ?? null,
            "pc.desktop_commander/effect": tool.effect,
            "pc.desktop_commander/available": advertised?.available === true,
            "pc.desktop_commander/capability_variants": advertised?.capability_variants ?? [],
            "pc.desktop_commander/mcp_era": ctx.era ?? null,
          },
        },
        async (args, callCtx) => this.callCompatibilityTool(tool, args, callCtx),
      );
    }

    return server;
  }

  async close() {
    if (!this.facadeSession) return;
    try {
      this.facade.closeSession(this.facadeSession.session_id);
    } catch {}
  }
}

export function nativeMcpServerFactory(runtime) {
  if (!(runtime instanceof NativeMcpRuntime)) throw new TypeError("NativeMcpRuntime is required");
  return (ctx) => runtime.createServer(ctx);
}

export const __test = Object.freeze({
  negotiationClient,
  requestIdentity,
  splitHostArguments,
  boundedResult,
  compatibilityErrorResult,
});
