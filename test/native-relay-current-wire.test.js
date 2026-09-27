import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_RELAY_LIMITS,
  REMOTE_FRAME_TYPES,
  REMOTE_FRAME_VERSION,
  NativeRelayServer,
  NativeRelayState,
  encodeRelayFrame,
  relaySha256Hex,
  requestFingerprint,
} from "../src/index.js";

function fixture(name) {
  return JSON.parse(readFileSync(
    new URL(`./fixtures/${name}`, import.meta.url),
    "utf8",
  ));
}

test("current 3a07382 PC transport byte vector is exact and matches relay encoder", () => {
  const current = fixture("pc-remote-transport-current-3a07382.json");
  assert.equal(
    current.contract_source.commit,
    "3a07382fa98f3e02a3d1ffbb4cc3c61b806e2e63",
  );
  assert.equal(
    current.contract_source.git_blob_sha1,
    "648d741d11c74d03b2f37039286ce23dc4b8d158",
  );
  assert.equal(
    current.contract_source.sha256,
    "ce0ffd0937e2d122199ee9aa54c61b22a87c17ca4c0ab57595a53dd3aa325de1",
  );

  const raw = encodeRelayFrame({
    deviceId: current.frame.device_id,
    sessionEpoch: current.frame.session_epoch,
    sequence: current.frame.sequence,
    type: current.frame.type,
    payload: current.frame.payload,
    credential: {
      generation: current.token.generation,
      secret: Buffer.from(current.token.secret_base64, "base64"),
    },
  });

  assert.equal(raw, current.encoded_utf8);
  assert.equal(relaySha256Hex(Buffer.from(raw, "utf8")), current.encoded_sha256);
  assert.equal(requestFingerprint(current.request), current.request_fingerprint);
});

test("current protocol constants and frame types match relay contract exactly", () => {
  const current = fixture("pc-remote-transport-current-3a07382.json");
  assert.equal(current.wire_constants.frame_version, REMOTE_FRAME_VERSION);
  assert.equal(current.wire_constants.max_frame_bytes, DEFAULT_RELAY_LIMITS.maxFrameBytes);
  assert.equal(current.wire_constants.max_request_bytes, DEFAULT_RELAY_LIMITS.maxRequestBytes);
  assert.equal(current.wire_constants.max_chunk_bytes, DEFAULT_RELAY_LIMITS.maxChunkBytes);
  assert.equal(current.wire_constants.max_stream_bytes, DEFAULT_RELAY_LIMITS.maxStreamBytes);
  assert.deepEqual(
    current.wire_constants.frame_types,
    [...REMOTE_FRAME_TYPES].sort(),
  );
});

test("current 3a07382 protocol remains byte-compatible with original relay source contract", () => {
  const old = fixture("pc-remote-transport-vector-v1.json");
  const current = fixture("pc-remote-transport-current-3a07382.json");

  assert.equal(current.encoded_utf8, old.encoded_utf8);
  assert.deepEqual(current.frame, old.frame);
  assert.deepEqual(current.token, old.token);
  assert.equal(
    current.wire_constants.frame_version,
    "pc_remote_transport.frame.v1",
  );
});

test("control API defaults fail closed and health/discovery never expose credentials", () => {
  const controlToken = "control-token-current-wire-0123456789abcdef";
  const state = new NativeRelayState();
  const secret = Buffer.alloc(32, "q");
  state.registerDevice({
    deviceId: "device-current-wire",
    generation: 1,
    secret,
    metadata: { label: "current-wire", api_token: "redact-me" },
  });

  assert.throws(
    () => new NativeRelayServer({
      state,
      controlToken,
      host: "0.0.0.0",
    }),
    /non-loopback/i,
  );

  const relay = new NativeRelayServer({ state, controlToken });
  const serialized = JSON.stringify({
    health: relay.health(),
    devices: relay.listDevices(),
  });
  assert.equal(serialized.includes(controlToken), false);
  assert.equal(serialized.includes(secret.toString("base64")), false);
  assert.equal(serialized.includes("redact-me"), false);
});
