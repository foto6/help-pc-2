# R21 — exact OS PID kill identity route correction

Date: 2026-09-29. Parent frozen Node Relay/Control: foto6/help-pc-2 SHA c3502aa9371d66332c9a90c95ce35e755e4aa131. New branch agent/r21-os-process-kill-route-20260929. No live service, user process, user file, SCM or Bridge mutation.

## Reproduced real signed cross-language bug — do not erase

Against original Control, genuine fixed installed Python producer foto6/help-pc-1 SHA f1678ee924552d85bb1ae9094268c79fb75712da and official MCP SDK, disposable Windows attempted kill_process on exactly one fresh test-created owned child. Tool returned PROCESS_ERROR; sanitized native cause EXECUTOR_PREFLIGHT_REJECTED ON THE FIRST READ-ONLY native process.list. Child was not physically killed by Executor; original Node owner later cleaned only its own ChildProcess. Agent shutdown was not invoked. Observed real failing Boss runs 36595572379 and 36596081295.

Exact integration mismatch: old Control Desktop Commander kill_process first variant picked native process.list whenever producer announced Executor action process.list. But frozen Python _COMPAT_PARITY_ACTION_BY_TOOL maps native process.list to parity Executor process.managed.list: an inventory of durable managed handles WITHOUT a pid parameter. The true OS-wide Executor process.list is reached instead through native system.process.list. Original native lookup sent pid to managed-list preflight, which rejected it before any OS side effect. Independent actual installed Python preflight verified actual OS process.list params pid/offset/max_results are READY and an unexpected limit is INVALID_REQUEST.

## Narrow source change and security benefit

1. In src/dc-compatibility-registry.js retain kill_process first variant pc_core_safe_identity with underlying required genuine parity actions process.list and system.process.kill, but change its native on-wire pair to system.process.list and system.process.kill. Real Python backend then resolves frozen native system.process.list to actual OS parity process.list, converting signed bounded Native Facade page.limit=1 into max_results=1 before native Executor preflight.
2. In src/dc-compatibility.js REMOVE dangerous fallback to arbitrary first process when exact requested PID was absent. Authorize ONLY item.pid === requestedPid, otherwise PROCESS_NOT_FOUND before any mutation. The real Python Executor independently rechecks expected executable identity after opening the exact Windows process before TerminateProcess.
3. New four focused regressions in test/r21-os-kill-route.test.js: alias/underlying action identity, OS-list-before-kill and request ID/page bounds, wrong returned PID fails without any kill, empty/missing-name lookup fails without any kill.
4. Update existing test/mcp-host.integration.test.js fake adapter to explicitly expose native system.process.list in synthetic capabilities and mock provider for this OS lookup, preserving its original disabled-destructive-action expectation. This does NOT synthesize a real production capability: original R19 signed Python capability alias projection already exists.

Desktop Commander compatibility digest intentionally changes because tool metadata native_tools changed. Every consumer must renegotiate digest in a new session. Original frozen Native v1 and Python PC Core wire registry digests MUST remain unchanged. No permission bypass, user OAuth/RBAC or production safety-policy changes.

## Independent acceptance needed

- Fresh exact-HEAD Windows TEMP source checkout, focused and full node --test.
- Exact-HEAD GitHub PR CI with Windows and Ubuntu official MCP host, Relay/provider, registry and complete suite.
- Separate Boss disposable-only Windows real signed Python->Node Relay->Control->official MCP child kill test: exactly one test-created child with immutable PID, Node parent, executable name and Windows creation epoch, only then signed agent.shutdown (graceful stop of ephemeral Agent, NOT Windows OS power-off), original runner still alive, no native service registration, one-child-only cleanup.
- Previous physical distinct positive tally 26/28 is independent of the final two gates. Do not claim one-session 28/28 or cold OS boot from a manual service restart.

Never run the destructive child-kill test on the user's personal computer. Frozen R15c and Bridge must remain untouched.
