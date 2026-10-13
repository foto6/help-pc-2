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
