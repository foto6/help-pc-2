#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  R37_CUTOVER_READINESS_V1,
  R37_OPERATOR_LIFECYCLE_V1,
  evaluateR37DirectHostRehearsal,
} from "../src/r37-operator-lifecycle.js";

function arg(flag, fallback = null) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const sourceSha = arg("--source-sha", process.env.GITHUB_SHA ?? null);
const outPath = arg("--out");
if (!outPath) throw new Error("--out is required");

const fixturePath = resolve(
  arg(
    "--rehearsal",
    "conformance/r37_operator_lifecycle/direct-host-rehearsal.blocked.json",
  ),
);
const raw = JSON.parse(readFileSync(fixturePath, "utf8"));
const rehearsal = evaluateR37DirectHostRehearsal(raw);

const report = {
  contract_version: R37_CUTOVER_READINESS_V1,
  lifecycle_contract_version: R37_OPERATOR_LIFECYCLE_V1,
  source_sha: sourceSha,
  ci_conclusion: "success",
  evidence_origin: "exact_head_ci_source_validation",
  direct_host_rehearsal: rehearsal,
  current_authority: "github_relay",
  current_authority_changed: false,
  cutover_ready: rehearsal.status === "PASS",
  state: rehearsal.status === "PASS"
    ? "READY_FOR_EXPLICIT_CUTOVER_REVIEW"
    : "BLOCKED",
  blockers: rehearsal.blockers,
  automatic_side_effect_replay: false,
  production_cutover_performed: false,
};

writeFileSync(resolve(outPath), JSON.stringify(report, null, 2) + "\n", {
  encoding: "utf8",
  mode: 0o600,
});
process.stdout.write(JSON.stringify({
  contract_version: report.contract_version,
  source_sha: report.source_sha,
  state: report.state,
  cutover_ready: report.cutover_ready,
  blocker_codes: report.blockers.map((item) => item.code),
  current_authority: report.current_authority,
  production_cutover_performed: false,
}) + "\n");
