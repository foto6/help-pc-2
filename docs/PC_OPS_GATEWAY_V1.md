# PC Operations Gateway v1 — operator bootstrap

`pc_ops.gateway.v1` is an additive coordinator surface over the existing Control Plane and Executor. The gateway never performs PC file, UI, process, clipboard, or shell effects itself: every such call is enqueued as a durable Control Plane action and dispatched through the configured Executor transport. Request correlation, preflight, context binding, outcome-journal reconciliation, cancellation, restart recovery, and audit evidence remain Control Plane/Executor responsibilities.

## Current producer gate

Pinned green producers are Control Plane Wave 8 `f082a7e837392240788d7474123c90095891e153` (CI 36317766821), Executor `2cc1e40f792a3d74560b726a0d246c90b7f077e9` (CI 36318986551), Vision `51b96fb41cb72cdfc4a03129d14b9afc5fe750fd` (CI 36317785328), and relay hardening `fcea28ec18a7e3a72e43a62c2782b5a51414a32f` (CI 36326683913). The relay head is green for transport hardening but its exact tree exposes only capabilities/preflight/outcome/windows/screenshot/UIA observation/clipboard.get plus `shell.run`. It does not yet contain the structured filesystem, log, process/session, system-resource, or UI-effect fixture pack required for migration. The E2E report therefore remains `ready_to_migrate=false`.

## Windows bootstrap

Use a dedicated checkout of the already-migrated relay queue. Never use the implementation checkout as the queue checkout, and never place gateway state or the queue under `E:\manhwa`.

~~~powershell
cd E:\pc-control-plane
$env:PC_OPS_QUEUE_REPO = "E:\pc-relay-queue"
$env:PC_OPS_IMPLEMENTATION_SHA = "<EXACT_GREEN_GATEWAY_SHA>"
node .\bin\pc-ops-gateway.js --state-dir "$env:LOCALAPPDATA\pc-ops-gateway" --queue-repo $env:PC_OPS_QUEUE_REPO
~~~

The service prints one redacted startup health record, then accepts newline-delimited requests such as `{"id":"req-1","tool":"health.get","arguments":{}}`. The default assumes the relay is dry-run for preflight semantics. Only after a separately approved live relay cutover should it be started with `--relay-live`. `--allow-destructive` is separate and explicit; high-destructive tools still require per-request `"confirm":true`.

Health reports the gateway implementation SHA, pinned Executor/relay SHAs, queue ref/head and reachability, relay heartbeat state, last request/result summary, and protected-path policy. It never prints Git credentials or command stderr.

## Selection and safety rules

Assistants should choose `fs.*`, `log.*`, `process.*`, and managed `shell.session.*` before `shell.run`; raw shell is fallback only. Windows path normalization requires an absolute `cwd` for relative paths, compares protected roots case-insensitively, and rejects `E:\manhwa` plus every descendant. Client-requested policy bypass fields are rejected before action enqueue; Executor policy remains authoritative.

Managed starts use a caller operation identity plus Control Plane idempotency. The operation store persists the bound start action, remote handle, cursor, and status. Restart never blindly starts a second process/session: the existing action is returned or reconciled first. Cursor reads resume from durable operation state.

## Promotion condition

Replace the relay pin only after an exact-head green producer commit publishes deterministic fixture packs for the missing structured actions. Update the producer matrix, run the full repository suite, regenerate deterministic hashes, and change the E2E report to `READY_TO_MIGRATE` only when every scenario is backed by those exact bytes. This branch performs no merge, release, live migration, or protected-path access.
