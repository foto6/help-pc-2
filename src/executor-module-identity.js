import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const EXECUTOR_MODULE_PIN_V1 = "pc.native.executor_module_pin.v1";

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizedIdentityPath(value) {
  const resolved = resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function modulePathFromSpecifier(specifier) {
  if (typeof specifier !== "string" || !specifier.trim()) {
    throw identityError("PC_NATIVE_EXECUTOR_MODULE is required", "EXECUTOR_MODULE_REQUIRED");
  }
  const value = specifier.trim();
  if (value.startsWith("file:")) return fileURLToPath(value);
  if (!isAbsolute(value)) {
    throw identityError("Executor module path must be absolute in production", "EXECUTOR_MODULE_PATH_UNPINNED");
  }
  return value;
}

function identityError(message, code, details = null) {
  const error = new Error(message);
  error.name = "ExecutorModuleIdentityError";
  error.code = code;
  error.details = details;
  return error;
}
function findPackageJson(moduleRealPath) {
  let current = dirname(moduleRealPath);
  const root = parse(current).root;
  for (;;) {
    const candidate = join(current, "package.json");
    try {
      const stat = lstatSync(candidate);
      if (stat.isSymbolicLink()) {
        throw identityError("Executor package.json must not be a symlink", "EXECUTOR_PACKAGE_ALIAS_DRIFT", { candidate });
      }
      if (!stat.isFile()) {
        throw identityError("Executor package.json must be a regular file", "EXECUTOR_PACKAGE_IDENTITY_INVALID", { candidate });
      }
      const real = realpathSync.native(candidate);
      if (normalizedIdentityPath(candidate) !== normalizedIdentityPath(real)) {
        throw identityError("Executor package path resolves through an alias", "EXECUTOR_PACKAGE_ALIAS_DRIFT", {
          candidate,
          real,
        });
      }
      return real;
    } catch (error) {
      if (error?.code && String(error.code).startsWith("EXECUTOR_")) throw error;
      if (error?.code !== "ENOENT") throw error;
    }
    if (current === root) break;
    current = dirname(current);
  }
  throw identityError("Executor module is not contained in a package with package.json", "EXECUTOR_PACKAGE_IDENTITY_MISSING");
}

export function inspectExecutorModuleIdentity(specifier) {
  const requested = modulePathFromSpecifier(specifier);
  const requestedResolved = resolve(requested);
  const moduleStat = lstatSync(requestedResolved);
  if (moduleStat.isSymbolicLink()) {
    throw identityError("Executor module must not be a symlink", "EXECUTOR_MODULE_ALIAS_DRIFT", { requested: requestedResolved });
  }
  if (!moduleStat.isFile()) {
    throw identityError("Executor module must be a regular file", "EXECUTOR_MODULE_IDENTITY_INVALID", { requested: requestedResolved });
  }
  const moduleRealPath = realpathSync.native(requestedResolved);
  if (normalizedIdentityPath(requestedResolved) !== normalizedIdentityPath(moduleRealPath)) {
    throw identityError("Executor module path resolves through an alias", "EXECUTOR_MODULE_ALIAS_DRIFT", {
      requested: requestedResolved,
      real: moduleRealPath,
    });
  }

  const packageJsonPath = findPackageJson(moduleRealPath);
  const packageRoot = dirname(packageJsonPath);
  const modulePathKey = normalizedIdentityPath(moduleRealPath);
  const packageRootKey = normalizedIdentityPath(packageRoot);
  const boundary = packageRootKey.endsWith("\\") || packageRootKey.endsWith("/") ? packageRootKey : packageRootKey + (process.platform === "win32" ? "\\" : "/");
  if (modulePathKey !== packageRootKey && !modulePathKey.startsWith(boundary)) {
    throw identityError("Executor module escaped its package root", "EXECUTOR_PACKAGE_BOUNDARY_MISMATCH");
  }
  const packageBytes = readFileSync(packageJsonPath);
  let packageJson;
  try {
    packageJson = JSON.parse(packageBytes.toString("utf8"));
  } catch (error) {
    throw identityError("Executor package.json is invalid JSON", "EXECUTOR_PACKAGE_IDENTITY_INVALID", {
      message: error.message,
    });
  }
  if (typeof packageJson.name !== "string" || !packageJson.name ||
      typeof packageJson.version !== "string" || !packageJson.version) {
    throw identityError("Executor package must declare immutable name and version", "EXECUTOR_PACKAGE_IDENTITY_INVALID");
  }

  return Object.freeze({
    contract_version: EXECUTOR_MODULE_PIN_V1,
    configured: true,
    module_path: moduleRealPath,
    module_sha256: sha256Bytes(readFileSync(moduleRealPath)),
    package_root: realpathSync.native(packageRoot),
    package_name: packageJson.name,
    package_version: packageJson.version,
    package_json_sha256: sha256Bytes(packageBytes),
  });
}

function requirePin(pin) {
  if (!pin || typeof pin !== "object" || Array.isArray(pin) ||
      pin.contract_version !== EXECUTOR_MODULE_PIN_V1 || pin.configured !== true) {
    throw identityError("Production Executor module pin is not configured", "EXECUTOR_MODULE_PIN_UNCONFIGURED");
  }
  for (const key of [
    "module_path",
    "module_sha256",
    "package_root",
    "package_name",
    "package_version",
    "package_json_sha256",
  ]) {
    if (typeof pin[key] !== "string" || !pin[key]) {
      throw identityError(`Executor module pin is missing ${key}`, "EXECUTOR_MODULE_PIN_INVALID", { key });
    }
  }
  if (!isAbsolute(pin.module_path) || !isAbsolute(pin.package_root)) {
    throw identityError("Executor module pin paths must be absolute", "EXECUTOR_MODULE_PIN_INVALID");
  }
  for (const key of ["module_sha256", "package_json_sha256"]) {
    if (!/^[0-9a-f]{64}$/i.test(pin[key])) {
      throw identityError(`Executor module pin ${key} must be a SHA-256 digest`, "EXECUTOR_MODULE_PIN_INVALID", { key });
    }
  }
  return pin;
}

export function verifyExecutorModuleIdentity(specifier, trustedPin) {
  const pin = requirePin(trustedPin);
  const actual = inspectExecutorModuleIdentity(specifier);
  const comparisons = [
    ["module_path", normalizedIdentityPath(actual.module_path), normalizedIdentityPath(pin.module_path)],
    ["module_sha256", actual.module_sha256, pin.module_sha256],
    ["package_root", normalizedIdentityPath(actual.package_root), normalizedIdentityPath(pin.package_root)],
    ["package_name", actual.package_name, pin.package_name],
    ["package_version", actual.package_version, pin.package_version],
    ["package_json_sha256", actual.package_json_sha256, pin.package_json_sha256],
  ];
  const mismatches = comparisons
    .filter(([, observed, expected]) => observed !== expected)
    .map(([field, observed, expected]) => ({ field, observed, expected }));
  if (mismatches.length) {
    throw identityError("Executor module identity does not match the immutable production pin", "EXECUTOR_MODULE_IDENTITY_MISMATCH", {
      mismatches,
    });
  }
  return actual;
}

export async function importPinnedExecutorModule(specifier, trustedPin) {
  const identity = verifyExecutorModuleIdentity(specifier, trustedPin);
  const imported = await import(pathToFileURL(identity.module_path).href);
  return { imported, identity };
}

export function readExecutorModulePin(pinPath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(pinPath, "utf8"));
  } catch (error) {
    throw identityError("Unable to read Executor module pin", "EXECUTOR_MODULE_PIN_INVALID", {
      pin_path: pinPath,
      message: error.message,
    });
  }
  return requirePin(parsed);
}

export const __test = Object.freeze({
  normalizedIdentityPath,
  modulePathFromSpecifier,
  findPackageJson,
});
