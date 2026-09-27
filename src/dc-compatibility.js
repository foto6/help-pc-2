import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  NATIVE_CONTROL_PROTOCOL_V1,
  DEFAULT_NATIVE_LIMITS,
} from "./native-registry.js";
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

function normalizedPath(value) {
  return value.replaceAll("/", "\\").replace(/\\+/g, "\\").toLowerCase();
}

function hasProtectedPath(value) {
  if (typeof value === "string") {
    const candidate = normalizedPath(value);
    return candidate === "e:\\manhwa" || candidate.startsWith("e:\\manhwa\\");
  }
  if (Array.isArray(value)) return value.some(hasProtectedPath);
  if (value && typeof value === "object") return Object.values(value).some(hasProtectedPath);
  return false;
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

function defaultState() {
  return { version: STORE_VERSION, processes: [] };
}

function extractNativeHandle(data) {
  if (!data || typeof data !== "object") return null;
  for (const key of ["process_handle", "session_handle", "handle"]) {
    if (typeof data[key] === "string" && data[key]) return data[key];
  }
  return null;
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
  if (/enoent|not[_ -]?found|no such file|missing file/.test(haystack)) {
    normalizedCode = "FILE_NOT_FOUND";
    normalizedCategory = "filesystem";
  } else if (/eacces|eperm|access[_ -]?denied|permission denied|unauthori[sz]ed/.test(haystack)) {
    normalizedCode = "ACCESS_DENIED";
    normalizedCategory = "filesystem";
  } else if (/stale.*handle|stale_process_handle|invalid.*handle|unknown.*handle/.test(haystack)) {
    normalizedCode = "STALE_HANDLE";
    normalizedCategory = "process";
  } else if (/replacement.*mismatch|replacement count|expected_replacements/.test(haystack)) {
    normalizedCode = "REPLACEMENT_CONFLICT";
    normalizedCategory = "conflict";
  } else if (/range|bounds|offset|page_limit|too large|exceeds.*bound/.test(haystack)) {
    normalizedCode = "RANGE_ERROR";
    normalizedCategory = "range";
  } else if ((tool && tool.includes("process")) || /process|terminate|spawn|exited/.test(haystack)) {
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
      nativeManifest: await this.facade.capabilities(),
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
    const manifest = await this.facade.capabilities();
    const advertised = new Set(Array.isArray(manifest?.executor?.actions) ? manifest.executor.actions : []);
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

  async #requireAvailableVariant(toolName, variantIds = null) {
    const definition = desktopCommanderToolDefinition(toolName);
    if (!definition) {
      throw new DcCompatibilityError(`Unknown Desktop Commander compatibility tool '${toolName}'.`, {
        code: "TOOL_NOT_FOUND",
        category: "tool",
      });
    }
    const manifest = await this.facade.capabilities();
    const advertised = new Set(Array.isArray(manifest?.executor?.actions) ? manifest.executor.actions : []);
    const allowedIds = variantIds === null
      ? null
      : new Set(Array.isArray(variantIds) ? variantIds : [variantIds]);
    const candidates = definition.capability_variants.filter(
      (variant) => allowedIds === null || allowedIds.has(variant.id),
    );
    for (const variant of candidates) {
      if (variant.executor_actions.every((action) => advertised.has(action))) {
        return { manifest, variant };
      }
    }
    throw new DcCompatibilityError(
      `Desktop Commander tool '${toolName}' is unavailable because no required native capability variant is present.`,
      {
        code: "CAPABILITY_UNAVAILABLE",
        category: "capability",
        details: {
          executor_digest: manifest?.executor?.digest ?? null,
          required_variants: candidates.map((variant) => ({
            id: variant.id,
            executor_actions: [...variant.executor_actions],
            missing_executor_actions: variant.executor_actions.filter((action) => !advertised.has(action)),
          })),
        },
      },
    );
  }

  #nativeArgs(args) {
    const { deviceId: _deviceId, ...nativeArgs } = args ?? {};
    return nativeArgs;
  }

  async #invokeNative({ sessionId, requestId, tool, arguments: args = {}, page = undefined, signal = undefined }) {
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
    if (response?.status === "error") {
      throw normalizeDesktopCommanderError(response, { tool });
    }
    if (response?.status !== "completed") {
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

  async #directCompatibilityCall(toolName, nativeTool, sessionId, requestId, args, signal, {
    variantIds = null,
    translate = (value) => this.#nativeArgs(value),
    project = (data) => clone(data),
    page = undefined,
  } = {}) {
    await this.#requireAvailableVariant(toolName, variantIds);
    const response = await this.#invokeNative({
      sessionId,
      requestId,
      tool: nativeTool,
      arguments: translate(args),
      ...(page === undefined ? {} : { page }),
      signal,
    });
    return project(response.data, response);
  }

  async #listDevices(sessionId, requestId, args, signal) {
    const data = await this.#directCompatibilityCall(
      "list_devices", "compat.device.info", sessionId, requestId, args, signal,
      { translate: () => ({}) },
    );
    return { devices: [data], count: 1, local_only: true };
  }

  async #ping(sessionId, requestId, args, signal) {
    const health = await this.#directCompatibilityCall(
      "ping", "compat.health.get", sessionId, requestId, args, signal,
      { translate: () => ({}) },
    );
    return {
      pong: true,
      timestamp: new Date(this.clock()).toISOString(),
      health,
      local_only: true,
    };
  }

  async #getConfig(sessionId, requestId, args, signal) {
    return this.#directCompatibilityCall(
      "get_config", "compat.config.get", sessionId, requestId, args, signal,
      { translate: () => ({}) },
    );
  }

  async #setConfigValue(sessionId, requestId, args, signal) {
    return this.#directCompatibilityCall(
      "set_config_value", "compat.config.set", sessionId, requestId, args, signal,
      { translate: (value) => ({ key: nonemptyString(value.key, "key"), value: clone(value.value) }) },
    );
  }

  async #createDirectory(sessionId, requestId, args, signal) {
    await this.#requireAvailableVariant("create_directory");
    const path = nonemptyString(args.path, "path");
    const response = await this.#invokeNative({
      sessionId,
      requestId,
      tool: "compat.fs.mkdir",
      arguments: { path, parents: true, exist_ok: true },
      signal,
    });
    return clone(response.data);
  }

  async #listDirectory(sessionId, requestId, args, signal) {
    await this.#requireAvailableVariant("list_directory");
    const path = nonemptyString(args.path, "path");
    const depth = integer(args.depth, "depth", { fallback: 2, minimum: 1, maximum: 32 });
    const response = await this.#invokeNative({
      sessionId,
      requestId,
      tool: "compat.fs.list",
      arguments: {
        path,
        offset: 0,
        max_entries: DEFAULT_NATIVE_LIMITS.maxPageSize,
        include_hidden: false,
      },
      signal,
    });
    return { ...clone(response.data), requested_depth: depth };
  }

  async #moveFile(sessionId, requestId, args, signal) {
    return this.#directCompatibilityCall(
      "move_file", "compat.fs.move", sessionId, requestId, args, signal,
      { translate: (value) => ({
        source: nonemptyString(value.source, "source"),
        destination: nonemptyString(value.destination, "destination"),
        overwrite: false,
      }) },
    );
  }

  async #getFileInfo(sessionId, requestId, args, signal) {
    return this.#directCompatibilityCall(
      "get_file_info", "compat.fs.stat", sessionId, requestId, args, signal,
      { translate: (value) => ({ path: nonemptyString(value.path, "path") }) },
    );
  }

  async #readFile(sessionId, requestId, args, signal) {
    await this.#requireCapabilities("read_file", ["fs.read_text"]);
    const translated = this.#fileReadArguments(args);
    const limit = Math.max(1, Math.min(translated.length, DEFAULT_NATIVE_LIMITS.maxPageSize));
    const response = await this.#invokeNative({
      sessionId,
      requestId,
      tool: "file.read",
      arguments: translated.native,
      page: { limit },
      signal,
    });
    return this.#projectRead(response.data, translated);
  }

  async #readMultipleFiles(sessionId, requestId, args, signal) {
    const { variant } = await this.#requireAvailableVariant("read_multiple_files");
    if (!Array.isArray(args.paths) || args.paths.length < 1 || args.paths.length > this.maxBatchFiles) {
      throw new DcCompatibilityError(`paths must contain 1..${this.maxBatchFiles} entries.`, {
        code: "RANGE_ERROR",
        category: "range",
      });
    }
    const paths = args.paths.map((path, index) => nonemptyString(path, `paths[${index}]`));

    if (variant.id === "native_batch") {
      const response = await this.#invokeNative({
        sessionId,
        requestId,
        tool: "compat.file.read_many",
        arguments: { paths },
        signal,
      });
      const nativeResults = Array.isArray(response.data?.results) ? response.data.results : [];
      const results = paths.map((path, index) => {
        const item = nativeResults[index];
        if (item?.ok === true) {
          const text = typeof item.text === "string" ? item.text : "";
          return {
            path,
            ok: true,
            data: {
              path: item.path ?? path,
              content: text,
              offset: 0,
              length: this.maxReadLines,
              returned_bytes: item.returned_bytes ?? Buffer.byteLength(text, "utf8"),
              truncated: item.truncated === true,
              next_line: null,
              file_bytes: item.file_bytes ?? null,
              sha256: item.sha256 ?? null,
            },
            error: null,
          };
        }
        return {
          path,
          ok: false,
          data: null,
          error: {
            code: item?.error?.code ?? "NATIVE_BATCH_READ_ERROR",
            category: "filesystem",
            message: item?.error?.message ?? "Native batch read failed for this path.",
            retryable: item?.error?.retryable === true,
            details: clone(item?.error?.details ?? null),
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

    const results = [];
    for (let index = 0; index < paths.length; index += 1) {
      const path = paths[index];
      try {
        const translated = this.#fileReadArguments({ path, offset: 0, length: this.maxReadLines });
        const response = await this.#invokeNative({
          sessionId,
          requestId: `${requestId}:file:${index}`,
          tool: "file.read",
          arguments: translated.native,
          page: { limit: DEFAULT_NATIVE_LIMITS.maxPageSize },
          signal,
        });
        results.push({
          path,
          ok: true,
          data: this.#projectRead(response.data, translated),
          error: null,
        });
      } catch (error) {
        if (error instanceof NativeStatusSignal) {
          results.push({
            path,
            ok: false,
            data: null,
            error: {
              code: "NATIVE_REQUEST_INCOMPLETE",
              category: "native_status",
              message: `Native request is ${error.response?.status ?? "incomplete"}.`,
              retryable: true,
              details: { status: error.response?.status ?? null },
            },
          });
          continue;
        }
        const normalized = normalizeDesktopCommanderError(error, { tool: "read_file" });
        results.push({
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
        });
      }
    }
    return {
      results,
      count: results.length,
      succeeded: results.filter((item) => item.ok).length,
      failed: results.filter((item) => !item.ok).length,
    };
  }

  async #editBlock(sessionId, requestId, args, signal) {
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

  async #writeFile(sessionId, requestId, args, signal) {
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

  async #startProcess(sessionId, requestId, args, signal) {
    await this.#requireCapabilities("start_process", ["process.start"]);
    const command = nonemptyString(args.command, "command");
    if (command.length > MAX_COMMAND_CHARS) {
      throw new DcCompatibilityError("command exceeds compatibility character bound.", {
        code: "RANGE_ERROR",
        category: "range",
      });
    }
    const response = await this.#invokeNative({
      sessionId,
      requestId,
      tool: "process.start",
      arguments: {
        command,
        ...(args.timeout_ms === undefined ? {} : {
          timeout_ms: integer(args.timeout_ms, "timeout_ms", { minimum: 0, maximum: 600000 }),
        }),
        ...(args.shell === undefined ? {} : { shell: nonemptyString(args.shell, "shell") }),
      },
      signal,
    });
    const handle = extractNativeHandle(response.data);
    const pid = response.data?.pid;
    if (!handle || !Number.isInteger(pid) || pid < 1) {
      throw new DcCompatibilityError("Native process.start must return both process_handle and numeric pid.", {
        code: "PROCESS_ERROR",
        category: "process",
        details: { handle_present: Boolean(handle), pid: pid ?? null },
      });
    }
    const existing = this.#process(sessionId, pid);
    const record = {
      sessionId,
      pid,
      handle,
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
      native: clone(response.data),
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

  async #readProcessOutput(sessionId, requestId, args, signal) {
    const { variant } = await this.#requireAvailableVariant("read_process_output");
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
    if (variant.id === "pc_core") {
      const maxBytes = Math.min(this.maxTextBytes, Math.max(1024, length * 1024));
      const nativeArgs = {
        handle_id: record.handle,
        max_bytes: maxBytes,
        wait_ms: Math.min(timeout, 2000),
        ...(offset < 0
          ? { tail_bytes: Math.min(maxBytes, Math.max(1, -offset * 1024)) }
          : offset === 0 && record.lastCursor
            ? { cursor: clone(record.lastCursor) }
            : {}),
      };
      response = await this.#invokeNative({
        sessionId,
        requestId,
        tool: "compat.process.read_output",
        arguments: nativeArgs,
        signal,
      });
      if (offset === 0) record.lastCursor = clone(response.data?.cursor ?? null);
    } else {
      const nativeArgs = {
        handle: record.handle,
        offset,
        length,
        timeout_ms: timeout,
      };
      const page = {
        limit: Math.max(1, Math.min(length, DEFAULT_NATIVE_LIMITS.maxPageSize)),
        ...(offset === 0 && record.lastCursor ? { cursor: record.lastCursor } : {}),
      };
      response = await this.#invokeNative({
        sessionId,
        requestId,
        tool: "process.read",
        arguments: nativeArgs,
        page,
        signal,
      });
      if (offset === 0) record.lastCursor = response.stream?.next_cursor ?? null;
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
    };
  }

  async #listSessions(sessionId, requestId, signal) {
    const { variant } = await this.#requireAvailableVariant("list_sessions");
    let response;
    let nativeProcesses;
    if (variant.id === "pc_core") {
      response = await this.#invokeNative({
        sessionId,
        requestId,
        tool: "compat.process.managed.list",
        arguments: {
          kind: "process",
          include_stale: true,
          offset: 0,
          max_results: DEFAULT_NATIVE_LIMITS.maxPageSize,
        },
        signal,
      });
      nativeProcesses = Array.isArray(response.data?.handles) ? response.data.handles : [];
    } else {
      response = await this.#invokeNative({
        sessionId,
        requestId,
        tool: "process.list",
        arguments: {},
        page: { limit: DEFAULT_NATIVE_LIMITS.maxPageSize },
        signal,
      });
      nativeProcesses = Array.isArray(response.data?.processes)
        ? response.data.processes
        : Array.isArray(response.data?.items)
          ? response.data.items
          : [];
    }

    const livePids = new Set(
      nativeProcesses
        .filter((item) => item?.owned_by_current_gateway !== false &&
          !["finished", "terminated", "exited", "stale"].includes(String(item?.status ?? "").toLowerCase()))
        .map((item) => item?.pid)
        .filter((pid) => Number.isInteger(pid) && pid > 0),
    );
    const sessions = this.state.processes
      .filter((item) => item.sessionId === sessionId)
      .map((item) => {
        if (item.status === "running" && nativeProcesses.length && !livePids.has(item.pid)) {
          item.running = false;
          item.status = "finished";
          item.updatedAtMs = this.clock();
        }
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
    return { sessions, count: sessions.length };
  }

  async #forceTerminate(sessionId, requestId, args, signal) {
    await this.#requireCapabilities("force_terminate", ["process.terminate"]);
    const pid = integer(args.pid, "pid", { minimum: 1 });
    const record = this.#requireProcess(sessionId, pid);
    const response = await this.#invokeNative({
      sessionId,
      requestId,
      tool: "process.terminate",
      arguments: { handle: record.handle },
      signal,
    });
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
    };
  }

  async #writePdf(sessionId, requestId, args, signal) {
    await this.#requireAvailableVariant("write_pdf");
    const path = nonemptyString(args.path, "path");
    if (typeof args.content !== "string" && !Array.isArray(args.content)) {
      throw new DcCompatibilityError("write_pdf content must be markdown text or an operation array.", {
        code: "INVALID_ARGUMENT",
        category: "argument",
      });
    }
    const response = await this.#invokeNative({
      sessionId,
      requestId,
      tool: "compat.file.write_pdf",
      arguments: {
        path,
        content: clone(args.content),
        ...(args.outputPath === undefined ? {} : { output_path: nonemptyString(args.outputPath, "outputPath") }),
        ...(args.options === undefined ? {} : { options: clone(args.options) }),
      },
      signal,
    });
    return clone(response.data);
  }

  async #startSearch(sessionId, requestId, args, signal) {
    await this.#requireAvailableVariant("start_search");
    const nativeArgs = {
      path: nonemptyString(args.path, "path"),
      pattern: nonemptyString(args.pattern, "pattern"),
      search_type: args.searchType ?? "files",
      literal_search: args.literalSearch === true,
      ignore_case: args.ignoreCase !== false,
      include_hidden: args.includeHidden === true,
      context_lines: integer(args.contextLines, "contextLines", { fallback: 5, minimum: 0, maximum: 100 }),
      max_results: integer(args.maxResults, "maxResults", { fallback: 100, minimum: 1, maximum: 100000 }),
      timeout_ms: integer(args.timeout_ms, "timeout_ms", { fallback: 30000, minimum: 1, maximum: 600000 }),
      // PC-Core search.start intentionally has no filePattern/earlyTermination fields.
      // Those optional Desktop Commander controls fail explicitly below instead of being ignored.
    };
    if (args.filePattern !== undefined || args.earlyTermination !== undefined) {
      throw new DcCompatibilityError(
        "The current native search capability does not publish filePattern or earlyTermination controls.",
        {
          code: "CAPABILITY_UNAVAILABLE",
          category: "capability",
          details: {
            unsupported_arguments: [
              ...(args.filePattern === undefined ? [] : ["filePattern"]),
              ...(args.earlyTermination === undefined ? [] : ["earlyTermination"]),
            ],
          },
        },
      );
    }
    const response = await this.#invokeNative({
      sessionId, requestId, tool: "compat.search.start", arguments: nativeArgs, signal,
    });
    const searchId = response.data?.search_id ?? response.data?.session_id ?? response.data?.id ?? null;
    return {
      ...clone(response.data),
      ...(searchId === null ? {} : { sessionId: searchId }),
    };
  }

  async #readSearch(sessionId, requestId, args, signal) {
    await this.#requireAvailableVariant("get_more_search_results");
    const searchId = nonemptyString(args.sessionId, "sessionId");
    const offset = integer(args.offset, "offset", { fallback: 0, minimum: -1000000, maximum: 1000000 });
    const length = integer(args.length, "length", { fallback: 100, minimum: 1, maximum: 1000 });
    const response = await this.#invokeNative({
      sessionId,
      requestId,
      tool: "compat.search.read",
      arguments: { search_id: searchId, offset, length },
      signal,
    });
    return { sessionId: searchId, ...clone(response.data) };
  }

  async #stopSearch(sessionId, requestId, args, signal) {
    await this.#requireAvailableVariant("stop_search");
    const searchId = nonemptyString(args.sessionId, "sessionId");
    const response = await this.#invokeNative({
      sessionId,
      requestId,
      tool: "compat.search.stop",
      arguments: { search_id: searchId },
      signal,
    });
    return { sessionId: searchId, ...clone(response.data) };
  }

  async #listSearches(sessionId, requestId, args, signal) {
    return this.#directCompatibilityCall(
      "list_searches", "compat.search.list", sessionId, requestId, args, signal,
      { translate: () => ({}) },
    );
  }

  async #interactWithProcess(sessionId, requestId, args, signal) {
    const { variant } = await this.#requireAvailableVariant("interact_with_process");
    const pid = integer(args.pid, "pid", { minimum: 1 });
    const record = this.#requireProcess(sessionId, pid);
    if (typeof args.input !== "string") {
      throw new DcCompatibilityError("input must be a string.", {
        code: "INVALID_ARGUMENT",
        category: "argument",
      });
    }
    const response = await this.#invokeNative({
      sessionId,
      requestId,
      tool: variant.id === "pc_core" ? "compat.shell.session.write_stdin" : "process.interact",
      arguments: variant.id === "pc_core"
        ? {
          session_id: record.handle,
          text: args.input,
          append_newline: false,
          sensitive: false,
        }
        : { handle: record.handle, input: args.input },
      signal,
    });
    record.updatedAtMs = this.clock();
    this.#persist();
    return { pid, ...clone(response.data) };
  }

  async #listProcesses(sessionId, requestId, args, signal) {
    const { variant } = await this.#requireAvailableVariant("list_processes");
    if (variant.id === "pc_core") {
      return this.#directCompatibilityCall(
        "list_processes", "compat.process.list_all", sessionId, requestId, args, signal,
        {
          variantIds: "pc_core",
          translate: () => ({ offset: 0, max_results: DEFAULT_NATIVE_LIMITS.maxPageSize }),
        },
      );
    }
    const response = await this.#invokeNative({
      sessionId,
      requestId,
      tool: "system.process.list",
      arguments: {},
      page: { limit: DEFAULT_NATIVE_LIMITS.maxPageSize },
      signal,
    });
    return clone(response.data);
  }

  async #killProcess(sessionId, requestId, args, signal) {
    const { variant } = await this.#requireAvailableVariant("kill_process");
    const pid = integer(args.pid, "pid", { minimum: 1 });
    let killArguments;
    if (variant.id === "pc_core") {
      const inspected = await this.#invokeNative({
        sessionId,
        requestId: `${requestId}:inspect`,
        tool: "compat.process.list_all",
        arguments: { pid, offset: 0, max_results: 1 },
        signal,
      });
      const processes = Array.isArray(inspected.data?.processes)
        ? inspected.data.processes
        : Array.isArray(inspected.data?.items)
          ? inspected.data.items
          : [];
      const match = processes.find((item) => item?.pid === pid) ?? null;
      const expectedName = match?.name;
      if (typeof expectedName !== "string" || !expectedName) {
        throw new DcCompatibilityError("Process identity is unavailable for safe termination.", {
          code: "PROCESS_ERROR",
          category: "process",
          details: { pid },
        });
      }
      killArguments = { pid, expected_name: expectedName, exit_code: 1 };
    } else {
      killArguments = { pid, force: true };
    }
    const response = await this.#invokeNative({
      sessionId,
      requestId,
      tool: "system.process.kill",
      arguments: killArguments,
      signal,
    });
    return { pid, ...clone(response.data) };
  }

  async #shutdown(sessionId, requestId, args, signal) {
    return this.#directCompatibilityCall(
      "shutdown", "compat.device.shutdown", sessionId, requestId, args, signal,
      { translate: () => ({}) },
    );
  }

  async #whoAmI(sessionId, requestId, args, signal) {
    const identity = await this.#directCompatibilityCall(
      "who_am_i", "compat.identity.get", sessionId, requestId, args, signal,
      { translate: () => ({}) },
    );
    return {
      identity_kind: "native_controller",
      identity,
      vendor_account_identity: null,
    };
  }

  async #usageStats(sessionId, requestId, args, signal) {
    const metrics = await this.#directCompatibilityCall(
      "get_usage_stats", "compat.metrics.get", sessionId, requestId, args, signal,
      { translate: () => ({}) },
    );
    return {
      source: "native_operation_metrics",
      vendor_billing_telemetry: null,
      metrics,
    };
  }

  async #recentToolCalls(sessionId, requestId, args, signal) {
    const limit = integer(args.maxResults, "maxResults", { fallback: 50, minimum: 1, maximum: 1000 });
    const raw = await this.#directCompatibilityCall(
      "get_recent_tool_calls", "compat.audit.history", sessionId, requestId, args, signal,
      { translate: () => ({ limit }) },
    );
    const key = Array.isArray(raw?.events) ? "events" : Array.isArray(raw?.calls) ? "calls" : null;
    if (key === null) return raw;
    const requestedTool = args.toolName === undefined ? null : nonemptyString(args.toolName, "toolName");
    const sinceMs = args.since === undefined ? null : Date.parse(nonemptyString(args.since, "since"));
    const filtered = raw[key].filter((item) => {
      if (requestedTool !== null) {
        const observed = item?.tool ?? item?.action ?? item?.name ?? null;
        if (observed !== requestedTool) return false;
      }
      if (sinceMs !== null) {
        const timestamp = item?.timestamp ?? item?.at ?? item?.created_at ?? item?.time ?? null;
        const observedMs = typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
        if (!Number.isFinite(observedMs) || observedMs < sinceMs) return false;
      }
      return true;
    }).slice(-limit);
    return {
      ...clone(raw),
      [key]: filtered,
      count: filtered.length,
    };
  }

  async invoke(envelope, { signal = undefined } = {}) {
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
      if (hasProtectedPath(args)) {
        throw new DcCompatibilityError("Protected path is outside compatibility dispatch scope.", {
          code: "PROTECTED_PATH_BLOCKED",
          category: "policy",
        });
      }

      let data;
      switch (toolName) {
        case "list_devices":
          data = await this.#listDevices(sessionId, requestId, args, signal);
          break;
        case "ping":
          data = await this.#ping(sessionId, requestId, args, signal);
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
        case "edit_block":
          data = await this.#editBlock(sessionId, requestId, args, signal);
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
        case "get_file_info":
          data = await this.#getFileInfo(sessionId, requestId, args, signal);
          break;
        case "start_search":
          data = await this.#startSearch(sessionId, requestId, args, signal);
          break;
        case "get_more_search_results":
          data = await this.#readSearch(sessionId, requestId, args, signal);
          break;
        case "stop_search":
          data = await this.#stopSearch(sessionId, requestId, args, signal);
          break;
        case "list_searches":
          data = await this.#listSearches(sessionId, requestId, args, signal);
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
        case "list_sessions":
          data = await this.#listSessions(sessionId, requestId, signal);
          break;
        case "force_terminate":
          data = await this.#forceTerminate(sessionId, requestId, args, signal);
          break;
        case "list_processes":
          data = await this.#listProcesses(sessionId, requestId, args, signal);
          break;
        case "kill_process":
          data = await this.#killProcess(sessionId, requestId, args, signal);
          break;
        case "shutdown":
          data = await this.#shutdown(sessionId, requestId, args, signal);
          break;
        case "who_am_i":
          data = await this.#whoAmI(sessionId, requestId, args, signal);
          break;
        case "get_usage_stats":
          data = await this.#usageStats(sessionId, requestId, args, signal);
          break;
        case "get_recent_tool_calls":
          data = await this.#recentToolCalls(sessionId, requestId, args, signal);
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
          status: error.response?.status ?? "pending",
          data: clone(error.response?.data ?? null),
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
