# Final Control/MCP + relay candidate provenance

This candidate is assembled manually from reviewed component deltas; divergent histories are not merged wholesale.

- primary base: `foto6/help-pc-2 agent/pc-native-control-full-dc@48996268112128a315a91caa0e1060de773a4035`, exact-head CI `36348011914` SUCCESS at branch creation;
- security identity source: `agent/pc-native-control-security-compat@b0750f2cc41c898d23dbd0d5a7cb1026f9c51a0d`, CI `36347403523` SUCCESS;
- relay-provider source: `agent/pc-native-control-relay-provider@3b5ff0cc0d3ecc7e39b8e3b888b53fc496c1ff21`, CI `36346843375` SUCCESS;
- external WebBridge identity floor: `bc51edd4a3a32f069796dc39812a5a32965314f2`; this repository does not modify it;
- current PC compatibility evidence: `foto6/help-pc-1@b62da531ac045c2ccd3b4c6b82da7bb55cb93b8c`, `tests/fixtures/native_tool_parity_v1/desktop_commander_mapping.json`, Git blob `65fadbe9c9291342c3e4e1574375581b26dc9683`;
- relay wire source: `foto6/help-pc-1@b62da531ac045c2ccd3b4c6b82da7bb55cb93b8c`, `src/pc_remote_transport/protocol.py`, blob `648d741d11c74d03b2f37039286ce23dc4b8d158`.

The final PC release SHA remains intentionally dynamic until the coordinator supplies the final green producer pin. Current contract evidence must not be misrepresented as the release pin.

The Desktop Commander compatibility registry contains 28 non-vendor tools. The only explicit vendor non-equivalents are `get_prompts` and `give_feedback_to_desktop_commander`.

Production runtime uses the built-in native relay provider and rejects `PC_NATIVE_EXECUTOR_MODULE`. Provider tokens are supplied only as environment/in-process secrets for the Authorization header; no token-bearing CLI argument, status field, identity object, or error surface is implemented.
