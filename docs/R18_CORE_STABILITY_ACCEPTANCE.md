# R18 — Personal Native MCP core stability acceptance

Date: 2026-09-29. Scope: STAGE 1 ONLY (source-level core fixes and isolated host validation).
Parent Control baseline: 32659a967e606216d3813d58e3abad338dbfe7d6 (R17, independent Windows+Ubuntu CI PASS).
Companion Python Executor precision fix: foto6/help-pc-1@30c65d04e905af61dd731904b454fb08153f589a (independent Windows+Ubuntu CI PASS).
Branch: agent/native-mcp-core-stability-r18-20260929.
Result must be reported as a candidate until exact-head full CI and isolated checks have finished. Neither original live R15c nor Bridge R7+ is overwritten.

## Owner/product contract

PERSONAL SINGLE OWNER. Do not add OAuth, logins, RBAC, user accounts or multi-tenant role management.
The full native capability set remains available subject to existing Executor policy. Host-side request handling is no longer artificially read-only after a TTL; any NEW side-effecting request can renew its idle session BEFORE dispatch, but an old uncertain operation or unprovable process-handle still prevents that renewal.
Preserve automatic loopback transport token and exact Host/Origin checks. They protect the local endpoint without prompting the owner.

## Deterministic faults observed against frozen R17 BEFORE edits

Seven focused negative scenarios: 1 PASS / 6 FAIL. The failures were:
- New file.write as the first call after idle TTL returned an error.
- Duplicate process.terminate after the handle was closed returned STALE_PROCESS_HANDLE instead of the cached receipt.
- Crash after Control persisted an action but before Facade persisted actionId left an "allocating" request at ACTION_RECORD_MISSING.
- Identical mutation requestId after renewal failed instead of safely reading its terminal durable receipt.
- Long-lived process handle was impossible to renew even if its device/boot epoch had remained unchanged.
- A quiescent historical R15 stale Control owner could be detected but lacked an explicit migration/reconciliation API.
A separate later negative regression proved that normal close + new session could run an old identical mutation request_id TWICE (two physical writes). This is addressed by a single-owner durable request ID across all Facade sessions.

## R18 implementation and important invariants

### 1. Before-dispatch idle renewal
The official native and DC-compatibility MCP tool handlers request pre-dispatch renewal for a fresh operation of any effect classification. The Facade permits TTL renewal only after checking the original local resume token, exact Control desktop owner, terminal old action journal, frozen registry and Executor digest, and optional authenticated relay device epoch. None of those checks dispatches or retries an old side effect.

### 2. Durable one-owner mutation IDs
Explicit side-effect request IDs are scoped to the entire single-owner persisted Facade journal, not merely the latest session. Same ID + matching normalized tool/arguments/page returns the original Control action result or reconciliation state via lookup ONLY. Same ID + different content rejects DUPLICATE_REQUEST_MISMATCH without dispatch. More than one ambiguous historical record blocks further execution pending reconciliation.
The automatic fallback ID, when an MCP caller omits request_id, is a new random UUID. Numeric MCP request IDs are transport-local and must not collide across restarts. For retryable mutations the caller MUST provide and retain an explicit request_id.

### 3. Crash-consistent allocation
Facet request status "allocating" is written before Control enqueue. Control persists a deterministic (owner session, request ID) idempotency action BEFORE provider dispatch. On restart an allocating Facade entry recovers via Control.enqueueAction with the same spec; if Control already has the action it returns the original. A mismatch in original type, input, metadata or key fails closed; a missing Control record may be allocated because it was provably not previously dispatched. Tests cover actual on-disk JsonFacadeStateStore + JsonStateStore restart.

