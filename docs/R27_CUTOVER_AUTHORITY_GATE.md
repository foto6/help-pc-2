# Native MCP R27 — integrated cutover authority gate

Decision for this milestone: **NO_LIVE_CUTOVER**.

R27 builds a pure, source-bound decision layer. It combines the exact Bridge R23
safe-cutover rehearsal authority with Native R26 relay progress health and the
existing R25 PC Executor runtime-health / outcome-journal prerequisites. It does
not perform, schedule, or encode an executable live cutover.

## Exact authorities

### Native MCP / PC Control

- repository: `foto6/help-pc-2`
- exact R26 authority SHA: `46c50ea85c3cc4db6b0e43fbd2762d0420d1be28`
- exact R26 CI: `36859871735` SUCCESS

### Bridge R23 safe cutover rehearsal

- repository: `foto6/WebAIBridge`
- branch: `agent/bridge-r23-cutover-rehearsal-20261001`
- exact SHA: `7e0d5e07f93990f103358850f8f3c10c1563f83a`
- exact CI: `36861515420` SUCCESS
- baseline SHA: `ba4525d0dc9ad808af73d766d0bb9ed0e9eee21b`

Pinned Bridge source blobs, CI artifact identities, readiness/evidence JSON
hashes and candidate manifest digests are committed in
`conformance/r27_cutover_authority/bridge-r23-pin.json`.

Exact Bridge CI artifact authorities:

| OS | Artifact ID | Archive digest |
| --- | ---: | --- |
| Ubuntu | `11161244146` | `sha256:63f9a62a9bb2d83d1c3eee3eca9a169bd342e3ec15b9944294f7ce46cda7f8af` |
| Windows | `11161923643` | `sha256:fa87af539c857c7bd35b5a77b47ea1ec234a151e0c4a2b74849b39b9fe4618be` |

The artifacts prove:

- `READY_FOR_EXPLICIT_CUTOVER` inside the isolated Bridge rehearsal only;
- all 8 Bridge preflight gates passed in the healthy fixture;
- rollback restoration at all five required boundaries;
- deterministic fail-closed coverage for occupied port, stale PID,
  nonresponsive status, code-reload-required, hung CDP and pending assignment;
- no live Bridge mutation, provider mutation, conversation create/delete or
  `/json/new` side effect;
- release gate remained `NO_LIVE_DEPLOY`.

R27 does not follow the Bridge branch name at runtime. A changed source SHA,
artifact identity, source blob, manifest identity, rollback proof or schema is a
blocked authority.

### PC Executor R24 runtime health

- producer repository: `foto6/help-pc-1`
- branch: `agent/pc-executor-r24-runtime-health-20261001`
- exact SHA: `60ba0ce92bf2f3cdd89e3213dba40793c6a90d8b`
- CI: `36806258696`
- contract: `pc_executor.runtime_health.v1`

R27 requires the R25 consumer snapshot to remain source-bound, fresh, complete,
generation-known and journal-healthy. The live coordinator must also supply a
fresh independent runtime producer SHA attestation to the exact R24 SHA, because
the R24 health envelope itself does not carry the Git SHA.

### PC relay R26 progress health

- producer repository: `foto6/help-pc-1`
- branch: `agent/pc-relay-r26-progress-health-20261001`
- exact SHA: `96d453bcdc866bfd26c06ad88e2ec0c033fbccdd`
- CI: `36833819136`
- contracts: `pc_relay.progress.v1` and `pc_relay.liveness_probe.v1`

Mutation/cutover readiness requires fresh R26 evidence classified exactly as
`healthy_progressing`, exact producer pinning, and unambiguous single-process
ownership.

## One machine-readable decision

`src/r27-cutover-authority-gate.js` returns exactly one of:

- `READY_FOR_EXPLICIT_CUTOVER`
- `BLOCKED`
- `RECONCILIATION_REQUIRED`

`RECONCILIATION_REQUIRED` has precedence whenever a durable UNKNOWN side
effect exists, including one reported by R26 relay evidence. The result always
sets:

- `automatic_replay_authorized=false`
- `automatic_restart_authorized=false`
- `automatic_kill_authorized=false`
- `live_cutover_authorized=false`
- `mutation_execution_authorized=false`

A READY decision means only that all explicit preconditions evaluated by the
gate are satisfied. It does not execute or authorize a live action by itself.

