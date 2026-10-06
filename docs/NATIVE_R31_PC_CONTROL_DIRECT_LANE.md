# Native MCP R31 — pc-control direct-lane candidate

Release decision: **NO LIVE PC-CONTROL CUTOVER**.

R31 adapts the exact-green R30 direct authenticated MCP lane for a future
private `pc-control` plugin candidate without changing the plugin or the
current GitHub request/result relay.

## Authority model

During R31 and any dual-lane canary:

- current side-effect authority: **GitHub relay**;
- direct MCP lane: candidate/read-only probe only;
- side-effect mirroring: forbidden;
- automatic fallback after a direct UNKNOWN: forbidden;
- automatic replay: forbidden;
- `ACTUAL_PC_CONTROL_CUTOVER=false`.

The original R31/R30 source authority remains preserved at
`conformance/r31_pc_control_direct/source-pin.r30-historical.json`.

The active readiness consumer now uses
`conformance/r31_pc_control_direct/source-pin.json`, contract
`pc.control.direct_source_authority.v2`. That active authority binds the
historical R30 SHA/CI plus accepted R35 quiescent-epoch, R36 public-Host, and
R37 operator-lifecycle successor bytes. `validateR31SourcePin()` verifies the
successor pin evidence and every active Git blob before an R31 readiness report
can be generated. The historical R30 tuple is not rewritten or treated as the
current implementation after those accepted successors.

## Plugin-facing gateway contract

`src/pc-control-direct-candidate.js` provides
`PcControlDirectCandidateGateway`.

The stable discovery output is `pc.control.plugin_surface.v1` and contains
only bounded, non-secret fields:

- normalized health state and latency;
- native registry digest;
- Executor capability digest;
- Desktop Commander compatibility registry digest where present;
- protected-path policy identity;
- explicit side-effect request-ID requirement;
- reconciliation / automatic-replay semantics;
- sorted tools with:
  - name;
  - read-only / side-effect classification;
  - availability;
  - input-schema digest.

Raw credentials and raw tool results are not part of this discovery contract.

The gateway maps directly to R30 MCP:

```text
plugin candidate
 -> initialize
 -> tools/list
 -> tools/call
 -> R30 NativeMcpRuntime
 -> NativeControlFacade
 -> durable ControlPlane
 -> authenticated native relay
 -> Executor
```

It does not expose Executor directly and does not create a second policy
boundary.

## Dual-lane migration behavior

`PcControlDualLaneGateway` accepts:

1. an authority adapter representing the existing GitHub-relay plugin lane;
2. the R30 direct candidate adapter.

For side-effect tools the call goes **only** to the authority adapter.

For read-only tools, optional canary mirroring may call both lanes. A candidate
read-only probe failure is recorded as a candidate probe error but does not
replace or suppress a successful authority result.

No result, argument payload, credential or raw exception is placed in canary
evidence. Candidate read-only results are represented only by a digest and
bounded status metadata.

## Candidate mutation identity and UNKNOWN outcomes

The direct adapter can later be instantiated in
`explicit_plugin_candidate` mode, but that mode is not activated by R31
against the real private plugin.

In that mode every side-effect call must carry the stable plugin
`request_id`. Missing identity fails before MCP dispatch.

If a direct side-effect response is `reconciliation_required`, R31 preserves:

- the same logical `request_id`;
- `automatic_replay=false`;
- `fallback_authorized=false`.

If transport loss occurs after a candidate side-effect call has begun, R31
conservatively surfaces `reconciliation_required` for the same request ID.
It does **not** route the mutation to the GitHub lane as a replacement action.

Authentication/connect failure before candidate dispatch remains a normal
blocked/error condition and never creates a side effect.

## Cutover comparison

`comparePluginSurfaces()` fails closed on:

- native registry digest mismatch;
- Executor digest mismatch;
- protected-path policy mismatch;
- side-effect request-ID semantics mismatch;
- reconciliation/automatic-replay mismatch;
- health-state mismatch;
- health latency outside the configured bound;
- direct transport/executor not responsive;
- missing/extra tools;
- tool availability mismatch;
- read-only/side-effect classification mismatch;
- input-schema digest mismatch.