### 4. Long-running process handles
Built-in loopback Relay now offers readDeviceIdentity, returning only authenticated deviceId, boot/sessionEpoch and Executor digest from its existing bound device snapshot. No new user auth or remote listener was added.
The Facade captures this identity on session open, checks it on reconnect/use, and reconstructs process-handle state from the terminal Control action journal in persistent insertion order (NOT same-millisecond timestamps or randomly sorted IDs). On idle TTL WITH an open handle, it renews the SAME Facade+Control session and rotates its internal resume token only if the identity/epoch and ownership are exact, all old actions terminal and handles are retained. This does not restart the process or forge handles. Missing epoch evidence, reboot/epoch change, unresolved action, inconsistent Control owner or missing process-creation evidence blocks renewal. Executor itself remains authoritative on individual handle liveness.

### 5. Explicit R15 stale snapshot migration
An opt-in, pinned local method migrateLegacyQuiescentSession retires ONLY one historical stale session with absent staleReason and expired TTL, exact desktop and digest, zero nonterminal actions, zero live or unprojected handles, and an exact matching Control owner. A saved Control-closed / Facade-still-stale interrupted two-store migration can complete safely. Wrong pins, mismatched capabilities, uncertain outcomes, live handles or another owner block. createConfiguredNativeMcpRuntime accepts optional legacyMigrationSessionId so an operator can invoke migration without manually editing JSON or adding logins. This is not an automatic live cutover.

### 6. Shutdown
A graceful close will not silently orphan a live process handle or cancel unsettled work. Runtime waits for in-progress session admission. Unknown-outcome side effects remain journal/reconciliation only; no blind replacement dispatch.

## Evidence matrix

| Test | Result at authoring |
| --- | --- |
| Frozen R17 regression scenarios | 13/13 local Windows PASS |
| New R18 core regression scenarios (including actual persisted restart and migration config) | 22/22 local Windows PASS |
| Real in-memory/signed loopback Relay provider, including boot-epoch drift test | 19/19 local Windows PASS |
| Official MCP SDK against isolated Control with REAL Windows TEMP file I/O and a scoped real Node child process | 1/1 PASS; exactly two distinct file writes, one process start and one process termination, no second effect on cached IDs |
| Combined focused groups | 55/55 PASS on Windows at local freeze |
| Full Windows Node suite | Running at authoring; inspect final log before declaring a result |
| Exact-head Ubuntu + Windows CI | Must both complete before accepting this source candidate |

The isolated end-to-end fixture injects a strict test-only bridge that can read/write ONLY its private TEMP file and launch ONLY its own Node fixture child. It is not evidence that the installed Python R15c service has been upgraded or that the external ChatGPT plugin is registered. Separately, Executor's signed real Windows file.stat -> pinned JS relay decoder precision regression was verified in R17.

Reproduction in a clean checkout:
- npm ci
- node --test test/r17-session-renewal.test.js test/r18-core-stability.test.js test/r18-windows-isolated-host.test.js test/native-relay-provider.test.js
- npm test (full repository suite; includes those tests)
- Cross-platform exact-head CI on the R18 PR.

## Acceptance boundaries and remaining work

This closes the identified SOURCE-CODE Stage 1 session/replay/handle/legacy-migration defects only after exact-head CI passes. It is NOT permission to replace R15c.
A full production cutover requires Stage 2 integration: freeze and pin Executor+Control+Launcher in a new isolated Windows installation, test its actual Python producer↔Relay↔Control communication and service restart/rollback, and verify live isolated read-only plus separately bounded TEMP side effects. The real existing service is untouched.
Native ChatGPT plugin registration / private outbound transport belongs to later stages and remains absent; Desktop Commander is not automatically removed. Long-term retention/compaction of durable request journals also needs an explicit safe design before indefinite unattended use; never silently delete old mutation receipts, as that would invalidate at-most-once guarantees.

## Source-only safety rules followed

No merge into frozen release branches; no overwrite of R15c, no live Windows service restart; no public bind; no login/credential lookup; no arbitrary user-file mutation; no protected-folder traversal. All writes in integration tests occur under newly created isolated operating-system TEMP fixtures, and the only spawned process is a fixture child that is terminated and cleaned up.
