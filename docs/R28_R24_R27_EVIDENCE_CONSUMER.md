# Native MCP R28 — exact Bridge R24 + PC Relay R27 evidence consumer

Decision for this milestone: **NO_LIVE_CUTOVER**.

R28 upgrades the R27 cutover authority layer to consume the new exact producer
evidence contracts instead of using a locally reconstructed Bridge preflight
shape and the direct R26 relay-progress view alone.

No live Bridge or PC Control process is stopped, restarted, killed, repointed,
deployed, or modified by this milestone.

## Independently verified producer authorities

The producer branches and Actions runs were queried directly before
implementation.

### Bridge R24 read-only live preflight

- repository: `foto6/WebAIBridge`
- branch: `agent/bridge-r24-live-preflight-20261001`
- branch HEAD: `4ff6315241df16bcfa4750b15f3a3a315296dc50`
- exact CI: `36865003806`
- CI head SHA: `4ff6315241df16bcfa4750b15f3a3a315296dc50`
- CI conclusion: `success`
- live contract: `bridge.r24_live_preflight.v1`

Bridge R24 does **not** publish a standalone JSON Schema file. Its committed
schema authority is the strict evaluator in `app/live-preflight-r24.js`,
together with its contract tests and deterministic fixture generator. R28
does not invent a schema that the producer did not publish.

Pinned Bridge R24 producer blobs include:

| Producer path | Git blob |
| --- | --- |
| `.github/workflows/r24-live-preflight.yml` | `1553ace9c1ca5c6be037a3b560043285d750e67d` |
| `app/docs/BRIDGE_R24_LIVE_PREFLIGHT.md` | `c32deadd02b1486c91268c20d93a79403a332bbe` |
| `app/live-preflight-r24.js` | `4e5d2c9765ed51848564e85582d990872a7349b5` |
| `app/r24-live-preflight.js` | `fa9e0b363ea35eca595ec2b049911be9284c1e1b` |
| `app/r24-live-preflight-contract.test.js` | `17b14b318dba64da03b4affc904da5e7392ec856` |
| `app/r24-live-preflight-fixtures.js` | `ab6f7b9284077568593ca0ed9f1321a75d77cc16` |
| `app/r24-readiness-report.js` | `a561986d9ff526422c35253ba05c4b3165c35c63` |

Exact R24 CI artifacts:

| OS | Artifact ID | Archive SHA-256 |
| --- | ---: | --- |
| Ubuntu | `11163470263` | `46399fa77887c1c2617a218f97ba266a1ebd2a3ea80e69b7f7b0c275e7dbbf51` |
| Windows | `11163625213` | `2e32c7a3b548668fa2d169cb390c92b57a360b6ad81f216fa51a74e628dc305a` |

R28 also pins the extracted readiness JSON and deterministic fixture SHA-256
values from both artifacts. The pin is committed at
`conformance/r28_bridge_r24/pin.json`.

### PC Relay R27 progress-evidence delivery

- repository: `foto6/help-pc-1`
- branch: `agent/pc-relay-r27-evidence-delivery-20261001`
- branch HEAD: `91600c19763ca8a0871d078a3f15ac97fb4f039a`
- exact CI: `36866129515`
- CI head SHA: `91600c19763ca8a0871d078a3f15ac97fb4f039a`
- CI conclusion: `success`
- envelope contract: `pc_relay.progress_evidence.v1`

R28 vendors the exact producer files:

- `schemas/pc_relay.progress_evidence.v1.schema.json`
- frozen `pc_relay.progress.v1` schema
- frozen `pc_relay.liveness_probe.v1` schema
- producer consumer manifest
- exact evidence example
- `src/pc_relay/evidence.py`
- `tools/read_relay_progress_evidence.py`

The producer manifest pins the frozen R26 upstream start
`96d453bcdc866bfd26c06ad88e2ec0c033fbccdd` and its source blobs. R28
validates the manifest and every vendored blob before consuming evidence.

The pin is committed at `conformance/r28_relay_r27/pin.json`.

## Bridge R24 consumer semantics

R28 consumes the producer object exactly as
`bridge.r24_live_preflight.v1`. It requires all ten published gate IDs:

1. `process_identity`
2. `source_provenance`
3. `config_provenance`
4. `port_ownership`
5. `status_responsiveness`
6. `health_responsiveness`
7. `queue_quiescence`
8. `cdp_readonly_probe`
9. `durable_state`
10. `r23_candidate_manifest`

Producer evidence states are retained exactly as published:
`PASS`, `DEGRADED`, `BLOCK`, and `UNKNOWN`.

R28 never converts a missing or UNKNOWN live fact into PASS. For integrated
readiness, every required gate and observation must be PASS, the producer
decision must be `READY_FOR_EXPLICIT_CUTOVER`, the snapshot must still be
fresh, queue counts must be zero, process ownership must be unambiguous,
`codeReloadRequired` must be exactly false, and required CDP evidence must be
healthy.

DEGRADED, BLOCK, UNKNOWN, stale status, stale collector output, code reload,
ambiguous PID, non-quiescent queue, corrupt state, or failed CDP all become
R28 `BLOCKED`.

