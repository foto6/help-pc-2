import { createHash } from "node:crypto";

export const NATIVE_CONTROL_PROTOCOL_V1 = "pc.native.control.v1";
export const NATIVE_TOOL_REGISTRY_V1 = "pc.native.tool_registry.v1";
export const NATIVE_RESPONSE_V1 = "pc.native.response.v1";
export const DEFAULT_NATIVE_LIMITS = Object.freeze({
  maxPageSize: 200,
  maxBodyBytes: 1024 * 1024,
});

const tools = [
  ["device.health", "system.health", "read_only"],
  ["device.get_config", "system.config.get", "read_only"],
  ["device.set_config", "system.config.set", "side_effect"],
  ["file.list", "fs.list", "read_only", "stream"],
  ["file.info", "fs.stat", "read_only"],
  ["file.read", "fs.read_text", "read_only", "stream"],
  ["file.read_bytes", "fs.read_bytes", "read_only", "stream"],
  ["file.hash", "fs.hash", "read_only"],
  ["file.search", "fs.find", "read_only", "stream"],
  ["content.search", "fs.search_text", "read_only", "stream"],
  ["file.write", "fs.write_text", "side_effect"],
  ["file.append", "fs.append_text", "side_effect"],
  ["file.edit", "fs.edit_text", "side_effect"],
  ["file.create_dir", "fs.mkdir", "side_effect"],
  ["file.copy", "fs.copy", "side_effect"],
  ["file.move", "fs.move", "side_effect"],
  ["file.delete", "fs.delete", "side_effect", null, "destructive"],
  ["process.start", "process.start", "side_effect", null, "handle_create"],
  ["process.read", "process.read", "read_only", "stream", "handle_use"],
  ["process.interact", "process.interact", "side_effect", null, "handle_use"],
  ["process.list", "process.list", "read_only", "stream"],
  ["process.terminate", "process.terminate", "side_effect", null, "handle_close"],
  ["system.process.list", "system.process.list", "read_only", "stream"],
  ["system.process.kill", "system.process.kill", "side_effect", null, "destructive"],
  ["shell.session.open", "shell.session.open", "side_effect", null, "handle_create"],
  ["shell.session.read", "shell.session.read", "read_only", "stream", "handle_use"],
  ["shell.session.write", "shell.session.write", "side_effect", null, "handle_use"],
  ["shell.session.close", "shell.session.close", "side_effect", null, "handle_close"],
  ["shell.run", "shell.run", "side_effect"],
  ["window.list", "window.list", "read_only", "stream"],
  ["screenshot.capture", "screenshot.capture", "read_only"],
  ["uia.find", "uia.find", "read_only", "stream"],
  ["uia.invoke", "uia.invoke", "side_effect"],
  ["input.click", "input.click", "side_effect"],
  ["input.type", "input.type", "side_effect"],
  ["clipboard.read", "clipboard.read", "read_only"],
  ["clipboard.write", "clipboard.write", "side_effect"],
].map(([name, executorAction, effect, stream = null, handle = null]) => Object.freeze({
  name,
  executorAction,
  effect,
  streaming: stream === "stream",
  handleMode: handle?.startsWith("handle_") ? handle.slice(7) : null,
  destructive: handle === "destructive",
}));

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}

export function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
}

