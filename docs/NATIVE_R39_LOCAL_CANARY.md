# Native MCP R39 — staged local canary / operator cutover readiness

Release decision: **NO PRODUCTION CUTOVER**.

R39 composes the accepted R32 local-canary contracts, R33 live read-only Windows
preflight, R37 operator lifecycle, and R38 source-pin recovery into one staged
local operator package. It does not replace or stop the production GitHub relay.

## Exact authority

- repository: `foto6/help-pc-2`
- R39 task head: `d8c7661d52670fe50e58bc68d50f59a624253e44`
- accepted parent: `a0d8438f0e4fa93e6be50402efb6783f92c3412b`
- accepted parent CI: `37406258361 SUCCESS`
- R38 source recovery acceptance CI: `37405176472 SUCCESS`
- active source authority: `pc.control.direct_source_authority.v2`
- current authority: `github_relay`

The source pin is committed at
`conformance/r39_local_canary/source-pin.json`.

## R39 contract

`native_mcp.local_canary.r39.v1` has only:

- `SOURCE_READY`
- `READY_FOR_STAGED_LOCAL_CANARY`
- `BLOCKED`

CI/source fixtures remain `SOURCE_READY`. A coordinator live preflight may
reach `READY_FOR_STAGED_LOCAL_CANARY`; this is not a cutover authorization and
does not claim an actual direct-lane canary pass.

All R39 evidence keeps:

- `current_authority=github_relay`
- `github_relay_fallback_enabled=true`
- `side_effect_mirroring=false`
- `automatic_side_effect_replay=false`
- `actual_pc_control_cutover=false`
- `production_relay_replaced=false`

## One-command Windows read-only preflight

R39 wraps the accepted R33 preflight. It auto-discovers only the non-secret
inputs R33 already permits and requires a credential **file path**, never
credential bytes.

Example:

```powershell
pwsh -NoProfile -File .\tools\r39-local-canary.ps1 `
  -Action Preflight `
  -RelayRepo "C:\path\to\dedicated-relay-checkout" `
  -NativeRelayUrl "http://127.0.0.1:<native-relay-port>" `
  -NativeRelayTokenFile "C:\secure\native-relay-token.txt" `
  -NativeDeviceId "<device-id>"
```

This creates only R33/R32 read-only evidence under `.r39-canary\...`. It does
not start, stop, repoint, install, or replace the production relay.

## Stage an isolated local canary package

```powershell
pwsh -NoProfile -File .\tools\r39-local-canary.ps1 `
  -Action Stage `
  -RelayRepo "C:\path\to\dedicated-relay-checkout" `
  -NativeRelayUrl "http://127.0.0.1:<native-relay-port>" `
  -NativeRelayTokenFile "C:\secure\native-relay-token.txt" `
  -NativeDeviceId "<device-id>" `
  -CandidatePort 0
```

The stage action:

1. runs R33 read-only preflight;
2. refuses staging unless R33 is `READY_FOR_COORDINATOR_CANARY`;
3. creates an isolated R39 root under `.r39-canary`;
4. assigns a loopback-only candidate identity
   `native-mcp-r39-canary-<id>`;
5. rehearses R37 lifecycle semantics on an isolated lifecycle state file;
6. records one lifecycle status snapshot;
7. generates a cutover plan with `apply_authorized=false`;
8. generates reboot/autostart contract state `STAGED_NOT_INSTALLED`;
9. writes the exact R32 RunCanary command for later explicit coordinator review.

The Stage action **does not execute** that R32 canary command.

## Lifecycle validation

R39 requires the exact sequence:

```text
RUNNING
→ PAUSED
→ DRAINING
→ RECONCILIATION_REQUIRED
→ PAUSED
→ RUNNING
→ RUNNING
```

The second `RUNNING` proves resume idempotency.

During `RECONCILIATION_REQUIRED`, resume must fail with
`automatic_replay=false`. Clearing the final reconciliation moves to
`PAUSED`, never directly to `RUNNING`; a separate explicit resume is
required.

One status command remains:

```text
node tools/r39-local-canary.js status --state-file <isolated-lifecycle-state>
```

It reports:

- native MCP host;
- control service;
- executor;
- GitHub relay fallback;
- direct lane;
- reconciliation state;
- authority.

The GitHub relay fallback remains enabled and current authority.

Explicit resume:

```text
node tools/r39-local-canary.js resume --state-file <isolated-lifecycle-state>
```

Resume is idempotent while already RUNNING and is refused while reconciliation
is required.

## Read-only canary command

To obtain the reviewed command without executing it:

```powershell
pwsh -NoProfile -File .\tools\r39-local-canary.ps1 `
  -Action RunReadOnlyCanary `
  -RelayRepo "C:\path\to\dedicated-relay-checkout" `
  -NativeRelayUrl "http://127.0.0.1:<native-relay-port>" `
  -NativeRelayTokenFile "C:\secure\native-relay-token.txt" `
  -NativeDeviceId "<device-id>"
```

R39 prints the exact R32 command and
`NOT_EXECUTED_BY_R39_WRAPPER`. This milestone does not run the live canary
automatically.

## Cutover plan is generator-only

The R39 cutover-plan contract is `native_mcp.cutover_plan.r39.v1`.

Every generated plan contains:

- `apply_authorized=false`
- `executable_cutover_action=null`
- `production_cutover_performed=false`
- `fallback_authority=github_relay`
- `automatic_side_effect_replay=false`

A later separately authorized milestone is required to apply any cutover.

## Staged reboot/autostart contract

The R39 reboot/autostart contract is
`native_mcp.reboot_autostart_stage.r39.v1`.

R39 only emits `STAGED_NOT_INSTALLED`. It records the isolated service
identity, loopback port, persisted R37 state file, startup/status/resume command
contracts and reboot semantics.

It explicitly records:

- service installed: false
- scheduled task installed: false
- startup-folder modified: false
- registry Run key modified: false
- paused stays paused after restart
- draining stays draining
- reconciliation-required stays blocked
- clearing reconciliation still requires explicit resume
- automatic side-effect replay: false

Because nothing is installed, the R39 rollback action is null with reason
`nothing_registered_in_r39`.

## Deterministic readiness artifact

CI generates:

`r39-local-canary-readiness-<os>.json`

The artifact is exact-head bound and remains `SOURCE_READY` because CI does
not execute a live coordinator canary. Its generated marker is deterministic
(`CI_EXACT_HEAD`) and its digest covers the exact head/run/OS plus the accepted
R38 lineage.

## Stopping rules

Stop and preserve GitHub relay authority if:

- R33 preflight is not READY;
- relay health/queue/process evidence is stale or ambiguous;
- lifecycle status requires reconciliation;
- any unknown side-effect outcome exists;
- GitHub relay fallback is unavailable;
- registry/schema/protected-path evidence drifts;
- candidate root is outside `.r39-canary`;
- candidate bind is not loopback;
- lifecycle resume would bypass reconciliation;
- any plan attempts to install/register a service/task or mutate firewall/tunnel;
- any plan attempts to replace the production relay.

## Milestone safety

R39 does **not**:

- replace or stop the production GitHub relay;
- restart/repoint the current Bridge/MCP stack;
- install a service or scheduled task;
- mutate firewall or tunnels;
- register a remote MCP/plugin endpoint;
- perform a live production cutover;
- authorize blind replay of UNKNOWN effects.

The final CI readiness state for this milestone is expected to remain
**SOURCE_READY** until the coordinator explicitly runs the local staged package.
