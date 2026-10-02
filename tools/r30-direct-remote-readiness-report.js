import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
}

const template = JSON.parse(readFileSync(
  new URL("../conformance/r30_direct_remote/readiness.template.json", import.meta.url),
  "utf8",
));

const exactHead = String(process.env.GITHUB_SHA || argValue("--sha") || "").trim();
const runId = String(process.env.GITHUB_RUN_ID || argValue("--run-id") || "local").trim();
const runnerOs = String(process.env.RUNNER_OS || process.platform).trim();
if (!/^[0-9a-f]{40}$/.test(exactHead)) {
  throw new Error("R30 readiness report requires an exact 40-hex source SHA.");
}
if (!runId) throw new Error("R30 readiness report requires a CI run ID.");

const report = {
  ...template,
  exact_head: exactHead,
  ci_run_id: runId,
  runner_os: runnerOs,
  generated_at: new Date().toISOString(),
};
const digestInput = { ...report, digest: null };
report.digest = createHash("sha256")
  .update(JSON.stringify(digestInput))
  .digest("hex");

const body = JSON.stringify(report, null, 2) + "\n";
const outPath = argValue("--out");
if (outPath) writeFileSync(resolve(process.cwd(), outPath), body, "utf8");
process.stdout.write(body);
