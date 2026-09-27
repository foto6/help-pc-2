import * as z from "zod/v4";
import { TOOL_REGISTRY_LIST } from "./native-registry.js";
import { DC_COMPATIBILITY_REGISTRY_LIST } from "./dc-compatibility-registry.js";

const requestId = z.string().min(1).max(200).optional();
const page = z.object({
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).optional(),
}).strict().optional();

const textPath = z.string().min(1);
const handle = z.string().min(1);
const envMap = z.record(z.string(), z.string()).optional();
const target = z.record(z.string(), z.unknown());

function strict(shape) {
  return z.object({ request_id: requestId, ...shape }).strict();
}
function paged(shape) {
  return z.object({ request_id: requestId, ...shape, page }).strict();
}

const schemas = {
  "device.health": strict({}),
  "device.get_config": strict({}),
  "device.set_config": strict({ key: z.string().min(1), value: z.unknown() }),
  "device.info": strict({}),
  "device.ping": strict({}),
  "agent.shutdown": strict({
    device_id: z.string().min(1),
    session_id: z.string().min(1),
    session_epoch: z.string().min(1),
    generation_id: z.string().min(1),
  }),
  "config.get": strict({}),
  "config.set": strict({
    key: z.string().min(1),
    value: z.unknown(),
  }),
  "identity.who_am_i": strict({}),
  "device.identity": strict({}),
  "usage.stats": strict({}),
  "diagnostics.usage_stats": strict({}),
  "audit.recent": strict({
    max_results: z.number().int().min(1).max(200).optional(),
    tool_name: z.string().min(1).optional(),
    since: z.string().min(1).optional(),
  }),
  "diagnostics.recent_tool_calls": strict({
    max_results: z.number().int().min(1).max(200).optional(),
    tool_name: z.string().min(1).optional(),
    since: z.string().min(1).optional(),
  }),

  "file.list": paged({ path: textPath, depth: z.number().int().min(1).max(32).optional() }),
  "file.info": strict({ path: textPath }),
  "file.read": paged({
    path: textPath,
    offset: z.number().int().optional(),
    length: z.number().int().min(1).max(100000).optional(),
    encoding: z.enum(["utf8", "utf-8"]).optional(),
  }),
  "file.read_multiple": strict({
    paths: z.array(textPath).min(1).max(64),
    max_bytes_per_file: z.number().int().min(1).max(1048576).optional(),
    max_total_bytes: z.number().int().min(1).max(16777216).optional(),
  }),
  "file.read_bytes": paged({
    path: textPath,
    offset_bytes: z.number().int().min(0).optional(),
    length_bytes: z.number().int().min(1).max(1048576).optional(),
  }),
  "file.hash": strict({ path: textPath, algorithm: z.enum(["sha256", "sha512"]).optional() }),
  "file.search": paged({
    path: textPath,
    pattern: z.string().min(1).optional(),
    glob: z.string().min(1).optional(),
    recursive: z.boolean().optional(),
  }),
  "content.search": paged({
    path: textPath,
    query: z.string().min(1),
    regex: z.boolean().optional(),
    case_sensitive: z.boolean().optional(),
  }),
  "file.write": strict({
    path: textPath,
    text: z.string(),
    expected_current_hash: z.string().min(1).optional(),
    create_only: z.boolean().optional(),
    overwrite: z.boolean().optional(),
  }),
  "file.append": strict({ path: textPath, text: z.string() }),
  "file.edit": strict({
    path: textPath,
    old_string: z.string(),
    new_string: z.string(),
    expected_current_hash: z.string().min(1).optional(),
  }),
  "file.create_dir": strict({ path: textPath, recursive: z.boolean().optional() }),
  "file.copy": strict({ source: textPath, destination: textPath, overwrite: z.boolean().optional() }),
  "file.move": strict({ source: textPath, destination: textPath, overwrite: z.boolean().optional() }),
  "file.delete": strict({ path: textPath, recursive: z.boolean().optional() }),
  "pdf.write": strict({
    path: textPath,
    content: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]),
    output_path: textPath.optional(),
  }),
  "search.start": strict({
    path: textPath,
    search_type: z.enum(["files", "content"]).optional(),
    pattern: z.string().min(1),
    literal_search: z.boolean().optional(),
    ignore_case: z.boolean().optional(),
    context_lines: z.number().int().min(0).max(100).optional(),
    include_hidden: z.boolean().optional(),
    max_results: z.number().int().min(1).max(100000).optional(),
    timeout_ms: z.number().int().min(1).max(600000).optional(),
  }),
  "search.read": strict({
    search_id: z.string().min(1).max(128),
    offset: z.number().int().min(-1000000).max(1000000).optional(),
    length: z.number().int().min(1).max(1000).optional(),
  }),
  "search.list": strict({}),
  "search.stop": strict({ search_id: z.string().min(1).max(128) }),

  "process.start": strict({
    command: z.string().min(1),
    args: z.array(z.string()).max(256).optional(),
    cwd: textPath.optional(),
    env: envMap,
    timeout_ms: z.number().int().min(1).max(300000).optional(),
  }),
  "process.read_output": strict({
    handle_id: handle,
    cursor: z.unknown().optional(),
    tail_bytes: z.number().int().min(1).max(1048576).optional(),
    max_bytes: z.number().int().min(1).max(1048576).optional(),
    wait_ms: z.number().int().min(0).max(2000).optional(),
  }),
  "process.status": strict({ handle_id: handle }),
  "process.managed.list": strict({
    kind: z.enum(["process", "session"]).optional(),
    include_stale: z.boolean().optional(),
    offset: z.number().int().min(0).optional(),
    max_results: z.number().int().min(1).max(200).optional(),
  }),
  "process.read": paged({
    handle,
    offset: z.number().int().optional(),
    length: z.number().int().min(1).max(100000).optional(),
    timeout_ms: z.number().int().min(0).max(10000).optional(),
  }),
  "process.interact": strict({ handle, input: z.string() }),
  "process.list": paged({}),
  "process.terminate": strict({ handle, force: z.boolean().optional() }),

  "system.process.list": paged({ filter: z.string().optional() }),
  "system.process.kill": strict({ pid: z.number().int().positive(), force: z.boolean().optional() }),

  "shell.session.open": strict({
    command: z.string().optional(),
    shell: z.string().optional(),
    cwd: textPath.optional(),
    env: envMap,
  }),
  "shell.session.start": strict({
    argv: z.array(z.string().min(1)).min(1).max(128),
    cwd: textPath.optional(),
    env: envMap,
    inherit_env: z.boolean().optional(),
    output_limit_bytes: z.number().int().min(1).max(1048576).optional(),
  }),
  "shell.session.read": paged({
    handle,
    offset: z.number().int().optional(),
    length: z.number().int().min(1).max(100000).optional(),
    timeout_ms: z.number().int().min(0).max(10000).optional(),
  }),
  "shell.session.write": strict({ handle, input: z.string() }),
  "shell.session.write_stdin": strict({
    session_id: handle,
    text: z.string(),
    append_newline: z.boolean().optional(),
    sensitive: z.boolean().optional(),
  }),
  "shell.session.close": strict({ handle }),
  "shell.session.terminate": strict({
    session_id: handle,
    grace_ms: z.number().int().min(0).max(5000).optional(),
  }),
  "shell.run": strict({
    command: z.string().min(1),
    cwd: textPath.optional(),
    env: envMap,
    timeout_ms: z.number().int().min(1).max(300000).optional(),
  }),

  "window.list": paged({}),
  "screenshot.capture": strict({
    window_id: z.union([z.string(), z.number().int()]).optional(),
    region: z.object({
      x: z.number().int(),
      y: z.number().int(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }).strict().optional(),
  }),
  "uia.find": paged({
    window_id: z.union([z.string(), z.number().int()]).optional(),
    query: target.optional(),
    max_results: z.number().int().min(1).max(200).optional(),
  }),
  "uia.invoke": strict({ target }),
  "input.click": strict({
    target: target.optional(),
    x: z.number().int().optional(),
    y: z.number().int().optional(),
    button: z.enum(["left", "right", "middle"]).optional(),
  }),
  "input.type": strict({ text: z.string(), target: target.optional(), replace: z.boolean().optional() }),
  "clipboard.read": strict({ format: z.string().optional() }),
  "clipboard.write": strict({ text: z.string() }),
};

