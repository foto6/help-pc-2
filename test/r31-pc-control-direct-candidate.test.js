import test from "node:test";
import assert from "node:assert/strict";

import {
  PcControlDirectCandidateGateway,
  PcControlDirectGatewayError,
  PcControlDualLaneGateway,
  PC_CONTROL_CANARY_EVIDENCE_V1,
  PC_CONTROL_PLUGIN_SURFACE_V1,
  PROTECTED_PATH_POLICY_ID,
  R31_R30_SOURCE_SHA,
  buildCanaryEvidence,
  comparePluginSurfaces,
  digestJson,
  evaluateR31Readiness,
  loadR31PluginCandidateMetadata,
  validateR31SourcePin,
} from "../src/pc-control-direct-candidate.js";

const TOKEN = "r31-direct-client-token-0123456789abcdef-0123456789";
const DIGEST = "a".repeat(64);
const EXECUTOR = "b".repeat(64);

function surface({
  lane = "github_relay",
  registry = DIGEST,
  executor = EXECUTOR,
  health = "HEALTHY",
  latency = 10,
  protectedPolicy = PROTECTED_PATH_POLICY_ID,
  automaticReplay = false,
  reconciliation = "reconciliation_required",
  requestIdRequired = true,
  tools = null,
} = {}) {
  const normalizedTools = tools ?? [
    {
      name: "device.ping",
      effect: "read_only",
      available: true,
      input_schema_digest: digestJson({ type: "object", properties: {} }),
    },
    {
      name: "file.write",
      effect: "side_effect",
      available: true,
      input_schema_digest: digestJson({ type: "object", properties: { path: { type: "string" } } }),
    },
  ];
  const capabilities = {
    protocol_version: "pc.native.control.v1",
    native_registry_digest: registry,
    executor_digest: executor,
    compatibility_registry_digest: "c".repeat(64),
    protected_path_policy: protectedPolicy,
    explicit_side_effect_request_id_required: requestIdRequired,
    reconciliation_status: reconciliation,
    automatic_replay: automaticReplay,
  };
  return {
    contract_version: PC_CONTROL_PLUGIN_SURFACE_V1,
    source_lane: lane,
    observed_at_ms: 1,
    health: {
      status: health,
      reason: null,
      latency_ms: latency,
      transport_connected: true,
      queue_progressing: true,
      executor_responsive: true,
    },
    capabilities,
    tools: normalizedTools,
    tool_surface_digest: digestJson({ capabilities, tools: normalizedTools }),
  };
}

function canary({
  origin = "synthetic_ci",
  status = "PASS",
  sideEffects = 0,
  replay = false,
} = {}) {
  return {
    contract_version: PC_CONTROL_CANARY_EVIDENCE_V1,
    evidence_origin: origin,
    status,
    started_at_ms: 1,
    completed_at_ms: 2,
    side_effect_calls: sideEffects,
    replay_authorized: replay,
    surface_digest: DIGEST,
    capability_registry_digest: DIGEST,
    executor_digest: EXECUTOR,
    health_status: "HEALTHY",
    health_latency_ms: 10,
    calls: [],
  };
}

function fakeTool(name, effect, available = true) {
  const prefix = name.includes(".") ? "pc.native" : "pc.desktop_commander";
  return {
    name,
    inputSchema: { type: "object", properties: {} },
    _meta: prefix === "pc.native"
      ? {
          "pc.native/effect": effect,
          "pc.native/available": available,
          "pc.native/registry_digest": DIGEST,
          "pc.native/executor_digest": EXECUTOR,
        }
      : {
          "pc.desktop_commander/effect": effect,
          "pc.desktop_commander/available": available,
          "pc.desktop_commander/native_registry_digest": DIGEST,
          "pc.desktop_commander/executor_digest": EXECUTOR,
          "pc.desktop_commander/compat_registry_digest": "c".repeat(64),
        },
  };
}

