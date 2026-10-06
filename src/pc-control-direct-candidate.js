import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

export const PC_CONTROL_DIRECT_GATEWAY_V1 = "pc.control.direct_candidate_gateway.v1";
export const PC_CONTROL_PLUGIN_SURFACE_V1 = "pc.control.plugin_surface.v1";
export const PC_CONTROL_CANARY_EVIDENCE_V1 = "pc.control.direct_canary_evidence.v1";
export const PC_CONTROL_READINESS_V1 = "pc.control.direct_readiness.v1";
export const PC_CONTROL_PLUGIN_CANDIDATE_V1 = "pc.control.plugin_candidate.v1";

export const R31_STATES = Object.freeze([
  "SOURCE_READY",
  "READ_ONLY_CANARY_PASS",
  "READY_FOR_EXPLICIT_PLUGIN_CANDIDATE",
  "BLOCKED",
]);

export const R31_R30_SOURCE_SHA = "29cefa62efcf3f3295dca32b0a202b21c5831969";
export const R31_ACTIVE_SOURCE_AUTHORITY_CONTRACT = "pc.control.direct_source_authority.v2";
export const R31_ACTIVE_SOURCE_OBSERVED_HEAD = "b13243e687173a5342356361956a2fd5eec81138";
export const R31_R35_SOURCE_SHA = "f9b88d8bb4a5e0844ec8448d09fafa96f0aff7e9";
export const R31_R36_SOURCE_SHA = "7f643b4f1f803b637e1b377ac4989bc79d03c4dd";
export const R31_R37_SOURCE_SHA = "59090e82d1c20e8c6ffb40fbcf38e7a0e34405b5";
export const PROTECTED_PATH_POLICY_ID = "pc.native.facade.protected_path_fail_closed.v1";

const READ_ONLY = "read_only";
const SIDE_EFFECT = "side_effect";

function gitBlobSha1(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const header = Buffer.from(`blob ${buffer.length}\0`, "utf8");
  return createHash("sha1").update(header).update(buffer).digest("hex");
}

