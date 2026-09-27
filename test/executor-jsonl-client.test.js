import test from "node:test";
import assert from "node:assert/strict";
import { ExecutorJsonlClient } from "../src/executor-jsonl-client.js";

test("ExecutorJsonlClient correlates one JSONL request with one response", async () => {
  const script = [
    "const readline=require('node:readline');",
    "const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity});",
    "rl.on('line',(line)=>{",
    " const req=JSON.parse(line);",
    " process.stdout.write(JSON.stringify({request_id:req.request_id,action:req.action,ok:true,status:'ok',data:req.params||{}})+'\\n');",
    "});",
  ].join("");

  const client = new ExecutorJsonlClient({
    command: process.execPath,
    args: ["-e", script],
    live: false,
    requestTimeoutMs: 5000,
  });

  try {
    const result = await client.request({ action: "echo.test", params: { value: 7 } });
    assert.equal(result.ok, true);
    assert.equal(result.status, "ok");
    assert.equal(result.action, "echo.test");
    assert.equal(result.data.value, 7);
    assert.equal(typeof result.request_id, "string");
    assert.equal(client.status().running, true);
  } finally {
    client.stop();
  }
});

test("ExecutorJsonlClient rejects invalid JSON from child process", async () => {
  const script = [
    "const readline=require('node:readline');",
    "const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity});",
    "rl.on('line',()=>process.stdout.write('not-json\\n'));",
  ].join("");

  const client = new ExecutorJsonlClient({
    command: process.execPath,
    args: ["-e", script],
    live: false,
    requestTimeoutMs: 5000,
  });

  try {
    await assert.rejects(
      client.request({ action: "echo.bad", params: {} }),
      (error) => error.code === "EXECUTOR_TRANSPORT_INVALID_JSON",
    );
  } finally {
    client.stop();
  }
});
