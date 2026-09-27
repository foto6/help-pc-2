#!/usr/bin/env node
import { createLiveControlRuntime } from "./live-runtime.js";
import { PcControlMcpGateway, serveMcpStdio } from "./mcp-gateway.js";

const runtime = createLiveControlRuntime();
const gateway = new PcControlMcpGateway(runtime);

const shutdown = () => {
  try { runtime.close(); } catch {}
};

process.once("SIGINT", () => { shutdown(); process.exit(130); });
process.once("SIGTERM", () => { shutdown(); process.exit(143); });
process.once("exit", shutdown);

console.error(JSON.stringify({
  event: "pc_control_mcp_started",
  live: runtime.live,
  desktopId: runtime.desktopId,
  dataDir: runtime.dataDir,
}));

try {
  await serveMcpStdio(gateway);
} finally {
  shutdown();
}
