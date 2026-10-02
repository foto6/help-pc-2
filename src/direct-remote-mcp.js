import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { nativeMcpServerFactory } from "./mcp-host.js";

export const DIRECT_REMOTE_MCP_V1 = "pc.native.direct_remote_mcp.v1";
export const DIRECT_REMOTE_HEALTH_V1 = "pc.native.direct_remote_mcp.health.v1";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export class DirectRemoteMcpError extends Error {
  constructor(message, { code = "DIRECT_REMOTE_MCP_ERROR", httpStatus = 400 } = {}) {
    super(message);
    this.name = "DirectRemoteMcpError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left), "utf8");
  const b = Buffer.from(String(right), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function normalizeToken(value, name) {
  if (typeof value !== "string" || value.length < 32) {
    throw new TypeError(`${name} must contain at least 32 characters`);
  }
  return value;
}

export function assertCredentialSeparation(clientToken, deviceAuthorityToken) {
  const client = normalizeToken(clientToken, "clientToken");
  if (deviceAuthorityToken !== undefined && deviceAuthorityToken !== null) {
    const device = normalizeToken(deviceAuthorityToken, "deviceAuthorityToken");
    if (safeEqual(client, device)) {
      throw new DirectRemoteMcpError(
        "MCP client credential authority must be separate from relay/device credential authority.",
        { code: "CREDENTIAL_AUTHORITY_COLLISION" },
      );
    }
  }
  return true;
}

function normalizeHost(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError("bindHost must be a non-empty string");
  }
  return value.trim().replace(/^[|]$/g, "");
}

function normalizeOrigin(value, { allowInsecureHttp = false } = {}) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError("publicOrigin is required");
  }
  let url;
  try { url = new URL(value); } catch { throw new TypeError("publicOrigin must be an absolute URL"); }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError("publicOrigin must not contain credentials, query, or fragment");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new TypeError("publicOrigin must be an origin without a path");
  }
  if (url.protocol !== "https:" && !(allowInsecureHttp && url.protocol === "http:")) {
    throw new TypeError("publicOrigin must use https outside isolated test mode");
  }
  url.pathname = "/";
  return url;
}

function hostHeader(request) {
  const value = request.headers.get("host");
  if (!value || /[s/]/.test(value)) return null;
  return value.toLowerCase();
}