const descriptions = {
  "device.health": "Read native PC Executor health without changing machine state.",
  "device.get_config": "Read native PC Executor configuration.",
  "device.set_config": "Change an Executor configuration value through the native control facade.",
  "device.info": "Read sanitized local device identity from the Executor.",
  "device.ping": "Read native health as a connectivity/ping operation.",
  "agent.shutdown": "Request Executor-bound device shutdown; unavailable unless explicitly advertised.",
  "config.get": "Read the Executor-native configuration contract.",
  "config.set": "Set one Executor configuration value; unavailable unless explicitly advertised.",
  "identity.who_am_i": "Read sanitized authenticated identity if the Executor publishes that capability.",
  "device.identity": "Read sanitized PC Core device/session identity.",
  "usage.stats": "Read sanitized native usage statistics through the current diagnostics.usage_stats action.",
  "diagnostics.usage_stats": "Read sanitized PC Core action/outcome metrics.",
  "audit.recent": "Read bounded sanitized recent audit metadata through PC Core diagnostics.recent_tool_calls.",
  "diagnostics.recent_tool_calls": "Read bounded sanitized PC Core audit metadata.",
  "file.list": "List filesystem entries with bounded MCP/native pagination.",
  "file.info": "Read filesystem metadata for one path.",
  "file.read": "Read bounded text from a file; use page/offset controls for large output.",
  "file.read_multiple": "Read a true bounded batch of files when the Executor publishes fs.read_multiple.",
  "file.read_bytes": "Read bounded binary bytes from a file.",
  "file.hash": "Compute a file hash through the Executor.",
  "file.search": "Search filesystem paths with bounded paginated results.",
  "content.search": "Search file content with bounded paginated results.",
  "file.write": "Write text through Executor policy and at-most-once control semantics.",
  "file.append": "Append text through Executor policy and at-most-once control semantics.",
  "file.edit": "Replace an exact text block through Executor policy.",
  "file.create_dir": "Create a directory through Executor policy.",
  "file.copy": "Copy a filesystem object through Executor policy.",
  "file.move": "Move a filesystem object through Executor policy.",
  "file.delete": "Delete a filesystem object; destructive and policy-gated.",
  "pdf.write": "Create or modify PDF content only when an Executor-bound pdf.write capability exists.",
  "search.start": "Start a durable Executor-managed stateful search.",
  "search.read": "Read a bounded result page from a durable search handle.",
  "search.list": "List active/recent Executor-managed search handles.",
  "search.stop": "Cancel an Executor-managed search while preserving retained results.",
  "process.start": "Start a process and return a session-bound native handle.",
  "process.read_output": "Read bounded output from a PC Core managed process handle.",
  "process.status": "Read one PC Core managed process status by handle.",
  "process.managed.list": "List PC Core managed process/session handles.",
  "process.read": "Read bounded output from a process handle.",
  "process.interact": "Write input to a process handle.",
  "process.list": "List native process-session handles with bounded results.",
  "process.terminate": "Terminate a process-session handle.",
  "system.process.list": "List system processes with bounded results.",
  "system.process.kill": "Kill a system process; destructive and policy-gated.",
  "shell.session.open": "Open an interactive shell session and return a native handle.",
  "shell.session.start": "Start a PC Core argv-only interactive session.",
  "shell.session.read": "Read bounded output from a shell-session handle.",
  "shell.session.write": "Write input to a shell-session handle.",
  "shell.session.write_stdin": "Write bounded non-sensitive stdin to a PC Core shell session.",
  "shell.session.close": "Close a shell-session handle.",
  "shell.session.terminate": "Terminate a PC Core shell-session handle.",
  "shell.run": "Run one bounded shell command through the Executor.",
  "window.list": "List desktop windows with bounded results.",
  "screenshot.capture": "Capture a screenshot through the native Executor.",
  "uia.find": "Find UI Automation targets with bounded results.",
  "uia.invoke": "Invoke a UI Automation target through Executor policy.",
  "input.click": "Send a pointer click through Executor policy.",
  "input.type": "Send text input through Executor policy.",
  "clipboard.read": "Read clipboard content.",
  "clipboard.write": "Write clipboard text through Executor policy.",
};

