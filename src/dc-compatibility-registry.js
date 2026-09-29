import { sha256, NATIVE_CONTROL_PROTOCOL_V1 } from "./native-registry.js";

export const DC_COMPATIBILITY_REGISTRY_V1 = "pc.desktop_commander.compat_registry.v1";
export const DC_COMPATIBILITY_RESPONSE_V1 = "pc.desktop_commander.compat_response.v1";
export const DESKTOP_COMMANDER_REFERENCE_VERSION = "0.2.51";

const integer = (minimum = undefined, maximum = undefined) => ({
  type: "integer",
  ...(minimum === undefined ? {} : { minimum }),
  ...(maximum === undefined ? {} : { maximum }),
});
const number = (minimum = undefined, maximum = undefined) => ({
  type: "number",
  ...(minimum === undefined ? {} : { minimum }),
  ...(maximum === undefined ? {} : { maximum }),
});
const string = (minLength = undefined) => ({
  type: "string",
  ...(minLength === undefined ? {} : { minLength }),
});
const boolean = () => ({ type: "boolean" });
const deviceId = string(1);
const requestObject = (required, properties) => ({
  type: "object",
  additionalProperties: false,
  ...(required?.length ? { required } : {}),
  properties: {
    ...properties,
    deviceId,
  },
});

