import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { errorEnvelope, NativeFacadeError } from "./native-facade.js";

function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function authorized(header, token) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const presented = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

async function readJson(req, maxBodyBytes) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      throw new NativeFacadeError("Request body exceeds configured bound.", {
        code: "REQUEST_TOO_LARGE",
        category: "bounds",
        httpStatus: 413,
      });
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch {
    throw new NativeFacadeError("Malformed JSON body.", { code: "MALFORMED_JSON", category: "transport" });
  }
}

function sendJson(res, statusCode, body) {
  const bytes = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": bytes.length,
    "cache-control": "no-store",
  });
  res.end(bytes);
}

export class LocalNativeHttpTransport {
  constructor({
    facade,
    token,
    host = "127.0.0.1",
    port = 0,
    maxBodyBytes = 1024 * 1024,
    clock = Date.now,
  } = {}) {
    if (!facade) throw new TypeError("facade is required.");
    if (typeof token !== "string" || token.length < 24) throw new TypeError("token must be at least 24 characters.");
    if (!isLoopbackHost(host)) throw new TypeError("Wave 1 native HTTP transport may bind only to loopback.");
    this.facade = facade;
    this.token = token;
    this.host = host;
    this.port = port;
    this.maxBodyBytes = maxBodyBytes;
    this.clock = clock;
    this.server = null;
    this.startedAtMs = null;
  }

  async #handle(req, res) {
    const requestUrl = new URL(req.url ?? "/", `http://${this.host}`);
    const path = requestUrl.pathname;
    if (!authorized(req.headers.authorization, this.token)) {
      sendJson(res, 401, errorEnvelope(new NativeFacadeError("Authentication required.", {
        code: "AUTH_REQUIRED",
        category: "auth",
        httpStatus: 401,
      })));
      return;
    }

    try {
      if (req.method === "GET" && path === "/v1/health") {
        sendJson(res, 200, {
          status: "ok",
          lifecycle: this.server?.listening ? "running" : "starting",
          protocol: "pc.native.control.v1",
        });
        return;
      }
      if (req.method === "GET" && path === "/v1/lifecycle") {
        sendJson(res, 200, {
          state: this.server?.listening ? "running" : "starting",
          started_at_ms: this.startedAtMs,
          loopback_only: true,
        });
        return;
      }
      if (req.method === "GET" && path === "/v1/capabilities") {
        sendJson(res, 200, await this.facade.capabilities());
        return;
      }

      const body = await readJson(req, this.maxBodyBytes);
      if (req.method === "POST" && path === "/v1/session/open") {
        sendJson(res, 200, await this.facade.openSession(body));
        return;
      }
      if (req.method === "POST" && path === "/v1/session/reconnect") {
        sendJson(res, 200, await this.facade.reconnectSession(body));
        return;
      }
      if (req.method === "POST" && path === "/v1/session/close") {
        sendJson(res, 200, this.facade.closeSession(body.sessionId));
        return;
      }
      if (req.method === "POST" && path === "/v1/request") {
        sendJson(res, 200, await this.facade.invoke(body));
        return;
      }
      if (req.method === "POST" && path === "/v1/request/lookup") {
        sendJson(res, 200, this.facade.lookupRequest(body));
        return;
      }
      if (req.method === "POST" && path === "/v1/request/reconcile") {
        sendJson(res, 200, await this.facade.reconcileRequest(body));
        return;
      }
      if (req.method === "POST" && path === "/v1/request/cancel") {
        sendJson(res, 200, this.facade.cancelRequest(body));
        return;
      }
      throw new NativeFacadeError("Endpoint not found.", {
        code: "ENDPOINT_NOT_FOUND",
        category: "transport",
        httpStatus: 404,
      });
    } catch (error) {
      const status = Number.isInteger(error?.httpStatus) ? error.httpStatus : 500;
      sendJson(res, status, errorEnvelope(error));
    }
  }

  async start() {
    if (this.server) throw new Error("Transport already started.");
    this.server = createServer((req, res) => {
      this.#handle(req, res).catch((error) => {
        if (!res.headersSent) sendJson(res, 500, errorEnvelope(error));
        else res.destroy(error);
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, resolve);
    });
    this.startedAtMs = this.clock();
    const address = this.server.address();
    const actualHost = typeof address === "object" && address ? address.address : this.host;
    const actualPort = typeof address === "object" && address ? address.port : this.port;
    return {
      host: actualHost,
      port: actualPort,
      url: `http://${actualHost.includes(":") ? `[${actualHost}]` : actualHost}:${actualPort}`,
    };
  }

  async stop() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

export const __test = Object.freeze({ isLoopbackHost, authorized });
