# Native R29 independent relay cutover/autostart QA

Repository: `foto6/help-pc-2`  
Branch: `agent/native-mcp-r29-relay-cutover-qa-20261002`  
Exact starting HEAD: `d777a8d8f5e42904e7b88f9223a3c426bc808090`

## Producer authority

R29 is source-bound to one immutable producer commit only:

- repository: `foto6/help-pc-1`
- branch label: `agent/pc-relay-watchdog-cutover-candidate-20261002`
- exact SHA: `6f44216e7e5fbf9fe3ae635f302c3c33887e0930`
- exact-head CI: `36967056910` SUCCESS
- Windows job `110712982244`: focused 41 passed, full 228 passed, plan-only marker `CUTOVER_CANDIDATE_POWERSHELL_PLAN_ONLY_PASS`
- Ubuntu job `110712982382`: focused 41 passed, full 228 passed

The QA bundle vendors committed producer blobs fetched by the exact SHA. Each vendored file is checked against the producer Git blob SHA; moving branch refs are not QA authority.

## Independent safety checks

The R29 classifier independently replays the recorded 2026-10-01 stale-sync fixture. A live `py.exe -> python3.13.exe` chain is one logical relay, but PID/process existence is not health. The recorded incident must classify `STALE`; forward progress must classify `HEALTHY`; an interrupted post-reboot side effect must classify `RECONCILIATION_REQUIRED`.

The relay source is checked for durable interrupted-side-effect reconciliation through `outcome.lookup`, the original request ID, `reexecuted=false`, and `replay_authorized=false`. Recovery or reboot liveness never turns an unknown outcome into permission to execute the side effect again.

The Windows installer is checked as explicit-`-Apply`, exact-HEAD/branch/clean-checkout guarded, per-user AtLogOn, delayed, Interactive/Limited, `MultipleInstances IgnoreNew`, and non-starting at registration time. The uninstall path refuses a running matching relay and preserves `.pc-relay/state` and `.pc-relay/outcomes.jsonl`.

Rollback is checked for a clean checkout, exact previous `origin/agent/pc-github-relay` pin, relay absence, task unregister only after explicit apply, detached checkout of the exact previous SHA, no branch rewrite, no automatic process kill, no relay start, no side-effect replay, and journal/state preservation.

The launcher is checked to accept only proven `HEALTHY`; existing-but-unproven, stale, duplicate, reconciliation, failed-start and degraded paths remain blocked. Log rotation is bounded at 5,242,880 bytes per active stdout/stderr log with three backups.

## Mutation boundary

This milestone does not execute any producer PowerShell script. It does not pass `-Apply`, register/unregister a task on the live PC, create a service, start/stop/kill a live relay, modify the live relay branch, or authorize a cutover.

If every source-bound gate passes, the QA decision is `READY_FOR_EXPLICIT_CUTOVER_DECISION` while `live_cutover_authorized=false`, `mutation_execution_authorized=false`, and release gate remains `NO_LIVE_CUTOVER`. Any blob drift or safety-gate failure returns `BLOCKED` with exact gate identifiers.