## Relay R27 consumer semantics

A successful R27 envelope is accepted only after all of these checks:

- exact `pc_relay.progress_evidence.v1` shape;
- exact source-bound R27 checkout attestation;
- exact approved reader/evidence-module SHA-256 derived from the pinned Git
  sources;
- read-only delivery semantics with no acknowledgement, lease, retry, or replay;
- envelope canonical SHA-256;
- embedded canonical progress SHA-256;
- strict frozen R26 progress schema;
- strict frozen R26 liveness schema;
- exact relay startup HEAD and relay-script identity;
- process PID/start/instance binding;
- loop generation and epoch binding;
- progress-record timestamp binding;
- pending-count/failure/error-class binding;
- progress/queue/cycle age binding to the same observation timestamp;
- current consumer freshness;
- exactly one observed relay PID matching the bound PID.

Only `status=ok`, fresh evidence, embedded
`liveness.state=healthy_progressing`, unambiguous process identity and a
zero-pending relay queue can satisfy R28 readiness.

A producer `status=blocked` envelope remains blocked. It is never partially
consumed.

The reader and evidence module SHA-256 values are derived from the exact pinned
source files. R28 accepts only the LF and Windows CRLF checkout
representations of those exact Git blobs; arbitrary changed bytes are rejected.

## R25 remains an independent prerequisite

R28 does not replace R25 runtime-health or outcome-journal authority. READY
also requires:

- exact `pc_executor.runtime_health.v1` producer authority;
- fresh source-bound R25 snapshot;
- known Executor PID/generation;
- configured healthy outcome journal;
- `system_state=HEALTHY`;
- every declared required adapter available, responsive, and circuit-closed;
- fresh independent binding to exact R24 Executor SHA
  `60ba0ce92bf2f3cdd89e3213dba40793c6a90d8b`.

## Decision contract

R28 preserves the three decision classes:

- `READY_FOR_EXPLICIT_CUTOVER`
- `BLOCKED`
- `RECONCILIATION_REQUIRED`

Any durable UNKNOWN side effect has precedence and yields
`RECONCILIATION_REQUIRED`.

Every result, including READY, retains:

- `release_gate=NO_LIVE_CUTOVER`
- `live_cutover_authorized=false`
- `mutation_execution_authorized=false`
- `live_cutover_performed=false`
- `automatic_replay_authorized=false`
- `automatic_restart_authorized=false`
- `automatic_kill_authorized=false`
- `read_only_diagnostics_allowed=true`

Relay liveness recovery never authorizes replay.

## Deterministic regression matrix

`test/fixtures/r28-evidence-fixtures.js` constructs an exact-green paired
Bridge/Relay/R25 input from the pinned producer contracts. Focused tests cover:

- exact-green READY;
- moving Bridge R24 producer SHA;
- moving Relay R27 producer SHA;
- Bridge artifact/pin drift;
- Relay manifest/blob pin drift;
- Bridge schema drift;
- Relay schema drift;
- Bridge DEGRADED/BLOCK/UNKNOWN;
- stale Bridge snapshot;
- ambiguous Bridge process;
- non-quiescent Bridge queue;
- code reload required;
- unhealthy/hung CDP;
- Relay delivery reader digest mismatch;
- replay-triggered delivery semantics;
- envelope digest mismatch;
- progress digest mismatch;
- atomic process/generation binding mismatch;
- stale Relay evidence;
- producer `status=blocked`;
- `alive_stalled`;
- duplicate relay processes;
- non-quiescent relay queue;
- corrupt R25 journal;
- unhealthy required R25 adapter;
- UNKNOWN side-effect reconciliation precedence.

The retained R27/R26/R25 tests and the full repository suite remain CI gates.

## Stopping rules

- STOP on any moving producer SHA or stale producer binding.
- STOP on schema/manifest/blob/artifact drift.
- STOP unless every required Bridge R24 gate and observation is PASS.
- STOP on any UNKNOWN/DEGRADED/BLOCK Bridge evidence.
- STOP on ambiguous process ownership, non-quiescent queues, code reload, stale
  status/health, or unhealthy CDP.
- STOP unless Relay R27 status is `ok`, source digests and atomic digests
  validate, evidence is fresh, liveness is `healthy_progressing`, ownership
  is unambiguous and the relay queue is empty.
- STOP if R25 runtime/journal/adapter authority is unacceptable.
- STOP and return `RECONCILIATION_REQUIRED` for every UNKNOWN side effect.
- Never replay an UNKNOWN effect after liveness recovery.
- Read-only diagnostics remain available under BLOCKED and
  RECONCILIATION_REQUIRED.

## Isolation

This milestone uses only source inspection, deterministic fixtures and CI.

- no live cutover;
- no Bridge restart/kill/repoint/deploy;
- no PC Control restart/kill/service change;
- no Desktop Commander;
- no access to `E:\manhwa`;
- no merge/release.

**NO_LIVE_CUTOVER** remains mandatory.
