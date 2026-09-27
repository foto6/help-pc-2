export class ProviderRegistry {
  #providers = new Map();

  constructor(providers = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider) {
    if (!provider || typeof provider.name !== "string" || typeof provider.execute !== "function") {
      throw new TypeError("Provider must expose { name, execute(action, context) }.");
    }
    this.#providers.set(provider.name, provider);
    return provider;
  }

  get(name) {
    return this.#providers.get(name) ?? null;
  }

  list() {
    return [...this.#providers.keys()];
  }
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

function executorProviderFailure(result) {
  const blocked = result?.status === "blocked";
  const error = new Error(
    typeof result?.error === "string" && result.error
      ? result.error
      : blocked
        ? "PC Executor blocked the action."
        : "PC Executor reported action failure.",
  );
  error.name = "ProviderExecutionError";
  error.code = blocked ? "EXECUTOR_BLOCKED" : "EXECUTOR_FAILED";
  error.retryable = false;
  return error;
}

function malformedExecutorResult() {
  const error = new Error("PC Executor returned a malformed result.");
  error.name = "ProviderExecutionError";
  error.code = "EXECUTOR_MALFORMED_RESULT";
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
      {
        signal: context.signal,
        attempt: context.attempt,
        session: context.session,
      },
    );

    if (result && typeof result === "object" && !Array.isArray(result)) {
      if (result.ok === false || result.status === "blocked") throw executorProviderFailure(result);
      if (result.ok === true && typeof result.status === "string" && result.status.trim()) return result;
    }
    throw malformedExecutorResult();
  }
}

export class Vision2Adapter extends InvokeAdapter {
  constructor({ invoke }) {
    super("vision-2", invoke);
  }
}

export class FunctionProvider extends InvokeAdapter {
  constructor(name, invoke) {
    super(name, invoke);
  }
}
