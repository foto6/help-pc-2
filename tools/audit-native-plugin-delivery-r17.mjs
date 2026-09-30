import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const BASE = "2e5e06ba6966435c0e49e49a9de6e9c550eae8f6";
const EXPECTED = new Set([
  ".github/workflows/ci.yml",
  "bin/pc-native-plugin-delivery-preflight.js",
  "docs/NATIVE_PC_PLUGIN_DELIVERY_R17.md",
  "src/native-plugin-delivery.js",
  "test/native-plugin-delivery-r17.test.js",
  "tools/audit-native-plugin-delivery-r17.mjs",
]);
const ISSUE6_OWNED = new Set([
  "src/mcp-host.js",
  "src/mcp-http-host.js",
  "src/native-facade.js",
  "test/r17-session-renewal.test.js",
]);
const FROZEN = [
  "package.json",
  "package-lock.json",
  "src/mcp-runtime-config.js",
  "src/native-registry.js",
  "src/native-relay-provider.js",
  "src/native-relay-registry-route.js",
  "src/native-relay-server.js",
];

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function blob(ref, path) {
  return git("rev-parse", `${ref}:${path}`);
}

const head = git("rev-parse", "HEAD");
if (git("merge-base", BASE, head) !== BASE) {
  throw new Error("R17 plugin branch is not based on the exact required head");
}
const changed = new Set(
  git("diff", "--name-only", BASE, head).split(/\r?\n/).filter(Boolean),
);
const missing = [...EXPECTED].filter((name) => !changed.has(name));
const extra = [...changed].filter((name) => !EXPECTED.has(name));
if (missing.length || extra.length) {
  throw new Error(`R17 changed-file drift missing=${missing} extra=${extra}`);
}
for (const path of ISSUE6_OWNED) {
  if (changed.has(path)) throw new Error(`Issue #6 owned file changed: ${path}`);
}
for (const path of FROZEN) {
  if (blob(BASE, path) !== blob(head, path)) {
    throw new Error(`Frozen R15c/plugin dependency drift: ${path}`);
  }
}

const source = readFileSync("src/native-plugin-delivery.js", "utf8");
for (const required of [
  "REMOTE_PLUGIN_DISABLED",
  "EXISTING_PLUGIN_IDENTITY",
  "PINNED_PC_FROZEN_DIGEST",
  "PINNED_CONTROL_NATIVE_DIGEST",
  "frozen !== 37",
  "parity !== 25",
  "UNKNOWN_RECONCILE",
  "automatic_replay: false",
  "PAIRING_BINDING_MISMATCH",
  "PROTECTED_PATH",
  "wss:",
]) {
  if (!source.includes(required)) {
    throw new Error(`R17 delivery invariant missing: ${required}`);
  }
}
if (source.includes("0.0.0.0") || source.includes("127.0.0.1/mcp")) {
  throw new Error("R17 source contains forbidden public-bind/localhost registration");
}

for (const path of changed) {
  if (path === "mcp.json" || path.endsWith("/mcp.json")) {
    throw new Error("mcp.json must not be published before a real verified endpoint exists");
  }
}

const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
if (!workflow.includes("agent/native-pc-plugin-delivery-r17-20260929")) {
  throw new Error("CI branch trigger missing");
}
if (!workflow.includes("test/native-plugin-delivery-r17.test.js")) {
  throw new Error("R17 focused CI step missing");
}

const docs = readFileSync("docs/NATIVE_PC_PLUGIN_DELIVERY_R17.md", "utf8");
for (const required of [
  "BLOCKED_APPROVED_REMOTE_ENDPOINT_REQUIRED",
  "zero Native PC MCP callable",
  "NOT_RUN",
  "existing `pc-control` plugin identity",
]) {
  if (!docs.includes(required)) {
    throw new Error(`R17 blocked/operator evidence missing: ${required}`);
  }
}

execFileSync("git", ["diff", "--check", BASE, head], { stdio: "inherit" });
console.log(
  `R17 Native PC plugin delivery audit: PASS head=${head} base=${BASE} files=${changed.size}`,
);