function sourceText(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function canonicalTextBlob(text) {
  return gitBlobSha1(Buffer.from(String(text).replace(/\r\n/g, "\n"), "utf8"));
}

function sourcePinError(message, code = "R31_SOURCE_PIN_INVALID", details = null) {
  throw new PcControlDirectGatewayError(message, {
    code,
    category: "source_pin",
    details,
  });
}

export function validateR31SourcePin({
  pin: suppliedPin = null,
  readText = sourceText,
} = {}) {
  const pin = suppliedPin ?? JSON.parse(readText(
    "conformance/r31_pc_control_direct/source-pin.json",
  ));
  if (pin.contract_version !== R31_ACTIVE_SOURCE_AUTHORITY_CONTRACT
      || pin.repository !== "foto6/help-pc-2"
      || pin.lineage_observed_head !== R31_ACTIVE_SOURCE_OBSERVED_HEAD
      || pin.historical_predecessor?.contract_version !== "pc.control.r31.source_pin.v1"
      || pin.historical_predecessor?.exact_sha !== R31_R30_SOURCE_SHA
      || pin.historical_predecessor?.exact_head_ci?.run_id !== 36985223664
      || pin.historical_predecessor?.exact_head_ci?.conclusion !== "success"
      || pin.contracts?.transport !== "pc.native.direct_remote_mcp.v1"
      || pin.contracts?.health !== "pc.native.direct_remote_mcp.health.v1"
      || pin.contracts?.native_protocol !== "pc.native.control.v1"
      || pin.contracts?.operator_lifecycle !== "native_mcp.operator_lifecycle.r37.v1"
      || pin.safety_invariants?.current_authority !== "github_relay"
      || pin.safety_invariants?.automatic_replay !== false
      || pin.safety_invariants?.live_remote_registration !== false
      || pin.safety_invariants?.production_cutover !== false
      || pin.safety_invariants?.firewall_or_tunnel_mutation !== false) {
    sourcePinError("Active direct source authority metadata is invalid.");
  }

  const acceptance = pin.recovery_acceptance ?? {};
  if (!["pending_r38_exact_head_ci", "accepted"].includes(acceptance.status)) {
    sourcePinError("R38 recovery acceptance state is invalid.");
  }
  if (acceptance.status === "accepted"
      && (acceptance.ci_run_id !== 37405176472
          || acceptance.head_sha !== "5241858a029d293f7d200045c585adefc37dde5b"
          || acceptance.conclusion !== "success"
          || acceptance.ubuntu_job?.id !== 112081028344
          || acceptance.ubuntu_job?.conclusion !== "success"
          || acceptance.windows_job?.id !== 112081028474
          || acceptance.windows_job?.conclusion !== "success")) {
    sourcePinError("Accepted R38 source authority CI evidence is not the exact green acceptance run.");
  }

  const successors = new Map(
    (Array.isArray(pin.accepted_successors) ? pin.accepted_successors : [])
      .map((item) => [item.milestone, item]),
  );
  const r35 = successors.get("R35");
  const r36 = successors.get("R36");
  const r37 = successors.get("R37");
  if (successors.size !== 3
      || r35?.exact_code_sha !== R31_R35_SOURCE_SHA
      || r35?.contract_version !== "pc.control.r35.source_pin.v1"
      || r35?.pin_path !== "conformance/r35_quiescent_epoch_rebind/source-pin.json"
      || r35?.pin_blob !== "7a080e055815acc8467f13d66b4df2053bb1d308"
      || r36?.exact_code_sha !== R31_R36_SOURCE_SHA
      || r36?.contract_version !== "pc.control.r36.source_pin.v1"
      || r36?.pin_path !== "conformance/r36_public_host_gate/source-pin.json"
      || r36?.pin_blob !== "025d2be61d0ae074423b1197663b59d81b5adf32"
      || r37?.exact_code_sha !== R31_R37_SOURCE_SHA
      || r37?.contract_version !== "native_mcp.operator_lifecycle.r37.v1"
      || r37?.source_path !== "src/r37-operator-lifecycle.js"
      || r37?.source_blob !== "dd47df2ea203fad47234520f246da1955558faac") {
    sourcePinError("Accepted direct source successor lineage is invalid.", "R31_SOURCE_LINEAGE_INVALID");
  }

  const historical = JSON.parse(readText(
    "conformance/r31_pc_control_direct/source-pin.r30-historical.json",
  ));
  if (historical.contract_version !== "pc.control.r31.source_pin.v1"
      || historical.exact_sha !== R31_R30_SOURCE_SHA
      || historical.exact_head_ci?.run_id !== 36985223664
      || historical.exact_head_ci?.conclusion !== "success") {
    sourcePinError("Historical R30 predecessor pin was mutated.", "R31_SOURCE_LINEAGE_INVALID");
  }

  const r35Text = readText(r35.pin_path);
  const r36Text = readText(r36.pin_path);
  if (canonicalTextBlob(r35Text) !== r35.pin_blob
      || canonicalTextBlob(r36Text) !== r36.pin_blob
      || canonicalTextBlob(readText(r37.source_path)) !== r37.source_blob) {
    sourcePinError("Accepted successor evidence bytes drifted.", "R31_SOURCE_LINEAGE_INVALID");
  }
  const r35Pin = JSON.parse(r35Text);
  const r36Pin = JSON.parse(r36Text);
  if (r35Pin.exact_code_sha !== R31_R35_SOURCE_SHA
      || r35Pin.blobs?.["src/mcp-host.js"] !== pin.active_blobs?.["src/mcp-host.js"]
      || r35Pin.blobs?.["src/native-relay-provider.js"] !== pin.active_blobs?.["src/native-relay-provider.js"]
      || r36Pin.exact_code_sha !== R31_R36_SOURCE_SHA
      || r36Pin.blobs?.["src/direct-remote-mcp.js"] !== pin.active_blobs?.["src/direct-remote-mcp.js"]) {
    sourcePinError("Active blobs are not justified by accepted successor pins.", "R31_SOURCE_LINEAGE_INVALID");
  }

  const diagnostic = pin.regression_evidence?.r37_diagnostic_ci;
  if (pin.regression_evidence?.r36_live_public_canary_contract !== "pc.control.r36.live_public_canary.v1"
      || pin.regression_evidence?.r36_focused_regression !== "48/48 PASS"
      || diagnostic?.run_id !== 37398892815
      || diagnostic?.head_sha !== R31_ACTIVE_SOURCE_OBSERVED_HEAD
      || diagnostic?.failure_only !== "Generate exact-head R31 pc-control direct readiness"
      || diagnostic?.ubuntu_full_test_suite !== "success"
      || diagnostic?.ubuntu_r29_relay_cutover_qa !== "success"
      || diagnostic?.ubuntu_r30_direct_remote !== "success"
      || diagnostic?.ubuntu_r31_direct_candidate !== "success"
      || diagnostic?.ubuntu_r37_operator_lifecycle !== "success"
      || diagnostic?.windows_r29_relay_cutover_qa !== "success"
      || diagnostic?.windows_r30_direct_remote !== "success"
      || diagnostic?.windows_r31_direct_candidate !== "success"
      || diagnostic?.windows_r37_operator_lifecycle !== "success") {
    sourcePinError("Successor regression/diagnostic CI evidence is incomplete.", "R31_SOURCE_LINEAGE_INVALID");
  }

  for (const [path, expected] of Object.entries(pin.active_blobs ?? {})) {
    const actual = canonicalTextBlob(readText(path));
    if (actual !== expected) {
      sourcePinError("Pinned active source blob drifted.", "R31_SOURCE_BLOB_DRIFT", {
        path,
        expected,
        actual,
      });
    }
  }
  return structuredClone(pin);
}

export function loadR31PluginCandidateMetadata() {
  const metadata = JSON.parse(readFileSync(
    new URL("../conformance/r31_pc_control_direct/plugin-candidate.json", import.meta.url),
    "utf8",
  ));
  if (metadata.contract_version !== PC_CONTROL_PLUGIN_CANDIDATE_V1
      || metadata.current_authority !== "github_relay"
      || metadata.actual_pc_control_cutover !== false
      || metadata.migration?.side_effect_authority !== "github_relay"
      || metadata.migration?.side_effect_mirroring_allowed !== false
      || metadata.request_semantics?.automatic_replay !== false) {
    throw new PcControlDirectGatewayError("R31 plugin candidate metadata is invalid.", {
      code: "R31_PLUGIN_CANDIDATE_METADATA_INVALID",
      category: "source_pin",
    });
  }
  return structuredClone(metadata);
}

export class PcControlDirectGatewayError extends Error {
  constructor(message, {
    code = "PC_CONTROL_DIRECT_GATEWAY_ERROR",
    category = "pc_control_direct_gateway",
    retryable = false,
    details = null,
  } = {}) {
    super(message);
    this.name = "PcControlDirectGatewayError";
    this.code = code;
    this.category = category;
    this.retryable = retryable;
    this.details = details;
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}

export function digestJson(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function boundedInt(value, name, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function normalizeEndpoint(value, { allowInsecureHttpForTests = false } = {}) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError("endpoint is required");
  let url;
  try { url = new URL(value); } catch { throw new TypeError("endpoint must be an absolute URL"); }
  if (!["https:", ...(allowInsecureHttpForTests ? ["http:"] : [])].includes(url.protocol)) {
    throw new TypeError("endpoint must use https outside isolated tests");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError("endpoint must not contain credentials, query, or fragment");
  }
  if (url.pathname !== "/mcp") throw new TypeError("endpoint path must be exactly /mcp");
  return url;
}

function normalizeToken(value) {
  if (typeof value !== "string" || value.length < 32) {
    throw new TypeError("token must contain at least 32 characters");
  }
  return value;
}

function withTimeout(promiseFactory, timeoutMs, code) {
  const controller = new AbortController();
  let timer = null;
  const operation = Promise.resolve().then(() => promiseFactory(controller.signal));
  operation.catch(() => {});
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new PcControlDirectGatewayError("Direct candidate request timed out.", {
        code,
        category: "timeout",
        retryable: false,
      });
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function toolEffect(tool) {
  return tool?._meta?.["pc.native/effect"]
    ?? tool?._meta?.["pc.desktop_commander/effect"]
    ?? null;
}

function toolAvailable(tool) {
  const native = tool?._meta?.["pc.native/available"];
  const compatibility = tool?._meta?.["pc.desktop_commander/available"];
  if (typeof native === "boolean") return native;
  if (typeof compatibility === "boolean") return compatibility;
  return null;
}

function firstUnique(values, field) {
  const unique = [...new Set(values.filter((value) => typeof value === "string" && value))];
  if (unique.length > 1) {
    throw new PcControlDirectGatewayError(`Direct candidate exposed inconsistent ${field}.`, {
      code: "DIRECT_CAPABILITY_INCONSISTENT",
      category: "capability",
      details: { field, count: unique.length },
    });
  }
  return unique[0] ?? null;
}

export function pluginSurfaceFromMcp({ health, tools, observedAtMs = Date.now(), latencyMs = null }) {
  if (!health || typeof health !== "object" || Array.isArray(health)) {
    throw new PcControlDirectGatewayError("Direct health payload is missing.", {
      code: "DIRECT_HEALTH_INVALID",
      category: "health",
    });
  }
  if (!Array.isArray(tools)) {
    throw new PcControlDirectGatewayError("Direct tools/list payload is missing.", {
      code: "DIRECT_TOOL_LIST_INVALID",
      category: "schema",
    });
  }
  const normalizedTools = tools.map((tool) => {
    const effect = toolEffect(tool);
    if (![READ_ONLY, SIDE_EFFECT].includes(effect)) {
      throw new PcControlDirectGatewayError("Direct tool effect classification is missing or invalid.", {
        code: "DIRECT_TOOL_EFFECT_INVALID",
        category: "schema",
        details: { tool: tool?.name ?? null },
      });
    }
    if (typeof tool?.name !== "string" || !tool.name) {
      throw new PcControlDirectGatewayError("Direct tool name is invalid.", {
        code: "DIRECT_TOOL_SCHEMA_INVALID",
        category: "schema",
      });
    }
    return {
      name: tool.name,
      effect,
      available: toolAvailable(tool),
      input_schema_digest: digestJson(tool.inputSchema ?? null),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const nativeRegistryDigest = firstUnique(
    tools.map((tool) => tool?._meta?.["pc.native/registry_digest"]
      ?? tool?._meta?.["pc.desktop_commander/native_registry_digest"]),
    "native registry digest",
  );
  const executorDigest = firstUnique(
    tools.map((tool) => tool?._meta?.["pc.native/executor_digest"]
      ?? tool?._meta?.["pc.desktop_commander/executor_digest"]),
    "Executor digest",
  );
  const compatibilityRegistryDigest = firstUnique(
    tools.map((tool) => tool?._meta?.["pc.desktop_commander/compat_registry_digest"]),
    "compatibility registry digest",
  );

  const surface = {
    contract_version: PC_CONTROL_PLUGIN_SURFACE_V1,
    source_lane: "direct_mcp_candidate",
    observed_at_ms: observedAtMs,
    health: {
      status: health.status ?? "UNKNOWN",
      reason: health.reason ?? null,
      latency_ms: latencyMs,
      transport_connected: health.transport_connected ?? null,
      queue_progressing: health.queue_progressing ?? null,
      executor_responsive: health.executor_responsive ?? null,
    },
    capabilities: {
      protocol_version: health.protocol_version ?? null,
      native_registry_digest: nativeRegistryDigest ?? health.registry_digest ?? null,
      executor_digest: executorDigest ?? health.executor_digest ?? null,
      compatibility_registry_digest: compatibilityRegistryDigest,
      protected_path_policy: PROTECTED_PATH_POLICY_ID,
      explicit_side_effect_request_id_required: true,
      reconciliation_status: "reconciliation_required",
      automatic_replay: false,
    },
    tools: normalizedTools,
  };
  return {
    ...surface,
    tool_surface_digest: digestJson({
      capabilities: surface.capabilities,
      tools: surface.tools,
    }),
  };
}

function healthUrlFromMcp(endpoint) {
  const url = new URL(endpoint);
  url.pathname = "/healthz";
  return url;
}

function mapTransportError(error) {
  if (error instanceof PcControlDirectGatewayError) return error;
  const text = String(error?.message ?? error);
  const status = error?.status ?? error?.response?.status ?? null;
  if (status === 401 || /401|unauthorized/i.test(text)) {
    return new PcControlDirectGatewayError("Direct MCP authentication failed.", {
      code: "DIRECT_AUTH_MISMATCH",
      category: "auth",
    });
  }
  return new PcControlDirectGatewayError("Direct MCP lane is unavailable.", {
    code: "DIRECT_LANE_UNAVAILABLE",
    category: "transport",
    retryable: false,
  });
}

export class PcControlDirectCandidateGateway {
  #token;

  constructor({
    endpoint,
    token,
    fetchImpl = globalThis.fetch,
    clientFactory = null,
    connectTimeoutMs = 5_000,
    requestTimeoutMs = 30_000,
    allowInsecureHttpForTests = false,
    mode = "read_only_canary",
  } = {}) {
    this.endpoint = normalizeEndpoint(endpoint, { allowInsecureHttpForTests });
    this.#token = normalizeToken(token);
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
    if (clientFactory !== null && typeof clientFactory !== "function") {
      throw new TypeError("clientFactory must be a function or null");
    }
    boundedInt(connectTimeoutMs, "connectTimeoutMs", 100, 30_000);
    boundedInt(requestTimeoutMs, "requestTimeoutMs", 250, 120_000);
    if (!["read_only_canary", "explicit_plugin_candidate"].includes(mode)) {
      throw new TypeError("mode must be read_only_canary or explicit_plugin_candidate");
    }
    this.fetchImpl = fetchImpl;
    this.clientFactory = clientFactory;
    this.connectTimeoutMs = connectTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.mode = mode;
    this.client = null;
    this.toolIndex = null;
  }

  async #client() {
    if (this.client) return this.client;
    try {
      if (this.clientFactory) {
        this.client = await withTimeout(
          () => this.clientFactory({
            endpoint: new URL(this.endpoint),
            token: this.#token,
          }),
          this.connectTimeoutMs,
          "DIRECT_CONNECT_TIMEOUT",
        );
        return this.client;
      }
      const transport = new StreamableHTTPClientTransport(new URL(this.endpoint), {
        authProvider: { token: async () => this.#token },
      });
      const client = new Client(
        { name: "pc-control-direct-candidate", version: "0.3.0-candidate" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      await withTimeout(
        () => client.connect(transport),
        this.connectTimeoutMs,
        "DIRECT_CONNECT_TIMEOUT",
      );
      this.client = client;
      return client;
    } catch (error) {
      throw mapTransportError(error);
    }
  }

  async health() {
    const target = healthUrlFromMcp(this.endpoint);
    const started = performance.now();
    try {
      const response = await withTimeout(
        (signal) => this.fetchImpl(target, {
          headers: { authorization: `Bearer ${this.#token}` },
          signal,
        }),
        this.connectTimeoutMs,
        "DIRECT_HEALTH_TIMEOUT",
      );
      let body = null;
      try { body = await response.json(); } catch {}
      if (response.status === 401) {
        throw new PcControlDirectGatewayError("Direct MCP authentication failed.", {
          code: "DIRECT_AUTH_MISMATCH",
          category: "auth",
        });
      }
      if (!response.ok && response.status !== 503) {
        throw new PcControlDirectGatewayError("Direct MCP health request failed.", {
          code: "DIRECT_HEALTH_UNAVAILABLE",
          category: "health",
        });
      }
      if (!body || typeof body !== "object" || Array.isArray(body)
          || typeof body.contract_version !== "string") {
        throw new PcControlDirectGatewayError("Direct MCP health schema is invalid.", {
          code: "DIRECT_HEALTH_SCHEMA_MISMATCH",
          category: "schema",
        });
      }
      return {
        payload: body,
        latency_ms: Math.round((performance.now() - started) * 1000) / 1000,
      };
    } catch (error) {
      throw mapTransportError(error);
    }
  }

  async listTools() {
    try {
      const client = await this.#client();
      const listed = await withTimeout(
        () => client.listTools(),
        this.requestTimeoutMs,
        "DIRECT_TOOLS_LIST_TIMEOUT",
      );
      if (!Array.isArray(listed?.tools)) {
        throw new PcControlDirectGatewayError("Direct tools/list schema is invalid.", {
          code: "DIRECT_TOOL_LIST_INVALID",
          category: "schema",
        });
      }
      this.toolIndex = new Map(listed.tools.map((tool) => [tool.name, tool]));
      return listed.tools;
    } catch (error) {
      throw mapTransportError(error);
    }
  }

  async describe() {
    const health = await this.health();
    const tools = await this.listTools();
    return pluginSurfaceFromMcp({
      health: health.payload,
      tools,
      latencyMs: health.latency_ms,
    });
  }

  async callTool({ name, arguments: args = {} } = {}) {
    if (typeof name !== "string" || !name) throw new TypeError("tool name is required");
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw new TypeError("tool arguments must be an object");
    }
    const tools = this.toolIndex ? [...this.toolIndex.values()] : await this.listTools();
    const tool = this.toolIndex?.get(name) ?? tools.find((entry) => entry.name === name);
    if (!tool) {
      throw new PcControlDirectGatewayError("Direct candidate tool is not advertised.", {
        code: "DIRECT_TOOL_NOT_FOUND",
        category: "tool",
      });
    }
    const effect = toolEffect(tool);
    if (effect === SIDE_EFFECT && this.mode !== "explicit_plugin_candidate") {
      throw new PcControlDirectGatewayError("Candidate side effects are blocked in dual-lane canary mode.", {
        code: "CANDIDATE_SIDE_EFFECT_BLOCKED",
        category: "policy",
      });
    }
    if (effect === SIDE_EFFECT && (typeof args.request_id !== "string" || !args.request_id)) {
      throw new PcControlDirectGatewayError("Candidate side effects require the stable plugin request_id.", {
        code: "REMOTE_STABLE_REQUEST_ID_REQUIRED",
        category: "idempotency",
      });
    }
    try {
      const client = await this.#client();
      const result = await withTimeout(
        () => client.callTool({ name, arguments: args }),
        this.requestTimeoutMs,
        "DIRECT_TOOL_CALL_TIMEOUT",
      );
      const structured = result?.structuredContent && typeof result.structuredContent === "object"
        ? result.structuredContent
        : null;
      if (structured?.status === "reconciliation_required") {
        return {
          contract_version: PC_CONTROL_DIRECT_GATEWAY_V1,
          lane: "direct_mcp_candidate",
          tool: name,
          status: "reconciliation_required",
          request_id: structured.request_id ?? args.request_id ?? null,
          automatic_replay: false,
          fallback_authorized: false,
          result: structured,
        };
      }
      return {
        contract_version: PC_CONTROL_DIRECT_GATEWAY_V1,
        lane: "direct_mcp_candidate",
        tool: name,
        status: structured?.status ?? (result?.isError ? "error" : "completed"),
        request_id: structured?.request_id ?? args.request_id ?? null,
        automatic_replay: false,
        fallback_authorized: false,
        result: structured,
      };
    } catch (error) {
      const mapped = mapTransportError(error);
      if (effect === SIDE_EFFECT
          && typeof args.request_id === "string"
          && args.request_id
          && !["DIRECT_AUTH_MISMATCH", "DIRECT_CONNECT_TIMEOUT"].includes(mapped.code)) {
        return {
          contract_version: PC_CONTROL_DIRECT_GATEWAY_V1,
          lane: "direct_mcp_candidate",
          tool: name,
          status: "reconciliation_required",
          request_id: args.request_id,
          automatic_replay: false,
          fallback_authorized: false,
          result: {
            contract_version: "pc.native.response.v1",
            request_id: args.request_id,
            status: "reconciliation_required",
            data: {
              lookup_required: true,
              reason: mapped.code,
              automatic_replay: false,
            },
            error: null,
          },
        };
      }
      throw mapped;
    }
  }

  async close() {
    const client = this.client;
    this.client = null;
    this.toolIndex = null;
    if (client && typeof client.close === "function") {
      await client.close().catch(() => {});
    }
  }
}

function normalizedToolMap(surface) {
  if (!surface || surface.contract_version !== PC_CONTROL_PLUGIN_SURFACE_V1
      || !Array.isArray(surface.tools)) {
    throw new PcControlDirectGatewayError("Plugin surface contract is invalid.", {
      code: "PLUGIN_SURFACE_SCHEMA_MISMATCH",
      category: "schema",
    });
  }
  return new Map(surface.tools.map((tool) => [tool.name, tool]));
}

export function comparePluginSurfaces(authority, candidate, {
  maxHealthLatencyMs = 5_000,
} = {}) {
  boundedInt(maxHealthLatencyMs, "maxHealthLatencyMs", 1, 120_000);
  const blockers = [];
  const authorityTools = normalizedToolMap(authority);
  const candidateTools = normalizedToolMap(candidate);
  const fail = (code, detail = null) => blockers.push({ code, detail });

  if (authority.capabilities?.native_registry_digest
      !== candidate.capabilities?.native_registry_digest) {
    fail("REGISTRY_DIGEST_MISMATCH");
  }
  if (authority.capabilities?.executor_digest
      !== candidate.capabilities?.executor_digest) {
    fail("EXECUTOR_DIGEST_MISMATCH");
  }
  if (authority.capabilities?.protected_path_policy
      !== candidate.capabilities?.protected_path_policy) {
    fail("PROTECTED_PATH_POLICY_MISMATCH");
  }
  if (candidate.capabilities?.explicit_side_effect_request_id_required !== true) {
    fail("REQUEST_ID_SEMANTICS_MISMATCH");
  }
  if (candidate.capabilities?.automatic_replay !== false
      || candidate.capabilities?.reconciliation_status !== "reconciliation_required") {
    fail("RECONCILIATION_SEMANTICS_MISMATCH");
  }
  if (!["HEALTHY", "DEGRADED"].includes(candidate.health?.status)) {
    fail("DIRECT_HEALTH_BLOCKED", candidate.health?.status ?? "UNKNOWN");
  }
  if (authority.health?.status !== candidate.health?.status) {
    fail("HEALTH_STATUS_MISMATCH", {
      authority: authority.health?.status ?? "UNKNOWN",
      candidate: candidate.health?.status ?? "UNKNOWN",
    });
  }
  if (!Number.isFinite(candidate.health?.latency_ms)
      || candidate.health.latency_ms > maxHealthLatencyMs) {
    fail("DIRECT_HEALTH_LATENCY_BOUND");
  }
  if (!Number.isFinite(authority.health?.latency_ms)
      || authority.health.latency_ms > maxHealthLatencyMs) {
    fail("AUTHORITY_HEALTH_LATENCY_BOUND");
  }
  if (candidate.health?.transport_connected !== true
      || candidate.health?.executor_responsive !== true) {
    fail("DIRECT_TRANSPORT_NOT_READY");
  }

  const allNames = [...new Set([...authorityTools.keys(), ...candidateTools.keys()])].sort();
  for (const name of allNames) {
    const left = authorityTools.get(name);
    const right = candidateTools.get(name);
    if (!left || !right) {
      fail("TOOL_AVAILABILITY_MISMATCH", name);
      continue;
    }
    if (left.effect !== right.effect) fail("TOOL_EFFECT_MISMATCH", name);
    if (left.available !== right.available) fail("TOOL_AVAILABILITY_MISMATCH", name);
    if (left.input_schema_digest !== right.input_schema_digest) {
      fail("TOOL_SCHEMA_MISMATCH", name);
    }
  }

  return {
    compatible: blockers.length === 0,
    blockers,
    authority_tool_surface_digest: authority.tool_surface_digest ?? null,
    candidate_tool_surface_digest: candidate.tool_surface_digest ?? null,
  };
}

export class PcControlDualLaneGateway {
  constructor({
    authority,
    candidate,
    mirrorReadOnly = false,
  } = {}) {
    if (!authority || typeof authority.callTool !== "function" || typeof authority.describe !== "function") {
      throw new TypeError("authority must provide describe() and callTool()");
    }
    if (!(candidate instanceof PcControlDirectCandidateGateway)
        && (!candidate || typeof candidate.callTool !== "function" || typeof candidate.describe !== "function")) {
      throw new TypeError("candidate must provide describe() and callTool()");
    }
    this.authority = authority;
    this.candidate = candidate;
    this.mirrorReadOnly = mirrorReadOnly === true;
  }

  async describe() {
    const [authority, candidate] = await Promise.all([
      this.authority.describe(),
      this.candidate.describe(),
    ]);
    return { authority, candidate };
  }

  async callTool({ name, arguments: args = {} } = {}) {
    const authoritySurface = await this.authority.describe();
    const tool = normalizedToolMap(authoritySurface).get(name);
    if (!tool) {
      throw new PcControlDirectGatewayError("Authority tool is not advertised.", {
        code: "AUTHORITY_TOOL_NOT_FOUND",
        category: "tool",
      });
    }
    if (tool.effect === SIDE_EFFECT) {
      return this.authority.callTool({ name, arguments: args });
    }
    if (!this.mirrorReadOnly) {
      return this.authority.callTool({ name, arguments: args });
    }
    const [authorityOutcome, candidateOutcome] = await Promise.allSettled([
      this.authority.callTool({ name, arguments: args }),
      this.candidate.callTool({ name, arguments: args }),
    ]);
    if (authorityOutcome.status === "rejected") throw authorityOutcome.reason;
    const candidateProbe = candidateOutcome.status === "fulfilled"
      ? {
          status: candidateOutcome.value?.status ?? null,
          request_id: candidateOutcome.value?.request_id ?? null,
          result_digest: digestJson(candidateOutcome.value?.result ?? null),
          error_code: null,
        }
      : {
          status: "blocked",
          request_id: null,
          result_digest: null,
          error_code: candidateOutcome.reason?.code ?? "DIRECT_READ_ONLY_PROBE_FAILED",
        };
    return {
      authority: authorityOutcome.value,
      candidate_read_only_probe: candidateProbe,
      side_effect_mirrored: false,
    };
  }
}

export function evaluateR31Readiness({
  sourceReady,
  authoritySurface = null,
  candidateSurface = null,
  canaryEvidence = null,
  explicitPluginCandidateEvaluation = false,
  maxHealthLatencyMs = 5_000,
} = {}) {
  if (sourceReady !== true) {
    return {
      contract_version: PC_CONTROL_READINESS_V1,
      state: "BLOCKED",
      blockers: [{ code: "SOURCE_NOT_READY" }],
      actual_pc_control_cutover: false,
      current_authority: "github_relay",
    };
  }

  if (!authoritySurface || !candidateSurface || !canaryEvidence) {
    return {
      contract_version: PC_CONTROL_READINESS_V1,
      state: "SOURCE_READY",
      blockers: [],
      actual_pc_control_cutover: false,
      current_authority: "github_relay",
    };
  }

  let comparison;
  try {
    comparison = comparePluginSurfaces(authoritySurface, candidateSurface, { maxHealthLatencyMs });
  } catch (error) {
    return {
      contract_version: PC_CONTROL_READINESS_V1,
      state: "BLOCKED",
      blockers: [{ code: error?.code ?? "SURFACE_COMPARISON_FAILED" }],
      actual_pc_control_cutover: false,
      current_authority: "github_relay",
    };
  }
  const blockers = [...comparison.blockers];

  if (canaryEvidence.contract_version !== PC_CONTROL_CANARY_EVIDENCE_V1) {
    blockers.push({ code: "CANARY_SCHEMA_MISMATCH" });
  }
  if (canaryEvidence.side_effect_calls !== 0) {
    blockers.push({ code: "CANARY_SIDE_EFFECT_VIOLATION" });
  }
  if (canaryEvidence.replay_authorized === true) {
    blockers.push({ code: "REPLAY_AUTHORIZATION_FORBIDDEN" });
  }
  if (canaryEvidence.status !== "PASS") {
    blockers.push({ code: "CANARY_NOT_PASS" });
  }
  if (blockers.length) {
    return {
      contract_version: PC_CONTROL_READINESS_V1,
      state: "BLOCKED",
      blockers,
      comparison,
      actual_pc_control_cutover: false,
      current_authority: "github_relay",
    };
  }

  if (canaryEvidence.evidence_origin !== "live_explicit_read_only_canary") {
    return {
      contract_version: PC_CONTROL_READINESS_V1,
      state: "SOURCE_READY",
      blockers: [],
      comparison,
      actual_pc_control_cutover: false,
      current_authority: "github_relay",
      reason: "source_or_synthetic_evidence_cannot_advance_plugin_readiness",
    };
  }

  return {
    contract_version: PC_CONTROL_READINESS_V1,
    state: explicitPluginCandidateEvaluation
      ? "READY_FOR_EXPLICIT_PLUGIN_CANDIDATE"
      : "READ_ONLY_CANARY_PASS",
    blockers: [],
    comparison,
    actual_pc_control_cutover: false,
    current_authority: "github_relay",
  };
}

export async function runReadOnlyCanary({
  gateway,
  tools = ["device.ping", "device.info"],
  evidenceOrigin = "runtime_probe_unattested",
} = {}) {
  if (!gateway || typeof gateway.describe !== "function" || typeof gateway.callTool !== "function") {
    throw new TypeError("gateway must provide describe() and callTool()");
  }
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new TypeError("tools must be a non-empty array");
  }
  const startedAtMs = Date.now();
  const surface = await gateway.describe();
  const toolMap = normalizedToolMap(surface);
  const calls = [];
  for (const name of tools) {
    const tool = toolMap.get(name);
    if (!tool) {
      throw new PcControlDirectGatewayError("Canary tool is not advertised.", {
        code: "CANARY_TOOL_NOT_FOUND",
        category: "canary",
        details: { tool: name },
      });
    }
    if (tool.effect !== READ_ONLY) {
      throw new PcControlDirectGatewayError("Canary tool must be read-only.", {
        code: "CANARY_SIDE_EFFECT_FORBIDDEN",
        category: "policy",
        details: { tool: name },
      });
    }
    const callStarted = performance.now();
    const result = await gateway.callTool({ name, arguments: {} });
    calls.push({
      tool: name,
      effect: READ_ONLY,
      status: result.status,
      latency_ms: Math.round((performance.now() - callStarted) * 1000) / 1000,
      request_id_present: typeof result.request_id === "string" && result.request_id.length > 0,
      result_digest: digestJson(result.result ?? null),
    });
  }
  const completedAtMs = Date.now();
  const evidence = buildCanaryEvidence({
    evidenceOrigin,
    surface,
    calls,
    startedAtMs,
    completedAtMs,
  });
  return { surface, evidence };
}

export function buildCanaryEvidence({
  evidenceOrigin,
  surface,
  calls,
  startedAtMs,
  completedAtMs,
} = {}) {
  const normalizedCalls = Array.isArray(calls) ? calls.map((call) => ({
    tool: call.tool,
    effect: call.effect,
    status: call.status,
    latency_ms: call.latency_ms,
    request_id_present: call.request_id_present === true,
    result_digest: call.result_digest ?? null,
  })) : [];
  const sideEffectCalls = normalizedCalls.filter((call) => call.effect === SIDE_EFFECT).length;
  const status = surface
    && ["HEALTHY", "DEGRADED"].includes(surface.health?.status)
    && sideEffectCalls === 0
    && normalizedCalls.every((call) => call.status === "completed")
      ? "PASS" : "BLOCKED";
  return {
    contract_version: PC_CONTROL_CANARY_EVIDENCE_V1,
    evidence_origin: evidenceOrigin ?? "source_fixture",
    status,
    started_at_ms: startedAtMs ?? null,
    completed_at_ms: completedAtMs ?? null,
    side_effect_calls: sideEffectCalls,
    replay_authorized: false,
    surface_digest: surface?.tool_surface_digest ?? null,
    capability_registry_digest: surface?.capabilities?.native_registry_digest ?? null,
    executor_digest: surface?.capabilities?.executor_digest ?? null,
    health_status: surface?.health?.status ?? "UNKNOWN",
    health_latency_ms: surface?.health?.latency_ms ?? null,
    calls: normalizedCalls,
  };
}
