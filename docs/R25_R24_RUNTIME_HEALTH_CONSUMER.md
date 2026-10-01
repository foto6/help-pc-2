# R25 — Consume PC Executor R24 runtime health

Decision: **NO_LIVE_CUTOVER**.

This change consumes the exact read-only producer contract delivered by
`foto6/help-pc-1` R24. It does not install, stop, restart, repoint, replace, or
modify any live service.

## Exact provenance

Consumer baseline:

- repository: `foto6/help-pc-2`
- branch: `agent/native-mcp-r25-r24-health-consumer-20261001`
- exact starting SHA: `f2b984c3e6a14e0e1d930c1c14253bd48f294f65`

Producer:

- repository: `foto6/help-pc-1`
- branch: `agent/pc-executor-r24-runtime-health-20261001`
- exact green SHA: `60ba0ce92bf2f3cdd89e3213dba40793c6a90d8b`
- workflow: `36806258696` SUCCESS
- contract: `pc_executor.runtime_health.v1`

Pinned producer source blobs:

| Producer path | Git blob SHA |
| --- | --- |
| `src/pc_executor/runtime_health.py` | `6b7a7bfd84e02855de468e87a621e349527f52d6` |
| `schemas/pc_executor.runtime_health.v1.schema.json` | `62d691862c4c66088bdb55b5fe35193529b6532f` |
| `tests/fixtures/runtime_health_v1/manifest.json` | `54b8ff1548529403d775cd4f4f5ffff997fe6d39` |
| `tests/fixtures/runtime_health_v1/runtime_health.example.json` | `aee3ce093250a0ca3659496c20ccb37940ec76cb` |

R25 vendors byte-identical copies of the schema, producer consumer manifest and
example envelope under `conformance/r24_runtime_health_v1/`. Startup
validation recomputes Git blob identities for those vendored artifacts. Changed
bytes, schema ID drift, source-blob pin drift, or producer SHA drift fail closed.

The R24 wire envelope itself does **not** carry a git SHA attestation. R25
therefore records `producer_sha_wire_attested=false` and never treats a valid
health envelope alone as proof that a live machine is running the pinned
producer commit.

## Consumer behavior

`src/r24-runtime-health-consumer.js` strictly validates:

- exact top-level schema and `pc_executor.runtime_health.v1`;
- required adapter set: UIA, screenshot, windows, shell, clipboard, input,
  outcome journal, search and process;
- per-adapter availability/state/provider/counters/bounded timeout/circuit;
- top-level and per-adapter Executor process/generation identity;
- UIA timeout accounting;
- outcome-journal integrity and duplicate journal diagnostics;
- summary counts against actual adapter states;
- observation freshness.

A previously accepted snapshot is re-aged on every read. It cannot remain
fresh indefinitely after ingestion.

### Health classifications

R25 intentionally separates global and lane-specific state:

- **system healthy**: source-bound/fresh/complete producer health with known
  generation and no global journal failure;
- **adapter-specific degraded/unhealthy/unknown**: retained per adapter without
  contaminating independent lanes;
- **action-specific blocked**: an action is blocked only when its required
  producer adapter is unavailable/unhealthy/open/unknown, or when a mutation
  lacks trusted outcome-journal integrity;
- **stale/unknown producer health**: readiness fails closed and cutover remains
  blocked.

A UIA timeout with producer state `degraded` is surfaced as
`R24_UIA_TIMEOUT_DEGRADED`. A producer UIA state `unhealthy` or open circuit
blocks UIA actions before provider dispatch. It does not mark windows,
screenshot, shell, or outcome-journal lanes unhealthy.

Corrupt journal evidence marks global producer health unhealthy and blocks
side-effect actions. Unrelated read-only adapter lanes remain independently
observable.

## MCP / canary integration

The existing native `device.health` response is the ingestion boundary. R24
delivers producer health in `data.runtime_health`; no registry change is
introduced.

The read-only canary continues to use `device.ping` / producer `health.get`.
When that canary returns `runtime_health`, R25 ingests the same exact producer
contract. The R23 exact-action canary lane remains unchanged, so a health probe
cannot advance an unrelated queued mutation.

`r23_health` now includes:

- `producer_runtime_health`;
- `producer_adapter_health`;
- adapter-specific degraded/unhealthy lists;
- source-bound outcome-journal integrity;
- `cutover_readiness`.

Local R23 breaker state remains separate from R24 producer state.

## Fail-closed regression coverage

Focused R25 tests cover:

- exact R24 fixture ingestion;
- changed producer SHA;
- changed pinned source blob identity;
- contract/schema drift and extra fields;
- adapter/root generation mismatch;
- unknown operations generation;
- dynamic stale evidence after initially fresh ingestion;
- corrupt outcome journal;
- malformed UIA timeout accounting;
- journal diagnostics drift;
- UIA timeout/degraded state;
- UIA unhealthy/open-circuit action blocking;
- shell/windows/screenshot/outcome isolation;
- MCP `device.health` ingestion followed by pre-dispatch UIA blocking while
  windows remains callable.

R23 lifecycle, canary, breaker, parity, soak, uncertain-outcome and full-suite
tests remain part of CI.

## Cutover prerequisites

R25 keeps `release_ready=false` unconditionally. A future independent
verification must establish all of the following before any cutover decision:

1. the deployed producer is independently attested to exact SHA
   `60ba0ce92bf2f3cdd89e3213dba40793c6a90d8b`;
2. the exact pinned schema/blob pack still verifies;
3. current `pc_executor.runtime_health.v1` evidence is fresh and complete;
4. Executor process ID and operations generation are known and internally
   consistent;
5. the outcome journal is configured and `healthy`;
6. every adapter needed by the intended action is acceptable at execution time;
7. restart/reboot convergence is verified against the actual target stack;
8. UNKNOWN side effects continue to reconcile via existing outcome lookup with
   no blind replay;
9. the full end-to-end lane is independently exercised after integration.

Until then the decision is **NO_LIVE_CUTOVER**.

## Isolation

- No Desktop Commander.
- No live service install/restart/repoint.
- No launcher replacement.
- No production deployment.
- No merge/release.
- No access to `E:\manhwa`.
