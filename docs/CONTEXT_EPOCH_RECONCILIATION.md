# Wave 9 execution-context and Vision-epoch reconciliation

Wave 9 extends the frozen Wave 8 readiness gate. It consumes exact producer contracts from:

- PC Executor `foto6/help-pc-1 agent/pc-executor @ 2cc1e40f792a3d74560b726a0d246c90b7f077e9`, CI `36318986551`;
- Vision `foto6/vision-2 agent/vision @ 51b96fb41cb72cdfc4a03129d14b9afc5fe750fd`, CI `36317785328`.

Exact fixture bytes are copied under SHA-qualified `conformance/frozen/` roots. Their source paths and Git blob SHA-1s are recorded in `conformance/CONTEXT_EPOCH_PROVENANCE.json`. No sibling repository is imported at runtime.

## Lifecycle binding

For providers that publish the optional Executor context contract, a ready Control action now binds a read-only `pc_executor.execution_context_binding.v1` after preflight and persists its digest with the action. The exact binding is sent in the subsequent Executor action request.

Control does not independently decide whether operating-system context still matches. Executor remains authoritative and performs its own last-moment read-only validation immediately before adapter dispatch. Control only consumes the returned `pc_executor.execution_context_validation.v1` record and the frozen action-outcome/journal evidence.

A context mismatch is eligible for read-only target reacquisition and re-preflight only when durable journal evidence also confirms safe `not_started`. If the journal is unknown, completed, corrupt, or otherwise does not prove safe not-started, Control never replays the side effect and enters reconciliation/fail-closed handling instead.

UIA geometry/display movement is not authoritative in the producer binding, so benign move/resize of the same process/window/target does not fail the context gate.

## Vision epoch and liveness

Wave 9 also consumes:

- `vision.observation_epoch.v1`;
- `vision.target_liveness.v1`;
- existing `vision.observation_consistency.v1`;
- existing `vision.semantic_ui_delta.v1`;
- existing `vision.post_action_verification_result.v1`.

Epoch and liveness evidence are read-only. A prior-epoch target lease is stale even when labels or automation ids look identical. After a completed side effect, an epoch replacement causes recapture/reacquisition/reverification only; it never authorizes re-execution. A read-only reacquired grounded target may carry a new epoch lease, but its target identity must still match the exact verification target.

Process restart and top-level window replacement roll the epoch. Producer-declared benign move/resize, minimize/restore and ordinary child/content churn remain same-epoch cases.

## Durable state and counters

Persisted action state adds:

- execution-context binding + digest;
- execution-context validation record;
- independent `contextBindingAttempts`;
- independent `contextValidationAttempts`.

Those counters remain separate from observation, preflight, execution, reconciliation and verification attempts. Restart tests cover preflight wait, queued-ready, executing, uncertain outcome, reconciling, verifying and post-verification evidence before terminalization.

## Safety

Existing semantics remain unchanged: default Executor dry-run behavior, durable idempotency, lane ownership, bounded cancellation/retry, audit redaction, credential/CAPTCHA rejection and destructive-actions-disabled defaults. Context and epoch evidence never grant side-effect authority.

Run:

```sh
npm run test:context-epoch
npm run test:e2e
npm run test:preflight
npm run test:journal
npm test
```

Canonical report: `conformance/reports/context-epoch-e2e-v1.json`.
