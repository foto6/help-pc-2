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
  const properties = {}, required = [];
  if (/^(fs\.|log\.)/.test(name)) { properties.path={type:"string",minLength:1}; required.push("path"); }
  if (["fs.copy","fs.move"].includes(name)) { properties.destination={type:"string",minLength:1}; required.push("destination"); }
  if (["fs.write_text","fs.append_text"].includes(name)) properties.text={type:"string"};
  if (name==="fs.write_text") { properties.expected_current_hash={type:["string","null"],pattern:"^[0-9a-f]{64}$"}; properties.create_only={type:"boolean"}; properties.overwrite={type:"boolean"}; }
  if (name==="shell.run" || name==="process.start") { properties.argv={type:"array",minItems:1,items:{type:"string"}}; required.push("argv"); }
  if (name.startsWith("shell.session.") || ["process.status","process.read_output","process.terminate"].includes(name)) { properties.operation_id={type:"string",minLength:1,maxLength:80}; required.push("operation_id"); }
  if (name==="shell.session.write_stdin") { properties.data={type:"string"}; required.push("data"); }
  properties.limit={type:"integer",minimum:1,maximum:10000};
  return {type:"object",additionalProperties:true,properties,...(required.length?{required}:{})};
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
