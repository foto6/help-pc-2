#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createConfiguredNativeMcpRuntime } from "../src/mcp-runtime-config.js";
import { nativeMcpServerFactory } from "../src/mcp-host.js";

const { runtime } = await createConfiguredNativeMcpRuntime({ mode: "stdio" });
const handle = serveStdio(nativeMcpServerFactory(runtime), {
  legacy: "serve",
  onerror: (error) => console.error("[pc-native-mcp] stdio error:", error),
});

async function shutdown() {
  try { await handle.close(); } catch {}
  try { await runtime.close(); } catch {}
}

process.once("SIGINT", () => shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => shutdown().finally(() => process.exit(0)));
