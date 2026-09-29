import test from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import assert from "node:assert/strict";
import {ControlPlane, HelpPc1Adapter, NativeControlFacade, NativeMcpRuntime, NATIVE_CONTROL_PROTOCOL_V1, TOOL_REGISTRY, startNativeMcpHttpServer} from "../src/index.js";
const TTL = 30 * 60 * 1000;
const TOKEN = "0123456789abcdef0123456789abcdef";
function success(req) {
 return {request_id:req.request_id,action:req.action,ok:true,status:"completed",
   started_at:"2026-09-29T00:00:00.000Z",finished_at:"2026-09-29T00:00:00.001Z",
   data:{ok:true},error:null,error_kind:null,dry_run:req.dry_run};
}
async function make({invoke=success,readEvidence=null}={}) {
 const state={time:1000,digest:"executor-r17",calls:0};
 const plane=new ControlPlane({providers:[new HelpPc1Adapter({dryRun:false,
  invoke:async req=>{state.calls++;return invoke(req);},readEvidence})]});
 const facade=new NativeControlFacade({controlPlane:plane,clock:()=>state.time,
  sessionTtlMs:TTL,capabilityProvider:async()=>({contract_version:"pc_executor.capabilities.v1",
   digest:state.digest,actions:["fs.write_text","system.health","fs.stat"]})});
 const runtime=await NativeMcpRuntime.create({facade,desktopId:"r17-isolated-desktop"});
 return {state,plane,facade,runtime,advance:(ms)=>{state.time+=ms;},close:()=>runtime.close()};
}
function client(manifest){return {protocol_version:manifest.protocol_version,registry_digest:manifest.registry_digest,
executor_digest:manifest.executor?.digest??null};}
function req(id,requestId,tool,args={}){return {contract_version:NATIVE_CONTROL_PROTOCOL_V1,session_id:id,request_id:requestId,tool,arguments:args};}

test("R17 single-flight initial open and read-only renewal do not leak desktop leases", async t=>{
 const h=await make();t.after(h.close);
 await Promise.all(Array.from({length:8},()=>h.runtime.ensureFacadeSession()));
 assert.equal(h.facade.debugSnapshot().sessions.length,1);
 const old=h.runtime.facadeSession.session_id;
 h.advance(TTL+60_000);
 await Promise.all(Array.from({length:8},()=>h.runtime.ensureFacadeSession({allowExpiredRenewal:true})));
 const state=h.facade.debugSnapshot();
 assert.equal(state.sessions.length,2);
 assert.equal(state.sessions[0].staleReason,"ttl_expired");
 assert.equal(state.sessions[1].renewalOf,old);
 assert.equal(h.plane.listSessions()[0].status,"closed");
 assert.equal(h.plane.listSessions()[1].status,"active");
 assert.equal(h.state.calls,0);
});

test("R17 expired mutation is not automatically renewed",async t=>{
 const h=await make();t.after(h.close);
 await h.runtime.ensureFacadeSession();h.advance(TTL+1);
 await assert.rejects(h.runtime.ensureFacadeSession(),e=>e.code==="STALE_SESSION");
 assert.equal(h.state.calls,0);
 assert.equal(h.facade.debugSnapshot().sessions.length,1);
});

test("R17 invalid token, desktop and non-TTL stale reason fail closed",async t=>{
 const h=await make();t.after(h.close);await h.runtime.ensureFacadeSession();
 const prior=h.runtime.facadeSession, manifest=await h.facade.capabilities();
 h.advance(TTL+1);
 await assert.rejects(h.facade.reconnectSession({sessionId:prior.session_id,
  resumeToken:prior.resume_token,client:client(manifest)}),e=>e.code==="STALE_SESSION");
 const options={sessionId:prior.session_id,resumeToken:prior.resume_token,
  desktopId:"r17-isolated-desktop",client:client(manifest)};
 await assert.rejects(h.facade.renewExpiredSession({...options,resumeToken:"bad"}),e=>e.code==="SESSION_AUTH_FAILED");
 await assert.rejects(h.facade.renewExpiredSession({...options,desktopId:"alien"}),e=>e.code==="SESSION_DESKTOP_DRIFT");
 h.facade.state.sessions[0].staleReason="capability_drift";
 await assert.rejects(h.facade.renewExpiredSession(options),e=>e.code==="STALE_SESSION");
 assert.equal(h.plane.listSessions().length,1);
});

