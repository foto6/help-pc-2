// Explicit, fail-closed wire routing for the exact pinned PC Core native registries.
// PC Core 04f817299b46ecb0ffa8aa908ce84fdb4c3300d0 freezes
// pc.native.tool_registry.v1 at 58b2bde8c6a49825747dcd7010f105dad0b6d548c7e8341cdafb32d2319f6dcd.
// New parity tools belong to pc.native.parity_tool_registry.v1; they MUST NOT
// be dispatched to the old registry simply because Control advertises them.
import { TOOL_REGISTRY_DIGEST, TOOL_REGISTRY_LIST, toolDefinition } from "./native-registry.js";

export const PC_FROZEN_REGISTRY_V1 = "pc.native.tool_registry.v1";
export const PC_PARITY_REGISTRY_V1 = "pc.native.parity_tool_registry.v1";
export const PINNED_PC_FROZEN_DIGEST =
  "58b2bde8c6a49825747dcd7010f105dad0b6d548c7e8341cdafb32d2319f6dcd";
export const PINNED_CONTROL_NATIVE_DIGEST =
  "771f6d31d48fc2c89ff936f43346da11ca897d37fc84c7a9cccb08367aba837b";

// Names from PC Core's literal _COMPAT_TOOLS_V1 (37 names). Do not alter their
// existing on-wire envelope or the frozen producer digest.
const FROZEN_NAMES = new Set(`
device.health device.get_config device.set_config file.list file.info file.read
file.read_bytes file.hash file.search content.search file.write file.append
file.edit file.create_dir file.copy file.move file.delete process.start
process.read process.interact process.list process.terminate system.process.list
system.process.kill shell.session.open shell.session.read shell.session.write
shell.session.close shell.run window.list screenshot.capture uia.find uia.invoke
input.click input.type clipboard.read clipboard.write
`.trim().split(/\s+/));

// Explicit Control-name -> PC Core _PARITY_TOOLS name mapping. Every route
// preserves the Executor action and effect. Aliases are necessary where the
// Control public native tool name differs from the frozen parity wire name.
const PARITY_WIRE_NAMES = Object.freeze({
  "device.info":"device.info",
  "device.ping":"device.health",
  "agent.shutdown":"agent.shutdown",
  "config.get":"device.get_config",
  "config.set":"device.set_config",
  "identity.who_am_i":"identity.who_am_i",
  "device.identity":"identity.who_am_i",
  "usage.stats":"diagnostics.usage_stats",
  "diagnostics.usage_stats":"diagnostics.usage_stats",
  "audit.recent":"diagnostics.recent_tool_calls",
  "diagnostics.recent_tool_calls":"diagnostics.recent_tool_calls",
  "file.read_multiple":"file.read_multiple",
  "log.tail":"log.tail",
  "pdf.write":"pdf.write",
  "search.start":"search.start",
  "search.read":"search.read",
  "search.list":"search.list",
  "search.stop":"search.stop",
  "process.read_output":"process.read",
  "process.status":"process.status",
  "process.managed.list":"process.list",
  "system.process.inspect":"system.process.inspect",
  "shell.session.start":"shell.session.open",
  "shell.session.write_stdin":"shell.session.write",
  "shell.session.terminate":"shell.session.close",
});

function invalidRoute(message) {
  const error = new Error(message);
  error.code = "NATIVE_WIRE_REGISTRY_MISMATCH";
  return error;
}

if (TOOL_REGISTRY_DIGEST !== PINNED_CONTROL_NATIVE_DIGEST) {
  throw invalidRoute("The pinned Control native registry has drifted; reject wire routes.");
}
if (FROZEN_NAMES.size !== 37 || Object.keys(PARITY_WIRE_NAMES).length !== 25 ||
    TOOL_REGISTRY_LIST.length !== 62) {
  throw invalidRoute("The pinned native wire route partition changed.");
}

const routing = new Map();
for (const tool of TOOL_REGISTRY_LIST) {
  const frozen = FROZEN_NAMES.has(tool.name);
  const parity = Object.hasOwn(PARITY_WIRE_NAMES, tool.name);
  if (frozen === parity || routing.has(tool.name)) {
    throw invalidRoute(`Ambiguous or missing PC Core route for ${tool.name}.`);
  }
  const route = Object.freeze({
    advertisedToolName: tool.name,
    registryVersion: frozen ? PC_FROZEN_REGISTRY_V1 : PC_PARITY_REGISTRY_V1,
    wireToolName: frozen ? tool.name : PARITY_WIRE_NAMES[tool.name],
    executorAction: tool.executorAction,
    effect: tool.effect,
  });
  routing.set(tool.name, route);
}
if (routing.size !== TOOL_REGISTRY_LIST.length ||
    [...FROZEN_NAMES].some((name) => !routing.has(name)) ||
    Object.keys(PARITY_WIRE_NAMES).some((name) => !routing.has(name))) {
  throw invalidRoute("PC Core native wire routes do not cover the exact native registry.");
}

export const PC_NATIVE_WIRE_ROUTES = Object.freeze([...routing.values()]);

export function routeNativeExecutorTool(name, action, effect) {
  const advertised = toolDefinition(name);
  const route = routing.get(name);
  if (!advertised || !route || advertised.executorAction !== action ||
      advertised.effect !== effect || route.executorAction !== action ||
      route.effect !== effect || !route.wireToolName) {
    throw invalidRoute("Native tool/Executor wire registry binding is unavailable or stale.");
  }
  return route;
}
