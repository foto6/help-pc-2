import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  NATIVE_CONTROL_PROTOCOL_V1,
  DEFAULT_NATIVE_LIMITS,
  NATIVE_RESPONSE_V1,
} from "./native-registry.js";
import { assertPinnedNativeManifest } from "./full-compat-observability.js";
import {
  DC_COMPATIBILITY_RESPONSE_V1,
  desktopCommanderCompatibilityManifestV1,
  desktopCommanderToolDefinition,
} from "./dc-compatibility-registry.js";

const STORE_VERSION = 1;
const MAX_READ_LINES = 1000;
const MAX_BATCH_FILES = 64;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_COMMAND_CHARS = 32768;

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function integer(value, name, { minimum = null, maximum = null, fallback = undefined } = {}) {
  const actual = value === undefined ? fallback : value;
  if (!Number.isInteger(actual) ||
      (minimum !== null && actual < minimum) ||
      (maximum !== null && actual > maximum)) {
    const bounds = [
      minimum === null ? null : `>= ${minimum}`,
      maximum === null ? null : `<= ${maximum}`,
    ].filter(Boolean).join(" and ");
    throw new DcCompatibilityError(`${name} must be an integer${bounds ? ` ${bounds}` : ""}.`, {
      code: "RANGE_ERROR",
      category: "range",
      details: { argument: name },
    });
  }
  return actual;
}

function nonemptyString(value, name) {
  if (typeof value !== "string" || !value.length) {
    throw new DcCompatibilityError(`${name} must be a non-empty string.`, {
      code: "INVALID_ARGUMENT",
      category: "argument",
      details: { argument: name },
    });
  }
  return value;
}

function commandToArgv(command, shell = null) {
  if (typeof command !== "string" || !command.length || command.includes("\0")) {
    throw new DcCompatibilityError("command must be a non-empty string without NUL bytes.", {
      code: "INVALID_ARGUMENT",
      category: "argument",
    });
  }
  if (shell !== null && shell !== undefined) {
    const shellName = nonemptyString(shell, "shell");
    const basename = shellName.replaceAll("\\", "/").split("/").at(-1).toLowerCase();
    if (["powershell", "powershell.exe", "pwsh", "pwsh.exe"].includes(basename)) {
      return [shellName, "-NoProfile", "-Command", command];
    }
    if (["cmd", "cmd.exe"].includes(basename)) return [shellName, "/d", "/s", "/c", command];
    return [shellName, "-c", command];
  }

  const argv = [];
  let current = "";
  let quote = null;
  let started = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) {
        quote = null;
        started = true;
      } else if (char === "\\" && quote === '"' && index + 1 < command.length && ["\\", '"'].includes(command[index + 1])) {
        current += command[++index];
        started = true;
      } else {
        current += char;
        started = true;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        argv.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (quote) {
    throw new DcCompatibilityError("command contains an unterminated quoted argument.", {
      code: "INVALID_ARGUMENT",
      category: "argument",
    });
  }
  if (started) argv.push(current);
  if (!argv.length || argv.length > 128 || argv.some((part) => !part.length)) {
    throw new DcCompatibilityError("command could not be represented as bounded argv.", {
      code: "INVALID_ARGUMENT",
      category: "argument",
    });
  }
  return argv;
}

function defaultState() {
  return { version: STORE_VERSION, processes: [] };
}

function extractNativeHandle(data) {
  if (!data || typeof data !== "object") return null;
  for (const key of ["process_handle", "session_handle", "handle", "handle_id"]) {
    if (typeof data[key] === "string" && data[key]) return data[key];
  }
  return null;
}

function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (/(secret|token|password|credential|authorization|auth)/i.test(key)) continue;
    result[key] = sanitize(item);
  }
  return result;
}

function asArray(value, keys = ["items", "results", "entries", "processes", "handles", "searches"]) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  for (const key of keys) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}

function responseEnvelope({ requestId, sessionId, tool, status, data = null, error = null }) {
  return {
    contract_version: DC_COMPATIBILITY_RESPONSE_V1,
    request_id: requestId,
    session_id: sessionId,
    tool,
    status,
    data,
    error,
  };
}

function nativeErrorObject(value) {
  if (!value) return null;
  if (value?.status === "error" && value.error) return value.error;
  if (value.error && typeof value.error === "object") return value.error;
  return value;
}

function textForError(error) {
  const native = nativeErrorObject(error);
  return [
    native?.code,
    native?.category,
    native?.message,
    error?.code,
    error?.category,
    error?.message,
  ].filter((value) => typeof value === "string").join(" ").toLowerCase();
}

export class DcCompatibilityError extends Error {
  constructor(message, {
    code = "DC_COMPATIBILITY_ERROR",
    category = "compatibility",
    retryable = false,
    details = null,
  } = {}) {
    super(message);
    this.name = "DcCompatibilityError";
    this.code = code;
    this.category = category;
    this.retryable = retryable;
    this.details = details;
  }
}

class NativeStatusSignal extends Error {
  constructor(response) {
    super(`Native request is ${response?.status ?? "incomplete"}.`);
    this.name = "NativeStatusSignal";
    this.response = response;
  }
}

export function normalizeDesktopCommanderError(error, { tool = null } = {}) {
  if (error instanceof DcCompatibilityError) return error;
  const native = nativeErrorObject(error);
  const code = String(native?.code ?? error?.code ?? "");
  const category = String(native?.category ?? error?.category ?? "");
  const message = String(native?.message ?? error?.message ?? error ?? "Native compatibility request failed.");
  const haystack = textForError(error);

  let normalizedCode = code || "NATIVE_ERROR";
  let normalizedCategory = category || "native";
  // Never relabel a structured non-file registry/device lookup failure as a
  // missing filesystem path merely because its code/message says "not found".
  // Real R14b: TOOL_NOT_FOUND for the frozen PC Core registry was incorrectly
  // rendered FILE_NOT_FOUND for list_devices, ping and get_config.
  const fileContext = /^(read_file|read_multiple_files|write_file|edit_block|create_directory|list_directory|move_file|get_file_info|write_pdf)$/.test(tool ?? "");
  const protectedDomain = /^(TOOL_NOT_FOUND|SCHEMA_VERSION_MISMATCH|CAPABILITY_MISMATCH|CAPABILITY_DRIFT|CAPABILITY_UNAVAILABLE|NATIVE_REGISTRY_IDENTITY_MISMATCH|EXECUTOR_CAPABILITY_IDENTITY_INVALID|DUPLICATE_REQUEST_MISMATCH|REQUEST_ID_CONFLICT|STALE_SESSION|SEARCH_SESSION_NOT_FOUND|STALE_EXECUTION_CONTEXT|PROTECTED_PATH_BLOCKED|UNKNOWN_RECONCILE|UNKNOWN_OUTCOME|RECONCILIATION_REQUIRED|TIMEOUT|REQUEST_TIMEOUT|DEADLINE_EXCEEDED|CANCELLED)$/i.test(code)
    || /^(tool|session|search|idempotency|capability|capability_mismatch|bridge_context|timeout|cancelled|policy)$/i.test(category);
  // Structured non-file domains are authoritative; prose (including words
  // such as "file", "not found", or "permission") cannot recategorize them.
  // A bare NOT_FOUND may mean a filesystem miss only in an actual file route.
  const structuredOtherNotFound = protectedDomain || (
    (/_NOT_FOUND$/i.test(code) || code.toUpperCase() === "NOT_FOUND")
    && !["FILE_NOT_FOUND", "PATH_NOT_FOUND", "DIRECTORY_NOT_FOUND"].includes(code.toUpperCase())
    && category.toLowerCase() !== "filesystem"
    && !(code.toUpperCase() === "NOT_FOUND" && fileContext)
  );
  if (!protectedDomain && !structuredOtherNotFound && !structuredOtherNotFound && /enoent|not[_ -]?found|no such file|missing file/.test(haystack)) {
    normalizedCode = "FILE_NOT_FOUND";
    normalizedCategory = "filesystem";
  } else if (!protectedDomain && !structuredOtherNotFound && /eacces|eperm|access[_ -]?denied|permission denied|unauthori[sz]ed/.test(haystack)) {
    normalizedCode = "ACCESS_DENIED";
    normalizedCategory = "filesystem";
  } else if (!protectedDomain && !structuredOtherNotFound && /stale.*handle|stale_process_handle|invalid.*handle|unknown.*handle/.test(haystack)) {
    normalizedCode = "STALE_HANDLE";
    normalizedCategory = "process";
  } else if (!protectedDomain && !structuredOtherNotFound && /replacement.*mismatch|replacement count|expected_replacements/.test(haystack)) {
    normalizedCode = "REPLACEMENT_CONFLICT";
    normalizedCategory = "conflict";
  } else if (!protectedDomain && !structuredOtherNotFound && /range|bounds|offset|page_limit|too large|exceeds.*bound/.test(haystack)) {
    normalizedCode = "RANGE_ERROR";
    normalizedCategory = "range";
  } else if (!protectedDomain && !structuredOtherNotFound && ((tool && tool.includes("process")) || /process|terminate|spawn|exited/.test(haystack))) {
    normalizedCode = "PROCESS_ERROR";
    normalizedCategory = "process";
  }

  return new DcCompatibilityError(message, {
    code: normalizedCode,
    category: normalizedCategory,
    retryable: native?.retryable === true || error?.retryable === true,
    details: {
      native_code: code || null,
      native_category: category || null,
      ...(native?.details === undefined ? {} : { native_details: clone(native.details) }),
    },
  });
}

