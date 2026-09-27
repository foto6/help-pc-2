import { sha256, NATIVE_CONTROL_PROTOCOL_V1 } from "./native-registry.js";

export const DC_COMPATIBILITY_REGISTRY_V1 = "pc.desktop_commander.compat_registry.v1";
export const DC_COMPATIBILITY_RESPONSE_V1 = "pc.desktop_commander.compat_response.v1";
export const DC_VENDOR_SPECIFIC_EXCLUSIONS = Object.freeze([
  "get_prompts",
  "give_feedback_to_desktop_commander",
]);

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
const bool = () => ({ type: "boolean" });
const deviceId = string(1);
const object = (properties = {}, required = []) => ({
  type: "object",
  additionalProperties: false,
  ...(required.length ? { required } : {}),
  properties,
});
const withDevice = (properties = {}, required = []) =>
  object({ ...properties, deviceId }, required);

function variants(...items) {
  return items.map(([id, executor_actions]) => ({ id, executor_actions }));
}
function def(name, effect, native_tools, capability_variants, input_schema, semantics) {
  return { name, effect, native_tools, capability_variants, input_schema, semantics };
}

const definitions = [
  def("list_devices", "read_only", ["compat.device.info"],
    variants(["local_device", ["device.info"]]), object(),
    "Returns the single authorized local native device identity; remote device brokerage is intentionally not synthesized."),
  def("ping", "read_only", ["compat.health.get"],
    variants(["pc_core", ["health.get"]]),
    withDevice(),
    "Connectivity/health probe through the native provider; no synthetic remote latency is invented."),
  def("get_config", "read_only", ["compat.config.get"],
    variants(["pc_core", ["config.get"]]),
    withDevice(),
    "Reads immutable native safety/configuration metadata from the provider."),
  def("set_config_value", "side_effect", ["compat.config.set"],
    variants(["future_pc_core", ["config.set"]]),
    withDevice({
      key: string(1),
      value: {
        oneOf: [
          string(), number(), bool(), { type: "array", items: string() }, { type: "null" },
        ],
      },
    }, ["key", "value"]),
    "Available only when the provider explicitly advertises mutable config; otherwise CAPABILITY_UNAVAILABLE."),
  def("read_file", "read_only", ["file.read"],
    variants(["default", ["fs.read_text"]]),
    withDevice({ path: string(1), offset: integer(), length: integer(1, 1000) }, ["path"]),
    "Line-based 0-origin offset/length. Negative offset requests tail lines and ignores length."),
  def("read_multiple_files", "read_only", ["compat.file.read_many", "file.read"],
    variants(["native_batch", ["fs.read_many"]], ["legacy", ["fs.read_text"]]),
    withDevice({ paths: { type: "array", minItems: 1, maxItems: 64, items: string(1) } }, ["paths"]),
    "Uses the PC-Core fs.read_many primitive when advertised, with the legacy facade read loop retained only as an explicit compatibility fallback."),
  def("write_file", "side_effect", ["file.write", "file.append"],
    variants(["rewrite", ["fs.write_text"]], ["append", ["fs.append_text"]]),
    withDevice({
      path: string(1), content: string(),
      mode: { type: "string", enum: ["rewrite", "append"], default: "rewrite" },
    }, ["path", "content"]),
    "Explicit rewrite or append only; payload is bounded before native dispatch."),
  def("write_pdf", "side_effect", ["compat.file.write_pdf"],
    variants(["future_pc_core", ["fs.write_pdf"]]),
    withDevice({
      path: string(1),
      content: {
        oneOf: [
          string(),
          {
            type: "array",
            items: {
              oneOf: [
                object({
                  type: { type: "string", enum: ["insert"] },
                  pageIndex: integer(0),
                  markdown: string(),
                  sourcePdfPath: string(1),
                  pdfOptions: { type: "object" },
                }, ["type", "pageIndex"]),
                object({
                  type: { type: "string", enum: ["delete"] },
                  pageIndexes: { type: "array", minItems: 1, items: integer(0) },
                }, ["type", "pageIndexes"]),
              ],
            },
          },
        ],
      },
      outputPath: string(1),
      options: { type: "object" },
    }, ["path", "content"]),
    "PDF creation/modification is exposed only when the native provider advertises fs.write_pdf."),
  def("edit_block", "side_effect", ["file.hash", "file.edit"],
    variants(["default", ["fs.hash", "fs.edit_text"]]),
    withDevice({
      path: string(1), old_string: string(1), new_string: string(),
      expected_replacements: integer(1, 10000), encoding: string(1),
    }, ["path", "old_string", "new_string"]),
    "Atomic exact old/new replacement with a native hash precondition and exact replacement count."),
  def("create_directory", "side_effect", ["compat.fs.mkdir"],
    variants(["pc_core", ["fs.mkdir"]]),
    withDevice({ path: string(1) }, ["path"]),
    "Creates the requested directory through the PC-Core fs.mkdir action and NativeFacade only."),
  def("list_directory", "read_only", ["compat.fs.list"],
    variants(["pc_core", ["fs.list"]]),
    withDevice({ path: string(1), depth: integer(1, 32) }, ["path"]),
    "Bounded directory listing through PC-Core fs.list; the provider remains authoritative for traversal semantics."),
  def("move_file", "side_effect", ["compat.fs.move"],
    variants(["pc_core", ["fs.move"]]),
    withDevice({ source: string(1), destination: string(1) }, ["source", "destination"]),
    "Moves or renames one native filesystem object through PC-Core fs.move."),
  def("get_file_info", "read_only", ["compat.fs.stat"],
    variants(["pc_core", ["fs.stat"]]),
    withDevice({ path: string(1) }, ["path"]),
    "Returns provider file/directory metadata through PC-Core fs.stat."),
  def("start_search", "side_effect", ["compat.search.start"],
    variants(["stateful", ["search.start"]]),
    withDevice({
      path: string(1), pattern: string(1),
      searchType: { type: "string", enum: ["files", "content"], default: "files" },
      literalSearch: bool(), filePattern: string(1), ignoreCase: bool(),
      includeHidden: bool(), contextLines: integer(0, 100),
      maxResults: integer(1, 100000), timeout_ms: integer(1, 600000),
      earlyTermination: bool(),
    }, ["path", "pattern"]),
    "Starts a generation-scoped stateful native search only when search.start is advertised."),
  def("get_more_search_results", "read_only", ["compat.search.read"],
    variants(["stateful", ["search.read"]]),
    withDevice({ sessionId: string(1), offset: integer(-1000000, 1000000), length: integer(1, 1000) }, ["sessionId"]),
    "Reads an existing native search by absolute or negative-tail result offset."),
  def("stop_search", "side_effect", ["compat.search.stop"],
    variants(["stateful", ["search.stop"]]),
    withDevice({ sessionId: string(1) }, ["sessionId"]),
    "Stops only the addressed native search session."),
  def("list_searches", "read_only", ["compat.search.list"],
    variants(["stateful", ["search.list"]]),
    withDevice(),
    "Lists active/recent search sessions from the native provider."),
  def("start_process", "side_effect", ["process.start"],
    variants(["default", ["process.start"]]),
    withDevice({ command: string(1), timeout_ms: integer(0, 600000), shell: string(1) }, ["command"]),
    "Starts a managed native process and records the facade handle against the returned numeric pid."),
  def("read_process_output", "read_only", ["process.read", "compat.process.read_output"],
    variants(["pc_core", ["process.read_output"]], ["control", ["process.read"]]),
    withDevice({
      pid: integer(1), timeout_ms: integer(0, 10000),
      offset: integer(), length: integer(1, 1000), verbose_timing: bool(),
    }, ["pid"]),
    "Supports repeated new-output, absolute, and negative-tail reads for a durable process handle."),
  def("interact_with_process", "side_effect", ["compat.shell.session.write_stdin", "process.interact"],
    variants(["pc_core", ["shell.session.write_stdin"]], ["control", ["process.interact"]]),
    withDevice({
      pid: integer(1), input: string(), timeout_ms: integer(0, 10000),
      wait_for_prompt: bool(), verbose_timing: bool(),
    }, ["pid", "input"]),
    "Sends input only through a native managed process handle when process.interact is advertised."),
  def("list_sessions", "read_only", ["compat.process.managed.list", "process.list"],
    variants(["pc_core", ["process.managed.list"]], ["control", ["process.list"]]),
    withDevice(),
    "Lists compatibility-started durable sessions and refreshes native running state."),
  def("force_terminate", "side_effect", ["process.terminate"],
    variants(["default", ["process.terminate"]]),
    withDevice({ pid: integer(1) }, ["pid"]),
    "Terminates the durable native process handle associated with pid."),
  def("list_processes", "read_only", ["compat.process.list_all", "system.process.list"],
    variants(["pc_core", ["process.list"]], ["control", ["system.process.list"]]),
    withDevice(),
    "Lists operating-system processes through the provider's read-only process inventory."),
  def("kill_process", "side_effect", ["system.process.kill", "compat.process.list_all"],
    variants(["pc_core", ["process.list", "system.process.kill"]], ["control", ["system.process.kill"]]),
    withDevice({ pid: integer(1) }, ["pid"]),
    "Requests provider-governed process termination; provider identity/safety checks remain authoritative."),
  def("shutdown", "side_effect", ["compat.device.shutdown"],
    variants(["future_pc_core", ["device.shutdown"]]),
    withDevice(),
    "Graceful device-agent shutdown is unavailable unless the provider explicitly advertises device.shutdown."),
  def("who_am_i", "read_only", ["compat.identity.get"],
    variants(["pc_core_identity", ["identity.get"]]),
    object(),
    "Semantic equivalent: returns sanitized controller/device/session identity from PC-Core identity.get, never vendor account secrets."),
  def("get_usage_stats", "read_only", ["compat.metrics.get"],
    variants(["pc_core_metrics", ["metrics.get"]]),
    withDevice(),
    "Semantic equivalent: returns sanitized native operation metrics; vendor connector billing telemetry is not synthesized."),
  def("get_recent_tool_calls", "read_only", ["compat.audit.history"],
    variants(["pc_core_audit", ["audit.history"]]),
    withDevice({
      maxResults: integer(1, 1000), toolName: string(1),
      since: { type: "string", format: "date-time" },
    }),
    "Semantic equivalent: sanitized native audit history when audit.history is explicitly advertised; otherwise unavailable."),
].map((value) => Object.freeze({
  ...value,
  native_protocol: NATIVE_CONTROL_PROTOCOL_V1,
  capability_variants: Object.freeze(value.capability_variants.map((variant) => Object.freeze({
    ...variant,
    executor_actions: Object.freeze([...variant.executor_actions]),
  }))),
  native_tools: Object.freeze([...value.native_tools]),
}));

