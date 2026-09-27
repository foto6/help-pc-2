import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ControlPlane,
  FunctionProvider,
  JsonStateStore,
  StateCorruptionError,
} from "../src/index.js";
import {
  combineSoakReports,
  runControlStateMachineSoak,
} from "./support/control-soak.js";

const SEEDS = [0x51a7e, 0xc0ffee];
const ACTIONS_PER_SEED = 256;
const EXPECTED_REPORT = JSON.parse(
  readFileSync(new URL("../conformance/reports/control-state-machine-soak-v1.json", import.meta.url), "utf8"),
);

function persistenceFaultChecks() {
  const dir = mkdtempSync(join(tmpdir(), "pc-control-soak-persistence-"));
  const provider = new FunctionProvider("fake", async () => ({ ok: true }));
  let checks = 0;

  const goodPath = join(dir, "good.json");
  const goodStore = new JsonStateStore(goodPath);
  const cp = new ControlPlane({ providers: [provider], store: goodStore, idFactory: (() => { let n = 0; return () => `persist-${++n}`; })() });
  const session = cp.createSession({ desktopId: "persist-desktop" });
  cp.enqueueAction(session.id, { provider: "fake", type: "screen.read", idempotencyKey: "persisted" });
  const goodText = readFileSync(goodPath, "utf8");

  const corruptions = [
    "",
    "{",
    '{"version":3',
    '{"version":3,"sessions":[',
    goodText.slice(0, Math.floor(goodText.length / 4)),
    goodText.slice(0, Math.floor(goodText.length / 2)),
    goodText.slice(0, goodText.length - 2),
    JSON.stringify({ version: 99, sessions: [], actions: [] }),
    JSON.stringify({ version: 3, sessions: {}, actions: [] }),
    JSON.stringify({ version: 3, sessions: [], actions: {} }),
    "null",
    "[]",
  ];

  for (let i = 0; i < corruptions.length; i += 1) {
    const path = join(dir, `corrupt-${i}.json`);
    writeFileSync(path, corruptions[i], "utf8");
    assert.throws(
      () => new ControlPlane({ providers: [provider], store: new JsonStateStore(path) }),
      StateCorruptionError,
      `corruption vector ${i} must fail closed`,
    );
    checks += 1;
  }

  const restored = new ControlPlane({ providers: [provider], store: goodStore });
  const original = restored.listActions()[0];
  const duplicate = restored.enqueueAction(session.id, { provider: "fake", type: "screen.read", idempotencyKey: "persisted" });
  assert.equal(duplicate.id, original.id);
  checks += 1;

  return checks;
}

test("deterministic control state-machine fault soak matches frozen report", async () => {
  const runs = [];
  for (const seed of SEEDS) {
    const { report } = await runControlStateMachineSoak({ seed, actionCount: ACTIONS_PER_SEED });
    runs.push(report);
  }
  const faults = persistenceFaultChecks();
  const actual = combineSoakReports(runs, faults);
  assert.equal(actual.logicalActions >= 500, true);
  assert.deepEqual(actual, EXPECTED_REPORT);
});

test("same fixed seed produces byte-identical aggregate transition report", async () => {
  const first = await runControlStateMachineSoak({ seed: 0x5eed1234, actionCount: 64 });
  const second = await runControlStateMachineSoak({ seed: 0x5eed1234, actionCount: 64 });
  assert.deepEqual(first.report, second.report);
});
