'use strict';

const crypto = require('node:crypto');
const {
  queueQuiescence,
  validateDurableState,
} = require('./cutover-r23');

const SCHEMA = 'bridge.r24_live_preflight.v1';
const R23_SOURCE_SHA = 'dac4dd0edd35cdbf96d5c03344acd94f899a6aba';
const R23_BRANCH = 'agent/bridge-r23-cutover-rehearsal-20261001';

function clean(value,limit=1000){
  return String(value??'').replace(/\s+/g,' ').trim().slice(0,limit);
}

function iso(value=Date.now()){
  return new Date(value).toISOString();
}

function sha256(value){
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hex(value,n){
  return new RegExp('^[0-9a-f]{'+n+'}$','i').test(clean(value,n+10));
}

function clone(value){
  return value===undefined?undefined:JSON.parse(JSON.stringify(value));
}

function observation({
  source,
  state='UNKNOWN',
  observedAt='',
  budgetMs=null,
  reason='',
  data={},
}={}){
  return {
    source:clean(source,240),
    state:['PASS','DEGRADED','BLOCK','UNKNOWN'].includes(state)?state:'UNKNOWN',
    observedAt:clean(observedAt,80),
    budgetMs:Number.isFinite(Number(budgetMs))?Number(budgetMs):null,
    reason:clean(reason,500),
    data:clone(data)||{},
  };
}

function gate(id,observationValue,pass,reason){
  const source=observationValue||observation({});
  if(source.state==='UNKNOWN'){
    return {
      id,state:'UNKNOWN',ok:false,
      reason:source.reason||clean(reason,500)||'observation_unknown',
      source:source.source,
      observedAt:source.observedAt,
      evidence:clone(source.data)||{},
    };
  }
  const ok=Boolean(pass);
  return {
    id,
    state:ok?'PASS':(source.state==='DEGRADED'?'DEGRADED':'BLOCK'),
    ok,
    reason:ok?'verified':clean(reason||source.reason,500),
    source:source.source,
    observedAt:source.observedAt,
    evidence:clone(source.data)||{},
  };
}

function summarizeQueueFromStatus(status={}){
  const tasks=Array.isArray(status.tasks)?status.tasks:null;
  const assignments=Array.isArray(status.agentAssignments)?status.agentAssignments:null;
  const outbox=Array.isArray(status.outbox)?status.outbox:null;
  if(!tasks||!assignments||!outbox){
    return {
      observable:false,
      quiescent:false,
      activeTasks:null,
      activeAssignments:null,
      activeOutbox:null,
    };
  }
  const queue=queueQuiescence({
    tasks,
    agentAssignments:assignments,
    outbox,
  });
  return {
    observable:true,
    quiescent:queue.quiescent,
    activeTaskCount:queue.activeTasks.length,
    activeAssignmentCount:queue.activeAssignments.length,
    activeOutboxCount:queue.activeOutbox.length,
    activeTaskIds:queue.activeTasks.slice(0,50),
    activeAssignmentIds:queue.activeAssignments.slice(0,50),
    activeOutboxIds:queue.activeOutbox.slice(0,50),
  };
}

function summarizeStatus(status={},receivedAtMs=Date.now(),maxAgeMs=5000){
  const generatedMs=Date.parse(status.generatedAt||'')||0;
  const ageMs=generatedMs?Math.max(0,receivedAtMs-generatedMs):null;
  const operational=status.operational||status.health||{};
  return {
    controlPlaneResponsive:status.controlPlaneResponsive===true,
    generatedAt:clean(status.generatedAt,80),
    generatedAgeMs:ageMs,
    generatedFresh:Boolean(generatedMs&&ageMs<=maxAgeMs),
    operationalState:clean(operational.state||'',40),
    operationalOk:operational.ok===true,
    blockers:Array.isArray(operational.blockers)
      ? operational.blockers.map(value=>clean(value,300)).slice(0,50)
      : [],
    degraded:Array.isArray(operational.degraded)
      ? operational.degraded.map(value=>clean(value,300)).slice(0,50)
      : [],
    codeReloadRequired:operational.codeReload?.required,
    codeReloadReason:clean(operational.codeReload?.reason,300),
    browserConnected:status.browser?.connected===true,
    browserLastSeenAt:clean(status.browser?.lastSeenAt,80),
    queue:summarizeQueueFromStatus(status),
    aiProfiles:(Array.isArray(status.aiProfiles)?status.aiProfiles:[])
      .filter(row=>row?.provider==='chatgpt'&&row?.enabled!==false)
      .map(row=>({
        id:clean(row.id,120),
        debugPort:Number(row.debugPort||0),
      }))
      .filter(row=>row.id),
  };
}

function summarizeHealth(health={},receivedAtMs=Date.now(),maxAgeMs=5000){
  const checkedMs=Date.parse(health.checkedAt||'')||0;
  const ageMs=checkedMs?Math.max(0,receivedAtMs-checkedMs):null;
  return {
    checkedAt:clean(health.checkedAt,80),
    checkedAgeMs:ageMs,
    checkedFresh:Boolean(checkedMs&&ageMs<=maxAgeMs),
    state:clean(health.state||'',40),
    ok:health.ok===true,
    reasons:Array.isArray(health.reasons)
      ? health.reasons.map(value=>clean(value,300)).slice(0,50)
      : [],
    eventLoopState:clean(health.eventLoop?.state,40),
    eventLoopAgeMs:Number.isFinite(Number(health.eventLoop?.ageMs))
      ? Number(health.eventLoop.ageMs)
      : null,
    maintenanceState:clean(health.components?.maintenance?.state,40),
    assignmentMaintenanceState:clean(
      health.components?.assignment_maintenance?.state,40),
    browserCdpState:clean(health.components?.browser_cdp?.state,40),
    browserCdpAgeMs:Number.isFinite(Number(health.components?.browser_cdp?.ageMs))
      ? Number(health.components.browser_cdp.ageMs)
      : null,
    codeReloadRequired:health.codeReload?.required,
    codeReloadReason:clean(health.codeReload?.reason,300),
  };
}

function r23ManifestBinding(value={}){
  const manifest=value?.manifest||value;
  if(!manifest||manifest.object!=='bridge.r23_candidate_manifest'){
    return {
      valid:false,
      reason:'r23_manifest_missing_or_wrong_object',
      digest:'',
      sourceSha:'',
      sourceBranch:'',
    };
  }
  const digest=clean(manifest.digest,100);
  return {
    valid:hex(digest,64)
      && clean(manifest.sourceSha,80).toLowerCase()===R23_SOURCE_SHA
      && clean(manifest.sourceBranch,300)===R23_BRANCH,
    reason:hex(digest,64)
      ? 'manifest_digest_present'
      : 'manifest_digest_invalid',
    digest,
    sourceSha:clean(manifest.sourceSha,80),
    sourceBranch:clean(manifest.sourceBranch,300),
    releaseGate:clean(manifest.releaseGate,80),
  };
}

function evaluateLivePreflight(input={}){
  const obs=input.observations||{};
  const expectations=input.expectations||{};
  const gates=[];

  const processObs=obs.processIdentity||observation({});
  const processData=processObs.data||{};
  const expectedPid=Number(expectations.pid||0);
  const expectedFingerprint=clean(expectations.commandFingerprint,100);
  const processPass=expectedPid>0
    && Number(processData.pid)===expectedPid
    && hex(expectedFingerprint,64)
    && clean(processData.commandFingerprint,100)===expectedFingerprint
    && processData.ambiguous!==true;
  gates.push(gate(
    'process_identity',
    processObs,
    processPass,
    expectedPid&&expectedFingerprint
      ? 'process_identity_mismatch_or_ambiguous'
      : 'expected_process_identity_missing'));

  const sourceObs=obs.sourceProvenance||observation({});
  const sourceData=sourceObs.data||{};
  const expectedSha=clean(expectations.sourceSha,80).toLowerCase();
  const expectedBranch=clean(expectations.sourceBranch,300);
  const sourcePass=hex(expectedSha,40)
    && expectedBranch
    && clean(sourceData.sha,80).toLowerCase()===expectedSha
    && clean(sourceData.branch,300)===expectedBranch;
  gates.push(gate(
    'source_provenance',
    sourceObs,
    sourcePass,
    expectedSha&&expectedBranch
      ? 'source_sha_or_branch_mismatch'
      : 'expected_source_provenance_missing'));

  const configObs=obs.configProvenance||observation({});
  const configData=configObs.data||{};
  const expectedConfig=clean(expectations.configDigest,100);
  const configPass=hex(expectedConfig,64)
    && clean(configData.digest,100)===expectedConfig;
  gates.push(gate(
    'config_provenance',
    configObs,
    configPass,
    expectedConfig
      ? 'config_digest_mismatch'
      : 'expected_config_digest_missing'));

  const portObs=obs.portOwnership||observation({});
  const portData=portObs.data||{};
  const expectedPort=Number(expectations.port||0);
  const portPass=expectedPort>0
    && Number(portData.port)===expectedPort
    && portData.listening===true
    && portData.ambiguous!==true
    && Number(portData.ownerPid)===expectedPid;
  gates.push(gate(
    'port_ownership',
    portObs,
    portPass,
    expectedPort&&expectedPid
      ? 'port_owner_mismatch_or_ambiguous'
      : 'expected_port_or_pid_missing'));

  const statusObs=obs.status||observation({});
  const statusData=statusObs.data||{};
  const statusPass=statusObs.state==='PASS'
    && statusData.responded===true
    && Number(statusData.latencyMs)<=Number(statusData.budgetMs||500)
    && statusData.summary?.controlPlaneResponsive===true
    && statusData.summary?.generatedFresh===true
    && statusData.summary?.operationalState==='OK'
    && statusData.summary?.codeReloadRequired===false;
  gates.push(gate(
    'status_responsiveness',
    statusObs,
    statusPass,
    'status_timeout_stale_degraded_or_reload_required'));

  const healthObs=obs.health||observation({});
  const healthData=healthObs.data||{};
  const healthPass=healthObs.state==='PASS'
    && healthData.responded===true
    && Number(healthData.latencyMs)<=Number(healthData.budgetMs||500)
    && healthData.summary?.checkedFresh===true
    && healthData.summary?.state==='OK'
    && healthData.summary?.eventLoopState==='healthy'
    && healthData.summary?.codeReloadRequired===false;
  gates.push(gate(
    'health_responsiveness',
    healthObs,
    healthPass,
    'health_timeout_stale_degraded_or_reload_required'));

  const queueObs=obs.queue||observation({});
  const queueData=queueObs.data||{};
  const queuePass=queueObs.state==='PASS'
    && queueData.observable===true
    && queueData.quiescent===true
    && Number(queueData.activeTaskCount||0)===0
    && Number(queueData.activeAssignmentCount||0)===0
    && Number(queueData.activeOutboxCount||0)===0;
  gates.push(gate(
    'queue_quiescence',
    queueObs,
    queuePass,
    queueData.observable===false
      ? 'queue_observability_incomplete'
      : 'pending_or_inflight_work'));

  const cdpObs=obs.cdp||observation({});
  const cdpData=cdpObs.data||{};
  const cdpProfiles=Array.isArray(cdpData.profiles)?cdpData.profiles:[];
  const cdpRequired=cdpData.required!==false;
  const cdpPass=!cdpRequired || (
    cdpObs.state==='PASS'
    && cdpProfiles.length>0
    && cdpProfiles.every(row=>
      row.responded===true
      && Number(row.latencyMs)<=Number(row.budgetMs||1000)
      && row.errorClass===''
    )
  );
  gates.push(gate(
    'cdp_readonly_probe',
    cdpObs,
    cdpPass,
    'cdp_timeout_error_or_unobservable'));

  const durableObs=obs.durableState||observation({});
  const durableData=durableObs.data||{};
  const durablePass=durableObs.state==='PASS'
    && durableData.readable===true
    && durableData.valid===true
    && Number(durableData.version)===13
    && hex(durableData.digest,64);
  gates.push(gate(
    'durable_state',
    durableObs,
    durablePass,
    'durable_state_unreadable_corrupt_or_schema_invalid'));

  const manifestObs=obs.r23Manifest||observation({});
  const manifestData=manifestObs.data||{};
  const manifestPass=manifestObs.state==='PASS'
    && manifestData.valid===true
    && hex(manifestData.digest,64)
    && manifestData.sourceSha===R23_SOURCE_SHA;
  gates.push(gate(
    'r23_candidate_manifest',
    manifestObs,
    manifestPass,
    'r23_candidate_manifest_unverified'));

  const nonPass=gates.filter(row=>!row.ok);
  const degraded=nonPass.filter(row=>row.state==='DEGRADED');
  const unknown=nonPass.filter(row=>row.state==='UNKNOWN');
  const blocked=nonPass.filter(row=>row.state==='BLOCK');
  const decision=blocked.length||unknown.length
    ? 'BLOCKED'
    : degraded.length
      ? 'DEGRADED'
      : 'READY_FOR_EXPLICIT_CUTOVER';

  return {
    schema:SCHEMA,
    object:SCHEMA,
    collectedAt:clean(input.collectedAt||iso(),80),
    candidate:{
      r23SourceSha:R23_SOURCE_SHA,
      r23SourceBranch:R23_BRANCH,
      r23ManifestSha256:clean(manifestData.digest,100),
    },
    budgets:clone(input.budgets)||{},
    expectations:{
      pid:expectedPid||null,
      commandFingerprint:hex(expectedFingerprint,64)?expectedFingerprint:'',
      port:expectedPort||null,
      sourceSha:hex(expectedSha,40)?expectedSha:'',
      sourceBranch:expectedBranch,
      configDigest:hex(expectedConfig,64)?expectedConfig:'',
    },
    observations:clone(obs)||{},
    gates,
    decision,
    releaseGate:'NO_LIVE_DEPLOY',
    readyForExplicitCutover:decision==='READY_FOR_EXPLICIT_CUTOVER',
    blockers:nonPass.map(row=>({
      gate:row.id,
      state:row.state,
      reason:row.reason,
    })),
    safety:{
      readOnly:true,
      methodsAllowed:['GET'],
      providerMutationPerformed:false,
      bridgeMutationPerformed:false,
      processMutationPerformed:false,
      filesWrittenByCollector:false,
      tabsCreated:false,
      conversationsCreated:false,
      assignmentsDispatched:false,
      migrationsApplied:false,
      secretsIncluded:false,
    },
    stoppingRules:[
      'STOP if any required observation is UNKNOWN, ambiguous, stale, over budget, DEGRADED or BLOCKED.',
      'STOP unless process PID and command fingerprint both exactly match coordinator expectations.',
      'STOP unless the expected listening port has one unambiguous owner equal to the exact expected PID.',
      'STOP unless source SHA/branch and config digest match explicit coordinator expectations.',
      'STOP unless /api/status and /api/health both respond within budget and report fresh operational OK with code_reload_required=false.',
      'STOP with any queued/in-flight assignment, task or outbox side effect.',
      'STOP unless every required ChatGPT profile has a bounded read-only CDP /json/list response.',
      'STOP on unreadable/corrupt/wrong-schema durable state.',
      'STOP unless the R23 candidate manifest digest and source binding are exact.',
      'NEVER kill, restart, stop, repoint, migrate, dispatch or create a tab/chat from this collector.',
    ],
  };
}

function strictStateSummary(raw){
  let state;
  try{
    state=JSON.parse(raw);
  }catch(error){
    return {
      readable:true,
      valid:false,
      version:null,
      digest:sha256(raw),
      validationErrors:['invalid_json'],
      parseErrorClass:'INVALID_JSON',
      queue:{observable:false,quiescent:false},
    };
  }
  const validation=validateDurableState(state);
  const queue=queueQuiescence(state);
  return {
    readable:true,
    valid:validation.ok,
    version:Number(state.version),
    digest:sha256(raw),
    validationErrors:validation.errors.slice(0,100),
    parseErrorClass:'',
    counts:{
      aiProfiles:Array.isArray(state.aiProfiles)?state.aiProfiles.length:null,
      chats:Array.isArray(state.chats)?state.chats.length:null,
      tasks:Array.isArray(state.tasks)?state.tasks.length:null,
      assignments:Array.isArray(state.agentAssignments)?state.agentAssignments.length:null,
      outbox:Array.isArray(state.outbox)?state.outbox.length:null,
      lifecycleAudit:Array.isArray(state.chatLifecycleAudit)?state.chatLifecycleAudit.length:null,
      deleteAttempts:Array.isArray(state.chatDeleteAttempts)?state.chatDeleteAttempts.length:null,
    },
    queue:{
      observable:true,
      quiescent:queue.quiescent,
      activeTaskCount:queue.activeTasks.length,
      activeAssignmentCount:queue.activeAssignments.length,
      activeOutboxCount:queue.activeOutbox.length,
    },
  };
}

module.exports={
  R23_BRANCH,
  R23_SOURCE_SHA,
  SCHEMA,
  clean,
  evaluateLivePreflight,
  observation,
  r23ManifestBinding,
  sha256,
  strictStateSummary,
  summarizeHealth,
  summarizeQueueFromStatus,
  summarizeStatus,
};