test("R17 capability drift cannot renew an expired session",async t=>{
 const h=await make();t.after(h.close);await h.runtime.ensureFacadeSession();
 h.advance(TTL+1);h.state.digest="another-executor";
 await assert.rejects(h.runtime.ensureFacadeSession({allowExpiredRenewal:true}),e=>e.code==="CAPABILITY_DRIFT");
 assert.equal(h.facade.debugSnapshot().sessions.length,1);
 assert.equal(h.state.calls,0);
});

test("R17 unknown side-effect receipt and live handle both block renewal",async t=>{
 const h=await make({invoke:async r=>({...success(r),ok:false,status:"timeout",error:"unknown after dispatch",
 error_kind:"timeout"}),readEvidence:async()=>({outcome:"unknown",source:"simulated-journal"})});
 t.after(h.close);await h.runtime.ensureFacadeSession();
 const sid=h.runtime.facadeSession.session_id;
 const first=await h.facade.invoke(req(sid,"write-unknown","file.write",{path:"C:\\isolated\\x.txt",text:"one"}));
 assert.equal(first.status,"reconciliation_required");
 assert.equal(h.state.calls,1);
 h.advance(TTL+1);
 await assert.rejects(h.runtime.ensureFacadeSession({allowExpiredRenewal:true}),e=>e.code==="SESSION_RENEWAL_BLOCKED");
 assert.equal(h.state.calls,1);
 assert.equal(h.plane.listSessions()[0].status,"active");
 const k=await make();t.after(k.close);await k.runtime.ensureFacadeSession();
 k.facade.state.handles.push({sessionId:k.runtime.facadeSession.session_id,handle:"owned",status:"open"});
 k.advance(TTL+1);
 await assert.rejects(k.runtime.ensureFacadeSession({allowExpiredRenewal:true}),e=>e.code==="SESSION_RENEWAL_BLOCKED");
});

test("R17 old mutation request returns original durable receipt without replay",async t=>{
 const h=await make();t.after(h.close);await h.runtime.ensureFacadeSession();
 const sid=h.runtime.facadeSession.session_id;
 const old=await h.facade.invoke(req(sid,"previous-write","file.write",{path:"C:\\isolated\\x.txt",text:"one"}));
 assert.equal(old.status,"completed");assert.equal(h.state.calls,1);
 h.advance(TTL+1);await h.runtime.ensureFacadeSession({allowExpiredRenewal:true});
 const renewed=h.runtime.facadeSession.session_id;
 const original=await h.facade.invoke(req(renewed,"previous-write","file.write",
 {path:"C:\\isolated\\x.txt",text:"one"}));
 assert.equal(original.status,"completed");
 assert.equal(original.request_id,"previous-write");
 assert.equal(h.state.calls,1);
});

test("R17 foreign Origin rejected before MCP parsing, same Origin admitted",async t=>{
 const h=await make();t.after(h.close);
 const http=await startNativeMcpHttpServer({runtime:h.runtime,token:TOKEN,port:0});
 t.after(()=>http.close());
 const headers={authorization:"Bearer "+TOKEN,"content-type":"application/json"};
 const bad=await fetch(http.url,{method:"POST",headers:{...headers,origin:"https://foreign.invalid"},body:"{}"});
 assert.equal(bad.status,403);
 assert.equal((await bad.json()).error,"invalid_origin");
 const same=await fetch(http.url,{method:"POST",
  headers:{...headers,origin:new URL(http.url).origin},body:"{}"});
 assert.notEqual(same.status,403);
 assert.equal(h.state.calls,0);
});

test("R17 genuine read-only runtime call after TTL renews once pre-dispatch",async t=>{
 const h=await make();t.after(h.close);await h.runtime.ensureFacadeSession();h.advance(TTL+1);
 const result=await h.runtime.callNativeTool(TOOL_REGISTRY["device.health"],
  {request_id:"read-after-idle"},{mcpReq:{id:8}});
 assert.equal(result.isError,false);
 assert.equal(result.structuredContent.status,"completed");
 assert.equal(h.facade.debugSnapshot().sessions.length,2);
 assert.equal(h.state.calls,1);
});

