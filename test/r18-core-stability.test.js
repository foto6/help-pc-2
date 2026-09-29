import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../src/native-registry.js";
import { __test as mcpTest } from "../src/mcp-host.js";
import {
  ControlPlane, HelpPc1Adapter, NativeControlFacade, NativeMcpRuntime,
  NATIVE_CONTROL_PROTOCOL_V1, TOOL_REGISTRY,
  JsonStateStore, JsonFacadeStateStore, createConfiguredNativeMcpRuntime,
} from "../src/index.js";

const TTL = 30 * 60 * 1000;
function success(req, data={}) {
  return {request_id:req.request_id,action:req.action,ok:true,status:"completed",
    dry_run:false,data,started_at:"2026-09-29T00:00:00Z",finished_at:"2026-09-29T00:00:01Z",
    error:null,error_kind:null};
}
async function fixture({withEpoch=false}={}) {
  const st={now:1000,calls:0,epoch:"device-boot-A",effectCalls:0};
  const cp=new ControlPlane({providers:[new HelpPc1Adapter({dryRun:false,invoke:async req=>{
    st.calls++;
    if(req.action==="fs.write_text"||req.action==="process.terminate") st.effectCalls++;
    if(req.action==="process.start") return success(req,{process_handle:"opaque-epoch-bound-handle"});
    if(req.action==="process.read") return success(req,{items:["still-running"],next_cursor:null});
    if(req.action==="process.terminate") return success(req,{terminated:true});
    return success(req,{written:true});
  }})]});
  const facade=new NativeControlFacade({
    controlPlane:cp,clock:()=>st.now,sessionTtlMs:TTL,
    capabilityProvider:async()=>({digest:"executor-contract-R18",contract_version:"pc_executor.capabilities.v1",
      actions:["fs.write_text","process.start","process.read","process.terminate","system.health"]}),
    ...(withEpoch?{deviceIdentityProvider:async()=>({
      deviceId:"personal-pc",sessionEpoch:st.epoch,executorDigest:"executor-contract-R18"})}:{}),
  });
  const runtime=await NativeMcpRuntime.create({facade,desktopId:"r18-private-fixture"});
  return {st,cp,facade,runtime,close:()=>runtime.close()};
}
function req(sid,rid,tool,args={}){
  return {contract_version:NATIVE_CONTROL_PROTOCOL_V1,session_id:sid,request_id:rid,tool,arguments:args};
}
const ctx=()=>({mcpReq:{id:73}});

test("R18: the first NEW side effect after TTL renews before dispatch exactly once",async t=>{
 const h=await fixture();t.after(h.close);
 await h.runtime.ensureFacadeSession();h.st.now+=TTL+1;
 const out=await h.runtime.callNativeTool(TOOL_REGISTRY["file.write"],
  {request_id:"unique-new-write-after-ttl",path:"C:\\Temp\\r18-new.txt",text:"once"},ctx());
 assert.equal(out.structuredContent.status,"completed");
 assert.equal(h.st.effectCalls,1);
 assert.equal(h.facade.debugSnapshot().sessions.length,2);
});

test("R18: duplicate terminate after handle is marked closed returns cached receipt",async t=>{
 const h=await fixture();t.after(h.close);await h.runtime.ensureFacadeSession();
 const sid=h.runtime.facadeSession.session_id;
 const created=await h.facade.invoke(req(sid,"process-start","process.start",{command:"isolated-echo"}));
 assert.equal(created.status,"completed");
 const stop=req(sid,"process-stop","process.terminate",{handle:created.data.process_handle});
 const first=await h.facade.invoke(stop);
 assert.equal(first.status,"completed");
 const duplicate=await h.facade.invoke(stop);
 assert.deepEqual(duplicate,first);
 assert.equal(h.st.effectCalls,1);
});

test("R18: recover lost Facade actionId using durable Control action without redispatch",async t=>{
 const h=await fixture();t.after(h.close);await h.runtime.ensureFacadeSession();
 const sid=h.runtime.facadeSession.session_id;
 const envelope=req(sid,"allocating-crash-after-control-save","file.write",
  {path:"C:\\Temp\\r18-idempotency.txt",text:"once"});
 const first=await h.facade.invoke(envelope);
 assert.equal(first.status,"completed");
 assert.equal(h.st.effectCalls,1);
 const record=h.facade.state.requests.find(x=>x.requestId===envelope.request_id);
 record.actionId=null;record.status="allocating";record.response=null;
 const resumed=await h.facade.invoke(envelope);
 assert.equal(resumed.status,"completed");
 assert.equal(h.st.effectCalls,1);
 assert.equal(h.cp.listActions().length,1);
});

