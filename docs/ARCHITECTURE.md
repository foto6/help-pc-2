# PC Control Plane Architecture

The control plane owns orchestration state and policy; PC Executor owns local side effects and final safety enforcement; Vision/observation providers remain read-only verification dependencies.

Runtime v2 separates six concerns: durable state/audit persistence, lease scheduler and lane locks, provider execution adapters, provider-neutral verification hooks, retry/cancellation/recovery policy, and RPC/MCP transport projection. No domain provider or LLM SDK is imported by the core.

The dependency direction remains `vision-2 -> help-pc-1 -> help-pc-2` for contract ownership. Runtime verification may call a read-only observation provider after an Executor action, but that does not transfer side-effect authority from the Executor.

Safety invariants: credential/CAPTCHA action types are rejected before queueing; destructive actions remain disabled by default and still require explicit permission plus confirmation when enabled; Executor dry-run defaults true; policy-blocked/cancelled work never auto-retries; `E:\\manhwa` is outside runtime scope.
