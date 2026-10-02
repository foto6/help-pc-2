# Native MCP R32 — local read-only canary operator

Release state for this milestone: **SOURCE_READY**.

R32 does not update/install the private pc-control plugin and does not replace,
stop, restart, repoint, or cut over the current GitHub-relay authority. It
packages the operator flow required for a later coordinator-run read-only
comparison against an isolated R30/R31 direct-MCP candidate.

## Exact source authority

- repository: `foto6/help-pc-2`
- R32 starting SHA: `6bf59b63b4681966f02c14248caccd6b1783f616`
- exact R31 CI at that SHA: `36989774978` SUCCESS
- inherited R30 direct-remote SHA:
  `29cefa62efcf3f3295dca32b0a202b21c5831969`
- current authority: `github_relay`
- release gate: `NO_LIVE_CUTOVER`

Pinned source metadata is committed in
`conformance/r32_local_canary/source-pin.json`.

## What R32 adds

R32 provides four operator surfaces:

1. isolated loopback direct-MCP candidate startup;
2. current GitHub-relay authority snapshot;
3. explicit read-only candidate canary and comparison;
4. candidate-only cleanup.

The Windows coordinator wrapper is:

`tools/r32-local-canary-operator.ps1`

It has these actions:

- `StartCandidate`
- `AuthoritySnapshot`
- `Canary`
- `Cleanup`
- `RunCanary`

`RunCanary` composes the first three actions and always executes candidate
cleanup in a `finally` block.

## Isolation boundary

The R32 candidate is a child process launched with:

- loopback bind only: `127.0.0.1`;
- a new per-run MCP client credential;
- a per-run durable state directory;
- no task registration;
- no service registration;
- no firewall changes;
- no tunnel changes;
- no current-authority mutation.

The direct candidate still uses the already-authorized Native relay/device
credential to reach the existing native relay transport. Its MCP client
credential is generated independently and must never equal the relay credential.

The descriptor contract is:

`pc.control.r32.isolated_candidate.v1`

The descriptor records PID, loopback MCP/health endpoints, state directory,
token-file path, isolation flags, and start timestamp. It does not contain the
token bytes.

Candidate stdout/stderr are written inside the isolated run directory. The
candidate runner logs endpoint/PID only; credential bytes are never logged.

## Candidate cleanup

Cleanup reads the exact candidate descriptor and stops only the PID recorded in
that descriptor.

On Windows, before `Stop-Process` R32 verifies that the live process command
line contains:

- `r32-isolated-candidate.js`;
- the exact candidate descriptor path.

If that identity proof fails, cleanup refuses to stop the process.

Cleanup never searches for or stops:

- `github_relay.py`;
- the current Bridge;
- another MCP host;
- a Windows service;
- a scheduled task.

The candidate token file is removed after candidate shutdown. Evidence and
non-secret state files are retained for coordinator review.

## Current GitHub-relay authority snapshot

The authority snapshot is read-only.

The PowerShell operator runs the **current dedicated relay checkout's own**
`tools/github_relay.py --status` command. On Windows it passes the currently
observed matching relay PID/parent-PID identities to that producer status probe.

No request/result queue entry is created by the snapshot command.

The persisted authority snapshot combines two explicitly separated evidence
classes:

### Live authority facts

From the current GitHub-relay watchdog:

- watchdog contract/version;
- HEALTHY/DEGRADED/BLOCKED mapping;
- logical process count;
- health PID observed/not observed;
- local/remote tracking heads;
- head relation;
- remote-tracking queue counters;
- stale reasons;
- reconciliation-required flag;
- recovery semantics.

Raw relay errors/results are not persisted. Only bounded error classification
is retained.

### Source-bound pc-control surface

From the exact R32/R31 source:

- native registry digest;
- Desktop Commander compatibility registry digest;
- protected-path policy identity;
- per-tool read-only/side-effect classification;
- per-tool input-schema digest;
- reconciliation status identity;
- `automatic_replay=false`.

This provenance split is deliberate. R32 does not invent live plugin facts that
the GitHub relay watchdog does not publish.

The snapshot contract is:

`pc.control.r32.authority_snapshot.v1`

Any unknown watchdog schema, ambiguous/missing process identity, reconciliation
requirement, or unsafe replay semantics makes the snapshot unsuitable for a
passing canary comparison.

## Explicit read-only direct canary

The only allowed candidate tools are:

- `device.ping`
- `device.info`

R32 rejects every other tool from the canary, including other read-only tools.
This is stricter than simply checking `effect=read_only`.

The direct candidate canary performs:

1. candidate health;
2. MCP initialize as part of direct client connection;
3. `tools/list`;
4. source/authority surface comparison;
5. `device.ping`;
6. `device.info`.

No side-effect tool may be mirrored or invoked.

R31's evidence layer hashes candidate tool results. Raw device information is
not stored in the R32 canary record.

The R32 evidence contract is:

`pc.control.r32.local_canary_evidence.v1`

The evidence always records:

- `side_effect_calls=0`;
- `replay_authorized=false`;
- `fallback_authorized=false`;
- `current_authority=github_relay`;
- `current_authority_changed=false`;
- `actual_pc_control_cutover=false`.

## Readiness comparison

The canary fails closed on:

