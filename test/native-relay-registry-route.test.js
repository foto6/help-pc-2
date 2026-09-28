import test from "node:test";
import assert from "node:assert/strict";
import { TOOL_REGISTRY_DIGEST, TOOL_REGISTRY_LIST } from "../src/native-registry.js";
import {
 PC_FROZEN_REGISTRY_V1, PC_PARITY_REGISTRY_V1, PINNED_PC_FROZEN_DIGEST,
 PINNED_CONTROL_NATIVE_DIGEST, PC_NATIVE_WIRE_ROUTES, routeNativeExecutorTool,
} from "../src/native-relay-registry-route.js";
import { normalizeDesktopCommanderError } from "../src/dc-compatibility.js";

// Independently transcribed from exact PC Core executor_adapter.py @04f8172,
// NOT imported from the Control routing implementation being tested.
const pinnedParityActions = Object.freeze({
 "device.info":["device.info","device.info","read_only"],
 "device.ping":["device.health","health.get","read_only"],
 "agent.shutdown":["agent.shutdown","agent.shutdown","side_effect"],
 "config.get":["device.get_config","config.get","read_only"],
 "config.set":["device.set_config","config.set","side_effect"],
 "identity.who_am_i":["identity.who_am_i","identity.who_am_i","read_only"],
 "device.identity":["identity.who_am_i","identity.who_am_i","read_only"],
 "usage.stats":["diagnostics.usage_stats","diagnostics.usage_stats","read_only"],
 "diagnostics.usage_stats":["diagnostics.usage_stats","diagnostics.usage_stats","read_only"],
 "audit.recent":["diagnostics.recent_tool_calls","diagnostics.recent_tool_calls","read_only"],
 "diagnostics.recent_tool_calls":["diagnostics.recent_tool_calls","diagnostics.recent_tool_calls","read_only"],
 "file.read_multiple":["file.read_multiple","fs.read_multiple","read_only"],
 "log.tail":["log.tail","log.tail","read_only"],
 "pdf.write":["pdf.write","pdf.write","side_effect"],
 "search.start":["search.start","search.start","side_effect"],
 "search.read":["search.read","search.read","read_only"],
 "search.list":["search.list","search.list","read_only"],
 "search.stop":["search.stop","search.stop","side_effect"],
 "process.read_output":["process.read","process.read_output","read_only"],
 "process.status":["process.status","process.status","read_only"],
 "process.managed.list":["process.list","process.managed.list","read_only"],
 "system.process.inspect":["system.process.inspect","process.inspect","read_only"],
 "shell.session.start":["shell.session.open","shell.session.start","side_effect"],
 "shell.session.write_stdin":["shell.session.write","shell.session.write_stdin","side_effect"],
 "shell.session.terminate":["shell.session.close","shell.session.terminate","side_effect"],
});

test("frozen PC Core and pinned Control registry attest exact 37/25 partition (62/62)", () => {
 assert.equal(PINNED_PC_FROZEN_DIGEST,
  "58b2bde8c6a49825747dcd7010f105dad0b6d548c7e8341cdafb32d2319f6dcd");
 assert.equal(TOOL_REGISTRY_DIGEST,PINNED_CONTROL_NATIVE_DIGEST);
 assert.equal(TOOL_REGISTRY_LIST.length,62);
 assert.equal(PC_NATIVE_WIRE_ROUTES.length,62);
 assert.equal(new Set(PC_NATIVE_WIRE_ROUTES.map(r=>r.advertisedToolName)).size,62);
 assert.equal(PC_NATIVE_WIRE_ROUTES.filter(r=>r.registryVersion===PC_FROZEN_REGISTRY_V1).length,37);
 assert.equal(PC_NATIVE_WIRE_ROUTES.filter(r=>r.registryVersion===PC_PARITY_REGISTRY_V1).length,25);
 assert.equal(Object.keys(pinnedParityActions).length,25);
 for(const entry of TOOL_REGISTRY_LIST){
  const route=routeNativeExecutorTool(entry.name,entry.executorAction,entry.effect);
  const expected=pinnedParityActions[entry.name];
  if(expected){
   assert.equal(route.registryVersion,PC_PARITY_REGISTRY_V1,entry.name);
   assert.deepEqual([route.wireToolName,route.executorAction,route.effect],expected,entry.name);
  } else {
   assert.equal(route.registryVersion,PC_FROZEN_REGISTRY_V1,entry.name);
   assert.equal(route.wireToolName,entry.name);
   assert.equal(route.executorAction,entry.executorAction);
   assert.equal(route.effect,entry.effect);
  }
 }
});
test("R14b rootless native tool names map to PC parity registry without losing executor action",()=>{
 assert.deepEqual(["device.info","device.health","device.get_config"].map((name,i)=>
   routeNativeExecutorTool(["device.info","device.ping","config.get"][i],
                           ["device.info","health.get","config.get"][i],"read_only").wireToolName),
  ["device.info","device.health","device.get_config"]);
});
test("stale action/effect/name fail before relay dispatch, with no alias fallback",()=>{
 for(const [name,action,effect] of [
  ["device.info","fs.read_text","read_only"],
  ["device.ping","health.get","side_effect"],
  ["file.read","fs.stat","read_only"],
  ["made-up-native-tool","device.info","read_only"],
 ]){
  assert.throws(()=>routeNativeExecutorTool(name,action,effect),
    err=>err.code==="NATIVE_WIRE_REGISTRY_MISMATCH");
 }
});
test("real TOOL_NOT_FOUND retains native category instead of becoming FILE_NOT_FOUND",()=>{
 const native=normalizeDesktopCommanderError({
  status:"error",error:{
   code:"TOOL_NOT_FOUND",category:"tool",
   message:"Unknown native tool 'device.info' for pc.native.tool_registry.v1",
   details:{registry_version:"pc.native.tool_registry.v1"},
  },
 },{tool:"device.info"});
 assert.equal(native.code,"TOOL_NOT_FOUND");
 assert.equal(native.category,"tool");
 assert.equal(native.details.native_code,"TOOL_NOT_FOUND");
 const file=normalizeDesktopCommanderError({
  status:"error",error:{code:"ENOENT",category:"filesystem",message:"No such file or directory"},
 },{tool:"file.read"});
 assert.equal(file.code,"FILE_NOT_FOUND");
 assert.equal(file.category,"filesystem");
});