test("R18: the same mutation ID after renewal returns original receipt, never executes twice",async t=>{
 const h=await fixture();t.after(h.close);await h.runtime.ensureFacadeSession();
 const old=h.runtime.facadeSession.session_id;
 const envelope=req(old,"same-id-across-renewal","file.write",
  {path:"C:\\Temp\\r18-idempotency.txt",text:"once"});
 const first=await h.facade.invoke(envelope);
 h.st.now+=TTL+1;
 await h.runtime.ensureFacadeSession({allowExpiredRenewal:true});
 const after=await h.facade.invoke({...envelope,session_id:h.runtime.facadeSession.session_id});
 assert.equal(after.status,"completed");
 assert.equal(after.data.written,true);
 assert.equal(h.st.effectCalls,1);
});

test("R18: epoch-bound live process handle remains usable after the session TTL",async t=>{
 const h=await fixture({withEpoch:true});t.after(h.close);await h.runtime.ensureFacadeSession();
 const before=h.runtime.facadeSession.session_id;
 const start=await h.facade.invoke(req(before,"start-live-process","process.start",{command:"isolated-echo"}));
 assert.equal(start.status,"completed");
 h.st.now+=TTL+1;
 await h.runtime.ensureFacadeSession({allowExpiredRenewal:true});
 assert.equal(h.runtime.facadeSession.session_id,before,"retains original session/handle owner");
 const read=await h.facade.invoke(req(before,"continue-existing-process","process.read",
  {handle:start.data.process_handle}));
 assert.equal(read.status,"completed");
 assert.equal(h.cp.listSessions().filter(s=>s.status==="active").length,1);
});
test("R18: epoch mismatch and missing epoch proof refuse process-handle rebinding",async t=>{
 const h=await fixture({withEpoch:true});t.after(h.close);await h.runtime.ensureFacadeSession();
 const sid=h.runtime.facadeSession.session_id;
 await h.facade.invoke(req(sid,"start-bound-handle","process.start",{command:"isolated-echo"}));
 h.st.now+=TTL+1;h.st.epoch="different-device-boot";
 await assert.rejects(
  h.runtime.ensureFacadeSession({allowExpiredRenewal:true}),
  e=>["STALE_DEVICE_SESSION","SESSION_RENEWAL_BLOCKED"].includes(e.code),
 );
 assert.equal(h.cp.listSessions().filter(s=>s.status==="active").length,1);
 assert.equal(h.st.effectCalls,0);
});
test("R18: explicitly migrate quiescent legacy R15 stale owner, without a ghost Control session",async t=>{
 const h=await fixture();t.after(h.close);await h.runtime.ensureFacadeSession();
 const sid=h.runtime.facadeSession.session_id;
 const old=h.facade.state.sessions.find(s=>s.id===sid);
 h.st.now+=TTL+1;old.status="stale";delete old.staleReason;
 const result=await h.facade.migrateLegacyQuiescentSession({
  sessionId:sid,desktopId:"r18-private-fixture",client:{
   protocol_version:(await h.facade.capabilities()).protocol_version,
   registry_digest:(await h.facade.capabilities()).registry_digest,
   executor_digest:"executor-contract-R18",
  },
 });
 assert.equal(result.status,"closed");
 const fresh=await NativeMcpRuntime.create({facade:h.facade,desktopId:"r18-private-fixture"});
 t.after(()=>fresh.close());await fresh.ensureFacadeSession();
 assert.equal(h.cp.listSessions().filter(s=>s.status==="active").length,1);
 assert.equal(h.st.effectCalls,0);
});

