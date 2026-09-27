# PC Control Plane

Provider-neutral coordinator and reliability layer for full-PC agent control.

Runtime v2 adds durable sessions/actions, leases and restart recovery, idempotency across restarts, lane locking, bounded structured retries, cancellation propagation, generic post-action verification hooks, dry-run simulation adapters, append-only audit, and runtime metrics.

Safety baseline remains unchanged: execution is delegated to the Executor; no credential/CAPTCHA automation; destructive actions are disabled by default; never touch `E:\\manhwa`.

See `docs/RUNTIME_V2.md` and `docs/ARCHITECTURE.md`.
