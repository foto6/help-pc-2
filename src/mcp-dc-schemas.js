import * as z from "zod/v4";
import { DC_COMPATIBILITY_REGISTRY_LIST } from "./dc-compatibility-registry.js";

const request_id = z.string().min(1).max(200).optional();
const path = z.string().min(1);
const strict = (shape) => z.object({ request_id, ...shape }).strict();

const schemas = {
  edit_block: strict({
    path,
    old_string: z.string().min(1),
    new_string: z.string(),
    expected_replacements: z.number().int().min(1).max(10000).optional(),
    encoding: z.string().min(1).optional(),
  }),
  read_file: strict({
    path,
    offset: z.number().int().optional(),
    length: z.number().int().min(1).max(1000).optional(),
  }),
  read_multiple_files: strict({
    paths: z.array(z.string().min(1)).min(1).max(64),
  }),
  write_file: strict({
    path,
    content: z.string(),
    mode: z.enum(["rewrite", "append"]).optional(),
  }),
  start_process: strict({
    command: z.string().min(1).max(32768),
    timeout_ms: z.number().int().min(0).max(600000).optional(),
    shell: z.string().min(1).optional(),
  }),
  read_process_output: strict({
    pid: z.number().int().positive(),
    timeout_ms: z.number().int().min(0).max(10000).optional(),
    offset: z.number().int().optional(),
    length: z.number().int().min(1).max(1000).optional(),
  }),
  list_sessions: strict({}),
  force_terminate: strict({
    pid: z.number().int().positive(),
  }),
};

const descriptions = {
  edit_block: "Desktop Commander-compatible exact block replacement through the native facade; replacement-count mismatch never partially mutates.",
  read_file: "Desktop Commander-compatible bounded text read with absolute line offset and negative-tail semantics.",
  read_multiple_files: "Desktop Commander-compatible deterministic true batch read with independent per-file success or error.",
  write_file: "Desktop Commander-compatible bounded rewrite or append through native at-most-once control.",
  start_process: "Desktop Commander-compatible managed process start returning a durable numeric pid backed by a native handle.",
  read_process_output: "Desktop Commander-compatible repeated bounded output reads for a durable process session.",
  list_sessions: "Desktop Commander-compatible listing of durable process sessions started through this compatibility surface.",
  force_terminate: "Desktop Commander-compatible termination of a durable process session.",
};

for (const tool of DC_COMPATIBILITY_REGISTRY_LIST) {
  if (!schemas[tool.name] || !descriptions[tool.name]) {
    throw new Error(`Missing MCP compatibility schema/description for ${tool.name}`);
  }
}

export function mcpDcToolSchema(name) {
  return schemas[name];
}

export function mcpDcToolDescription(name) {
  return descriptions[name];
}

export const MCP_DC_TOOL_SCHEMAS = Object.freeze(schemas);
export const MCP_DC_TOOL_DESCRIPTIONS = Object.freeze(descriptions);
