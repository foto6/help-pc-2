import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const serverBin = fileURLToPath(new URL("../fixtures/mcp-stdio-server-fixture.js", import.meta.url));
const productionServerBin = fileURLToPath(new URL("../bin/pc-native-mcp-stdio.js", import.meta.url));

function inheritedEnv(extra) {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === "string")),
    ...extra,
  };
}

async function runStdio({ modern }) {
  const stateDir = mkdtempSync(join(tmpdir(), modern ? "mcp-stdio-modern-" : "mcp-stdio-legacy-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverBin],
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: inheritedEnv({
      PC_NATIVE_STATE_DIR: stateDir,
      PC_NATIVE_DESKTOP_ID: "stdio-test-desktop",
    }),
    stderr: "pipe",
  });
  const client = new Client(
    { name: modern ? "stdio-modern-client" : "stdio-legacy-client", version: "1.0.0" },
    modern ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : undefined,
  );
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
  try {
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      const result = await client.callTool({
        name: "device.health",
        arguments: { request_id: modern ? "stdio-modern-health" : "stdio-legacy-health" },
      });
      return {
        era: client.getProtocolEra(),
        revision: client.getNegotiatedProtocolVersion(),
        tools,
        result,
      };
    } catch (error) {
      error.message = `${error.message}
stdio server stderr:
${stderr}`;
      throw error;
    }
  } finally {
    await client.close().catch(() => {});
    rmSync(stateDir, { recursive: true, force: true });
  }
}

function resultBody(result) {
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const text = result.content?.find((item) => item.type === "text")?.text;
  return JSON.parse(text);
}

test("official stdio client serves modern 2026-07-28 when pinned", async () => {
  const result = await runStdio({ modern: true });
  assert.equal(result.era, "modern");
  assert.equal(result.revision, "2026-07-28");
  assert.equal(result.tools.tools.some((tool) => tool.name === "device.health"), true);
  assert.equal(resultBody(result.result).status, "completed");
  assert.equal(resultBody(result.result).data.stdio, true);
});

test("official stdio client serves supported 2025-era initialize handshake", async () => {
  const result = await runStdio({ modern: false });
  assert.equal(result.era, "legacy");
  assert.match(result.revision, /^2025-/);
  assert.equal(result.tools.tools.some((tool) => tool.name === "device.health"), true);
  assert.equal(resultBody(result.result).status, "completed");
});

test("official MCP client cannot start production stdio with an unpinned attacker module", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "mcp-stdio-prod-pin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const marker = join(root, "attacker-imported.txt");
  const providerMarker = join(root, "attacker-provider-called.txt");
  const attacker = join(root, "attacker.mjs");
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "@attacker/local-executor",
    version: "9.9.9",
    type: "module",
  }, null, 2));
  writeFileSync(attacker, `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "imported");
export async function createExecutorBridge() {
  return {
    readCapabilities: async () => ({
      contract_version: "pc_executor.capabilities.v1",
      digest: "attacker-cap",
      actions: ["fs.write_text"],
    }),
    invoke: async () => {
      writeFileSync(${JSON.stringify(providerMarker)}, "provider-called");
      throw new Error("attacker provider must never execute");
    },
  };
}
`);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [productionServerBin],
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: inheritedEnv({
      PC_NATIVE_EXECUTOR_MODULE: attacker,
      PC_NATIVE_STATE_DIR: join(root, "state"),
    }),
    stderr: "pipe",
  });
  const client = new Client(
    { name: "stdio-production-pin-negative", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await assert.rejects(client.connect(transport));
  await client.close().catch(() => {});
  assert.equal(existsSync(marker), false, "attacker module top-level side effect must remain zero");
  assert.equal(existsSync(providerMarker), false, "attacker provider side-effect count must remain zero");
});
