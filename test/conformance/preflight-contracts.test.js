import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  ConformanceValidationError,
  adaptExecutorActionPreflightResultV1,
  adaptExecutorCapabilitiesV1,
  buildExecutorActionPreflightRequestV1,
  parseExecutorActionPreflightRequestV1,
  parseExecutorActionPreflightResultV1,
  parseExecutorCapabilitiesV1,
} from "../../src/index.js";
import {
  bindPreflightResult,
  frozenCapabilities,
  mutateCapabilities,
  readFrozenPreflightFixture,
} from "../support/preflight-fixtures.js";

const provenance = JSON.parse(
  readFileSync(new URL("../../conformance/PREFLIGHT_PROVENANCE.json", import.meta.url), "utf8"),
);

test("preflight frozen corpus provenance pins exact producer bytes and hashes", () => {
  assert.equal(provenance.producer.commit_sha, "d0ccb0f390474fc3fc091e51c25f7ef8771b0f09");
  for (const entry of provenance.files) {
    const path = `${provenance.copied_root}/${entry.name}`;
    assert.equal(
      execFileSync("git", ["rev-parse", `HEAD:${path}`], { encoding: "utf8" }).trim(),
      entry.git_blob_sha1,
      path,
    );
    const bytes = execFileSync("git", ["show", `HEAD:${path}`]);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256, path);
  }
});

test("authoritative capabilities fixture parses and verifies attestation digest", () => {
  const parsed = parseExecutorCapabilitiesV1(frozenCapabilities());
  assert.equal(parsed.contract_version, "pc_executor.capabilities.v1");
  assert.equal(parsed.attestation.digest, "9e3867f7b7d5a429d28e2c9ed2d4ab9cf635f4d6b2b65a8add494b455b651052");
  assert.equal(parsed.safety.credential_entry_allowed, false);
  assert.equal(parsed.safety.captcha_entry_allowed, false);
  assert.equal(parsed.actions["shell.run"].side_effecting, true);
  assert.equal(adaptExecutorCapabilitiesV1(frozenCapabilities()).digest, parsed.attestation.digest);
});

test("capabilities reject version, extras, safety tamper, action drift, and attestation mismatch", () => {
  for (const mutate of [
    (p) => { p.contract_version = "pc_executor.capabilities.v2"; },
    (p) => { p.runtime.hostname = "host"; },
    (p) => { p.safety.credential_entry_allowed = true; },
    (p) => { p.actions["keyboard.press"].side_effecting = false; },
    (p) => { p.attestation.digest = "0".repeat(64); },
  ]) {
    const payload = frozenCapabilities();
    mutate(payload);
    assert.throws(() => parseExecutorCapabilitiesV1(payload), ConformanceValidationError);
  }
});

test("capability attestation changes deterministically when configuration drifts", () => {
  const base = adaptExecutorCapabilitiesV1(frozenCapabilities());
  const drifted = adaptExecutorCapabilitiesV1(mutateCapabilities((payload) => {
    payload.adapters.shell.available = false;
    payload.adapters.shell.provider = "missing";
    payload.adapters.shell.unsupported_reason = "adapter_missing";
    payload.actions["shell.run"].supported = false;
    payload.actions["shell.run"].unsupported_reason = "adapter_missing";
  }));
  assert.notEqual(base.digest, drifted.digest);
  assert.equal(drifted.actions["shell.run"].supported, false);
});

test("authoritative preflight request round-trips strictly", () => {
  const payload = readFrozenPreflightFixture("ready.request.json");
  assert.deepEqual(parseExecutorActionPreflightRequestV1(payload), {
    contract_version: "pc_executor.action_preflight.v1",
    request: {
      request_id: "fixture-ready",
      action: "keyboard.press",
      params: { key: "enter" },
      dry_run: null,
      timeout_ms: 1000,
    },
  });
  const built = buildExecutorActionPreflightRequestV1(
    { id: "logical-action", type: "keyboard.press", input: { key: "enter" } },
    { dryRun: true, timeoutMs: 900 },
  );
  assert.deepEqual(built.request, {
    request_id: "logical-action",
    action: "keyboard.press",
    params: { key: "enter" },
    dry_run: true,
    timeout_ms: 900,
  });
});

