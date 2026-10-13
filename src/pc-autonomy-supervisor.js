import {createHash, randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, openSync, writeFileSync, closeSync, readFileSync, renameSync, rmSync} from 'node:fs';
import {dirname, resolve} from 'node:path';

export const CONTRACT='pc.control.autonomy.v1';
export const MIN_INTERVAL_MS=60000;
const CLASSES=new Set(['OK','HEALTHY']);
const STATES=new Set(['observe','armed']);
const asObject=x=>x && typeof x==='object' && !Array.isArray(x)?x:{};
function errorCode(error){return String(error?.code||error?.name||'ERROR').slice(0,80);}
export function digest(value){return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
export function assertConfig(c){
  if(!c || c.contract!==CONTRACT || !STATES.has(c.mode))throw new Error('AUTONOMY_INVALID_CONFIG');
  if(!c.r45 || !resolve(c.r45.runner).endsWith('autonomy-r45-runner.js') || !resolve(c.r45.plan).endsWith('.json') || !c.r45.state)throw new Error('AUTONOMY_INVALID_R45_PATHS');
  if(!c.r45.runner.includes('r45-durable-autonomy') || !c.r45.runner.includes('releases'))throw new Error('AUTONOMY_SHADOW_RELEASE_REQUIRED');
  if(!c.bridge || !['http://127.0.0.1:17448','http://localhost:17448'].includes(c.bridge.url))throw new Error('AUTONOMY_LOOPBACK_BRIDGE_ONLY');
  if(c.mode==='armed' && c.operatorApproved!==true)throw new Error('AUTONOMY_ARM_NOT_APPROVED');
  if(c.allowNewChat===true || c.allowProviderRateBypass===true || c.allowUnsafeReplay===true)throw new Error('AUTONOMY_UNSAFE_OPTIONS');
  if(c.pollIntervalMs!==undefined && (!Number.isInteger(c.pollIntervalMs)||c.pollIntervalMs<MIN_INTERVAL_MS))throw new Error('AUTONOMY_POLL_INTERVAL_TOO_SHORT');
  return c;
}
export function localRead(file,fallback=null){if(!existsSync(file))return structuredClone(fallback);return JSON.parse(readFileSync(file,'utf8'));}
export function atomicWrite(file,body){mkdirSync(dirname(file),{recursive:true});const t=file+'.tmp-'+process.pid+'-'+randomUUID();const fd=openSync(t,'wx',0o600);try{writeFileSync(fd,JSON.stringify(body,null,2)+'\n');}finally{closeSync(fd);}renameSync(t,file);}
export const LOCK_STALE_GRACE_MS=120000;
export function ownerProcessIsDead(pid){
  if(!Number.isSafeInteger(pid)||pid<1)return false;
  try{process.kill(pid,0);return false;}
  catch(e){return e?.code==='ESRCH';}
}
function readLockOwner(dir){
  try{
    const x=JSON.parse(readFileSync(dir+'/owner.json','utf8'));
    if(!Number.isSafeInteger(x?.pid)||x.pid<1||typeof x.nonce!=='string'||!x.nonce
      ||!Number.isFinite(Date.parse(x.at)))return null;
    return x;
  }catch{return null;}
}
export function createLock(file,{now=Date.now(),dead=ownerProcessIsDead}={}){
  const dir=file+'.lock';
  mkdirSync(dirname(dir),{recursive:true});
  const allocate=()=>{
    mkdirSync(dir);
    const owner={pid:process.pid,nonce:randomUUID(),at:new Date().toISOString()};
    try{writeFileSync(dir+'/owner.json',JSON.stringify(owner),{flag:'wx',mode:0o600});}
    catch(e){rmSync(dir,{recursive:true,force:true});throw e;}
    return owner;
  };
  let owner;
  try{owner=allocate();}
  catch(e){
    if(e.code!=='EEXIST')throw e;
    const gate=dir+'.takeover';
    mkdirSync(gate); // Single-winner stale recovery; never steal if another owner is active.
    try{
      const a=readLockOwner(dir);
      const eligible=x=>x && x.pid!==process.pid &&
        now-Date.parse(x.at)>=LOCK_STALE_GRACE_MS &&
        now>=Date.parse(x.at)&&dead(x.pid)===true;
      if(!eligible(a))throw new Error('AUTONOMY_LOCK_BUSY_OR_UNVERIFIED');
      const b=readLockOwner(dir);
      if(!eligible(b)||a.pid!==b.pid||a.nonce!==b.nonce||a.at!==b.at)
        throw new Error('AUTONOMY_LOCK_CHANGED_DURING_RECOVERY');
      // Retain old owner file as an immutable investigation breadcrumb.
      renameSync(dir,dir+'.orphan.'+randomUUID());
      owner=allocate();
    }finally{rmSync(gate,{recursive:true,force:true});}
  }
  let released=false;
  return ()=>{
    if(released)return;
    released=true;
    const current=readLockOwner(dir);
    if(current?.pid===owner.pid && current.nonce===owner.nonce && current.at===owner.at)
      rmSync(dir,{recursive:true,force:true});
  };
}
function isFresh(row,now,ageMs=120000){const stamp=Date.parse(String(row?.observedAt||row?.updatedAt||''));return Number.isFinite(stamp)&&stamp<=now&&now-stamp<=ageMs;}
export function admission({config,bridge={},cutover={},operator={},relay={},now=Date.now()}){
  assertConfig(config);const blocks=[];
  if(config.mode!=='armed')blocks.push('observer_mode');
  if(config.operatorApproved!==true)blocks.push('operator_approval_missing');
  if(!CLASSES.has(bridge.health?.state))blocks.push('bridge_unhealthy');
  if(bridge.health?.blockers?.length || bridge.health?.reasons?.length)blocks.push('bridge_health_reasons_present');
  if(cutover?.cutoverState?.holdActive!==false)blocks.push('r42_cutover_hold');
  if(!['RUNNING','RUNNING_MANAGED'].includes(operator.mode))blocks.push('operator_not_running');
  if(operator.queuePaused!==false)blocks.push('queue_paused_or_unknown');
  if(operator.reconciliationRequired!==false)blocks.push('operator_reconciliation_unknown');
  if(operator.allowAutonomousSend!==true)blocks.push('autonomous_send_disabled');
  if(!relay || relay.status!=='HEALTHY'|| !isFresh(relay,now,120000))blocks.push('pc_control_relay_unverified');
  if(config.maxSendsPerHour!==undefined && (!Number.isInteger(config.maxSendsPerHour)||config.maxSendsPerHour<1||config.maxSendsPerHour>60))blocks.push('invalid_send_budget');
  return {ready:blocks.length===0,blocks};
}
export function budgetCheck(state,now,max=12,minSpacingMs=90000){const history=(Array.isArray(state?.sends)?state.sends:[]).filter(x=>now-x<3600000&&x<=now);return {allowed:history.length<max && (!history.length || now-history.at(-1)>=minSpacingMs),history};}
export function cooldownFor(result,now){if(result?.status==='RECONCILIATION_REQUIRED' || result?.status==='CHAT_INSPECTION_FAILED'||result?.status==='DISPATCH_UNKNOWN')return now+300000;if(result?.status==='CUTOVER_BLOCKED'||result?.status==='BRIDGE_UNHEALTHY')return now+120000;if(/429|RATE_LIMIT/i.test(JSON.stringify(result||{})))return now+1800000;return 0;}
function normalizeStore(x){const s=asObject(x);return {contract:CONTRACT,revision:(s.revision||0),sends:Array.isArray(s.sends)?s.sends:[],lastCycle:s.lastCycle||null,lastDecision:s.lastDecision||null,cooldownUntil:Number(s.cooldownUntil||0),pendingUnknown:Array.isArray(s.pendingUnknown)?s.pendingUnknown:[],pendingDispatch:s.pendingDispatch??null};}
export class PcAutonomySupervisor{
  constructor({config,statePath,probes,runner,clock=Date.now}){this.config=assertConfig(config);this.statePath=statePath;this.probes=probes;this.runner=runner;this.clock=clock;}
  async cycle({dispatch=false,brain=false}={}){
    const unlock=createLock(this.statePath);
    try {
      const now=this.clock(),s=normalizeStore(localRead(this.statePath,{}));
      let probes;
      try{probes=await this.probes();}catch(e){probes={error:errorCode(e)};}
      const policy=admission({config:this.config,bridge:probes.bridge,cutover:probes.cutover,operator:probes.operator,relay:probes.relay,now});
      if(probes.error)policy.blocks.push('probe_failed_'+probes.error);
      if(s.pendingUnknown.length)policy.blocks.push('unknown_effect_reconciliation_required');
      // A crash while R45 was being called is not evidence of a failed Send.
      // Retain the original transaction until exact assignment evidence is reconciled.
      if(s.pendingDispatch!==null)policy.blocks.push('unresolved_dispatch_intent');
      if(s.cooldownUntil>now)policy.blocks.push('cooldown_active');
      const budget=budgetCheck(s,now,this.config.maxSendsPerHour||12,this.config.minSpacingMs||90000);
      if(!budget.allowed)policy.blocks.push('send_rate_budget');
      policy.ready=policy.blocks.length===0;
      const authorizedDispatch=dispatch===true&&policy.ready;
      if(authorizedDispatch){
        // Write-ahead reservation BEFORE invoking R45 and any provider-side effect.
        // A hard process crash can no longer lose the inter-Send rate budget or
        // accidentally re-admit another dispatch on restart.
        s.sends=[...budget.history,now].slice(-60);
        s.pendingDispatch={at:new Date(now).toISOString(),token:randomUUID(),status:'AWAITING_R45_RESULT'};
        atomicWrite(this.statePath,s);
      }else{
        s.sends=budget.history;
      }
      let result;
      // Local-only Ollama proposals may advance while provider Send is held.
      // They cannot open a ChatGPT tab or override the PC Control gates.
      const localBrain=brain===true&&this.config.enableBrain===true&&s.pendingUnknown.length===0;
      try{result=await this.runner({dispatch:authorizedDispatch,brain:localBrain});}
      catch(e){result={status:authorizedDispatch?'DISPATCH_UNKNOWN':'COORDINATOR_ERROR',code:errorCode(e),dispatched:[]};}
      const emitted=Array.isArray(result?.dispatched)?result.dispatched:[];
      const unresolvedR45=Array.isArray(result?.reconciliationRequired)
        && result.reconciliationRequired.length>0;
      const uncertain=authorizedDispatch && (
        !result||typeof result.status!=='string'
        || result.status==='DISPATCH_UNKNOWN'
        || result.status==='RECONCILIATION_REQUIRED'
        || unresolvedR45 || emitted.length>1
      );
      if(uncertain){
        s.pendingUnknown.push('r45_original_dispatch_journal');
        // Preserve original token: never try to replay a timed-out request.
      }else if(authorizedDispatch){
        s.pendingDispatch=null;
      }
      s.pendingUnknown=[...new Set(s.pendingUnknown)];
      s.cooldownUntil=Math.max(s.cooldownUntil,cooldownFor(result,now));
      s.revision++;
      s.lastCycle=new Date(now).toISOString();
      s.lastDecision={admitted:authorizedDispatch,blocks:policy.blocks,status:String(result?.status||'UNKNOWN'),dispatched:emitted.length,probeError:probes.error||null,uncertainEffect:uncertain};
      atomicWrite(this.statePath,s);
      return {contract:CONTRACT,revision:s.revision,at:s.lastCycle,dispatchEnabled:authorizedDispatch,decision:s.lastDecision,cooldownUntil:s.cooldownUntil,unknownEffects:s.pendingUnknown.length,taskCounts:result?.counts||{},bridgeHealth:String(probes.bridge?.health?.state||'UNKNOWN')};
    } finally{unlock();}
  }
}
export function assignmentLedgerSafety(payload) {
  const rows=payload?.assignments;
  if(!Array.isArray(rows))return {safe:false,reason:'missing_assignment_ledger',unknownCount:1};
  const seen=new Set();
  let historicFailed=0,active=0,unknown=0,queued=0;
  for(const row of rows) {
    if(!row||typeof row.id!=='string'||!row.id||seen.has(row.id)) {
      unknown++;continue;
    }
    seen.add(row.id);
    const state=String(row.state||'');
    if(state==='queued'){
      queued++;
      if(row.dispatchSubmitAttempted!==false
        || Number(row.dispatchCount||0)!==0)unknown++;
    }else if(['dispatching','running','awaiting_evidence'].includes(state)){
      active++;unknown++;
    }else if(['completed','cancelled','blocked','failed'].includes(state)){
      if(['blocked','failed'].includes(state))historicFailed++;
      if(row.dispatchSubmitAttempted===true
         && !row.dispatchFingerprint)unknown++;
    }else unknown++;
  }
  return {safe:unknown===0,reason:unknown?'unreconciled_assignments':'ledger_reconciled',
    unknownCount:unknown,queued,active,historicFailed,total:rows.length};
}
export async function httpJson(origin,route,{timeoutMs=5000,token,maxChars=500000}={}){const u=new URL(origin);if(u.protocol!=='http:'||!['127.0.0.1','localhost'].includes(u.hostname)||u.username||u.password||u.pathname!=='/'||u.search)throw new Error('LOCAL_ONLY');const r=await fetch(u.origin+route,{redirect:'error',signal:AbortSignal.timeout(timeoutMs),headers:{Accept:'application/json',...(token?{Authorization:'Bearer '+token}:{})}});if(!r.ok)throw Object.assign(new Error('HTTP_'+r.status),{code:'HTTP_'+r.status});const text=await r.text();if(text.length>maxChars)throw new Error('OVERSIZED_RESPONSE');return JSON.parse(text);}
export async function probeBridge(config){
  const u=config.bridge.url;
  const [health,cutover,operator,supervisor,assignments]=await Promise.all([
    httpJson(u,'/api/health'),
    httpJson(u,'/api/projects/control-plane/cutover-r42/status'),
    httpJson(u,'/api/operator-lifecycle'),
    httpJson(u,'/api/supervisor-watchdog?detect=0'),
    httpJson(u,'/api/supervisor-watchdog/agent-assignments',{timeoutMs:7000,maxChars:2000000}),
  ]);
  const p=asObject(operator),ledger=assignmentLedgerSafety(assignments);
  return {
    bridge:{health,ledger:{safe:ledger.safe,reason:ledger.reason,unknownCount:ledger.unknownCount,
      queued:ledger.queued,active:ledger.active,historicFailed:ledger.historicFailed}},
    cutover,
    operator:{
      mode:p.mode||null,
      queuePaused:p.queuePaused,
      allowAutonomousSend:supervisor?.config?.allowAutonomousSend===true,
      // R49 operator lifecycle has no reconciliationRequired field.
      // Never assume absent === false; use the exact independent assignment ledger.
      reconciliationRequired:p.reconciliationRequired===true || ledger.safe!==true,
    },
  };
}
