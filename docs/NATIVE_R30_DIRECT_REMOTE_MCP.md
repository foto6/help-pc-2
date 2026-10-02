# Native MCP R30 — direct authenticated remote lane

Release decision: **NO_LIVE_CUTOVER**.

R30 adds a production-shaped remote MCP network surface around the existing
`NativeMcpRuntime` and authenticated native relay provider. It does not add a
second Executor authority and does not expose a raw shell or raw Executor
endpoint.

## Architecture

The direct lane is:

```text
remote ChatGPT/plugin gateway
  -> HTTPS gateway / exact Host
  -> pc-native-mcp-remote Streamable HTTP /mcp
  -> NativeMcpRuntime
  -> NativeControlFacade
  -> durable ControlPlane
  -> built-in authenticated NativeRelayExecutorProvider
  -> authenticated native remote relay
  -> PC Executor
```

All normal registry/capability negotiation, Control policy, durable
idempotency, protected-path policy, reconciliation and relay semantics remain
in the existing stack.

The MCP transport uses the official SDK `createMcpHandler` Streamable HTTP
implementation. Supported protocol operations therefore include
`initialize`, `tools/list` and `tools/call` through the same host used by
the local MCP surfaces.

## Exact configuration for a later explicit live rehearsal

Do not configure these variables on the live stack as part of R30. For a later
explicit rehearsal, create an isolated process/config with:

```text
PC_NATIVE_RELAY_URL=http://127.0.0.1:<relay-control-port>
PC_NATIVE_RELAY_TOKEN=<relay-control credential, >=32 chars>
PC_NATIVE_DEVICE_ID=<provisioned native device id>
PC_NATIVE_DESKTOP_ID=<desktop id>
PC_NATIVE_STATE_DIR=<isolated durable state directory>
PC_NATIVE_RELAY_CONTROL_TIMEOUT_MS=5000

PC_NATIVE_REMOTE_MCP_TOKEN=<separate MCP client credential, >=32 chars>
PC_NATIVE_REMOTE_MCP_BIND_HOST=127.0.0.1
PC_NATIVE_REMOTE_MCP_PORT=<isolated port>
PC_NATIVE_REMOTE_MCP_PUBLIC_ORIGIN=https://<gateway-host>
PC_NATIVE_REMOTE_MCP_REQUEST_TIMEOUT_MS=30000
PC_NATIVE_REMOTE_MCP_DISCOVERY_TIMEOUT_MS=5000
PC_NATIVE_REMOTE_MCP_MAX_REQUEST_BODY_BYTES=1048576
```

Then, only under a separately authorized live rehearsal:

```text
npm run mcp:remote
```

For a deliberate non-loopback bind, the exact bind address must also be in:

```text
PC_NATIVE_REMOTE_MCP_ALLOWED_BIND_HOSTS=<exact-bind-address>[,<another>]
```

The server refuses a non-loopback bind that is not explicitly listed.

If browser-style requests are expected, optional allowed Origins can be
specified as an exact comma-separated list:

```text
PC_NATIVE_REMOTE_MCP_ALLOWED_ORIGINS=https://<gateway-host>
```

When omitted, the public origin itself is the only accepted non-null Origin.
Requests without an Origin remain permitted for non-browser MCP gateways.

The HTTPS gateway must preserve the exact public `Host` header. R30 does not
trust `X-Forwarded-Host` as an authorization source.

## Credential separation

The direct MCP client credential and relay/device credential are different
authorities.

`PC_NATIVE_REMOTE_MCP_TOKEN` must not equal `PC_NATIVE_RELAY_TOKEN`. Startup
fails closed if they collide. Device WebSocket credentials continue to be
owned by the native relay and are never accepted as MCP client credentials.

Credential bytes are not returned by `/healthz`, MCP tool metadata, readiness
reports or diagnostics.

Rotation is restart-based: start a later isolated direct MCP host with the new
client token while preserving the durable Native/Control state. Old MCP
credentials stop authenticating, while stable logical `request_id` values
still bind to the same durable action history. Rotation never authorizes a
second side effect.

