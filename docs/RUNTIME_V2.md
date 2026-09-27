# Resilient PC Control Runtime v2

Runtime v2 provides durable sessions/actions, leases, lane locks, idempotency, cancellation, provider-neutral verification, audit, metrics and RPC/MCP projection. Wave 3 strengthens its recovery semantics without rebuilding those abstractions.

## Lifecycle

Normal execution is `queued -> leased -> executing -> verifying -> succeeded`. `awaiting_confirmation`, `retry_wait`, `blocked`, `cancelled`, and `failed` remain supported.

Wave 3 adds `uncertain_outcome`, `reconciliation_wait`, and `reconciling`. A never-started execution lease may return to `queued`. An interrupted `executing` action never automatically returns to the execution queue; it enters read-only reconciliation. Interrupted verification also resumes read-only reconciliation.

See `UNCERTAIN_OUTCOME_RECONCILIATION.md` for exact transition and retry ownership rules.

## Persistence and compatibility

Persisted state is version 3. Version 1/2 snapshots are migrated in memory. Legacy `attempts` is retained as an alias of `executionAttempts`; verification and reconciliation have separate persisted counters. Existing ActionSpec/RPC/MCP names remain available.

`JsonStateStore` remains atomic and fails closed on corrupt state. `JsonlAuditTimeline` remains append-only and redacts secret/token/password/CAPTCHA/text/value-like metadata.

## Provider boundaries

`HelpPc1Adapter` preserves the existing Executor request envelope and dry-run default. Current Executor `b3f126f...` response fields are normalized into evidence without assuming an Executor-internal journal. Optional `readEvidence` is an injected read-only boundary only.

Verification remains provider-neutral; future Vision verification v2 fixtures can be supplied through the same `verify()` contract.

## Safety

No credential/CAPTCHA automation, no destructive default actions, no implicit coordinate fallback, and no protected-path access are introduced by reconciliation.
