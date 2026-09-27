export class ProviderRegistry {
  #providers = new Map();
  constructor(providers = []) { for (const provider of providers) this.register(provider); }
  register(provider) {
    if (!provider || typeof provider.name !== "string" || typeof provider.execute !== "function") {
      throw new TypeError("Provider must expose { name, execute(action, context) }.");
    }
    this.#providers.set(provider.name, provider);
    return provider;
  }
  get(name) { return this.#providers.get(name) ?? null; }
  list() { return [...this.#providers.keys()]; }
}

export class VerificationRegistry {
  #providers = new Map();
  constructor(providers = []) { for (const provider of providers) this.register(provider); }
  register(provider) {
    if (!provider || typeof provider.name !== "string" || typeof provider.verify !== "function") {
      throw new TypeError("Verification provider must expose { name, verify(request, context) }.");
    }
    this.#providers.set(provider.name, provider);
    return provider;
  }
  get(name) { return this.#providers.get(name) ?? null; }
  list() { return [...this.#providers.keys()]; }
}

class InvokeAdapter {
  constructor(name, invoke) {
    if (typeof invoke !== "function") throw new TypeError("invoke must be a function.");
    this.name = name;
    this.invoke = invoke;
  }
  async execute(action, context) {
    return this.invoke({
      requestId: action.id,
      sessionId: action.sessionId,
      tool: action.type,
      input: action.input,
      resource: action.resource,
      signal: context.signal,
      attempt: context.attempt,
    });
  }
}

function normalizedExecutorError(result) {
  const detail = result?.error;
  const blocked = result?.status === "blocked" || detail?.category === "policy_blocked" || detail?.code === "policy_blocked";
  const message = typeof detail === "string"
    ? detail
    : typeof detail?.message === "string"
      ? detail.message
      : blocked ? "PC Executor blocked the action." : "PC Executor reported action failure.";
  const error = new Error(message);
  error.name = "ProviderExecutionError";
  error.code = typeof detail?.code === "string" ? detail.code : blocked ? "EXECUTOR_BLOCKED" : "EXECUTOR_FAILED";
  error.category = typeof detail?.category === "string" ? detail.category : blocked ? "executor_blocked" : "executor_error";
  error.retryable = blocked ? false : detail?.retryable === true;
  error.providerResult = result;
  return error;
}

function malformedExecutorResult() {
  const error = new Error("PC Executor returned a malformed result.");
  error.name = "ProviderExecutionError";
  error.code = "EXECUTOR_MALFORMED_RESULT";
  error.category = "malformed_result";
  error.retryable = false;
  return error;
}

export class HelpPc1Adapter {
  constructor({ invoke, dryRun = true } = {}) {
    if (typeof invoke !== "function") throw new TypeError("invoke must be a function.");
    if (typeof dryRun !== "boolean") throw new TypeError("dryRun must be a boolean.");
    this.name = "help-pc-1";
    this.invoke = invoke;
    this.dryRun = dryRun;
  }

  async execute(action, context) {
    const result = await this.invoke(
      {
        request_id: action.id,
        action: action.type,
        params: structuredClone(action.input ?? {}),
        dry_run: this.dryRun,
      },
      { signal: context.signal, attempt: context.attempt, session: context.session },
    );
    if (!result || typeof result !== "object" || Array.isArray(result)) throw malformedExecutorResult();
    if (result.ok === false || result.status === "blocked") throw normalizedExecutorError(result);
    if (result.ok === true && typeof result.status === "string" && result.status.trim()) return result;
    throw malformedExecutorResult();
  }
}

export class Vision2Adapter extends InvokeAdapter {
  constructor({ invoke }) { super("vision-2", invoke); }
}

export class FunctionProvider extends InvokeAdapter {
  constructor(name, invoke) { super(name, invoke); }
}

export class FunctionVerificationProvider {
  constructor(name, verify) {
    if (typeof verify !== "function") throw new TypeError("verify must be a function.");
    this.name = name;
    this._verify = verify;
  }
  verify(request, context) { return this._verify(request, context); }
}

export class FakeExecutorAdapter extends HelpPc1Adapter {
  constructor({ script = [], dryRun = true } = {}) {
    const state = { calls: [], script: [...script] };
    super({
      dryRun,
      invoke: async (request, context) => {
        state.calls.push(structuredClone(request));
        const next = state.script.length ? state.script.shift() : { ok: true, status: request.dry_run ? "dry_run" : "completed", data: {} };
        if (typeof next === "function") return next(request, context);
        if (next instanceof Error) throw next;
        return { request_id: request.request_id, action: request.action, dry_run: request.dry_run, ...structuredClone(next) };
      },
    });
    this.calls = state.calls;
    this._state = state;
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
    this.calls = state.calls;
    this._state = state;
  }
}