## Stable request identity

In direct-remote mode, **every side-effecting MCP call must include an explicit
stable `request_id`**. Calls without one fail before facade/relay dispatch with
`REMOTE_STABLE_REQUEST_ID_REQUIRED`.

This is stricter than local MCP mode. Numeric JSON-RPC/MCP IDs can restart after
transport reconnect, so they are not accepted as durable mutation identities.

Read-only calls may omit `request_id`.

The same explicit mutation `request_id` survives:

- HTTP/MCP reconnect;
- direct MCP host restart;
- relay reconnect/restart;
- client-token rotation.

Existing facade + Control + relay journals provide the durable duplicate
boundary. R30 does not add an independent replay layer.

## UNKNOWN outcomes and reconnects

If a response is lost after a side effect has been dispatched, the existing
relay/Control path returns or persists `reconciliation_required` with
`automatic_replay=false`.

The direct transport has a bounded request deadline. At the deadline it aborts
the underlying MCP request and returns a bounded timeout response carrying:

```json
{
  "error": "request_timeout",
  "reconciliation_required": true,
  "automatic_replay": false
}
```

The durable state is still authoritative. A subsequent call with the *same*
stable `request_id` reuses/reconciles the original action; R30 never creates a
replacement side effect automatically.

## Discovery and health

`initialize` and `tools/list` remain read-only. They validate capabilities
but do not open a facade session or claim desktop ownership.

Authenticated `GET /healthz` is also read-only and bounded. It reports
`HEALTHY`, `DEGRADED` or `BLOCKED` using the existing native health stack
and capability check. It does not run a side-effect canary and does not claim a
desktop.

The health payload includes only bounded, non-secret information such as
registry/Executor digests and transport responsiveness.

A hung/offline relay or device is bounded by:

- `PC_NATIVE_RELAY_CONTROL_TIMEOUT_MS` for relay control requests;
- `PC_NATIVE_REMOTE_MCP_DISCOVERY_TIMEOUT_MS` for direct discovery/health;
- `PC_NATIVE_REMOTE_MCP_REQUEST_TIMEOUT_MS` for MCP requests;
- existing relay/device response bounds.

## Host and Origin protection

Every `/mcp` and `/healthz` request requires:

1. exact allowed Host matching the configured public origin;
2. exact allowed Origin when an Origin header is present;
3. a valid Bearer MCP client token.

Missing/short/wrong tokens fail closed. Host mismatch returns 421. Origin
mismatch returns 403.

Outside isolated tests, `PC_NATIVE_REMOTE_MCP_PUBLIC_ORIGIN` must use HTTPS.

## Capability drift

The direct transport delegates to the existing runtime. Before every tool
dispatch, the runtime rechecks:

- native protocol version;
- native registry digest;
- Executor capability digest;
- device/session identity.

Drift fails before provider dispatch. No raw network transport can bypass this.

## Bounds

R30 preserves the MCP host result bound and relay stream/request bounds. An
oversized provider result is replaced by the existing bounded
`MCP_RESULT_BOUND` result; it is not emitted unbounded to the remote client.

## External platform registration

R30 does **not** register this endpoint with ChatGPT or any remote plugin
platform. CI has no authority to perform that external account/platform action.

Machine readiness therefore distinguishes:

- `source_state = SOURCE_READY`
- `live_rehearsal_gate = READY_FOR_EXPLICIT_LIVE_REHEARSAL`
- `actual_remote_chatgpt_tool_exposed = false`
- `missing_external_authority = REMOTE_CHATGPT_PLUGIN_GATEWAY_REGISTRATION`

A future coordinator must explicitly provision the HTTPS gateway, register the
endpoint with the external platform, and run a bounded live rehearsal before
any cutover decision.

## Prohibited in this milestone

R30 does not:

- deploy or restart the current MCP/relay stack;
- register a Windows task/service;
- alter firewall or tunnel configuration;
- repoint the current GitHub relay;
- replace the current Control/Bridge processes;
- perform remote-plugin registration;
- perform a production cutover.

No Desktop Commander is used. Protected user paths are outside this milestone.
