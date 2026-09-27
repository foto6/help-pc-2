export const ACTION_STATUSES = Object.freeze([
  "awaiting_confirmation",
  "queued",
  "leased",
  "executing",
  "verifying",
  "uncertain_outcome",
  "reconciliation_wait",
  "reconciling",
  "succeeded",
  "retry_wait",
  "blocked",
  "cancelled",
  "failed",
  "running",
]);

export const TERMINAL_ACTION_STATUSES = new Set(["succeeded", "blocked", "cancelled", "failed"]);
const FORBIDDEN_ACTION_PATTERNS = [/(^|[._-])captcha([._-]|$)/i, /(^|[._-])credentials?([._-]|$)/i];

export class ValidationError extends Error {
  constructor(message, code = "INVALID_ARGUMENT") { super(message); this.name = "ValidationError"; this.code = code; }
}

export function assertSafeActionType(type) {
  if (FORBIDDEN_ACTION_PATTERNS.some((pattern) => pattern.test(type))) {
    throw new ValidationError("Credential and CAPTCHA automation is not supported.", "PROHIBITED_ACTION");
  }
}

function validateVerification(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new ValidationError("verification must be an object.");
  if (typeof value.provider !== "string" || !value.provider.trim()) throw new ValidationError("verification.provider is required.");
  if (typeof value.type !== "string" || !value.type.trim()) throw new ValidationError("verification.type is required.");
  if (value.input !== undefined && (value.input === null || typeof value.input !== "object" || Array.isArray(value.input))) throw new ValidationError("verification.input must be an object when supplied.");
  return { provider: value.provider.trim(), type: value.type.trim(), input: value.input ? structuredClone(value.input) : {} };
}

function intInRange(value, name, minimum, maximum) {
  if (value !== undefined && (!Number.isInteger(value) || value < minimum || value > maximum)) {
    throw new ValidationError(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
}

export function validateActionSpec(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new ValidationError("Action spec must be an object.");
  if (typeof spec.provider !== "string" || !spec.provider.trim()) throw new ValidationError("Action provider is required.");
  if (typeof spec.type !== "string" || !spec.type.trim()) throw new ValidationError("Action type is required.");
  assertSafeActionType(spec.type);
  if (spec.input !== undefined && (spec.input === null || typeof spec.input !== "object" || Array.isArray(spec.input))) throw new ValidationError("Action input must be an object when supplied.");
  if (spec.resource !== undefined && (typeof spec.resource !== "string" || !spec.resource.trim())) throw new ValidationError("Action resource must be a non-empty string when supplied.");
  if (spec.permission !== undefined && (typeof spec.permission !== "string" || !spec.permission.trim())) throw new ValidationError("Action permission must be a non-empty string when supplied.");
  if (spec.idempotencyKey !== undefined && (typeof spec.idempotencyKey !== "string" || !spec.idempotencyKey.trim())) throw new ValidationError("idempotencyKey must be a non-empty string when supplied.");
  if (spec.correlationId !== undefined && (typeof spec.correlationId !== "string" || !spec.correlationId.trim())) throw new ValidationError("correlationId must be a non-empty string when supplied.");
  intInRange(spec.maxAttempts, "maxAttempts", 1, 10);
  intInRange(spec.maxVerificationAttempts, "maxVerificationAttempts", 1, 20);
  intInRange(spec.maxReconciliationAttempts, "maxReconciliationAttempts", 1, 20);
  intInRange(spec.retryDelayMs, "retryDelayMs", 0, 300000);
  intInRange(spec.verificationDelayMs, "verificationDelayMs", 0, 300000);
  if (spec.confirmation !== undefined && !["none", "required"].includes(spec.confirmation)) throw new ValidationError("confirmation must be 'none' or 'required'.");
  if (spec.destructive !== undefined && typeof spec.destructive !== "boolean") throw new ValidationError("destructive must be boolean when supplied.");
  if (spec.requiresDesktop !== undefined && typeof spec.requiresDesktop !== "boolean") throw new ValidationError("requiresDesktop must be boolean when supplied.");
  return {
    provider: spec.provider.trim(),
    type: spec.type.trim(),
    input: spec.input ? structuredClone(spec.input) : {},
    resource: spec.resource?.trim() || null,
    permission: spec.permission?.trim() || "desktop.control",
    idempotencyKey: spec.idempotencyKey?.trim() || null,
    correlationId: spec.correlationId?.trim() || null,
    maxAttempts: spec.maxAttempts ?? 3,
    maxVerificationAttempts: spec.maxVerificationAttempts ?? 3,
    maxReconciliationAttempts: spec.maxReconciliationAttempts ?? 3,
    retryDelayMs: spec.retryDelayMs ?? 0,
    verificationDelayMs: spec.verificationDelayMs ?? 0,
    confirmation: spec.confirmation ?? "none",
    destructive: spec.destructive ?? false,
    requiresDesktop: spec.requiresDesktop ?? true,
    verification: validateVerification(spec.verification),
    metadata: spec.metadata && typeof spec.metadata === "object" ? structuredClone(spec.metadata) : {},
  };
}

export const actionSpecSchema = Object.freeze({
  type: "object",
  required: ["provider", "type"],
  additionalProperties: false,
  properties: {
    provider: { type: "string", minLength: 1 }, type: { type: "string", minLength: 1 }, input: { type: "object" },
    resource: { type: ["string", "null"] }, permission: { type: "string", default: "desktop.control" },
    idempotencyKey: { type: ["string", "null"] }, correlationId: { type: ["string", "null"] },
    maxAttempts: { type: "integer", minimum: 1, maximum: 10, default: 3 },
    maxVerificationAttempts: { type: "integer", minimum: 1, maximum: 20, default: 3 },
    maxReconciliationAttempts: { type: "integer", minimum: 1, maximum: 20, default: 3 },
    retryDelayMs: { type: "integer", minimum: 0, maximum: 300000, default: 0 },
    verificationDelayMs: { type: "integer", minimum: 0, maximum: 300000, default: 0 },
    confirmation: { enum: ["none", "required"], default: "none" }, destructive: { type: "boolean", default: false }, requiresDesktop: { type: "boolean", default: true },
    verification: { type: ["object", "null"], properties: { provider: { type: "string" }, type: { type: "string" }, input: { type: "object" } } },
    metadata: { type: "object" },
  },
});
