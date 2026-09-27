import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

function abortError(reason = "aborted") {
  const error = new Error(typeof reason === "string" ? reason : "aborted");
  error.name = "AbortError";
  error.code = "CANCELLED";
  error.category = "cancelled";
  error.dispatchState = "unknown";
  error.outcomeUncertain = true;
  return error;
}

export class ExecutorJsonlClient {
  constructor({
    command = process.env.PC_EXECUTOR_COMMAND || "pc-executor",
    args = null,
    live = process.env.PC_CONTROL_LIVE === "1",
    cwd = process.env.PC_EXECUTOR_CWD || undefined,
    env = process.env,
    requestTimeoutMs = Number(process.env.PC_EXECUTOR_REQUEST_TIMEOUT_MS || 60000),
    stderrLimit = 16 * 1024,
  } = {}) {
    this.command = command;
    this.args = args ?? (live ? ["--live"] : []);
    this.cwd = cwd;
    this.env = env;
    this.requestTimeoutMs = Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0 ? requestTimeoutMs : 60000;
    this.stderrLimit = stderrLimit;
    this.child = null;
    this.reader = null;
    this.pending = [];
    this.stderrTail = "";
    this.startedAt = null;
    this.lastExit = null;
  }

  get running() {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
  }

  status() {
    return {
      running: this.running,
      pid: this.child?.pid ?? null,
      command: this.command,
      args: [...this.args],
      startedAt: this.startedAt,
      pending: this.pending.length,
      lastExit: this.lastExit,
      stderrTail: this.stderrTail,
    };
  }

  start() {
    if (this.running) return this;
    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    this.child = child;
    this.startedAt = new Date().toISOString();
    this.lastExit = null;
    this.stderrTail = "";

    this.reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.reader.on("line", (line) => this.#handleLine(line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-this.stderrLimit);
    });
    child.on("error", (error) => this.#failAll(error));
    child.on("exit", (code, signal) => {
      this.lastExit = { code, signal, at: new Date().toISOString() };
      this.#failAll(Object.assign(new Error(`pc-executor exited (code=${code}, signal=${signal ?? "none"})`), {
        code: "EXECUTOR_PROCESS_EXITED",
        category: "executor_unavailable",
        dispatchState: "unknown",
        outcomeUncertain: true,
      }));
      this.reader?.close();
      this.reader = null;
      this.child = null;
    });
    return this;
  }

  stop() {
    if (!this.child) return;
    this.child.kill();
  }

  async request(payload, { timeoutMs = this.requestTimeoutMs, signal = null } = {}) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new TypeError("Executor request must be an object.");
    if (signal?.aborted) throw abortError(signal.reason);
    this.start();

    const requestId = typeof payload.request_id === "string" && payload.request_id ? payload.request_id : randomUUID();
    const body = { ...structuredClone(payload), request_id: requestId };
    const effectiveTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : this.requestTimeoutMs;

    return new Promise((resolve, reject) => {
      const pending = {
        requestId,
        resolve,
        reject,
        settled: false,
        timer: null,
        abortListener: null,
      };

      const settleReject = (error) => {
        if (pending.settled) return;
        pending.settled = true;
        clearTimeout(pending.timer);
        if (signal && pending.abortListener) signal.removeEventListener("abort", pending.abortListener);
        reject(error);
      };

      pending.timer = setTimeout(() => {
        settleReject(Object.assign(new Error(`pc-executor request timed out after ${effectiveTimeout} ms`), {
          code: "EXECUTOR_TRANSPORT_TIMEOUT",
          category: "timeout",
          dispatchState: "unknown",
          outcomeUncertain: true,
        }));
      }, effectiveTimeout);

      if (signal) {
        pending.abortListener = () => settleReject(abortError(signal.reason));
        signal.addEventListener("abort", pending.abortListener, { once: true });
      }

      this.pending.push(pending);
      try {
        this.child.stdin.write(`${JSON.stringify(body)}\n`, "utf8");
      } catch (error) {
        settleReject(error);
      }
    });
  }

  #handleLine(line) {
    const pending = this.pending.shift();
    if (!pending) return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      if (!pending.settled) {
        pending.settled = true;
        clearTimeout(pending.timer);
        pending.reject(Object.assign(new Error(`pc-executor emitted invalid JSON: ${error.message}`), {
          code: "EXECUTOR_TRANSPORT_INVALID_JSON",
          category: "malformed_result",
          dispatchState: "unknown",
          outcomeUncertain: true,
        }));
      }
      return;
    }

    if (pending.settled) return;
    pending.settled = true;
    clearTimeout(pending.timer);
    if (parsed?.request_id && parsed.request_id !== pending.requestId) {
      pending.reject(Object.assign(new Error(`pc-executor response request_id mismatch: expected ${pending.requestId}, got ${parsed.request_id}`), {
        code: "EXECUTOR_TRANSPORT_CORRELATION_MISMATCH",
        category: "malformed_result",
        dispatchState: "unknown",
        outcomeUncertain: true,
      }));
      return;
    }
    pending.resolve(parsed);
  }

  #failAll(error) {
    for (const pending of this.pending.splice(0)) {
      if (pending.settled) continue;
      pending.settled = true;
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}
