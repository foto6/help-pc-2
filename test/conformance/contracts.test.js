import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ConformanceValidationError,
  VisionVerificationResultV1Adapter,
  adaptExecutorActionOutcomeV1,
  gitBlobSha1,
  parseExecutorActionOutcomeV1,
  parseVisionVerificationInputV1,
  parseVisionVerificationResultV1,
} from "../../src/index.js";

const readJson = (relative) => JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8"));
const provenance = readJson("../../conformance/PROVENANCE.json");
const execBase = "../../conformance/frozen/executor/606074456ca00681fac30a40ee28f7bb0f67c79c/tests/fixtures/";
const visionBase = "../../conformance/frozen/vision/f20e2c2e35cbcb9b675c9c1a0568de2e40b5eb82/tests/fixtures/post_action_verification_result_v1/";

test("frozen corpus provenance matches exact Git blob hashes", () => {
  assert.equal(provenance.upstreams.executor.commit_sha, "606074456ca00681fac30a40ee28f7bb0f67c79c");
  assert.equal(provenance.upstreams.vision.commit_sha, "f20e2c2e35cbcb9b675c9c1a0568de2e40b5eb82");
  for (const entry of provenance.files) {
    const content = readFileSync(new URL("../../" + entry.copied_path, import.meta.url), "utf8");
    assert.equal(gitBlobSha1(content), entry.git_blob_sha1, entry.copied_path);
  }
});

test("Executor authoritative corpus parses strictly", () => {
  const cases = [
    ["action_outcome_v1_not_started.json", "not_started"],
    ["action_outcome_v1.json", "completed"],
    ["action_outcome_v1_unknown.json", "unknown"],
  ];
  for (const [name, state] of cases) {
    const payload = readJson(execBase + name);
    assert.equal(parseExecutorActionOutcomeV1(payload).effect_state, state);
  }
});

test("Executor outcome v1 rejects version, extra fields, inconsistent flags and binding mismatch", () => {
  const base = readJson(execBase + "action_outcome_v1.json");
  for (const mutate of [
    (p) => { p.contract_version = "pc_executor.action_outcome.v2"; },
    (p) => { p.extra = true; },
    (p) => { p.reexecution_safe = true; },
    (p) => { p.completion_observed = false; },
  ]) {
    const payload = structuredClone(base);
    mutate(payload);
    assert.throws(() => parseExecutorActionOutcomeV1(payload), ConformanceValidationError);
  }
  assert.throws(
    () => parseExecutorActionOutcomeV1(base, { requestId: "other", action: base.action }),
    (error) => error.code === "EXECUTOR_OUTCOME_BINDING_MISMATCH",
  );
});

test("Executor outcome adapter preserves not_started/completed/unknown semantics", () => {
  assert.equal(adaptExecutorActionOutcomeV1(readJson(execBase + "action_outcome_v1_not_started.json")).outcome, "not_dispatched");
  assert.equal(adaptExecutorActionOutcomeV1(readJson(execBase + "action_outcome_v1.json")).outcome, "succeeded");
  assert.equal(adaptExecutorActionOutcomeV1(readJson(execBase + "action_outcome_v1_unknown.json")).outcome, "unknown");
});

test("Vision frozen verification input canonical digest matches authoritative binding", () => {
  const input = readJson(visionBase + "verification_input.json");
  const parsed = parseVisionVerificationInputV1(input);
  assert.equal(parsed.canonicalDigest, "fd9003468e901fe009e8aa0b2720dd91babce3cf9c19253a114d6248b0e180a1");
  assert.equal(parsed.expectationDigest, "be843db601bbee8adbe7a2027993fa24363a9c4219115c1a2e48f126c8db8d99");
});

test("Vision authoritative four-status corpus parses against exact input binding", () => {
  const input = readJson(visionBase + "verification_input.json");
  for (const status of ["verified", "failed", "stale", "inconclusive"]) {
    const parsed = parseVisionVerificationResultV1(readJson(visionBase + status + ".json"), { verificationInput: input });
    assert.equal(parsed.status, status);
  }
});

test("Vision result v1 rejects version, extras, inconsistent evidence and wrong canonical input", () => {
  const input = readJson(visionBase + "verification_input.json");
  const verified = readJson(visionBase + "verified.json");
  for (const mutate of [
    (p) => { p.contract_version = "vision.post_action_verification_result.v2"; },
    (p) => { p.extra = true; },
    (p) => { p.evidence.changed_ratio = null; },
    (p) => { p.evidence.reasons = ["unexpected"]; },
    (p) => { p.binding.before.image_digest = "other"; },
  ]) {
    const payload = structuredClone(verified);
    mutate(payload);
    assert.throws(() => parseVisionVerificationResultV1(payload, { verificationInput: input }), ConformanceValidationError);
  }

  const otherActionObservationPair = structuredClone(input);
  otherActionObservationPair.before.frame.image_digest = "another-action-before";
  assert.throws(
    () => parseVisionVerificationResultV1(verified, { verificationInput: otherActionObservationPair }),
    (error) => error.code === "VISION_VERIFICATION_BINDING_MISMATCH",
  );
});

test("Vision target identity binding mismatch fails closed", () => {
  const input = readJson(visionBase + "verification_input.json");
  const verified = readJson(visionBase + "verified.json");
  assert.throws(
    () => parseVisionVerificationResultV1(verified, {
      verificationInput: input,
      targetIdentity: { element_id: "uia:other", node_id: "other", automation_id: "other" },
    }),
    (error) => error.code === "VISION_VERIFICATION_BINDING_MISMATCH",
  );
});

test("Vision adapter maps result statuses without execution authority", async () => {
  const input = readJson(visionBase + "verification_input.json");
  const expected = {
    verified: { ok: true },
    stale: { ok: false, retryable: true, category: "stale_observation" },
    inconclusive: { ok: false, retryable: true, category: "inconclusive" },
    failed: { ok: false, retryable: false, category: "verification_failed" },
  };
  for (const [status, fields] of Object.entries(expected)) {
    const adapter = new VisionVerificationResultV1Adapter({ readResult: async () => readJson(visionBase + status + ".json") });
    const result = await adapter.verify({ verification: { input: { verificationInput: input } } }, {});
    for (const [key, value] of Object.entries(fields)) assert.equal(result[key], value);
  }
});