test("R18 crash before Control enqueue: matching allocating record can safely create one action",async t=>{
 const h=await fixture();t.after(h.close);await h.runtime.ensureFacadeSession();
 const sid=h.runtime.facadeSession.session_id;
 const args={path:"C:\\Temp\\r18-before-control.txt",text:"exactly-once"};
 const rid="crashed-before-control-commit";
 h.facade.state.requests.push({
  sessionId:sid,requestId:rid,
  fingerprint:sha256({tool:"file.write",args,page:null}),
  tool:"file.write",effect:"side_effect",args,
  pageLimit:200,pageRequested:false,actionId:null,status:"allocating",response:null,
 });
 const envelope=req(sid,rid,"file.write",args);
 const recovered=await h.facade.invoke(envelope);
 assert.equal(recovered.status,"completed");
 assert.equal((await h.facade.invoke(envelope)).status,"completed");
 assert.equal(h.st.effectCalls,1);
 assert.equal(h.cp.listActions().length,1);
});

test("R18 persisted Control/Facade restart repairs a missing actionId without redispatch",async t=>{
 const directory=mkdtempSync(join(tmpdir(),"native-r18-crash-fixture-"));
 t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const control=join(directory,"control.json"),facadeFile=join(directory,"facade.json");
 let effects=0;
 const adapter=new HelpPc1Adapter({dryRun:false,invoke:async x=>{
  effects++;
  return success(x,{written:true});
 }});
 const caps=async()=>({digest:"persistent-executor",contract_version:"pc_executor.capabilities.v1",
  actions:["fs.write_text"]});
 const cp1=new ControlPlane({providers:[adapter],store:new JsonStateStore(control)});
 const f1=new NativeControlFacade({controlPlane:cp1,store:new JsonFacadeStateStore(facadeFile),capabilityProvider:caps});
 const manifest=await f1.capabilities();
 const opening=await f1.openSession({desktopId:"r18-crash",client:{
  protocol_version:manifest.protocol_version,registry_digest:manifest.registry_digest,
  executor_digest:manifest.executor.digest,
 }});
 const original=req(opening.session_id,"persisted-original","file.write",
  {path:"C:\\Temp\\r18-persisted.txt",text:"one"});
 assert.equal((await f1.invoke(original)).status,"completed");
 assert.equal(effects,1);
 // Simulate ONLY the Facade save between durable Control enqueue and
 // linking its actionId. No filesystem mutation happens on this edit.
 const broken=f1.debugSnapshot();
 const entry=broken.requests.find(x=>x.requestId===original.request_id);
 entry.actionId=null;entry.status="allocating";entry.response=null;
 new JsonFacadeStateStore(facadeFile).save(broken);
 const cp2=new ControlPlane({providers:[adapter],store:new JsonStateStore(control)});
 const f2=new NativeControlFacade({controlPlane:cp2,store:new JsonFacadeStateStore(facadeFile),capabilityProvider:caps});
 const result=await f2.invoke(original);
 assert.equal(result.status,"completed");
 assert.equal(effects,1,"old side effect must not execute a second time");
 assert.equal(cp2.listActions().length,1);
});

test("R18 changed arguments with old mutation ID fail across renewal before side effects",async t=>{
 const h=await fixture();t.after(h.close);await h.runtime.ensureFacadeSession();
 const sid=h.runtime.facadeSession.session_id;
 const args={path:"C:\\Temp\\r18-delta.txt",text:"original"};
 assert.equal((await h.facade.invoke(req(sid,"cross-ttl-id","file.write",args))).status,"completed");
 h.st.now+=TTL+1;
 await h.runtime.ensureFacadeSession({allowExpiredRenewal:true});
 await assert.rejects(h.facade.invoke(req(h.runtime.facadeSession.session_id,
  "cross-ttl-id","file.write",{...args,text:"different"})),
  e=>e.code==="DUPLICATE_REQUEST_MISMATCH");
 assert.equal(h.st.effectCalls,1);
});

test("R18 64 simultaneous identical calls after TTL do not create a second mutation",async t=>{
 const h=await fixture();t.after(h.close);await h.runtime.ensureFacadeSession();h.st.now+=TTL+1;
 const results=await Promise.all(Array.from({length:64},()=>h.runtime.callNativeTool(
  TOOL_REGISTRY["file.write"],
  {request_id:"same-after-idle",path:"C:\\Temp\\r18-multi.txt",text:"once"},ctx())));
 assert.ok(results.every(r=>["completed","pending"].includes(r.structuredContent.status)));
 assert.equal(h.st.effectCalls,1);
 assert.equal(h.cp.listActions().length,1);
});

