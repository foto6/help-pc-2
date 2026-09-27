export const GATEWAY_VERSION = "pc_ops.gateway.v1";
export const CURRENT_RELAY_BASELINE = Object.freeze([
  "capabilities.get", "shell.run", "windows.list", "screenshot.capture",
  "uia.snapshot", "uia.inspect", "clipboard.get", "action.preflight", "outcome.lookup",
]);
const DEFINITIONS = [
  ["health.get","Read gateway, relay and producer health without causing a PC effect."],
  ["capabilities.get","Read Executor capabilities and policy limits."],
  ["shell.run","Fallback bounded command execution; prefer structured file, log and process tools."],
  ["shell.session.start","Start a durable long-running shell session."],
  ["shell.session.read","Read shell-session output from a cursor."],
  ["shell.session.write_stdin","Write bounded stdin to a managed shell session."],
  ["shell.session.terminate","Terminate a managed shell session."],
  ["fs.list","List a directory with bounded result count."],["fs.stat","Read file or directory metadata."],
  ["fs.read_text","Read bounded UTF-8 text by line/range and byte limits."],["fs.read_bytes","Read bounded bytes encoded as base64."],
  ["fs.hash","Compute a file digest without returning file contents."],["fs.find","Find or glob paths with a bounded result count."],
  ["fs.write_text","Write text with expected-current-hash, create-only or overwrite semantics."],
  ["fs.append_text","Append bounded text through Executor policy."],["fs.mkdir","Create a directory through Executor policy."],
  ["fs.copy","Copy a path through Executor policy."],["fs.move","Move a path through Executor policy."],
  ["fs.delete","Delete only with explicit policy classification; protected paths always fail closed."],
  ["log.tail","Read a bounded tail of a log file."],["log.read_since","Read bounded log records since a cursor or timestamp."],
  ["log.search","Search logs with bounded matches and output."],["process.list","List processes with bounded fields and result count."],
  ["process.inspect","Inspect one process without changing it."],["process.start","Start one durable managed process exactly once per operation identity."],
  ["process.status","Read managed-process status."],["process.read_output","Read managed-process output from a cursor."],
  ["process.terminate","Terminate a managed process through policy."],["windows.list","List visible top-level windows."],
  ["screenshot.capture","Capture an observation through the existing Executor/Vision stack."],
  ["uia.snapshot","Capture a bounded UI Automation snapshot."],["uia.inspect","Inspect a UI Automation element."],
  ["uia.invoke","Invoke a UI Automation element through preflight/context binding."],
  ["uia.focus","Focus a UI Automation element through preflight/context binding."],
  ["uia.set_value","Set a UI Automation value through preflight/context binding."],
  ["clipboard.get","Read clipboard content subject to Executor policy."],["clipboard.set","Set clipboard content subject to Executor policy."],
  ["action.preflight","Run the Executor read-only preflight contract."],["outcome.lookup","Read durable Executor outcome evidence for reconciliation."],
  ["system.info","Read bounded operating-system and host information."],["system.resources","Read bounded CPU, memory, disk and runtime resource information."],
];
const READ_ONLY = new Set(["health.get","capabilities.get","fs.list","fs.stat","fs.read_text","fs.read_bytes","fs.hash","fs.find","log.tail","log.read_since","log.search","process.list","process.inspect","process.status","process.read_output","windows.list","screenshot.capture","uia.snapshot","uia.inspect","clipboard.get","action.preflight","outcome.lookup","system.info","system.resources","shell.session.read"]);
const HIGH = new Set(["fs.delete"]), MEDIUM = new Set(["process.terminate","shell.session.terminate"]);
const START = new Set(["process.start","shell.session.start"]), CURSOR = new Set(["process.read_output","shell.session.read","log.tail","log.read_since"]);
const BASELINE = new Set(CURRENT_RELAY_BASELINE);
function schemaFor(name) {
  const object=(properties={},required=undefined,additionalProperties=false)=>({type:"object",additionalProperties,properties,...(required?.length?{required}:{})});
  const str={type:"string"}, operation={type:"string",minLength:1,maxLength:80};
  if (["health.get","capabilities.get","system.info"].includes(name)) return object();
  if (name==="shell.run") return object({argv:{type:"array",minItems:1,maxItems:128,items:{type:"string"}},cwd:{type:["string","null"]}},["argv"],true);
  if (name==="shell.session.start") return object({operation_id:operation,argv:{type:"array",minItems:1,maxItems:128,items:{type:"string"}},cwd:{type:["string","null"]},env:{type:"object"},inherit_env:{type:"boolean"},output_limit_bytes:{type:"integer",minimum:1024,maximum:268435456}},["operation_id","argv"]);
  if (name==="shell.session.read") return object({operation_id:operation,cursor:{type:["object","null"]},max_bytes:{type:"integer",minimum:1,maximum:65536},wait_ms:{type:"integer",minimum:0,maximum:2000}},["operation_id"]);
  if (name==="shell.session.write_stdin") return object({operation_id:operation,data:{type:"string",maxLength:65536},append_newline:{type:"boolean"}},["operation_id","data"]);
  if (name==="shell.session.terminate") return object({operation_id:operation,grace_ms:{type:"integer",minimum:0,maximum:5000}},["operation_id"]);
  if (name==="fs.list") return object({path:str,max_entries:{type:"integer",minimum:1,maximum:500},include_hidden:{type:"boolean"}},["path"]);
  if (name==="fs.stat") return object({path:str},["path"]);
  if (name==="fs.read_text") return object({path:str,encoding:{type:"string"},start_line:{type:"integer",minimum:1},end_line:{type:["integer","null"],minimum:1},max_bytes:{type:"integer",minimum:1,maximum:1048576}},["path"]);
  if (name==="fs.read_bytes") return object({path:str,offset:{type:"integer",minimum:0},max_bytes:{type:"integer",minimum:1,maximum:1048576}},["path"]);
  if (name==="fs.hash") return object({path:str,max_bytes:{type:"integer",minimum:1,maximum:1073741824}},["path"]);
  if (name==="fs.find") return object({path:str,name_contains:{type:["string","null"],maxLength:512},max_results:{type:"integer",minimum:1,maximum:500},max_depth:{type:"integer",minimum:0,maximum:32}},["path"]);
  if (name==="fs.write_text") return object({path:str,text:{type:"string"},encoding:{type:"string"},expected_current_hash:{type:["string","null"],pattern:"^[0-9a-f]{64}$"},create_only:{type:"boolean"},overwrite:{type:"boolean"}},["path","text"]);
  if (name==="fs.append_text") return object({path:str,text:{type:"string"},encoding:{type:"string"},expected_current_hash:{type:["string","null"],pattern:"^[0-9a-f]{64}$"},create:{type:"boolean"}},["path","text"]);
  if (name==="fs.mkdir") return object({path:str,parents:{type:"boolean"},exist_ok:{type:"boolean"}},["path"]);
  if (["fs.copy","fs.move"].includes(name)) return object({source:str,destination:str,overwrite:{type:"boolean"},expected_source_hash:{type:["string","null"],pattern:"^[0-9a-f]{64}$"}},["source","destination"]);
  if (name==="fs.delete") return object({path:str,classification:{enum:["file","empty_directory"]},expected_current_hash:{type:["string","null"],pattern:"^[0-9a-f]{64}$"}},["path","classification"]);
  if (name==="log.tail") return object({path:str,encoding:{type:"string"},max_lines:{type:"integer",minimum:1,maximum:2000},max_bytes:{type:"integer",minimum:1,maximum:1048576}},["path"]);
  if (name==="log.read_since") return object({path:str,encoding:{type:"string"},cursor:{type:["object","null"]},max_bytes:{type:"integer",minimum:1,maximum:1048576}},["path"]);
  if (name==="log.search") return object({path:str,pattern:{type:"string",minLength:1,maxLength:512},regex:{type:"boolean"},case_sensitive:{type:"boolean"},encoding:{type:"string"},max_matches:{type:"integer",minimum:1,maximum:500},max_bytes:{type:"integer",minimum:1,maximum:1048576}},["path","pattern"]);
  if (name==="process.list") return object({pid:{type:["integer","null"],minimum:1},name_contains:{type:["string","null"],maxLength:256},max_results:{type:"integer",minimum:1,maximum:500}});
  if (name==="process.inspect") return object({pid:{type:"integer",minimum:1}},["pid"]);
  if (name==="process.start") return object({operation_id:{type:["string","null"],minLength:1,maxLength:80},argv:{type:"array",minItems:1,maxItems:128,items:{type:"string"}},cwd:{type:["string","null"]},env:{type:"object"},inherit_env:{type:"boolean"},output_limit_bytes:{type:"integer",minimum:1024,maximum:268435456}},["argv"]);
  if (name==="process.status") return object({operation_id:operation},["operation_id"]);
  if (name==="process.read_output") return object({operation_id:operation,cursor:{type:["object","null"]},max_bytes:{type:"integer",minimum:1,maximum:65536},wait_ms:{type:"integer",minimum:0,maximum:2000}},["operation_id"]);
  if (name==="process.terminate") return object({operation_id:operation,grace_ms:{type:"integer",minimum:0,maximum:5000}},["operation_id"]);
  if (name==="system.resources") return object({path:{type:["string","null"]}});
  return object({},undefined,true);
}
function metadata(name,description) {
  const readOnly=READ_ONLY.has(name);
  return Object.freeze({
    name,description,input_schema:schemaFor(name),access:readOnly?"read_only":"effectful",
    destructive_level:HIGH.has(name)?"high":MEDIUM.has(name)?"medium":readOnly?"none":"mutating",
    preflight:readOnly||name==="health.get"?"not_required":"required",
    restart_semantics:START.has(name)?"no_duplicate_start":CURSOR.has(name)?"cursor_resume":readOnly?"repeatable":"reconcile_before_replay",
    output_limit_bytes:name==="screenshot.capture"?524288:name==="fs.read_bytes"?1048576:65536,
    scope:/^(windows\.|screenshot\.|uia\.|clipboard\.)/.test(name)?"desktop":name==="health.get"?"gateway":"system",
    shell_fallback:name==="shell.run",preferred_structured:name!=="shell.run",
    producer_requirement:name==="health.get"?"gateway.local.v1":BASELINE.has(name)?"pc_relay.baseline.v2":"pc_relay.structured_ops.v1",
  });
}
export const TOOL_CATALOG=Object.freeze(DEFINITIONS.map(([name,description])=>metadata(name,description)));
export function getToolMetadata(name){return TOOL_CATALOG.find((tool)=>tool.name===name)??null;}
export function toolManifest(){return {version:GATEWAY_VERSION,selection_policy:{structured_before_shell:true,shell_run_role:"fallback"},tools:TOOL_CATALOG.map((x)=>structuredClone(x))};}