export const DC_COMPATIBILITY_REGISTRY_LIST = Object.freeze(
  [...definitions].sort((a, b) => a.name.localeCompare(b.name)),
);
export const DC_COMPATIBILITY_REGISTRY = Object.freeze(
  Object.fromEntries(DC_COMPATIBILITY_REGISTRY_LIST.map((tool) => [tool.name, tool])),
);
export const DC_COMPATIBILITY_REGISTRY_DIGEST = sha256({
  contract_version: DC_COMPATIBILITY_REGISTRY_V1,
  native_protocol: NATIVE_CONTROL_PROTOCOL_V1,
  tools: DC_COMPATIBILITY_REGISTRY_LIST,
  vendor_specific_exclusions: DC_VENDOR_SPECIFIC_EXCLUSIONS,
});

export function desktopCommanderToolDefinition(name) {
  return DC_COMPATIBILITY_REGISTRY[name] ?? null;
}

export function desktopCommanderCompatibilityManifestV1({ nativeManifest = null } = {}) {
  const advertised = new Set(Array.isArray(nativeManifest?.executor?.actions) ? nativeManifest.executor.actions : []);
  return {
    contract_version: DC_COMPATIBILITY_REGISTRY_V1,
    native_protocol: NATIVE_CONTROL_PROTOCOL_V1,
    registry_digest: DC_COMPATIBILITY_REGISTRY_DIGEST,
    native_registry_digest: nativeManifest?.registry_digest ?? null,
    executor_digest: nativeManifest?.executor?.digest ?? null,
    vendor_specific_exclusions: [...DC_VENDOR_SPECIFIC_EXCLUSIONS],
    tools: DC_COMPATIBILITY_REGISTRY_LIST.map((tool) => {
      const capability_variants = tool.capability_variants.map((variant) => {
        const missing = variant.executor_actions.filter((action) => !advertised.has(action));
        return {
          id: variant.id,
          executor_actions: [...variant.executor_actions],
          available: missing.length === 0,
          missing_executor_actions: missing,
        };
      });
      return {
        name: tool.name,
        effect: tool.effect,
        native_tools: [...tool.native_tools],
        input_schema: structuredClone(tool.input_schema),
        semantics: tool.semantics,
        available: capability_variants.some((variant) => variant.available),
        capability_variants,
      };
    }),
  };
}
