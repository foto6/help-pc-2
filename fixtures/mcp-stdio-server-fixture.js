import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createConfiguredNativeMcpRuntime } from "../src/mcp-runtime-config.js";
import { nativeMcpServerFactory } from "../src/mcp-host.js";
import { createExecutorBridge } from "../test/fixtures/mock-mcp-executor-bridge.js";

const { runtime } = await createConfiguredNativeMcpRuntime({
  mode: "stdio",
  stateDir: process.env.PC_NATIVE_STATE_DIR,
  desktopId: process.env.PC_NATIVE_DESKTOP_ID,
  testConfig: {
    enabled: true,
    createExecutorBridge,
  },
});

const handle = serveStdio(nativeMcpServerFactory(runtime), {
  legacy: "serve",
  onerror: (error) => console.error("[pc-native-mcp-test] stdio error:", error),
});

async function shutdown() {
  try { await handle.close(); } catch {}
  try { await runtime.close(); } catch {}
}

process.once("SIGINT", () => shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => shutdown().finally(() => process.exit(0)));