const definitions = [
  {
    name: "list_devices",
    effect: "read_only",
    native_tools: ["device.info"],
    capability_variants: [{ id: "pc_core", executor_actions: ["device.info"], native_tools: ["device.info"] }],
    input_schema: requestObject([], {}),
    semantics: "Returns the single native Executor-bound device identity available to this MCP host; no credentials or secrets are exposed.",
  },
  {
    name: "ping",
    effect: "read_only",
    native_tools: ["device.ping", "device.health"],
    capability_variants: [
      { id: "pc_core", executor_actions: ["health.get"], native_tools: ["device.ping"] },
      { id: "legacy_facade", executor_actions: ["system.health"], native_tools: ["device.health"] },
    ],
    input_schema: requestObject([], {}),
    semantics: "Connectivity/health probe through the native facade only.",
  },
  {
    name: "shutdown",
    effect: "side_effect",
    native_tools: ["agent.shutdown", "device.info"],
    capability_variants: [{
      id: "executor_bound",
      executor_actions: ["agent.shutdown", "device.info"],
      native_tools: ["agent.shutdown", "device.info"],
    }],
    input_schema: requestObject([], {}),
    semantics: "Fails closed unless the Executor explicitly publishes agent.shutdown; the control host never exits or shuts down the PC directly.",
  },
  {
    name: "get_config",
    effect: "read_only",
    native_tools: ["config.get", "device.get_config"],
    capability_variants: [
      { id: "pc_core", executor_actions: ["config.get"], native_tools: ["config.get"] },
      { id: "legacy_facade", executor_actions: ["system.config.get"], native_tools: ["device.get_config"] },
    ],
    input_schema: requestObject([], {}),
    semantics: "Reads the native Executor configuration contract and returns a recursively sanitized view.",
  },
  {
    name: "set_config_value",
    effect: "side_effect",
    native_tools: ["config.set", "device.set_config"],
    capability_variants: [
      { id: "pc_core", executor_actions: ["config.set"], native_tools: ["config.set"] },
      { id: "legacy_facade", executor_actions: ["system.config.set"], native_tools: ["device.set_config"] },
    ],
    input_schema: requestObject(["key", "value"], {
      key: string(1),
      value: {
        anyOf: [
          { type: "string" },
          { type: "number" },
          { type: "boolean" },
          { type: "array", items: { type: "string" } },
          { type: "null" },
        ],
      },
    }),
    semantics: "Fails closed unless the current Executor capability manifest publishes a mutable config action.",
  },
  {
    name: "read_file",
    effect: "read_only",
    native_tools: ["file.read", "file.read_bytes", "log.tail"],
    capability_variants: [
      {
        id: "pc_core_full",
        executor_actions: ["fs.read_text", "fs.read_bytes", "log.tail"],
        native_tools: ["file.read", "file.read_bytes", "log.tail"],
      },
      {
        id: "legacy_text",
        executor_actions: ["fs.read_text"],
        unless_executor_actions: ["fs.read_bytes", "log.tail"],
        native_tools: ["file.read"],
      },
    ],
    input_schema: requestObject(["path"], {
      path: string(1),
      isUrl: boolean(),
      offset: integer(),
      length: integer(1, 1000),
      sheet: string(1),
      range: string(1),
      options: { type: "object" },
    }),
    semantics: "Bounded text-file read with Desktop Commander 0-based offset and negative-tail behavior. URL/office/PDF format modes fail closed unless separately backed by Executor capabilities.",
  },
  {
    name: "read_multiple_files",
    effect: "read_only",
    native_tools: ["file.read_multiple"],
    capability_variants: [{ id: "true_batch", executor_actions: ["fs.read_multiple"], native_tools: ["file.read_multiple"] }],
    input_schema: requestObject(["paths"], {
      paths: { type: "array", minItems: 1, maxItems: 64, items: string(1) },
    }),
    semantics: "True Executor-bound batch only. Preserves input order and independent per-file success/error records; no composed fallback is advertised.",
  },
  {
    name: "write_file",
    effect: "side_effect",
    native_tools: ["file.write", "file.append"],
    capability_variants: [
      { id: "rewrite", executor_actions: ["fs.write_text"], native_tools: ["file.write"] },
      { id: "append", executor_actions: ["fs.append_text"], native_tools: ["file.append"] },
    ],
    input_schema: requestObject(["path", "content"], {
      path: string(1),
      content: string(),
      mode: { type: "string", enum: ["rewrite", "append"], default: "rewrite" },
    }),
    semantics: "Explicit bounded rewrite or append only; all mutation remains Executor-bound.",
  },
  {
    name: "write_pdf",
    effect: "side_effect",
    native_tools: ["pdf.write"],
    capability_variants: [{ id: "executor_pdf", executor_actions: ["pdf.write"], native_tools: ["pdf.write"] }],
    input_schema: requestObject(["path", "content"], {
      path: string(1),
      content: {
        anyOf: [
          { type: "string" },
          { type: "array", items: { type: "object" } },
        ],
      },
      outputPath: string(1),
      options: { type: "object" },
    }),
    semantics: "Available only when the live Executor publishes pdf.write. Older/partial manifests fail closed; Control/MCP never renders or edits PDF bytes itself.",
  },
  {
    name: "create_directory",
    effect: "side_effect",
    native_tools: ["file.create_dir"],
    capability_variants: [{ id: "default", executor_actions: ["fs.mkdir"], native_tools: ["file.create_dir"] }],
    input_schema: requestObject(["path"], { path: string(1) }),
    semantics: "Creates/ensures a directory through the native facade; recursive parent creation is requested at the Executor boundary.",
  },
  {
    name: "list_directory",
    effect: "read_only",
    native_tools: ["file.list"],
    capability_variants: [{ id: "default", executor_actions: ["fs.list"], native_tools: ["file.list"] }],
    input_schema: requestObject(["path"], {
      path: string(1),
      depth: integer(1, 32),
    }),
    semantics: "Bounded directory listing through the Executor. Depth is passed to the native facade and output remains bounded.",
  },
  {
    name: "move_file",
    effect: "side_effect",
    native_tools: ["file.move"],
    capability_variants: [{ id: "default", executor_actions: ["fs.move"], native_tools: ["file.move"] }],
    input_schema: requestObject(["source", "destination"], {
      source: string(1),
      destination: string(1),
    }),
    semantics: "Move/rename through the native facade with Executor path policy.",
  },
  {
    name: "start_search",
    effect: "side_effect",
    native_tools: ["search.start"],
    capability_variants: [{ id: "stateful_search_v1", executor_actions: ["search.start"], native_tools: ["search.start"] }],
    input_schema: requestObject(["path", "pattern"], {
      path: string(1),
      pattern: string(1),
      searchType: { type: "string", enum: ["files", "content"], default: "files" },
      literalSearch: boolean(),
      filePattern: string(1),
      ignoreCase: boolean(),
      earlyTermination: boolean(),
      includeHidden: boolean(),
      maxResults: integer(1, 100000),
      timeout_ms: integer(1, 600000),
      contextLines: integer(0, 100),
    }),
    semantics: "Creates a durable PC Core search.start handle. Unsupported filePattern/earlyTermination hints are rejected rather than silently ignored.",
  },
  {
    name: "get_more_search_results",
    effect: "read_only",
    native_tools: ["search.read"],
    capability_variants: [{ id: "stateful_search_v1", executor_actions: ["search.read"], native_tools: ["search.read"] }],
    input_schema: requestObject(["sessionId"], {
      sessionId: string(1),
      offset: integer(-1000000, 1000000),
      length: integer(1, 1000),
    }),
    semantics: "Reads a durable search handle by absolute result offset; negative offset tails and ignores length.",
  },
  {
    name: "stop_search",
    effect: "side_effect",
    native_tools: ["search.stop"],
    capability_variants: [{ id: "stateful_search_v1", executor_actions: ["search.stop"], native_tools: ["search.stop"] }],
    input_schema: requestObject(["sessionId"], { sessionId: string(1) }),
    semantics: "Cancels the addressed Executor search session; retained results remain owned/readable by PC Core retention rules.",
  },
  {
    name: "list_searches",
    effect: "read_only",
    native_tools: ["search.list"],
    capability_variants: [{ id: "stateful_search_v1", executor_actions: ["search.list"], native_tools: ["search.list"] }],
    input_schema: requestObject([], {}),
    semantics: "Lists active/recent PC Core search handles with type, pattern, status, runtime and result count.",
  },
  {
    name: "get_file_info",
    effect: "read_only",
    native_tools: ["file.info", "file.hash"],
    capability_variants: [{ id: "stat", executor_actions: ["fs.stat"], native_tools: ["file.info"] }],
    input_schema: requestObject(["path"], { path: string(1) }),
    semantics: "Returns Executor filesystem metadata. A SHA-256 is added only when fs.hash is separately available.",
  },
  {
    name: "edit_block",
    effect: "side_effect",
    native_tools: ["file.hash", "file.edit"],
    capability_variants: [{ id: "default", executor_actions: ["fs.hash", "fs.edit_text"], native_tools: ["file.hash", "file.edit"] }],
    input_schema: requestObject(["path", "old_string", "new_string"], {
      path: string(1),
      old_string: string(1),
      new_string: string(),
      expected_replacements: integer(1, 10000),
      encoding: string(1),
    }),
    semantics: "Atomic exact old/new replacement with Executor replacement-count and hash preconditions; no fallback write.",
  },
  {
    name: "start_process",
    effect: "side_effect",
    native_tools: ["shell.session.start", "process.start"],
    capability_variants: [
      {
        id: "pc_core_interactive_session",
        executor_actions: ["shell.session.start", "shell.session.read", "shell.session.write_stdin", "shell.session.terminate"],
        native_tools: ["shell.session.start"],
      },
      { id: "pc_core_process", executor_actions: ["process.start", "process.read_output", "process.terminate"], native_tools: ["process.start"] },
      {
        id: "legacy_facade",
        executor_actions: ["process.start"],
        unless_executor_actions: ["process.read_output", "shell.session.start"],
        native_tools: ["process.start"],
      },
    ],
    input_schema: requestObject(["timeout_ms", "command"], {
      timeout_ms: integer(0, 600000),
      verbose_timing: boolean(),
      command: string(1),
      shell: string(1),
    }),
    semantics: "Starts a managed interactive session when PC Core shell-session capabilities exist, otherwise a managed process; command text is parsed to bounded argv without host execution and the durable native handle remains authoritative.",
  },
  {
    name: "read_process_output",
    effect: "read_only",
    native_tools: ["shell.session.read", "process.read_output", "process.read"],
    capability_variants: [
      { id: "pc_core_session", executor_actions: ["shell.session.read"], native_tools: ["shell.session.read"] },
      { id: "pc_core_process", executor_actions: ["process.read_output"], native_tools: ["process.read_output"] },
      { id: "legacy_facade", executor_actions: ["process.read"], native_tools: ["process.read"] },
    ],
    input_schema: requestObject(["pid"], {
      pid: integer(1),
      timeout_ms: integer(0, 10000),
      offset: integer(),
      length: integer(1, 1000),
      verbose_timing: boolean(),
    }),
    semantics: "Repeated bounded reads preserve the durable native handle/cursor. PC Core process.read_output is preferred over the legacy facade read action.",
  },
  {
    name: "interact_with_process",
    effect: "side_effect",
    native_tools: ["shell.session.write_stdin", "process.interact"],
    capability_variants: [
      { id: "pc_core_session", executor_actions: ["shell.session.write_stdin"], native_tools: ["shell.session.write_stdin"] },
      { id: "legacy_facade", executor_actions: ["process.interact"], native_tools: ["process.interact"] },
    ],
    input_schema: requestObject(["input", "pid"], {
      wait_for_prompt: boolean(),
      input: string(),
      timeout_ms: integer(0, 10000),
      verbose_timing: boolean(),
      pid: integer(1),
    }),
    semantics: "Writes input only through an Executor-managed process handle. Prompt/timing hints are returned as unsupported metadata unless the native action implements them.",
  },
  {
    name: "force_terminate",
    effect: "side_effect",
    native_tools: ["shell.session.terminate", "process.terminate"],
    capability_variants: [
      { id: "pc_core_session", executor_actions: ["shell.session.terminate"], native_tools: ["shell.session.terminate"] },
      { id: "managed_process", executor_actions: ["process.terminate"], native_tools: ["process.terminate"] },
    ],
    input_schema: requestObject(["pid"], { pid: integer(1) }),
    semantics: "Terminates the durable native process handle associated with pid and marks the compatibility session terminated.",
  },
  {
    name: "list_sessions",
    effect: "read_only",
    native_tools: ["process.managed.list", "process.list"],
    capability_variants: [
      {
        id: "pc_core",
        executor_actions: ["process.managed.list", "process.status"],
        native_tools: ["process.managed.list", "process.status"],
      },
      {
        id: "legacy_facade",
        executor_actions: ["process.list"],
        unless_executor_actions: ["process.managed.list"],
        native_tools: ["process.list"],
      },
    ],
    input_schema: requestObject([], {}),
    semantics: "Lists durable managed sessions. PC Core process.managed.list is preferred; legacy process.list is used only when the managed-list capability is absent.",
  },
  {
    name: "list_processes",
    effect: "read_only",
    native_tools: ["process.list", "system.process.inspect", "system.process.list"],
    capability_variants: [
      {
        id: "pc_core",
        executor_actions: ["process.list", "process.inspect"],
        native_tools: ["process.list", "system.process.inspect"],
      },
      { id: "legacy_facade", executor_actions: ["system.process.list"], native_tools: ["system.process.list"] },
    ],
    input_schema: requestObject([], {}),
    semantics: "Bounded native system-process listing; no shell/tasklist implementation in Control/MCP.",
  },
  {
    name: "kill_process",
    effect: "side_effect",
    native_tools: ["process.list", "system.process.list", "system.process.kill"],
    capability_variants: [
      {
        id: "pc_core_safe_identity",
        // Python PC Core's native "process.list" is MANAGED process handles,
        // not OS-wide pid-filtered listing. The actual OS parity action
        // "process.list" is reached through native "system.process.list".
        executor_actions: ["process.list", "system.process.kill"],
        native_tools: ["system.process.list", "system.process.kill"],
      },
      {
        id: "legacy_safe_identity",
        executor_actions: ["system.process.list", "system.process.kill"],
        native_tools: ["system.process.list", "system.process.kill"],
      },
    ],
    input_schema: requestObject(["pid"], { pid: integer(1) }),
    semantics: "Looks up executable identity through a read-only native process listing, then passes pid plus expected executable name to Executor system.process.kill.",
  },
  {
    name: "who_am_i",
    effect: "read_only",
    native_tools: ["identity.who_am_i"],
    capability_variants: [{ id: "sanitized_identity", executor_actions: ["identity.who_am_i"], native_tools: ["identity.who_am_i"] }],
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    semantics: "Available only when the Executor publishes a sanitized identity.who_am_i action; never synthesized from host OS/account state.",
  },
  {
    name: "get_usage_stats",
    effect: "read_only",
    native_tools: ["diagnostics.usage_stats"],
    capability_variants: [{ id: "sanitized_usage", executor_actions: ["diagnostics.usage_stats"], native_tools: ["diagnostics.usage_stats"] }],
    input_schema: requestObject([], {}),
    semantics: "Available only when the Executor publishes sanitized diagnostics.usage_stats; Control/MCP reports native action/outcome metrics and does not infer subscription or remote quota data.",
  },
  {
    name: "get_recent_tool_calls",
    effect: "read_only",
    native_tools: ["audit.recent"],
    capability_variants: [{ id: "sanitized_audit", executor_actions: ["diagnostics.recent_tool_calls"], native_tools: ["audit.recent"] }],
    input_schema: requestObject([], {
      maxResults: integer(1, 1000),
      toolName: string(1),
      since: { type: "string", format: "date-time" },
    }),
    semantics: "Available only when the Executor publishes sanitized diagnostics.recent_tool_calls records; secrets/raw sensitive payloads are not reconstructed by Control/MCP.",
  },
].map((value) => Object.freeze({
  ...value,
  desktop_commander_version: DESKTOP_COMMANDER_REFERENCE_VERSION,
  native_protocol: NATIVE_CONTROL_PROTOCOL_V1,
  capability_variants: Object.freeze(value.capability_variants.map((variant) => Object.freeze({
    ...variant,
    executor_actions: Object.freeze([...variant.executor_actions]),
    native_tools: Object.freeze([...(variant.native_tools ?? [])]),
    unless_executor_actions: Object.freeze([...(variant.unless_executor_actions ?? [])]),
  }))),
  native_tools: Object.freeze([...value.native_tools]),
}));

