# Browser tab image media: isolated PC Control MCP sidecar

This opt-in feature is separate from the pinned R31/R38 PC Control Native MCP
host. It does not alter direct remote, GitHub relay or PC Executor authority.

## What is implemented

- List exact Chrome page target IDs and sanitized URL (no query or fragment).
- Capture the selected tab using only CDP Page.captureScreenshot.
- Return a genuine MCP content item of type image with mimeType image/png.
- Never activate tabs, focus Chrome, scroll, click, type, navigate or resize.
- CDP discovery is local loopback only, with allowlisted port numbers.
- No screenshot pixels go to GitHub or stdout logs. Image media is delivered
  through an authorized local MCP connection to the requesting MCP client.

## Host requirements

- Chrome already running with localhost remote debugging enabled. The user
  must authorize observing their selected tabs. Example existing ports:
  17410 (ChatGPT), 17447 (Gemini).
- Node.js 24, project dependencies installed by npm ci.
- A desktop MCP client capable of launching a local stdio MCP server.

Set this environment variable in the MCP client's local process environment:

    PC_CONTROL_ENABLE_BROWSER_TAB_CAPTURE=1

Optional strict port allowlist:

    PC_CONTROL_BROWSER_CDP_ALLOWED_PORTS=17410,17447

Launch entrypoint:

    node bin/pc-browser-tab-mcp-stdio.js

Tools:

    browser.tab.list    { port:17410 }
    browser.tab.capture { port:17410, target_id:"<exact ID from list>", expected_url:"https://example.org/path" }

The capture response contains image/png media bytes and metadata; it never
encodes PNG as a text-only fake screenshot. Do not publish captured media to
issues/PRs or durable GitHub relay logs.

## Non-goals and limits

- This feature does **not** automatically appear in the current ChatGPT
  conversation. A compatible trusted MCP client must connect and expose this
  sidecar tool namespace. The existing PC Control account skill/plugin does
  not by itself establish this native media connection.
- The pinned direct remote host is deliberately unchanged; its R38 source
  SHA checks must continue to pass. This is not a production direct-host
  cutover or release authority update.
- Chrome may return a blank or stale frame if minimized/suspended. Test on
  the live Windows host before claiming minimized-window success.
- The sidecar must not be exposed directly on an untrusted/public network:
  CDP is highly privileged. Use a trusted local stdio MCP connection.

## Verification

    npm test
    node --test test/browser-tab-capture.test.js test/browser-tab-mcp-sidecar.test.js

Live host acceptance must include (1) exact tab listing, (2) real MCP image
return, (3) user-chosen tab covered by another foreground window and HWND
unchanged, (4) minimized behavior, (5) two simultaneous Chrome profiles,
(6) auth/port allowlist blocked negatives. No fake pixels as live evidence.

## Existing Windows read-only capture evidence

On October 9, 2026, the separate WebAIBridge CLI captured actual local Chrome
tabs on ports 17410 and 17447 with SHA-256-verified PNGs and no foreground HWND
change. This proves the CDP capture path on Windows, not that this new MCP
sidecar has been attached to ChatGPT.
