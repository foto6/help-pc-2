import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  ConformanceValidationError,
  parseExecutorExecutionContextBindingV1,
  parseExecutorExecutionContextValidationV1,
  parseVisionObservationEpochV1,
  parseVisionTargetLivenessV1,
  validateVisionTargetLivenessV1,
} from "../../src/index.js";
import {
  contextMismatchValidation,
  epochPair,
  executionContextBinding,
  groundedTargetFromSnapshot,
  observationEpochCorpus,
  readExecutorCurrentJson,
  targetLivenessLease,
  verificationInput,
} from "../support/context-epoch-fixtures.js";

const provenance = JSON.parse(
  readFileSync(new URL("../../conformance/CONTEXT_EPOCH_PROVENANCE.json", import.meta.url), "utf8"),
);

test("Wave 9 provenance pins exact producer fixture bytes at exact producer heads", () => {
  assert.equal(provenance.executor.commit_sha, "2cc1e40f792a3d74560b726a0d246c90b7f077e9");
  assert.equal(provenance.executor.ci_run_id, 36318986551);
  assert.equal(provenance.vision.commit_sha, "51b96fb41cb72cdfc4a03129d14b9afc5fe750fd");
  assert.equal(provenance.vision.ci_run_id, 36317785328);
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

test("Executor producer UIA/foreground/shell execution-context fixtures parse strictly", () => {
  for (const [name, kind] of [
    ["uia.binding.json", "uia"],
    ["foreground.binding.json", "foreground"],
    ["shell.binding.json", "shell"],
  ]) {
    const parsed = parseExecutorExecutionContextBindingV1(
      readExecutorCurrentJson(`execution_context_binding_v1/${name}`),
    );
    assert.equal(parsed.contract_version, "pc_executor.execution_context_binding.v1");
    assert.equal(parsed.context_kind, kind);
    assert.match(parsed.context_digest, /^[0-9a-f]{64}$/);
  }
});

test("Executor context binding rejects version, digest, request and action mismatch", () => {
  const base = executionContextBinding("ctx-contract");
  const cases = [
    (p) => { p.contract_version = "pc_executor.execution_context_binding.v2"; },
    (p) => { p.context_digest = "0".repeat(64); },
    (p) => { p.window.window_handle = 999; },
  ];
  for (const mutate of cases) {
    const payload = structuredClone(base);
    mutate(payload);
    assert.throws(() => parseExecutorExecutionContextBindingV1(payload), ConformanceValidationError);
  }
  assert.throws(
    () => parseExecutorExecutionContextBindingV1(base, { requestId: "other", action: "vision.target.invoke" }),
    (error) => error.code === "EXECUTOR_CONTEXT_BINDING_MISMATCH",
  );
  assert.throws(
    () => parseExecutorExecutionContextBindingV1(base, { requestId: "ctx-contract", action: "uia.invoke" }),
    (error) => error.code === "EXECUTOR_CONTEXT_BINDING_MISMATCH",
  );
});

test("Executor context mismatch validation is bound to exact context digest and safe pre-dispatch semantics", () => {
  const binding = executionContextBinding("ctx-validation");
  const validation = contextMismatchValidation(binding, ["process.start_epoch_ms"]);
  const parsed = parseExecutorExecutionContextValidationV1(validation, {
    bindingDigest: binding.context_digest,
  });
  assert.equal(parsed.status, "blocked");
  assert.equal(parsed.reason, "context_mismatch");
  assert.equal(parsed.adapter_dispatch_started, false);
  assert.equal(parsed.reexecution_safe, true);
  assert.deepEqual(parsed.mismatches, ["process.start_epoch_ms"]);

  const wrong = structuredClone(validation);
  wrong.binding_digest = "0".repeat(64);
  assert.throws(
    () => parseExecutorExecutionContextValidationV1(wrong, { bindingDigest: binding.context_digest }),
    (error) => error.code === "EXECUTOR_CONTEXT_BINDING_MISMATCH",
  );
});

test("Vision producer epoch scenario corpus preserves replacement and benign-change semantics", () => {
  const corpus = observationEpochCorpus();
  assert.equal(corpus.contract_version, "vision.observation_epoch_fixture_corpus.v1");
  assert.equal(corpus.scenarios.process_restart_same_title.expected_relation, "replaced");
  assert.equal(corpus.scenarios.process_restart_same_title.expected_reason, "process_start_epoch_changed");
  assert.equal(corpus.scenarios.window_recreated_same_automation_ids.expected_relation, "replaced");
  assert.equal(corpus.scenarios.window_recreated_same_automation_ids.expected_reason, "window_identity_changed");
  assert.equal(corpus.scenarios.moving_window.expected_relation, "same");
  assert.equal(corpus.scenarios.moving_window.epoch_changed, false);
  assert.equal(corpus.scenarios.minimize_restore.expected_relation, "same");
});

test("synthetic same/process-restart/window-replacement epoch records enforce producer transition rules", () => {
  for (const [mode, relation, reason] of [
    ["same", "same", null],
    ["process_restart", "replaced", "process_start_epoch_changed"],
    ["window_replaced", "replaced", "window_identity_changed"],
  ]) {
    const { before, after } = epochPair(mode);
    const parsedBefore = parseVisionObservationEpochV1(before, { snapshot: verificationInput().before });
    const parsedAfter = parseVisionObservationEpochV1(after, {
      snapshot: verificationInput().after,
      previousEpoch: before,
    });
    assert.equal(parsedBefore.relation, "initial");
    assert.equal(parsedAfter.relation, relation);
    if (reason === null) assert.deepEqual(parsedAfter.transition_reasons, []);
    else assert.ok(parsedAfter.transition_reasons.includes(reason));
  }
});

test("Vision epoch parser rejects wrong version, digest and forged transition reason", () => {
  const { before, after } = epochPair("process_restart");
  const wrongVersion = structuredClone(after);
  wrongVersion.contract_version = "vision.observation_epoch.v2";
  assert.throws(() => parseVisionObservationEpochV1(wrongVersion), ConformanceValidationError);

  const wrongDigest = structuredClone(after);
  wrongDigest.stable_identity_sha256 = "0".repeat(64);
  assert.throws(() => parseVisionObservationEpochV1(wrongDigest), ConformanceValidationError);

  const forged = structuredClone(after);
  forged.transition_reasons = ["window_identity_changed"];
  assert.throws(
    () => parseVisionObservationEpochV1(forged, {
      snapshot: verificationInput().after,
      previousEpoch: before,
    }),
    (error) => error.code === "VISION_EPOCH_TRANSITION_MISMATCH",
  );
});

test("target liveness is live in same epoch and stale across process/window replacement", () => {
  const input = verificationInput();
  const target = groundedTargetFromSnapshot(input.before);

  const same = epochPair("same");
  const sameLease = targetLivenessLease(target, same.before);
  assert.equal(parseVisionTargetLivenessV1(sameLease).contract_version, "vision.target_liveness.v1");
  const live = validateVisionTargetLivenessV1(sameLease, target, same.after);
  assert.equal(live.status, "live");

  for (const mode of ["process_restart", "window_replaced"]) {
    const epochs = epochPair(mode);
    const lease = targetLivenessLease(target, epochs.before);
    const result = validateVisionTargetLivenessV1(lease, target, epochs.after);
    assert.equal(result.status, "stale");
    assert.ok(result.reasons.includes("observation_epoch_changed"));
  }
});

test("target liveness wrong version/digest fails closed or reports stale", () => {
  const input = verificationInput();
  const target = groundedTargetFromSnapshot(input.before);
  const epochs = epochPair("same");
  const lease = targetLivenessLease(target, epochs.before);

  const wrongVersion = structuredClone(lease);
  wrongVersion.contract_version = "vision.target_liveness.v2";
  assert.throws(() => parseVisionTargetLivenessV1(wrongVersion), ConformanceValidationError);

  const wrongDigest = structuredClone(lease);
  wrongDigest.target_sha256 = "0".repeat(64);
  assert.equal(validateVisionTargetLivenessV1(wrongDigest, target, epochs.after).status, "stale");
});
