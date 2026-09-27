# Native relay Executor bridge provider

This module completes the control-side path from the native MCP/NativeFacade runtime to
the authenticated native relay without adding any Executor, shell, filesystem, UI, or
action implementation to the relay/control process.

## Production module identity

The bridge factory is published by this repository as:

- package: `pc-control-plane`
- package version: `0.9.0`
- module path: `src/native-relay-provider.js`
- factory export: `createExecutorBridge`
- explicit factory alias: `createNativeRelayExecutorBridge`
- provider contract: `pc.native.relay.executor_bridge.v1`
- relay API: `pc.native.relay.control_api.v1`
- device transport: `pc_remote_transport.frame.v1`

`NATIVE_RELAY_PROVIDER_IDENTITY` exports those values so a later release manifest can
pin the exact package/module identity and digest before the MCP runtime imports it.

The current PC Core wire reference is
`foto6/help-pc-1@3a07382fa98f3e02a3d1ffbb4cc3c61b806e2e63`. The provider test suite consumes
the frozen `pc-remote-transport-current-3a07382.json` fixture already generated from
that exact transport source.

## Configuration

The factory accepts in-process configuration or these environment variables:

- `PC_NATIVE_RELAY_URL`: relay control origin, for example
  `http://127.0.0.1:8765`
- `PC_NATIVE_RELAY_TOKEN`: relay control bearer token, minimum 32 characters
- `PC_NATIVE_DEVICE_ID`: exact provisioned relay device ID
- `PC_NATIVE_DESKTOP_ID`: optional NativeFacade desktop ID

The relay URL must be an explicit loopback HTTP/HTTPS origin. Embedded credentials,
query strings, fragments, non-loopback binds, and API paths fail closed.

The bearer token is held only in a private provider field and is used only in the
Authorization header. It is not returned by the bridge factory, identity metadata,
capability results, errors, status, or discovery output. No command-line argument for
the token is implemented.

## Bridge contract

`createExecutorBridge()` returns the current MCP runtime bridge surface:

- `invoke(request, context)`
- `readCapabilities(request, context)`
- `readEvidence(request, context)`
- `dryRun: false`
- `desktopId`
- non-secret `identity`

The current MCP runtime treats preflight, evidence, and execution-context hooks as
optional. This bridge intentionally does not expose a second control-side
`preflight()` or `bindExecutionContext()` RPC: the current PC Core
`ExecutorRemoteDispatcher` performs capability stability checks, Executor preflight,
durable side-effect replay checks, and execution-context binding on the device after
the authenticated native envelope arrives. Duplicating those operations in the relay
provider would introduce a second action protocol.

`readEvidence()` is implemented because ControlPlane reconciliation requires a
read-only lookup path after uncertain dispatch. It reads only the relay delivery
record and never creates or resends work.

## Request and delivery identity

NativeFacade stores the original facade request ID and native session/tool binding in
the ControlPlane action metadata. `HelpPc1Adapter` passes that metadata and the
correlation ID to the bridge without replacing its existing internal ControlPlane
action/journal identity.

For each invocation:

1. the facade `request_id` remains the logical request ID;
2. the provider creates a deterministic, separate `delivery_id` from device ID plus
   logical request ID;
3. the relay frame request ID and the embedded `pc.native.control.v1` request ID are
   both the original facade request ID;
4. duplicate calls reuse the same delivery ID and relay durable record;
5. a duplicate logical request with different content fails with a conflict rather
   than creating new work.

The provider translates the completed native response back into the existing
HelpPc1Adapter result shape using the internal ControlPlane action ID only at the
adapter boundary. This keeps current ControlPlane evidence contracts intact without
changing the remote logical request identity.

## Device/session/capability binding

Before dispatch, `readCapabilities()` reads authenticated relay device discovery,
requires the configured device to be online, verifies the advertised capability
digest, and binds the provider instance to:

- device ID;
- authenticated session epoch;
- full native capability digest;
- Executor capability digest.

A later session-epoch change fails with `STALE_DEVICE_SESSION`. Capability-manifest
or Executor-digest drift fails with `CAPABILITY_DRIFT`. The provider does not
silently rebind and dispatch after a reconnect.

The device-side `ExecutorRemoteDispatcher` independently verifies that the current
Executor/native capability manifest still matches the digest advertised during the
device hello before it executes any request.

## Reconciliation and cancellation

The provider never transparently retries or redelivers side effects after a POST has
started.

- relay `reconciliation_required` maps to `UNKNOWN_RECONCILE`;
- `automaticReplay` is always false;
- connection/result loss after dispatch is treated as an unknown dispatch outcome;
- `readEvidence()` can recover a cached completed relay result without dispatch;
- a durable relay restart preserves unresolved side effects as
  `reconciliation_required`;
- a signal already aborted before dispatch is a proven pre-dispatch cancellation;
- cancellation racing an already-dispatched side effect invokes only the relay cancel
  endpoint, which maps that side effect to reconciliation-required rather than
  claiming device cancellation.

The current device protocol has no cancellation frame, so the provider never claims
that an already-dispatched device side effect was cancelled.

## Testing

Focused provider coverage:

```
npm run test:relay-provider
```

The suite uses the real in-process `NativeRelayServer`, authenticated WebSocket
frames, the current `3a07382...` frozen transport fixture, and the real
`NativeControlFacade` / `HelpPc1Adapter` control path. It covers normal read-only
and side-effect results, duplicate request identity, conflict rejection,
disconnect-after-dispatch, response loss with lookup recovery, relay restart, stale
session/capability binding, cancellation races, and chunked response integrity.

Tests and implementation use temporary state only and do not access protected user
data.
