import {
  adaptExecutorActionOutcomeV1,
  adaptExecutorOutcomeJournalLookupV1,
  adaptExecutorCapabilitiesV1,
  adaptExecutorActionPreflightResultV1,
  buildExecutorActionPreflightRequestV1,
  ConformanceValidationError,
  executorJournalExecutionId,
} from "./conformance.js";
import {
  parseExecutorExecutionContextBindingV1,
  parseExecutorExecutionContextValidationV1,
} from "./context-epoch.js";

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

function invalidExecutorJournal(error) {
  const wrapped = new Error(`PC Executor outcome journal evidence failed conformance: ${error.message}`);
  wrapped.name = "ProviderEvidenceError";
  wrapped.code = error?.code === "EXECUTOR_JOURNAL_BINDING_MISMATCH"
    ? "EXECUTOR_JOURNAL_BINDING_MISMATCH"
    : error?.code === "EXECUTOR_JOURNAL_VERSION_MISMATCH"
      ? "EXECUTOR_JOURNAL_VERSION_MISMATCH"
      : "EXECUTOR_JOURNAL_INVALID";
  wrapped.category = "journal_evidence_invalid";
  wrapped.retryable = false;
  wrapped.dispatchState = "unknown";
  wrapped.outcomeUncertain = true;
  wrapped.cause = error;
  return wrapped;
}


function invalidExecutorCapabilities(error) {
  const wrapped = new Error(`PC Executor capabilities failed conformance: ${error.message}`);
  wrapped.name = "ProviderPreflightError";
  wrapped.code = error?.code ?? "EXECUTOR_CAPABILITIES_INVALID";
  wrapped.category = "capabilities_invalid";
  wrapped.retryable = false;
  wrapped.dispatchState = "not_dispatched";
  wrapped.outcomeUncertain = false;
  wrapped.cause = error;
  return wrapped;
}

function invalidExecutorPreflight(error) {
  const wrapped = new Error(`PC Executor preflight failed conformance: ${error.message}`);
  wrapped.name = "ProviderPreflightError";
  wrapped.code = error?.code ?? "EXECUTOR_PREFLIGHT_INVALID";
  wrapped.category = "preflight_invalid";
  wrapped.retryable = false;
  wrapped.dispatchState = "not_dispatched";
  wrapped.outcomeUncertain = false;
  wrapped.cause = error;
  return wrapped;
}

function invalidExecutorContext(error, { category = "context_binding_invalid", code = null } = {}) {
  const wrapped = new Error(`PC Executor execution context failed conformance: ${error?.message ?? error}`);
  wrapped.name = "ProviderContextError";
  wrapped.code = code ?? error?.code ?? "EXECUTOR_CONTEXT_INVALID";
  wrapped.category = category;
  wrapped.retryable = false;
  wrapped.dispatchState = "not_dispatched";
  wrapped.outcomeUncertain = false;
  wrapped.cause = error;
  return wrapped;
}

function executionContextMismatch(result, evidence, validation) {
  const error = new Error(result.error ?? "PC Executor blocked because execution context changed.");
  error.name = "ProviderContextMismatchError";
  error.code = "EXECUTION_CONTEXT_MISMATCH";
  error.category = "execution_context_mismatch";
  error.retryable = true;
  error.dispatchState = "not_dispatched";
  error.outcomeUncertain = false;
  error.executorEvidence = evidence;
  error.contextValidation = validation;
  error.providerResult = result;
  return error;
}

