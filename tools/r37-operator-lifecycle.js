#!/usr/bin/env node
import { resolve } from "node:path";
import {
  JsonR37OperatorLifecycleStore,
  R37OperatorLifecycle,
  R37_PINNED_AUTHORITY_SHA,
  R37_PINNED_AUTHORITY_VERSION,
} from "../src/r37-operator-lifecycle.js";

function arg(flag, fallback = null) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const command = process.argv[2] ?? "status";
const stateFile = resolve(
  arg("--state-file", process.env.PC_NATIVE_R37_STATE_FILE ?? ".pc-native-mcp-state/operator-lifecycle-r37.json"),
);
const lifecycle = new R37OperatorLifecycle({
  store: new JsonR37OperatorLifecycleStore(stateFile),
  authoritySha: arg("--authority-sha", process.env.PC_NATIVE_AUTHORITY_SHA ?? R37_PINNED_AUTHORITY_SHA),
  authorityVersion: arg("--authority-version", process.env.PC_NATIVE_AUTHORITY_VERSION ?? R37_PINNED_AUTHORITY_VERSION),
});

let output;
switch (command) {
  case "status":
    output = await lifecycle.status();
    break;
  case "pause":
    output = lifecycle.pause(arg("--reason", "operator_pause"));
    break;
  case "drain":
    output = lifecycle.drain();
    break;
  case "resume":
    output = lifecycle.resume();
    break;
  case "require-reconciliation":
    output = lifecycle.requireReconciliation(arg("--request-id"));
    break;
  case "clear-reconciliation":
    output = lifecycle.clearReconciliation(arg("--request-id"));
    break;
  default:
    throw new Error(
      "command must be one of: status, pause, drain, resume, require-reconciliation, clear-reconciliation",
    );
}

process.stdout.write(JSON.stringify(output, null, 2) + "\n");
