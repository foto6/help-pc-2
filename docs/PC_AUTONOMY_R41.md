# PC Control Autonomy R41 — single supervisor

## Architecture

PC Control (native runtime with GitHub relay as verified fallback) is the primary control authority. The existing, SHA-pinned R45 **shadow** release is reused as the bounded agent DAG, exact-chat task dispatcher, Git/CI evidence verifier and optional local Ollama planner. This code does not create a second competing browser bridge.

The daemon runs independently of the ChatGPT coordinator tab. It writes a separate atomic state journal and never opens a new ChatGPT tab in observe mode. Exactly one coordinator is admitted through an exclusive lock.

## Included

- \`src/pc-autonomy-supervisor.js\`: PC Control relay freshness, operator lifecycle, queue pause, Bridge health, R42 hold, reconciliation, cooldown, 12 sends/hour default, 90s minimum inter-send gap, atomic journal.
- \`bin/pc-autonomy-daemon.js\`: perpetual local loop (\`--watch\`, >=60s) or one-shot observer (\`--once\`); loads exact immutable R45 SHADOW_ONLY release; independently checks all Git blob hashes; invokes R45 engine. Limits dispatch to **one assignment per tick**, even when multiple agents are waiting.
- \`examples/pc-autonomy.example.json\`: disabled observer config. The separate task plan must contain real exact chat/branch/HEAD bindings, not placeholders.
- \`test/pc-autonomy.test.js\`: adversarial no-Send, rate limiting, R42 hold, PC relay stale, crash/restart, unknown outcomes and lock tests.

Self-planning: \`enableBrain:true\` and a bounded R45 plan \`brain.enabled:true\` with \`brain.autoAccept\` explicitly approved. R45 proposes finite waves through **local Ollama**, never opens ChatGPT tabs to solicit new tasks, and requires actual GitHub HEAD + exact CI evidence to accept predecessors.

## Install without affecting live PC Control

Use an isolated checkout of branch \`agent/pc-autonomy-r41-native-supervisor-20261013\` of \`foto6/help-pc-2\`, **not the production PC Control, relay, or WebAIBridge worktrees**. Node.js 24 is preferred.

Copy the example to \`E:\PCControlAutonomy\config.json\` and configure a SHA-verified local R45 release and state paths. The existing release is under:

\`E:\WebAIBridge\app\data\operator-tools\r45-durable-autonomy\releases\28e4accf59e37e767c37585b85cdacbdbac62120\`

In the example, \`mode=observe\`, \`operatorApproved=false\`, and the plan is non-dispatchable. These commands make **no provider Send**:

\`\`\`text
node bin/pc-autonomy-daemon.js --config E:\PCControlAutonomy\config.json --once
node bin/pc-autonomy-daemon.js --config E:\PCControlAutonomy\config.json --watch
\`\`\`

In addition to the held R42 cutoff, enabled Send requires a fresh trusted local PC Control relay authority record at the explicit \`relay.healthFile\` with \`status=HEALTHY\`, \`reconciliationRequired=false\` and \`observedAt\` no more than 120 seconds old. The native PC HTTP endpoint, if configured, is merely observed; a failing native endpoint can never be used to bypass the GitHub relay production authority.

## Real-send controls — not activated

After the owner and other agents reconcile the live queue, old timeout effects, chat identities and **explicitly** remove the original R42 HOLD through the audited cutover mechanism, the exact plan must be reviewed and \`allowDispatch:true\` must be deliberately set. The owner can then choose \`mode=armed\`, \`operatorApproved=true\`, and:

\`\`\`text
node bin/pc-autonomy-daemon.js --config E:\PCControlAutonomy\config.json --watch --dispatch --i-accept-real-send
\`\`\`

Missing or stale gates fail closed. A 429 or unknown side effect induces cooldown/reconciliation; unknown effects are **never** retried under new IDs. New provider chats are never opened to evade usage limits. R45 requests checkpoints at ~35 min rather than relying on unlimited ChatGPT session duration.

**As of 2026-10-13**, production WebAIBridge R49 is BLOCKED, R42 HOLD remains active, and an unsent Telegram Curator assignment is queued. No safe basis exists to unpause or dispatch yet. The R41 code may be run **only as an isolated observer** while those issues remain.

Run focused checks with \`node --test test/pc-autonomy.test.js\`. No tool-safety disabling, social publishing, repo resets, Chrome restarts, or access to \`E:\manhwa\` is part of this implementation.


Local-only Ollama task proposals can be prepared while R42 HOLD is active, provided the approved finite R45 plan allows bounded planning. This does not enable browser Send; dispatch still requires every PC Control and R42 gate.


## Verified Windows always-on observer and crash recovery — 2026-10-13

**Exact tested code release:** \`d5c2ac399b3dc71cb9f83f28c2fc86ed942878bd\`. This release introduces a **lifetime watcher lease** alongside the pre-existing per-cycle transaction lock. A second \`--watch\` process aborts with \`AUTONOMY_LOCK_BUSY_OR_UNVERIFIED\`; a crash-abandoned lease can only be recovered after a two-minute grace period and independent proof that the recorded PID is dead, with immutable orphan evidence retained. A running or ambiguous PID is never stolen. Windows+Ubuntu focused regressions: [GitHub Actions 38344447668](https://github.com/foto6/help-pc-2/actions/runs/38344447668), full CI additionally [38344447719](https://github.com/foto6/help-pc-2/actions/runs/38344447719). The exact seven local source blobs and Node tests were also verified before controlled installation.

Operator-PC production remains separated:
- R41 isolated root: \`E:\PCControlAutonomyR41\`
- User observer source: \`E:\PCControlAutonomyR41\releases\d5c2ac399b3dc71cb9f83f28c2fc86ed942878bd\`
- Current-user startup target: \`E:\PCControlAutonomyR41\START_R41_OBSERVER.cmd\`
- Current-user shutdown: \`E:\PCControlAutonomyR41\STOP_R41_USER_OBSERVER.cmd\`
- Separate structured state: \`E:\PCControlAutonomyR41\data\pc-control-supervisor.json\`
- Current observer PID at verification: 8276. Lifetime lock is owned by the same exact PID, read-only \`--watch\`. Running a second watcher returned code 1 before any cycle.
- Automatic retry on next Windows user login: Startup cmd restarts a failed Node observer after a bounded 75-second delay, subject to the lifetime lock. A user STOP sets the explicit \`data\STOP_R41_OBSERVER.flag\` to prevent respawn, then terminates only the exact R41 Node process and removes the owned startup entry.
- All updates save backups under \`E:\PCControlAutonomyR41\backups\`; previous source releases remain unchanged.
- This user-level login startup **does not provide machine-level Windows service uptime when no user is logged in**. The scheduler ONLOGON attempt was denied by Windows and was not forced through elevation.

**Authority caveat:** R49 WebAIBridge continues at \`5da11c6b...\` with \`CUTOVER_HOLD_PREPARED\`, deliberate \`holdActive:true\`, watchdog \`enabled:false\` and \`allowAutonomousSend:false\`. The browser profile on debug port 17410 was directly observed with \`workerConnected:true\` on 2026-10-13; older \`profile_offline\` managed-chat entries are cached, not proof of current offline state. No automatic ChatGPT Send was enabled. See [independent Boss evidence](https://github.com/foto6/boss/pull/9).