export const DC_VENDOR_NON_EQUIVALENTS = Object.freeze([
  Object.freeze({
    name: "get_prompts",
    reason: "Desktop Commander vendor onboarding/prompt injection is not an Executor capability and is intentionally not exposed.",
  }),
  Object.freeze({
    name: "give_feedback_to_desktop_commander",
    reason: "Desktop Commander vendor feedback/browser workflow is not a native PC control capability and is intentionally not exposed.",
  }),
]);

export const DC_COMPATIBILITY_REGISTRY_LIST = Object.freeze(
  [...definitions].sort((a, b) => a.name.localeCompare(b.name)),
);
export const DC_COMPATIBILITY_REGISTRY = Object.freeze(
  Object.fromEntries(DC_COMPATIBILITY_REGISTRY_LIST.map((tool) => [tool.name, tool])),
);
export const DC_COMPATIBILITY_REGISTRY_DIGEST = sha256({
  contract_version: DC_COMPATIBILITY_REGISTRY_V1,
  desktop_commander_version: DESKTOP_COMMANDER_REFERENCE_VERSION,
  native_protocol: NATIVE_CONTROL_PROTOCOL_V1,
  tools: DC_COMPATIBILITY_REGISTRY_LIST,
  vendor_non_equivalents: DC_VENDOR_NON_EQUIVALENTS,
});

