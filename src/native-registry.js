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
  ["device.info", "device.info", "read_only"],
  ["device.ping", "health.get", "read_only"],
  ["agent.shutdown", "agent.shutdown", "side_effect"],
  ["config.get", "config.get", "read_only"],
  ["config.set", "config.set", "side_effect"],
  ["identity.who_am_i", "identity.who_am_i", "read_only"],
  ["device.identity", "identity.who_am_i", "read_only"],
  ["usage.stats", "diagnostics.usage_stats", "read_only"],
  ["diagnostics.usage_stats", "diagnostics.usage_stats", "read_only"],
  ["audit.recent", "diagnostics.recent_tool_calls", "read_only"],
  ["diagnostics.recent_tool_calls", "diagnostics.recent_tool_calls", "read_only"],
  ["file.list", "fs.list", "read_only", "stream"],
  ["file.info", "fs.stat", "read_only"],
  ["file.read", "fs.read_text", "read_only", "stream"],
  ["file.read_multiple", "fs.read_multiple", "read_only"],
  ["file.read_bytes", "fs.read_bytes", "read_only", "stream"],
  ["log.tail", "log.tail", "read_only", "stream"],
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
  ["pdf.write", "pdf.write", "side_effect"],
  ["search.start", "search.start", "side_effect"],
  ["search.read", "search.read", "read_only"],
  ["search.list", "search.list", "read_only"],
  ["search.stop", "search.stop", "side_effect"],
  ["process.start", "process.start", "side_effect", null, "handle_create"],
  ["process.read_output", "process.read_output", "read_only", null, "handle_use"],
  ["process.status", "process.status", "read_only", null, "handle_use"],
  ["process.managed.list", "process.managed.list", "read_only"],
  ["process.read", "process.read", "read_only", "stream", "handle_use"],
  ["process.interact", "process.interact", "side_effect", null, "handle_use"],
  ["process.list", "process.list", "read_only", "stream"],
  ["system.process.inspect", "process.inspect", "read_only"],
  ["process.terminate", "process.terminate", "side_effect", null, "handle_close"],
  ["system.process.list", "system.process.list", "read_only", "stream"],
  ["system.process.kill", "system.process.kill", "side_effect", null, "destructive"],
  ["shell.session.open", "shell.session.open", "side_effect", null, "handle_create"],
  ["shell.session.start", "shell.session.start", "side_effect", null, "handle_create"],
  ["shell.session.read", "shell.session.read", "read_only", "stream", "handle_use"],
  ["shell.session.write", "shell.session.write", "side_effect", null, "handle_use"],
  ["shell.session.write_stdin", "shell.session.write_stdin", "side_effect", null, "handle_use"],
  ["shell.session.close", "shell.session.close", "side_effect", null, "handle_close"],
  ["shell.session.terminate", "shell.session.terminate", "side_effect", null, "handle_close"],
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

export const TOOL_REGISTRY = Object.freeze(Object.fromEntries(tools.map((tool) => [tool.name, tool])));
export const TOOL_REGISTRY_LIST = Object.freeze([...tools].sort((a, b) => a.name.localeCompare(b.name)));
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
  return TOOL_REGISTRY[name] ?? null;
}
