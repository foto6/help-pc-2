# Native MCP R33 — live read-only canary preflight

Milestone state: **BLOCKED until the coordinator executes this preflight on the authorized Windows machine**.

R33 prepares the exact preflight for the R32 live read-only canary. It does not run the canary, update the private pc-control plugin, restart/repoint the GitHub relay, restart Bridge/MCP, or mutate firewall/task/service/tunnel state.

## Exact source authority

- repository: `foto6/help-pc-2`
- exact R33 start: `b235e319a2afe049a708d48329cc6d80d988256f`
- exact R32 CI: `36993946760` SUCCESS
- current authority: `github_relay`
- actual live canary at R33 source time: false
- release gate: `NO_LIVE_CUTOVER`

Source pin: `conformance/r33_live_readonly_preflight/source-pin.json`.

## One-command preflight

On the authorized Windows coordinator:

```powershell
pwsh -NoProfile -File .\tools\r33-live-readonly-canary-preflight.ps1
```

Optional explicit non-secret inputs can be supplied when auto-discovery cannot safely prove them:

```powershell
pwsh -NoProfile -File .\tools\r33-live-readonly-canary-preflight.ps1 `
  -RelayRepo "C:\path\to\dedicated-relay-checkout" `
  -NativeRelayUrl "http://127.0.0.1:<port>" `
  -NativeRelayTokenFile "C:\secure\native-relay-token.txt" `
  -NativeDeviceId "<device-id>"
```

The token file path is non-secret metadata. Token bytes are read only into memory for authenticated GET probes and are never written to discovery/preflight evidence.

## Safe auto-discovery

R33 may auto-discover only:

- the dedicated `github_relay.py` checkout from the running relay process command line;
- matching relay PID/parent-PID lineage;
- local native relay origin from `PC_NATIVE_RELAY_URL` in the coordinator process environment;
- relay credential file path from `PC_NATIVE_RELAY_TOKEN_FILE` in the coordinator process environment;
- device identity from authenticated read-only `GET /v1/relay/devices`.

R33 does **not**:

- scrape token bytes from another process environment;
- persist process command lines;
- port-scan localhost;
- infer a credential path from guesses;
- inspect arbitrary credential stores.

If no safe token-file path is available, the exact blocker is:

`BLOCKED_MISSING_CREDENTIAL_PATH`

## Read-only authority checks

The current GitHub relay remains the authority.

R33 runs the relay checkout's own:

`tools/github_relay.py --status`

with the observed PID/parent-PID evidence and then reuses the R32 source-bound authority snapshot logic.

To permit the coordinator canary, R33 requires:

- exactly one logical relay;
- watchdog state `HEALTHY`;
- no reconciliation requirement;
- `automatic_side_effect_replay=false`;
- UNKNOWN requires outcome lookup;
- local/remote head relation exactly `equal`;
- local and remote tracking heads identical;
- no stale reasons;
- exact native registry digest;
- exact Desktop Commander compatibility registry digest;
- exact protected-path policy identity;
- exact per-tool read-only/side-effect classification;
- exact per-tool input-schema digests.

Any drift returns `BLOCKED`.

## Native relay checks

With the credential bytes held only in memory, R33 performs only:

- `GET /v1/relay/health`
- `GET /v1/relay/devices`

The relay origin must be explicit loopback.

Required health fields:

- `status=ok`
- `running=true`
- `process_alive=true`
- `transport_connected=true`
- `queue_progressing=true`
- `executor_responsive=true`

Device selection is:

1. the explicit device ID if supplied; otherwise
2. exactly one online device.

Multiple online devices without an explicit selection block as `BLOCKED_DEVICE_IDENTITY_AMBIGUOUS`.

The selected device must be online with a session epoch, exact capability digest, and Executor digest.

## Preflight decision

The machine-readable state is exactly:

- `READY_FOR_COORDINATOR_CANARY`
- `BLOCKED`

A READY report still contains:

- `actual_read_only_canary_executed=false`
- `read_only_canary_pass_claimed=false`
- `actual_pc_control_cutover=false`
- `automatic_replay_authorized=false`
- `fallback_authorized=false`
- `live_mutation_authorized=false`

R33 never reports `READ_ONLY_CANARY_PASS`.

## Generated coordinator command

Only when every preflight gate passes, R33 emits a PowerShell command for the already-built R32 operator:

`tools/r32-local-canary-operator.ps1 -Action RunCanary -ExplicitLiveReadOnlyCanary ...`

The command contains:

- R32 script path;
- isolated output directory;
- dedicated relay checkout path;
- loopback native relay origin;
- credential file **path**, not bytes;
- device ID;
- desktop ID.

R33 does not execute that command.

## Evidence files

Each preflight run creates a new `.r33-preflight\<run-id>` directory containing:

- `authority-watchdog.json`
- `authority-snapshot.json`
- `runtime-discovery.json`
- `preflight-report.json`

No credential bytes or raw process command lines are stored.

Contracts:

- `pc.control.r33.runtime_discovery.v1`
- `pc.control.r33.native_relay_probe.v1`
- `pc.control.r33.live_readonly_canary_preflight.v1`

## Stable blocker examples

- `BLOCKED_MISSING_CREDENTIAL_PATH`
- `BLOCKED_RELAY_CHECKOUT_NOT_DISCOVERED`
- `BLOCKED_RELAY_PROCESS_AMBIGUOUS`
- `BLOCKED_AUTHORITY_NOT_HEALTHY`
- `BLOCKED_AUTHORITY_RECONCILIATION_REQUIRED`
- `BLOCKED_AUTHORITY_HEAD_RELATION`
- `BLOCKED_AUTHORITY_STALE_QUEUE`
- `BLOCKED_SOURCE_PROFILE_DRIFT`
- `BLOCKED_PROTECTED_POLICY_DRIFT`
- `BLOCKED_NATIVE_RELAY_ORIGIN_UNSAFE`
- `BLOCKED_NATIVE_RELAY_UNAVAILABLE`
- `BLOCKED_NATIVE_RELAY_UNHEALTHY`
- `BLOCKED_DEVICE_IDENTITY_MISSING`
- `BLOCKED_DEVICE_IDENTITY_AMBIGUOUS`
- `BLOCKED_DEVICE_OFFLINE`
- `BLOCKED_DEVICE_CAPABILITY_DIGEST`

## Stopping rules

Do not run R32 `RunCanary` unless R33 returns `READY_FOR_COORDINATOR_CANARY`.

Stop and preserve the GitHub relay as authority when:

- the credential path is missing;
- relay ownership is ambiguous;
- watchdog health is stale/degraded/non-HEALTHY;
- reconciliation is required;
- head relation is not exact `equal`;
- stale queue evidence exists;
- registry/schema/protected policy differs;
- native relay is not loopback or not healthy/progressing;
- device identity is missing, ambiguous, offline, stale, or digest-invalid.

Never use a direct-lane failure as authority to replay or fall back a mutation.

## This milestone

No pc-control tool namespace is exposed to this agent chat, so this milestone does not execute the Windows preflight or actual R32 canary. CI validates the logic with fixtures and emits an exact-head readiness artifact whose state remains `BLOCKED` with `LIVE_WINDOWS_PREFLIGHT_NOT_EXECUTED_IN_CI`.

The current working pc-control/GitHub-relay path remains unchanged.