for (const tool of TOOL_REGISTRY_LIST) {
  if (!schemas[tool.name] || !descriptions[tool.name]) {
    throw new Error(`Missing MCP schema/description for native tool ${tool.name}`);
  }
}
for (const name of Object.keys(schemas)) {
  if (!TOOL_REGISTRY_LIST.some((tool) => tool.name === name)) {
    throw new Error(`MCP schema exists for unknown native tool ${name}`);
  }
}

export function mcpToolSchema(name) {
  return schemas[name];
}

export function mcpToolDescription(name) {
  return descriptions[name];
}

export const MCP_TOOL_SCHEMAS = Object.freeze(schemas);
export const MCP_TOOL_DESCRIPTIONS = Object.freeze(descriptions);

const compatibilityDeviceId = z.string().min(1).optional();
const compatibilityStrict = (shape, { device = true } = {}) => z.object({
  request_id: requestId,
  ...(device ? { deviceId: compatibilityDeviceId } : {}),
  ...shape,
}).strict();

const compatibilitySchemas = {
  list_devices: compatibilityStrict({}),
  ping: compatibilityStrict({}),
  shutdown: compatibilityStrict({}),
  get_config: compatibilityStrict({}),
  set_config_value: compatibilityStrict({
    key: z.string().min(1),
    value: z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.array(z.string()),
      z.null(),
    ]),
  }),
  read_file: compatibilityStrict({
    path: textPath,
    isUrl: z.boolean().optional(),
    offset: z.number().int().optional(),
    length: z.number().int().min(1).max(1000).optional(),
    sheet: z.string().min(1).optional(),
    range: z.string().min(1).optional(),
    options: z.record(z.string(), z.unknown()).optional(),
  }),
  read_multiple_files: compatibilityStrict({
    paths: z.array(textPath).min(1).max(64),
  }),
  write_file: compatibilityStrict({
    path: textPath,
    content: z.string(),
    mode: z.enum(["rewrite", "append"]).optional(),
  }),
  write_pdf: compatibilityStrict({
    path: textPath,
    content: z.union([
      z.string(),
      z.array(z.record(z.string(), z.unknown())),
    ]),
    outputPath: textPath.optional(),
    options: z.record(z.string(), z.unknown()).optional(),
  }),
  create_directory: compatibilityStrict({
    path: textPath,
  }),
  list_directory: compatibilityStrict({
    path: textPath,
    depth: z.number().int().min(1).max(32).optional(),
  }),
  move_file: compatibilityStrict({
    source: textPath,
    destination: textPath,
  }),
  start_search: compatibilityStrict({
    maxResults: z.number().int().min(1).max(100000).optional(),
    includeHidden: z.boolean().optional(),
    timeout_ms: z.number().int().min(1).max(600000).optional(),
    contextLines: z.number().int().min(0).max(100).optional(),
    filePattern: z.string().min(1).optional(),
    ignoreCase: z.boolean().optional(),
    searchType: z.enum(["files", "content"]).optional(),
    earlyTermination: z.boolean().optional(),
    pattern: z.string().min(1),
    path: textPath,
    literalSearch: z.boolean().optional(),
  }),
  get_more_search_results: compatibilityStrict({
    sessionId: z.string().min(1).max(128),
    offset: z.number().int().min(-1000000).max(1000000).optional(),
    length: z.number().int().min(1).max(1000).optional(),
  }),
  stop_search: compatibilityStrict({
    sessionId: z.string().min(1).max(128),
  }),
  list_searches: compatibilityStrict({}),
  get_file_info: compatibilityStrict({
    path: textPath,
  }),
  edit_block: compatibilityStrict({
    path: textPath,
    old_string: z.string().min(1),
    new_string: z.string(),
    expected_replacements: z.number().int().min(1).max(10000).optional(),
    encoding: z.string().min(1).optional(),
  }),
  start_process: compatibilityStrict({
    timeout_ms: z.number().int().min(0).max(600000),
    verbose_timing: z.boolean().optional(),
    command: z.string().min(1).max(32768),
    shell: z.string().min(1).optional(),
  }),
  read_process_output: compatibilityStrict({
    pid: z.number().int().positive(),
    timeout_ms: z.number().int().min(0).max(10000).optional(),
    offset: z.number().int().optional(),
    length: z.number().int().min(1).max(1000).optional(),
    verbose_timing: z.boolean().optional(),
  }),
  interact_with_process: compatibilityStrict({
    wait_for_prompt: z.boolean().optional(),
    input: z.string(),
    timeout_ms: z.number().int().min(0).max(10000).optional(),
    verbose_timing: z.boolean().optional(),
    pid: z.number().int().positive(),
  }),
  force_terminate: compatibilityStrict({
    pid: z.number().int().positive(),
  }),
  list_sessions: compatibilityStrict({}),
  list_processes: compatibilityStrict({}),
  kill_process: compatibilityStrict({
    pid: z.number().int().positive(),
  }),
  who_am_i: compatibilityStrict({}, { device: false }),
  get_usage_stats: compatibilityStrict({}),
  get_recent_tool_calls: compatibilityStrict({
    maxResults: z.number().int().min(1).max(1000).optional(),
    toolName: z.string().min(1).optional(),
    since: z.iso.datetime().optional(),
  }),
};

const compatibilityDescriptions = Object.freeze(Object.fromEntries(
  DC_COMPATIBILITY_REGISTRY_LIST.map((tool) => [
    tool.name,
    "Desktop Commander compatibility v1: " + tool.semantics,
  ]),
));

for (const tool of DC_COMPATIBILITY_REGISTRY_LIST) {
  if (!compatibilitySchemas[tool.name] || !compatibilityDescriptions[tool.name]) {
    throw new Error("Missing MCP schema/description for Desktop Commander compatibility tool " + tool.name);
  }
}
for (const name of Object.keys(compatibilitySchemas)) {
  if (!DC_COMPATIBILITY_REGISTRY_LIST.some((tool) => tool.name === name)) {
    throw new Error("MCP compatibility schema exists for unknown tool " + name);
  }
}

export function mcpCompatibilityToolSchema(name) {
  return compatibilitySchemas[name];
}

export function mcpCompatibilityToolDescription(name) {
  return compatibilityDescriptions[name];
}

export const MCP_COMPATIBILITY_TOOL_SCHEMAS = Object.freeze(compatibilitySchemas);
export const MCP_COMPATIBILITY_TOOL_DESCRIPTIONS = compatibilityDescriptions;
