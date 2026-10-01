import { mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { ControlPlane } from "./control-plane.js";
import { HelpPc1Adapter } from "./adapters.js";
import { JsonStateStore } from "./persistence.js";
import { JsonFacadeStateStore, NativeControlFacade } from "./native-facade.js";
import { NativeMcpRuntime } from "./mcp-host.js";
import { DesktopCommanderCompatibilitySurface, JsonDcCompatibilityStore } from "./dc-compatibility.js";
import {
  createExecutorBridge as createBuiltInRelayBridge,
  NATIVE_RELAY_PROVIDER_IDENTITY,
} from "./native-relay-provider.js";
import { importPinnedExecutorModule } from "./executor-module-identity.js";
import { R23AdapterCircuitRegistry, R23HealthSupervisor } from "./r23-health.js";

export const PRODUCTION_BRIDGE_CONTRACT = "pc.native.builtin_relay_provider.v1";

function runtimeConfigError(message, code, details = null) {
  const error = new Error(message);
  error.name = "NativeMcpRuntimeConfigError";
  error.code = code;
  error.details = details;
  return error;
}

function capabilityPayload(raw) {
  return raw?.data?.capabilities ?? raw?.capabilities ?? raw;
}

function requireFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`Executor bridge must provide ${name}()`);
  return value;
}

function builtInProviderIdentity(mode) {
  return Object.freeze({
    contract_version: PRODUCTION_BRIDGE_CONTRACT,
    built_in: true,
    mode,
    ...NATIVE_RELAY_PROVIDER_IDENTITY,
  });
}

async function resolveBridgeFactory({ mode, testConfig }) {
  if (testConfig !== undefined) {
    if (!testConfig || testConfig.enabled !== true) {
      throw runtimeConfigError(
        "testConfig must explicitly set enabled=true",
        "TEST_BRIDGE_INJECTION_NOT_ENABLED",
      );
    }
    if (testConfig.createExecutorBridge !== undefined) {
      if (typeof testConfig.createExecutorBridge !== "function") {
        throw new TypeError("testConfig.createExecutorBridge must be a function");
      }
      return {
        createBridge: testConfig.createExecutorBridge,
        moduleIdentity: Object.freeze({
          contract_version: "pc.native.executor_module_test_injection.v1",
          mode,
          injected: true,
        }),
      };
    }
    if (testConfig.trustedPin && testConfig.executorModule) {
      const { imported, identity } = await importPinnedExecutorModule(
        testConfig.executorModule,
        testConfig.trustedPin,
      );
      const createBridge = imported.createExecutorBridge ?? imported.default;
      if (typeof createBridge !== "function") {
        throw new TypeError("Pinned test Executor bridge module must export createExecutorBridge() or a default factory");
      }
      return { createBridge, moduleIdentity: identity };
    }
    throw runtimeConfigError(
      "testConfig must provide createExecutorBridge or {executorModule, trustedPin}",
      "TEST_BRIDGE_INJECTION_INVALID",
    );
  }

  if (typeof process.env.PC_NATIVE_EXECUTOR_MODULE === "string"
      && process.env.PC_NATIVE_EXECUTOR_MODULE.trim()) {
    throw runtimeConfigError(
      "PC_NATIVE_EXECUTOR_MODULE is forbidden in production; the shipped native relay provider is authoritative.",
      "PRODUCTION_EXECUTOR_MODULE_OVERRIDE_FORBIDDEN",
    );
  }

  return {
    createBridge: createBuiltInRelayBridge,
    moduleIdentity: builtInProviderIdentity(mode),
  };
}