const compatibilityInternalTools = [
  ["compat.device.info", "device.info", "read_only"],
  ["compat.health.get", "health.get", "read_only"],
  ["compat.config.get", "config.get", "read_only"],
  ["compat.config.set", "config.set", "side_effect"],
  ["compat.identity.get", "identity.get", "read_only"],
  ["compat.metrics.get", "metrics.get", "read_only"],
  ["compat.audit.history", "audit.history", "read_only"],
  ["compat.file.read_many", "fs.read_many", "read_only"],
  ["compat.fs.mkdir", "fs.mkdir", "side_effect"],
  ["compat.fs.list", "fs.list", "read_only"],
  ["compat.fs.move", "fs.move", "side_effect"],
  ["compat.fs.stat", "fs.stat", "read_only"],
  ["compat.search.start", "search.start", "side_effect"],
  ["compat.search.read", "search.read", "read_only"],
  ["compat.search.stop", "search.stop", "side_effect"],
  ["compat.search.list", "search.list", "read_only"],
  ["compat.process.list_all", "process.list", "read_only"],
  ["compat.process.managed.list", "process.managed.list", "read_only"],
  ["compat.process.read_output", "process.read_output", "read_only"],
  ["compat.shell.session.write_stdin", "shell.session.write_stdin", "side_effect"],
  ["compat.file.write_pdf", "fs.write_pdf", "side_effect"],
  ["compat.device.shutdown", "device.shutdown", "side_effect", null, "destructive"],
].map(([name, executorAction, effect, stream = null, handle = null]) => Object.freeze({
  name,
  executorAction,
  effect,
  streaming: stream === "stream",
  handleMode: handle?.startsWith("handle_") ? handle.slice(7) : null,
  destructive: handle === "destructive",
  internalCompatibilityOnly: true,
}));

export const TOOL_REGISTRY = Object.freeze(Object.fromEntries(tools.map((tool) => [tool.name, tool])));
export const TOOL_REGISTRY_LIST = Object.freeze([...tools].sort((a, b) => a.name.localeCompare(b.name)));
export const COMPATIBILITY_INTERNAL_TOOL_REGISTRY = Object.freeze(
  Object.fromEntries(compatibilityInternalTools.map((tool) => [tool.name, tool])),
);
export const TOOL_REGISTRY_DIGEST = sha256({
  contract_version: NATIVE_TOOL_REGISTRY_V1,
  tools: TOOL_REGISTRY_LIST,
});

export function nativeCapabilityManifestV1({ executorCapabilities = null, limits = DEFAULT_NATIVE_LIMITS } = {}) {
  const executorDigest = executorCapabilities?.digest ?? executorCapabilities?.capabilities_digest ?? null;
  return {
    contract_version: NATIVE_TOOL_REGISTRY_V1,
    protocol_version: NATIVE_CONTROL_PROTOCOL_V1,
    registry_digest: TOOL_REGISTRY_DIGEST,
    limits: {
      max_page_size: limits.maxPageSize ?? DEFAULT_NATIVE_LIMITS.maxPageSize,
      max_body_bytes: limits.maxBodyBytes ?? DEFAULT_NATIVE_LIMITS.maxBodyBytes,
    },
    executor: executorCapabilities ? {
      contract_version: executorCapabilities.contract_version ?? null,
      digest: executorDigest,
      actions: Array.isArray(executorCapabilities.actions) ? [...executorCapabilities.actions].sort() : null,
    } : null,
    tools: TOOL_REGISTRY_LIST.map((tool) => ({
      name: tool.name,
      executor_action: tool.executorAction,
      effect: tool.effect,
      streaming: tool.streaming,
      process_handle: tool.handleMode,
      destructive: tool.destructive,
    })),
  };
}

export function assertCapabilityNegotiation(client, manifest) {
  if (!client || typeof client !== "object") {
    const error = new Error("Client capability manifest is required.");
    error.code = "CAPABILITY_NEGOTIATION_REQUIRED";
    throw error;
  }
  const expected = {
    protocol_version: manifest.protocol_version,
    registry_digest: manifest.registry_digest,
    executor_digest: manifest.executor?.digest ?? null,
  };
  const actual = {
    protocol_version: client.protocol_version ?? null,
    registry_digest: client.registry_digest ?? null,
    executor_digest: client.executor_digest ?? null,
  };
  if (actual.protocol_version !== expected.protocol_version ||
      actual.registry_digest !== expected.registry_digest ||
      actual.executor_digest !== expected.executor_digest) {
    const error = new Error("Capability/schema version mismatch.");
    error.code = "CAPABILITY_MISMATCH";
    error.expected = expected;
    error.actual = actual;
    throw error;
  }
  return true;
}

export function toolDefinition(name) {
  return TOOL_REGISTRY[name] ?? COMPATIBILITY_INTERNAL_TOOL_REGISTRY[name] ?? null;
}
