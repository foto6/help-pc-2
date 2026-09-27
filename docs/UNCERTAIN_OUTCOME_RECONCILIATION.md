# Uncertain-outcome reconciliation

Wave 3 closes the at-most-once correctness gap for interrupted side-effect dispatch.

## Counter ownership

The runtime persists three independent counters:

- `executionAttempts`: entries into the side-effect provider boundary. `attempts` remains only as a backward-compatible alias of this counter.
- `verificationAttempts`: read-only post-action verification calls.
- `reconciliationAttempts`: read-only reconciliation leases/cycles after an outcome becomes uncertain or verification is interrupted/inconclusive.

Verification/reconciliation never increment `executionAttempts` and never call the side-effect provider's `execute()` method.

## States and transitions

Execution path:

`queued -> leased(mode=execute) -> executing`

A returned successful provider result becomes `verifying` when a verifier is configured, then `succeeded` on positive evidence. A stale/inconclusive verifier result becomes `reconciliation_wait`; it does not return to `queued` or `retry_wait`.

A lease that expires before execution starts is safe to return to `queued`. Once `executing` has begun, process restart, lease expiry, cancellation race, transport failure, timeout, malformed response, or any failure without explicit `dispatchState="not_dispatched"` enters:

`executing -> uncertain_outcome -> leased(mode=reconcile) -> reconciling`

Read-only reconciliation may consume two evidence boundaries:

1. optional provider `readOutcomeEvidence()` records (for example an Executor evidence fixture/journal adapter if one exists externally);
2. the existing provider-neutral post-action verifier (for example a future Vision verification v2 adapter).

The control plane does not claim that PC Executor `b3f126f18b17e1a8fc10fc19a4a4abd9efa82bad` exposes a durable outcome journal. Its current `ActionResult` is normalized into an evidence record when a response is actually received. A separate `readEvidence` function must be explicitly injected to query any future/read-only evidence source.

## Retry ownership

A fresh side-effect execution retry is allowed only when a structured provider error explicitly proves `dispatchState="not_dispatched"` and marks the error retryable. Policy blocks are never retried.

After dispatch may have happened, stale/inconclusive evidence can only cause bounded read-only reconciliation/reverification. Exhaustion leaves the action in `uncertain_outcome` with `RECONCILIATION_EXHAUSTED`; it does not re-execute.

If read-only evidence conclusively says the side effect was not applied, the original logical action terminates (`cancelled` when cancellation was requested, otherwise `failed`). A new side effect requires a newly enqueued logical action with a new action id and, when idempotency is used, a distinct idempotency key. Duplicate submission of the original key continues to resolve to the original action across restart.

## Current Executor compatibility

`HelpPc1Adapter` continues to emit the exact request envelope:

```json
{"request_id":"...","action":"...","params":{},"dry_run":true}
```

The adapter accepts the current Executor `ActionResult` fields including `status` and `error_kind`. `stale_target`, `ambiguous_target`, and policy-blocked results are treated as known non-dispatch outcomes; `timeout`, `cancelled`, `transient`, and `executor_failure` are conservative unknown outcomes unless separate evidence proves otherwise.

## Safety invariants

Dry-run remains the Executor adapter default. Credential/CAPTCHA action rejection, destructive-actions-disabled-by-default, lane ownership, durable idempotency, and audit redaction remain unchanged. Reconciliation is read-only by contract and never authorizes coordinate fallback or a new side effect.
