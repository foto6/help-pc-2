# R18 independent Stage-1 journal-link recovery

Date: 2026-09-29. Personal single-owner. Source branch: agent/r18-independent-link-recovery-20260929.
Source parent: foto6/help-pc-2 @ 6827b9e30ed5ca167f4985b11051594a181197c7.
The R18 parent has exact-head Windows+Ubuntu CI PASS:
https://github.com/foto6/help-pc-2/actions/runs/36575206527.

## Independently reproduced omission BEFORE changes

An Executor operation may complete and Control may atomically persist its one Action, while Facade's separate persistent JSON store fails before saving actionId. A recovering active R18 session could re-link through Control idempotency. But when this exact original session later TTL-expires, stale lookupRequest returned "allocating" and reconcileRequest returned an unlinked result even though a completed Control action exists. Any post-renewal retry with the original explicit mutation ID was also blocked. This created a durable stale-journal dead end.

Repro isolated on Windows, exact unchanged parent R18 @ 6827b9e: the one-case audit test failed 0/1:
expected = "completed"; actual = "allocating". The injected Executor action executed once, then ONLY the Facade fixture's actionId/status/response were altered to simulate an interrupted two-store save. No user file or live service was changed.

## Narrow fix

src/native-facade.js #recoverPersistedActionLink(session, request) is a JOURNAL-ONLY read and Facade linkage update; it never enqueues or invokes the Executor. It searches the already-persisted original Control session idempotency key native:<facade-session-id>:<logical-request-id> and insists on exactly one matching action.

Checks: original Control session, provider, Executor action, exact original input, Facade owner ID, request ID, native tool, effect classification, Executor digest and idempotency key. If metadata/input drifts, DUPLICATE_REQUEST_MISMATCH. If multiple matches, fail closed. If NO Action exists, stale lookup/reconcile returns reconciliation_required with reason control_action_not_allocated and never dispatches. Historical streaming inner cursors omitted from the old Facade journal are NOT guessed; such cursor-bearing actions require manual reconciliation.

Use this verified read-only link restoration in expired/closed lookupRequest and reconcileRequest. On a different newly renewed session, restore the link for the original old logical mutation ID before returning its historical receipt. The old terminal process creation receipt is not reprojected to resurrect an invalid process handle: the prior R18 historical-handle fail-closed check is preserved.

## Independent regression evidence

Seven focused tests in test/r18-independent-link-recovery.test.js:
1. Expired old completed Control write restores old receipt through verified local session token, then new-session retry never writes again.
2. No previously allocated Control Action => reconciliation_required, zero dispatch.
3. Tampered Control action input => reject, original effect count remains one.
4. Expired unprojected process.start => historical_handle_receipt_missing, no fake handle resurrection.
5. ACTUAL separate temporary on-disk Control/Facade JSON snapshots reload after a simulated intermediate save => read-only restore exact original Action ID, one physical adapter invocation.
6. First post-TTL same-ID retry restores original receipt without preceding journal lookup, still one effect.
7. Forged Control owner metadata => reject without side effect.

Original R18 independent reproduction: 63/63 focused tests PASS (including official MCP SDK with REAL isolated Windows TEMP file writes and one fixture Node child process); exact-head parent GitHub CI PASS Win+Ubuntu. R18 companion Executor signed Python large integer fix independently PASS both systems, see foto6/help-pc-1 PR #2.

## Acceptance and isolation

This patch is isolated from the parent R18 branch and live R15c. It does NOT auto-resend old operations, allocate new Control records from a stale journal, reset state, publish a socket, or add OAuth/RBAC. For exact child HEAD, record full Windows node --test and exact-head Ubuntu+Windows pull-request CI before final Stage-1 SOURCE signoff.

The isolated host fixture is a strict injected Executor bridge accessing only new OS TEMP files and its single test-owned Node process. It is not the final installed Python Producer ↔ Relay ↔ Control stack nor ChatGPT plugin; these require a later explicit integrated cutover gate.
