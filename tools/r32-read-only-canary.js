#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  PcControlDirectCandidateGateway,
  runReadOnlyCanary,
} from "../src/pc-control-direct-candidate.js";
import {
  assertR32SafeCanaryTools,
  buildR32CanaryEvidence,
  evaluateR32Readiness,
  validateR32CandidateDescriptor,
} from "../src/r32-local-canary-operator.js";

function arg(flag, fallback = null) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
function has(flag) {
  return process.argv.includes(flag);
}
function intArg(flag, fallback, min, max) {
  const parsed = Number.parseInt(arg(flag, String(fallback)), 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${flag} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

const descriptorPath = arg("--candidate-descriptor");
const authorityPath = arg("--authority-snapshot");
const outPath = arg("--out");
if (!descriptorPath || !authorityPath || !outPath) {
  throw new Error("--candidate-descriptor, --authority-snapshot and --out are required");
}
const descriptor = JSON.parse(readFileSync(resolve(descriptorPath), "utf8"));
if (!validateR32CandidateDescriptor(descriptor)) {
  throw new Error("candidate descriptor is invalid or not isolated loopback evidence");
}
const authoritySnapshot = JSON.parse(readFileSync(resolve(authorityPath), "utf8"));
const token = readFileSync(resolve(descriptor.token_file), "utf8").trim();
const tools = (arg("--tools", "device.ping,device.info"))
  .split(",").map((item) => item.trim()).filter(Boolean);
const actualCoordinatorRun = has("--actual-coordinator-run");
const explicitPluginCandidateReview = has("--explicit-plugin-candidate-review");
if (explicitPluginCandidateReview && !actualCoordinatorRun) {
  throw new Error("--explicit-plugin-candidate-review requires --actual-coordinator-run");
}

const gateway = new PcControlDirectCandidateGateway({
  endpoint: descriptor.mcp_endpoint,
  token,
  allowInsecureHttpForTests: true,
  connectTimeoutMs: intArg("--connect-timeout-ms", 5000, 100, 30000),
  requestTimeoutMs: intArg("--request-timeout-ms", 30000, 250, 120000),
  mode: "read_only_canary",
});

const startedAtMs = Date.now();
let report;
try {
  const candidateSurface = await gateway.describe();
  assertR32SafeCanaryTools(candidateSurface, tools);
  const { evidence: candidateCanaryEvidence } = await runReadOnlyCanary({
    gateway,
    tools,
    evidenceOrigin: actualCoordinatorRun
      ? "live_explicit_read_only_canary"
      : "synthetic_ci",
  });
  const completedAtMs = Date.now();
  const evidence = buildR32CanaryEvidence({
    authoritySnapshot,
    candidateSurface,
    candidateCanaryEvidence,
    initializeStatus: "PASS",
    evidenceOrigin: actualCoordinatorRun
      ? "coordinator_live_read_only_canary"
      : "synthetic_ci",
    actualCoordinatorRun,
    candidateDescriptor: descriptor,
    startedAtMs,
    completedAtMs,
  });
  const readiness = evaluateR32Readiness({
    sourceReady: true,
    canaryEvidence: evidence,
    explicitPluginCandidateReview,
  });
  report = {
    contract_version: "pc.control.r32.local_canary_report.v1",
    authority_snapshot_digest: authoritySnapshot.snapshot_digest ?? null,
    candidate_instance_id: descriptor.instance_id,
    candidate_pid: descriptor.pid,
    candidate_endpoint: descriptor.mcp_endpoint,
    candidate_surface_digest: candidateSurface.tool_surface_digest ?? null,
    safe_tools: tools,
    evidence,
    readiness,
    current_authority: "github_relay",
    current_authority_changed: false,
    side_effect_mirroring: false,
    actual_pc_control_cutover: false,
    cleanup_required: true,
  };
} finally {
  await gateway.close().catch(() => {});
}

writeFileSync(resolve(outPath), JSON.stringify(report, null, 2) + "\n", {
  encoding: "utf8",
  mode: 0o600,
});
process.stdout.write(JSON.stringify({
  contract_version: report.contract_version,
  state: report.readiness.state,
  evidence_digest: report.evidence.evidence_digest,
  current_authority_changed: false,
  actual_pc_control_cutover: false,
}) + "\n");
