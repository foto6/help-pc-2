import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { nativeMcpServerFactory } from "./mcp-host.js";

export function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function bearerMatches(header, token) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice(7), "utf8");
  const expected = Buffer.from(token, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function requestHostname(request) {
  const raw = request.headers.get("host");
  if (!raw) return null;
  try { return new URL(`http://${raw}`).hostname.replace(/^\[|\]$/g, ""); }
  catch { return null; }
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

export async function startNativeMcpHttpServer({
  runtime,
  token,
  host = "127.0.0.1",
  port = 0,
  maxRequestBodySize = 1024 * 1024,
} = {}) {
  if (!runtime) throw new TypeError("runtime is required");
  if (typeof token !== "string" || token.length < 24) {
    throw new TypeError("token must be at least 24 characters");
  }
  if (!isLoopbackHost(host)) {
    throw new TypeError("MCP HTTP host is loopback-only; remote bind requires a future tested remote-auth mode");
  }

  const mcpHandler = createMcpHandler(nativeMcpServerFactory(runtime), {
    legacy: "stateless",
    responseMode: "auto",
    maxRequestBodySize,
  });

  const fetchHandler = {
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname !== "/mcp") {
        return jsonResponse(404, { error: "not_found" });
      }

      const hostname = requestHostname(request);
      if (!hostname || !isLoopbackHost(hostname)) {
        return jsonResponse(421, { error: "invalid_host" });
      }

      const authHeader = request.headers.get("authorization");
      if (!bearerMatches(authHeader, token)) {
        return jsonResponse(
          401,
          { error: "unauthorized" },
          { "www-authenticate": 'Bearer realm="pc-native-mcp"' },
        );
      }

      return mcpHandler.fetch(request, {
        authInfo: {
          token,
          clientId: "pc-native-mcp-local",
          scopes: ["mcp"],
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        },
      });
    },
  };

  const nodeHandler = toNodeHandler(fetchHandler, { maxRequestBodySize });
  const server = createServer((req, res) => {
    nodeHandler(req, res).catch((error) => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "internal_error" }));
      } else {
        res.destroy(error);
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to determine MCP HTTP bind address");
  const displayHost = address.address.includes(":") ? `[${address.address}]` : address.address;

  return {
    host: address.address,
    port: address.port,
    url: `http://${displayHost}:${address.port}/mcp`,
    close: async () => {
      await mcpHandler.close();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

export const __test = Object.freeze({ bearerMatches, requestHostname });
