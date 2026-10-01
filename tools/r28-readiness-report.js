import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
}

const template = JSON.parse(readFileSync(
  new URL("../conformance/r28_cutover_authority/coordinator-handoff.json", import.meta.url),
  "utf8",
));
const sourceSha = String(process.env.GITHUB_SHA || argValue("--sha") || "").trim();
const runId = String(process.env.GITHUB_RUN_ID || argValue("--run-id") || "local").trim();
const branch = String(
  process.env.GITHUB_REF_NAME
  || argValue("--branch")
  || "agent/native-mcp-r28-r24-r27-evidence-consumer-20261001",
).trim();
const runnerOs = String(process.env.RUNNER_OS || process.platform).trim();

if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
  throw new Error("R28 readiness report requires an exact 40-hex source SHA.");
}
if (!runId) throw new Error("R28 readiness report requires a CI run ID.");

const report = {
  ...template,
  object: "pc.native.r28.source_bound_readiness_report.v1",
  r28_consumer: {
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
report.digest = createHash("sha256")
  .update(JSON.stringify(digestInput))
  .digest("hex");

const body = JSON.stringify(report, null, 2) + "\n";
const out = argValue("--out");
if (out) writeFileSync(resolve(process.cwd(), out), body, "utf8");
process.stdout.write(body);
