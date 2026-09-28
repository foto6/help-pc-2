// Deterministic, read-only audit of the pinned Control -> PC Core native wire
// and Desktop Commander compatibility surface. Never invokes an Executor.
import {
  NATIVE_CONTROL_PROTOCOL_V1,
  NATIVE_TOOL_REGISTRY_V1,
  TOOL_REGISTRY,
  TOOL_REGISTRY_DIGEST,
  TOOL_REGISTRY_LIST,
  sha256,
} from "./native-registry.js";
import {
  PC_NATIVE_WIRE_ROUTES,
  PC_FROZEN_REGISTRY_V1,
  PC_PARITY_REGISTRY_V1,
  PINNED_PC_FROZEN_DIGEST,
  routeNativeExecutorTool,
} from "./native-relay-registry-route.js";
import {
  DC_COMPATIBILITY_REGISTRY_V1,
  DC_COMPATIBILITY_REGISTRY_DIGEST,
  DC_COMPATIBILITY_REGISTRY_LIST,
  DC_VENDOR_NON_EQUIVALENTS,
  desktopCommanderCompatibilityManifestV1,
} from "./dc-compatibility-registry.js";

export const FULL_COMPAT_AUDIT_V1 = "pc.control.full_compat_observability.v1";

export class FullCompatibilityAuditError extends Error {
  constructor(code) {
    super(code);
    this.name = "FullCompatibilityAuditError";
    this.code = code;
    this.category = "capability_mismatch";
    this.retryable = false;
  }
}

function fail(code) { throw new FullCompatibilityAuditError(code); }

export function assertPinnedNativeManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)
      || manifest.contract_version !== NATIVE_TOOL_REGISTRY_V1
      || manifest.protocol_version !== NATIVE_CONTROL_PROTOCOL_V1
      || manifest.registry_digest !== TOOL_REGISTRY_DIGEST) {
    fail("NATIVE_REGISTRY_IDENTITY_MISMATCH");
  }
  const executor = manifest.executor;
  if (!executor || executor.contract_version !== "pc_executor.capabilities.v1"
      || typeof executor.digest !== "string" || !executor.digest
      || !Array.isArray(executor.actions)
      || executor.actions.some((name) => typeof name !== "string" || !name)
      || new Set(executor.actions).size !== executor.actions.length) {
    fail("EXECUTOR_CAPABILITY_IDENTITY_INVALID");
  }
  return manifest;
}

function routeAudit() {
  if (TOOL_REGISTRY_LIST.length !== 62 || PC_NATIVE_WIRE_ROUTES.length !== 62) {
    fail("NATIVE_ROUTE_COUNT_MISMATCH");
  }
  const names = new Set();
  const rows = PC_NATIVE_WIRE_ROUTES.map((route) => {
    const definition = TOOL_REGISTRY[route.advertisedToolName];
    if (!definition || names.has(definition.name)) fail("NATIVE_ROUTE_IDENTITY_MISMATCH");
    names.add(definition.name);
    const canonical = routeNativeExecutorTool(
      definition.name, definition.executorAction, definition.effect);
    if (canonical !== route ||
        ![PC_FROZEN_REGISTRY_V1, PC_PARITY_REGISTRY_V1].includes(route.registryVersion) ||
        (route.registryVersion === PC_FROZEN_REGISTRY_V1 &&
         route.wireToolName !== definition.name)) {
      fail("NATIVE_ROUTE_IDENTITY_MISMATCH");
    }
    return {
      name: definition.name,
      registry_version: route.registryVersion,
      wire_tool: route.wireToolName,
      alias: route.wireToolName !== definition.name,
      executor_action: definition.executorAction,
      effect: definition.effect,
      streaming: definition.streaming,
      destructive: definition.destructive,
      handle_mode: definition.handleMode,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  if (names.size !== TOOL_REGISTRY_LIST.length ||
      rows.filter((row) => row.registry_version === PC_FROZEN_REGISTRY_V1).length !== 37 ||
      rows.filter((row) => row.registry_version === PC_PARITY_REGISTRY_V1).length !== 25) {
    fail("NATIVE_ROUTE_PARTITION_MISMATCH");
  }
  return rows;
}

function compatibilityAudit(manifest) {
  const publicManifest = desktopCommanderCompatibilityManifestV1({ nativeManifest: manifest });
  if (publicManifest.registry_digest !== DC_COMPATIBILITY_REGISTRY_DIGEST ||
      publicManifest.tools.length !== 28 || DC_VENDOR_NON_EQUIVALENTS.length !== 2) {
    fail("PUBLIC_COMPATIBILITY_CATALOG_MISMATCH");
  }
  const seen = new Set();
  for (const definition of DC_COMPATIBILITY_REGISTRY_LIST) {
    if (seen.has(definition.name)) fail("PUBLIC_COMPATIBILITY_CATALOG_MISMATCH");
    seen.add(definition.name);
    for (const variant of definition.capability_variants) {
      const selectedTools = variant.native_tools.map((name) => {
        const native = TOOL_REGISTRY[name];
        if (!native) fail("PUBLIC_COMPATIBILITY_NATIVE_ROUTE_MISSING");
        if (definition.effect === "read_only" && native.effect !== "read_only") {
          fail("PUBLIC_COMPATIBILITY_EFFECT_ESCALATION");
        }
        return native;
      });
      if (definition.effect === "side_effect" &&
          !selectedTools.some((native) => native.effect === "side_effect")) {
        fail("PUBLIC_COMPATIBILITY_EFFECT_DOWNGRADE");
      }
    }
  }
  if (seen.size !== 28 || publicManifest.tools.some((tool) => !seen.has(tool.name))) {
    fail("PUBLIC_COMPATIBILITY_CATALOG_MISMATCH");
  }
  return publicManifest;
}

export function fullCompatibilityAuditV1({ nativeManifest } = {}) {
  assertPinnedNativeManifest(nativeManifest);
  const routes = routeAudit();
  const publicManifest = compatibilityAudit(nativeManifest);
  return {
    contract_version: FULL_COMPAT_AUDIT_V1,
    protocol_version: NATIVE_CONTROL_PROTOCOL_V1,
    control_registry_digest: TOOL_REGISTRY_DIGEST,
    pc_frozen_registry_digest: PINNED_PC_FROZEN_DIGEST,
    route_digest: sha256({ contract_version: FULL_COMPAT_AUDIT_V1, routes }),
    executor_digest: nativeManifest.executor.digest,
    native_routes: {
      total: routes.length,
      frozen: 37,
      parity: 25,
      rows: routes,
    },
    public_catalog: {
      contract_version: DC_COMPATIBILITY_REGISTRY_V1,
      registry_digest: DC_COMPATIBILITY_REGISTRY_DIGEST,
      mandatory: publicManifest.tools.length,
      vendor_non_equivalents: publicManifest.vendor_non_equivalents.map((entry) => entry.name),
      available: publicManifest.tools.filter((tool) => tool.available).length,
      tools: publicManifest.tools.map((tool) => ({
        name: tool.name,
        effect: tool.effect,
        available: tool.available,
        selected_variant: tool.selected_variant,
        availability_reason: tool.availability_reason,
        variants: tool.capability_variants.map((variant) => ({
          id: variant.id,
          available: variant.available,
          executor_actions: variant.executor_actions,
          native_tools: variant.native_tools,
          missing_executor_actions: variant.missing_executor_actions,
          blocked_by_executor_actions: variant.blocked_by_executor_actions,
        })),
      })),
    },
  };
}
