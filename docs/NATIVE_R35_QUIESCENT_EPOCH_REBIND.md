# R35 — quiescent device-epoch rebind

R35 closes the production reboot gap found by the live R34 side-effect canary.

A device reconnect changes its authenticated transport epoch. R34 correctly failed closed with `STALE_DEVICE_SESSION`, but this meant a persistent direct-MCP runtime could not resume after a normal device reboot without operator recovery.

R35 does not permit silent rebinding. It separates device identity **observation** from provider binding **commit**. Normal provider calls remain fail-closed on epoch drift. A rebind is allowed only during explicit tool-call admission after the NativeControlFacade proves that the existing session is quiescent: same device ID and Executor digest, exact active Control owner, no nonterminal actions, no unsettled facade requests, and no open process/session handles. UNKNOWN work or a live handle keeps `STALE_DEVICE_SESSION`.

The live Windows canary used the real R24 Executor, a loopback NativeRelayServer and the R35 direct-MCP candidate. One append mutation completed, relay + device + MCP were fully restarted with durable state preserved, then the identical request ID returned its cached completed receipt without a second append. A new mutation then completed on the new epoch. The physical fixture contained exactly two expected lines.

Historical R30/R31 source pins remain immutable. R35 has its own source pin because changing the direct-MCP implementation is expected to make the R31 frozen R30 blob test report source drift.
