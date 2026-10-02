import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  loadR31PluginCandidateMetadata,
  validateR31SourcePin,
} from "../src/pc-control-direct-candidate.js";

function arg(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
}

const exactHead = String(process.env.GITHUB_SHA || arg("--sha") || "").trim();
const runId = String(process.env.GITHUB_RUN_ID || arg("--run-id") || "local").trim();
const runnerOs = String(process.env.RUNNER_OS || process.platform).trim();
if (!/^[0-9a-f]{40}$/.test(exactHead)) {
  throw new Error("R31 readiness report requires an exact 40-hex source SHA.");
}
if (!runId) throw new Error("R31 readiness report requires a CI run ID.");

const sourcePin = validateR31SourcePin();
const pluginCandidate = loadR31PluginCandidateMetadata();
const template = JSON.parse(readFileSync(
  new URL("../conformance/r31_pc_control_direct/readiness.template.json", import.meta.url),
  "utf8",
));

const report = {
  ...template,
  r30_source_sha: sourcePin.exact_sha,
  r30_ci_run_id: sourcePin.exact_head_ci.run_id,
  candidate_version: pluginCandidate.candidate_version,
  current_authority: pluginCandidate.current_authority,
  actual_pc_control_cutover: false,
  current_working_path_changed: false,
  exact_head: exactHead,
  ci_run_id: runId,
  runner_os: runnerOs,
  generated_at: new Date().toISOString(),
};
const digestInput = { ...report, digest: null };
report.digest = createHash("sha256").update(JSON.stringify(digestInput)).digest("hex");

const body = JSON.stringify(report, null, 2) + "\n";
const out = arg("--out");
if (out) writeFileSync(resolve(out), body, { encoding: "utf8", mode: 0o600 });
process.stdout.write(body);