test("R31 source pin validates exact R30 green blobs and candidate metadata keeps GitHub relay authoritative", () => {
  const pin = validateR31SourcePin();
  assert.equal(pin.exact_sha, R31_R30_SOURCE_SHA);
  assert.equal(pin.exact_head_ci.run_id, 36985223664);
  assert.equal(pin.exact_head_ci.conclusion, "success");

  const metadata = loadR31PluginCandidateMetadata();
  assert.equal(metadata.candidate_version, "0.3.0-candidate");
  assert.equal(metadata.current_authority, "github_relay");
  assert.equal(metadata.actual_pc_control_cutover, false);
  assert.equal(metadata.migration.side_effect_authority, "github_relay");
  assert.equal(metadata.migration.side_effect_mirroring_allowed, false);
  assert.equal(metadata.request_semantics.automatic_replay, false);
});

test("gateway credentials are private and never serialize into plugin state", () => {
  const gateway = new PcControlDirectCandidateGateway({
    endpoint: "http://127.0.0.1:12345/mcp",
    token: TOKEN,
    allowInsecureHttpForTests: true,
    clientFactory: async () => ({
      listTools: async () => ({ tools: [] }),
      close: async () => {},
    }),
    fetchImpl: async () => new Response("{}", { status: 200 }),
  });
  assert.equal(JSON.stringify(gateway).includes(TOKEN), false);
});

test("surface comparison accepts exact semantics and rejects each critical mismatch", () => {
  const authority = surface();
  const exact = surface({ lane: "direct_mcp_candidate" });
  assert.equal(comparePluginSurfaces(authority, exact).compatible, true);

  const cases = [
    [surface({ lane: "direct_mcp_candidate", registry: "d".repeat(64) }), "REGISTRY_DIGEST_MISMATCH"],
    [surface({ lane: "direct_mcp_candidate", executor: "e".repeat(64) }), "EXECUTOR_DIGEST_MISMATCH"],
    [surface({ lane: "direct_mcp_candidate", protectedPolicy: "different" }), "PROTECTED_PATH_POLICY_MISMATCH"],
    [surface({ lane: "direct_mcp_candidate", automaticReplay: true }), "RECONCILIATION_SEMANTICS_MISMATCH"],
    [surface({ lane: "direct_mcp_candidate", reconciliation: "error" }), "RECONCILIATION_SEMANTICS_MISMATCH"],
    [surface({ lane: "direct_mcp_candidate", requestIdRequired: false }), "REQUEST_ID_SEMANTICS_MISMATCH"],
    [surface({ lane: "direct_mcp_candidate", health: "BLOCKED" }), "DIRECT_HEALTH_BLOCKED"],
    [surface({ lane: "direct_mcp_candidate", latency: 6000 }), "DIRECT_HEALTH_LATENCY_BOUND"],
    [surface({
      lane: "direct_mcp_candidate",
      tools: [
        { ...authority.tools[0], effect: "side_effect" },
        authority.tools[1],
      ],
    }), "TOOL_EFFECT_MISMATCH"],
    [surface({
      lane: "direct_mcp_candidate",
      tools: [
        authority.tools[0],
        { ...authority.tools[1], available: false },
      ],
    }), "TOOL_AVAILABILITY_MISMATCH"],
    [surface({
      lane: "direct_mcp_candidate",
      tools: [
        authority.tools[0],
        { ...authority.tools[1], input_schema_digest: "f".repeat(64) },
      ],
    }), "TOOL_SCHEMA_MISMATCH"],
  ];

  for (const [candidate, code] of cases) {
    const result = comparePluginSurfaces(authority, candidate);
    assert.equal(result.compatible, false, code);
    assert.ok(result.blockers.some((item) => item.code === code), code);
  }
});