function readOnlyProviderUnavailable(error, category) {
  if (error?.name === "AbortError" || error?.code === "CANCELLED") return error;
  const wrapped = new Error(String(error?.message ?? error ?? "read-only provider unavailable"));
  wrapped.name = "ProviderPreflightError";
  wrapped.code = typeof error?.code === "string" ? error.code : category === "capabilities_unavailable" ? "EXECUTOR_CAPABILITIES_UNAVAILABLE" : "EXECUTOR_PREFLIGHT_UNAVAILABLE";
  wrapped.category = typeof error?.category === "string" ? error.category : category;
  wrapped.retryable = error?.retryable !== false;
  wrapped.dispatchState = "not_dispatched";
  wrapped.outcomeUncertain = false;
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
  constructor({ invoke, dryRun = true, readEvidence = null, readCapabilities = null, preflight = null, bindExecutionContext = null } = {}) {
    if (typeof invoke !== "function") throw new TypeError("invoke must be a function.");
    if (typeof dryRun !== "boolean") throw new TypeError("dryRun must be a boolean.");
    if (readEvidence !== null && typeof readEvidence !== "function") throw new TypeError("readEvidence must be a function when supplied.");
    if (readCapabilities !== null && typeof readCapabilities !== "function") throw new TypeError("readCapabilities must be a function when supplied.");
    if (preflight !== null && typeof preflight !== "function") throw new TypeError("preflight must be a function when supplied.");
    if ((readCapabilities === null) !== (preflight === null)) throw new TypeError("readCapabilities and preflight must be supplied together.");
    if (bindExecutionContext !== null && typeof bindExecutionContext !== "function") throw new TypeError("bindExecutionContext must be a function when supplied.");
    this.name = "help-pc-1";
    this.invoke = invoke;
    this.dryRun = dryRun;
    this._readEvidence = readEvidence;
    this._readCapabilities = readCapabilities;
    this._preflight = preflight;
    this._bindExecutionContext = bindExecutionContext;
    this.supportsPreflight = Boolean(readCapabilities && preflight);
    this.supportsExecutionContext = Boolean(bindExecutionContext);
  }
  executionCorrelation(action, executionAttempt) {
    return Object.freeze({
      contract: "pc_executor.outcome_journal.execution_correlation.v1",
      requestId: action.id,
      action: action.type,
      executionAttempt,
      executionId: executorJournalExecutionId(action.id, action.type, executionAttempt),
    });
  }

  async readCapabilities(action, context = {}) {
    if (!this.supportsPreflight) return null;
    let raw;
    try {
      raw = await this._readCapabilities({
        request_id: action?.id ?? null,
        action: action?.type ?? null,
      }, context);
    } catch (error) {
      throw readOnlyProviderUnavailable(error, "capabilities_unavailable");
    }
    const payload = raw?.data?.capabilities ?? raw?.capabilities ?? raw;
    try {
      return adaptExecutorCapabilitiesV1(payload);
    } catch (error) {
      throw invalidExecutorCapabilities(error);
    }
  }

  async preflightAction(action, context = {}) {
    if (!this.supportsPreflight) return null;
    const request = buildExecutorActionPreflightRequestV1(action, {
      dryRun: this.dryRun,
      timeoutMs: action.preflightTimeoutMs ?? null,
    });
    let raw;
    try {
      raw = await this._preflight(structuredClone(request), {
        signal: context.signal,
        preflightAttempt: context.preflightAttempt,
        session: context.session,
        capabilitiesDigest: context.capabilitiesDigest ?? null,
      });
    } catch (error) {
      throw readOnlyProviderUnavailable(error, "preflight_unavailable");
    }
    const payload = raw?.data?.preflight ?? raw?.preflight ?? raw;
    try {
      return adaptExecutorActionPreflightResultV1(payload, {
        requestId: action.id,
        action: action.type,
        capabilitiesDigest: context.capabilitiesDigest ?? null,
      });
    } catch (error) {
      throw invalidExecutorPreflight(error);
    }
  }

  async bindExecutionContext(action, context = {}) {
    if (!this.supportsExecutionContext) return null;
    let raw;
    try {
      raw = await this._bindExecutionContext({
        request_id: action.id,
        action: action.type,
        params: structuredClone(action.input ?? {}),
        dry_run: this.dryRun,
      }, {
        signal: context.signal,
        preflightAttempt: context.preflightAttempt,
        session: context.session,
        preflightAttestationDigest: action.preflightAttestationDigest ?? null,
        capabilitiesDigest: action.preflightCapabilitiesDigest ?? null,
      });
    } catch (error) {
      if (error?.name === "AbortError" || error?.code === "CANCELLED") throw error;
      const wrapped = readOnlyProviderUnavailable(error, error?.category ?? "context_binding_unavailable");
      if (["stale_target", "ambiguous_target"].includes(error?.category ?? error?.code)) wrapped.category = error?.category ?? error?.code;
      throw wrapped;
    }
    const payload = raw?.data?.execution_context_binding ?? raw?.execution_context_binding ?? raw;
    try {
      return parseExecutorExecutionContextBindingV1(payload, { requestId: action.id, action: action.type });
    } catch (error) {
      throw invalidExecutorContext(error);
    }
  }

  async execute(action, context) {
    let result;
    try {
      const request = { request_id: action.id, action: action.type, params: structuredClone(action.input ?? {}), dry_run: this.dryRun };
      if (action.executionContextBinding?.raw) request.execution_context_binding = structuredClone(action.executionContextBinding.raw);
      result = await this.invoke(
        request,
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

    if (result.data?.execution_context_validation !== undefined) {
      let validation;
      try {
        validation = parseExecutorExecutionContextValidationV1(result.data.execution_context_validation, {
          bindingDigest: action.executionContextBinding?.context_digest ?? null,
        });
      } catch (error) {
        throw invalidExecutorContext(error, { category: "context_evidence_invalid", code: "EXECUTOR_CONTEXT_VALIDATION_INVALID" });
      }
      if (validation.status === "blocked") {
        if (evidence?.effectState !== "not_started" || evidence?.dispatchStarted !== false || evidence?.reexecutionSafe !== true) {
          throw invalidExecutorContext(new ConformanceValidationError("context mismatch must carry safe not_started outcome evidence"), {
            category: "context_evidence_invalid",
            code: "EXECUTOR_CONTEXT_OUTCOME_INCONSISTENT",
          });
        }
        throw executionContextMismatch(result, evidence, validation);
      }
    }
    if (result.ok === false || result.status === "blocked") throw executorProviderFailure(result, evidence);
    if (result.ok === true && typeof result.status === "string" && result.status.trim()) return { result, evidence };
    throw malformedExecutorResult();
  }

  async readOutcomeEvidence(action, context) {
    if (!this._readEvidence) return { outcome: "unknown", source: this.name, requestId: action.id, reason: "no_executor_evidence_reader" };
    const raw = await this._readEvidence({
      request_id: action.id,
      action: action.type,
      execution_attempt: action.executionAttempts,
    }, context);
    if (raw === null || raw === undefined) {
      return { outcome: "unknown", source: this.name, requestId: action.id, reason: "journal_missing", journalMissing: true };
    }

    const journalPayload =
      raw?.contract_version?.startsWith?.("pc_executor.outcome_journal.lookup.")
        ? raw
        : raw?.data?.outcome_evidence?.contract_version?.startsWith?.("pc_executor.outcome_journal.lookup.")
          ? raw.data.outcome_evidence
          : null;
    if (journalPayload) {
      try {
        return adaptExecutorOutcomeJournalLookupV1(journalPayload, {
          requestId: action.id,
          action: action.type,
          executionAttempt: action.executionAttempts,
          executionId: action.executionCorrelation?.executionId ?? executorJournalExecutionId(action.id, action.type, action.executionAttempts),
        });
      } catch (error) {
        throw invalidExecutorJournal(error);
      }
    }

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
