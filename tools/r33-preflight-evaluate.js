#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  R33_DISCOVERY_V1,
  evaluateR33Preflight,
  loadR33SourcePin,
} from "../src/r33-live-readonly-canary-preflight.js";

function arg(flag, fallback = null) {
  const index=process.argv.indexOf(flag);
  return index>=0 && process.argv[index+1] ? process.argv[index+1] : fallback;
}

const inputPath=arg("--input");
const outPath=arg("--out");
const repoRoot=arg("--repo-root",process.cwd());
const outputDir=arg("--run-dir",resolve(repoRoot,".r33-canary","coordinator-live"));
if(!inputPath || !outPath) throw new Error("--input and --out are required");

const discovery=JSON.parse(readFileSync(resolve(inputPath),"utf8"));
if(discovery.contract_version!==R33_DISCOVERY_V1){
  // Let evaluator produce an exact blocker rather than throwing arbitrary parsing semantics.
}
const sourcePin=loadR33SourcePin();
const report=evaluateR33Preflight(discovery,{repoRoot,outputDir});
const result={
  ...report,
  source_pin:{
    exact_start_sha:sourcePin.exact_start_sha,
    ci_run_id:sourcePin.exact_start_ci.run_id,
    current_authority:sourcePin.inherited.current_authority,
  },
};
writeFileSync(resolve(outPath),JSON.stringify(result,null,2)+"\n",{encoding:"utf8",mode:0o600});
process.stdout.write(JSON.stringify({
  contract_version:result.contract_version,
  state:result.state,
  blockers:result.blockers.map((item)=>item.code),
  run_canary_command_generated:typeof result.run_canary_command==="string",
  actual_read_only_canary_executed:false,
  actual_pc_control_cutover:false,
})+"\n");
