import * as z from "zod/v4";
import { DC_COMPATIBILITY_REGISTRY_LIST } from "./dc-compatibility-registry.js";

const request_id = z.string().min(1).max(200).optional();
const deviceId = z.string().min(1).optional();
const path = z.string().min(1);
const strict = (shape = {}) => z.object({ request_id, ...shape }).strict();
const local = (shape = {}) => strict({ ...shape, deviceId });

const writePdfInsert = z.object({
  type: z.literal("insert"),
  pageIndex: z.number().int().min(0),
  markdown: z.string().optional(),
  sourcePdfPath: z.string().min(1).optional(),
  pdfOptions: z.record(z.string(), z.unknown()).optional(),
}).strict();
const writePdfDelete = z.object({
  type: z.literal("delete"),
  pageIndexes: z.array(z.number().int().min(0)).min(1),
}).strict();

const schemas = {
  list_devices: strict({}),
  ping: local({}),
  get_config: local({}),
  set_config_value: local({
    key: z.string().min(1),
    value: z.union([
      z.string(), z.number(), z.boolean(), z.array(z.string()), z.null(),
    ]),
  }),
  read_file: local({
    path,
    offset: z.number().int().optional(),
    length: z.number().int().min(1).max(1000).optional(),
  }),
  read_multiple_files: local({
    paths: z.array(z.string().min(1)).min(1).max(64),
  }),
  write_file: local({
    path,
    content: z.string(),
    mode: z.enum(["rewrite", "append"]).optional(),
  }),
  write_pdf: local({
    path,
    content: z.union([z.string(), z.array(z.union([writePdfInsert, writePdfDelete]))]),
    outputPath: z.string().min(1).optional(),
    options: z.record(z.string(), z.unknown()).optional(),
  }),
  edit_block: local({
    path,
    old_string: z.string().min(1),
    new_string: z.string(),
    expected_replacements: z.number().int().min(1).max(10000).optional(),
    encoding: z.string().min(1).optional(),
  }),
  create_directory: local({ path }),
  list_directory: local({
    path,
    depth: z.number().int().min(1).max(32).optional(),
  }),
  move_file: local({
    source: z.string().min(1),
    destination: z.string().min(1),
  }),
  get_file_info: local({ path }),
  start_search: local({
    path,
    pattern: z.string().min(1),
    searchType: z.enum(["files", "content"]).optional(),
    literalSearch: z.boolean().optional(),
    filePattern: z.string().min(1).optional(),
    ignoreCase: z.boolean().optional(),
    includeHidden: z.boolean().optional(),
    contextLines: z.number().int().min(0).max(100).optional(),
    maxResults: z.number().int().min(1).max(100000).optional(),
    timeout_ms: z.number().int().min(1).max(600000).optional(),
    earlyTermination: z.boolean().optional(),
  }),
  get_more_search_results: local({
    sessionId: z.string().min(1),
    offset: z.number().int().min(-1000000).max(1000000).optional(),
    length: z.number().int().min(1).max(1000).optional(),
  }),
  stop_search: local({ sessionId: z.string().min(1) }),
  list_searches: local({}),
  start_process: local({
    command: z.string().min(1).max(32768),
    timeout_ms: z.number().int().min(0).max(600000).optional(),
    shell: z.string().min(1).optional(),
  }),
  read_process_output: local({
    pid: z.number().int().positive(),
    timeout_ms: z.number().int().min(0).max(10000).optional(),
    offset: z.number().int().optional(),
    length: z.number().int().min(1).max(1000).optional(),
    verbose_timing: z.boolean().optional(),
  }),
  interact_with_process: local({
    pid: z.number().int().positive(),
    input: z.string(),
    timeout_ms: z.number().int().min(0).max(10000).optional(),
    wait_for_prompt: z.boolean().optional(),
    verbose_timing: z.boolean().optional(),
  }),
  list_sessions: local({}),
  force_terminate: local({ pid: z.number().int().positive() }),
  list_processes: local({}),
  kill_process: local({ pid: z.number().int().positive() }),
  shutdown: local({}),
  who_am_i: strict({}),
  get_usage_stats: local({}),
  get_recent_tool_calls: local({
    maxResults: z.number().int().min(1).max(1000).optional(),
    toolName: z.string().min(1).optional(),
    since: z.string().datetime({ offset: true }).optional(),
  }),
};
const descriptions = {
  list_devices: "Desktop Commander-compatible local-device discovery through the pinned native provider.",
  ping: "Desktop Commander-compatible health/connectivity probe through NativeFacade.",
  get_config: "Desktop Commander-compatible read-only native configuration metadata.",
  set_config_value: "Desktop Commander-compatible config mutation only when the provider explicitly advertises config.set.",
  read_file: "Desktop Commander-compatible bounded text read with absolute line offset and negative-tail semantics.",
  read_multiple_files: "Desktop Commander-compatible true batch via fs.read_many when advertised, with bounded legacy read fallback.",
  write_file: "Desktop Commander-compatible bounded rewrite or append through native at-most-once control.",
  write_pdf: "Desktop Commander-compatible PDF operation only when the provider advertises fs.write_pdf.",
  edit_block: "Desktop Commander-compatible exact block replacement through the native facade; replacement-count mismatch never partially mutates.",
  create_directory: "Desktop Commander-compatible directory creation through the native filesystem provider.",
  list_directory: "Desktop Commander-compatible bounded directory listing.",
  move_file: "Desktop Commander-compatible move or rename through native policy.",
  get_file_info: "Desktop Commander-compatible file metadata through native stat.",
  start_search: "Desktop Commander-compatible stateful search start when search.start is available.",
  get_more_search_results: "Desktop Commander-compatible stateful search result pagination.",
  stop_search: "Desktop Commander-compatible cancellation of one search session.",
  list_searches: "Desktop Commander-compatible listing of active/recent native search sessions.",
  start_process: "Desktop Commander-compatible managed process start returning a durable numeric pid backed by a native handle.",
  read_process_output: "Desktop Commander-compatible repeated bounded output reads for a durable process session.",
  interact_with_process: "Desktop Commander-compatible managed session input via PC-Core shell.session.write_stdin, with legacy process.interact fallback.",
  list_sessions: "Desktop Commander-compatible listing of durable process sessions started through this compatibility surface.",
  force_terminate: "Desktop Commander-compatible termination of a durable process session.",
  list_processes: "Desktop Commander-compatible read-only system process inventory.",
  kill_process: "Desktop Commander-compatible provider-governed process termination.",
  shutdown: "Desktop Commander-compatible graceful device-agent shutdown only when device.shutdown is explicitly available.",
  who_am_i: "Semantic equivalent using sanitized PC-Core identity.get, not vendor account identity.",
  get_usage_stats: "Semantic equivalent using sanitized PC-Core metrics.get, not vendor billing telemetry.",
  get_recent_tool_calls: "Semantic equivalent using sanitized PC-Core audit.history when available; otherwise explicitly unavailable.",
};
for (const tool of DC_COMPATIBILITY_REGISTRY_LIST) {
  if (!schemas[tool.name] || !descriptions[tool.name]) {
    throw new Error(`Missing MCP compatibility schema/description for ${tool.name}`);
  }
}
for (const name of Object.keys(schemas)) {
  if (!DC_COMPATIBILITY_REGISTRY_LIST.some((tool) => tool.name === name)) {
    throw new Error(`MCP compatibility schema exists for unknown tool ${name}`);
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
