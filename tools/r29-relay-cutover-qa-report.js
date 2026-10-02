import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { evaluateR29RelayCutoverQa } from "../src/index.js";

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
}

const sourceSha = String(process.env.GITHUB_SHA || argValue("--sha") || "").trim();
const runId = String(process.env.GITHUB_RUN_ID || argValue("--run-id") || "local").trim();
const runnerOs = String(process.env.RUNNER_OS || process.platform).trim();
const branch = String(
  process.env.GITHUB_REF_NAME
    || argValue("--branch")
    || "agent/native-mcp-r29-relay-cutover-qa-20261002",
).trim();

if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
  throw new Error("R29 QA report requires the exact 40-hex consumer source SHA.");
}

const evaluation = evaluateR29RelayCutoverQa();
const report = {
  ...evaluation,
  object: "pc.native.r29.relay_cutover_qa_report.v1",
  consumer: {
    repository: "foto6/help-pc-2",
    branch,
    source_sha: sourceSha,
    ci_run_id: runId,
    runner_os: runnerOs,
  },
  producer_ci: {
    run_id: 36967056910,
    windows_job_id: 110712982244,
    windows_conclusion: "success",
    windows_focused_tests: "41 passed",
    windows_full_tests: "228 passed",
    windows_plan_only_marker: "CUTOVER_CANDIDATE_POWERSHELL_PLAN_ONLY_PASS",
    ubuntu_job_id: 110712982382,
    ubuntu_conclusion: "success",
    ubuntu_focused_tests: "41 passed",
    ubuntu_full_tests: "228 passed",
  },
  live_observation_performed: false,
  installer_executed: false,
  scheduled_task_or_service_created: false,
  live_process_killed_or_restarted: false,
  live_cutover_authorized: false,
  release_gate: "NO_LIVE_CUTOVER",
  generated_at: new Date().toISOString(),
};
const digestInput = { ...report };
delete digestInput.digest;
report.digest = createHash("sha256").update(JSON.stringify(digestInput)).digest("hex");

const body = JSON.stringify(report, null, 2) + "\n";
const out = argValue("--out");
if (out) writeFileSync(resolve(process.cwd(), out), body, "utf8");
process.stdout.write(body);