test("readiness never advances from source/synthetic evidence and only explicit live evidence reaches candidate states", () => {
  const authority = surface();
  const candidate = surface({ lane: "direct_mcp_candidate" });

  assert.equal(evaluateR31Readiness({ sourceReady: true }).state, "SOURCE_READY");

  const synthetic = evaluateR31Readiness({
    sourceReady: true,
    authoritySurface: authority,
    candidateSurface: candidate,
    canaryEvidence: canary({ origin: "synthetic_ci" }),
  });
  assert.equal(synthetic.state, "SOURCE_READY");
  assert.equal(synthetic.actual_pc_control_cutover, false);

  const live = evaluateR31Readiness({
    sourceReady: true,
    authoritySurface: authority,
    candidateSurface: candidate,
    canaryEvidence: canary({ origin: "live_explicit_read_only_canary" }),
  });
  assert.equal(live.state, "READ_ONLY_CANARY_PASS");
  assert.equal(live.current_authority, "github_relay");

  const candidateReady = evaluateR31Readiness({
    sourceReady: true,
    authoritySurface: authority,
    candidateSurface: candidate,
    canaryEvidence: canary({ origin: "live_explicit_read_only_canary" }),
    explicitPluginCandidateEvaluation: true,
  });
  assert.equal(candidateReady.state, "READY_FOR_EXPLICIT_PLUGIN_CANDIDATE");
  assert.equal(candidateReady.actual_pc_control_cutover, false);

  for (const bad of [
    canary({ origin: "live_explicit_read_only_canary", status: "BLOCKED" }),
    canary({ origin: "live_explicit_read_only_canary", sideEffects: 1 }),
    canary({ origin: "live_explicit_read_only_canary", replay: true }),
  ]) {
    assert.equal(evaluateR31Readiness({
      sourceReady: true,
      authoritySurface: authority,
      candidateSurface: candidate,
      canaryEvidence: bad,
    }).state, "BLOCKED");
  }
});

test("dual-lane gateway never mirrors a side effect and may mirror only read-only calls", async () => {
  const authoritySurface = surface();
  const candidateSurface = surface({ lane: "direct_mcp_candidate" });
  const authorityCalls = [];
  const candidateCalls = [];

  const authority = {
    describe: async () => authoritySurface,
    callTool: async (request) => {
      authorityCalls.push(request);
      return { lane: "github_relay", status: "completed", request_id: request.arguments?.request_id ?? null };
    },
  };
  const candidate = {
    describe: async () => candidateSurface,
    callTool: async (request) => {
      candidateCalls.push(request);
      return { lane: "direct_mcp_candidate", status: "completed", request_id: null, result: { ok: true } };
    },
  };
  const dual = new PcControlDualLaneGateway({
    authority,
    candidate,
    mirrorReadOnly: true,
  });

  const write = await dual.callTool({
    name: "file.write",
    arguments: { request_id: "r31-write-once", path: "C:\\tmp\\x.txt" },
  });
  assert.equal(write.lane, "github_relay");
  assert.equal(authorityCalls.length, 1);
  assert.equal(candidateCalls.length, 0);

  const read = await dual.callTool({ name: "device.ping", arguments: {} });
  assert.equal(read.side_effect_mirrored, false);
  assert.equal(authorityCalls.length, 2);
  assert.equal(candidateCalls.length, 1);
  assert.equal(Object.hasOwn(read.candidate_read_only_probe, "result"), false);
  assert.equal(typeof read.candidate_read_only_probe.result_digest, "string");
});

test("candidate UNKNOWN outcome is preserved and cannot authorize fallback or automatic replay", async () => {
  let calls = 0;
  const client = {
    listTools: async () => ({ tools: [fakeTool("file.write", "side_effect")] }),
    callTool: async ({ arguments: args }) => {
      calls += 1;
      return {
        structuredContent: {
          contract_version: "pc.native.response.v1",
          request_id: args.request_id,
          status: "reconciliation_required",
          data: { lookup_required: true },
          error: null,
        },
      };
    },
    close: async () => {},
  };
  const gateway = new PcControlDirectCandidateGateway({
    endpoint: "http://127.0.0.1:12345/mcp",
    token: TOKEN,
    allowInsecureHttpForTests: true,
    mode: "explicit_plugin_candidate",
    clientFactory: async () => client,
    fetchImpl: async () => new Response("{}", { status: 200 }),
  });

  const result = await gateway.callTool({
    name: "file.write",
    arguments: { request_id: "r31-unknown-1", path: "C:\\tmp\\unknown.txt", text: "once" },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, "reconciliation_required");
  assert.equal(result.request_id, "r31-unknown-1");
  assert.equal(result.automatic_replay, false);
  assert.equal(result.fallback_authorized, false);
});

test("candidate mode rejects missing stable side-effect identity before tool call", async () => {
  let calls = 0;
  const gateway = new PcControlDirectCandidateGateway({
    endpoint: "http://127.0.0.1:12345/mcp",
    token: TOKEN,
    allowInsecureHttpForTests: true,
    mode: "explicit_plugin_candidate",
    clientFactory: async () => ({
      listTools: async () => ({ tools: [fakeTool("file.write", "side_effect")] }),
      callTool: async () => { calls += 1; return {}; },
      close: async () => {},
    }),
    fetchImpl: async () => new Response("{}", { status: 200 }),
  });
  await assert.rejects(
    gateway.callTool({ name: "file.write", arguments: { path: "C:\\tmp\\x.txt", text: "x" } }),
    (error) => error.code === "REMOTE_STABLE_REQUEST_ID_REQUIRED",
  );
  assert.equal(calls, 0);
});

test("auth mismatch and direct-lane unavailability fail closed", async () => {
  const auth = new PcControlDirectCandidateGateway({
    endpoint: "http://127.0.0.1:12345/mcp",
    token: TOKEN,
    allowInsecureHttpForTests: true,
    fetchImpl: async () => new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }),
  });
  await assert.rejects(auth.health(), (error) => error.code === "DIRECT_AUTH_MISMATCH");

  const unavailable = new PcControlDirectCandidateGateway({
    endpoint: "http://127.0.0.1:12345/mcp",
    token: TOKEN,
    allowInsecureHttpForTests: true,
    fetchImpl: async () => { throw new Error("offline"); },
  });
  await assert.rejects(unavailable.health(), (error) => error.code === "DIRECT_LANE_UNAVAILABLE");
});