- current authority watchdog not source-bound/healthy;
- current authority process ownership unknown/ambiguous;
- current authority reconciliation requirement;
- native registry digest mismatch;
- compatibility registry digest mismatch;
- protected-path policy mismatch;
- tool-set mismatch;
- read-only/side-effect classification mismatch;
- input-schema digest mismatch;
- direct health mismatch;
- direct health latency over the bound;
- direct transport not connected;
- direct Executor not responsive;
- candidate reconciliation semantics other than
  `reconciliation_required + automatic_replay=false`;
- initialize failure;
- safe-tool canary failure;
- candidate descriptor not proving isolated loopback operation.

Under any mismatch, readiness is `BLOCKED`. Read-only diagnostic evidence is
retained.

## Synthetic CI cannot claim a live canary pass

R32 has four externally visible readiness labels:

- `SOURCE_READY`
- `READ_ONLY_CANARY_PASS`
- `READY_FOR_EXPLICIT_PLUGIN_CANDIDATE`
- `BLOCKED`

CI fixtures use `evidence_origin=synthetic_ci` and
`actual_coordinator_run=false`.

Even with otherwise matching synthetic fixtures, the decision remains
`SOURCE_READY`.

`READ_ONLY_CANARY_PASS` requires all of:

- `evidence_origin=coordinator_live_read_only_canary`;
- `actual_coordinator_run=true`;
- a valid isolated candidate descriptor;
- exact healthy authority/candidate comparison;
- candidate canary PASS;
- zero side-effect calls;
- replay/fallback both false.

R32 CI readiness artifacts therefore remain `SOURCE_READY` until an actual
coordinator-run artifact is supplied later.

## Coordinator inputs for a real read-only canary

A later explicitly authorized coordinator run needs:

- this exact R32 checkout;
- path to the current dedicated GitHub-relay checkout;
- current Native relay URL;
- path to the Native relay credential file;
- Native device ID;
- optional Native desktop ID;
- PowerShell 7+;
- Node.js 20+ and repository dependencies installed.

Credential bytes must be provided through the credential file, never as command
arguments.

## One-command coordinator canary

Example only; **not executed in this milestone**:

```powershell
pwsh -NoProfile -File .\tools\r32-local-canary-operator.ps1 `
  -Action RunCanary `
  -ExplicitLiveReadOnlyCanary `
  -RelayRepo "C:\path\to\dedicated-pc-relay-checkout" `
  -NativeRelayUrl "http://127.0.0.1:<native-relay-port>" `
  -NativeRelayTokenFile "C:\secure\native-relay-token.txt" `
  -NativeDeviceId "<device-id>"
```

The command creates a new `.r32-canary\<run-id>` directory and returns the
canary evidence path.

Expected persisted files include:

- `candidate.json`
- `candidate-state\...`
- `candidate.stdout.log`
- `candidate.stderr.log`
- `authority-watchdog.json`
- `authority-snapshot.json`
- `canary-evidence.json`

The candidate token file is removed during cleanup.

## Individual commands

Start candidate only:

```powershell
pwsh -NoProfile -File .\tools\r32-local-canary-operator.ps1 `
  -Action StartCandidate `
  -RunDir <isolated-run-dir> `
  -NativeRelayUrl <loopback-native-relay-origin> `
  -NativeRelayTokenFile <credential-file> `
  -NativeDeviceId <device-id>
```

Snapshot current GitHub relay authority:

```powershell
pwsh -NoProfile -File .\tools\r32-local-canary-operator.ps1 `
  -Action AuthoritySnapshot `
  -RunDir <isolated-run-dir> `
  -RelayRepo <dedicated-github-relay-checkout>
```

Run canary against already-started candidate:

```powershell
pwsh -NoProfile -File .\tools\r32-local-canary-operator.ps1 `
  -Action Canary `
  -ExplicitLiveReadOnlyCanary `
  -CandidateDescriptor <candidate.json> `
  -AuthoritySnapshot <authority-snapshot.json>
```

Candidate cleanup only:

```powershell
pwsh -NoProfile -File .\tools\r32-local-canary-operator.ps1 `
  -Action Cleanup `
  -CandidateDescriptor <candidate.json>
```

## Stopping rules

Stop the canary and keep the current authority unchanged if any of the following
occurs:

- authority watchdog is not `HEALTHY`;
- relay process ownership cannot be proved exactly;
- reconciliation is required;
- authority or candidate registry/schema/policy digests mismatch;
- direct health is BLOCKED/unknown or over latency bounds;
- direct initialize or `tools/list` fails;
- either safe tool is missing, reclassified, or fails;
- any canary tool is side-effecting;
- candidate cannot prove loopback + isolated state;
- cleanup PID/command identity check fails.

Never:

- route a failed direct canary call to the GitHub lane as replacement;
- replay an UNKNOWN mutation;
- mirror a side-effect to both lanes;
- stop/restart the current GitHub relay;
- stop/restart Bridge/current MCP;
- register a service/task;
- modify firewall/tunnel settings;
- update/install the private plugin from this operator.

## Current milestone result

No coordinator-run live canary artifact exists in R32 source/CI.

Therefore the required state remains:

**SOURCE_READY**

The existing pc-control/GitHub-relay working path is unchanged.
