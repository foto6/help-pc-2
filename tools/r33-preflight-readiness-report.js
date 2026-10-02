#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function arg(flag){const i=process.argv.indexOf(flag);return i>=0&&process.argv[i+1]?process.argv[i+1]:null;}
const template=JSON.parse(readFileSync(new URL("../conformance/r33_live_readonly_preflight/readiness.template.json",import.meta.url),"utf8"));
const sha=String(process.env.GITHUB_SHA||arg("--sha")||"").trim();
const run=String(process.env.GITHUB_RUN_ID||arg("--run-id")||"local").trim();
const os=String(process.env.RUNNER_OS||process.platform).trim();
if(!/^[0-9a-f]{40}$/.test(sha)) throw new Error("R33 readiness requires exact 40-hex SHA");
const out={...template,exact_head:sha,ci_run_id:run,runner_os:os,generated_at:new Date().toISOString()};
out.digest=createHash("sha256").update(JSON.stringify({...out,digest:null})).digest("hex");
const body=JSON.stringify(out,null,2)+"\n";
const path=arg("--out"); if(path) writeFileSync(resolve(path),body,"utf8"); process.stdout.write(body);