test("R17 close after a quiet TTL retires the old desktop owner without renewal",async()=>{
 const h=await make();await h.runtime.ensureFacadeSession();
 h.advance(TTL+1);await h.runtime.close();
 assert.equal(h.plane.listSessions()[0].status,"closed");
 assert.equal(h.facade.debugSnapshot().sessions[0].status,"closed");
 assert.equal(h.state.calls,0);
});

test("R17 shutdown waits for single-flight session admission before closing",async()=>{
 const h=await make();
 const opening=h.runtime.ensureFacadeSession();
 await h.runtime.close();
 await opening;
 assert.equal(h.plane.listSessions()[0].status,"closed");
 assert.equal(h.state.calls,0);
});
test("R17 deterministic stress: 128 simultaneous opens across 24 TTL epochs never fork ownership", async t=>{
 const h=await make();t.after(h.close);
 await Promise.all(Array.from({length:128},()=>h.runtime.ensureFacadeSession()));
 for(let cycle=0;cycle<24;cycle++){
  h.advance(TTL+1);
  await Promise.all(Array.from({length:128},()=>
    h.runtime.ensureFacadeSession({allowExpiredRenewal:true})));
  assert.equal(h.facade.debugSnapshot().sessions.length,cycle+2);
  assert.equal(h.plane.listSessions().filter(s=>s.status==="active").length,1);
 }
 assert.equal(h.state.calls,0,"admission stress must never dispatch an Executor action");
});
test("R17 official HTTP MCP client survives genuine second read-only request after 31m idle",async t=>{
 const h=await make();t.after(h.close);
 const http=await startNativeMcpHttpServer({runtime:h.runtime,token:TOKEN,port:0});
 t.after(()=>http.close());
 const transport=new StreamableHTTPClientTransport(new URL(http.url),{
  authProvider:{token:async()=>TOKEN},
 });
 const clientInstance=new Client({name:"r17-idle-official-client",version:"1.0.0"},
  {versionNegotiation:{mode:"auto"}});
 t.after(()=>clientInstance.close());
 await clientInstance.connect(transport);
 const first=await clientInstance.callTool({name:"device.health",arguments:{request_id:"r17-before-idle"}});
 assert.equal(first.structuredContent.status,"completed");
 h.advance(TTL+60_000);
 const after=await clientInstance.callTool({name:"device.health",arguments:{request_id:"r17-after-idle"}});
 assert.equal(after.isError,false);
 assert.equal(after.structuredContent.status,"completed");
 assert.equal(h.facade.debugSnapshot().sessions.length,2);
 assert.equal(h.plane.listSessions()[0].status,"closed");
 assert.equal(h.state.calls,2,"two independent read-only operations, no mutation replay");
});

test("R17 frozen legacy stale owner fails before allocating ghost Control sessions",async t=>{
 const h=await make();t.after(h.close);await h.runtime.ensureFacadeSession();
 const old=h.runtime.facadeSession.session_id;
 h.advance(TTL+1);
 await assert.rejects(h.runtime.ensureFacadeSession(),e=>e.code==="STALE_SESSION");
 // R15c persisted state may have already been marked stale by the old oracle,
 // but its old Control session still owns the desktop.
 await assert.rejects(
  NativeMcpRuntime.create({facade:h.facade,desktopId:"r17-isolated-desktop"}),
  e=>e.code==="SESSION_MIGRATION_REQUIRED",
 );
 assert.equal(h.plane.listSessions().length,1);
 assert.equal(h.plane.listSessions()[0].status,"active");
 // An explicit safe close can retire a quiet expired owner before fresh start.
 assert.equal(h.facade.closeSession(old).status,"closed");
 const fresh=await NativeMcpRuntime.create({facade:h.facade,desktopId:"r17-isolated-desktop"});
 t.after(()=>fresh.close());
 await fresh.ensureFacadeSession();
 assert.equal(h.plane.listSessions().filter(s=>s.status==="active").length,1);
});
