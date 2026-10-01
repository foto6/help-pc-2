# Native MCP R26 — relay progress-health consumer

Decision: **NO_LIVE_CUTOVER**.

This branch consumes the exact read-only relay progress/liveness contracts from
the authoritative PC producer. It does not deploy, install, restart, repoint,
replace, kill, or otherwise modify the live PC Control relay or live Bridge.

## Provenance

Consumer:

- repository: `foto6/help-pc-2`
- branch: `agent/native-mcp-r26-relay-progress-consumer-20261001`
- exact starting SHA: `787bb25aa9202ae91d90a000c3d88a0e5ac96a7c`

Producer authority:

- repository: `foto6/help-pc-1`
- branch: `agent/pc-relay-r26-progress-health-20261001`
- exact producer SHA: `96d453bcdc866bfd26c06ad88e2ec0c033fbccdd`
- exact producer CI: `36833819136` GREEN
- progress contract: `pc_relay.progress.v1`
- liveness contract: `pc_relay.liveness_probe.v1`

Pinned producer blobs:

| Producer artifact | Git blob SHA |
| --- | --- |
| `src/pc_relay/progress.py` | `c00ccc58f75de463898cd26bb6c4cfeab25a2ca6` |
| `tools/github_relay.py` | `022cef2a800772c755f34a75faa76b7f54589c94` |
| `tools/start_pc_control_relay.ps1` | `7f0add5fb528526336a6caa1f534c2551983f653` |
| `schemas/pc_relay.progress.v1.schema.json` | `04b8da53f638a244a668c8f0a9be4c9b165e1c5e` |
| `schemas/pc_relay.liveness_probe.v1.schema.json` | `7990e850ef2c143a3d718bd15101c142feb80e1e` |
| `tests/fixtures/relay_progress_v1/manifest.json` | `b96441e6d164af3554acdcdf77b9ea9eabc3abaf` |
| `tests/fixtures/relay_progress_v1/progress.example.json` | `4025cb31ae48e0032215bd38edf1c2acaf5d90e1` |

The exact SHA-256 of the producer `tools/github_relay.py` bytes at the pinned
producer SHA is:

`9a50c40a591e92fc4c8c05202baf5af7f24937d018c57ca2b13b8097b5eca383`

R26 requires a live progress record to bind both `source.startup_head` to the
exact producer SHA and `source.relay_script_sha256` to this exact script
identity before mutation readiness can become source-bound.

The committed producer schemas, manifest and progress fixture are vendored
byte-identically under `conformance/r26_relay_progress_v1/`. Consumer startup
verification recomputes their canonical Git blob identities and validates the
producer manifest's recovery and safety invariants.

## Exact producer semantics retained

R26 does not reinterpret PID presence as health and does not create substitute
liveness states. `liveness_state` is preserved exactly from
`pc_relay.liveness_probe.v1`.

Important producer states are retained verbatim:

- `healthy_progressing`
- `alive_stalled`
- `duplicate_processes_ambiguous`
- `alive_ambiguous_identity`
- `stale_record_no_process`
- `no_process`
- `alive_unknown`
- `progress_record_current`
- `stalled_record`
- `unknown`

A separate consumer classification `reconciliation_required` is used only
when the Control side already has pending UNKNOWN effects. It is not presented
as a producer liveness enum and never changes the underlying producer state.

## Strict progress/liveness binding

`src/r26-relay-progress-consumer.js` strictly validates all committed schema
fields and additionally binds the liveness probe to the same progress record:

- process PID;
- loop generation;
- loop epoch;
- pending count;
- consecutive cycle failures;
- last error classification;
- progress age;
- queue-result progress age;
- successful-cycle age.

Age values are recomputed from the progress timestamps and must match the
producer probe within the producer's millisecond rounding tolerance.

The consumer also requires the exact producer repository, branch, startup HEAD
and relay script SHA-256. Changed producer SHA, changed branch, dirty/replaced
relay script, schema drift, manifest drift, mismatched loop generation/epoch or
mismatched liveness counters fail closed.

## Readiness model

For mutations, R26 requires all of the following:

1. exact pinned R26 producer identity;
2. valid paired progress + liveness envelopes;
3. evidence still within the configured freshness bound;
4. producer state exactly `healthy_progressing`;
5. no pending UNKNOWN side effects requiring reconciliation.

Anything else blocks the mutation before provider dispatch.

Read-only operations are not blocked merely because the relay is degraded,
stalled, ambiguous, absent, or stale. They remain available as bounded
diagnostics through the pre-existing safety/capability gates.

