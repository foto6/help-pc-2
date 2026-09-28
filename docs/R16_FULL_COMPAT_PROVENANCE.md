# R16 native-PC full compatibility / observability provenance

## Immutable starting point and disposition

- Writable repository: `foto6/help-pc-2`; isolated branch: `agent/pc-r16-full-compat-observability-20260928`.
- Exact starting R15 HEAD: `2e5e06ba6966435c0e49e49a9de6e9c550eae8f6`. R16 does not change frozen PC Core producer code.
- Prior *independent real read-only* acceptance: **3/3** (device health/config, read/tail, protected-path lexical rejection before access), as supplied to this milestone. This is **not** an R16 full hardware, mutation, or release/cutover attestation.
- Frozen PC Core producer registry: `pc.native.tool_registry.v1`, digest `58b2bde8c6a49825747dcd7010f105dad0b6d548c7e8341cdafb32d2319f6dcd`.
- Pinned Control registry: `pc.native.tool_registry.v1`, digest `771f6d31d48fc2c89ff936f43346da11ca897d37fc84c7a9cccb08367aba837b`.
- New PC Core compatibility routes use explicit `pc.native.parity_tool_registry.v1`; do not graft parity names into the frozen 37-name registry. The protocol remains `pc.native.control.v1`.
- Code authorities: `src/native-registry.js`, `src/native-relay-registry-route.js`, `src/dc-compatibility-registry.js`, `src/full-compat-observability.js`. Read-only, deterministic audit function `fullCompatibilityAuditV1({nativeManifest})` emits every route and public tool with digest/availability, and rejects mismatched version/registry/Executor identity.

## Exhaustive native logical routing (62/62)

Every row lists a **Control logical name**, exact PC Core wire name, frozen or parity registry version, unchanged Executor action and immutable effect classification. Aliases are not inferred from string similarity. The runtime rejects unsupported names, action mismatch, effect mismatch, and route-version mismatch before relay dispatch.

