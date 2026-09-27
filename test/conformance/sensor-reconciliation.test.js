import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  ConformanceValidationError,
  VisionSensorReconciliationAdapter,
  parseVisionObservationConsistencyV1,
  parseVisionSemanticUiDeltaV1,
} from "../../src/index.js";
import {
  TARGET,
  bindObservationConsistency,
  bindSemanticDelta,
  readVisionText,
  sensorBundle,
  verificationInput,
  wrongTargetBundle,
} from "../support/e2e-readiness-fixtures.js";

const provenance = JSON.parse(
  readFileSync(new URL("../../conformance/E2E_READINESS_PROVENANCE.json", import.meta.url), "utf8"),
);

test("Wave 8 provenance pins exact producer Git blobs at exact heads", () => {
  assert.equal(provenance.executor.commit_sha, "d0ccb0f390474fc3fc091e51c25f7ef8771b0f09");
  assert.equal(provenance.vision.commit_sha, "df9a84590a4a9d8fe8dfdec9ff195fe4821397f6");
  for (const producer of [provenance.executor, provenance.vision]) {
    for (const [sourcePath, blobSha] of Object.entries(producer.files)) {
      const copiedPath = producer.copied_root + sourcePath;
      assert.equal(
        execFileSync("git", ["rev-parse", `HEAD:${copiedPath}`], { encoding: "utf8" }).trim(),
        blobSha,
        copiedPath,
      );
    }
  }
});

test("semantic delta v1 binds exact current before/after observations and target", () => {
  const input = verificationInput();
  const delta = bindSemanticDelta("save_success.json", input, TARGET);
  const parsed = parseVisionSemanticUiDeltaV1(delta, { verificationInput: input, targetIdentity: TARGET });
  assert.equal(parsed.contract_version, "vision.semantic_ui_delta.v1");
  assert.equal(parsed.summary.semantically_meaningful, true);
  assert.equal(parsed.summary.stale, false);
  assert.equal(parsed.binding.target.element_id, TARGET.element_id);
});

test("semantic delta stale evidence is preserved and binding tamper fails closed", () => {
  const input = verificationInput();
  const stale = bindSemanticDelta("stale_capture.json", input, TARGET);
  assert.equal(parseVisionSemanticUiDeltaV1(stale, { verificationInput: input, targetIdentity: TARGET }).summary.stale, true);
  const bad = structuredClone(stale);
  bad.binding.after_snapshot_sha256 = "0".repeat(64);
  assert.throws(
    () => parseVisionSemanticUiDeltaV1(bad, { verificationInput: input, targetIdentity: TARGET }),
    (error) => error instanceof ConformanceValidationError && error.code === "VISION_SENSOR_BINDING_MISMATCH",
  );
});

test("observation consistency v1 derives and validates consistent/conflict/stale states", () => {
  const input = verificationInput();
  for (const [name, expected] of [
    ["matching_save_flow.json", "consistent"],
    ["semantic_delta_contradiction.json", "conflict"],
    ["stale_screenshot.json", "stale"],
  ]) {
    const delta = bindSemanticDelta("save_success.json", input, TARGET);
    const consistency = bindObservationConsistency(name, { input, semanticDelta: delta, target: TARGET });
    const parsed = parseVisionObservationConsistencyV1(consistency, {
      afterSnapshot: input.after,
      verificationInput: input,
      semanticDelta: delta,
      targetIdentity: TARGET,
    });
    assert.equal(parsed.status, expected);
  }
});

test("observation consistency rejects status/findings and target binding tamper", () => {
  const input = verificationInput();
  const delta = bindSemanticDelta("save_success.json", input, TARGET);
  const payload = bindObservationConsistency("matching_save_flow.json", { input, semanticDelta: delta, target: TARGET });
  payload.status = "conflict";
  assert.throws(() => parseVisionObservationConsistencyV1(payload), ConformanceValidationError);

  const targetBad = bindObservationConsistency("matching_save_flow.json", { input, semanticDelta: delta, target: TARGET });
  targetBad.binding.target = { element_id: "uia:other", node_id: "other", automation_id: "other" };
  assert.throws(
    () => parseVisionObservationConsistencyV1(targetBad, {
      afterSnapshot: input.after,
      verificationInput: input,
      semanticDelta: delta,
      targetIdentity: TARGET,
    }),
    (error) => error.code === "VISION_SENSOR_BINDING_MISMATCH",
  );
});

function request() {
  const input = verificationInput();
  return {
    action: { id: "sensor-contract", type: "vision.target.invoke" },
    verification: {
      input: {
        verificationInput: input,
        verificationInputCanonicalJson: readVisionText("post_action_verification_result_v1/verification_input.json"),
        targetIdentity: TARGET,
      },
    },
  };
}

test("sensor reconciliation maps consistent+verified to success without side-effect authority", async () => {
  const adapter = new VisionSensorReconciliationAdapter({ readEvidence: async () => sensorBundle() });
  const result = await adapter.verify(request(), {});
  assert.equal(result.ok, true);
  assert.equal(result.status, "verified");
  assert.equal(result.consistencyStatus, "consistent");
});

for (const [consistency, expectedStatus, expectedCode] of [
  ["semantic_delta_contradiction.json", "inconclusive", "VISION_OBSERVATION_CONFLICT"],
  ["stale_screenshot.json", "stale", "VISION_SENSOR_STALE"],
]) {
  test(`sensor reconciliation maps ${consistency} to read-only ${expectedStatus}`, async () => {
    const adapter = new VisionSensorReconciliationAdapter({
      readEvidence: async () => sensorBundle({ consistency }),
    });
    const result = await adapter.verify(request(), {});
    assert.equal(result.ok, false);
    assert.equal(result.retryable, true);
    assert.equal(result.status, expectedStatus);
    assert.equal(result.code, expectedCode);
  });
}

test("sensor reconciliation wrong target binding throws fail-closed sensor evidence error", async () => {
  const adapter = new VisionSensorReconciliationAdapter({ readEvidence: async () => wrongTargetBundle() });
  await assert.rejects(
    adapter.verify(request(), {}),
    (error) => error.category === "sensor_evidence_invalid" && error.dispatchState === "not_dispatched",
  );
});