export class JsonDcCompatibilityStore {
  constructor(path) {
    this.path = path;
  }

  load() {
    if (!existsSync(this.path)) return null;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8"));
    } catch (error) {
      throw new DcCompatibilityError(`Desktop Commander compatibility state is corrupted: ${error.message}`, {
        code: "COMPATIBILITY_STATE_CORRUPTED",
        category: "state",
      });
    }
    if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.processes)) {
      throw new DcCompatibilityError("Desktop Commander compatibility state schema is invalid.", {
        code: "COMPATIBILITY_STATE_CORRUPTED",
        category: "state",
      });
    }
    return parsed;
  }

  save(snapshot) {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(temp, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      renameSync(temp, this.path);
    } catch (error) {
      try { unlinkSync(temp); } catch {}
      throw error;
    }
  }
}

export class DesktopCommanderCompatibilitySurface {
  constructor({
    facade,
    store = null,
    maxReadLines = MAX_READ_LINES,
    maxBatchFiles = MAX_BATCH_FILES,
    maxTextBytes = MAX_TEXT_BYTES,
    clock = Date.now,
  } = {}) {
    if (!facade || typeof facade.invoke !== "function" || typeof facade.capabilities !== "function") {
      throw new TypeError("facade must expose capabilities() and invoke().");
    }
    this.facade = facade;
    this.store = store;
    this.maxReadLines = maxReadLines;
    this.maxBatchFiles = maxBatchFiles;
    this.maxTextBytes = maxTextBytes;
    this.clock = clock;
    this.state = store?.load() ?? defaultState();
  }

