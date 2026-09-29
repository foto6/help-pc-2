# R16 native MCP → ChatGPT plugin exposure gate (design and operator contract)

Status: **BLOCKED_PENDING_APPROVED_REMOTE_ENDPOINT**. This document does not authorize remote exposure or claim ChatGPT tool registration. It is independent of the existing R15c service and the concurrent Control R16 reboot branch.

## Evidence fixed at freeze

- Native PC Core pinned: `04f817299b46ecb0ffa8aa908ce84fdb4c3300d0`.
- Control wire-registry pinned: `2e5e06ba6966435c0e49e49a9de6e9c550eae8f6`.
- R15c launcher pinned: `792d3b0d1efbd73170f8e52f3a74c4dab882e092`.
- Real isolated R15c live read-only oracle: `READ_ONLY_PASS` 3/3 on health/config, file read/tail and lexical protected-path rejection; capability digest `sha256:c4f93163fa9e032566121847b03ca4cc9cb181d18b4b87ac288424ca654430a8`. These are local service observations **not** evidence that any ChatGPT agent can see the tools.
- Actual `src/mcp-http-host.js`: authenticated `/mcp`, `legacy:"stateless"`, default `127.0.0.1`, and explicit rejection of any non-loopback bind. No unauthenticated remote listener is supported by this producer.
- Existing private `pc-control 0.1.0` ChatGPT plugin release has only `plugin.json`, compatibility overlay and a GitHub-backed PC Executor relay SKILL; it has **no** portable `mcp.json`. It is neither proof of, nor a substitute for, Native PC tool registration.
- ChatGPT plugin creation contract uses portable root `mcp.json` with a real `streamable-http` MCP server URL. `http://127.0.0.1:<ephemeral-port>/mcp` is not a remotely reachable ChatGPT cloud connector target and must never be published as if it were.

## Required engineering milestone: maintain local safety, add an approved outbound connectivity path

1. Preserve the **existing loopback-only** Native PC MCP host. Do not change it to bind `0.0.0.0`, forward public ports, copy any ephemeral bearer, or commit environment/profile secrets.
2. Specify and test a separately authorized remote access/pairing path supporting the actual ChatGPT client. Prefer an outbound-initiated, authenticated, audited bridge whose Internet-facing entry point is HTTPS with validated identity. A design without a real provisioned endpoint must report BLOCKED, not synthesize a URL.
3. Bind each pairing to current device/process boot epoch, verified Control registry/executor digests, specific authorized caller and explicit consent. Reject old pre-reboot persisted `ready.json`, expired pairing, capability drift, mismatched Host/Origin, missing/altered Authorization, and unsupported client transports.
4. Preserve stable `pc.native.tool_registry.v1` and `pc.native.parity_tool_registry.v1` routing, 37 frozen+25 parity coverage from R15; the separate full Desktop Commander compatibility gate still needs independent real behavior evidence.
5. Enforce existing protected-root lexical rejection **without accessing or enumerating the protected directory**. Do not expose credentials, shells, or arbitrary file access outside the current Executor policy.
6. Connection loss after a possible side-effect must consult the durable action journal and return completed/unknown; **never blindly resend**. Auth revocation terminates new side effects immediately; preflight must bind exact process/window/target context.
7. Stage an updated plugin as the SAME existing package identity `pc-control`, bump version, preserve its display metadata and prompts, add `mcp.json` only with a **real, validated, approved HTTPS URL** and supported auth handshake. Read-back after update must verify server discoverability; no attempt to replace or automatically uninstall Desktop Commander while parity is unproven.
8. Independently from **this ChatGPT coordinator session** and at least two **existing** coding-agent conversations, prove an actual registered Native PC tool catalog and real read-only `list_devices`, `ping`, `get_config`, and isolated fixture read. Distinguish a direct MCP invocation from Remote Desktop Commander, GitHub relay, or a PC-local SDK script. Verify the returned capability digests and fresh run epoch.
9. Publish nonsecret provenance: exact Git heads, server implementation/registration commits, CI for Windows+Ubuntu, permitted remote endpoint identity (no secret/query-string tokens), and a revocation/rollback recipe. No production merge or Native PC/Desktop Commander cutover before the complete gate.

## Decision matrix

| Observation | Decision |
| --- | --- |
| R15c `READY`, PC-local conformance 3/3, client tool list absent | `SERVER_OK_CLIENT_UNREGISTERED` |
| Plugin only has a SKILL, no `mcp.json` | `PLUGIN_MCP_NOT_CONFIGURED` |
| MCP URL is localhost/private, HTTP, invented, unapproved, or contains credentials | `BLOCKED_UNREACHABLE_OR_UNSAFE_ENDPOINT` |
| External HTTPS/pairing exists but no independently observed ChatGPT `tools/list` | `BLOCKED_CLIENT_DISCOVERY_UNPROVEN` |
| Tool catalog visible but only simulated PC SDK checks | `BLOCKED_REAL_AGENT_BEHAVIOR_UNPROVEN` |
| Real authorized read-only calls from coordinator AND two existing agents pass; no side-effect claims | `READ_ONLY_AGENT_INTEGRATION_PASS` |
| All 28 mandatory compatibility operations independently behave correctly, restart/epoch/digest/rollback gates pass | Eligible for a **separate**, explicitly approved production cutover decision |

### Ownership split (no overlapping writes)

- Control R16 owner: securely expose/provision/pair the Native MCP transport with real connector binding, preserve all R15 protocol invariants.
- Existing Bridge reliability owner: independently verify actual message dispatch/transcript receipt and tool availability in existing chats; the previous R7 failure `noneditable_span` must not be circumvented by a blind Enter.
- Boss conformance owner: independent real-agent, reboot, unknown-outcome and rollback assertions. Never relabel local read-only oracle PASS as full release parity.
- Coordinator: validate server and package manifests, exact-head CI, actual client tool presence and safe operator handoff.

Protected local area is entirely out of scope; no file reads or real traversal are permitted.
