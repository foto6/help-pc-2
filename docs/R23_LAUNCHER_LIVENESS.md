# R23 launcher/service liveness contract

Contract: `pc.native.launcher_liveness.v1`

This is an isolated R23 consumer contract. It does not install, stop, restart, repoint, or replace any service. The live R22/current stack remains outside this branch.

## Rule

A PID/process existing is **not** sufficient evidence that the native lane is healthy. A launcher may report `already_running_healthy=true` only when all of the following are true:

- the process exists and its recorded PID identity is current;
- no duplicate process is detected;
- the relay/control health endpoint is responsive;
- the Executor/device is present;
- transport/network convergence has completed;
- the authenticated `pc.native.health.v1` snapshot is `HEALTHY`;
- the journal is not known corrupt.

Otherwise the contract returns `RECOVERY_REQUIRED` (or `STOPPED` when the process is absent) with machine-readable reasons such as:

- `STALE_PID_IDENTITY`
- `DUPLICATE_PROCESS`
- `RELAY_UNRESPONSIVE`
- `EXECUTOR_ABSENT`
- `NETWORK_UNAVAILABLE`
- `TRANSPORT_NOT_CONVERGED`
- `JOURNAL_CORRUPT`
- `FRESHNESS_HANDSHAKE_FAILED`
- `STARTUP_CONVERGENCE_TIMEOUT`

## Safe recovery boundary

The contract never kills an existing process and never restarts the live stack. Its recovery object is deliberately fixed to:

- `kill_existing_process=false`
- `restart_live_stack=false`
- `automatic_replay=false`

An operator/launcher integration must inspect authenticated health/queue freshness, reconcile any `UNKNOWN` side effect with `outcome.lookup`, and only then use a separately verified recovery procedure.

## Freshness and canary

R23 health distinguishes:

- `process_alive`
- `transport_connected`
- `queue_progressing`
- `executor_responsive`
- per-adapter breaker/timeout state
- outcome-journal integrity
- last successful request/result age

The deterministic liveness canary is a read-only `device.ping` / `health.get` request. Its durable logical request ID is reused across timeout/retry until the same canary completes. It is processed through an exact-action read-only queue lane, so a health probe cannot advance an unrelated queued mutation.

If the producer does not advertise `health.get`, R23 records `R23_CANARY_CAPABILITY_UNAVAILABLE` without durable enqueue or synthetic execution.

## Queue-progress semantics

Relay health computes freshness from active deliveries themselves. A recent completion cannot mask a different active delivery that stopped progressing. When an active delivery exceeds the heartbeat freshness bound, the relay reports `queue_progressing=false` and `status=degraded` even if its process remains alive.

## Integration status

There is no launcher/service implementation in the R22 `help-pc-2` tree at baseline `47f54210128488171e34186182d6d2e382ba7552`. R23 therefore provides the versioned liveness decision contract and deterministic synthetic convergence tests only. It deliberately does not modify any live launcher or service.
