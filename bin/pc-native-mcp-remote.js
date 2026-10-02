#!/usr/bin/env node
import { createConfiguredNativeMcpRuntime } from "../src/mcp-runtime-config.js";
import {
  assertCredentialSeparation,
  startDirectRemoteMcpServer,
} from "../src/direct-remote-mcp.js";

function intEnv(name, fallback, minimum, maximum) {
  const raw = process.env[name] ?? String(fallback);
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function csv(name) {
  const value = process.env[name];
  if (!value) return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

const clientToken = process.env.PC_NATIVE_REMOTE_MCP_TOKEN;
if (!clientToken) throw new Error("PC_NATIVE_REMOTE_MCP_TOKEN is required");
const relayToken = process.env.PC_NATIVE_RELAY_TOKEN;
if (!relayToken) throw new Error("PC_NATIVE_RELAY_TOKEN is required");
assertCredentialSeparation(clientToken, relayToken);

const bindHost = process.env.PC_NATIVE_REMOTE_MCP_BIND_HOST ?? "127.0.0.1";
const port = intEnv("PC_NATIVE_REMOTE_MCP_PORT", 0, 0, 65535);
const publicOrigin = process.env.PC_NATIVE_REMOTE_MCP_PUBLIC_ORIGIN;
if (!publicOrigin) throw new Error("PC_NATIVE_REMOTE_MCP_PUBLIC_ORIGIN is required");

const requestTimeoutMs = intEnv("PC_NATIVE_REMOTE_MCP_REQUEST_TIMEOUT_MS", 30_000, 250, 120_000);
const discoveryTimeoutMs = intEnv("PC_NATIVE_REMOTE_MCP_DISCOVERY_TIMEOUT_MS", 5_000, 100, 30_000);
const maxRequestBodySize = intEnv(
  "PC_NATIVE_REMOTE_MCP_MAX_REQUEST_BODY_BYTES",
  1024 * 1024,
  1024,
  8 * 1024 * 1024,
);

const configured = await createConfiguredNativeMcpRuntime({
  mode: "direct-remote",
});

const server = await startDirectRemoteMcpServer({
  runtime: configured.runtime,
  clientToken,
  deviceAuthorityToken: relayToken,
  bindHost,
  port,
  publicOrigin,
  authorizedRemoteBindHosts: csv("PC_NATIVE_REMOTE_MCP_ALLOWED_BIND_HOSTS"),
  allowedOrigins: csv("PC_NATIVE_REMOTE_MCP_ALLOWED_ORIGINS").length
    ? csv("PC_NATIVE_REMOTE_MCP_ALLOWED_ORIGINS")
    : null,
  requestTimeoutMs,
  discoveryTimeoutMs,
  maxRequestBodySize,
});

console.error(
  `[pc-native-mcp] direct remote lane SOURCE_READY bind=${server.host}:${server.port} public_origin=${server.public_origin}`,
);
console.error(
  "[pc-native-mcp] ACTUAL_REMOTE_CHATGPT_TOOL_EXPOSED=false; external gateway/plugin registration requires separate explicit authority",
);

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  try { await server.close(); } catch {}
  try { await configured.runtime.close(); } catch {}
}

process.once("SIGINT", () => shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => shutdown().finally(() => process.exit(0)));