### State behavior

| Producer/consumer state | Mutation | Read-only diagnostics |
| --- | --- | --- |
| `healthy_progressing` + fresh + no UNKNOWN | READY | READY |
| `alive_stalled` | BLOCKED | DIAGNOSTIC_ONLY |
| `duplicate_processes_ambiguous` | BLOCKED | DIAGNOSTIC_ONLY |
| `alive_ambiguous_identity` | BLOCKED | DIAGNOSTIC_ONLY |
| `stale_record_no_process` | BLOCKED | DIAGNOSTIC_ONLY |
| stale/unknown evidence | BLOCKED | DIAGNOSTIC_ONLY |
| pending UNKNOWN effect | RECONCILIATION_REQUIRED | DIAGNOSTIC_ONLY |

Ambiguous ownership has no automatic recovery path:

- `auto_restart=false`
- `auto_kill=false`
- `automatic_replay=false`
- `replay_authorized_after_liveness_recovery=false`

A restart that produces a new process instance / loop generation is observable
as `restart_observed=true`. It never clears pending UNKNOWN effects and never
turns them into replayable mutations.

## Bounded diagnostics surfaced

The R23/R25 health view now supports the source-bound R26 snapshot with:

- producer liveness state and bounded reason;
- pending count;
- oldest pending age;
- queue-result progress age;
- last successful cycle age/timestamp;
- last committed result timestamp/ID;
- consecutive cycle failures;
- current cycle state;
- process PID/instance and observed PID set;
- loop generation and epoch;
- bounded error classification, retryability, operation and return code.

The raw producer error `message` is deliberately **not** exposed by the R26
consumer. Request parameters, environment variables, credentials, raw command
lines and broad process inventories are not added to health output.

## Runtime delivery boundary

The existing built-in Native relay API in `help-pc-2` does not itself emit
`pc_relay.progress.v1` or `pc_relay.liveness_probe.v1`. R26 therefore does
not translate that different API into these contracts or guess equivalent
fields.

The R26 mutation gate activates only when an exact
`readRelayProgressHealth()` evidence reader is wired, or when isolated tests
explicitly enable the R26 consumer. Until that exact delivery is independently
integrated, the current lane is **not cut over** to R26 progress gating.

This avoids both unsafe alternatives:

- treating unrelated Native relay health as if it were the R26 GitHub-relay
  contract;
- blocking the accepted pre-cutover lane based on fabricated/unknown fields.

## R25 safety preserved

R25 runtime adapter-health and outcome-journal gates remain unchanged. R26 adds
a separate relay-progress prerequisite; it does not downgrade R24/R25 adapter
health, journal integrity, source SHA, generation or freshness checks.

R23/R25 cutover readiness now reports R25 runtime health and R26 relay progress
as separate prerequisites and keeps `release_ready=false`.

UNKNOWN side effects remain governed by existing outcome reconciliation. Relay
restart/liveness recovery never authorizes blind replay.

## Deterministic tests

Focused R26 tests cover:

- exact schema/manifest/fixture blob identities;
- exact producer SHA/branch/script identity;
- `healthy_progressing` mutation readiness;
- `alive_stalled`;
- duplicate-process ambiguity;
- ambiguous process identity;
- stale record with no process;
- dynamically stale cached evidence;
- process/loop restart;
- pending UNKNOWN reconciliation after restart;
- liveness/progress generation and counter drift;
- bounded error output with secret-bearing raw message omitted;
- MCP pre-dispatch mutation block while read-only diagnostics remain callable;
- healthy recovery allowing a new mutation;
- reconciliation-required state preserving `automatic_replay=false`.

The retained R23 soak, R25 R24-health consumer tests and full repository suite
remain CI gates.

## Cutover prerequisites

**NO_LIVE_CUTOVER** remains mandatory until independent verification proves:

1. the running relay is exactly producer SHA
   `96d453bcdc866bfd26c06ad88e2ec0c033fbccdd`;
2. its loaded `github_relay.py` SHA-256 is exactly the pinned runtime script
   identity;
3. an exact R26 evidence reader delivers paired progress/liveness envelopes to
   the Native MCP runtime without translating or guessing fields;
4. the evidence is fresh and producer-classified `healthy_progressing`;
5. ownership is unambiguous;
6. there are no pending UNKNOWN effects requiring outcome reconciliation;
7. R25 runtime-health/journal prerequisites remain satisfied;
8. restart/reboot end-to-end behavior is independently verified on the intended
   target stack.

No live service was touched by this milestone.
