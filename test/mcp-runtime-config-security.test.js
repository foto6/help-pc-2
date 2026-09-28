import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXECUTOR_MODULE_PIN_V1,
  createConfiguredNativeMcpRuntime,
  inspectExecutorModuleIdentity,
  importPinnedExecutorModule,
  verifyExecutorModuleIdentity,
} from "../src/index.js";

function fixtureRoot(t, prefix) {
  const created = mkdtempSync(join(tmpdir(), prefix));
  const root = realpathSync.native(created);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writePackage(root, { name = "@foto6/test-executor", version = "1.0.0" } = {}) {
  writeFileSync(join(root, "package.json"), JSON.stringify({ name, version, type: "module" }, null, 2));
}

function bridgeSource({ marker = null, providerMarker = null, digest = "test-cap-v1" } = {}) {
  const sideEffect = marker || providerMarker
    ? `import { appendFileSync } from "node:fs";${marker ? ` appendFileSync(${JSON.stringify(marker)}, "imported\\n");` : ""}\n`
    : "";
  const providerEffect = providerMarker
    ? `appendFileSync(${JSON.stringify(providerMarker)}, "provider-called\\n");\n      `
    : "";
  return `${sideEffect}
export async function createExecutorBridge() {
  return {
    dryRun: false,
    readCapabilities: async () => ({
      contract_version: "pc_executor.capabilities.v1",
      digest: ${JSON.stringify(digest)},
      actions: [],
    }),
    invoke: async (request) => {
      ${providerEffect}return {
        request_id: request.request_id,
        action: request.action,
        ok: true,
        status: "completed",
        data: {},
        dry_run: false,
      };
    },
  };
}
`;
}
test("production runtime rejects arbitrary executor module override before import", async (t) => {
  const root = fixtureRoot(t, "mcp-pin-prod-");
  writePackage(root);
  const marker = join(root, "malicious-import.txt");
  const malicious = join(root, "malicious.mjs");
  writeFileSync(malicious, bridgeSource({ marker }));
  const previous = process.env.PC_NATIVE_EXECUTOR_MODULE;
  process.env.PC_NATIVE_EXECUTOR_MODULE = malicious;
  t.after(() => {
    if (previous === undefined) delete process.env.PC_NATIVE_EXECUTOR_MODULE;
    else process.env.PC_NATIVE_EXECUTOR_MODULE = previous;
  });

  await assert.rejects(
    createConfiguredNativeMcpRuntime({ stateDir: join(root, "state") }),
    (error) => error?.code === "PRODUCTION_EXECUTOR_MODULE_OVERRIDE_FORBIDDEN",
  );
  assert.equal(existsSync(marker), false);
});

test("verified test configuration accepts only the exact pinned module identity", async (t) => {
  const root = fixtureRoot(t, "mcp-pin-good-");
  writePackage(root);
  const good = join(root, "bridge.mjs");
  writeFileSync(good, bridgeSource({ digest: "verified-cap-v1" }));
  const pin = inspectExecutorModuleIdentity(good);
  assert.equal(pin.contract_version, EXECUTOR_MODULE_PIN_V1);

  const configured = await createConfiguredNativeMcpRuntime({
    stateDir: join(root, "state"),
    testConfig: { enabled: true, executorModule: good, trustedPin: pin },
  });
  t.after(() => configured.runtime.close());
  assert.equal(configured.moduleIdentity.module_sha256, pin.module_sha256);
  assert.equal(configured.moduleIdentity.package_name, "@foto6/test-executor");
  assert.equal(configured.moduleIdentity.package_version, "1.0.0");
});
test("attacker path substitution fails before malicious module import or provider side effect", async (t) => {
  const root = fixtureRoot(t, "mcp-pin-substitute-");
  writePackage(root);
  const good = join(root, "good.mjs");
  const marker = join(root, "side-effects.txt");
  const providerMarker = join(root, "provider-side-effects.txt");
  const malicious = join(root, "malicious.mjs");
  writeFileSync(good, bridgeSource());
  writeFileSync(malicious, bridgeSource({ marker, providerMarker }));
  const pin = inspectExecutorModuleIdentity(good);

  await assert.rejects(
    createConfiguredNativeMcpRuntime({
      stateDir: join(root, "state"),
      testConfig: { enabled: true, executorModule: malicious, trustedPin: pin },
    }),
    (error) => error?.code === "EXECUTOR_MODULE_IDENTITY_MISMATCH",
  );
  assert.equal(existsSync(marker), false, "malicious module must never be imported");
  assert.equal(existsSync(providerMarker), false, "malicious provider side-effect count must remain zero");
});

test("same-path digest drift fails before changed module executes", async (t) => {
  const root = fixtureRoot(t, "mcp-pin-digest-");
  writePackage(root);
  const modulePath = join(root, "bridge.mjs");
  const marker = join(root, "digest-drift-side-effect.txt");
  writeFileSync(modulePath, bridgeSource());
  const pin = inspectExecutorModuleIdentity(modulePath);
  writeFileSync(modulePath, bridgeSource({ marker, digest: "changed" }));

  assert.throws(
    () => verifyExecutorModuleIdentity(modulePath, pin),
    (error) => error?.code === "EXECUTOR_MODULE_IDENTITY_MISMATCH" &&
      error.details?.mismatches?.some((item) => item.field === "module_sha256"),
  );
  await assert.rejects(
    importPinnedExecutorModule(modulePath, pin),
    (error) => error?.code === "EXECUTOR_MODULE_IDENTITY_MISMATCH",
  );
  assert.equal(existsSync(marker), false);
});
test("package version or manifest drift invalidates the pinned bridge before import", async (t) => {
  const root = fixtureRoot(t, "mcp-pin-package-");
  writePackage(root, { version: "1.0.0" });
  const modulePath = join(root, "bridge.mjs");
  const marker = join(root, "package-drift-side-effect.txt");
  writeFileSync(modulePath, bridgeSource({ marker }));
  const pin = inspectExecutorModuleIdentity(modulePath);
  writePackage(root, { version: "1.0.1" });

  assert.throws(
    () => verifyExecutorModuleIdentity(modulePath, pin),
    (error) => error?.code === "EXECUTOR_MODULE_IDENTITY_MISMATCH" &&
      error.details?.mismatches?.some((item) =>
        item.field === "package_version" || item.field === "package_json_sha256"),
  );
  assert.equal(existsSync(marker), false);
});

test("symlink or junction path aliases are rejected instead of silently canonicalized", async (t) => {
  const root = fixtureRoot(t, "mcp-pin-alias-");
  const packageRoot = join(root, "package");
  const aliasRoot = join(root, "alias");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(packageRoot);
  writePackage(packageRoot);
  const modulePath = join(packageRoot, "bridge.mjs");
  writeFileSync(modulePath, bridgeSource());
  const pin = inspectExecutorModuleIdentity(modulePath);
  symlinkSync(packageRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");
  const aliasModule = join(aliasRoot, "bridge.mjs");

  assert.throws(
    () => verifyExecutorModuleIdentity(aliasModule, pin),
    (error) => error?.code === "EXECUTOR_MODULE_ALIAS_DRIFT",
  );
});

test("explicit test-only bridge factory seam is opt-in and does not depend on production module env", async (t) => {
  const root = fixtureRoot(t, "mcp-test-inject-");
  let providerCalls = 0;
  const configured = await createConfiguredNativeMcpRuntime({
    stateDir: join(root, "state"),
    testConfig: {
      enabled: true,
      createExecutorBridge: async () => ({
        readCapabilities: async () => ({
          contract_version: "pc_executor.capabilities.v1",
          digest: "injected-cap-v1",
          actions: [],
        }),
        invoke: async () => {
          providerCalls += 1;
          throw new Error("not expected");
        },
      }),
    },
  });
  t.after(() => configured.runtime.close());
  assert.equal(configured.moduleIdentity.injected, true);
  assert.equal(providerCalls, 0);

  await assert.rejects(
    createConfiguredNativeMcpRuntime({
      stateDir: join(root, "bad-state"),
      testConfig: { enabled: false, createExecutorBridge: async () => ({}) },
    }),
    /enabled=true/,
  );
});
