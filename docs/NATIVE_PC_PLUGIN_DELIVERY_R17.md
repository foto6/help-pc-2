# R17 secure Native PC ChatGPT plugin delivery

Issue: `foto6/help-pc-2#5`
Writable branch: `agent/native-pc-plugin-delivery-r17-20260929`
Exact base: `2e5e06ba6966435c0e49e49a9de6e9c550eae8f6`

Status: **BLOCKED_APPROVED_REMOTE_ENDPOINT_REQUIRED**.

This branch implements the opt-in pairing protocol, outbound connector, request
deduplication/reconciliation boundary, deployment gate, and deterministic
cross-platform tests. It does **not** publish a plugin, create an external
endpoint, change the running R15c stack, or claim that ChatGPT can currently
reach the Native MCP.

## Current evidence and strict naming

The existing `src/mcp-http-host.js` at the frozen base remains loopback-only.
Its authenticated `/mcp` endpoint on `127.0.0.1` is useful for PC-local
testing but is not reachable from ChatGPT cloud agents. This branch does not
change that file or bind it to `0.0.0.0`.

In this existing ChatGPT coding-agent session, the callable tool inventory was
inspected before implementation and contained **zero Native PC MCP callable
tools**. Therefore the required direct Native `tools/list`, device info,
ping, config, and known TEMP fixture read are **NOT_RUN** here. Remote Desktop
Commander and the historical GitHub-relay `pc-control` skill are not counted
or relabeled as Native evidence.

The existing plugin identity remains `pc-control`. No `mcp.json` is
created because there is no real, approved, independently verified remote MCP
URL and supported ChatGPT authentication flow available to this agent.

## Issue #6 ownership boundary

The concurrent STALE_SESSION owner has changed these files on
`agent/native-mcp-session-expiry-r17-20260929`:

- `src/mcp-host.js`
- `src/mcp-http-host.js`
- `src/native-facade.js`
- `test/r17-session-renewal.test.js`

R17 plugin delivery intentionally does not modify any of them. Session renewal
must land and be independently validated on its own branch. The remote connector
does not disable, extend, or work around the 30-minute facade TTL.

## Pairing and reachability design

`src/native-plugin-delivery.js` implements a real outbound connector that can
dial an approved broker **only after explicit configuration and pairing**. It
has no default endpoint.

An approved broker origin must be:

- HTTPS;
- the exact explicitly approved hostname;
- bare origin only, on normal TLS port 443;
- free of embedded credentials, query strings, or fragments;
- neither localhost/private-local naming nor an IP literal.

The device never opens an Internet-facing listener or arbitrary port forward.
After pairing, it initiates an outbound WSS connection to the same approved
origin at the versioned device path. The existing loopback MCP host stays local.

Pairing requires explicit `consent.granted=true`, a consent identifier, a
one-time pairing code, fresh live-stack evidence, current device/process epochs,
and current registry/executor/capability digests. The raw pairing code is never
sent; a nonce-bound HMAC proof is transmitted over TLS. The broker response
must echo the exact binding and provide:

- a short-lived device credential (maximum 15 minutes);
- broker identity digest;
- authorized-caller digest;
- a credential-free HTTPS Streamable HTTP MCP URL on the same broker origin.

The device bearer is written directly to an injected secure credential store.
The store must explicitly identify itself as secure. The token is never returned
from public connector methods, written to this repository, placed in an MCP URL,
or included in hello/registration metadata.

The remote MCP URL is only a **registration candidate**. The candidate always
has `publish_allowed=false` until a separate owner proves real endpoint
reachability, ChatGPT-supported authentication, actual client tool discovery,
and direct read-only Native calls. This branch cannot fabricate those facts.

## Device and capability binding

Each pairing binds:

- device ID and desktop ID;
- fresh device epoch and process epoch;
- exact Control native registry digest
  `771f6d31d48fc2c89ff936f43346da11ca897d37fc84c7a9cccb08367aba837b`;
- exact PC Core frozen registry digest
  `58b2bde8c6a49825747dcd7010f105dad0b6d548c7e8341cdafb32d2319f6dcd`;
- current Executor digest and capability digest;
- exact 37 frozen + 25 parity = 62 route partition.

A reboot, process replacement, registry drift, capability drift, or mismatched
broker identity/caller digest blocks connection before request dispatch.

Fresh readiness is mandatory. Persisted READY files are not accepted:
`live_probe=true` and current PC Core, relay, Control, and MCP-host states must
all be ready, with evidence no older than 30 seconds. A reboot partial stack,
including relay backoff or missing Control, remains blocked.

## Delivery semantics

Remote broker request IDs and delivery IDs are bound to a durable delivery
ledger. A same-content duplicate returns the stored response without another
dispatch. Reusing a delivery ID with different content fails closed.

For a side-effect whose dispatch outcome is uncertain, the connector stores and
returns `reconciliation_required / UNKNOWN_RECONCILE` and does not blindly
redispatch a duplicate. This layer does not replace the existing PC Executor
outcome journal; it adds a conservative remote boundary in front of it.

The connector also performs a lexical defense-in-depth protected-root check
before dispatch. Protected roots are supplied by the authoritative local
configuration. The implementation uses only path-string normalization; it never
stats, opens, lists, or probes a protected directory. The underlying Executor
policy remains authoritative.

## Deterministic acceptance coverage

`test/native-plugin-delivery-r17.test.js` covers on both Windows and Ubuntu:

- remote mode OFF by default;
- 401 pairing rejection;
- invalid host/origin, localhost/IP/non-443 rejection;
- unpaired connector rejection;
- offline pairing/socket rejection;
- explicit consent requirement;
- no raw pairing code or bearer in public output;
- 37+25 registry and digest binding;
- mismatched device epoch, Executor digest, and registry digest;
- reboot partial-stack and stale-readiness rejection;
- lexical protected-path rejection before dispatch;
- same-content duplicate request suppression;
- conflicting duplicate rejection;
- uncertain side-effect outcome with no automatic replay;
- outbound WSS handshake binding and bearer isolation;
- stale pairing and mismatched broker identity rejection;
- release gate remains BLOCKED until real endpoint + ChatGPT agent evidence exists.

The exact-base audit additionally proves no overlap with Issue #6 files, no
`mcp.json` publication, and no changes to the frozen R15c relay/provider,
registry, runtime config, package lock, or bridge surfaces.

## Missing real endpoint and required user action

This implementation is intentionally blocked at the final registration step.
No approved Internet-reachable HTTPS broker endpoint was supplied or authorized,
and this agent has no authority to provision one.

To continue, the user/authorized infrastructure owner must:

1. provision or identify the approved HTTPS/WSS broker endpoint and hostname;
2. provide a supported ChatGPT authentication/registration mechanism for that
   endpoint;
3. explicitly opt in and complete pairing from the local device using a secure
   credential store and authoritative protected-root configuration;
4. independently verify the endpoint identity and tool discovery;
5. connect/update the **existing `pc-control` plugin identity** only after a
   real `mcp.json` can reference that verified endpoint;
6. from existing ChatGPT agents, prove direct Native `tools/list` and
   read-only device info/ping/config/TEMP-fixture read.

Until those actions occur, the correct release state is
`BLOCKED_APPROVED_REMOTE_ENDPOINT_REQUIRED`, not READY.

No merge, release, live service change, SCM/UAC action, relay deployment, or
protected-root access is authorized by this document.
