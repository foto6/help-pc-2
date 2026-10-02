#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function arg(flag) {
  const index=process.argv.indexOf(flag);
  return index>=0 && process.argv[index+1] ? process.argv[index+1] : null;
}

const template=JSON.parse(readFileSync(
  new URL("../conformance/r32_local_canary/readiness.template.json",import.meta.url),
  "utf8",
));
const sha=String(process.env.GITHUB_SHA || arg("--sha") || "").trim();
const runId=String(process.env.GITHUB_RUN_ID || arg("--run-id") || "local").trim();
const runnerOs=String(process.env.RUNNER_OS || process.platform).trim();
if(!/^[0-9a-f]{40}$/.test(sha)) throw new Error("R32 readiness requires exact 40-hex SHA");
if(!runId) throw new Error("R32 readiness requires CI run ID");

const report={
  ...template,
  exact_head:sha,
  ci_run_id:runId,
  runner_os:runnerOs,
  generated_at:new Date().toISOString(),
};
const input={...report,digest:null};
report.digest=createHash("sha256").update(JSON.stringify(input)).digest("hex");
const body=JSON.stringify(report,null,2)+"\n";
const out=arg("--out");
if(out) writeFileSync(resolve(out),body,{encoding:"utf8",mode:0o600});
process.stdout.write(body);
