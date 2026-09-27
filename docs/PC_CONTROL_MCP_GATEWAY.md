# PC Control MCP Gateway

This branch exposes the existing durable PC Control Plane as a local MCP stdio server.

The gateway does **not** bypass Control Plane or PC Executor safety. `pc_shell_run`
creates a normal durable `shell.run` action and drives it through the same provider,
preflight, outcome evidence and reconciliation path as other actions.

## Runtime chain

```
ChatGPT / MCP client
  -> pc-control-mcp (stdio)
  -> PC Control Plane
  -> HelpPc1Adapter
  -> pc-executor JSONL process
  -> Windows adapters / shell.run
```

## Safety defaults

- Gateway defaults to dry-run.
- Live Executor side effects require `PC_CONTROL_LIVE=1`.
- Destructive Control Plane actions stay disabled by policy.
- Credential/CAPTCHA automation remains prohibited.
- Executor protected paths remain authoritative.
- `pc_shell_run` accepts only `argv: string[]`; it never accepts a raw shell command string.
- If durable work from a previous run is unfinished, the convenience shell tool fails with `GATEWAY_BUSY` instead of accidentally draining unrelated actions.

## Prerequisites

Install the matching PC Executor locally:

```powershell
py -m pip install -e "E:\path\to\help-pc-1"
pc-executor --help
```

For PowerShell execution, PC Executor must contain the reviewed PowerShell allowlist change; the gateway itself never expands the Executor allowlist.

## Dry-run start

```powershell
cd E:\path\to\help-pc-2
npm test
npm run test:gateway
npm run gateway:mcp
```

## Live start

```powershell
$env:PC_CONTROL_LIVE = "1"
$env:PC_CONTROL_DESKTOP_ID = "desktop-main"
npm run gateway:mcp
```

Optional environment variables:

- `PC_EXECUTOR_COMMAND` — executable name/path, default `pc-executor`
- `PC_EXECUTOR_CWD` — working directory for the Executor child process
- `PC_EXECUTOR_REQUEST_TIMEOUT_MS` — bounded transport/request deadline
- `PC_CONTROL_DATA_DIR` — durable state/audit directory
- `PC_CONTROL_DESKTOP_ID` — logical local desktop identity

## MCP tools

The server exposes all existing Control Plane RPC tools from `mcpToolDefinitions()` plus:

- `pc_health` — read-only gateway/runtime/Executor status
- `pc_shell_run` — one bounded argv-based shell action through normal Control Plane safety

Typical shell arguments:

```json
{
  "argv": ["powershell.exe", "-NoProfile", "-Command", "git status"],
  "cwd": "E:\\work",
  "timeoutMs": 30000,
  "idempotencyKey": "status-check-001"
}
```

The actual executable allowlist is always enforced by PC Executor.

## ChatGPT connection status

This repository provides the local MCP stdio endpoint. A ChatGPT web session cannot reach a private local stdio process by itself.
The gateway still needs to be registered through a supported local/remote MCP connector or relay before it appears as a native tool in ChatGPT.

Until that registration exists, Remote Desktop Commander may be used only as a bootstrap or independent fallback channel; it is not part of the PC Control execution path.
