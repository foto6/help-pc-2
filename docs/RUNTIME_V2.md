# Resilient PC Control Runtime v2

## Lifecycle

Actions can move through `queued -> leased -> executing -> verifying -> succeeded`. Retryable failures move to `retry_wait`; policy blocks, cancellation, and exhausted/non-retryable failures terminate as `blocked`, `cancelled`, or `failed`. The legacy `awaiting_confirmation` gate remains for backward compatibility before `queued`.

A lease records worker ownership and expiry. Persisted `leased`, `executing`, or `verifying` work is recovered on restart: never-started leases return to `queued`; interrupted attempts enter bounded `retry_wait` or `failed` at the attempt limit. Explicit lease-expiry recovery provides the same behavior while a process remains alive.

## Durability

`JsonStateStore` atomically persists version-2 state. Session ownership, queue state, idempotency keys, attempt counts, retry deadlines, metrics, and action correlation IDs survive restart. Corrupt or unsupported persisted state fails closed with `STATE_CORRUPTED`/`STATE_VERSION_UNSUPPORTED`; it is never silently reset.

`JsonlAuditTimeline` is append-only. Audit entries carry correlation IDs but redact metadata keys commonly associated with credentials, tokens, CAPTCHA values, text-entry values, and secrets. Long strings are bounded.

## Resource ownership and lanes

Desktop ownership remains session-exclusive. Action leases additionally lock provider-neutral runtime lanes:

- `keyboard-mouse:<desktop>` for keyboard, mouse, UIA side effects, and `vision.target.invoke`;
- `observation:<desktop>` for screenshot/window/UIA observation;
- `shell:<desktop>` for shell work;
- `resource:<custom>` when callers supply a resource key;
- a conservative `desktop-action:<desktop>` fallback for uncategorized actions.

Locks are released on success, failure, cancellation, retry scheduling, lease expiry, and restart recovery.

## Retry and cancellation

Retries are bounded by `maxAttempts`. Automatic retry requires a structured error with `retryable: true`. `policy_blocked`, cancellation/abort, malformed results, and ordinary non-retryable failures never auto-retry. `retryDelayMs` controls the durable `retry_wait` deadline.

Cancelling queued/retry/leased work terminates it immediately and releases locks. Cancelling executing/verifying work aborts the provider `AbortSignal`; the resulting state is `cancelled`, never a retry.

## Executor and verification boundaries

`HelpPc1Adapter` retains the frozen Executor envelope:

```json
{"request_id":"...","action":"vision.target.invoke","params":{},"dry_run":true}
```

Dry-run remains adapter configuration and defaults true. Frozen Executor blocked results remain non-retryable provider failures for A3 compatibility. Future structured Executor errors can opt into bounded retry only with explicit retry metadata.

Verification is a separate generic provider boundary. An ActionSpec may add:

```json
{"verification":{"provider":"vision-2","type":"post_action.observe","input":{}}}
```

The core only consumes `{ok, code, category, retryable, ...}` verification results. It does not interpret Vision target semantics or confidence rules.

## Simulation and failure injection

`createSimulationRuntime()` wires `FakeExecutorAdapter` and `FakeVisionObservationAdapter` in dry-run mode. Tests cover executor timeout, stale/ambiguous verification, process crash recovery, cancellation races, duplicate requests, lease expiry, and corrupted persisted state.

## Metrics

`runtime.metrics` reports queue, execution, and verification duration counts/totals/max/average plus retry, cancellation, and lease-expiry counters. Metrics are persisted with runtime state.

## Backward compatibility and migration

Existing constructor usage, session/action methods, `processNext()`, `drain()`, ActionSpec fields, RPC names, and MCP projection remain supported. Version-1 snapshots are migrated in memory to version 2; legacy `running` becomes `executing`, action lanes/correlation IDs are derived, and existing idempotency mappings are retained. The `awaiting_confirmation` compatibility gate remains. Runtime v2 adds new states and fields, so clients should treat unknown future statuses as non-terminal unless the API documents otherwise.

No migration enables credentials, CAPTCHA handling, coordinate fallback, destructive defaults, or protected-path access.
