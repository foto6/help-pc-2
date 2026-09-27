# Desktop Commander 0.2.51 Compatibility Surface

## Scope

The compatibility registry `pc.desktop_commander.compat_registry.v1` exposes the observed Desktop Commander 0.2.51 operation names over `pc.native.control.v1`. The Control/MCP process is translation and transport only: it does not implement filesystem, PDF, process, shell, UI, configuration, device-shutdown, identity, usage, or audit side effects.

Every MCP compatibility tool advertises its registry digest, native registry digest, Executor capability digest, selected capability variant, and current availability. A tool is callable only when the current Executor capability manifest satisfies one of its registered variants.

Required compatibility names:

- `list_devices`, `ping`, `shutdown`, `get_config`, `set_config_value`
- `read_file`, `read_multiple_files`, `write_file`, `write_pdf`, `create_directory`, `list_directory`, `move_file`, `get_file_info`, `edit_block`
- `start_search`, `get_more_search_results`, `stop_search`, `list_searches`
- `start_process`, `read_process_output`, `interact_with_process`, `force_terminate`, `list_sessions`, `list_processes`, `kill_process`
- `who_am_i`, `get_usage_stats`, `get_recent_tool_calls`

Desktop Commander vendor workflows `get_prompts` and `give_feedback_to_desktop_commander` are explicit non-equivalents. They are documented in the registry metadata and intentionally are not registered as native MCP tools because they are vendor onboarding/feedback workflows, not PC Executor capabilities.

## Capability-gated availability

The current green PC Core full-parity producer (`agent/pc-native-full-dc-parity` at `de9797eaf0fd646291ad7ed06af8447c281ddcac`) publishes the capability set required for every mandatory compatibility name except PDF output. Availability is still resolved dynamically from the live Executor manifest rather than hard-coded.

Current capability mappings include:

- `shutdown` -> `device.shutdown` (current authenticated device agent/session only; not OS power-off)
- `set_config_value` -> `config.set` (Executor allowlist and atomic validation remain authoritative)
- `read_multiple_files` -> `fs.read_many`
- `who_am_i` -> `identity.get`
- `get_usage_stats` -> `metrics.get`
- `get_recent_tool_calls` -> `audit.history`
- stateful search -> `search.start`, `search.read`, `search.list`, `search.stop`

`write_pdf` remains explicitly unavailable because the current producer does not advertise `pdf.write`. The registry already contains the translation schema, so it will become available only when an Executor-bound `pdf.write` capability is actually advertised. There is no host-side PDF renderer.

There is no composed serial fallback for `read_multiple_files` in the canonical full-DC surface. True batch ordering and independent per-file records require `fs.read_many`. Identity, usage, and audit data are not synthesized by the host.

## Filesystem semantics

`read_file` preserves 0-based positive line offsets and negative tail offsets. Reads are bounded to 1000 lines and 256 KiB. URL, spreadsheet-range, office-document, and PDF-specific read modes fail closed unless an Executor-bound capability is added; they are not emulated by the MCP host.

`read_multiple_files` sends one true-batch native request. The returned list must match input cardinality and order. Every item carries independent success/error state.

`edit_block` first obtains a native SHA-256 precondition and then issues one `file.edit` mutation with exact old/new text and replacement-count precondition. A mismatch never falls back to a whole-file write.

`write_file` uses explicit rewrite/append actions. `create_directory`, `list_directory`, `move_file`, and `get_file_info` remain bounded facade translations. `get_file_info` adds a native hash only when `fs.hash` is advertised.

## Stateful search semantics

`start_search` maps to `search.start` and returns the durable PC Core `search_id` as Desktop Commander's `sessionId`. It supports files/content type, regex-by-default vs literal search, case behavior, hidden-file policy, context lines, max results, and timeout. Parameters not implemented by `pc_executor.search_session.v1` such as `filePattern` or `earlyTermination` return `CAPABILITY_UNAVAILABLE` instead of being silently ignored.

`get_more_search_results` maps to `search.read`. Positive offsets are absolute result indexes; negative offsets tail and omit length. `list_searches` projects the retained search ID/type/pattern/status/runtime/result count. `stop_search` cancels the search via `search.stop`; final retained results remain owned by PC Core's retention lifecycle.

## Process and system semantics

Compatibility-started processes persist only non-secret pid-to-native-handle metadata. On current PC Core, `start_process` prefers the interactive `shell.session.start/read/write_stdin/terminate` lifecycle so Desktop Commander stdin semantics remain available. Command text is parsed into bounded argv by the translator but is never executed by Control/MCP; PC Core performs executable allowlisting, preflight, and execution. If only managed-process capabilities are advertised, `process.start/read_output/terminate` is used instead. Older facade variants remain capability-gated fallbacks.

Repeated `read_process_output` calls preserve the PC Core byte cursor. Unsupported absolute line offsets on byte-cursor variants fail closed rather than being approximated. `list_sessions` prefers `process.managed.list`; `interact_with_process` is available only for a compatibility-owned interactive session handle.

`list_processes` is a bounded native process listing. `kill_process` first resolves the target executable identity using a read-only native process listing, then requests `system.process.kill` with both pid and expected executable name. Existing destructive-action policy remains authoritative and may block the kill before provider dispatch.

## Identity, usage, and audit

`who_am_i`, `get_usage_stats`, and `get_recent_tool_calls` are not reconstructed from the Control/MCP host process. They become available only when the Executor publishes dedicated sanitized read-only actions. Returned objects are recursively stripped of secret/token/password/credential/auth-shaped fields before projection.

## Idempotency, cancellation, and protected paths

Every compatibility call uses the MCP logical `request_id` as the facade correlation/idempotency key. Multi-step translations derive deterministic child IDs. Cancellation signals propagate through the translator into `NativeControlFacade`.

A lost connection, unknown dispatch, lost result, or cancellation race after side-effect dispatch remains `reconciliation_required`; compatibility never authorizes a blind replacement action.

The Executor remains authoritative for protected-path policy. The facade also rejects the protected test target before Control Plane enqueue; tests use only mocked path strings and prove zero provider dispatch.

## Verification

`test/dc-compatibility.test.js` covers registry, bounded reads, true-batch behavior, edit/write semantics, capability failure, durable process lifecycle, and normalized errors.

`test/mcp-host.integration.test.js` uses the official MCP SDK client against the real Streamable HTTP host. It covers discovery/status metadata, filesystem, stateful search, process/system, identity/usage/audit sanitization, unsupported capabilities, modern/older protocol negotiation, cancellation, duplicate logical requests, uncertain outcomes, and protected-path no-dispatch.