| Control logical name | PC Core registry | PC Core wire name | Executor action | Effect |
| --- | --- | --- | --- | --- |
| `agent.shutdown` | Parity v1 | `agent.shutdown` | `agent.shutdown` | side_effect |
| `audit.recent` | Parity v1 | `diagnostics.recent_tool_calls` | `diagnostics.recent_tool_calls` | read_only |
| `clipboard.read` | Frozen v1 | `clipboard.read` | `clipboard.read` | read_only |
| `clipboard.write` | Frozen v1 | `clipboard.write` | `clipboard.write` | side_effect |
| `config.get` | Parity v1 | `device.get_config` | `config.get` | read_only |
| `config.set` | Parity v1 | `device.set_config` | `config.set` | side_effect |
| `content.search` | Frozen v1 | `content.search` | `fs.search_text` | read_only |
| `device.get_config` | Frozen v1 | `device.get_config` | `system.config.get` | read_only |
| `device.health` | Frozen v1 | `device.health` | `system.health` | read_only |
| `device.identity` | Parity v1 | `identity.who_am_i` | `identity.who_am_i` | read_only |
| `device.info` | Parity v1 | `device.info` | `device.info` | read_only |
| `device.ping` | Parity v1 | `device.health` | `health.get` | read_only |
| `device.set_config` | Frozen v1 | `device.set_config` | `system.config.set` | side_effect |
| `diagnostics.recent_tool_calls` | Parity v1 | `diagnostics.recent_tool_calls` | `diagnostics.recent_tool_calls` | read_only |
| `diagnostics.usage_stats` | Parity v1 | `diagnostics.usage_stats` | `diagnostics.usage_stats` | read_only |
| `file.append` | Frozen v1 | `file.append` | `fs.append_text` | side_effect |
| `file.copy` | Frozen v1 | `file.copy` | `fs.copy` | side_effect |
| `file.create_dir` | Frozen v1 | `file.create_dir` | `fs.mkdir` | side_effect |
| `file.delete` | Frozen v1 | `file.delete` | `fs.delete` | side_effect |
| `file.edit` | Frozen v1 | `file.edit` | `fs.edit_text` | side_effect |
| `file.hash` | Frozen v1 | `file.hash` | `fs.hash` | read_only |
| `file.info` | Frozen v1 | `file.info` | `fs.stat` | read_only |
| `file.list` | Frozen v1 | `file.list` | `fs.list` | read_only |
| `file.move` | Frozen v1 | `file.move` | `fs.move` | side_effect |
| `file.read` | Frozen v1 | `file.read` | `fs.read_text` | read_only |
| `file.read_bytes` | Frozen v1 | `file.read_bytes` | `fs.read_bytes` | read_only |
| `file.read_multiple` | Parity v1 | `file.read_multiple` | `fs.read_multiple` | read_only |
| `file.search` | Frozen v1 | `file.search` | `fs.find` | read_only |
| `file.write` | Frozen v1 | `file.write` | `fs.write_text` | side_effect |
| `identity.who_am_i` | Parity v1 | `identity.who_am_i` | `identity.who_am_i` | read_only |
| `input.click` | Frozen v1 | `input.click` | `input.click` | side_effect |
| `input.type` | Frozen v1 | `input.type` | `input.type` | side_effect |
| `log.tail` | Parity v1 | `log.tail` | `log.tail` | read_only |
| `pdf.write` | Parity v1 | `pdf.write` | `pdf.write` | side_effect |
| `process.interact` | Frozen v1 | `process.interact` | `process.interact` | side_effect |
| `process.list` | Frozen v1 | `process.list` | `process.list` | read_only |
| `process.managed.list` | Parity v1 | `process.list` | `process.managed.list` | read_only |
| `process.read` | Frozen v1 | `process.read` | `process.read` | read_only |
| `process.read_output` | Parity v1 | `process.read` | `process.read_output` | read_only |
| `process.start` | Frozen v1 | `process.start` | `process.start` | side_effect |
| `process.status` | Parity v1 | `process.status` | `process.status` | read_only |
| `process.terminate` | Frozen v1 | `process.terminate` | `process.terminate` | side_effect |
| `screenshot.capture` | Frozen v1 | `screenshot.capture` | `screenshot.capture` | read_only |
| `search.list` | Parity v1 | `search.list` | `search.list` | read_only |
| `search.read` | Parity v1 | `search.read` | `search.read` | read_only |
| `search.start` | Parity v1 | `search.start` | `search.start` | side_effect |
| `search.stop` | Parity v1 | `search.stop` | `search.stop` | side_effect |
| `shell.run` | Frozen v1 | `shell.run` | `shell.run` | side_effect |
| `shell.session.close` | Frozen v1 | `shell.session.close` | `shell.session.close` | side_effect |
| `shell.session.open` | Frozen v1 | `shell.session.open` | `shell.session.open` | side_effect |
| `shell.session.read` | Frozen v1 | `shell.session.read` | `shell.session.read` | read_only |
| `shell.session.start` | Parity v1 | `shell.session.open` | `shell.session.start` | side_effect |
| `shell.session.terminate` | Parity v1 | `shell.session.close` | `shell.session.terminate` | side_effect |
| `shell.session.write` | Frozen v1 | `shell.session.write` | `shell.session.write` | side_effect |
| `shell.session.write_stdin` | Parity v1 | `shell.session.write` | `shell.session.write_stdin` | side_effect |
| `system.process.inspect` | Parity v1 | `system.process.inspect` | `process.inspect` | read_only |
| `system.process.kill` | Frozen v1 | `system.process.kill` | `system.process.kill` | side_effect |
| `system.process.list` | Frozen v1 | `system.process.list` | `system.process.list` | read_only |
| `uia.find` | Frozen v1 | `uia.find` | `uia.find` | read_only |
| `uia.invoke` | Frozen v1 | `uia.invoke` | `uia.invoke` | side_effect |
| `usage.stats` | Parity v1 | `diagnostics.usage_stats` | `diagnostics.usage_stats` | read_only |
| `window.list` | Frozen v1 | `window.list` | `window.list` | read_only |

