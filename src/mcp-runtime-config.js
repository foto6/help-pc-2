import { mkdirSync } from "node:fs";
import { isAbsolute, resolve, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { ControlPlane } from "./control-plane.js";
import { HelpPc1Adapter } from "./adapters.js";
import { JsonStateStore } from "./persistence.js";
import { JsonFacadeStateStore, NativeControlFacade } from "./native-facade.js";
import { NativeMcpRuntime } from "./mcp-host.js";
import { DesktopCommanderCompatibilitySurface, JsonDcCompatibilityStore } from "./dc-compatibility.js";

function moduleUrl(specifier) {
  if (typeof specifier !== "string" || !specifier.trim()) {
    throw new Error("PC_NATIVE_EXECUTOR_MODULE is required");
  }
  const value = specifier.trim();
  if (value.startsWith("file:")) return value;
  if (isAbsolute(value)) return pathToFileURL(value).href;
  if (/^[a-z]+:/i.test(value)) {
    throw new Error("Only local file executor bridge modules are supported");
  }
  return pathToFileURL(resolve(value)).href;
}

function capabilityPayload(raw) {
  return raw?.data?.capabilities ?? raw?.capabilities ?? raw;
}

function requireFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`Executor bridge must provide ${name}()`);
  return value;
}

export async function createConfiguredNativeMcpRuntime({
  executorModule = process.env.PC_NATIVE_EXECUTOR_MODULE,
  stateDir = process.env.PC_NATIVE_STATE_DIR ?? resolve(".pc-native-mcp-state"),
  desktopId = process.env.PC_NATIVE_DESKTOP_ID ?? "desktop-A",
  mode = "mcp",
} = {}) {
  const imported = await import(moduleUrl(executorModule));
  const createBridge = imported.createExecutorBridge ?? imported.default;
  if (typeof createBridge !== "function") {
    throw new TypeError("Executor bridge module must export createExecutorBridge() or a default factory");
  }

  const bridge = await createBridge({ mode });
  if (!bridge || typeof bridge !== "object") throw new TypeError("Executor bridge factory returned no bridge");
  requireFunction(bridge.invoke, "invoke");
  requireFunction(bridge.readCapabilities, "readCapabilities");

  if (bridge.preflight !== undefined) requireFunction(bridge.preflight, "preflight");
  if (bridge.readEvidence !== undefined) requireFunction(bridge.readEvidence, "readEvidence");
  if (bridge.bindExecutionContext !== undefined) requireFunction(bridge.bindExecutionContext, "bindExecutionContext");

  mkdirSync(stateDir, { recursive: true });
  const adapter = new HelpPc1Adapter({
    invoke: bridge.invoke,
    dryRun: bridge.dryRun ?? false,
    readEvidence: bridge.readEvidence ?? null,
    readCapabilities: bridge.preflight ? bridge.readCapabilities : null,
    preflight: bridge.preflight ?? null,
    bindExecutionContext: bridge.bindExecutionContext ?? null,
  });

  const controlPlane = new ControlPlane({
    providers: [adapter],
    store: new JsonStateStore(join(stateDir, "control-plane.json")),
  });

  const facade = new NativeControlFacade({
    controlPlane,
    store: new JsonFacadeStateStore(join(stateDir, "native-facade.json")),
    capabilityProvider: async () => capabilityPayload(await bridge.readCapabilities(
      { request_id: null, action: null },
      { source: "pc-native-mcp-host" },
    )),
  });

  const compatibilitySurface = new DesktopCommanderCompatibilitySurface({
    facade,
    store: new JsonDcCompatibilityStore(join(stateDir, "dc-compatibility.json")),
  });

  const runtime = await NativeMcpRuntime.create({
    facade,
    desktopId: bridge.desktopId ?? desktopId,
    compatibilitySurface,
  });

  return { runtime, facade, controlPlane, bridge, stateDir };
}

export const __test = Object.freeze({ moduleUrl, capabilityPayload });
