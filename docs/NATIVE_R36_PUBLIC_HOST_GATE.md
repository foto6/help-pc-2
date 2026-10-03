# R36 — public HTTPS Host gate

R36 fixes the direct remote MCP Host parser so valid DNS hostnames containing the letter `s` are accepted while whitespace and slash characters remain rejected.

The historical R30/R31 source pin remains immutable. R36 has its own source pin because this is an intentional change to `src/direct-remote-mcp.js`; the old R31 source-pin test is expected to report source drift after R35/R36 and is not rewritten.

Live validation used the real R35/R24 direct path behind an ephemeral Cloudflare HTTPS tunnel. Public MCP discovery exposed 90 tools. Read-only `ping` and `list_devices` completed. A bounded append side effect using stable request id `r35-public-remote-write-001` completed, and an identical duplicate returned completed with `automatic_replay=false`; the fixture gained exactly one remote-canary line.

Focused R30/R33/R35/R36 regression passed 48/48. The public tunnel is validation-only and is not a production endpoint. GitHub relay remains the current authority and no ChatGPT/plugin registration or production cutover is claimed.