test("R18 unresolved old write still refuses a brand-new post-TTL write",async t=>{
 const h=await fixture();t.after(h.close);await h.runtime.ensureFacadeSession();
 const sid=h.runtime.facadeSession.session_id;
 await h.facade.invoke(req(sid,"old-write-unknown","file.write",
  {path:"C:\\Temp\\r18-old-unknown.txt",text:"once"}));
 const action=h.cp.listActions()[0];
 h.cp.actions.get(action.id).status="uncertain_outcome";
 h.st.now+=TTL+1;
 const rejected=await h.runtime.callNativeTool(TOOL_REGISTRY["file.write"],
  {request_id:"new-write-must-wait",path:"C:\\Temp\\r18-new-blocked.txt",text:"new"},ctx());
 assert.equal(rejected.structuredContent.status,"error");
 assert.equal(rejected.structuredContent.error.code,"SESSION_RENEWAL_BLOCKED");
 assert.equal(h.st.effectCalls,1);
 assert.equal(h.cp.listSessions().filter(s=>s.status==="active").length,1);
});

test("R18 reconstructs successful unprojected process creation from durable Control journal",async t=>{
 const h=await fixture({withEpoch:true});t.after(h.close);await h.runtime.ensureFacadeSession();
 const sid=h.runtime.facadeSession.session_id;
 const started=await h.facade.invoke(req(sid,"process-creation-committed",
  "process.start",{command:"isolated-echo"}));
 assert.equal(started.status,"completed");
 h.facade.state.handles.length=0;
 h.st.now+=TTL+1;
 await h.runtime.ensureFacadeSession({allowExpiredRenewal:true});
 assert.equal(h.runtime.facadeSession.session_id,sid);
 const read=await h.facade.invoke(req(sid,"read-restored-handle","process.read",
  {handle:started.data.process_handle}));
 assert.equal(read.status,"completed");
 assert.equal(h.facade.debugSnapshot().handles.filter(x=>x.status==="open").length,1);
});

test("R18 durable handle journal respects creation/termination insertion order",async()=>{
 const h=await fixture({withEpoch:true});await h.runtime.ensureFacadeSession();
 const sid=h.runtime.facadeSession.session_id;
 const start=await h.facade.invoke(req(sid,"r18-handle-create",
  "process.start",{command:"isolated-echo"}));
 await h.facade.invoke(req(sid,"r18-handle-close",
  "process.terminate",{handle:start.data.process_handle}));
 h.facade.state.handles.length=0;
 await h.runtime.close();
 assert.equal(h.cp.listSessions()[0].status,"closed");
 assert.equal(h.facade.debugSnapshot().handles.filter(x=>x.status==="open").length,0);
});

test("R18 live process handles without frozen device epoch block TTL renewal",async t=>{
 const h=await fixture();t.after(h.close);await h.runtime.ensureFacadeSession();
 const sid=h.runtime.facadeSession.session_id;
 await h.facade.invoke(req(sid,"start-without-epoch","process.start",{command:"isolated-echo"}));
 h.st.now+=TTL+1;
 await assert.rejects(h.runtime.ensureFacadeSession({allowExpiredRenewal:true}),
  e=>e.code==="SESSION_RENEWAL_BLOCKED");
 assert.equal(h.cp.listSessions().filter(x=>x.status==="active").length,1);
});

test("R18 epoch drift is rejected even without a TTL expiry",async t=>{
 const h=await fixture({withEpoch:true});t.after(h.close);
 await h.runtime.ensureFacadeSession();h.st.epoch="device-rebooted";
 const out=await h.runtime.callNativeTool(TOOL_REGISTRY["file.write"],
  {request_id:"new-request-after-reboot",path:"C:\\Temp\\r18-epoch.txt",text:"should-not-write"},ctx());
 assert.equal(out.structuredContent.status,"error");
 assert.equal(out.structuredContent.error.code,"STALE_DEVICE_SESSION");
 assert.equal(h.st.effectCalls,0);
});

