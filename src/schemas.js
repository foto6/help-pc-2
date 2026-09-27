export const ACTION_STATUSES = Object.freeze([
  "awaiting_confirmation",
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export const TERMINAL_ACTION_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

const FORBIDDEN_ACTION_PATTERNS = [/(^|[._-])captcha([._-]|$)/i, /(^|[._-])credentials?([._-]|$)/i];

export class ValidationError extends Error {
  constructor(message, code = "INVALID_ARGUMENT") {
    super(message);
    this.name = "ValidationError";
    this.code = code;
  }
}

export function assertSafeActionType(type) {
  if (FORBIDDEN_ACTION_PATTERNS.some((pattern) => pattern.test(type))) {
    throw new ValidationError("Credential and CAPTCHA automation is not supported.", "PROHIBITED_ACTION");
  }
}

export function validateActionSpec(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new ValidationError("Action spec must be an object.");
  }
  if (typeof spec.provider !== "string" || !spec.provider.trim()) {
    throw new ValidationError("Action provider is required.");
  }
  if (typeof spec.type !== "string" || !spec.type.trim()) {
    throw new ValidationError("Action type is required.");
  }
  assertSafeActionType(spec.type);
  if (spec.input !== undefined && (spec.input === null || typeof spec.input !== "object" || Array.isArray(spec.input))) {
    throw new ValidationError("Action input must be an object when supplied.");
  }
  if (spec.resource !== undefined && (typeof spec.resource !== "string" || !spec.resource.trim())) {
    throw new ValidationError("Action resource must be a non-empty string when supplied.");
  }
  if (spec.permission !== undefined && (typeof spec.permission !== "string" || !spec.permission.trim())) {
    throw new ValidationError("Action permission must be a non-empty string when supplied.");
  }
  if (spec.idempotencyKey !== undefined && (typeof spec.idempotencyKey !== "string" || !spec.idempotencyKey.trim())) {
    throw new ValidationError("idempotencyKey must be a non-empty string when supplied.");
  }
  if (spec.maxAttempts !== undefined && (!Number.isInteger(spec.maxAttempts) || spec.maxAttempts < 1 || spec.maxAttempts > 10)) {
    throw new ValidationError("maxAttempts must be an integer from 1 to 10.");
  }
  if (spec.confirmation !== undefined && !["none", "required"].includes(spec.confirmation)) {
    throw new ValidationError("confirmation must be 'none' or 'required'.");
  }
  if (spec.destructive !== undefined && typeof spec.destructive !== "boolean") {
    throw new ValidationError("destructive must be boolean when supplied.");
  }
  if (spec.requiresDesktop !== undefined && typeof spec.requiresDesktop !== "boolean") {
    throw new ValidationError("requiresDesktop must be boolean when supplied.");
  }
  return {
    provider: spec.provider.trim(),
    type: spec.type.trim(),
    input: spec.input ? structuredClone(spec.input) : {},
    resource: spec.resource?.trim() || null,
    permission: spec.permission?.trim() || "desktop.control",
    idempotencyKey: spec.idempotencyKey?.trim() || null,
    maxAttempts: spec.maxAttempts ?? 3,
    confirmation: spec.confirmation ?? "none",
    destructive: spec.destructive ?? false,
    requiresDesktop: spec.requiresDesktop ?? true,
    metadata: spec.metadata && typeof spec.metadata === "object" ? structuredClone(spec.metadata) : {},
  };
}

export const actionSpecSchema = Object.freeze({
  type: "object",
  required: ["provider", "type"],
  additionalProperties: false,
  properties: {
    provider: { type: "string", minLength: 1 },
    type: { type: "string", minLength: 1, description: "Provider-neutral action/tool identifier." },
    input: { type: "object" },
    resource: { type: ["string", "null"] },
    permission: { type: "string", default: "desktop.control" },
    idempotencyKey: { type: ["string", "null"] },
    maxAttempts: { type: "integer", minimum: 1, maximum: 10, default: 3 },
    confirmation: { enum: ["none", "required"], default: "none" },
    destructive: { type: "boolean", default: false },
    requiresDesktop: { type: "boolean", default: true },
    metadata: { type: "object" },
  },
});
