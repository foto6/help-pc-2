import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {ControlPlane,HelpPc1Adapter,NativeControlFacade,NativeMcpRuntime,JsonStateStore,JsonFacadeStateStore,
 NATIVE_CONTROL_PROTOCOL_V1} from "../src/index.js";
const TTL=1800000;
function result(r,data={written:true}){return {request_id:r.request_id,action:r.action,ok:true,status:"completed",
 started_at:"2026-09-29T00:00:00Z",finished_at:"2026-09-29T00:00:01Z",dry_run:false,
 data,error:null,error_kind:null};}
async function make({root=null,device=false}={}){
 let now=1000,effects=0;
 const adapter=new HelpPc1Adapter({dryRun:false,invoke:async r=>{
  effects++;
  return result(r,r.action==="process.start"?{process_handle:"fixture-child"}:{written:true});
 }});
 const control=new ControlPlane({providers:[adapter],...(root?{store:new JsonStateStore(join(root,"control.json"))}:{})});
 const facade=new NativeControlFacade({controlPlane:control,
  ...(root?{store:new JsonFacadeStateStore(join(root,"facade.json"))}:{}),
  clock:()=>now,sessionTtlMs:TTL,
  capabilityProvider:async()=>({digest:"pinned-stable-r18",contract_version:"pc_executor.capabilities.v1",
  actions:["fs.write_text","process.start"]}),
  ...(device?{deviceIdentityProvider:async()=>({deviceId:"isolated",sessionEpoch:"boot-1",
    executorDigest:"pinned-stable-r18"})}:{}),
 });
 const runtime=await NativeMcpRuntime.create({facade,desktopId:"audit-only"});
 await runtime.ensureFacadeSession();
 const old=structuredClone(runtime.facadeSession);
 const envelope=(requestId,tool="file.write",arguments_={path:"C:\\isolated\\fixture.txt",text:"once"})=>
 ({contract_version:NATIVE_CONTROL_PROTOCOL_V1,session_id:old.session_id,
 request_id:requestId,tool,arguments:arguments_});
 return {facade,control,runtime,old,envelope,counts:()=>effects,advance:()=>{now+=TTL+1;},
  now:()=>now,adapter,caps:async()=>({digest:"pinned-stable-r18",contract_version:"pc_executor.capabilities.v1",
  actions:["fs.write_text","process.start"]}),close:()=>runtime.close()};
}
function loseLink(h,rid){
 const record=h.facade.state.requests.find(x=>x.requestId===rid);
 assert.ok(record);
 record.actionId=null;record.status="allocating";record.response=null;
 return record;
}
test("Independent: lost link after already executed write restores completed receipt on expired journal and next session",async t=>{
 const h=await make();t.after(h.close);
 const env=h.envelope("lost-after-control");
 assert.equal((await h.facade.invoke(env)).status,"completed");
 loseLink(h,env.request_id);h.advance();
 await h.runtime.ensureFacadeSession({allowExpiredRenewal:true});
 const lookup=h.facade.lookupRequest({sessionId:h.old.session_id,requestId:env.request_id,
  resumeToken:h.old.resume_token});
 assert.equal(lookup.status,"completed");
 const retry=await h.facade.invoke({...env,session_id:h.runtime.facadeSession.session_id});
 assert.equal(retry.status,"completed");
 assert.equal(h.counts(),1);
 assert.equal(h.control.listActions().length,1);
});
test("Independent: missing Control allocation never becomes a new action through stale journal",async t=>{
 const h=await make();t.after(h.close);
 const req=h.envelope("allocating-with-no-control");
 h.facade.state.requests.push({sessionId:h.old.session_id,requestId:req.request_id,
  fingerprint:"original-fingerprint",tool:"file.write",effect:"side_effect",
  args:req.arguments,pageLimit:200,pageRequested:false,
  actionId:null,status:"allocating",response:null});
 h.advance();await h.runtime.ensureFacadeSession({allowExpiredRenewal:true});
 const input={sessionId:h.old.session_id,requestId:req.request_id,resumeToken:h.old.resume_token};
 assert.equal(h.facade.lookupRequest(input).status,"reconciliation_required");
 assert.equal((await h.facade.reconcileRequest(input)).status,"reconciliation_required");
 assert.equal(h.counts(),0);assert.equal(h.control.listActions().length,0);
});
test("Independent: tampered original action input refuses stale-link recovery with no second write",async t=>{
 const h=await make();t.after(h.close);
 const req=h.envelope("tampered-control-input");
 await h.facade.invoke(req);loseLink(h,req.request_id);
 h.control.actions.get(h.control.listActions()[0].id).input.text="unexpected";
 h.advance();await h.runtime.ensureFacadeSession({allowExpiredRenewal:true});
 assert.throws(()=>h.facade.lookupRequest({sessionId:h.old.session_id,requestId:req.request_id,
  resumeToken:h.old.resume_token}),e=>e.code==="DUPLICATE_REQUEST_MISMATCH");
 assert.equal(h.counts(),1);
});
test("Independent: expired unprojected process creation is not reattached by journal recovery",async t=>{
 const h=await make({device:true});t.after(h.close);
 const req=h.envelope("created-but-receipt-lost","process.start",{command:"fixture-worker"});
 assert.equal((await h.facade.invoke(req)).status,"completed");
 loseLink(h,req.request_id);h.facade.state.handles.length=0;h.advance();
 const lookup=h.facade.lookupRequest({sessionId:h.old.session_id,requestId:req.request_id,
  resumeToken:h.old.resume_token});
 assert.equal(lookup.status,"reconciliation_required");
 assert.equal(lookup.data.reason,"historical_handle_receipt_missing");
 assert.equal(h.facade.debugSnapshot().handles.length,0);
 assert.equal(h.counts(),1);
});
test("Independent: actual persisted two-file JSON crash and expiry restores existing action read-only",async t=>{
 const root=mkdtempSync(join(tmpdir(),"r18-independent-journal-recovery-"));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const h=await make({root});t.after(h.close);
 const req=h.envelope("real-persisted-control-before-link");
 assert.equal((await h.facade.invoke(req)).status,"completed");
 const originalAction=h.control.listActions()[0].id;
 const snap=h.facade.debugSnapshot();
 const row=snap.requests.find(x=>x.requestId===req.request_id);
 row.actionId=null;row.status="allocating";row.response=null;
 new JsonFacadeStateStore(join(root,"facade.json")).save(snap);
 h.advance();
 const control2=new ControlPlane({providers:[h.adapter],store:new JsonStateStore(join(root,"control.json"))});
 const facade2=new NativeControlFacade({controlPlane:control2,
  store:new JsonFacadeStateStore(join(root,"facade.json")),clock:h.now,sessionTtlMs:TTL,
  capabilityProvider:h.caps});
 const found=facade2.lookupRequest({sessionId:h.old.session_id,requestId:req.request_id,
  resumeToken:h.old.resume_token});
 assert.equal(found.status,"completed");
 assert.equal(control2.listActions().length,1);
 assert.equal(control2.listActions()[0].id,originalAction);
 assert.equal(h.counts(),1);
});

