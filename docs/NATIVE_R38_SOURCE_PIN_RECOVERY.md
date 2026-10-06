# Native MCP R38 — source-pin recovery / operator lifecycle closeout

Release decision: **NO LIVE CUTOVER**.

R38 repairs the stale source authority lineage that caused exact-head CI
`37398892815` to fail after all earlier R29/R30/R31/R37 gates had passed.

## Root cause

The historical R31 source pin intentionally froze the exact R30 implementation:

- R30 SHA `29cefa62efcf3f3295dca32b0a202b21c5831969`
- R30 CI `36985223664` SUCCESS
- historical `src/direct-remote-mcp.js` blob
  `cb6d74888514d3262d206df4f3cbd13a1f8899e2`

That pin was correct for R31, but it remained wired as the **active** readiness
validator after accepted successors changed implementation bytes.

The first observed failure was:

- path: `src/direct-remote-mcp.js`
- historical expected blob:
  `cb6d74888514d3262d206df4f3cbd13a1f8899e2`
- current blob:
  `8df50ca3792091625d4de1143b4625ae2f970ecd`

The change is legitimate.

R36 commit `7f643b4f1f803b637e1b377ac4989bc79d03c4dd`
corrected the Host-header parser from:

`/[s/]/.test(value)`

to:

`/[\s/]/.test(value)`

The former incorrectly rejected any valid hostname containing the letter
`s`. The successor keeps whitespace and slash rejection while allowing valid
public DNS hosts.

R36 added:

- `test/r36-public-host-gate.test.js`
- exact R36 source pin
- live public HTTPS canary evidence
- 48/48 focused R30/R33/R35/R36 regression evidence
- no-cutover / no-replay invariants

Therefore restoring the old R30 bytes would reintroduce a known parser defect.

## Additional accepted successors

The stale R30 tuple covered other files that had also changed legitimately.

R35 commit `f9b88d8bb4a5e0844ec8448d09fafa96f0aff7e9`
introduced explicit quiescent device-epoch rebind semantics. It changed:

- `src/mcp-host.js`
- `src/mcp-runtime-config.js`
- `src/native-relay-provider.js`

The R35 source pin proves those bytes and preserves:

- same device identity;
- same Executor digest;
- exact control owner;
- no unfinished actions;
- no unsettled facade requests;
- no open process handles;
- explicit provider rebind;
- `automatic_replay=false`.

R37 commit `59090e82d1c20e8c6ffb40fbcf38e7a0e34405b5`
then legitimately advanced `src/mcp-runtime-config.js` again to wire the
durable operator lifecycle.

## Active authority

The original R30 tuple is preserved byte-for-byte at:

`conformance/r31_pc_control_direct/source-pin.r30-historical.json`

The active consumer now reads:

`conformance/r31_pc_control_direct/source-pin.json`

Contract:

`pc.control.direct_source_authority.v2`

This is a composite lineage authority, not a blind replacement hash.

It binds:

1. historical R30 SHA + successful CI;
2. exact R35 successor pin/blob;
3. exact R36 successor pin/blob;
4. exact R37 lifecycle source blob/contract;
5. the active bytes for every path formerly covered by R31;
6. current GitHub-relay authority;
7. no replay / no cutover / no live-registration invariants.

The active blob set is:

| Path | Active Git blob |
| --- | --- |
| `src/direct-remote-mcp.js` | `8df50ca3792091625d4de1143b4625ae2f970ecd` |
| `src/mcp-host.js` | `3026902f00adf1b453645a28689ecd72f4308ee4` |
| `src/mcp-runtime-config.js` | `a6f09571e8ffe5cd10acfbcd8b489e9a07d5b600` |
| `src/native-relay-provider.js` | `7dc50fa87102f6bf21b1e612c3c8d283044a3fb4` |
| `bin/pc-native-mcp-remote.js` | `ba636cc1f1f95dce7fa92bf7581b1924d386dfab` |
| `docs/NATIVE_R30_DIRECT_REMOTE_MCP.md` | `a71b700068f7276df5e3c824502cde99cfbc9cb3` |
| `conformance/r30_direct_remote/readiness.template.json` | `9cfaaab9fd4b561295bdc336842e1fc0ded41672` |

## Drift regression

`validateR31SourcePin()` now accepts an injectable read function for
deterministic validation tests.

R38 includes a regression that keeps the exact repository/head/pin metadata
unchanged but substitutes the old incorrect direct-remote bytes in the
checkout. Validation fails with:

`R31_SOURCE_BLOB_DRIFT`

and exact path:

`src/direct-remote-mcp.js`

The exact accepted bytes pass.

This preserves fail-closed source validation. R38 does **not** simply change an
expected hash until CI turns green.

## R37 operator lifecycle preserved

Contract:

`native_mcp.operator_lifecycle.r37.v1`

Exact operator states remain:

- `RUNNING`
- `PAUSED`
- `DRAINING`
- `RECONCILIATION_REQUIRED`

Resume remains explicit and idempotent.

Unknown side effects still block resume and retain
`automatic_side_effect_replay=false`.

Clearing the final reconciliation item moves the lifecycle to `PAUSED`, not
`RUNNING`; another explicit resume is required.

The one-command status surface remains:

`node tools/r37-operator-lifecycle.js status`

It reports:

- native MCP host;
- control service;
- Executor;
- GitHub relay fallback;
- direct lane;
- reconciliation state;
- current authority.

## Failing-run evidence

Exact failing run `37398892815` at
`b13243e687173a5342356361956a2fd5eec81138` showed:

Ubuntu:

- R29 relay-cutover QA: SUCCESS
- R30 direct remote: SUCCESS
- R31 direct candidate: SUCCESS
- R37 operator lifecycle: SUCCESS
- full test suite: SUCCESS
- R31 readiness generation: FAILED only on stale historical blob pin

Windows:

- R29 relay-cutover QA: SUCCESS
- R30 direct remote: SUCCESS
- R31 direct candidate: SUCCESS
- R37 operator lifecycle: SUCCESS

The Windows job was cancelled after the Ubuntu readiness failure.

This is recorded as diagnostic evidence, not misrepresented as a successful
acceptance run.

## R38 acceptance

The active source authority has a separate
`recovery_acceptance` field.

R38 first validates the repaired lineage with exact-head CI. Only after that
successful run is available is its run ID pinned and status advanced from:

`pending_r38_exact_head_ci`

to:

`accepted`.

A final exact-head Windows + Ubuntu run then validates the accepted tuple.

## Readiness artifact

CI generates:

`r38-source-pin-recovery-readiness-<os>.json`

The artifact includes:

- final exact source SHA;
- CI run ID;
- active source contract;
- active blob set;
- accepted lineage;
- historical predecessor;
- recovery acceptance CI;
- blocker list;
- R37 lifecycle contract/status command;
- current authority;
- no-cutover / no-registration / no-firewall-tunnel-mutation assertions.

## Safety boundary

R38 performs no:

- remote plugin registration;
- production cutover;
- current relay/Bridge/MCP restart or repoint;
- firewall/tunnel mutation;
- credential collection or logging;
- merge/release.

GitHub relay remains current authority.
