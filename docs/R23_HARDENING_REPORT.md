# Native MCP / PC Control R23 hardening report

Decision: **NO_CUTOVER**. This branch is isolated evidence and hardening only. It does not deploy, install, restart, repoint, replace, or modify the accepted live R22/current stack.

## Provenance

- Writable repository: `foto6/help-pc-2`
- R23 branch: `agent/native-mcp-r23-hardening-20261001`
- Exact R23 baseline: `47f54210128488171e34186182d6d2e382ba7552`
- R22 surface baseline manifest: `conformance/R23_R22_SURFACE_BASELINE.json`
- Read-only producer inspected for blocker analysis: `foto6/help-pc-1 agent/r22-scm-acceptance-20260930 @ 7eed906976d092e3216f50b0f52e6cb422392979`
- New synthetic R23 measurement source: `help-pc-2 @ 5a49b03c8df12ae6fb10f7cd242b3aa0556931d2`, GitHub Actions run `36799483795`, Ubuntu job `110170373834`
- Existing R22/full-surface evidence is treated as baseline only; this report does not relabel it as new R23 evidence.

No Desktop Commander was used. No access to `E:\manhwa` was performed; the protected-path regression uses a literal path string only to prove pre-dispatch rejection.

## R23 implementation

### End-to-end health model

`src/r23-health.js` defines `pc.native.health.v1`. It exposes:

- `process_alive`
- `transport_connected`
- `queue_progressing`
- `executor_responsive`
- per-adapter health and circuit state
- outcome-journal integrity state
- last successful request age
- last successful result age
- canary ages/errors
- queue depth/oldest/progress age
- bounded retained lifecycle diagnostics

The relay health implementation no longer treats process existence as sufficient. Active-delivery freshness is computed from the active deliveries themselves, so a recent unrelated completion cannot mask a stalled queue item.

### Read-only heartbeat/canary

The deterministic canary is `device.ping` routed to producer `health.get`. It is bounded by `canaryTimeoutMs`, retains the same durable logical request ID across a timeout/retry, and is advanced only through `ControlPlane.processSpecificReadOnly()`.

That exact-action lane prevents a liveness probe from advancing an older queued mutation. If `health.get` is not advertised, R23 records `R23_CANARY_CAPABILITY_UNAVAILABLE` without durable enqueue.

### Request lifecycle

`pc.native.request_lifecycle.v1` projects Control state into the requested bounded diagnostic states:

- `queued`
- `dispatched`
- `executing`
- `completed`
- `timeout`
- `unknown`
- `reconciled`

Control status endpoints include lifecycle projection, and bounded lifecycle summaries are available without unbounded history growth.

### Adapter isolation / circuit breaker

`R23AdapterCircuitRegistry` applies adapter-specific bounded execution and separate breaker state for:

- UIA
- shell
- windows
- screenshot
- input
- clipboard
- outcome journal
- filesystem
- search
- process
- Executor/control primitives

A UIA timeout opens/degrades only the UIA lane. Shell, windows, screenshot, and outcome-journal paths remain independently callable. Timed-out side effects are classified as unknown after dispatch and carry `automaticReplay=false`; a breaker can only reject a later mutation before dispatch, never authorize replay.

Frozen `system.health` / `system.config.*` and parity `health.get` / `config.*` are explicitly classified under the same Executor-health lane.

### At-most-once and crash/reboot recovery

R23 preserves the existing durable Control/relay semantics:

- a side effect with unknown post-dispatch outcome enters reconciliation;
- process/relay restart does not convert unknown into safe retry;
- `outcome.lookup`/journal evidence is read-only reconciliation;
- a duplicate logical request does not create another side effect;
- synthetic restart tests verify execution count remains one.

### Launcher/service liveness contract

`pc.native.launcher_liveness.v1` is documented in `docs/R23_LAUNCHER_LIVENESS.md`.

`already_running_healthy=true` requires a current PID identity plus a fresh authenticated health handshake. Stale PID, duplicate process, crashed/unresponsive relay, missing Executor, unavailable network, delayed transport, corrupt journal, or failed freshness gate produce `RECOVERY_REQUIRED`/machine-readable reasons.

The recovery contract has:

- `kill_existing_process=false`
- `restart_live_stack=false`
- `automatic_replay=false`

The R22 tree contains no launcher/service implementation to safely modify here, so R23 provides the versioned contract and synthetic convergence tests only.

### R22 parity freeze

`conformance/R23_R22_SURFACE_BASELINE.json` pins the accepted baseline and tests:

