# R18 single-owner R15c -> R18 quiescent legacy session migration

Status: an explicit Stage 1 source API, NOT a production rollout instruction. Install/cutover belongs to Stage 2.

## Why this exists

The old R15c Facade can retain a stale session while its Control Plane still records the desktop as owned. Blindly creating a new session leaks or collides with that owner. Blindly closing the old session is worse when an old side effect has an unknown outcome or an interactive process is still alive.

R18 therefore exposes migrateLegacyQuiescentSession, plus an optional legacyMigrationSessionId parameter in createConfiguredNativeMcpRuntime. This is an exact-ID one-time retirement, not a general JSON repair or auto-reset. There are no accounts, OAuth prompts, roles or remote administrative endpoint.

## Preconditions checked by the implementation

1. The exact historical Facade session ID and its desktop ID are supplied; no automatic selection among multiple candidates.
2. Its status is stale, staleReason is absent (historical R15 snapshot), and lastSeenAtMs is beyond the configured TTL.
3. Registry and Executor digests match current negotiated capabilities; there is no competing live Facade owner.
4. All previous Control actions of that session are TERMINAL; any executing, pending, unknown or reconciliation action blocks migration.
5. Successful process creation/termination receipts are rebuilt from the durable Control journal in insertion order. ANY open process handle, missing creation evidence or state inconsistency blocks migration.
6. Control desktop owner must match exactly that session. If Control was already persisted CLOSED and ownership was released before the Facade save was interrupted, completing the old Facade marker is allowed.
7. Only after those checks, close the old Control session if needed, then write old Facade status closed; no Executor command is invoked.

Example for a future authorized, isolated operator launcher (pseudocode; do not apply to live R15c while it is running):

~~~js
const stack = await createConfiguredNativeMcpRuntime({
  stateDir: verifiedIsolatedCopyOfStateDirectory,
  desktopId: verifiedDesktopId,
  legacyMigrationSessionId: exactOldFacadeSessionId,
});
// This returns ONLY if all durable reconciliation checks succeed.
// Follow with isolated read-only MCP and explicit owner/epoch assertions.
~~~

Do NOT obtain the session ID by printing a raw Facade debugSnapshot: it also contains resume tokens. A safe installer should display ONLY local session ID, desktop, status, age, owner, count of outstanding actions and count of live handles. Do not manually remove, mutate or regenerate old journal records. Do not put device tokens in operator JSON, GitHub comments or CLI arguments.

Blocked results are intentional, not a reason to force-reset:
- SESSION_MIGRATION_BLOCKED: exact status/pin/owner, unresolved action, or live handle not eligible.
- CAPABILITY_DRIFT: Executor or registry mismatch.
- SESSION_HANDLE_RECONCILIATION_REQUIRED: a successful process creation lacks a durable handle.
- SESSION_DEVICE_BINDING_MISSING or STALE_DEVICE_SESSION: an old live handle cannot be attached without exact original device boot/epoch evidence.

Tests include: safe quiescent migration, wrong pinned ID, open handle refusal, half-complete two-store migration recovery, and configuration API recovery from real JSON stores. A live R15c installation is NOT mutated by those fixture tests.

## Resolving an expired session with an old uncertain action

Do not force-migrate or reset a stale owner whose old write/process result is
uncertain. Retrieve the original internal resume token from its existing
private runtime context; do NOT print or store it in GitHub/CLI arguments.
Within the already restricted loopback control transport, call
lookupRequest({sessionId,requestId,resumeToken}) to inspect that old journal
and, if necessary, reconcileRequest with the SAME exact tuple. This is
journal-only; it never substitutes a fresh user mutation. Only after original
actions are terminal AND all handles are closed can the pinned historical
migration run. Absent/wrong old token blocks stale-journal access. A current
runtime with an open process handle should instead retain the SAME epoch-bound
owner session where proven, not run the quiescent migration.

## ACTIVE historical session (different from stale-session migration)

Do not run the old stale quiescent migration for a still-ACTIVE session whose
Control desktop ownership is valid. When no historical action is unsettled
and no legacy process handle is open/unprojected, the R18 reconnect or first
safe direct invocation may capture a FRESH, authoritative device boot epoch
from the already bound local Relay. That epoch applies to NEW process handles
only; it is never treated as evidence of the boot on which an old unfinished
action might have executed. An unsettled old action, stale Control ownership,
or a previous open process handle blocks this epoch binding.

Old closed-session process-start journal receipts are immutable historical
results, NOT proof the old PID/handle is still alive. Looking one up or asking
for a reconciliation tick must never recreate the handle or a process.