test("canary evidence contains hashes/status only and can never authorize replay", () => {
  const evidence = buildCanaryEvidence({
    evidenceOrigin: "synthetic_ci",
    surface: surface({ lane: "direct_mcp_candidate" }),
    calls: [{
      tool: "device.ping",
      effect: "read_only",
      status: "completed",
      latency_ms: 1,
      request_id_present: true,
      result_digest: "d".repeat(64),
      result: { secret: "must-not-appear" },
    }],
    startedAtMs: 1,
    completedAtMs: 2,
  });
  assert.equal(evidence.status, "PASS");
  assert.equal(evidence.replay_authorized, false);
  assert.equal(JSON.stringify(evidence).includes("must-not-appear"), false);
});


test("read-only candidate probe failure never breaks a successful GitHub-authority result", async () => {
  const authoritySurface = surface();
  const authority = {
    describe: async () => authoritySurface,
    callTool: async () => ({ lane: "github_relay", status: "completed", data: { ok: true } }),
  };
  const candidate = {
    describe: async () => surface({ lane: "direct_mcp_candidate" }),
    callTool: async () => {
      throw new PcControlDirectGatewayError("offline", {
        code: "DIRECT_LANE_UNAVAILABLE",
        category: "transport",
      });
    },
  };
  const dual = new PcControlDualLaneGateway({ authority, candidate, mirrorReadOnly: true });
  const result = await dual.callTool({ name: "device.ping", arguments: {} });
  assert.equal(result.authority.lane, "github_relay");
  assert.equal(result.authority.status, "completed");
  assert.equal(result.candidate_read_only_probe.status, "blocked");
  assert.equal(result.candidate_read_only_probe.error_code, "DIRECT_LANE_UNAVAILABLE");
  assert.equal(result.side_effect_mirrored, false);
});

test("candidate transport loss after side-effect call begins becomes reconciliation_required without fallback", async () => {
  const gateway = new PcControlDirectCandidateGateway({
    endpoint: "http://127.0.0.1:12345/mcp",
    token: TOKEN,
    allowInsecureHttpForTests: true,
    mode: "explicit_plugin_candidate",
    clientFactory: async () => ({
      listTools: async () => ({ tools: [fakeTool("file.write", "side_effect")] }),
      callTool: async () => { throw new Error("connection lost after request write"); },
      close: async () => {},
    }),
    fetchImpl: async () => new Response("{}", { status: 200 }),
  });
  const result = await gateway.callTool({
    name: "file.write",
    arguments: {
      request_id: "r31-transport-unknown",
      path: "C:\\tmp\\transport-unknown.txt",
      text: "once",
    },
  });
  assert.equal(result.status, "reconciliation_required");
  assert.equal(result.request_id, "r31-transport-unknown");
  assert.equal(result.automatic_replay, false);
  assert.equal(result.fallback_authorized, false);
  assert.equal(result.result.data.lookup_required, true);
});
