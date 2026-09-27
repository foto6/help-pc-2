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

export class HelpPc1Adapter extends InvokeAdapter {
  constructor({ invoke }) {
    super("help-pc-1", invoke);
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
