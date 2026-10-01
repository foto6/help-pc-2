import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
}

const templatePath = new URL(
  "../conformance/r27_cutover_authority/coordinator-handoff.json",
  import.meta.url,
);
const template = JSON.parse(readFileSync(templatePath, "utf8"));
const sourceSha = String(process.env.GITHUB_SHA || argValue("--sha") || "").trim();
const runId = String(process.env.GITHUB_RUN_ID || argValue("--run-id") || "local").trim();
const runnerOs = String(process.env.RUNNER_OS || process.platform).trim();
const branch = String(
  process.env.GITHUB_REF_NAME
  || argValue("--branch")
  || "agent/native-mcp-r27-cutover-authority-gate-20261001",
).trim();

if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
  throw new Error("R27 handoff requires an exact 40-hex source SHA.");
}
if (!runId) throw new Error("R27 handoff requires a CI run ID or explicit --run-id.");

const report = {
  ...template,
  object: "pc.native.r27.coordinator_handoff_report.v1",
  r27_authority: {
    repository: "foto6/help-pc-2",
    branch,
    source_sha: sourceSha,
    ci_run_id: runId,
    runner_os: runnerOs,
  },
  generated_at: new Date().toISOString(),
  release_gate: "NO_LIVE_CUTOVER",
  live_cutover_authorized: false,
  mutation_execution_authorized: false,
  executable_live_cutover_action: null,
  executable_commands: [],
};

const digestInput = { ...report };
delete digestInput.digest;
report.digest = createHash("sha256").update(JSON.stringify(digestInput)).digest("hex");

const body = JSON.stringify(report, null, 2) + "\n";
const out = argValue("--out");
if (out) writeFileSync(resolve(process.cwd(), out), body, "utf8");
process.stdout.write(body);
