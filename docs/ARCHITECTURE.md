# PC Control Plane MVP

The control plane is a provider-neutral coordinator. It owns policy, ordering, state transitions, and audit; concrete desktop execution remains behind adapters.

## Safety baseline

Credential and CAPTCHA action types are rejected by schema validation. Destructive actions are disabled by default, and enabling them still requires both the `destructive` permission and explicit per-action confirmation. The control plane does not perform destructive fallback or credential recovery. `E:\\manhwa` is outside this repository and is never an execution target.

## Core model

- **Session + desktop ownership:** one active session may own a desktop at a time. Desktop-requiring actions fail closed if ownership is lost before execution.
- **Action queue:** actions move through `awaiting_confirmation`, `queued`, `running`, and terminal states (`succeeded`, `failed`, `cancelled`).
- **Schema boundary:** `actionSpecSchema` is JSON-Schema-shaped and the runtime validator enforces the same safety-sensitive fields.
- **Permissions + confirmation:** global policy bounds per-session permissions; destructive work is opt-in and confirmation-gated.
- **Idempotency:** a session-scoped idempotency key resolves repeated submissions to the original action.
- **Cancellation:** queued work is cancelled immediately; running work receives an `AbortSignal`.
- **Retry + recovery:** providers may mark failures `retryable`; bounded retries are requeued. Snapshots can be restored and orphaned `running` actions are recovered to `queued` (or `cancelled` when cancellation was already requested).
- **Audit:** state transitions append ordered audit events with a monotonically increasing sequence number.
- **Resource locking:** only one action may execute against a resource key at a time; unrelated resources can progress independently.

## Provider boundary

A provider implements:

```js
{
  name: "provider-name",
  async execute(action, { signal, attempt, session }) { /* ... */ }
}
```

`HelpPc1Adapter` and `Vision2Adapter` translate that contract into injected `invoke(...)` calls. No provider-specific transport, SDK, or credential format leaks into the control plane.

## MCP/API boundary

`createRpcHandler()` exposes stable method names such as `session.create`, `action.enqueue`, `action.confirm`, `action.cancel`, and `audit.list`. `mcpToolDefinitions()` projects the same methods into MCP-compatible tool descriptors. HTTP, JSON-RPC, MCP, IPC, or another transport can wrap the handler without changing core orchestration.

## Persistence boundary

`snapshot()` returns serializable state suitable for a persistence adapter. The MVP intentionally keeps storage out of the core; durable backends can persist snapshots and restore them through the constructor without changing provider or transport contracts.
