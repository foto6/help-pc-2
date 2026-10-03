import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

function gitBlobSha1(text) {
  const bytes = Buffer.from(text.replace(/\r\n/g, "\n"), "utf8");
  const header = Buffer.from(`blob ${bytes.length}\0`, "utf8");
  return createHash("sha1").update(header).update(bytes).digest("hex");
}

test("R36 source pin binds the public Host fix without rewriting historical R31 authority", () => {
  const pin = JSON.parse(readFileSync(
    new URL("../conformance/r36_public_host_gate/source-pin.json", import.meta.url),
    "utf8",
  ));
  assert.equal(pin.contract_version, "pc.control.r36.source_pin.v1");
  assert.equal(pin.repository, "foto6/help-pc-2");
  assert.equal(pin.exact_code_sha, "7f643b4f1f803b637e1b377ac4989bc79d03c4dd");
  assert.equal(pin.inherits.r35_release_sha, "5ce23dcbe442633c2f3157d1c4d5d5fc03872672");
  assert.equal(pin.inherits.current_authority, "github_relay");
  assert.equal(pin.inherits.live_cutover_performed, false);
  assert.equal(pin.historical_pins.r31_r30_pin_immutable, true);
  assert.equal(pin.historical_pins.r31_source_drift_expected, true);

  for (const [path, expected] of Object.entries(pin.blobs)) {
    const text = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    assert.equal(gitBlobSha1(text), expected, path);
  }
});

test("R36 pinned live public evidence remains non-authoritative and replay-safe", () => {
  const evidence = JSON.parse(readFileSync(
    new URL("../conformance/r36_public_host_gate/live-public-canary.json", import.meta.url),
    "utf8",
  ));
  assert.equal(evidence.source_sha, "7f643b4f1f803b637e1b377ac4989bc79d03c4dd");
  assert.equal(evidence.read_only.ping, "completed");
  assert.equal(evidence.read_only.list_devices, "completed");
  assert.equal(evidence.side_effect.first_status, "completed");
  assert.equal(evidence.side_effect.duplicate_status, "completed");
  assert.equal(evidence.side_effect.automatic_replay, false);
  assert.equal(evidence.side_effect.physical_duplicate_observed, false);
  assert.equal(evidence.current_authority_changed, false);
  assert.equal(evidence.production_cutover_performed, false);
  assert.equal(evidence.external_chatgpt_registration_performed, false);
});
