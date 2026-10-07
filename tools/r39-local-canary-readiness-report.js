#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  evaluateR39Readiness,
  validateR39SourceLineage,
} from "../src/r39-local-canary.js";

function arg(flag,fallback=null){
  const i=process.argv.indexOf(flag);
  return i>=0 && process.argv[i+1] ? process.argv[i+1] : fallback;
}

const exactHead=String(process.env.GITHUB_SHA || arg("--sha") || "").trim();
const runIdRaw=String(process.env.GITHUB_RUN_ID || arg("--run-id") || "").trim();
const runnerOs=String(process.env.RUNNER_OS || process.platform).trim();
const out=arg("--out");
if(!/^[0-9a-f]{40}$/.test(exactHead)) throw new Error("R39 readiness requires exact 40-hex SHA");
if(!/^\d+$/.test(runIdRaw)) throw new Error("R39 readiness requires numeric CI run ID");
if(!out) throw new Error("--out is required");

const template=JSON.parse(readFileSync(
  new URL("../conformance/r39_local_canary/readiness.template.json",import.meta.url),
  "utf8",
));
const sourceLineage=validateR39SourceLineage();
const evaluated=evaluateR39Readiness({
  sourceLineage,
  exactHead,
  ciRunId:Number(runIdRaw),
  runnerOs,
});
const report={
  ...template,
  ...evaluated,
  source_lineage:sourceLineage,
  generated_at:"CI_EXACT_HEAD",
  deterministic_artifact:true,
};
const digestInput={...report,digest:null};
report.digest=createHash("sha256").update(JSON.stringify(digestInput)).digest("hex");

writeFileSync(resolve(out),JSON.stringify(report,null,2)+"\n",{encoding:"utf8",mode:0o600});
process.stdout.write(JSON.stringify({
 contract_version:report.contract_version,
 state:report.state,
 exact_head:report.exact_head,
 ci_run_id:report.ci_run_id,
 blockers:report.blockers,
 current_authority:report.current_authority,
 production_cutover:false,
})+"\n");
