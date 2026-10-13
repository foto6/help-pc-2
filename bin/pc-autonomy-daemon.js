#!/usr/bin/env node
import {createRequire} from 'node:module';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {readFileSync, existsSync} from 'node:fs';
import {setTimeout as sleep} from 'node:timers/promises';
import {PcAutonomySupervisor, httpJson, probeBridge, assertConfig, MIN_INTERVAL_MS} from '../src/pc-autonomy-supervisor.js';

const configFlag=(args,key)=>{const i=args.indexOf(key);return i<0?null:args[i+1];};
function absoluteConfig(argv){const name=configFlag(argv,'--config');if(!name)throw new Error('REQUIRED_--config');const p=resolve(name);const cfg=JSON.parse(readFileSync(p,'utf8'));assertConfig(cfg);return {cfg,path:p};}
function readRelayProbe(cfg){
  if(!cfg.relay?.healthFile)return {status:'UNKNOWN',observedAt:''};
  try{
    const raw=JSON.parse(readFileSync(resolve(cfg.relay.healthFile),'utf8'));
    // Owner-provided relay producer snapshot only, not a string supplied by AI.
    const state=String(raw.status||raw.state||'UNKNOWN').toUpperCase();
    const healthy=state==='HEALTHY' && raw.reconciliationRequired===false;
    return {status:healthy?'HEALTHY':'UNKNOWN',observedAt:String(raw.observedAt||raw.updatedAt||'')};
  }catch{return {status:'UNKNOWN',observedAt:''};}
}
function verifyR45Release(cfg){
  const runner=resolve(cfg.r45.runner), manifest=resolve(dirname(runner),'MANIFEST.json');
  if(!existsSync(manifest))throw new Error('R45_VERIFIED_MANIFEST_REQUIRED');
  const m=JSON.parse(readFileSync(manifest,'utf8'));
  if(m?.deployment!=='SHADOW_ONLY'||!/^[a-f0-9]{40}$/i.test(m?.exactSha||'')||
    !m.files||typeof m.files!=='object'||!m.files['autonomy-r45-runner.js'])
    throw new Error('R45_UNVERIFIED_RELEASE');
  if(cfg.r45.sha && cfg.r45.sha!==m.exactSha)throw new Error('R45_SHA_DRIFT');
  for(const [file,sha] of Object.entries(m.files)){
    if(!/^[\w.-]{1,100}$/.test(file)||!/^[a-f0-9]{40}$/i.test(sha))throw new Error('R45_MANIFEST_INVALID');
    const body=readFileSync(resolve(dirname(runner),file));
    const hash=createHash('sha1').update('blob '+body.length+'\0').update(body).digest('hex');
    if(hash!==sha)throw new Error('R45_BLOB_DRIFT_'+file);
  }
  return runner;
}
export async function runCli(argv=process.argv.slice(2),{probes,runner,clock}={}){
  const {cfg}=absoluteConfig(argv);
  const isWatch=argv.includes('--watch');
  if(isWatch && argv.includes('--once'))throw new Error('SELECT_ONCE_OR_WATCH');
  const dispatch=argv.includes('--dispatch');
  if(dispatch && cfg.mode!=='armed')throw new Error('DISPATCH_REQUIRES_ARMED_CONFIG');
  if(dispatch && !argv.includes('--i-accept-real-send'))throw new Error('REAL_SEND_REQUIRES_EXPLICIT_FLAG');
  const source=verifyR45Release(cfg);
  const require=createRequire(import.meta.url);
  const engine=runner || require(source).tick;
  const poll=probes|| (async()=>{
    let snap;
    try{snap=await probeBridge(cfg);}catch(e){snap={bridge:{health:{state:'UNKNOWN'}},cutover:{},operator:{},probeFailure:String(e?.code||'ERROR')}};}
    snap.relay=readRelayProbe(cfg);
    if(snap.probeFailure)throw new Error(snap.probeFailure);
    if(cfg.native?.url){try{snap.native=await httpJson(cfg.native.url,'/v1/health',{token:process.env.PC_NATIVE_TOKEN});}catch{snap.native={status:'UNAVAILABLE'};}}
    return snap;
  });
  const supervisor=new PcAutonomySupervisor({config:cfg,statePath:resolve(cfg.state),probes:poll,clock,runner:async({dispatch:go,brain})=>{
    const plan=JSON.parse(readFileSync(resolve(cfg.r45.plan),'utf8'));
    // One new side effect per coordinator cycle; never dispatch an entire wave
    // before its independently verified task-by-task budget is evaluated.
    const safePlan={...plan,maxParallel:1};
    const observe=async base=>{
      const [health,list,status]=await Promise.all([
        httpJson(base,'/api/health'),
        httpJson(base,'/api/supervisor-watchdog/agent-assignments'),
        httpJson(base,'/api/status'),
      ]);
      const clean=health.state==='OK'&&!(health.reasons||[]).length&&!(health.blockers||[]).length;
      return {health:clean?{...health,state:'HEALTHY'}:health,assignments:list.assignments||[],status};
    };
    return engine({plan:safePlan,stateFile:resolve(cfg.r45.state),base:cfg.bridge.url,dispatch:go,brain,hooks:{observe}});
  }});
  const once=async()=>{const res=await supervisor.cycle({dispatch,brain:cfg.enableBrain===true});process.stdout.write(JSON.stringify(res)+'\n');return res;};
  if(!isWatch)return once();
  const ms=cfg.pollIntervalMs??60000;if(ms<MIN_INTERVAL_MS)throw new Error('INTERVAL_TOO_SHORT');
  let stopping=false;process.once('SIGINT',()=>{stopping=true;});process.once('SIGTERM',()=>{stopping=true;});
  while(!stopping){try{await once();}catch(e){process.stderr.write('pc-autonomy: '+String(e?.code||e?.message||'ERROR').slice(0,160)+'\n');}if(!stopping)await sleep(ms);}
}
if(process.argv[1] && resolve(process.argv[1])===resolve(fileURLToPath(import.meta.url)))runCli().catch(e=>{process.stderr.write(String(e?.message||e)+'\n');process.exitCode=1;});
