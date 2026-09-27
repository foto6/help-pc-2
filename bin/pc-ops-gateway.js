#!/usr/bin/env node
import process from "node:process";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { createGatewayRuntime } from "../src/pc-ops/service.js";
function arg(name,fallback=null){const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]:fallback;}
const stateDir=arg("--state-dir",process.env.LOCALAPPDATA?process.env.LOCALAPPDATA+"\\pc-ops-gateway":".pc-ops-gateway"),queueRepo=arg("--queue-repo",process.env.PC_OPS_QUEUE_REPO),queueRef=arg("--queue-ref","agent/pc-relay-queue");
if(!queueRepo){console.error("Missing --queue-repo or PC_OPS_QUEUE_REPO.");process.exit(2);}
const gateway=createGatewayRuntime({stateDir,queueRepo,queueRef,desktopId:arg("--desktop-id","default"),relayDryRun:!process.argv.includes("--relay-live"),allowDestructive:process.argv.includes("--allow-destructive"),implementationSha:process.env.PC_OPS_IMPLEMENTATION_SHA??"unknown",producerMatrix:{ready_to_migrate:false}});
const startup=await gateway.call("health.get",{}, {requestId:"startup-health"});process.stdout.write(JSON.stringify({service:"pc_ops.gateway.v1",health:startup.data})+"\n");
const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
for await(const line of rl){if(!line.trim())continue;let request;try{request=JSON.parse(line);const result=await gateway.call(request.tool,request.arguments??{},{requestId:String(request.id??randomUUID()),confirm:request.confirm===true,approvedBy:request.approved_by});process.stdout.write(JSON.stringify({id:request.id??result.request_id,ok:true,result})+"\n");}catch(error){process.stdout.write(JSON.stringify({id:request?.id??null,ok:false,error:{code:error?.code??"PC_OPS_ERROR",message:String(error?.message??error),details:error?.details??null}})+"\n");}}
