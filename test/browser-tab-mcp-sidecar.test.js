import test from "node:test";
import assert from "node:assert/strict";
import { registerBrowserTabTools } from "../src/browser-tab-mcp-sidecar.js";

test("sidecar opt-in is required and never mutates the pinned native registry", () => {
  const server = { registerTool() { throw Error("should not register"); } };
  assert.throws(() => registerBrowserTabTools(server, { enabled: false }),
    /BROWSER_CAPTURE_EXPLICIT_OPT_IN_REQUIRED/);
});

test("sidecar exposes only two read-only tools with actual MCP image content", async () => {
  const tools = new Map();
  const server = { registerTool(name, options, handler) {
    tools.set(name, { options, handler });
  } };
  const result = registerBrowserTabTools(server, {
    enabled: true,
    listImpl: async port => [{ port, target_id: "XYZ", url: "https://example.org" }],
    captureImpl: async args => ({
      ...args, base64: "iVBORw0KGgo=", width: 1,
      height: 1, byte_length: 8, sha256: "a".repeat(64),
    }),
  });
  assert.deepEqual(result, ["browser.tab.list", "browser.tab.capture"]);
  assert.equal(tools.size, 2);
  for (const tool of tools.values()) {
    assert.equal(tool.options.annotations.readOnlyHint, true);
    assert.equal(tool.options.annotations.destructiveHint, false);
    assert.equal(tool.options._meta["pc.browser/focus_change"], false);
    assert.equal(tool.options._meta["pc.browser/pixels_to_github"], false);
  }
  const listed = await tools.get("browser.tab.list").handler({ port: 17410 });
  assert.equal(JSON.parse(listed.content[0].text).tabs[0].target_id, "XYZ");
  const shot = await tools.get("browser.tab.capture").handler({
    port: 17410, target_id: "XYZ",
  });
  assert.equal(shot.content[0].type, "image");
  assert.equal(shot.content[0].mimeType, "image/png");
  assert.equal(shot.content[0].data, "iVBORw0KGgo=");
  assert.ok(!shot.content[1].text.includes("iVBORw0KGgo="));
  assert.equal(JSON.parse(shot.content[1].text).focus_changed_by_tool, false);
});

test("sidecar fails closed on CDP errors without disclosing private URLs", async () => {
  const tools = new Map();
  const server = { registerTool(name, _, handler) { tools.set(name, handler); } };
  registerBrowserTabTools(server, {
    enabled: true,
    listImpl: async () => { throw Error("private-url https://example.org/path?token=foo"); },
    captureImpl: async () => { throw Error("CDP_TARGET_CHANGED"); },
  });
  const listed = await tools.get("browser.tab.list")({ port: 17410 });
  assert.equal(listed.isError, true);
  assert.equal(JSON.parse(listed.content[0].text).code, "BROWSER_CAPTURE_FAILED");
  assert.ok(!listed.content[0].text.includes("token"));
  const captured = await tools.get("browser.tab.capture")({ port: 17410, target_id: "XYZ" });
  assert.equal(captured.isError, true);
  assert.equal(JSON.parse(captured.content[0].text).code, "CDP_TARGET_CHANGED");
});
