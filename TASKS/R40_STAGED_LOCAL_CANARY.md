# Native MCP R40 — real staged local canary evidence

Writable branch: agent/native-mcp-r40-staged-local-canary-20261007
Exact start: 8264b87bcb3ab06993f46cb5cd59ff5e5574b4a1
Parent R39 CI: 37610672352 SUCCESS

Goal: execute the already-implemented R39 staged local canary on the user's Windows PC and capture real evidence, while GitHub relay remains production authority.

Required:
- read-only preflight first;
- isolated non-production root/port/service identity;
- validate RUNNING -> PAUSED -> DRAINING -> RECONCILIATION_REQUIRED -> PAUSED -> RUNNING and idempotent RUNNING;
- no blind replay;
- do not replace/stop current GitHub relay;
- do not install production service/task/firewall/tunnel changes;
- collect exact local evidence and commit only non-secret machine-readable summaries;
- exact-head CI for any source changes;
- emit CANARY_READY or exact blocker;
- no production cutover in this milestone.

Return exact SHA/CI/artifacts + local canary evidence and next cutover recommendation.