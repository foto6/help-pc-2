import { adaptExecutorActionOutcomeV1, ConformanceValidationError } from "./conformance.js";

export class ProviderRegistry {
  #providers = new Map();
  constructor(providers = []) { for (const provider of providers) this.register(provider); }
  register(provider) {
    if (!provider || typeof provider.name !== "string" || typeof provider.execute !== "function") throw new TypeError("Provider must expose { name, execute(action, context) }.");
    this.#providers.set(provider.name, provider); return provider;
  }
  get(name) { return this.#providers.get(name) ?? null; }
  list() { return [...this.#providers.keys()]; }
}

export class VerificationRegistry {
  #providers = new Map();
  constructor(providers = []) { for (const provider of providers) this.register(provider); }
  register(provider) {
    if (!provider || typeof provider.name !== "string" || typeof provider.verify !== "function") throw new TypeError("Verification provider must expose { name, verify(request, context) }.");
    this.#providers.set(provider.name, provider); return provider;
  }
  get(name) { return this.#providers.get(name) ?? null; }
  list() { return [...this.#providers.keys()]; }
}

class InvokeAdapter {
  constructor(name, invoke, { readEvidence = null } = {}) {
    if (typeof invoke !== "function") throw new TypeError("invoke must be a function.");
    if (readEvidence !== null && typeof readEvidence !== "function") throw new TypeError("readEvidence must be a function when supplied.");
    this.name = name; this.invoke = invoke; this._readEvidence = readEvidence;
  }
  async execute(action, context) {
    return this.invoke({ requestId: action.id, sessionId: action.sessionId, tool: action.type, input: action.input, resource: action.resource, signal: context.signal, executionAttempt: context.executionAttempt });
  }
  async readOutcomeEvidence(action, context) {
    if (!this._readEvidence) return { outcome: "unknown", source: this.name, requestId: action.id, reason: "no_evidence_reader" };
    return this._readEvidence({ requestId: action.id, action: action.type, input: action.input, executionAttempt: action.executionAttempts }, context);
  }
}

function legacyExecutorResultEvidence(result, action) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const kind = typeof result.error_kind === "string" ? result.error_kind : null;
  let outcome = "unknown";
  if (result.ok === true) outcome = "succeeded";
  else if (result.ok === false && (result.status === "blocked" || kind === "policy_blocked")) outcome = "blocked";
  else if (result.ok === false && (result.status === "cancelled" || kind === "cancelled")) outcome = "unknown";
  else if (result.ok === false && ["stale_target", "ambiguous_target"].includes(kind ?? result.status)) outcome = "not_dispatched";
  else if (result.ok === false && ["timeout", "transient", "executor_failure"].includes(kind ?? result.status)) outcome = "unknown";
  else if (result.ok === false) outcome = "failed";
  return {
    source: "help-pc-1",
    contract: "pc_executor.action_result.v2-compatible",
    requestId: result.request_id ?? action.id,
    action: result.action ?? action.type,
    outcome,
    status: result.status ?? null,
    errorKind: kind,
    dryRun: result.dry_run ?? null,
    startedAt: result.started_at ?? null,
    finishedAt: result.finished_at ?? null,
  };
}

function executorResultEvidence(result, action) {
  if (result?.outcome_evidence !== undefined) {
    return adaptExecutorActionOutcomeV1(result.outcome_evidence, { requestId: action.id, action: action.type });
  }
  return legacyExecutorResultEvidence(result, action);
}

function invalidExecutorOutcome(error) {
  const wrapped = new Error(`PC Executor outcome evidence failed conformance: ${error.message}`);
  wrapped.name = "ProviderExecutionError";
  wrapped.code = "EXECUTOR_OUTCOME_INVALID";
  wrapped.category = "malformed_result";
  wrapped.retryable = false;
  wrapped.dispatchState = "unknown";
  wrapped.outcomeUncertain = true;
  wrapped.cause = error;
  return wrapped;
}

function executorProviderFailure(result, evidence) {
  const kind = typeof result?.error_kind === "string" ? result.error_kind : null;
  const detail = result?.error;
  const blocked = result?.status === "blocked" || kind === "policy_blocked";
  const message = typeof detail === "string" && detail ? detail : blocked ? "PC Executor blocked the action." : "PC Executor reported action failure.";
  const error = new Error(message);
  error.name = "ProviderExecutionError";
  error.code = blocked ? "EXECUTOR_BLOCKED" : kind ? `EXECUTOR_${kind.toUpperCase()}` : "EXECUTOR_FAILED";
  error.category = kind ?? (blocked ? "executor_blocked" : "executor_error");
  error.dispatchState = evidence?.outcome === "not_dispatched" || evidence?.outcome === "blocked" ? "not_dispatched" : "unknown";
  error.retryable = error.dispatchState === "not_dispatched" && ["transient", "timeout"].includes(kind);
  error.outcomeUncertain = error.dispatchState !== "not_dispatched";
  error.executorEvidence = evidence;
  error.providerResult = result;
  return error;
}

function malformedExecutorResult() {
  const error = new Error("PC Executor returned a malformed result.");
  error.name = "ProviderExecutionError"; error.code = "EXECUTOR_MALFORMED_RESULT"; error.category = "malformed_result";
  error.retryable = false; error.dispatchState = "unknown"; error.outcomeUncertain = true;
  return error;
}

export class HelpPc1Adapter {
  constructor({ invoke, dryRun = true, readEvidence = null } = {}) {
    if (typeof invoke !== "function") throw new TypeError("invoke must be a function.");
    if (typeof dryRun !== "boolean") throw new TypeError("dryRun must be a boolean.");
    if (readEvidence !== null && typeof readEvidence !== "function") throw new TypeError("readEvidence must be a function when supplied.");
    this.name = "help-pc-1"; this.invoke = invoke; this.dryRun = dryRun; this._readEvidence = readEvidence;
  }
  async execute(action, context) {
    let result;
    try {
      result = await this.invoke(
        { request_id: action.id, action: action.type, params: structuredClone(action.input ?? {}), dry_run: this.dryRun },
        { signal: context.signal, executionAttempt: context.executionAttempt, session: context.session },
      );
    } catch (error) {
      if (error && typeof error === "object") {
        if (!error.dispatchState) error.dispatchState = "unknown";
        if (error.outcomeUncertain === undefined) error.outcomeUncertain = error.dispatchState !== "not_dispatched";
      }
      throw error;
    }
    if (!result || typeof result !== "object" || Array.isArray(result)) throw malformedExecutorResult();

    let evidence;
    try {
      evidence = executorResultEvidence(result, action);
      if (result.outcome_evidence && result.ok === false && evidence?.effectState === "completed") {
        throw new ConformanceValidationError("failed ActionResult cannot carry completed outcome evidence");
      }
    } catch (error) {
      throw invalidExecutorOutcome(error);
    }

    if (result.ok === false || result.status === "blocked") throw executorProviderFailure(result, evidence);
    if (result.ok === true && typeof result.status === "string" && result.status.trim()) return { result, evidence };
    throw malformedExecutorResult();
  }

  async readOutcomeEvidence(action, context) {
    if (!this._readEvidence) return { outcome: "unknown", source: this.name, requestId: action.id, reason: "no_executor_evidence_reader" };
    const raw = await this._readEvidence({ request_id: action.id, action: action.type, execution_attempt: action.executionAttempts }, context);
    try {
      if (raw?.contract_version === "pc_executor.action_outcome.v1") return adaptExecutorActionOutcomeV1(raw, { requestId: action.id, action: action.type });
      if (raw?.outcome_evidence?.contract_version === "pc_executor.action_outcome.v1") return adaptExecutorActionOutcomeV1(raw.outcome_evidence, { requestId: action.id, action: action.type });
    } catch (error) {
      throw invalidExecutorOutcome(error);
    }
    if (raw && typeof raw === "object" && typeof raw.outcome === "string") return structuredClone(raw);
    return legacyExecutorResultEvidence(raw, action) ?? { outcome: "unknown", source: this.name, requestId: action.id, reason: "malformed_evidence" };
  }
}

export class Vision2Adapter extends InvokeAdapter { constructor({ invoke }) { super("vision-2", invoke); } }
export class FunctionProvider extends InvokeAdapter { constructor(name, invoke, options = {}) { super(name, invoke, options); } }
export class FunctionVerificationProvider {
  constructor(name, verify) { if (typeof verify !== "function") throw new TypeError("verify must be a function."); this.name = name; this._verify = verify; }
  verify(request, context) { return this._verify(request, context); }
}

export class FakeExecutorAdapter extends HelpPc1Adapter {
  constructor({ script = [], evidenceScript = [], dryRun = true } = {}) {
    const state = { calls: [], script: [...script], evidenceCalls: [], evidenceScript: [...evidenceScript] };
    super({
      dryRun,
      invoke: async (request, context) => {
        state.calls.push(structuredClone(request));
        const next = state.script.length ? state.script.shift() : { ok: true, status: request.dry_run ? "dry_run" : "completed", data: {} };
        if (typeof next === "function") return next(request, context);
        if (next instanceof Error) throw next;
        return { request_id: request.request_id, action: request.action, dry_run: request.dry_run, ...structuredClone(next) };
      },
      readEvidence: async (request, context) => {
        state.evidenceCalls.push(structuredClone(request));
        const next = state.evidenceScript.length ? state.evidenceScript.shift() : { outcome: "unknown", source: "fake-executor", requestId: request.request_id };
        if (typeof next === "function") return next(request, context);
        if (next instanceof Error) throw next;
        return structuredClone(next);
      },
    });
    this.calls = state.calls; this.evidenceCalls = state.evidenceCalls; this._state = state;
  }
}

export class FakeVisionObservationAdapter extends FunctionVerificationProvider {
  constructor({ script = [] } = {}) {
    const state = { calls: [], script: [...script] };
    super("vision-2", async (request, context) => {
      state.calls.push(structuredClone(request));
      const next = state.script.length ? state.script.shift() : { ok: true, observation: { matched: true } };
      if (typeof next === "function") return next(request, context);
      if (next instanceof Error) throw next;
      return structuredClone(next);
    });
    this.calls = state.calls; this._state = state;
  }
}

export { legacyExecutorResultEvidence as normalizeExecutorOutcomeEvidence };
