#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildR32AuthoritySnapshot } from "../src/r32-local-canary-operator.js";

function arg(flag, fallback = null) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const watchdogPath = arg("--watchdog-status");
const outPath = arg("--out");
if (!watchdogPath || !outPath) throw new Error("--watchdog-status and --out are required");
const latencyMs = Number(arg("--latency-ms", "NaN"));
const watchdogStatus = JSON.parse(readFileSync(resolve(watchdogPath), "utf8"));

const snapshot = buildR32AuthoritySnapshot({
  watchdogStatus,
  probeLatencyMs: Number.isFinite(latencyMs) ? latencyMs : null,
  evidenceOrigin: "coordinator_live_github_relay_snapshot",
});
writeFileSync(resolve(outPath), JSON.stringify(snapshot, null, 2) + "\n", {
  encoding: "utf8",
  mode: 0o600,
});
process.stdout.write(JSON.stringify({
  contract_version: snapshot.contract_version,
  safe_for_comparison: snapshot.safe_for_comparison,
  health_status: snapshot.live_health.status,
  snapshot_digest: snapshot.snapshot_digest,
  raw_results_included: false,
  credentials_included: false,
}) + "\n");
