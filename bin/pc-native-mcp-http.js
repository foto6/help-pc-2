#!/usr/bin/env node
import { createConfiguredNativeMcpRuntime } from "../src/mcp-runtime-config.js";
import { startNativeMcpHttpServer } from "../src/mcp-http-host.js";

const token = process.env.PC_NATIVE_MCP_TOKEN;
if (!token) throw new Error("PC_NATIVE_MCP_TOKEN is required for Streamable HTTP");
const host = process.env.PC_NATIVE_MCP_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.PC_NATIVE_MCP_PORT ?? "0", 10);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PC_NATIVE_MCP_PORT must be 0..65535");

const { runtime } = await createConfiguredNativeMcpRuntime({ mode: "http" });
const httpServer = await startNativeMcpHttpServer({ runtime, token, host, port });
console.error(`[pc-native-mcp] Streamable HTTP listening on ${httpServer.url}`);

async function shutdown() {
  try { await httpServer.close(); } catch {}
  try { await runtime.close(); } catch {}
}

process.once("SIGINT", () => shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => shutdown().finally(() => process.exit(0)));