## READY prerequisites

Every gate must pass:

1. exact pinned Bridge R23 source and CI artifact authority;
2. successful R23 rehearsal and all required rollback proofs;
3. fresh live Bridge preflight evidence;
4. exact Bridge candidate source SHA/branch and schema 13;
5. unambiguous exact Bridge PID + command identity;
6. valid state/config with exact matching backup digests;
7. migration compatible with state schema 13;
8. queue quiescent: zero active assignments/tasks/outbox side effects;
9. bounded, fresh Bridge status with control plane responsive, operational
   state `OK`, and `code_reload_required=false`;
10. bounded fresh healthy CDP evidence when required;
11. exact, fresh R25 runtime-health authority;
12. known Executor process/generation;
13. healthy configured outcome journal;
14. fresh independent attestation of the exact R24 producer SHA;
15. every declared required native adapter responsive/available with closed
    circuit;
16. exact, fresh R26 relay authority;
17. R26 state exactly `healthy_progressing`;
18. unambiguous relay ownership: exactly one observed PID matching the recorded
    process;
19. no UNKNOWN side effect.

Any stale/unknown evidence, moving SHA, manifest/artifact drift, ambiguous
ownership, code reload requirement, nonresponsive status, failed backup,
non-quiescent queue, failed rollback authority, corrupt journal, unhealthy
required adapter or non-progressing relay results in `BLOCKED`.

## Read-only diagnostics

R27 keeps `read_only_diagnostics_allowed=true` for BLOCKED and
RECONCILIATION_REQUIRED decisions. It does not weaken the lower-level R25/R26
safety gates, but it does not make a cutover failure equivalent to losing
diagnostic access.

## Deterministic fixtures

`conformance/r27_cutover_authority/decision-fixtures.json` contains a complete
READY fixture and deterministic single-gate mutations covering:

- explicit UNKNOWN side effect;
- relay pending UNKNOWN;
- Bridge source mismatch;
- Bridge process ambiguity;
- invalid state backup;
- migration incompatibility;
- non-quiescent queue;
- nonresponsive status;
- code reload required;
- stale status;
- stale CDP;
- stale R25 health;
- unknown Executor generation;
- corrupt journal;
- unhealthy required native adapter;
- stale R24 producer attestation;
- stale R26 relay evidence;
- `alive_stalled`;
- duplicate process ambiguity;
- ambiguous relay identity.

Tests also mutate the pinned Bridge authority itself to prove that moving SHA,
artifact digest drift, schema drift and failed rollback evidence become
`BLOCKED`.

## Coordinator handoff

`conformance/r27_cutover_authority/coordinator-handoff.json` is intentionally
committed as `BLOCKED` because no live preflight is executed in this milestone.
It contains the exact producer/consumer authorities, required live preflight
fields and stopping rules.

CI runs `tools/r27-cutover-handoff-report.js` after the complete test suite and
uploads a per-OS handoff artifact bound to the exact `GITHUB_SHA` and
`GITHUB_RUN_ID`. The generated handoff contains:

- no executable live cutover action;
- no process restart/kill action;
- no deployment/repoint command;
- no automatic replay authorization;
- no executable command list.

## Stopping rules

- STOP on any failed, stale, unknown, ambiguous or schema-drifted gate.
- STOP and reconcile any UNKNOWN side effect; never submit it again as a new
  mutation.
- STOP on ambiguous Bridge or relay ownership. Never kill/restart based only on
  a port, stale PID or ambiguous ownership.
- STOP if Bridge status is stale, nonresponsive, degraded, over latency budget
  or requires code reload.
- STOP if required CDP evidence is missing, unhealthy, stale or over budget.
- STOP if state/config backup digests differ from their pre-cutover digests.
- STOP if the queue is not quiescent.
- STOP if R25 runtime health, generation, journal or required-adapter evidence
  is unacceptable.
- STOP unless R26 relay evidence is fresh `healthy_progressing` with
  unambiguous ownership.

## Isolation

This milestone performs no live preflight and no live cutover.

- no Bridge restart, kill, repoint or deploy;
- no PC Control restart, kill, service change or cutover;
- no Desktop Commander;
- no access to `E:\manhwa`;
- no merge/release.

Final release decision remains **NO_LIVE_CUTOVER** pending explicit coordinator
execution of the required live preflight and a separate explicit cutover action.