function bearerMatches(request, token) {
  const header = request.headers.get("authorization");
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  return safeEqual(header.slice(7), token);
}

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function boundedInt(value, name, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

async function boundedRuntimeProbe(runtime, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(Object.assign(new Error("direct_remote_health_timeout"), {
      code: "DIRECT_REMOTE_HEALTH_TIMEOUT",
    })),
    timeoutMs,
  );
  try {
    const capabilityPromise = runtime.ensureCapabilities({ signal: controller.signal });
    const healthPromise = typeof runtime.healthSnapshot === "function"
      ? runtime.healthSnapshot({ refresh: true, canary: false, signal: controller.signal })
      : Promise.resolve(null);
    const timeout = new Promise((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
    });
    const [manifest, health] = await Promise.race([
      Promise.all([capabilityPromise, healthPromise]),
      timeout,
    ]);
    const nativeStatus = health?.status ?? "UNAVAILABLE";
    const status = nativeStatus === "HEALTHY"
      ? "HEALTHY"
      : nativeStatus === "UNHEALTHY"
        ? "BLOCKED"
        : "DEGRADED";
    return {
      status,
      reason: health ? `native_health_${String(nativeStatus).toLowerCase()}` : "native_health_unavailable",
      protocol_version: manifest?.protocol_version ?? null,
      registry_digest: manifest?.registry_digest ?? null,
      executor_digest: manifest?.executor?.digest ?? null,
      native_health_status: nativeStatus,
      transport_connected: health?.transport_connected ?? null,
      queue_progressing: health?.queue_progressing ?? null,
      executor_responsive: health?.executor_responsive ?? null,
    };
  } catch (error) {
    return {
      status: error?.code === "DIRECT_REMOTE_HEALTH_TIMEOUT" ? "DEGRADED" : "BLOCKED",
      reason: error?.code ?? "DIRECT_REMOTE_HEALTH_FAILED",
      protocol_version: null,
      registry_digest: null,
      executor_digest: null,
      native_health_status: "UNAVAILABLE",
      transport_connected: false,
      queue_progressing: null,
      executor_responsive: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

function authorizeBind(bindHost, authorizedRemoteBindHosts) {
  if (LOOPBACK.has(bindHost)) return;
  if (!Array.isArray(authorizedRemoteBindHosts)
      || !authorizedRemoteBindHosts.map(normalizeHost).includes(bindHost)) {
    throw new DirectRemoteMcpError(
      "Non-loopback direct MCP bind is not explicitly authorized.",
      { code: "REMOTE_BIND_NOT_AUTHORIZED" },
    );
  }
}

export async function startDirectRemoteMcpServer({
  runtime,
  clientToken,
  deviceAuthorityToken = null,
  bindHost = "127.0.0.1",
  port = 0,
  publicOrigin,
  authorizedRemoteBindHosts = [],
  allowedOrigins = null,
  maxRequestBodySize = 1024 * 1024,
  requestTimeoutMs = 30_000,
  discoveryTimeoutMs = 5_000,
  allowInsecureHttpForTests = false,
  autoTestOrigin = false,
} = {}) {
  if (!runtime) throw new TypeError("runtime is required");
  const token = normalizeToken(clientToken, "clientToken");
  assertCredentialSeparation(token, deviceAuthorityToken);
  const host = normalizeHost(bindHost);
  authorizeBind(host, authorizedRemoteBindHosts);
  boundedInt(port, "port", 0, 65535);
  boundedInt(maxRequestBodySize, "maxRequestBodySize", 1024, 8 * 1024 * 1024);
  boundedInt(requestTimeoutMs, "requestTimeoutMs", 250, 120_000);
  boundedInt(discoveryTimeoutMs, "discoveryTimeoutMs", 100, 30_000);

  let origin = null;
  if (!autoTestOrigin) {
    origin = normalizeOrigin(publicOrigin, { allowInsecureHttp: allowInsecureHttpForTests });
  } else if (!allowInsecureHttpForTests) {
    throw new DirectRemoteMcpError("autoTestOrigin is restricted to isolated insecure test mode.", {
      code: "TEST_ORIGIN_MODE_FORBIDDEN",
    });
  }

  const mcpHandler = createMcpHandler(nativeMcpServerFactory(runtime), {
    legacy: "stateless",
    responseMode: "auto",
    maxRequestBodySize,
  });

  const stats = {
    startedAtMs: Date.now(),
    requestsTotal: 0,
    authFailures: 0,
    hostFailures: 0,
    originFailures: 0,
    requestTimeouts: 0,
    lastSuccessfulRequestAtMs: null,
  };

  let expectedHost = origin?.host?.toLowerCase() ?? null;
  let allowedOriginSet = origin
    ? new Set((allowedOrigins ?? [origin.origin]).map((value) =>
        normalizeOrigin(value, { allowInsecureHttp: allowInsecureHttpForTests }).origin))
    : new Set();

  const fetchHandler = {
    fetch: async (request) => {
      stats.requestsTotal += 1;
      const url = new URL(request.url);
      if (!["/mcp", "/healthz"].includes(url.pathname)) {
        return jsonResponse(404, { error: "not_found" });
      }

      const hostValue = hostHeader(request);
      if (!hostValue || hostValue !== expectedHost) {
        stats.hostFailures += 1;
        return jsonResponse(421, { error: "invalid_host" });
      }
      const requestOrigin = request.headers.get("origin");
      if (requestOrigin !== null && !allowedOriginSet.has(requestOrigin)) {
        stats.originFailures += 1;
        return jsonResponse(403, { error: "invalid_origin" });
      }
      if (!bearerMatches(request, token)) {
        stats.authFailures += 1;
        return jsonResponse(
          401,
          { error: "unauthorized" },
          { "www-authenticate": 'Bearer realm="pc-native-direct-remote-mcp"' },
        );
      }

      if (url.pathname === "/healthz") {
        const probe = await boundedRuntimeProbe(runtime, discoveryTimeoutMs);
        return jsonResponse(probe.status === "BLOCKED" ? 503 : 200, {
          contract_version: DIRECT_REMOTE_HEALTH_V1,
          status: probe.status,
          reason: probe.reason,
          source_ready: true,
          actual_remote_chatgpt_tool_exposed: false,
          client_credential_authority: "direct_remote_mcp",
          device_credential_authority: "native_remote_relay",
          protocol_version: probe.protocol_version,
          registry_digest: probe.registry_digest,
          executor_digest: probe.executor_digest,
          native_health_status: probe.native_health_status,
          transport_connected: probe.transport_connected,
          queue_progressing: probe.queue_progressing,
          executor_responsive: probe.executor_responsive,
          request_timeout_ms: requestTimeoutMs,
          discovery_timeout_ms: discoveryTimeoutMs,
          requests_total: stats.requestsTotal,
          request_timeouts: stats.requestTimeouts,
          last_successful_request_at_ms: stats.lastSuccessfulRequestAtMs,
        });
      }

      const controller = new AbortController();
      const timer = setTimeout(() => {
        stats.requestTimeouts += 1;
        controller.abort(Object.assign(new Error("direct_remote_request_timeout"), {
          code: "DIRECT_REMOTE_REQUEST_TIMEOUT",
        }));
      }, requestTimeoutMs);
      try {
        const boundedRequest = new Request(request, { signal: controller.signal });
        const response = await mcpHandler.fetch(boundedRequest, {
          authInfo: {
            token: "[REDACTED]",
            clientId: "pc-native-direct-remote-client",
            scopes: ["mcp"],
            expiresAt: Math.floor(Date.now() / 1000) + 300,
          },
        });
        stats.lastSuccessfulRequestAtMs = Date.now();
        return response;
      } catch (error) {
        if (controller.signal.aborted) {
          return jsonResponse(504, {
            error: "request_timeout",
            reconciliation_required: true,
            automatic_replay: false,
          });
        }
        return jsonResponse(500, { error: "internal_error" });
      } finally {
        clearTimeout(timer);
      }
    },
  };

  const nodeHandler = toNodeHandler(fetchHandler, { maxRequestBodySize });
  const server = createServer((req, res) => {
    nodeHandler(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify({ error: "internal_error" }));
      } else {
        res.destroy();
      }
    });
  });
  server.requestTimeout = requestTimeoutMs + 2_000;
  server.headersTimeout = Math.max(2_000, Math.min(requestTimeoutMs, 30_000));
  server.keepAliveTimeout = Math.max(1_000, Math.min(requestTimeoutMs, 15_000));
  server.maxHeadersCount = 64;

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await mcpHandler.close().catch(() => {});
    throw new DirectRemoteMcpError("Unable to determine direct MCP bind address.", {
      code: "DIRECT_REMOTE_BIND_FAILED",
    });
  }

  const displayHost = address.address.includes(":") ? `[${address.address}]` : address.address;
  if (autoTestOrigin) {
    origin = normalizeOrigin(`http://${displayHost}:${address.port}`, { allowInsecureHttp: true });
    expectedHost = origin.host.toLowerCase();
    allowedOriginSet = new Set([origin.origin]);
  }

  return {
    contract_version: DIRECT_REMOTE_MCP_V1,
    host: address.address,
    port: address.port,
    url: `http://${displayHost}:${address.port}/mcp`,
    health_url: `http://${displayHost}:${address.port}/healthz`,
    public_origin: origin.origin,
    diagnostics: () => ({
      contract_version: DIRECT_REMOTE_HEALTH_V1,
      source_ready: true,
      actual_remote_chatgpt_tool_exposed: false,
      requests_total: stats.requestsTotal,
      auth_failures: stats.authFailures,
      host_failures: stats.hostFailures,
      origin_failures: stats.originFailures,
      request_timeouts: stats.requestTimeouts,
      last_successful_request_at_ms: stats.lastSuccessfulRequestAtMs,
    }),
    close: async () => {
      await mcpHandler.close().catch(() => {});
      await new Promise((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

export const __test = Object.freeze({
  normalizeOrigin,
  hostHeader,
  bearerMatches,
  authorizeBind,
  boundedRuntimeProbe,
});
