# PC Control Plane

Provider-neutral reliability layer for full-PC agent control.

Runtime v2 provides durable sessions/actions, leases, restart recovery, idempotency, lane locking, cancellation, generic verification, dry-run simulation, redacted append-only audit and metrics. Wave 3 adds uncertain-outcome reconciliation so interrupted side-effect dispatch is never blindly replayed.

Safety baseline: execution remains delegated to the Executor; no credential/CAPTCHA automation; destructive actions are disabled by default; never touch `E:\manhwa`.

See `docs/RUNTIME_V2.md`, `docs/UNCERTAIN_OUTCOME_RECONCILIATION.md`, and `docs/ARCHITECTURE.md`.
