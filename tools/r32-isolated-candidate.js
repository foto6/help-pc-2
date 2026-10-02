#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { createConfiguredNativeMcpRuntime } from "../src/mcp-runtime-config.js";
import { startDirectRemoteMcpServer } from "../src/direct-remote-mcp.js";
import { R32_CANDIDATE_DESCRIPTOR_V1 } from "../src/r32-local-canary-operator.js";

function arg(flag, fallback = null) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function integer(value, name, min, max) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

const stateDir = resolve(arg("--state-dir") ?? "");
const tokenFile = resolve(arg("--token-file") ?? "");
const descriptorPath = resolve(arg("--descriptor") ?? "");
if (!stateDir || !tokenFile || !descriptorPath) {
  throw new Error("--state-dir, --token-file and --descriptor are required");
}
const token = readFileSync(tokenFile, "utf8").trim();
if (token.length < 32) throw new Error("candidate token file must contain at least 32 characters");
const relayToken = process.env.PC_NATIVE_RELAY_TOKEN;
if (typeof relayToken !== "string" || relayToken.length < 32) {
  throw new Error("PC_NATIVE_RELAY_TOKEN is required for the existing relay authority");
}
if (relayToken === token) {
  throw new Error("candidate MCP token must be distinct from relay credential");
}
const port = integer(arg("--port", "0"), "port", 0, 65535);
const requestTimeoutMs = integer(arg("--request-timeout-ms", "30000"), "request timeout", 250, 120000);
const discoveryTimeoutMs = integer(arg("--discovery-timeout-ms", "5000"), "discovery timeout", 100, 30000);

mkdirSync(stateDir, { recursive: true });

const configured = await createConfiguredNativeMcpRuntime({
  stateDir,
  mode: "direct-remote",
});
const remote = await startDirectRemoteMcpServer({
  runtime: configured.runtime,
  clientToken: token,
  deviceAuthorityToken: relayToken,
  bindHost: "127.0.0.1",
  port,
  publicOrigin: "http://127.0.0.1",
  allowInsecureHttpForTests: true,
  autoTestOrigin: true,
  requestTimeoutMs,
  discoveryTimeoutMs,
});

const descriptor = {
  contract_version: R32_CANDIDATE_DESCRIPTOR_V1,
  instance_id: randomUUID(),
  pid: process.pid,
  bind_host: "127.0.0.1",
  mcp_endpoint: remote.url,
  health_endpoint: remote.health_url,
  state_dir: stateDir,
  token_file: tokenFile,
  isolated_state: true,
  current_authority: "github_relay",
  current_authority_changed: false,
  service_or_task_registered: false,
  firewall_or_tunnel_changed: false,
  live_cutover_performed: false,
  started_at: new Date().toISOString(),
};
writeFileSync(descriptorPath, JSON.stringify(descriptor, null, 2) + "\n", {
  encoding: "utf8",
  mode: 0o600,
});

process.stderr.write(
  `[r32-canary] isolated candidate SOURCE_READY pid=${process.pid} endpoint=${remote.url}\n`,
);

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  try { await remote.close(); } catch {}
  try { await configured.runtime.close(); } catch {}
}

process.once("SIGINT", () => shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => shutdown().finally(() => process.exit(0)));

await new Promise(() => {});
