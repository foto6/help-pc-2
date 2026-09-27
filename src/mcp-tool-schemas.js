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

  "file.list": paged({ path: textPath, depth: z.number().int().min(1).max(32).optional() }),
  "file.info": strict({ path: textPath }),
  "file.read": paged({
    path: textPath,
    offset: z.number().int().optional(),
    length: z.number().int().min(1).max(100000).optional(),
    encoding: z.enum(["utf8", "utf-8"]).optional(),
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

  "process.start": strict({
    command: z.string().min(1),
    args: z.array(z.string()).max(256).optional(),
    cwd: textPath.optional(),
    env: envMap,
    timeout_ms: z.number().int().min(1).max(300000).optional(),
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
  "shell.session.read": paged({
    handle,
    offset: z.number().int().optional(),
    length: z.number().int().min(1).max(100000).optional(),
    timeout_ms: z.number().int().min(0).max(10000).optional(),
  }),
  "shell.session.write": strict({ handle, input: z.string() }),
  "shell.session.close": strict({ handle }),
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
  "file.list": "List filesystem entries with bounded MCP/native pagination.",
  "file.info": "Read filesystem metadata for one path.",
  "file.read": "Read bounded text from a file; use page/offset controls for large output.",
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
  "process.start": "Start a process and return a session-bound native handle.",
  "process.read": "Read bounded output from a process handle.",
  "process.interact": "Write input to a process handle.",
  "process.list": "List native process-session handles with bounded results.",
  "process.terminate": "Terminate a process-session handle.",
  "system.process.list": "List system processes with bounded results.",
  "system.process.kill": "Kill a system process; destructive and policy-gated.",
  "shell.session.open": "Open an interactive shell session and return a native handle.",
  "shell.session.read": "Read bounded output from a shell-session handle.",
  "shell.session.write": "Write input to a shell-session handle.",
  "shell.session.close": "Close a shell-session handle.",
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

const compatibilitySchemas = {
  edit_block: strict({
    path: textPath,
    old_string: z.string().min(1),
    new_string: z.string(),
    expected_replacements: z.number().int().min(1).max(10000).optional(),
    encoding: z.string().min(1).optional(),
  }),
  read_file: strict({
    path: textPath,
    offset: z.number().int().optional(),
    length: z.number().int().min(1).max(1000).optional(),
  }),
  read_multiple_files: strict({
    paths: z.array(textPath).min(1).max(64),
  }),
  write_file: strict({
    path: textPath,
    content: z.string(),
    mode: z.enum(["rewrite", "append"]).optional(),
  }),
  start_process: strict({
    command: z.string().min(1),
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
