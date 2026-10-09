#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createBrowserTabMcpServer } from "../src/browser-tab-mcp-sidecar.js";

// Opt-in separate local stdio MCP surface. No private GitHub relay, no
// browser profile relaunch, no PC Executor authority or desktop lease.
if (process.env.PC_CONTROL_ENABLE_BROWSER_TAB_CAPTURE !== "1") {
  throw new Error("Set PC_CONTROL_ENABLE_BROWSER_TAB_CAPTURE=1 to authorize local screenshot media");
}
const handle = serveStdio(() => createBrowserTabMcpServer(), {
  legacy: "serve",
  onerror: error => console.error("[pc-browser-tab] stdio error:", error?.name || "Error"),
});
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  try { await handle.close(); } catch {}
}
process.once("SIGINT", () => shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => shutdown().finally(() => process.exit(0)));