Counts: 37 frozen, 25 parity, 62 unique names; `routeNativeExecutorTool(name, action, effect)` is the fail-closed selector. MCP tools/list additionally exposes the exact wire version/name/alias, frozen producer digest, Control registry digest, route-audit digest and Executor digest for operator inspection.

## Public Desktop Commander 0.2.51 catalog (28 required / 30 total)

The 28 equivalents below are registered as `pc.desktop_commander.compat_registry.v1`. Each can become unavailable if the **current live** Executor manifest fails its required capability variant; advertised coverage is not a promise that a disconnected device can execute a tool. Both vendor-only names, `get_prompts` and `give_feedback_to_desktop_commander`, are explicit non-equivalents (2/30), not success stubs.

| Public tool | Domain | Effect | Availability and fallback |
| --- | --- | --- | --- |
| `create_directory` | Filesystem | side_effect | Dynamic Executor capability variant; explicit `CAPABILITY_UNAVAILABLE` when absent |
| `edit_block` | Filesystem | side_effect | Dynamic Executor capability variant; explicit `CAPABILITY_UNAVAILABLE` when absent |
| `force_terminate` | Process/shell | side_effect | Dynamic Executor capability variant; explicit `CAPABILITY_UNAVAILABLE` when absent |
| `get_config` | Device | read_only | Dynamic Executor capability variant; explicit `CAPABILITY_UNAVAILABLE` when absent |
| `get_file_info` | Filesystem | read_only | Dynamic Executor capability variant; explicit `CAPABILITY_UNAVAILABLE` when absent |
| `get_more_search_results` | Search | read_only | Dynamic Executor capability variant; explicit `CAPABILITY_UNAVAILABLE` when absent |
| `get_recent_tool_calls` | Identity/observability | read_only | Dynamic Executor capability variant; explicit `CAPABILITY_UNAVAILABLE` when absent |
| `get_usage_stats` | Identity/observability | read_only | Dynamic Executor capability variant; explicit `CAPABILITY_UNAVAILABLE` when absent |
| `interact_with_process` | Process/shell | side_effect | Dynamic Executor capability variant; explicit `CAPABILITY_UNAVAILABLE` when absent |
| `kill_process` | Process/shell | side_effect | Dynamic Executor capability variant; explicit `CAPABILITY_UNAVAILABLE` when absent |
| `list_devices` | Device | read_only | Dynamic Executor capability variant; explicit `CAPABILITY_UNAVAILABLE` when absent |
| `list_directory` | Filesystem | read_only | Dynamic Executor capability variant; explicit `CAPABILITY_UNAVAILABLE` when absent |
| `list_processes` | Process/shell | read_only | Dynamic Executor capability variant; explicit `CAPABILITY_UNAVAILABLE` when absent |
| `list_searches` | Search | read_only | Dynamic Executor capability variant; explicit `CAPABILITY_UNAVAILABLE` when absent |
| `list_sessions` | Process/shell | read_only | Dynamic Executor capability variant; explicit `CAPABILITY_UNAVAILABLE` when absent |
| `move_file` | Filesystem | side_effect | Dynamic Executor capability variant; explicit `CAPABILITY_UNAVAILABLE` when absent |
| `ping` | Device | read_only | Dynamic Executor capability variant; explicit `CAPABILITY_UNAVAILABLE` when absent |
| `read_file` | Filesystem | read_only | Dynamic Executor capability variant; explicit `CAPABILITY_UNAVAILABLE` when absent |
| `read_multiple_files` | Filesystem | read_only | Dynamic Executor capability variant; explicit `CAPABILITY_UNAVAILABLE` when absent |
| `read_process_output` | Process/shell | read_only | Dynamic Executor capability variant; explicit `CAPABILITY_UNAVAILABLE` when absent |
| `set_config_value` | Device | side_effect | Dynamic Executor capability variant; explicit `CAPABILITY_UNAVAILABLE` when absent |
| `shutdown` | Device | side_effect | Dynamic Executor capability variant; explicit `CAPABILITY_UNAVAILABLE` when absent |
| `start_process` | Process/shell | side_effect | Dynamic Executor capability variant; explicit `CAPABILITY_UNAVAILABLE` when absent |
| `start_search` | Search | side_effect | Dynamic Executor capability variant; explicit `CAPABILITY_UNAVAILABLE` when absent |
| `stop_search` | Search | side_effect | Dynamic Executor capability variant; explicit `CAPABILITY_UNAVAILABLE` when absent |
| `who_am_i` | Identity/observability | read_only | Dynamic Executor capability variant; explicit `CAPABILITY_UNAVAILABLE` when absent |
| `write_file` | Filesystem | side_effect | Dynamic Executor capability variant; explicit `CAPABILITY_UNAVAILABLE` when absent |
| `write_pdf` | Filesystem | side_effect | Dynamic Executor capability variant; explicit `CAPABILITY_UNAVAILABLE` when absent |

