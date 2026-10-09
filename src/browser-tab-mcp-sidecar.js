import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  allowedCdpPorts, listChromeTabs, captureChromeTab, mcpScreenshotResult,
} from "./browser-tab-capture.js";

const SERVER_NAME = "pc-browser-tab-capture";
const TOOL_META = Object.freeze({
  "pc.browser/source": "local_chrome_cdp",
  "pc.browser/effect": "read_only",
  "pc.browser/focus_change": false,
  "pc.browser/pixels_to_github": false,
});
const ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

function browserFailure(error) {
  const message = String(error?.message || "");
  return {
    content: [{ type: "text", text: JSON.stringify({
      ok: false,
      code: /^CDP_[A-Z_]+$/.test(message) ? message : "BROWSER_CAPTURE_FAILED",
    }) }],
    isError: true,
  };
}

// Deliberately separate from src/mcp-host.js and the R31/R38 pinned
// direct-remote authority. Running this sidecar never obtains the PC Executor
// desktop lease or enables filesystem/keyboard/mouse/side-effect tools.
export function registerBrowserTabTools(server, {
  enabled = process.env.PC_CONTROL_ENABLE_BROWSER_TAB_CAPTURE === "1",
  listImpl = listChromeTabs,
  captureImpl = captureChromeTab,
} = {}) {
  if (!enabled) throw new Error("BROWSER_CAPTURE_EXPLICIT_OPT_IN_REQUIRED");
  allowedCdpPorts(); // Fail closed on unsafe operator configuration.

  server.registerTool("browser.tab.list", {
    description: "List page target IDs and sanitized URLs from an allowed localhost Chrome DevTools port without switching tabs or changing focus.",
    inputSchema: z.object({
      port: z.number().int().min(1024).max(65535),
    }).strict(),
    annotations: ANNOTATIONS, _meta: TOOL_META,
  }, async ({ port }) => {
    try {
      return {
        content: [{ type: "text", text: JSON.stringify({
          ok: true, tabs: await listImpl(port),
        }) }],
      };
    } catch (error) { return browserFailure(error); }
  });

  server.registerTool("browser.tab.capture", {
    description: "Return real image/png content of the exact Chrome page target in the background; no activation, navigation, typing, pointer movement, or GitHub screenshot persistence. Use only on user-authorized pages.",
    inputSchema: z.object({
      port: z.number().int().min(1024).max(65535),
      target_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
      expected_url: z.string().min(1).max(2048).optional(),
    }).strict(),
    annotations: ANNOTATIONS, _meta: TOOL_META,
  }, async ({ port, target_id, expected_url }) => {
    try {
      const screenshot = await captureImpl({
        port, target_id, expected_url: expected_url ?? null,
      });
      return mcpScreenshotResult(screenshot);
    } catch (error) { return browserFailure(error); }
  });
  return Object.freeze(["browser.tab.list", "browser.tab.capture"]);
}

export function createBrowserTabMcpServer() {
  const server = new McpServer(
    { name: SERVER_NAME, version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  registerBrowserTabTools(server);
  return server;
}
