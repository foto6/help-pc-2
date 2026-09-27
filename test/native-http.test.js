import test from "node:test";
import assert from "node:assert/strict";
import {
  ControlPlane,
  HelpPc1Adapter,
  LocalNativeHttpTransport,
  NativeControlFacade,
} from "../src/index.js";

function success(request, data = {}) {
  return {
    request_id: request.request_id,
    action: request.action,
    ok: true,
    status: "completed",
    started_at: "2026-09-27T00:00:00.000Z",
    finished_at: "2026-09-27T00:00:00.001Z",
    data,
    error: null,
    error_kind: null,
    dry_run: request.dry_run,
  };
}

function auth(token) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

test("loopback HTTP transport is authenticated and exposes lifecycle/health/capabilities", async (t) => {
  const cp = new ControlPlane({
    providers: [new HelpPc1Adapter({ invoke: async (request) => success(request, { ok: true }) })],
  });
  const facade = new NativeControlFacade({
    controlPlane: cp,
    capabilityProvider: async () => ({
      contract_version: "pc_executor.capabilities.v1",
      digest: "exec-http-v1",
      actions: ["system.health"],
    }),
  });
  const token = "0123456789abcdef0123456789abcdef";
  const transport = new LocalNativeHttpTransport({ facade, token, port: 0 });
  t.after(() => transport.stop());
  const address = await transport.start();

  const unauthorized = await fetch(`${address.url}/v1/health`);
  assert.equal(unauthorized.status, 401);
  assert.equal((await unauthorized.json()).error.code, "AUTH_REQUIRED");

  const health = await fetch(`${address.url}/v1/health`, { headers: auth(token) });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, "ok");

  const lifecycle = await fetch(`${address.url}/v1/lifecycle`, { headers: auth(token) });
  const lifecycleBody = await lifecycle.json();
  assert.equal(lifecycleBody.state, "running");
  assert.equal(lifecycleBody.loopback_only, true);

  const caps = await fetch(`${address.url}/v1/capabilities`, { headers: auth(token) });
  const manifest = await caps.json();
  assert.equal(manifest.executor.digest, "exec-http-v1");

  const opened = await fetch(`${address.url}/v1/session/open`, {
    method: "POST",
    headers: auth(token),
    body: JSON.stringify({
      desktopId: "desktop-http",
      client: {
        protocol_version: manifest.protocol_version,
        registry_digest: manifest.registry_digest,
        executor_digest: manifest.executor.digest,
      },
    }),
  });
  assert.equal(opened.status, 200);
  const session = await opened.json();
  assert.equal(typeof session.session_id, "string");

  const invoked = await fetch(`${address.url}/v1/request`, {
    method: "POST",
    headers: auth(token),
    body: JSON.stringify({
      contract_version: manifest.protocol_version,
      session_id: session.session_id,
      request_id: "http-req-1",
      tool: "device.health",
      arguments: {},
    }),
  });
  const response = await invoked.json();
  assert.equal(invoked.status, 200);
  assert.equal(response.status, "completed");
  assert.equal(response.data.ok, true);
});

test("Wave 1 transport refuses non-loopback bind", () => {
  const facade = {};
  assert.throws(
    () => new LocalNativeHttpTransport({
      facade,
      token: "0123456789abcdef0123456789abcdef",
      host: "0.0.0.0",
    }),
    /loopback/,
  );
});
