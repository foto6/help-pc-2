# Native MCP R28 — independent relay freshness QA

Decision: **WAITING_FOR_LIVE_HEALTH_EVIDENCE**. Release gate remains **NO_LIVE_CUTOVER**.

R28 independently consumes the new durable `pc_relay.health.v1` evidence from the stale-sync watchdog producer. It exists because PID/process presence proved insufficient: a relay process remained alive while its local queue checkout stopped advancing.

## Exact producer authority

- repository: `foto6/help-pc-1`
- branch: `agent/pc-relay-stale-sync-watchdog-20261001`
- exact producer SHA: `2158066be7f4141c70e9bf24f6138d399bff7164`
- exact-head producer CI: `36885427807`
- contract: `pc_relay.health.v1`
- schema blob: `2a2f4e88e3b483db768fc95972c2ed25fa9a187e`
- producer-pin blob: `935940dfc0678c65fa76db3a2c1d0364de4fbe8f`
- relay implementation blob: `d10c3064ae21833cc7288d37adead7dc0f67e15d`
- launcher blob: `c9545f09b8dc6eb2d10cf1903736e95829cbaba0`

The exact producer schema and producer pin are vendored byte-identically under `conformance/r28_relay_freshness/`.

## Incident encoded

The deterministic stale fixture represents the observed failure:

- live `py.exe -> python.exe` process chain;
- local HEAD `be374169e51309bbc943f68e7965f23f53c85380`;
- independently observed remote HEAD `e29d3746d2fbdc35b26e4b0725a63b78100a07c6`;
- 576 request files / 554 results / backlog 22;
- empty stderr;
- manual fetch succeeded;
- no health-probe result before operator restart.

R28 must classify this as `STALE`, never healthy.

## Gate semantics

`evaluateR28RelayFreshness` returns one of:

- `HEALTHY`
- `STALE`
- `MISSING_EVIDENCE`
- `RECONCILIATION_REQUIRED`
- `BLOCKED`

A healthy mutation lane requires all of:

1. exact producer SHA/workflow/blob authority;
2. valid durable health schema;
3. one logical relay runtime;
4. optional `py.exe` wrapper may parent that runtime and is not a duplicate;
5. externally observed remote HEAD equals producer-recorded remote HEAD;
6. local HEAD equals that observed remote HEAD;
7. fresh heartbeat under phase-aware budget;
8. monotonic timestamps/counters for the same process instance;
9. consistent request/result/backlog counters;
10. no durable UNKNOWN/reconciliation requirement.

PID-only evidence is always insufficient.

## Freshness

Default freshness: 30 seconds.

Bounded execution phases `execute_request` and `reconcile_interrupted_side_effect` receive 150 seconds so an allowed long operation is not falsely declared stale merely because the relay blocks inside the executor.

## Safety

Every decision, including HEALTHY, keeps:

- `live_cutover_authorized=false`
- `automatic_restart_authorized=false`
- `automatic_kill_authorized=false`
- `automatic_replay_authorized=false`

UNKNOWN/interrupted side effects produce `RECONCILIATION_REQUIRED`.

R28 does not restart, kill, deploy, repoint, or mutate the live relay.

## Current integration state

The watchdog producer is still a development branch and has not been cut over to the running relay. Therefore the committed status is `WAITING_FOR_LIVE_HEALTH_EVIDENCE`; deterministic QA can pass while live deployment remains explicitly blocked.