test("R18 legacy R15 migration blocks an open process without touching old Control owner",async t=>{
 const h=await fixture();t.after(h.close);await h.runtime.ensureFacadeSession();
 const sid=h.runtime.facadeSession.session_id;
 await h.facade.invoke(req(sid,"legacy-process","process.start",{command:"isolated-echo"}));
 h.st.now+=TTL+1;
 const old=h.facade.state.sessions.find(x=>x.id===sid);
 old.status="stale";delete old.staleReason;
 const mf=await h.facade.capabilities();
 await assert.rejects(h.facade.migrateLegacyQuiescentSession({sessionId:sid,
  desktopId:"r18-private-fixture",client:{
    protocol_version:mf.protocol_version,registry_digest:mf.registry_digest,
    executor_digest:mf.executor.digest,
  }}),e=>e.code==="SESSION_MIGRATION_BLOCKED");
 assert.equal(h.cp.listSessions()[0].status,"active");
});

test("R18 legacy migration resumes after Control close/Facade save crash",async t=>{
 const h=await fixture();t.after(h.close);await h.runtime.ensureFacadeSession();
 const sid=h.runtime.facadeSession.session_id;
 h.st.now+=TTL+1;
 const old=h.facade.state.sessions.find(x=>x.id===sid);
 old.status="stale";delete old.staleReason;
 h.cp.closeSession(old.controlSessionId);
 const mf=await h.facade.capabilities();
 const result=await h.facade.migrateLegacyQuiescentSession({sessionId:sid,
  desktopId:"r18-private-fixture",client:{
    protocol_version:mf.protocol_version,registry_digest:mf.registry_digest,
    executor_digest:mf.executor.digest,
  }});
 assert.equal(result.migrated,true);
 assert.equal(h.cp.listSessions().filter(x=>x.status==="active").length,0);
});


test("R18 same owner mutation ID survives orderly close/restart and never dispatches twice",async t=>{
 const h=await fixture();t.after(h.close);await h.runtime.ensureFacadeSession();
 const sid=h.runtime.facadeSession.session_id;
 const original=req(sid,"durable-owner-request-id","file.write",
  {path:"C:\\Temp\\r18-restart-safe.txt",text:"one"});
 assert.equal((await h.facade.invoke(original)).status,"completed");
 assert.equal(h.st.effectCalls,1);
 h.facade.closeSession(sid);
 const mf=await h.facade.capabilities();
 const reopened=await h.facade.openSession({desktopId:"r18-private-fixture",client:{
  protocol_version:mf.protocol_version,registry_digest:mf.registry_digest,executor_digest:mf.executor.digest,
 }});
 const receipt=await h.facade.invoke({...original,session_id:reopened.session_id});
 assert.equal(receipt.status,"completed");
 assert.equal(h.st.effectCalls,1);
 await assert.rejects(h.facade.invoke({...original,session_id:reopened.session_id,
  arguments:{...original.arguments,text:"changed"}}),e=>e.code==="DUPLICATE_REQUEST_MISMATCH");
 assert.equal(h.st.effectCalls,1);
});

test("R18 explicit logical ID remains deduplicated across a real persisted graceful restart",async t=>{
 const directory=mkdtempSync(join(tmpdir(),"native-r18-owner-restart-"));
 t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const control=join(directory,"control.json");
 const facadeFile=join(directory,"facade.json");
 let effects=0;
 const adapter=new HelpPc1Adapter({dryRun:false,invoke:async request=>{
  effects++;
  return success(request,{written:true});
 }});
 const caps=async()=>({contract_version:"pc_executor.capabilities.v1",
  digest:"r18-graceful-persistent",actions:["fs.write_text"]});
 const cp1=new ControlPlane({providers:[adapter],store:new JsonStateStore(control)});
 const f1=new NativeControlFacade({controlPlane:cp1,
  store:new JsonFacadeStateStore(facadeFile),capabilityProvider:caps});
 const mf=await f1.capabilities();
 const client={protocol_version:mf.protocol_version,registry_digest:mf.registry_digest,
  executor_digest:mf.executor.digest};
 const old=await f1.openSession({desktopId:"r18-owner-restart",client});
 const original=req(old.session_id,"persisted-one-owner-id","file.write",
  {path:"C:\\Temp\\r18-persisted-owner.txt",text:"once"});
 assert.equal((await f1.invoke(original)).status,"completed");
 f1.closeSession(old.session_id);
 const cp2=new ControlPlane({providers:[adapter],store:new JsonStateStore(control)});
 const f2=new NativeControlFacade({controlPlane:cp2,
  store:new JsonFacadeStateStore(facadeFile),capabilityProvider:caps});
 const current=await f2.openSession({desktopId:"r18-owner-restart",client});
 const oldReceipt=await f2.invoke({...original,session_id:current.session_id});
 assert.equal(oldReceipt.status,"completed");
 assert.equal(effects,1);
 assert.equal(cp2.listActions().length,1);
});

