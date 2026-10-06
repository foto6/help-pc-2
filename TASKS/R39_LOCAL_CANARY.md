# Native MCP R39

Branch: agent/native-mcp-r39-local-canary-20261006
Parent: a0d8438f0e4fa93e6be50402efb6783f92c3412b
Parent CI: 37406258361 SUCCESS

Goal: staged local canary and operator cutover readiness.

Acceptance:
- read-only Windows preflight;
- isolated canary that cannot replace production authority;
- RUNNING / PAUSED / DRAINING / RECONCILIATION_REQUIRED verified;
- explicit resume and no replay of unknown effects;
- GitHub relay remains fallback;
- cutover plan generated but not applied;
- Windows + Ubuntu exact-head CI;
- deterministic readiness artifact;
- no production cutover in this milestone.
