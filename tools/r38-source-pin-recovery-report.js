#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateR31SourcePin } from "../src/pc-control-direct-candidate.js";

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const exactHead = String(process.env.GITHUB_SHA || arg("--sha") || "").trim();
const runIdRaw = String(process.env.GITHUB_RUN_ID || arg("--run-id") || "").trim();
const runnerOs = String(process.env.RUNNER_OS || process.platform).trim();
const outPath = arg("--out");
if (!/^[0-9a-f]{40}$/.test(exactHead)) throw new Error("R38 report requires exact 40-hex source SHA");
if (!/^\d+$/.test(runIdRaw)) throw new Error("R38 report requires numeric CI run ID");
if (!outPath) throw new Error("--out is required");

const pin = validateR31SourcePin();
const lineage = JSON.parse(readFileSync(
  new URL("../conformance/r38_source_pin_recovery/lineage.json", import.meta.url),
  "utf8",
));
const template = JSON.parse(readFileSync(
  new URL("../conformance/r38_source_pin_recovery/readiness.template.json", import.meta.url),
  "utf8",
));

const accepted = pin.recovery_acceptance?.status === "accepted"
  && Number.isInteger(pin.recovery_acceptance?.ci_run_id)
  && pin.recovery_acceptance?.conclusion === "success";

const blockers = [];
if (!accepted) blockers.push("R38_ACCEPTANCE_CI_PENDING");

const report = {
  ...template,
  state: accepted ? "SOURCE_READY" : "BLOCKED",
  exact_head: exactHead,
  ci_run_id: Number(runIdRaw),
  runner_os: runnerOs,
  active_blobs: pin.active_blobs,
  lineage: lineage.lineage,
  source_recovery_acceptance: pin.recovery_acceptance,
  historical_r30_predecessor: pin.historical_predecessor,
  diagnostic_ci: pin.regression_evidence?.r37_diagnostic_ci ?? null,
  blockers,
  generated_at: new Date().toISOString(),
};
const digestInput = { ...report, digest: null };
report.digest = createHash("sha256").update(JSON.stringify(digestInput)).digest("hex");

writeFileSync(resolve(outPath), JSON.stringify(report, null, 2) + "\n", {
  encoding: "utf8",
  mode: 0o600,
});
process.stdout.write(JSON.stringify({
  contract_version: report.contract_version,
  state: report.state,
  exact_head: report.exact_head,
  ci_run_id: report.ci_run_id,
  blocker_codes: report.blockers,
  source_recovery_status: report.source_recovery_acceptance?.status ?? null,
  current_authority: report.current_authority,
  production_cutover: false,
}) + "\n");