test("preflight request rejects unknown version, fields and malformed deadlines", () => {
  for (const payload of [
    { contract_version: "pc_executor.action_preflight.v2", request: { request_id: "x", action: "keyboard.press", params: {} } },
    { contract_version: "pc_executor.action_preflight.v1", request: { request_id: "x", action: "keyboard.press", params: {}, extra: true } },
    { contract_version: "pc_executor.action_preflight.v1", request: { request_id: "x", action: "keyboard.press", params: {}, timeout_ms: 0 } },
  ]) assert.throws(() => parseExecutorActionPreflightRequestV1(payload), ConformanceValidationError);
});

test("all authoritative preflight result statuses parse strictly", () => {
  const expected = [
    ["ready.result.json", "ready", true],
    ["blocked.result.json", "blocked", false],
    ["unsupported.result.json", "unsupported", false],
    ["invalid_request.result.json", "invalid_request", false],
    ["stale_observation.result.json", "stale_observation", false],
    ["ambiguous_target.result.json", "ambiguous_target", false],
  ];
  for (const [name, status, executable] of expected) {
    const parsed = parseExecutorActionPreflightResultV1(readFrozenPreflightFixture(name));
    assert.equal(parsed.status, status);
    assert.equal(parsed.executable, executable);
  }
});

test("preflight result binding requires logical request/action and capabilities digest", () => {
  const caps = adaptExecutorCapabilitiesV1(frozenCapabilities());
  const payload = bindPreflightResult("ready.result.json", {
    requestId: "logical-action",
    action: "keyboard.press",
    capabilitiesDigest: caps.digest,
  });
  const adapted = adaptExecutorActionPreflightResultV1(payload, {
    requestId: "logical-action",
    action: "keyboard.press",
    capabilitiesDigest: caps.digest,
  });
  assert.equal(adapted.ready, true);
  assert.equal(adapted.capabilitiesDigest, caps.digest);
  assert.match(adapted.attestationDigest, /^[0-9a-f]{64}$/);

  assert.throws(
    () => parseExecutorActionPreflightResultV1(payload, { requestId: "other", action: "keyboard.press", capabilitiesDigest: caps.digest }),
    (error) => error.code === "EXECUTOR_PREFLIGHT_BINDING_MISMATCH",
  );
  assert.throws(
    () => parseExecutorActionPreflightResultV1(payload, { requestId: "logical-action", action: "shell.run", capabilitiesDigest: caps.digest }),
    (error) => error.code === "EXECUTOR_PREFLIGHT_BINDING_MISMATCH",
  );
  assert.throws(
    () => parseExecutorActionPreflightResultV1(payload, { requestId: "logical-action", action: "keyboard.press", capabilitiesDigest: "0".repeat(64) }),
    (error) => error.code === "EXECUTOR_PREFLIGHT_CAPABILITY_MISMATCH",
  );
});

test("preflight result rejects malformed version, extras, executable mismatch and target smuggling", () => {
  const caps = adaptExecutorCapabilitiesV1(frozenCapabilities());
  const base = bindPreflightResult("ready.result.json", {
    requestId: "strict",
    action: "keyboard.press",
    capabilitiesDigest: caps.digest,
  });
  const mutations = [
    (p) => { p.contract_version = "pc_executor.action_preflight.v2"; },
    (p) => { p.extra = true; },
    (p) => { p.executable = false; },
    (p) => { p.target = { resolved: true, raw_handle: 42 }; },
  ];
  for (const mutate of mutations) {
    const payload = structuredClone(base);
    mutate(payload);
    assert.throws(() => parseExecutorActionPreflightResultV1(payload), ConformanceValidationError);
  }
});
