# Frozen cross-repo PC reconciliation conformance gate

This gate freezes consumer compatibility to:

- PC Executor `606074456ca00681fac30a40ee28f7bb0f67c79c` — `pc_executor.action_outcome.v1`.
- Vision `f20e2c2e35cbcb9b675c9c1a0568de2e40b5eb82` — `vision.post_action_verification_result.v1`, `vision.post_action_verification_input.v1`, and `vision.perception_snapshot.v2`.

No sibling repository is imported at runtime. Exact upstream fixture bytes live under `conformance/frozen/`; `conformance/PROVENANCE.json` records repository, source commit, source path, copied path, and authoritative Git blob SHA-1. The conformance tests recompute every Git blob hash.

## Consumer rules

`parseExecutorActionOutcomeV1()` requires the exact v1 field set, known side-effect actions/reasons, boolean flag types, state/flag consistency, and optional request/action binding. Its adapter mapping is:

- `not_started -> not_dispatched`;
- `completed -> succeeded`;
- `unknown -> unknown`.

The Executor adapter prefers this frozen outcome record when present. A `not_started` response can re-enter bounded execution retry only for the already-allowed pre-dispatch retry classes (`transient` or `timeout`). `completed` and `unknown` never authorize execution replay. Legacy Executor responses without `outcome_evidence` retain the Wave-3 compatibility path.

`parseVisionVerificationResultV1()` requires the exact result shape, known status, canonical sorted/unique reason arrays, finite range-bounded numeric evidence, status/evidence consistency, exact target identity fields, and SHA-256 binding to the supplied verification input. It recomputes both the canonical verification-input digest and expectation digest, then compares the exact before/after frame id, sequence and image digest.

`VisionVerificationResultV1Adapter` is read-only:

- `verified -> success`;
- `stale -> recapture/reverify only`;
- `inconclusive -> bounded reverify only`;
- `failed -> terminal verification failure`.

None of those result statuses authorizes a side-effect call.

## Frozen flow gate

The deterministic tests cover:

1. `not_started` + retryable pre-dispatch failure -> bounded execution retry;
2. `completed` -> verification/reverification only;
3. `unknown` -> `uncertain_outcome` -> read-only evidence and verification reconciliation;
4. `stale` -> reverify only;
5. `inconclusive` -> bounded reverify only;
6. `failed` -> terminal failure without implicit replay;
7. `verified` -> original logical action succeeds.

Restart tests cover leased, executing, provisional unknown, uncertain outcome, reconciling, verifying, reconciliation wait, and all terminal states. Bounded state-machine sequences assert that uncertain/completed work never receives an execution lease after restart or reconciliation events.

The deterministic report fixture is `conformance/reports/frozen-pc-reconciliation-e2e.json`. It records exact execution/verification/reconciliation counters and audit transition trace.

Existing safety semantics are unchanged: dry-run remains the Executor default, durable idempotency and lane locks remain active, audit metadata remains redaction-safe, credential/CAPTCHA automation is rejected, destructive actions are disabled by default, and `E:\\manhwa` remains out of scope.
