import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  connectDevice,
  relayEnv,
  respond,
  startRelay,
} from "./support/native-relay-fixture.js";

const serverBin = fileURLToPath(new URL("../bin/pc-native-mcp-stdio.js", import.meta.url));

function inheritedEnv(extra) {
  const env = Object.fromEntries(
    Object.entries(process.env)
      .filter(([key, value]) => key !== "PC_NATIVE_EXECUTOR_MODULE" && typeof value === "string"),
  );
  return { ...env, ...extra };
}

async function runStdio(t, { modern }) {
  const { address } = await startRelay(t);
  const peer = await connectDevice(address);
  t.after(() => peer.close());

  const stateDir = mkdtempSync(join(tmpdir(), modern ? "mcp-stdio-modern-" : "mcp-stdio-legacy-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverBin],
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: inheritedEnv(relayEnv(address, {
      PC_NATIVE_STATE_DIR: stateDir,
    })),
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
      const requestId = modern ? "stdio-modern-health" : "stdio-legacy-health";
      const pending = client.callTool({
        name: "device.ping",
        arguments: { request_id: requestId },
      });
      const first = await Promise.race([
        peer.nextRequest().then((frame) => ({ frame })),
        pending.then(
          (result) => ({ earlyResult: result }),
          (error) => ({ earlyError: error }),
        ),
      ]);
      if (!first.frame) {
        throw new Error("stdio MCP call completed before relay dispatch: " + JSON.stringify({
          result: first.earlyResult ?? null,
          error: first.earlyError ? { message: first.earlyError.message, code: first.earlyError.code } : null,
        }));
      }
      const frame = first.frame;
      assert.equal(frame.payload.request_id, requestId);
      assert.equal(frame.payload.body.request_id, requestId);
      // The public MCP tool is still device.ping. The exact pinned PC Core
      // requires the parity registry and its wire alias device.health.
      assert.equal(frame.payload.body.registry_version, "pc.native.parity_tool_registry.v1");
      assert.equal(frame.payload.body.tool, "device.health");
      respond(peer, frame, { data: { stdio: true, healthy: true } });
      const result = await pending;
      return {
        era: client.getProtocolEra(),
        revision: client.getNegotiatedProtocolVersion(),
        tools,
        result,
      };
    } catch (error) {
      error.message = `${error.message}\nstdio server stderr:\n${stderr}`;
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

test("official stdio client serves modern 2026-07-28 through built-in relay provider", async (t) => {
  const result = await runStdio(t, { modern: true });
  assert.equal(result.era, "modern");
  assert.equal(result.revision, "2026-07-28");
  assert.equal(result.tools.tools.some((tool) => tool.name === "device.ping"), true);
  assert.equal(resultBody(result.result).status, "completed");
  assert.equal(resultBody(result.result).data.stdio, true);
});

test("official stdio client serves supported 2025-era handshake through built-in relay provider", async (t) => {
  const result = await runStdio(t, { modern: false });
  assert.equal(result.era, "legacy");
  assert.match(result.revision, /^2025-/);
  assert.equal(result.tools.tools.some((tool) => tool.name === "device.ping"), true);
  assert.equal(resultBody(result.result).status, "completed");
});
