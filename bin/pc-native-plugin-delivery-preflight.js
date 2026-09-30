#!/usr/bin/env node
import {
  assessPluginDeliveryGate,
  validateApprovedBrokerOrigin,
} from "../src/native-plugin-delivery.js";

function output(value, code = 2) {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
  process.exitCode = code;
}

const enabled = process.env.PC_NATIVE_PLUGIN_REMOTE_ENABLE === "1";
if (!enabled) {
  output({
    contract_version: "pc.native.chatgpt.plugin_delivery_preflight.v1",
    status: "BLOCKED_REMOTE_PLUGIN_DISABLED",
    ready: false,
    action_required: "explicitly opt in after an approved remote endpoint exists",
  });
} else {
  const brokerOrigin = process.env.PC_NATIVE_PLUGIN_BROKER_ORIGIN ?? "";
  const approvedHostname = process.env.PC_NATIVE_PLUGIN_BROKER_HOSTNAME ?? "";
  if (!brokerOrigin || !approvedHostname) {
    output({
      contract_version: "pc.native.chatgpt.plugin_delivery_preflight.v1",
      ...assessPluginDeliveryGate(),
      action_required: "provide an approved real HTTPS broker origin and exact hostname",
    });
  } else {
    try {
      const origin = validateApprovedBrokerOrigin(brokerOrigin, {
        approvedHostname,
      });
      output({
        contract_version: "pc.native.chatgpt.plugin_delivery_preflight.v1",
        ...assessPluginDeliveryGate({ brokerOrigin: origin }),
        broker_origin: origin,
        action_required: "complete explicit secure pairing; do not publish mcp.json yet",
      });
    } catch (caught) {
      output({
        contract_version: "pc.native.chatgpt.plugin_delivery_preflight.v1",
        status: caught?.code ?? "BLOCKED_INVALID_CONFIGURATION",
        ready: false,
        action_required: "correct the approved broker configuration",
      });
    }
  }
}
