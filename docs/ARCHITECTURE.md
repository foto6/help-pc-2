# PC Control Plane Architecture

The control plane owns orchestration state and retry/reconciliation policy; PC Executor owns local side effects and final safety enforcement; Vision/observation providers remain read-only verification dependencies.

Runtime v2 keeps durable state/audit, lease scheduler and lane locks, provider execution adapters, generic verification hooks, and RPC/MCP projection. Wave 3 adds a strict dispatch boundary: once execution enters a side-effect provider, an unknown result is reconciled read-only rather than replayed.

`HelpPc1Adapter` normalizes current Executor `ActionResult` evidence but does not infer or own Executor internals. Optional evidence reads are injected. Verification/reconciliation can consume future Executor evidence or Vision verification fixtures without coupling the core to either schema.

Safety invariants remain unchanged: credential/CAPTCHA types are rejected before queueing; destructive actions are disabled by default; Executor dry-run defaults true; policy blocks are never auto-retried; `E:\\manhwa` remains outside runtime scope.
