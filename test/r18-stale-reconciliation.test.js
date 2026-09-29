import test from "node:test";
import assert from "node:assert/strict";
import {
  ControlPlane, HelpPc1Adapter, NativeControlFacade, LocalNativeHttpTransport,
  NATIVE_CONTROL_PROTOCOL_V1,
} from "../src/index.js";

const TTL = 30 * 60 * 1000;
const HTTP_TOKEN = "r18-isolated-only-http-token-20260929";
function success(request, data = {}) {
  return {
    request_id: request.request_id, action: request.action, ok: true,
    status: "completed", dry_run: false, data,
    started_at: "2026-09-29T00:00:00Z",
    finished_at: "2026-09-29T00:00:01Z",
    error: null, error_kind: null,
  };
}
async function fixture() {
  const state = { now: 1_000, effects: 0, evidenceReads: 0, evidence: "unknown" };
  const adapter = new HelpPc1Adapter({
    dryRun: false,
    invoke: async (request) => {
      state.effects += 1;
      return { ...success(request), ok: false, status: "timeout",
        error: "possible committed write but reply was lost", error_kind: "timeout" };
    },
    readEvidence: async (request) => {
      state.evidenceReads += 1;
      if (state.evidence === "unknown") {
        return { outcome: "unknown", source: "isolated-r18-lookup", reason: "pending_device_receipt" };
      }
      return {
        outcome: "succeeded", source: "isolated-r18-lookup",
        result: success({request_id:request.request_id, action:request.action}, {written:true}),
      };
    },
  });
  const cp = new ControlPlane({providers:[adapter]});
  const facade = new NativeControlFacade({
    controlPlane:cp, clock:()=>state.now, sessionTtlMs:TTL,
    capabilityProvider:async()=>({
      contract_version:"pc_executor.capabilities.v1",
      digest:"r18-expired-reconcile-static-executor",
      actions:["fs.write_text"],
    }),
  });
  const manifest = await facade.capabilities();
  const client = {
    protocol_version:manifest.protocol_version,
    registry_digest:manifest.registry_digest,
    executor_digest:manifest.executor.digest,
  };
  const opened=await facade.openSession({desktopId:"r18-expired-journal",client});
  const request = {
    contract_version:NATIVE_CONTROL_PROTOCOL_V1,
    session_id:opened.session_id,
    request_id:"r18-first-mutation-reply-lost",
    tool:"file.write",
    arguments:{path:"C:\\Temp\\r18-logical-fixture-only.txt",text:"single-once"},
  };
  const initial=await facade.invoke(request);
  assert.equal(initial.status,"reconciliation_required");
  assert.equal(state.effects,1);
  state.now+=TTL+1;
  const controlSessionId=facade.debugSnapshot().sessions.find(s=>s.id===opened.session_id).controlSessionId;
  return {state,cp,facade,manifest,opened,request,controlSessionId,client};
}
function extraQueued(h) {
  return h.cp.enqueueAction(h.controlSessionId,{
    provider:"help-pc-1", type:"fs.write_text",
    input:{path:"C:\\Temp\\r18-unrelated-no-execute.txt",text:"do-not-execute"},
    idempotencyKey:"extra-unrelated-mutation", correlationId:"r18-unrelated-action",
    requiresDesktop:false,
  });
}
test("R18 stale journal demands original token, then read-only lookup never dispatches",async()=>{
  const h=await fixture();
  await assert.rejects(
    Promise.resolve().then(()=>h.facade.lookupRequest({
      sessionId:h.opened.session_id,requestId:h.request.request_id,
    })),
    e=>e.code==="SESSION_AUTH_FAILED",
  );
  assert.throws(()=>h.facade.lookupRequest({
    sessionId:h.opened.session_id,requestId:h.request.request_id,
    resumeToken:"incorrect-stale-token",
  }), e=>e.code==="SESSION_AUTH_FAILED");
  const original=h.facade.lookupRequest({
    sessionId:h.opened.session_id,requestId:h.request.request_id,
    resumeToken:h.opened.resume_token,
  });
  assert.equal(original.status,"reconciliation_required");
  assert.equal(h.state.effects,1);
  assert.equal(h.state.evidenceReads,0,"ordinary stale lookup must not process an action");
  await assert.rejects(
    h.facade.invoke(h.request),e=>e.code==="STALE_SESSION",
  );
});

test("R18 targeted stale reconciliation cannot execute unrelated queued side effects",async()=>{
  const h=await fixture();
  const unrelated=extraQueued(h);
  const active=h.cp.getAction(unrelated.id);
  assert.equal(active.status,"queued");
  const original={sessionId:h.opened.session_id,requestId:h.request.request_id,
    resumeToken:h.opened.resume_token};
  const unknown=await h.facade.reconcileRequest(original);
  assert.equal(unknown.status,"reconciliation_required");
  assert.equal(h.state.effects,1,"no second physical mutation on unknown evidence");
  assert.equal(h.cp.getAction(unrelated.id).status,"queued");
  h.state.evidence="succeeded";
  const recovered=await h.facade.reconcileRequest(original);
  assert.equal(recovered.status,"completed");
  assert.equal(recovered.data.written,true);
  assert.equal(h.state.effects,1,"old write was not sent again");
  assert.equal(h.cp.getAction(unrelated.id).status,"queued");
  assert.ok(h.state.evidenceReads>=2);
  h.cp.cancelAction(unrelated.id);
  const renewed=await h.facade.renewExpiredSession({
    sessionId:h.opened.session_id,resumeToken:h.opened.resume_token,
    desktopId:"r18-expired-journal",client:h.client,
  });
  assert.notEqual(renewed.session_id,h.opened.session_id);
  assert.equal(h.state.effects,1);
  assert.equal(h.cp.listSessions().filter(s=>s.status==="active").length,1);
});

test("R18 reconciliationOnly selector is inert for queued new side effects",async()=>{
  const h=await fixture();
  const unrelated=extraQueued(h);
  const view=await h.cp.reconcileNext(unrelated.id);
  assert.equal(view.status,"queued");
  assert.equal(h.cp.getAction(unrelated.id).status,"queued");
  assert.equal(h.state.effects,1);
});

test("R18 expired journal HTTP route is loopback/transport-auth gated and isolated",async t=>{
  const h=await fixture();
  h.state.evidence="succeeded";
  const http=new LocalNativeHttpTransport({facade:h.facade,token:HTTP_TOKEN,port:0});
  const address=await http.start();
  t.after(()=>http.stop());
  const url=address.url+"/v1/request/";
  const data={sessionId:h.opened.session_id,requestId:h.request.request_id};
  const post=(path,body,auth=HTTP_TOKEN)=>fetch(url+path,{
    method:"POST",
    headers:{"content-type":"application/json",authorization:"Bearer "+auth},
    body:JSON.stringify(body),
  });
  const denied=await post("lookup",data,"invalid-transport");
  assert.equal(denied.status,401);
  const staleDenied=await post("lookup",data);
  assert.equal(staleDenied.status,401);
  const allowed=await post("lookup",{...data,resumeToken:h.opened.resume_token});
  assert.equal(allowed.status,200);
  const original=await allowed.json();
  assert.equal(original.status,"reconciliation_required");
  const checked=await post("reconcile",{...data,resumeToken:h.opened.resume_token});
  assert.equal(checked.status,200);
  const receipt=await checked.json();
  assert.equal(receipt.status,"completed");
  assert.equal(h.state.effects,1);
});
