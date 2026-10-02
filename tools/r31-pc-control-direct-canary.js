#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  PcControlDirectCandidateGateway,
  evaluateR31Readiness,
  loadR31PluginCandidateMetadata,
  runReadOnlyCanary,
  validateR31SourcePin,
} from "../src/pc-control-direct-candidate.js";

function arg(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
}
function has(flag) {
  return process.argv.includes(flag);
}
function intEnv(name, fallback, min, max) {
  const raw = process.env[name] ?? String(fallback);
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

const endpoint = process.env.PC_CONTROL_DIRECT_MCP_ENDPOINT;
const token = process.env.PC_CONTROL_DIRECT_MCP_TOKEN;
if (!endpoint) throw new Error("PC_CONTROL_DIRECT_MCP_ENDPOINT is required");
if (!token) throw new Error("PC_CONTROL_DIRECT_MCP_TOKEN is required");

const sourcePin = validateR31SourcePin();
const pluginCandidate = loadR31PluginCandidateMetadata();
const live = has("--live-explicit-read-only-canary");
const explicitPluginCandidateEvaluation = has("--explicit-plugin-candidate-evaluation");
if (explicitPluginCandidateEvaluation && !live) {
  throw new Error("--explicit-plugin-candidate-evaluation requires --live-explicit-read-only-canary");
}

const tools = (arg("--tools") ?? process.env.PC_CONTROL_DIRECT_CANARY_TOOLS ?? "device.ping,device.info")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const gateway = new PcControlDirectCandidateGateway({
  endpoint,
  token,
  connectTimeoutMs: intEnv("PC_CONTROL_DIRECT_CONNECT_TIMEOUT_MS", 5000, 100, 30000),
  requestTimeoutMs: intEnv("PC_CONTROL_DIRECT_REQUEST_TIMEOUT_MS", 30000, 250, 120000),
  mode: "read_only_canary",
});

let result;
try {
  const { surface, evidence } = await runReadOnlyCanary({
    gateway,
    tools,
    evidenceOrigin: live
      ? "live_explicit_read_only_canary"
      : "runtime_probe_unattested",
  });
  const authorityPath = arg("--authority-snapshot");
  const authoritySurface = authorityPath
    ? JSON.parse(readFileSync(resolve(authorityPath), "utf8"))
    : null;
  const readiness = evaluateR31Readiness({
    sourceReady: true,
    authoritySurface,
    candidateSurface: authorityPath ? surface : null,
    canaryEvidence: authorityPath ? evidence : null,
    explicitPluginCandidateEvaluation,
  });
  result = {
    contract_version: "pc.control.r31.canary_report.v1",
    source_pin: {
      exact_sha: sourcePin.exact_sha,
      ci_run_id: sourcePin.exact_head_ci.run_id,
    },
    plugin_candidate: {
      candidate_version: pluginCandidate.candidate_version,
      current_authority: pluginCandidate.current_authority,
      actual_pc_control_cutover: false,
    },
    evidence,
    candidate_surface: surface,
    readiness,
    actual_pc_control_cutover: false,
  };
} finally {
  await gateway.close().catch(() => {});
}

const body = JSON.stringify(result, null, 2) + "\n";
const out = arg("--out");
if (out) writeFileSync(resolve(out), body, { encoding: "utf8", mode: 0o600 });
process.stdout.write(body);