test("Independent: first retry after TTL repairs an unlinked prior write without requiring a separate journal lookup",async t=>{
 const h=await make();t.after(h.close);
 const env=h.envelope("unlinked-direct-retry");
 assert.equal((await h.facade.invoke(env)).status,"completed");
 loseLink(h,env.request_id);h.advance();
 await h.runtime.ensureFacadeSession({allowExpiredRenewal:true});
 const replay=await h.facade.invoke({...env,session_id:h.runtime.facadeSession.session_id});
 assert.equal(replay.status,"completed");
 assert.equal(h.counts(),1);
 assert.equal(h.control.listActions().length,1);
});
test("Independent: historical Control action with forged owner metadata cannot be linked",async t=>{
 const h=await make();t.after(h.close);
 const env=h.envelope("old-provenance-forgery");
 await h.facade.invoke(env);loseLink(h,env.request_id);
 h.control.actions.get(h.control.listActions()[0].id).metadata.native_session_id="other-owner";
 h.advance();await h.runtime.ensureFacadeSession({allowExpiredRenewal:true});
 assert.throws(()=>h.facade.lookupRequest({sessionId:h.old.session_id,requestId:env.request_id,
 resumeToken:h.old.resume_token}),e=>e.code==="DUPLICATE_REQUEST_MISMATCH");
 assert.equal(h.counts(),1);
});
