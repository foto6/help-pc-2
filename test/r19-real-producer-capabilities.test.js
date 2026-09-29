import test from "node:test";
import assert from "node:assert/strict";
import { projectProducerExecutorActions } from "../src/native-relay-provider.js";

function realPythonShapedManifest() {
  return {
    executor: {
      contract_version: "pc_executor.capabilities.v1",
      digest: "d".repeat(64),
      // Genuine Python producer advertises parity action names here.
      actions: ["health.get", "config.get", "fs.read_text", "fs.write_text"],
    },
    compatibility: {
      routes: {
        "device.health": { status: "translated", surface: "parity", target_action: "health.get" },
        "device.get_config": { status: "translated", surface: "parity", target_action: "config.get" },
        "file.read": { status: "translated", surface: "parity", target_action: "fs.read_text" },
        "file.write": { status: "translated", surface: "parity", target_action: "fs.write_text" },
        "file.search": { status: "translated", surface: "parity", target_action: "fs.find" },
        "window.list": { status: "translated", surface: "legacy_executor", target_action: "windows.list" },
        "uia.find": { status: "capability_unavailable", surface: "unavailable", target_action: null },
      },
      legacy_executor: { actions: ["windows.list"] },
    },
  };
}
test("R19: genuine Python parity manifest proves frozen Control compatibility aliases", () => {
  const manifest = realPythonShapedManifest();
  const before = JSON.stringify(manifest);
  const actual = projectProducerExecutorActions(manifest, manifest.executor);
  assert.equal(actual.digest, manifest.executor.digest, "authenticated Executor digest remains unchanged");
  assert.ok(actual.actions.includes("system.health"), "Control device.health -> real Python health.get");
  assert.ok(actual.actions.includes("system.config.get"), "Control device.get_config -> real Python config.get");
  assert.ok(actual.actions.includes("fs.read_text"));
  assert.ok(actual.actions.includes("fs.write_text"));
  assert.ok(actual.actions.includes("windows.list"), "legacy route is explicitly supported by legacy manifest");
  assert.equal(actual.actions.includes("fs.find"), false, "missing underlying action is not invented");
  assert.equal(actual.actions.includes("uia.find"), false, "explicitly unavailable route is not invented");
  assert.equal(JSON.stringify(manifest), before, "do not mutate the authenticated remote manifest");
});
test("R19: no signed Python compatibility routes means no synthetic aliases", () => {
  const executor={digest:"z".repeat(64),actions:["health.get"]};
  assert.equal(projectProducerExecutorActions({executor},executor),executor);
});
test("R19: a forged route to an absent action cannot advertise frozen compatibility", () => {
  const manifest=realPythonShapedManifest();
  manifest.compatibility.routes["device.health"].target_action="not-in-real-parity";
  const projected=projectProducerExecutorActions(manifest,manifest.executor);
  assert.equal(projected.actions.includes("system.health"),false);
  assert.equal(projected.actions.includes("health.get"),true);
});