  #persist() {
    this.store?.save(this.state);
  }

  async registry() {
    return desktopCommanderCompatibilityManifestV1({
      nativeManifest: assertPinnedNativeManifest(await this.facade.capabilities()),
    });
  }

  #process(sessionId, pid) {
    return this.state.processes.find((item) => item.sessionId === sessionId && item.pid === pid) ?? null;
  }

  #requireProcess(sessionId, pid) {
    const record = this.#process(sessionId, pid);
    if (!record || record.status === "terminated") {
      throw new DcCompatibilityError("Process handle is stale or unknown.", {
        code: "STALE_HANDLE",
        category: "process",
        details: { pid },
      });
    }
    return record;
  }

  async #requireCapabilities(toolName, actions) {
    const manifest = assertPinnedNativeManifest(await this.facade.capabilities());
    const advertised = new Set(manifest.executor.actions);
    const missing = actions.filter((action) => !advertised.has(action));
    if (missing.length) {
      throw new DcCompatibilityError(
        `Desktop Commander tool '${toolName}' is unavailable because required native capabilities are missing.`,
        {
          code: "CAPABILITY_UNAVAILABLE",
          category: "capability",
          details: {
            required_executor_actions: [...actions],
            missing_executor_actions: missing,
            executor_digest: manifest?.executor?.digest ?? null,
          },
        },
      );
    }
    return manifest;
  }

  async #selectVariant(toolName, { variantId = null } = {}) {
    const definition = desktopCommanderToolDefinition(toolName);
    if (!definition) {
      throw new DcCompatibilityError(`Unknown Desktop Commander compatibility tool '${toolName}'.`, {
        code: "TOOL_NOT_FOUND",
        category: "tool",
      });
    }
    const manifest = assertPinnedNativeManifest(await this.facade.capabilities());
    const advertised = new Set(manifest.executor.actions);
    const variants = definition.capability_variants.filter(
      (variant) => variantId === null || variant.id === variantId,
    );
    for (const variant of variants) {
      const missing = variant.executor_actions.filter((action) => !advertised.has(action));
      const blockedBy = (variant.unless_executor_actions ?? []).filter((action) => advertised.has(action));
      if (missing.length === 0 && blockedBy.length === 0) {
        return { definition, variant, manifest, advertised };
      }
    }
    throw new DcCompatibilityError(
      `Desktop Commander tool '${toolName}' is unavailable because required native capabilities are missing.`,
      {
        code: "CAPABILITY_UNAVAILABLE",
        category: "capability",
        details: {
          executor_digest: manifest?.executor?.digest ?? null,
          requested_variant: variantId,
          variants: variants.map((variant) => ({
            id: variant.id,
            required_executor_actions: [...variant.executor_actions],
            missing_executor_actions: variant.executor_actions.filter((action) => !advertised.has(action)),
            blocked_by_executor_actions: (variant.unless_executor_actions ?? []).filter((action) => advertised.has(action)),
          })),
        },
      },
    );
  }

  async #invokeNative({ sessionId, requestId, tool, arguments: args = {}, page = undefined, signal = null }) {
    let response;
    try {
      response = await this.facade.invoke({
        contract_version: NATIVE_CONTROL_PROTOCOL_V1,
        session_id: sessionId,
        request_id: requestId,
        tool,
        arguments: args,
        ...(page === undefined ? {} : { page }),
      }, { signal });
    } catch (error) {
      throw normalizeDesktopCommanderError(error, { tool });
    }
    // The facade response identity/version is part of the same durable
    // request. An unrelated completion must never become a compatibility success.
    if (!response || response.contract_version !== NATIVE_RESPONSE_V1
        || response.request_id !== requestId || response.session_id !== sessionId
        || !["completed", "error", "pending", "reconciliation_required", "cancelled"].includes(response.status)) {
      throw new DcCompatibilityError("Native response contract or logical request identity changed.", {
        code: "NATIVE_RESULT_INVALID",
        category: "native_result",
        retryable: false,
      });
    }
    if (response.status === "error") {
      throw normalizeDesktopCommanderError(response, { tool });
    }
    if (response.status !== "completed") {
      throw new NativeStatusSignal(response);
    }
    return response;
  }

  #fileReadArguments(args) {
    const path = nonemptyString(args.path, "path");
    const offset = integer(args.offset, "offset", { fallback: 0 });
    const length = integer(args.length, "length", {
      fallback: this.maxReadLines,
      minimum: 1,
      maximum: this.maxReadLines,
    });
    if (offset < 0) {
      if (-offset > this.maxReadLines) {
        throw new DcCompatibilityError(`negative offset tail is bounded to ${this.maxReadLines} lines.`, {
          code: "RANGE_ERROR",
          category: "range",
          details: { offset, max_tail_lines: this.maxReadLines },
        });
      }
      return {
        path,
        offset,
        length: -offset,
        native: { path, tail_lines: -offset, max_bytes: this.maxTextBytes },
      };
    }
    return {
      path,
      offset,
      length,
      native: {
        path,
        start_line: offset + 1,
        end_line: offset + length,
        max_bytes: this.maxTextBytes,
      },
    };
  }

  #projectRead(data, { path, offset, length }) {
    const text = typeof data?.text === "string"
      ? data.text
      : Array.isArray(data?.items)
        ? data.items.join("\n")
        : "";
    return {
      path: data?.path ?? path,
      content: text,
      offset,
      length,
      returned_bytes: data?.returned_bytes ?? Buffer.byteLength(text, "utf8"),
      truncated: data?.truncated === true,
      next_line: data?.next_line ?? null,
      file_bytes: data?.file_bytes ?? null,
      sha256: data?.sha256 ?? null,
    };
  }

  #unsupportedMode(toolName, message, details = null) {
    throw new DcCompatibilityError(message, {
      code: "CAPABILITY_UNAVAILABLE",
      category: "capability",
      details: { tool: toolName, ...(details ?? {}) },
    });
  }

  async #listDevices(sessionId, requestId, signal = null) {
    const { variant } = await this.#selectVariant("list_devices");
    const response = await this.#invokeNative({
      sessionId,
      requestId,
      tool: variant.native_tools[0],
      arguments: {},
      signal,
    });
    const data = sanitize(response.data ?? {});
    const device = {
      device_id: data.device_id ?? "local",
      status: "online",
      transport: data.transport ?? "native",
      platform: data.platform ?? null,
      architecture: data.architecture ?? null,
      generation_id: data.generation_id ?? null,
      contract_version: data.contract_version ?? null,
    };
    return { devices: [device], count: 1 };
  }

  async #ping(sessionId, requestId, _args, signal = null) {
    const { variant } = await this.#selectVariant("ping");
    const response = await this.#invokeNative({
      sessionId,
      requestId,
      tool: variant.native_tools[0],
      arguments: {},
      signal,
    });
    return {
      pong: true,
      timestamp_ms: this.clock(),
      health: sanitize(response.data ?? {}),
    };
  }

  async #shutdown(sessionId, requestId, _args, signal = null) {
    await this.#selectVariant("shutdown");
    const identity = await this.#invokeNative({
      sessionId,
      requestId: `${requestId}:generation`,
      tool: "device.info",
      arguments: {},
      signal,
    });
    const generationId = nonemptyString(identity.data?.generation_id, "device.info generation_id");
    const response = await this.#invokeNative({
      sessionId,
      requestId,
      tool: "agent.shutdown",
      arguments: { generation_id: generationId },
      signal,
    });
    return {
      acknowledged: true,
      native: sanitize(response.data ?? {}),
    };
  }

  async #getConfig(sessionId, requestId, _args, signal = null) {
    const { variant } = await this.#selectVariant("get_config");
    const response = await this.#invokeNative({
      sessionId,
      requestId,
      tool: variant.native_tools[0],
      arguments: {},
      signal,
    });
    return sanitize(response.data ?? {});
  }

  async #setConfigValue(sessionId, requestId, args, signal = null) {
    const { variant } = await this.#selectVariant("set_config_value");
    const key = nonemptyString(args.key, "key");
    const response = await this.#invokeNative({
      sessionId,
      requestId,
      tool: variant.native_tools[0],
      arguments: { key, value: clone(args.value) },
      signal,
    });
    return sanitize(response.data ?? { key, updated: true });
  }

  async #writePdf(sessionId, requestId, args, signal = null) {
    const { variant } = await this.#selectVariant("write_pdf");
    const path = nonemptyString(args.path, "path");
    if (typeof args.content !== "string" && !Array.isArray(args.content)) {
      throw new DcCompatibilityError("write_pdf content must be markdown text or an operation array.", {
        code: "INVALID_ARGUMENT",
        category: "argument",
      });
    }
    if (args.options !== undefined && args.options !== null && Object.keys(args.options).length > 0) {
      this.#unsupportedMode("write_pdf", "write_pdf options are unavailable in the current Executor-bound PDF action.", {
        unsupported_parameters: ["options"],
      });
    }
    const response = await this.#invokeNative({
      sessionId,
      requestId,
      tool: variant.native_tools[0],
      arguments: {
        path,
        content: clone(args.content),
        ...(args.outputPath === undefined ? {} : { output_path: nonemptyString(args.outputPath, "outputPath") }),
      },
      signal,
    });
    return sanitize(response.data ?? {});
  }

  async #createDirectory(sessionId, requestId, args, signal = null) {
    await this.#selectVariant("create_directory");
    const path = nonemptyString(args.path, "path");
    const response = await this.#invokeNative({
      sessionId,
      requestId,
      tool: "file.create_dir",
      arguments: { path, parents: true, exist_ok: true },
      signal,
    });
    return {
      path: response.data?.path ?? path,
      created: response.data?.created ?? true,
      native: sanitize(response.data ?? {}),
    };
  }

  async #listDirectory(sessionId, requestId, args, signal = null) {
    await this.#selectVariant("list_directory");
    const root = nonemptyString(args.path, "path");
    const depth = integer(args.depth, "depth", { fallback: 2, minimum: 1, maximum: 32 });
    const entries = [];
    const queue = [{ path: root, level: 1 }];
    let directoryIndex = 0;
    let truncated = false;
    const maxAggregateEntries = 2000;
    const maxDirectories = 256;

    while (queue.length && entries.length < maxAggregateEntries && directoryIndex < maxDirectories) {
      const current = queue.shift();
      const nested = current.level > 1;
      const perDirectoryLimit = nested ? 100 : DEFAULT_NATIVE_LIMITS.maxPageSize;
      let offset = 0;
      let pageIndex = 0;
      do {
        const response = await this.#invokeNative({
          sessionId,
          requestId: `${requestId}:dir:${directoryIndex}:page:${pageIndex}`,
          tool: "file.list",
          arguments: {
            path: current.path,
            offset,
            max_entries: perDirectoryLimit,
            include_hidden: true,
          },
          signal,
        });
        const pageEntries = asArray(response.data, ["entries", "items"]);
        for (const item of pageEntries) {
          if (entries.length >= maxAggregateEntries) {
            truncated = true;
            break;
          }
          const clean = sanitize(item);
          entries.push(clean);
          const itemPath = item?.path;
          const kind = item?.kind ?? item?.type;
          if (current.level < depth && typeof itemPath === "string" &&
              (kind === "directory" || item?.is_directory === true)) {
            queue.push({ path: itemPath, level: current.level + 1 });
          }
        }
        const hasMore = response.data?.has_more === true || response.data?.truncated === true;
        if (pageEntries.length > perDirectoryLimit || (hasMore && pageEntries.length === 0)) {
          throw new DcCompatibilityError("Native file.list returned an invalid bounded page.", {
            code: "NATIVE_RESULT_INVALID",
            category: "native_result",
          });
        }
        if (nested && hasMore) {
          truncated = true;
          break;
        }
        if (!hasMore) break;
        const nextOffset = Number.isInteger(response.data?.next_offset)
          ? response.data.next_offset
          : offset + pageEntries.length;
        if (nextOffset <= offset) {
          throw new DcCompatibilityError("Native file.list continuation did not advance.", {
            code: "NATIVE_RESULT_INVALID",
            category: "native_result",
          });
        }
        offset = nextOffset;
        pageIndex += 1;
        if (pageIndex >= 10) {
          truncated = true;
          break;
        }
      } while (entries.length < maxAggregateEntries);
      directoryIndex += 1;
    }
    if (queue.length || directoryIndex >= maxDirectories || entries.length >= maxAggregateEntries) truncated = true;
    return {
      path: root,
      depth,
      entries,
      count: entries.length,
      truncated,
      nested_directory_limit: 100,
      aggregate_entry_limit: maxAggregateEntries,
    };
  }

  async #moveFile(sessionId, requestId, args, signal = null) {
    await this.#selectVariant("move_file");
    const source = nonemptyString(args.source, "source");
    const destination = nonemptyString(args.destination, "destination");
    const response = await this.#invokeNative({
      sessionId,
      requestId,
      tool: "file.move",
      arguments: { source, destination, overwrite: false },
      signal,
    });
    return sanitize(response.data ?? { source, destination });
  }

  async #startSearch(sessionId, requestId, args, signal = null) {
    await this.#selectVariant("start_search");
    const path = nonemptyString(args.path, "path");
    const pattern = nonemptyString(args.pattern, "pattern");
    if (args.filePattern !== undefined) {
      this.#unsupportedMode("start_search", "filePattern is not available in pc_executor.search_session.v1.", {
        unsupported_parameter: "filePattern",
      });
    }
    if (args.earlyTermination !== undefined) {
      this.#unsupportedMode("start_search", "earlyTermination is not available in pc_executor.search_session.v1.", {
        unsupported_parameter: "earlyTermination",
      });
    }
    const searchType = args.searchType ?? "files";
    if (!["files", "content"].includes(searchType)) {
      throw new DcCompatibilityError("searchType must be files or content.", {
        code: "INVALID_ARGUMENT",
        category: "argument",
      });
    }
    const nativeArgs = {
      path,
      pattern,
      search_type: searchType,
      literal_search: args.literalSearch === true,
      ignore_case: args.ignoreCase !== false,
      include_hidden: args.includeHidden === true,
      context_lines: integer(args.contextLines, "contextLines", { fallback: 5, minimum: 0, maximum: 100 }),
      max_results: integer(args.maxResults, "maxResults", { fallback: 100, minimum: 1, maximum: 100000 }),
      ...(args.timeout_ms === undefined ? {} : {
        timeout_ms: integer(args.timeout_ms, "timeout_ms", { minimum: 1, maximum: 600000 }),
      }),
    };
    const response = await this.#invokeNative({
      sessionId,
      requestId,
      tool: "search.start",
      arguments: nativeArgs,
      signal,
    });
    const searchId = response.data?.search_id ?? response.data?.sessionId ?? response.data?.session_id;
    if (typeof searchId !== "string" || !searchId) {
      throw new DcCompatibilityError("Native search.start did not return a search_id.", {
        code: "NATIVE_RESULT_INVALID",
        category: "native_result",
      });
    }
    return {
      sessionId: searchId,
      search_id: searchId,
      searchType,
      pattern,
      status: response.data?.status ?? "running",
      result_count: response.data?.result_count ?? 0,
      runtime_ms: response.data?.runtime_ms ?? 0,
    };
  }

  async #getMoreSearchResults(sessionId, requestId, args, signal = null) {
    await this.#selectVariant("get_more_search_results");
    const searchId = nonemptyString(args.sessionId, "sessionId");
    const offset = integer(args.offset, "offset", {
      fallback: 0,
      minimum: -1000000,
      maximum: 1000000,
    });
    const length = integer(args.length, "length", {
      fallback: 100,
      minimum: 1,
      maximum: 1000,
    });
    const response = await this.#invokeNative({
      sessionId,
      requestId,
      tool: "search.read",
      arguments: {
        search_id: searchId,
        offset,
        ...(offset < 0 ? {} : { length }),
      },
      signal,
    });
    const results = asArray(response.data, ["results", "items"]);
    const maxExpected = offset < 0 ? Math.min(-offset, 1000000) : length;
    if (results.length > maxExpected) {
      throw new DcCompatibilityError("Native search.read exceeded the requested result bound.", {
        code: "NATIVE_RESULT_INVALID",
        category: "bounds",
        details: { expected_max: maxExpected, actual: results.length },
      });
    }
    return {
      sessionId: searchId,
      search_id: searchId,
      offset,
      length: offset < 0 ? null : length,
      results: sanitize(results),
      result_count: response.data?.result_count ?? results.length,
      status: response.data?.status ?? null,
      runtime_ms: response.data?.runtime_ms ?? null,
      has_more: response.data?.has_more ?? null,
    };
  }

  async #stopSearch(sessionId, requestId, args, signal = null) {
    await this.#selectVariant("stop_search");
    const searchId = nonemptyString(args.sessionId, "sessionId");
    const response = await this.#invokeNative({
      sessionId,
      requestId,
      tool: "search.stop",
      arguments: { search_id: searchId },
      signal,
    });
    return {
      sessionId: searchId,
      search_id: searchId,
      stopped: response.data?.stopped !== false,
      already_finished: response.data?.already_finished === true,
      status: response.data?.status ?? null,
    };
  }

  async #listSearches(sessionId, requestId, _args, signal = null) {
    await this.#selectVariant("list_searches");
    const response = await this.#invokeNative({
      sessionId,
      requestId,
      tool: "search.list",
      arguments: {},
      signal,
    });
    const searches = asArray(response.data, ["searches", "items"]).map((item) => ({
      sessionId: item?.search_id ?? item?.sessionId ?? null,
      search_id: item?.search_id ?? item?.sessionId ?? null,
      searchType: item?.search_type ?? item?.searchType ?? null,
      pattern: item?.pattern ?? null,
      status: item?.status ?? null,
      runtime_ms: item?.runtime_ms ?? null,
      result_count: item?.result_count ?? item?.count ?? null,
    }));
    return { searches, count: searches.length };
  }

  async #getFileInfo(sessionId, requestId, args, signal = null) {
    const { advertised } = await this.#selectVariant("get_file_info");
    const path = nonemptyString(args.path, "path");
    const stat = await this.#invokeNative({
      sessionId,
      requestId: `${requestId}:stat`,
      tool: "file.info",
      arguments: { path },
      signal,
    });
    let sha256 = null;
    if (advertised.has("fs.hash")) {
      const hash = await this.#invokeNative({
        sessionId,
        requestId: `${requestId}:hash`,
        tool: "file.hash",
        arguments: { path, max_bytes: this.maxTextBytes },
        signal,
      });
      sha256 = hash.data?.sha256 ?? null;
    }
    const data = stat.data ?? {};
    return {
      path: data.path ?? path,
      type: data.kind ?? data.type ?? null,
      size: data.bytes ?? data.size ?? null,
      created_ns: data.created_ns ?? null,
      modified_ns: data.modified_ns ?? null,
      permissions: data.permissions ?? null,
      symlink: data.symlink ?? false,
      lineCount: data.line_count ?? null,
      lastLine: data.last_line ?? null,
      appendPosition: data.append_position ?? null,
      sheets: data.sheets ?? null,
      sha256,
      native: sanitize(data),
    };
  }

  async #whoAmI(sessionId, requestId, signal = null) {
    const { variant } = await this.#selectVariant("who_am_i");
    const response = await this.#invokeNative({
      sessionId,
      requestId,
      tool: variant.native_tools[0],
      arguments: {},
      signal,
    });
    return sanitize(response.data ?? {});
  }

  async #getUsageStats(sessionId, requestId, _args, signal = null) {
    const { variant } = await this.#selectVariant("get_usage_stats");
    const response = await this.#invokeNative({
      sessionId,
      requestId,
      tool: variant.native_tools[0],
      arguments: {},
      signal,
    });
    const data = sanitize(response.data ?? {});
    return {
      ...data,
      connector_billing_available: false,
      note: "Native equivalent reports sanitized PC action/outcome metrics only; Desktop Commander Remote MCP billing telemetry is not synthesized.",
    };
  }

  async #getRecentToolCalls(sessionId, requestId, args, signal = null) {
    const { variant } = await this.#selectVariant("get_recent_tool_calls");
    const requested = integer(args.maxResults, "maxResults", { fallback: 50, minimum: 1, maximum: 1000 });
    const nativeArgs = { max_results: Math.min(requested, 200) };
    if (args.toolName !== undefined) nativeArgs.tool_name = nonemptyString(args.toolName, "toolName");
    if (args.since !== undefined) nativeArgs.since = nonemptyString(args.since, "since");
    const response = await this.#invokeNative({
      sessionId,
      requestId,
      tool: variant.native_tools[0],
      arguments: nativeArgs,
      signal,
    });
    const data = sanitize(response.data ?? {});
    let events = asArray(data, ["events", "calls", "items"]);
    if (args.toolName !== undefined) {
      const toolName = nonemptyString(args.toolName, "toolName");
      events = events.filter((item) => (item?.tool ?? item?.action) === toolName);
    }
    if (args.since !== undefined) {
      const since = Date.parse(nonemptyString(args.since, "since"));
      if (!Number.isFinite(since)) {
        throw new DcCompatibilityError("since must be an ISO date-time.", { code: "INVALID_ARGUMENT", category: "argument" });
      }
      events = events.filter((item) => {
        const value = item?.timestamp ?? item?.timestamp_ms ?? item?.time;
        const stamp = typeof value === "number" ? value : Date.parse(String(value ?? ""));
        return Number.isFinite(stamp) && stamp >= since;
      });
    }
    events = events.slice(-requested);
    return {
      calls: sanitize(events),
      count: events.length,
      sanitized: data.sanitized !== false,
      source_contract: data.contract_version ?? null,
      bounded_native_limit: 200,
      requested_max_results: requested,
    };
  }

  async #readFile(sessionId, requestId, args, signal = null) {
    await this.#selectVariant("read_file");
    if (args.isUrl === true || args.sheet !== undefined || args.range !== undefined || args.options !== undefined) {
      this.#unsupportedMode(
        "read_file",
        "URL/office/PDF-specific read_file modes are not backed by the current native text-file capability.",
        { unsupported_parameters: ["isUrl", "sheet", "range", "options"].filter((key) => args[key] !== undefined) },
      );
    }
    const translated = this.#fileReadArguments(args);
    const response = await this.#invokeNative({
      sessionId,
      requestId,
      tool: "file.read",
      arguments: translated.native,
      signal,
    });
    return this.#projectRead(response.data, translated);
  }

  async #readMultipleFiles(sessionId, requestId, args, signal = null) {
    await this.#selectVariant("read_multiple_files", { variantId: "true_batch" });
    if (!Array.isArray(args.paths) || args.paths.length < 1 || args.paths.length > this.maxBatchFiles) {
      throw new DcCompatibilityError(`paths must contain 1..${this.maxBatchFiles} entries.`, {
        code: "RANGE_ERROR",
        category: "range",
      });
    }
    const paths = args.paths.map((path, index) => nonemptyString(path, `paths[${index}]`));
    const response = await this.#invokeNative({
      sessionId,
      requestId,
      tool: "file.read_multiple",
      arguments: { paths },
      signal,
    });
    const rawResults = Array.isArray(response.data?.results)
      ? response.data.results
      : Array.isArray(response.data?.files)
        ? response.data.files
        : null;
    if (!rawResults || rawResults.length !== paths.length) {
      throw new DcCompatibilityError("Native fs.read_multiple returned an invalid batch result cardinality.", {
        code: "NATIVE_RESULT_INVALID",
        category: "native_result",
        details: {
          expected_count: paths.length,
          actual_count: rawResults?.length ?? null,
        },
      });
    }

    const results = rawResults.map((item, index) => {
      const path = paths[index];
      if (!item || typeof item !== "object" || Array.isArray(item)
          || typeof item.ok !== "boolean"
          || (item.ok && (item.error != null || (
            typeof item.text !== "string" && typeof item.content !== "string"
            && (!item.data || typeof item.data !== "object" || Array.isArray(item.data))
          )))
          || (!item.ok && (!item.error || typeof item.error !== "object"))) {
        throw new DcCompatibilityError("Native fs.read_multiple returned a malformed partial-file record.", {
          code: "NATIVE_RESULT_INVALID",
          category: "native_result",
          details: { index },
        });
      }
      if (item?.path !== undefined && item.path !== path) {
        throw new DcCompatibilityError("Native fs.read_multiple changed deterministic batch ordering.", {
          code: "NATIVE_RESULT_INVALID",
          category: "native_result",
          details: { index, expected_path: path, actual_path: item.path },
        });
      }
      const ok = item.ok;
      if (ok) {
        const data = item?.data && typeof item.data === "object"
          ? clone(item.data)
          : {
            path,
            content: typeof item?.content === "string"
              ? item.content
              : typeof item?.text === "string"
                ? item.text
                : "",
            ...(item?.returned_bytes === undefined ? {} : { returned_bytes: item.returned_bytes }),
          };
        return { path, ok: true, data, error: null };
      }
      const normalized = normalizeDesktopCommanderError(item?.error ?? item, { tool: "read_file" });
      return {
        path,
        ok: false,
        data: null,
        error: {
          code: normalized.code,
          category: normalized.category,
          message: normalized.message,
          retryable: normalized.retryable,
          details: clone(normalized.details),
        },
      };
    });
    return {
      results,
      count: results.length,
      succeeded: results.filter((item) => item.ok).length,
      failed: results.filter((item) => !item.ok).length,
    };
  }

  async #editBlock(sessionId, requestId, args, signal = null) {
    await this.#requireCapabilities("edit_block", ["fs.hash", "fs.edit_text"]);
    const path = nonemptyString(args.path, "path");
    const oldString = nonemptyString(args.old_string, "old_string");
    if (typeof args.new_string !== "string") {
      throw new DcCompatibilityError("new_string must be a string.", {
        code: "INVALID_ARGUMENT",
        category: "argument",
      });
    }
    const expected = integer(args.expected_replacements, "expected_replacements", {
      fallback: 1,
      minimum: 1,
      maximum: 10000,
    });
    if (Buffer.byteLength(oldString, "utf8") > this.maxTextBytes ||
        Buffer.byteLength(args.new_string, "utf8") > this.maxTextBytes) {
      throw new DcCompatibilityError("edit_block replacement exceeds compatibility byte bound.", {
        code: "RANGE_ERROR",
        category: "range",
      });
    }

    const hash = await this.#invokeNative({
      sessionId,
      requestId: `${requestId}:hash`,
      tool: "file.hash",
      arguments: { path, max_bytes: this.maxTextBytes },
      signal,
    });
    const expectedCurrentHash = hash.data?.sha256;
    if (typeof expectedCurrentHash !== "string" || !/^[0-9a-f]{64}$/.test(expectedCurrentHash)) {
      throw new DcCompatibilityError("Native file.hash did not return a valid SHA-256 precondition.", {
        code: "NATIVE_RESULT_INVALID",
        category: "native_result",
      });
    }
    const edit = await this.#invokeNative({
      sessionId,
      requestId: `${requestId}:edit`,
      tool: "file.edit",
      arguments: {
        path,
        old_text: oldString,
        new_text: args.new_string,
        expected_replacements: expected,
        expected_current_hash: expectedCurrentHash,
        ...(typeof args.encoding === "string" && args.encoding ? { encoding: args.encoding } : {}),
      },
      signal,
    });
    return {
      path: edit.data?.path ?? path,
      replacements: edit.data?.replacements ?? expected,
      bytes: edit.data?.bytes ?? null,
      sha256: edit.data?.sha256 ?? null,
      atomic_replace: edit.data?.atomic_replace === true,
    };
  }

  async #writeFile(sessionId, requestId, args, signal = null) {
    const path = nonemptyString(args.path, "path");
    if (typeof args.content !== "string") {
      throw new DcCompatibilityError("content must be a string.", {
        code: "INVALID_ARGUMENT",
        category: "argument",
      });
    }
    const mode = args.mode ?? "rewrite";
    if (!["rewrite", "append"].includes(mode)) {
      throw new DcCompatibilityError("mode must be 'rewrite' or 'append'.", {
        code: "INVALID_ARGUMENT",
        category: "argument",
      });
    }
    const bytes = Buffer.byteLength(args.content, "utf8");
    if (bytes > this.maxTextBytes) {
      throw new DcCompatibilityError(`content exceeds ${this.maxTextBytes} byte compatibility bound.`, {
        code: "RANGE_ERROR",
        category: "range",
        details: { bytes, max_bytes: this.maxTextBytes },
      });
    }
    const action = mode === "append" ? "fs.append_text" : "fs.write_text";
    await this.#requireCapabilities("write_file", [action]);
    const response = await this.#invokeNative({
      sessionId,
      requestId,
      tool: mode === "append" ? "file.append" : "file.write",
      arguments: mode === "append"
        ? { path, text: args.content, create: true }
        : { path, text: args.content, overwrite: true },
      signal,
    });
    return {
      path: response.data?.path ?? path,
      mode,
      bytes: response.data?.bytes ?? bytes,
      sha256: response.data?.sha256 ?? null,
    };
  }

  async #startProcess(sessionId, requestId, args, signal = null) {
    const { variant } = await this.#selectVariant("start_process");
    const command = nonemptyString(args.command, "command");
    if (command.length > MAX_COMMAND_CHARS) {
      throw new DcCompatibilityError("command exceeds compatibility character bound.", {
        code: "RANGE_ERROR",
        category: "range",
      });
    }

    const argv = commandToArgv(command, args.shell);
    let tool;
    let nativeArgs;
    let kind;
    if (variant.id === "pc_core_interactive_session") {
      tool = "shell.session.start";
      nativeArgs = { argv, output_limit_bytes: this.maxTextBytes };
      kind = "session";
    } else if (variant.id === "pc_core_process") {
      tool = "process.start";
      nativeArgs = { argv, output_limit_bytes: this.maxTextBytes };
      kind = "process_pc_core";
    } else {
      tool = "process.start";
      nativeArgs = {
        command,
        ...(args.timeout_ms === undefined ? {} : {
          timeout_ms: integer(args.timeout_ms, "timeout_ms", { minimum: 0, maximum: 600000 }),
        }),
        ...(args.shell === undefined ? {} : { shell: nonemptyString(args.shell, "shell") }),
      };
      kind = "legacy_process";
    }

    const response = await this.#invokeNative({ sessionId, requestId, tool, arguments: nativeArgs, signal });
    const handle = extractNativeHandle(response.data);
    const pid = response.data?.pid;
    if (!handle || !Number.isInteger(pid) || pid < 1) {
      throw new DcCompatibilityError("Native start action must return both a durable handle and numeric pid.", {
        code: "PROCESS_ERROR",
        category: "process",
        details: { handle_present: Boolean(handle), pid: pid ?? null, variant: variant.id },
      });
    }
    const existing = this.#process(sessionId, pid);
    const record = {
      sessionId,
      pid,
      handle,
      kind,
      status: response.data?.running === false ? "finished" : "running",
      running: response.data?.running !== false,
      returncode: response.data?.returncode ?? null,
      lastCursor: null,
      startedAtMs: this.clock(),
      updatedAtMs: this.clock(),
    };
    if (existing) Object.assign(existing, record);
    else this.state.processes.push(record);
    this.#persist();
    return {
      pid,
      status: record.status,
      running: record.running,
      process_handle: handle,
      native_variant: variant.id,
      interactive: kind === "session" || variant.id === "legacy_facade",
      native: sanitize(response.data ?? {}),
    };
  }

  #processOutput(data) {
    if (typeof data?.output === "string") return data.output;
    if (typeof data?.text === "string") return data.text;
    if (Array.isArray(data?.items)) return data.items.join("\n");
    const stdout = typeof data?.stdout === "string" ? data.stdout : "";
    const stderr = typeof data?.stderr === "string" ? data.stderr : "";
    return stdout + stderr;
  }

  async #readProcessOutput(sessionId, requestId, args, signal = null) {
    const pid = integer(args.pid, "pid", { minimum: 1 });
    const record = this.#requireProcess(sessionId, pid);
    const offset = integer(args.offset, "offset", { fallback: 0 });
    const length = integer(args.length, "length", {
      fallback: this.maxReadLines,
      minimum: 1,
      maximum: this.maxReadLines,
    });
    const timeout = integer(args.timeout_ms, "timeout_ms", {
      fallback: 0,
      minimum: 0,
      maximum: 10000,
    });

    let response;
    let nativeVariant;
    if (record.kind === "session") {
      await this.#requireCapabilities("read_process_output", ["shell.session.read"]);
      if (offset !== 0) this.#unsupportedMode("read_process_output", "PC Core shell-session output supports durable byte cursors for repeated reads; absolute/tail line offsets are not losslessly translatable.", { offset });
      response = await this.#invokeNative({
        sessionId,
        requestId,
        tool: "shell.session.read",
        arguments: {
          session_id: record.handle,
          ...(record.lastCursor ? { cursor: record.lastCursor } : {}),
          max_bytes: Math.min(this.maxTextBytes, Math.max(1024, length * 4096)),
          wait_ms: Math.min(timeout, 2000),
        },
        signal,
      });
      record.lastCursor = response.data?.cursor ?? null;
      nativeVariant = "pc_core_session";
    } else if (record.kind === "process_pc_core") {
      await this.#requireCapabilities("read_process_output", ["process.read_output"]);
      if (offset !== 0) this.#unsupportedMode("read_process_output", "PC Core process output supports durable byte cursors for repeated reads; absolute/tail line offsets are not losslessly translatable.", { offset });
      response = await this.#invokeNative({
        sessionId,
        requestId,
        tool: "process.read_output",
        arguments: {
          handle_id: record.handle,
          ...(record.lastCursor ? { cursor: record.lastCursor } : {}),
          max_bytes: Math.min(this.maxTextBytes, Math.max(1024, length * 4096)),
          wait_ms: Math.min(timeout, 2000),
        },
        signal,
      });
      record.lastCursor = response.data?.cursor ?? null;
      nativeVariant = "pc_core_process";
    } else {
      await this.#requireCapabilities("read_process_output", ["process.read"]);
      const page = {
        limit: Math.max(1, Math.min(length, DEFAULT_NATIVE_LIMITS.maxPageSize)),
        ...(offset === 0 && record.lastCursor ? { cursor: record.lastCursor } : {}),
      };
      response = await this.#invokeNative({
        sessionId,
        requestId,
        tool: "process.read",
        arguments: { handle: record.handle, offset, length, timeout_ms: timeout },
        page,
        signal,
      });
      if (offset === 0) record.lastCursor = response.stream?.next_cursor ?? null;
      nativeVariant = "legacy_facade";
    }

    if (typeof response.data?.running === "boolean") record.running = response.data.running;
    if (response.data?.returncode !== undefined) record.returncode = response.data.returncode;
    if (!record.running) record.status = "finished";
    record.updatedAtMs = this.clock();
    this.#persist();
    return {
      pid,
      output: this.#processOutput(response.data),
      running: record.running,
      status: record.status,
      returncode: record.returncode,
      offset,
      length,
      truncated: response.data?.truncated === true ||
        response.data?.stdout_truncated_before_cursor === true ||
        response.data?.stderr_truncated_before_cursor === true,
      cursor: nativeVariant === "legacy_facade" ? record.lastCursor : clone(response.data?.cursor ?? null),
      native_variant: nativeVariant,
    };
  }

  async #listSessions(sessionId, requestId, _args = {}, signal = null) {
    const { variant } = await this.#selectVariant("list_sessions");
    let nativeProcesses = [];
    let completeListing = true;
    let pagesRead = 0;
    if (variant.id === "pc_core") {
      let offset = 0;
      const maxPages = 10;
      for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
        const response = await this.#invokeNative({
          sessionId,
          requestId: pageIndex === 0 ? requestId : `${requestId}:page:${pageIndex}`,
          tool: "process.managed.list",
          arguments: {
            include_stale: true,
            offset,
            max_results: DEFAULT_NATIVE_LIMITS.maxPageSize,
          },
          signal,
        });
        const rows = asArray(response.data, ["handles", "items", "processes"]);
        if (rows.length > DEFAULT_NATIVE_LIMITS.maxPageSize) {
          throw new DcCompatibilityError("Native process listing exceeded the requested page bound.", {
            code: "NATIVE_RESULT_INVALID",
            category: "native_result",
          });
        }
        nativeProcesses.push(...rows);
        pagesRead += 1;
        if (response.data?.has_more !== true) break;
        if (pageIndex + 1 === maxPages) {
          completeListing = false;
          break;
        }
        const nextOffset = Number.isInteger(response.data?.next_offset)
          ? response.data.next_offset : offset + rows.length;
        if (rows.length === 0 || nextOffset <= offset) {
          throw new DcCompatibilityError("Native process listing continuation did not advance.", {
            code: "NATIVE_RESULT_INVALID",
            category: "native_result",
          });
        }
        offset = nextOffset;
      }
    } else {
      const response = await this.#invokeNative({
        sessionId,
        requestId,
        tool: "process.list",
        arguments: {},
        page: { limit: DEFAULT_NATIVE_LIMITS.maxPageSize },
        signal,
      });
      nativeProcesses = asArray(response.data, ["processes", "items", "handles"]);
      completeListing = response.stream?.next_cursor == null
        && response.data?.has_more !== true && response.data?.truncated !== true;
      pagesRead = 1;
    }

    const byHandle = new Map(
      nativeProcesses
        .filter((item) => typeof item?.handle_id === "string")
        .map((item) => [item.handle_id, item]),
    );
    const byPid = new Map(
      nativeProcesses
        .filter((item) => Number.isInteger(item?.pid) && item.pid > 0)
        .map((item) => [item.pid, item]),
    );
    const sessions = this.state.processes
      .filter((item) => item.sessionId === sessionId)
      .map((item) => {
        const native = byHandle.get(item.handle) ?? byPid.get(item.pid) ?? null;
        if (native) {
          const nativeStatus = native.status;
          if (typeof native.running === "boolean") item.running = native.running;
          else if (typeof nativeStatus === "string") {
            item.running = ["running", "blocked", "waiting"].includes(nativeStatus);
          }
          if (native.returncode !== undefined) item.returncode = native.returncode;
          if (!item.running && item.status === "running") item.status = nativeStatus ?? "finished";
          if (nativeStatus === "stale_after_restart") {
            item.running = false;
            item.status = "stale_after_restart";
          }
        } else if (completeListing && nativeProcesses.length && item.status === "running") {
          item.running = false;
          item.status = "finished";
        }
        item.updatedAtMs = this.clock();
        return {
          pid: item.pid,
          running: item.running,
          status: item.status,
          returncode: item.returncode,
          process_handle: item.handle,
        };
      })
      .sort((a, b) => a.pid - b.pid);
    this.#persist();
    return {
      sessions,
      count: sessions.length,
      native_variant: variant.id,
      native_pages_read: pagesRead,
      native_listing_complete: completeListing,
      truncated: !completeListing,
    };
  }

  async #forceTerminate(sessionId, requestId, args, signal = null) {
    const pid = integer(args.pid, "pid", { minimum: 1 });
    const record = this.#requireProcess(sessionId, pid);
    let tool;
    let nativeArgs;
    if (record.kind === "session") {
      await this.#requireCapabilities("force_terminate", ["shell.session.terminate"]);
      tool = "shell.session.terminate";
      nativeArgs = { session_id: record.handle, grace_ms: 0 };
    } else if (record.kind === "process_pc_core") {
      await this.#requireCapabilities("force_terminate", ["process.terminate"]);
      tool = "process.terminate";
      nativeArgs = { handle_id: record.handle, grace_ms: 0 };
    } else {
      await this.#requireCapabilities("force_terminate", ["process.terminate"]);
      tool = "process.terminate";
      nativeArgs = { handle: record.handle };
    }
    const response = await this.#invokeNative({ sessionId, requestId, tool, arguments: nativeArgs, signal });
    record.running = false;
    record.status = "terminated";
    record.returncode = response.data?.returncode ?? record.returncode;
    record.updatedAtMs = this.clock();
    this.#persist();
    return {
      pid,
      terminated: true,
      already_exited: response.data?.already_exited === true,
      returncode: record.returncode,
      native_variant: record.kind,
    };
  }

  async #interactWithProcess(sessionId, requestId, args, signal = null) {
    const pid = integer(args.pid, "pid", { minimum: 1 });
    const record = this.#requireProcess(sessionId, pid);
    if (typeof args.input !== "string") {
      throw new DcCompatibilityError("input must be a string.", {
        code: "INVALID_ARGUMENT",
        category: "argument",
      });
    }
    let response;
    let nativeVariant;
    if (record.kind === "session") {
      await this.#requireCapabilities("interact_with_process", ["shell.session.write_stdin"]);
      response = await this.#invokeNative({
        sessionId,
        requestId,
        tool: "shell.session.write_stdin",
        arguments: { session_id: record.handle, text: args.input, append_newline: false, sensitive: false },
        signal,
      });
      nativeVariant = "pc_core_session";
    } else if (record.kind === "legacy_process") {
      await this.#requireCapabilities("interact_with_process", ["process.interact"]);
      response = await this.#invokeNative({
        sessionId,
        requestId,
        tool: "process.interact",
        arguments: {
          handle: record.handle,
          input: args.input,
          ...(args.timeout_ms === undefined ? {} : { timeout_ms: integer(args.timeout_ms, "timeout_ms", { minimum: 0, maximum: 10000 }) }),
        },
        signal,
      });
      nativeVariant = "legacy_facade";
    } else {
      throw new DcCompatibilityError("This managed process was not started with an interactive stdin capability.", {
        code: "CAPABILITY_UNAVAILABLE",
        category: "capability",
        details: { pid, native_kind: record.kind },
      });
    }
    return {
      pid,
      native: sanitize(response.data ?? {}),
      native_variant: nativeVariant,
      wait_for_prompt_supported: false,
      verbose_timing_supported: false,
    };
  }

  async #listProcesses(sessionId, requestId, _args = {}, signal = null) {
    const { variant } = await this.#selectVariant("list_processes");
    const nativeTool = variant.native_tools[0];
    const response = await this.#invokeNative({
      sessionId,
      requestId,
      tool: nativeTool,
      arguments: nativeTool === "process.list"
        ? { offset: 0, max_results: DEFAULT_NATIVE_LIMITS.maxPageSize }
        : {},
      ...(nativeTool === "system.process.list" ? { page: { limit: DEFAULT_NATIVE_LIMITS.maxPageSize } } : {}),
      signal,
    });
    const processes = asArray(response.data, ["processes", "items"]);
    return {
      processes: sanitize(processes),
      count: processes.length,
      truncated: response.data?.has_more === true ||
        response.stream?.next_cursor !== null && response.stream?.next_cursor !== undefined,
      native_variant: variant.id,
    };
  }

  async #killProcess(sessionId, requestId, args, signal = null) {
    const { variant } = await this.#selectVariant("kill_process");
    const pid = integer(args.pid, "pid", { minimum: 1 });
    const listingTool = variant.native_tools[0];
    const listed = await this.#invokeNative({
      sessionId,
      requestId: `${requestId}:lookup`,
      tool: listingTool,
      arguments: listingTool === "process.list"
        ? { pid, offset: 0, max_results: 1 }
        : { pid },
      ...(listingTool === "system.process.list" ? { page: { limit: 1 } } : {}),
      signal,
    });
    const processes = asArray(listed.data, ["processes", "items"]);
    const target = processes.find((item) => item?.pid === pid) ?? processes[0] ?? null;
    const expectedName = target?.name ?? target?.executable ?? target?.command ?? null;
    if (!target || typeof expectedName !== "string" || !expectedName) {
      throw new DcCompatibilityError("Process identity could not be resolved before kill.", {
        code: "PROCESS_NOT_FOUND",
        category: "process",
        details: { pid },
      });
    }
    const killed = await this.#invokeNative({
      sessionId,
      requestId: `${requestId}:kill`,
      tool: "system.process.kill",
      arguments: { pid, expected_name: expectedName },
      signal,
    });
    return {
      pid,
      expected_name: expectedName,
      terminated: killed.data?.terminated !== false,
      native: sanitize(killed.data ?? {}),
    };
  }

  async invoke(envelope, { signal = null } = {}) {
    const requestId = envelope?.request_id;
    const sessionId = envelope?.session_id;
    const toolName = envelope?.tool;
    try {
      if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
        throw new DcCompatibilityError("Compatibility request must be an object.", {
          code: "INVALID_ARGUMENT",
          category: "argument",
        });
      }
      nonemptyString(sessionId, "session_id");
      nonemptyString(requestId, "request_id");
      nonemptyString(toolName, "tool");
      const definition = desktopCommanderToolDefinition(toolName);
      if (!definition) {
        throw new DcCompatibilityError(`Unknown Desktop Commander compatibility tool '${toolName}'.`, {
          code: "TOOL_NOT_FOUND",
          category: "tool",
        });
      }
      const args = envelope.arguments ?? {};
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        throw new DcCompatibilityError("arguments must be an object.", {
          code: "INVALID_ARGUMENT",
          category: "argument",
        });
      }

      let data;
      switch (toolName) {
        case "list_devices":
          data = await this.#listDevices(sessionId, requestId, signal);
          break;
        case "ping":
          data = await this.#ping(sessionId, requestId, args, signal);
          break;
        case "shutdown":
          data = await this.#shutdown(sessionId, requestId, args, signal);
          break;
        case "get_config":
          data = await this.#getConfig(sessionId, requestId, args, signal);
          break;
        case "set_config_value":
          data = await this.#setConfigValue(sessionId, requestId, args, signal);
          break;
        case "read_file":
          data = await this.#readFile(sessionId, requestId, args, signal);
          break;
        case "read_multiple_files":
          data = await this.#readMultipleFiles(sessionId, requestId, args, signal);
          break;
        case "write_file":
          data = await this.#writeFile(sessionId, requestId, args, signal);
          break;
        case "write_pdf":
          data = await this.#writePdf(sessionId, requestId, args, signal);
          break;
        case "create_directory":
          data = await this.#createDirectory(sessionId, requestId, args, signal);
          break;
        case "list_directory":
          data = await this.#listDirectory(sessionId, requestId, args, signal);
          break;
        case "move_file":
          data = await this.#moveFile(sessionId, requestId, args, signal);
          break;
        case "start_search":
          data = await this.#startSearch(sessionId, requestId, args, signal);
          break;
        case "get_more_search_results":
          data = await this.#getMoreSearchResults(sessionId, requestId, args, signal);
          break;
        case "stop_search":
          data = await this.#stopSearch(sessionId, requestId, args, signal);
          break;
        case "list_searches":
          data = await this.#listSearches(sessionId, requestId, args, signal);
          break;
        case "get_file_info":
          data = await this.#getFileInfo(sessionId, requestId, args, signal);
          break;
        case "edit_block":
          data = await this.#editBlock(sessionId, requestId, args, signal);
          break;
        case "start_process":
          data = await this.#startProcess(sessionId, requestId, args, signal);
          break;
        case "read_process_output":
          data = await this.#readProcessOutput(sessionId, requestId, args, signal);
          break;
        case "interact_with_process":
          data = await this.#interactWithProcess(sessionId, requestId, args, signal);
          break;
        case "force_terminate":
          data = await this.#forceTerminate(sessionId, requestId, args, signal);
          break;
        case "list_sessions":
          data = await this.#listSessions(sessionId, requestId, args, signal);
          break;
        case "list_processes":
          data = await this.#listProcesses(sessionId, requestId, args, signal);
          break;
        case "kill_process":
          data = await this.#killProcess(sessionId, requestId, args, signal);
          break;
        case "who_am_i":
          data = await this.#whoAmI(sessionId, requestId, signal);
          break;
        case "get_usage_stats":
          data = await this.#getUsageStats(sessionId, requestId, args, signal);
          break;
        case "get_recent_tool_calls":
          data = await this.#getRecentToolCalls(sessionId, requestId, args, signal);
          break;
        default:
          throw new DcCompatibilityError(`Tool '${toolName}' has no compatibility translator.`, {
            code: "TOOL_NOT_FOUND",
            category: "tool",
          });
      }
      return responseEnvelope({
        requestId,
        sessionId,
        tool: toolName,
        status: "completed",
        data,
      });
    } catch (error) {
      if (error instanceof NativeStatusSignal) {
        return responseEnvelope({
          requestId: requestId ?? null,
          sessionId: sessionId ?? null,
          tool: toolName ?? null,
          status: error.response.status,
          data: error.response.status === "reconciliation_required"
            ? { ...clone(error.response.data ?? {}), lookup_required: true, automatic_replay: false }
            : clone(error.response.data ?? null),
          error: null,
        });
      }
      const normalized = normalizeDesktopCommanderError(error, { tool: toolName });
      return responseEnvelope({
        requestId: requestId ?? null,
        sessionId: sessionId ?? null,
        tool: toolName ?? null,
        status: "error",
        error: {
          code: normalized.code,
          category: normalized.category,
          message: normalized.message,
          retryable: normalized.retryable,
          details: clone(normalized.details),
        },
      });
    }
  }

  debugSnapshot() {
    return clone(this.state);
  }
}
