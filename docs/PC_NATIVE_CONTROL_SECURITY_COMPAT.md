# Control security and full Desktop Commander compatibility

This branch starts exactly from the green control/MCP full-stack head `8d210bb684964e633d1d1a91c249aa0515f7a140`.

## Security closure

Production Executor bridge loading now uses a fixed immutable identity-pin contract before dynamic import. The trusted identity includes canonical module and package paths, module/package-manifest SHA-256 values, package name, and package version. Local module substitution, alias/symlink/junction drift, package/version drift, and digest drift fail closed before bridge code executes.

The checked-in production pin is intentionally unconfigured. Release packaging must install the reviewed exact identity; a source checkout cannot silently promote an arbitrary `PC_NATIVE_EXECUTOR_MODULE`.

Tests retain an explicit in-process injection seam behind `testConfig.enabled=true`. Production stdio and HTTP entrypoints do not expose or enable that seam.

## Compatibility closure

The compatibility registry now models the 28 non-vendor tools in the installed Desktop Commander surface. Existing supported actions bind immediately; not-yet-published PC-Core actions remain registered but advertise unavailable until the Executor capability manifest supplies the required action.

`write_pdf` is included with a strict compatibility schema and fixed `fs.write_pdf` native binding, but remains unavailable unless that action is advertised.

`get_prompts` and `give_feedback_to_desktop_commander` are intentionally excluded because they are Desktop Commander vendor-service functions rather than native PC-control operations.

All compatibility execution remains `MCP -> DesktopCommanderCompatibilitySurface -> NativeControlFacade -> ControlPlane -> provider`. No filesystem, process, shell, search, PDF, or UI side-effect implementation exists in this compatibility layer.

## Verification expectations

The branch-specific CI matrix runs on Ubuntu and Windows and executes the official MCP integration/security tests, native facade tests, compatibility tests, focused conformance gates, and the complete repository suite.

The implementation and tests use temporary C-drive paths only and do not access the protected root.