- 62 native Control routes total
- 37 frozen `pc.native.tool_registry.v1` routes
- 25 parity routes
- frozen PC Core digest `58b2bde8c6a49825747dcd7010f105dad0b6d548c7e8341cdafb32d2319f6dcd`
- Control registry digest `771f6d31d48fc2c89ff936f43346da11ca897d37fc84c7a9cccb08367aba837b`
- 28 mandatory Desktop Commander-compatible tools / 30 catalog semantics including two explicit vendor non-equivalents
- schema/numeric bounds
- protected-path, credential, CAPTCHA, and automatic-replay safety invariants

R23 does not rename or extend the canonical R22 tool registry.

## New R23 synthetic evidence

Measured on Ubuntu in run `36799483795`, job `110170373834`, candidate `5a49b03c8df12ae6fb10f7cd242b3aa0556931d2`:

| Metric | Focused soak |
| --- | ---: |
| Requests | 1200 |
| Read-only requests | 1152 |
| Synthetic side-effect requests | 48 |
| Injected safe read stalls | 12 |
| Injected unknown side effects | 4 |
| Journal reconciliations | 4 |
| Synthetic Control restarts | 4 |
| Max queue depth | 1 |
| Final queue depth | 0 |
| Retained action records | 1200 |
| p50 request latency | 7.312 ms |
| p95 request latency | 14.707 ms |
| Max reconciliation tick | 0.378 ms |
| Heap growth | 42,651,776 bytes |
| Active handle growth | 0 |
| Active request growth | 0 |
| Max execution count for any synthetic side effect | 1 |
| Automatic replay | false |

The same test ran again inside the full suite in that Ubuntu job: p50 8.033 ms, p95 15.999 ms, max reconciliation tick 0.592 ms, heap growth 43,249,560 bytes, active handle/request growth 0, and side-effect max execution count 1.

Focused R23 hardening and the full existing safe suite also passed in that Ubuntu job. Windows focused hardening and soak passed in the same run before the report commit; exact final-head Windows/Ubuntu results are required separately before any integration decision.

## Startup/reboot/convergence cases encoded

Synthetic tests cover:

- process alive but queue stalled
- stale PID identity
- duplicate process
- relay unresponsive/crashed
- Executor absent
- network unavailable
- delayed transport convergence
- journal present/unknown/corrupt states
- stalled transport health probe
- timed-out canary with stable logical identity
- Control restart after unknown mutation
- safe read-only retry after confirmed pre-dispatch stall
- UIA breaker isolation from shell/windows/screenshot/outcome lanes

No test starts/stops a production service or touches the live stack.

## help-pc-1 producer blockers

These remain **producer-side** and are not changed in R23.

At read-only producer SHA `7eed906976d092e3216f50b0f52e6cb422392979`:

1. `src/pc_executor/capabilities.py` exposes static adapter availability and `operation_timeout_ms`, but not dynamic per-adapter responsiveness, timeout counters, breaker state, or last-success/last-failure timestamps.
2. `src/pc_executor/operations.py::_health()` returns `status=ok` plus managed process/search counts and generation ID. It does not expose runtime health for UIA/screenshot/windows/shell/clipboard/input adapters or outcome-journal integrity.
3. `src/pc_executor/uia.py` performs the real UIA tree walk. The observed Chrome/File Explorer snapshot timeouts therefore cannot be repaired in this consumer repository. R23 can bound the call and isolate the UIA lane, but it cannot make the producer UIA implementation responsive.
4. The outcome journal provides strict read-only lookup/corruption semantics, but the current producer health payload does not expose a proactive journal-integrity field.

A future help-pc-1 producer change should provide a versioned, read-only runtime adapter-health snapshot (or extend an existing producer health contract) with bounded/cancellable probes and explicit journal integrity. R23 must consume that exact producer contract rather than inventing health evidence.

## Changed files relative to exact R23 baseline

- `.github/workflows/ci.yml`
- `conformance/R23_R22_SURFACE_BASELINE.json`
- `docs/R23_HARDENING_REPORT.md`
- `docs/R23_LAUNCHER_LIVENESS.md`
- `package.json`
- `src/adapters.js`
- `src/control-plane.js`
- `src/index.js`
- `src/mcp-host.js`
- `src/mcp-runtime-config.js`
- `src/native-facade.js`
- `src/native-relay-provider.js`
- `src/native-relay-server.js`
- `src/r23-health.js`
- `test/r23-hardening.test.js`
- `test/r23-mcp-health.integration.test.js`
- `test/r23-soak-chaos.test.js`
- `test/r23-surface-baseline.test.js`

## Cutover decision

**NO_CUTOVER.**

Reasons:

- the milestone explicitly requires independent verification;
- the live R22/current stack was not modified or exercised by this branch;
- producer-side UIA runtime health/timeout behavior remains a help-pc-1 blocker;
- launcher integration must consume `pc.native.launcher_liveness.v1` in a separately verified change rather than being applied to the live stack from this branch.
