import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  createConfiguredNativeMcpRuntime, startNativeMcpHttpServer,
} from "../src/index.js";

const TTL=30*60*1000;
const TOKEN="r18-private-loopback-fixture-key-only-20260929";
function success(request,data={}) {
 return {request_id:request.request_id,action:request.action,ok:true,status:"completed",
  dry_run:false,data,started_at:"2026-09-29T00:00:00Z",
  finished_at:"2026-09-29T00:00:01Z",error:null,error_kind:null};
}
function result(response){
 assert.ok(response.structuredContent,"Official MCP structuredContent absent");
 return response.structuredContent;
}

test("R18 isolated actual Windows/Node filesystem and child process via official MCP SDK",async t=>{
 const root=mkdtempSync(join(tmpdir(),"native-r18-isolated-host-"));
 const path=join(root,"fixture.txt");
 const stateDir=join(root,"state");
 let clock=1_000;
 let writes=0,spawns=0,stops=0,output="";
 let child=null;
 const bridge={
  desktopId:"r18-fixture-desktop",
  dryRun:false,
  readCapabilities:async()=>({
   contract_version:"pc_executor.capabilities.v1",
   digest:"r18-fixture-actual-host-epoch-A",
   actions:["system.health","fs.write_text","fs.read_text","process.start","process.read","process.terminate"],
  }),
  readDeviceIdentity:async()=>({
   deviceId:"r18-isolated-only",sessionEpoch:"fixture-boot-A",
   executorDigest:"r18-fixture-actual-host-epoch-A",
  }),
  invoke:async request=>{
   switch(request.action) {
    case "system.health":return success(request,{healthy:true});
    case "fs.write_text":
     assert.equal(request.params.path,path,"never write outside isolated fixture");
     assert.equal(typeof request.params.text,"string");
     writes++;
     writeFileSync(path,request.params.text,"utf8");
     return success(request,{written:true});
    case "fs.read_text":
     assert.equal(request.params.path,path,"never read outside isolated fixture");
     return success(request,{content:readFileSync(path,"utf8")});
    case "process.start":
     assert.equal(request.params.command,"fixture-worker","never execute arbitrary command");
     assert.equal(child,null,"no duplicate child process");
     spawns++;
     // A REAL child process is launched under the isolated TEMP directory.
     // The shell is never involved; cleanup can terminate only this PID.
     child=spawn(process.execPath,["-e",
      "process.stdout.write('R18_FIXTURE_RUNNING');setTimeout(()=>process.exit(0),12000)"],{
      cwd:root,shell:false,windowsHide:true,stdio:["ignore","pipe","pipe"],
     });
     child.stdout.on("data",chunk=>{output+=chunk.toString("utf8")});
     return success(request,{process_handle:"r18-owned-child-handle"});
    case "process.read":
     assert.equal(request.params.handle,"r18-owned-child-handle");
     return success(request,{items:[output],next_cursor:null});
    case "process.terminate":
     assert.equal(request.params.handle,"r18-owned-child-handle");
     stops++;
     if(child && child.exitCode===null && child.signalCode===null)child.kill();
     return success(request,{terminated:true});
    default:throw new Error("Fixture bridge refused action "+request.action);
   }
  },
 };
 let http=null,client=null,stack=null;
 t.after(async()=>{
  try{if(client)await client.close()}catch{}
  try{if(http)await http.close()}catch{}
  try{if(stack)await stack.runtime.close()}catch{}
  if(child && child.exitCode===null && child.signalCode===null)child.kill();
  if(child && child.exitCode===null && child.signalCode===null){
   await Promise.race([
    new Promise(resolve=>child.once("exit",resolve)),
    new Promise(resolve=>setTimeout(resolve,3000)),
   ]);
  }
  rmSync(root,{recursive:true,force:true});
 });
 stack=await createConfiguredNativeMcpRuntime({
  stateDir,desktopId:"r18-fixture-desktop",
  testConfig:{enabled:true,createExecutorBridge:async()=>bridge},
 });
 stack.facade.clock=()=>clock;
 http=await startNativeMcpHttpServer({runtime:stack.runtime,token:TOKEN,port:0});
 client=new Client({name:"r18-windows-real-fixture-client",version:"1.0.0"},
  {versionNegotiation:{mode:"auto"}});
 await client.connect(new StreamableHTTPClientTransport(new URL(http.url),{
  authProvider:{token:async()=>TOKEN},
 }));
 const health=result(await client.callTool({name:"device.health",arguments:{request_id:"r18-real-health"}}));
 assert.equal(health.status,"completed");
 const firstArgs={request_id:"r18-fixture-write-old",path,text:"real-fixture-one"};
 assert.equal(result(await client.callTool({name:"file.write",arguments:firstArgs})).status,"completed");
 assert.equal(result(await client.callTool({name:"file.write",arguments:firstArgs})).status,"completed");
 assert.equal(readFileSync(path,"utf8"),"real-fixture-one");
 assert.equal(writes,1);
 clock+=TTL+1;
 const secondArgs={request_id:"r18-fixture-write-new",path,text:"real-fixture-two"};
 assert.equal(result(await client.callTool({name:"file.write",arguments:secondArgs})).status,"completed");
 assert.equal(result(await client.callTool({name:"file.write",arguments:firstArgs})).status,"completed");
 assert.equal(readFileSync(path,"utf8"),"real-fixture-two");
 assert.equal(writes,2,"old mutation receipt must never rewrite the file");
 const read=result(await client.callTool({name:"file.read",
  arguments:{request_id:"r18-read-real-file",path}}));
 assert.equal(read.status,"completed");
 assert.equal(read.data.content,"real-fixture-two");

 const start=result(await client.callTool({name:"process.start",
  arguments:{request_id:"r18-start-real-child",command:"fixture-worker"}}));
 assert.equal(start.status,"completed");
 assert.equal(start.data.process_handle,"r18-owned-child-handle");
 const processSessionId=stack.runtime.facadeSession.session_id;
 clock+=TTL+1;
 const continued=result(await client.callTool({name:"process.read",
  arguments:{request_id:"r18-read-after-idle",handle:"r18-owned-child-handle"}}));
 assert.equal(continued.status,"completed");
 assert.equal(stack.runtime.facadeSession.session_id,processSessionId,
  "one owner must retain the process handle through TTL");
 const stopArgs={request_id:"r18-stop-real-child",handle:"r18-owned-child-handle"};
 assert.equal(result(await client.callTool({name:"process.terminate",arguments:stopArgs})).status,"completed");
 assert.equal(result(await client.callTool({name:"process.terminate",arguments:stopArgs})).status,"completed");
 assert.equal(spawns,1);
 assert.equal(stops,1);
 assert.equal(stack.controlPlane.listSessions().filter(x=>x.status==="active").length,1);
 assert.equal(existsSync(path),true);
 console.log(JSON.stringify({
  isolated_host:process.platform,real_temp_file_writes:writes,
  real_scoped_child_spawns:spawns,child_terminations:stops,
  active_owners:1,second_effect_on_old_receipt:false,
 }));
});
