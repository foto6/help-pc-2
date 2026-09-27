import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class StateCorruptionError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "StateCorruptionError";
    this.code = "STATE_CORRUPTED";
  }
}

function ensureParent(path) { mkdirSync(dirname(path), { recursive: true }); }

export class JsonStateStore {
  constructor(path) { this.path = path; }

  load() {
    if (!existsSync(this.path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8"));
      if (!parsed || typeof parsed !== "object" || !Number.isInteger(parsed.version)) throw new Error("missing state version");
      if (![1, 2].includes(parsed.version)) throw new Error(`unsupported state version ${parsed.version}`);
      if (!Array.isArray(parsed.sessions) || !Array.isArray(parsed.actions)) throw new Error("sessions/actions must be arrays");
      return parsed;
    } catch (error) {
      throw new StateCorruptionError(`Persisted control-plane state is corrupted: ${error.message}`, error);
    }
  }

  save(snapshot) {
    ensureParent(this.path);
    const temp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(temp, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    try { renameSync(temp, this.path); } catch (error) { try { unlinkSync(temp); } catch {} throw error; }
  }
}

const SENSITIVE_KEY = /(password|passwd|secret|token|credential|auth|cookie|captcha|text|value)/i;

export function redactMetadata(value, depth = 0) {
  if (depth > 6) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactMetadata(item, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactMetadata(item, depth + 1);
    return out;
  }
  if (typeof value === "string" && value.length > 256) return `${value.slice(0, 256)}…`;
  return value;
}

export class JsonlAuditTimeline {
  constructor(path) { this.path = path; }

  append(entry) {
    ensureParent(this.path);
    appendFileSync(this.path, `${JSON.stringify(redactMetadata(entry))}\n`, { encoding: "utf8", mode: 0o600 });
  }

  read() {
    if (!existsSync(this.path)) return [];
    const text = readFileSync(this.path, "utf8").trim();
    if (!text) return [];
    return text.split(/\r?\n/).map((line, index) => {
      try { return JSON.parse(line); }
      catch (error) { throw new StateCorruptionError(`Audit timeline is corrupted at line ${index + 1}`, error); }
    });
  }
}
