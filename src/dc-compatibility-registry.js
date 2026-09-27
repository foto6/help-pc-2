import { sha256, NATIVE_CONTROL_PROTOCOL_V1 } from "./native-registry.js";

export const DC_COMPATIBILITY_REGISTRY_V1 = "pc.desktop_commander.compat_registry.v1";
export const DC_COMPATIBILITY_RESPONSE_V1 = "pc.desktop_commander.compat_response.v1";

const integer = (minimum = undefined, maximum = undefined) => ({
  type: "integer",
  ...(minimum === undefined ? {} : { minimum }),
  ...(maximum === undefined ? {} : { maximum }),
});
const string = (minLength = undefined) => ({
  type: "string",
  ...(minLength === undefined ? {} : { minLength }),
});

const definitions = [
  {
    name: "edit_block",
    effect: "side_effect",
    native_tools: ["file.hash", "file.edit"],
    capability_variants: [{ id: "default", executor_actions: ["fs.hash", "fs.edit_text"] }],
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["path", "old_string", "new_string"],
      properties: {
        path: string(1),
        old_string: string(1),
        new_string: string(),
        expected_replacements: integer(1, 10000),
        encoding: string(1),
      },
    },
    semantics: "Atomic exact old/new replacement. A hash precondition is obtained through the native facade and replacement-count mismatch must not mutate the target.",
  },
  {
    name: "read_file",
    effect: "read_only",
    native_tools: ["file.read"],
    capability_variants: [{ id: "default", executor_actions: ["fs.read_text"] }],
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: string(1),
        offset: integer(),
        length: integer(1, 1000),
      },
    },
    semantics: "Line-based 0-origin offset/length. Negative offset requests tail lines and ignores length.",
  },
  {
    name: "read_multiple_files",
    effect: "read_only",
    native_tools: ["file.read"],
    capability_variants: [{ id: "default", executor_actions: ["fs.read_text"] }],
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["paths"],
      properties: {
        paths: { type: "array", minItems: 1, maxItems: 64, items: string(1) },
      },
    },
    semantics: "Batch read preserving input order; each path returns independent success or normalized error.",
  },
  {
    name: "write_file",
    effect: "side_effect",
    native_tools: ["file.write", "file.append"],
    capability_variants: [
      { id: "rewrite", executor_actions: ["fs.write_text"] },
      { id: "append", executor_actions: ["fs.append_text"] },
    ],
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["path", "content"],
      properties: {
        path: string(1),
        content: string(),
        mode: { type: "string", enum: ["rewrite", "append"], default: "rewrite" },
      },
    },
    semantics: "Explicit rewrite or append only; payload is bounded before native dispatch.",
  },
  {
    name: "start_process",
    effect: "side_effect",
    native_tools: ["process.start"],
    capability_variants: [{ id: "default", executor_actions: ["process.start"] }],
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["command"],
      properties: {
        command: string(1),
        timeout_ms: integer(0, 600000),
        shell: string(1),
      },
    },
    semantics: "Starts a managed native process and records the facade handle against the returned numeric pid.",
  },
  {
    name: "read_process_output",
    effect: "read_only",
    native_tools: ["process.read"],
    capability_variants: [{ id: "default", executor_actions: ["process.read"] }],
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["pid"],
      properties: {
        pid: integer(1),
        timeout_ms: integer(0, 10000),
        offset: integer(),
        length: integer(1, 1000),
      },
    },
    semantics: "Supports new-output reads, absolute line reads, and negative-tail reads while preserving the durable native process handle.",
  },
  {
    name: "list_sessions",
    effect: "read_only",
    native_tools: ["process.list"],
    capability_variants: [{ id: "default", executor_actions: ["process.list"] }],
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    semantics: "Lists compatibility-started durable sessions and refreshes running state from the native process view when available.",
  },
  {
    name: "force_terminate",
    effect: "side_effect",
    native_tools: ["process.terminate"],
    capability_variants: [{ id: "default", executor_actions: ["process.terminate"] }],
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["pid"],
      properties: { pid: integer(1) },
    },
    semantics: "Terminates the durable native process handle associated with pid and marks the compatibility session terminated.",
  },
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
    tools: DC_COMPATIBILITY_REGISTRY_LIST.map((tool) => {
      const variants = tool.capability_variants.map((variant) => {
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
        available: variants.some((variant) => variant.available),
        capability_variants: variants,
      };
    }),
  };
}