test("R18 fallback IDs are unique across independent MCP transports; explicit retry IDs persist",async()=>{
 const fake={mcpReq:{id:1}};
 const first=mcpTest.requestIdentity("file.write",{},fake);
 const second=mcpTest.requestIdentity("file.write",{},fake);
 assert.notEqual(first,second);
 assert.equal(mcpTest.requestIdentity("file.write",{request_id:"stable-owner-id"},fake),"stable-owner-id");
});

test("R18 installed runtime supports pinned one-time migration of R15 stale owner",async t=>{
 const directory=mkdtempSync(join(tmpdir(),"native-r18-upgrade-config-"));
 t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const stateDir=join(directory,"state");
 let effects=0;
 const cfg={enabled:true,createExecutorBridge:async()=>({
  desktopId:"r18-upgrade-desktop",dryRun:false,
  invoke:async req=>{effects++;return success(req)},
  readCapabilities:async()=>({contract_version:"pc_executor.capabilities.v1",
   digest:"r18-upgrade-digest",actions:["system.health"]}),
 })};
 const old=await createConfiguredNativeMcpRuntime({stateDir,testConfig:cfg});
 await old.runtime.ensureFacadeSession();
 const sid=old.runtime.facadeSession.session_id;
 const persisted=old.facade.debugSnapshot();
 persisted.sessions[0].status="stale";
 persisted.sessions[0].lastSeenAtMs=Date.now()-TTL-60_000;
 delete persisted.sessions[0].staleReason;
 new JsonFacadeStateStore(join(stateDir,"native-facade.json")).save(persisted);
 await assert.rejects(createConfiguredNativeMcpRuntime({
  stateDir,testConfig:cfg,legacyMigrationSessionId:"wrong-expected-id",
 }),e=>e.code==="SESSION_MIGRATION_BLOCKED");
 const upgraded=await createConfiguredNativeMcpRuntime({
  stateDir,testConfig:cfg,legacyMigrationSessionId:sid,
 });
 t.after(()=>upgraded.runtime.close());
 await upgraded.runtime.ensureFacadeSession();
 assert.equal(upgraded.controlPlane.listSessions().filter(x=>x.status==="active").length,1);
 assert.equal(upgraded.facade.debugSnapshot().sessions.find(x=>x.id===sid).status,"closed");
 assert.equal(effects,0);
});

test("R18 replaying old process creation after termination cannot reopen its closed handle",async t=>{
 const h=await fixture({withEpoch:true});t.after(h.close);
 await h.runtime.ensureFacadeSession();
 const original=h.runtime.facadeSession.session_id;
 const startArgs={command:"isolated-echo"};
 const created=await h.facade.invoke(req(original,"same-old-process-start","process.start",startArgs));
 assert.equal(created.status,"completed");
 const handle=created.data.process_handle;
 assert.equal((await h.facade.invoke(req(original,"stop-old-process","process.terminate",
  {handle}))).status,"completed");
 assert.equal(h.facade.debugSnapshot().handles.filter(x=>x.status==="open").length,0);
 h.facade.closeSession(original);
 const mf=await h.facade.capabilities();
 const next=await h.facade.openSession({desktopId:"r18-private-fixture",client:{
  protocol_version:mf.protocol_version,registry_digest:mf.registry_digest,
  executor_digest:mf.executor.digest,
 }});
 const duplicate=await h.facade.invoke(req(next.session_id,"same-old-process-start",
  "process.start",startArgs));
 assert.equal(duplicate.status,"completed");
 assert.equal(h.st.calls,2,"one process.start + one process.terminate only");
 assert.equal(h.facade.debugSnapshot().handles.filter(x=>x.status==="open").length,0,
  "cached old start must never resurrect a closed handle");
 assert.equal(h.cp.listActions().length,2);
 h.facade.closeSession(next.session_id);
});
