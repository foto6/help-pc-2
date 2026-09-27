import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  canonicalSha256,
  parseVisionVerificationInputV1,
} from "../../src/index.js";

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

test("Python canonical float vectors preserve integral-looking floats and negative zero", () => {
  const vectors = [
    {
      pythonCanonicalJson: '{"value":50.0}',
      pythonSha256: "f25d83dda39e9f5eba217c9e47c1f83b07ddf119d5fc5fab9771221007127750",
      jsNormalizedSha256: "b3ff35319045aae558b55e787ba2ece9f2edb99905342c076ee98f9f834a36fe",
    },
    {
      pythonCanonicalJson: '{"a":-0.0,"b":50.0,"c":0.125}',
      pythonSha256: "33cf6e1145761dfe32c398799384e8563394c0a6178e39a351e2d998113329b7",
      jsNormalizedSha256: "0a0abcc43580653cb7965e6f9d748122e428a02381d26db4d488e32c5a1b1ded",
    },
  ];
  for (const vector of vectors) {
    assert.equal(sha256(vector.pythonCanonicalJson), vector.pythonSha256);
    const parsed = JSON.parse(vector.pythonCanonicalJson);
    assert.equal(canonicalSha256(parsed), vector.jsNormalizedSha256);
    assert.notEqual(vector.pythonSha256, vector.jsNormalizedSha256);
  }
});

test("Wave4 frozen Vision input keeps Python 50.0 canonical bytes authoritative", () => {
  const fixtureUrl = new URL(
    "../../conformance/frozen/vision/f20e2c2e35cbcb9b675c9c1a0568de2e40b5eb82/tests/fixtures/post_action_verification_result_v1/verification_input.json",
    import.meta.url,
  );
  const canonicalText = readFileSync(fixtureUrl, "utf8").trimEnd();
  const payload = JSON.parse(canonicalText);
  assert.match(canonicalText, /"height":16\.666666666666668,"width":50\.0/);
  assert.match(canonicalText, /"y":50\.0/);
  const parsed = parseVisionVerificationInputV1(payload, { canonicalJsonText: canonicalText });
  assert.equal(parsed.canonicalDigest, "fd9003468e901fe009e8aa0b2720dd91babce3cf9c19253a114d6248b0e180a1");
  assert.notEqual(canonicalSha256(payload), parsed.canonicalDigest);
});