Semantics audited by executable tests and existing full-stack integration:
- `read_multiple_files`: one true `fs.read_multiple` request, input order/cardinality, per-file success/error, malformed partial record and path reorder rejected; no serial fallback. A non-file `TOOL_NOT_FOUND` preserves its error domain, while a genuine file ENOENT is `FILE_NOT_FOUND`.
- Pagination: file list progression and bounds are checked; multi-page managed process listing uses root request identity followed by deterministic `:page:N` child IDs. Incomplete native listing is reported as truncated and does **not** fabricate process termination. Search offsets/tail, max results, context, hidden, timeout and unsupported hints retain their existing capability-gated translators.
- Process/search/shell handles remain Executor-owned. `start_process` prefers PC Core shell sessions when advertised; read/interact/terminate preserve the compatibility-owned durable handle. No host-side command or side-effect executor is introduced.
- Native UI observation routes (`window.list`, `screenshot.capture`, `uia.find`) are read-only; `uia.invoke`, `input.click` and `input.type` remain side effects with no alias-based effect coercion.
- Native response `pc.native.response.v1`, `request_id` and `session_id` must match the invocation. A different version/identity, invalid batch or stalled continuation produces `NATIVE_RESULT_INVALID`, not a fabricated success.
- Registry, session, search, timeout, capability, idempotency and UNKNOWN error domains remain distinct from filesystem errors. Missing actions return `CAPABILITY_UNAVAILABLE`, never implicit fallback.
- Side-effect `reconciliation_required` is surfaced with `lookup_required: true` and `automatic_replay: false`. Repeated caller `request_id` remains the same durable logical identity; reconciliation belongs to existing facade/Control journal lookup, never a newly generated side-effect request.
- Protected-path rejection remains before provider dispatch, as covered by retained existing MCP/facade tests. R16 tests use mocked paths/temp fixtures only; no real protected/user data, Windows service/UAC/SCM or primary running stack is touched.
- This report is contract/CI evidence. **Release and production cutover remain held** pending independent full-gate evidence.

## Reproduction

```sh
npm ci
npm run test:r16-compat
npm run test:dc-compat
npm run test:mcp-host
npm run test:provider
npm run test:final-control
npm test
```

CI: `.github/workflows/ci.yml` includes `agent/pc-r16-full-compat-observability-20260928`, matrix `ubuntu-latest` + `windows-latest`, pinned npm dependency installation, the R16 focused audit, and the full suite. Exact-head SHA and run IDs are reported alongside the final pushed commit; intermediate green runs are not release evidence.