A mismatch blocks candidate readiness. It never changes the active authority.

## One-command read-only canary

The command is:

```text
PC_CONTROL_DIRECT_MCP_ENDPOINT=https://<gateway>/mcp
PC_CONTROL_DIRECT_MCP_TOKEN=<separate-direct-client-token>
npm run r31:canary -- --out r31-canary.json
```

Default tools are:

```text
device.ping,device.info
```

Override them only with known read-only tools:

```text
PC_CONTROL_DIRECT_CANARY_TOOLS=device.ping,device.info npm run r31:canary -- --out r31-canary.json
```

The canary validates health/capabilities/tools-list and then invokes the selected
read-only tools. It refuses any tool classified as side-effecting.

By default the evidence origin is `runtime_probe_unattested`; therefore the
readiness decision cannot advance beyond `SOURCE_READY`.

A later, separately authorized live rehearsal may use:

```text
npm run r31:canary -- \
  --live-explicit-read-only-canary \
  --authority-snapshot <current-pc-control-authority-snapshot.json> \
  --out r31-live-canary.json
```

Only that explicit evidence origin can produce `READ_ONLY_CANARY_PASS`.

A still-later coordinator review may additionally request:

```text
--explicit-plugin-candidate-evaluation
```

With exact matching authority/candidate surfaces and a passing explicit live
read-only canary, that can produce
`READY_FOR_EXPLICIT_PLUGIN_CANDIDATE`.

It still emits `actual_pc_control_cutover=false`.

## Readiness states

The R31 machine decision uses exactly:

- `SOURCE_READY`
- `READ_ONLY_CANARY_PASS`
- `READY_FOR_EXPLICIT_PLUGIN_CANDIDATE`
- `BLOCKED`

Source fixtures and CI synthetic canaries cannot advance beyond
`SOURCE_READY`.

Any schema/capability/policy/health mismatch, side-effect canary call, replay
authorization, failed canary, unavailable direct lane or authentication mismatch
blocks the corresponding migration decision.

## Future private-plugin candidate metadata

`conformance/r31_pc_control_direct/plugin-candidate.json` defines the
non-installed `0.3.0-candidate` contract.

Configuration names reserved for a future plugin candidate:

```text
PC_CONTROL_DIRECT_MCP_ENDPOINT=https://<gateway>/mcp
PC_CONTROL_DIRECT_MCP_TOKEN=<direct MCP client credential>
PC_CONTROL_DIRECT_CONNECT_TIMEOUT_MS=5000
PC_CONTROL_DIRECT_REQUEST_TIMEOUT_MS=30000
```

The direct MCP client credential must remain distinct from device/relay
credentials and must never be included in logs, discovery, evidence or tool
metadata.

R31 does not install, update or mutate the actual private plugin.

## Evidence contracts

Committed schemas:

- `pc.control.plugin_surface.v1`
- `pc.control.direct_canary_evidence.v1`
- `pc.control.direct_readiness.v1`

Exact-head CI also publishes
`pc.control.r31.readiness_report.v1`, bound to `GITHUB_SHA` and
`GITHUB_RUN_ID`.

The CI report intentionally records:

- `source_state=SOURCE_READY`;
- `read_only_canary_state=NOT_EXECUTED_LIVE`;
- `plugin_candidate_state=NOT_AUTHORIZED`;
- `actual_pc_control_cutover=false`;
- `current_authority=github_relay`;
- `current_working_path_changed=false`.

## Explicitly not performed

This milestone does not:

- update/install/reconfigure the current private `pc-control` plugin;
- stop or repoint the GitHub request/result relay;
- restart Bridge, MCP or current relay processes;
- register a service or scheduled task;
- modify firewall or tunnel configuration;
- deploy a new public endpoint;
- log or persist direct MCP credential bytes;
- merge or release the branch.

The current working `pc-control` transport remains unchanged.
