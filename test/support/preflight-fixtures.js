import { readFileSync } from "node:fs";
import { canonicalSha256 } from "../../src/index.js";

const BASE = new URL(
  "../../conformance/frozen/executor/d0ccb0f390474fc3fc091e51c25f7ef8771b0f09/tests/fixtures/preflight_v1/",
  import.meta.url,
);

export function readFrozenPreflightFixture(name) {
  return JSON.parse(readFileSync(new URL(name, BASE), "utf8"));
}

export function frozenCapabilities() {
  return readFrozenPreflightFixture("capabilities.json");
}

export function mutateCapabilities(mutator) {
  const payload = frozenCapabilities();
  mutator(payload);
  const body = structuredClone(payload);
  delete body.attestation;
  payload.attestation.digest = canonicalSha256(body);
  return payload;
}

export function bindPreflightResult(name, { requestId, action, capabilitiesDigest }) {
  const payload = readFrozenPreflightFixture(name);
  payload.request_id = requestId;
  payload.action = action;
  if (capabilitiesDigest) payload.capabilities_digest = capabilitiesDigest;
  return payload;
}