export function desktopCommanderToolDefinition(name) {
  return DC_COMPATIBILITY_REGISTRY[name] ?? null;
}

export function desktopCommanderCompatibilityManifestV1({ nativeManifest = null } = {}) {
  const advertised = new Set(Array.isArray(nativeManifest?.executor?.actions) ? nativeManifest.executor.actions : []);
  return {
    contract_version: DC_COMPATIBILITY_REGISTRY_V1,
    desktop_commander_version: DESKTOP_COMMANDER_REFERENCE_VERSION,
    native_protocol: NATIVE_CONTROL_PROTOCOL_V1,
    registry_digest: DC_COMPATIBILITY_REGISTRY_DIGEST,
    native_registry_digest: nativeManifest?.registry_digest ?? null,
    executor_digest: nativeManifest?.executor?.digest ?? null,
    vendor_non_equivalents: DC_VENDOR_NON_EQUIVALENTS.map((entry) => ({ ...entry })),
    tools: DC_COMPATIBILITY_REGISTRY_LIST.map((tool) => {
      const variants = tool.capability_variants.map((variant) => {
        const missing = variant.executor_actions.filter((action) => !advertised.has(action));
        const blockedBy = variant.unless_executor_actions.filter((action) => advertised.has(action));
        return {
          id: variant.id,
          executor_actions: [...variant.executor_actions],
          native_tools: [...variant.native_tools],
          available: missing.length === 0 && blockedBy.length === 0,
          missing_executor_actions: missing,
          blocked_by_executor_actions: blockedBy,
        };
      });
      const selected = variants.find((variant) => variant.available) ?? null;
      return {
        name: tool.name,
        desktop_commander_version: tool.desktop_commander_version,
        effect: tool.effect,
        native_tools: [...tool.native_tools],
        input_schema: structuredClone(tool.input_schema),
        semantics: tool.semantics,
        available: Boolean(selected),
        selected_variant: selected?.id ?? null,
        availability_reason: selected
          ? "available"
          : variants.length
            ? "required_native_capability_unavailable"
            : "no_executor_equivalent",
        capability_variants: variants,
      };
    }),
  };
}
