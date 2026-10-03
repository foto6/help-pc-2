import test from "node:test";
import assert from "node:assert/strict";
import { __test as directRemoteTest } from "../src/direct-remote-mcp.js";

test("R36 Host parser accepts valid public DNS names containing letter s", () => {
  for (const host of [
    "systems.example.test",
    "papers-wma-cities-recently.trycloudflare.com",
    "STATUS.EXAMPLE.TEST",
  ]) {
    const request = new Request("https://gateway.invalid/healthz", {
      headers: { host },
    });
    assert.equal(directRemoteTest.hostHeader(request), host.toLowerCase());
  }
});

test("R36 Host parser still fails closed on missing, whitespace, or slash", () => {
  assert.equal(directRemoteTest.hostHeader(new Request("https://gateway.invalid/")), null);
  for (const host of ["bad host.example", "bad/host.example", "bad\thost.example"]) {
    const request = new Request("https://gateway.invalid/", { headers: { host } });
    assert.equal(directRemoteTest.hostHeader(request), null);
  }
});
