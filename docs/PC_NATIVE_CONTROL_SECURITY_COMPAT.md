# Final Control security and bridge identity

This candidate starts from `agent/pc-native-control-full-dc@48996268112128a315a91caa0e1060de773a4035` and re-applies the reviewed security identity checks from `agent/pc-native-control-security-compat@b0750f2cc41c898d23dbd0d5a7cb1026f9c51a0d` without importing that divergent branch wholesale.

## Production identity policy

Normal stdio/HTTP runtime uses the statically imported built-in relay provider in `src/native-relay-provider.js`. Its exported identity is `pc.native.relay.executor_bridge.v1` in package `pc-control-plane` version `0.9.0`.

`PC_NATIVE_EXECUTOR_MODULE` is forbidden in production. If it is set, runtime construction fails with `PRODUCTION_EXECUTOR_MODULE_OVERRIDE_FORBIDDEN` before any attacker-controlled module import or provider side effect.

No release-time external module is required for this candidate. The immutable-module verifier is retained solely for explicit in-process tests or future reviewed release-manifest use. It checks canonical module/package paths, module SHA-256, package root, package name/version, and package.json SHA-256 before import. Symlink/junction aliases, path substitution, digest drift, and package/version drift fail before module execution. Windows tests canonicalize the fixture root so inherited parent-directory junctions do not cause false positives.

## Test-only injection

`createConfiguredNativeMcpRuntime({ testConfig: ... })` accepts a bridge factory or a pinned external module only when `testConfig.enabled === true`. Normal CLI entrypoints do not construct or expose this object.

## Execution boundary

The production path is:

`MCP -> NativeControlFacade -> ControlPlane -> HelpPc1Adapter -> built-in native relay provider -> authenticated relay -> device transport -> Executor`

Control/MCP and relay remain transport/translation layers. They do not contain filesystem, process, shell, UI, PDF, search, or Executor side-effect engines.