export async function createConfiguredNativeMcpRuntime({
  stateDir = process.env.PC_NATIVE_STATE_DIR ?? resolve(".pc-native-mcp-state"),
  desktopId = process.env.PC_NATIVE_DESKTOP_ID ?? "desktop-A",
  mode = "mcp",
  testConfig = undefined,
  legacyMigrationSessionId = null,
  healthConfig = {},
} = {}) {
  const { createBridge, moduleIdentity } = await resolveBridgeFactory({ mode, testConfig });
  const bridge = await createBridge({ mode });
  if (!bridge || typeof bridge !== "object") throw new TypeError("Executor bridge factory returned no bridge");
  requireFunction(bridge.invoke, "invoke");
  requireFunction(bridge.readCapabilities, "readCapabilities");

  if (bridge.readDeviceIdentity !== undefined) requireFunction(bridge.readDeviceIdentity, "readDeviceIdentity");
  if (bridge.preflight !== undefined) requireFunction(bridge.preflight, "preflight");
  if (bridge.readEvidence !== undefined) requireFunction(bridge.readEvidence, "readEvidence");
  if (bridge.bindExecutionContext !== undefined) requireFunction(bridge.bindExecutionContext, "bindExecutionContext");
  if (bridge.readTransportHealth !== undefined) requireFunction(bridge.readTransportHealth, "readTransportHealth");

  mkdirSync(stateDir, { recursive: true });
  const circuitRegistry = new R23AdapterCircuitRegistry({
    ...(healthConfig.circuit ?? {}),
  });
  const adapter = new HelpPc1Adapter({
    invoke: bridge.invoke,
    dryRun: bridge.dryRun ?? false,
    readEvidence: bridge.readEvidence ?? null,
    readCapabilities: bridge.preflight ? bridge.readCapabilities : null,
    preflight: bridge.preflight ?? null,
    bindExecutionContext: bridge.bindExecutionContext ?? null,
    healthGovernor: circuitRegistry,
  });

  const controlPlane = new ControlPlane({
    providers: [adapter],
    store: new JsonStateStore(join(stateDir, "control-plane.json")),
  });

  const facade = new NativeControlFacade({
    controlPlane,
    store: new JsonFacadeStateStore(join(stateDir, "native-facade.json")),
    capabilityProvider: async ({ signal = null } = {}) => capabilityPayload(await bridge.readCapabilities(
      { request_id: null, action: null },
      { source: "pc-native-mcp-host", signal },
    )),
    deviceIdentityProvider: bridge.readDeviceIdentity
      ? async ({ signal = null } = {}) => bridge.readDeviceIdentity(
        { request_id: null, action: null },
        { source: "pc-native-mcp-host", signal },
      )
      : null,
  });

  const healthSupervisor = new R23HealthSupervisor({
    controlPlane,
    circuitRegistry,
    processAlive: () => true,
    transportProbe: bridge.readTransportHealth
      ? ({ signal }) => bridge.readTransportHealth(
          { request_id: null, action: "health.get" },
          { source: "pc-native-mcp-health", signal },
        )
      : null,
    ...(healthConfig.supervisor ?? {}),
  });

  const compatibilitySurface = new DesktopCommanderCompatibilitySurface({
    facade,
    store: new JsonDcCompatibilityStore(join(stateDir, "dc-compatibility.json")),
  });

  // Explicit one-time PERSONAL installation upgrade only. Never guess an old
  // owner's identity or silently cancel an unresolved Executor operation.
  if (legacyMigrationSessionId !== null) {
    if (typeof legacyMigrationSessionId !== "string" || !legacyMigrationSessionId) {
      throw runtimeConfigError("A pinned legacy facade session ID is required.", "SESSION_MIGRATION_PIN_REQUIRED");
    }
    const manifest = await facade.capabilities();
    await facade.migrateLegacyQuiescentSession({
      sessionId: legacyMigrationSessionId,
      desktopId: bridge.desktopId ?? desktopId,
      client: {
        protocol_version: manifest.protocol_version,
        registry_digest: manifest.registry_digest,
        executor_digest: manifest.executor?.digest ?? null,
      },
    });
  }

  const runtime = await NativeMcpRuntime.create({
    facade,
    desktopId: bridge.desktopId ?? desktopId,
    compatibilitySurface,
    healthSupervisor,
  });

  return {
    runtime,
    facade,
    controlPlane,
    bridge,
    circuitRegistry,
    healthSupervisor,
    stateDir,
    moduleIdentity,
  };
}

export const __test = Object.freeze({
  capabilityPayload,
  resolveBridgeFactory,
  builtInProviderIdentity,
});
