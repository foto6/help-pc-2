import test from "node:test";
import assert from "node:assert/strict";
import {
  allowedCdpPorts, listChromeTabs, captureChromeTab,
  validatePng, validateTargetEndpoint, mcpScreenshotResult,
} from "../src/browser-tab-capture.js";

const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y3rc0AAAAASUVORK5CYII=";
const target = Object.freeze({
  id: "F3ABC_1", type: "page", title: "Private tab",
  url: "https://example.org/view?q=SECRET#FRAGMENT",
  webSocketDebuggerUrl: "ws://127.0.0.1:17410/devtools/page/F3ABC_1",
});
const targets = [
  target,
  { type: "page", id: "bad", url: "chrome-extension://secret", webSocketDebuggerUrl: "ws://127.0.0.1:17410/devtools/page/bad" },
  { type: "worker", id: "other", url: "https://example.org", webSocketDebuggerUrl: "ws://127.0.0.1:17410/devtools/page/other" },
];
const mockFetch = async (url, opts) => {
  assert.equal(url, "http://127.0.0.1:17410/json/list");
  assert.equal(opts.redirect, "error");
  return { ok: true, text: async () => JSON.stringify(targets) };
};

test("CDP allowlist rejects ports outside operator list", () => {
  assert.deepEqual([...allowedCdpPorts("17410,17447")], [17410, 17447]);
  assert.throws(() => allowedCdpPorts("17410,abc"), /CDP_ALLOWLIST_INVALID/);
  assert.throws(() => allowedCdpPorts("0"), /CDP_ALLOWLIST_INVALID/);
});

test("read-only inventory returns exact pages without query/fragment", async () => {
  const items = await listChromeTabs(17410, { fetchImpl: mockFetch });
  assert.deepEqual(items, [{ target_id: "F3ABC_1", title: "Private tab",
    port: 17410, url: "https://example.org/view" }]);
  await assert.rejects(listChromeTabs(17499, { fetchImpl: mockFetch }), /CDP_PORT_NOT_ALLOWED/);
});

test("capture uses exact page websocket, rejects URL race and emits real MCP image media", async () => {
  const calls = [];
  const result = await captureChromeTab({
    port: 17410, target_id: "F3ABC_1",
    expected_url: "https://example.org/view", fetchImpl: mockFetch,
    sendImpl: async url => { calls.push(url); return { data: pixel }; },
  });
  assert.deepEqual(calls, ["ws://127.0.0.1:17410/devtools/page/F3ABC_1"]);
  assert.equal(result.width, 1);
  assert.equal(result.height, 1);
  assert.equal(result.byte_length, Buffer.from(pixel, "base64").length);
  assert.equal(result.sha256.length, 64);
  const media = mcpScreenshotResult(result);
  assert.equal(media.content[0].type, "image");
  assert.equal(media.content[0].mimeType, "image/png");
  assert.deepEqual(Buffer.from(media.content[0].data, "base64"), Buffer.from(pixel, "base64"), "equivalent binary PNG content despite noncanonical base64 padding");
  assert.equal(media.content[1].type, "text");
  assert.ok(!media.content[1].text.includes(pixel), "image bytes never leak into text logs");
  assert.ok(!media.content[1].text.includes("SECRET"), "query string is redacted");
  assert.equal(JSON.parse(media.content[1].text).focus_changed_by_tool, false);
  await assert.rejects(captureChromeTab({
    port: 17410, target_id: "F3ABC_1", expected_url: "https://example.org/changed",
    fetchImpl: mockFetch, sendImpl: async () => ({ data: pixel }),
  }), /CDP_TARGET_CHANGED/);
  await assert.rejects(captureChromeTab({
    port: 17410, target_id: "../F3ABC_1", fetchImpl: mockFetch,
  }), /CDP_TARGET_ID_REQUIRED/);
});

test("strict endpoint validation fails closed for cross-port/cross-host credentials", () => {
  for (const url of [
    "ws://evil.test:17410/devtools/page/F3ABC_1",
    "ws://127.0.0.1:17447/devtools/page/F3ABC_1",
    "ws://127.0.0.1:17410/devtools/page/ANOTHER",
    "ws://127.0.0.1:17410/devtools/page/F3ABC_1?x=1",
    "ws://user:pass@127.0.0.1:17410/devtools/page/F3ABC_1",
  ]) {
    assert.throws(() => validateTargetEndpoint(url, 17410, "F3ABC_1"), /CDP_ENDPOINT_INVALID/);
  }
});

test("binary verification rejects fake PNG, invalid encoding and impossible size", () => {
  assert.throws(() => validatePng("!"), /CDP_PNG_INVALID_BASE64/);
  assert.throws(() => validatePng(Buffer.from("not a PNG").toString("base64")), /CDP_PNG_INVALID/);
  assert.throws(() => validatePng(Buffer.from("x".repeat(8 * 1024 * 1024 + 1)).toString("base64")), /CDP_PNG_INVALID/);
});
