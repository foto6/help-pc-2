export {
  R28_HEALTH_V1,
  R28_FRESHNESS_GATE_V1,
  R28_PRODUCER_PIN,
  validateR28HealthSnapshot,
  evaluateR28RelayFreshness,
} from "./r28-relay-freshness-gate.js";

export {
  R27_CUTOVER_AUTHORITY_V1,
  R27_COORDINATOR_HANDOFF_V1,
  R27_DECISIONS,
  R27_AUTHORITIES,
  R27CutoverAuthorityError,
  validateBridgeR23AuthorityPin,
  loadBridgeR23AuthorityPin,
  evaluateR27CutoverAuthority,
  buildR27CoordinatorHandoff,
} from "./r27-cutover-authority-gate.js";

export { ControlPlane, ControlPlaneError } from "./control-plane.js";
export {
  R26_PROGRESS_V1,
  R26_LIVENESS_V1,
  R26_CONSUMER_V1,
  R26_PIN_V1,
  R26_PRODUCER_PIN,
  R26RelayProgressConsumerError,
  R26RelayProgressConsumer,
  validateR26ProducerPin,
  validateVendoredR26Artifacts,
  validateR26Progress,
  validateR26Liveness,
} from "./r26-relay-progress-consumer.js";

export {
  R24_RUNTIME_HEALTH_V1,
  R25_R24_CONSUMER_V1,
  R25_R24_PIN_V1,
  R24_PRODUCER_PIN,
  R24RuntimeHealthConsumerError,
  R24RuntimeHealthConsumer,
  validateR24ProducerPin,
  validateVendoredR24Artifacts,
  validateR24RuntimeHealthEnvelope,
} from "./r24-runtime-health-consumer.js";

export {
  R23_HEALTH_V1,
  R23_LIFECYCLE_V1,
  R23_LAUNCHER_LIVENESS_V1,
  R23_LIFECYCLE_STATES,
  R23_DEFAULT_ADAPTER_TIMEOUTS,
  R23AdapterCircuitRegistry,
  R23HealthSupervisor,
  adapterNameForAction,
  projectActionLifecycle,
  launcherLivenessDecision,
} from "./r23-health.js";
export {
  ProviderRegistry,
  VerificationRegistry,
  FunctionProvider,
  FunctionVerificationProvider,
  HelpPc1Adapter,
  Vision2Adapter,
  FakeExecutorAdapter,
  FakeVisionObservationAdapter,
  normalizeExecutorOutcomeEvidence,
} from "./adapters.js";
export { createRpcHandler, mcpToolDefinitions, RPC_METHODS } from "./api.js";
export { actionSpecSchema, validateActionSpec, ValidationError, ACTION_STATUSES } from "./schemas.js";
export { JsonStateStore, JsonlAuditTimeline, StateCorruptionError, redactMetadata } from "./persistence.js";
export { RuntimeMetrics } from "./metrics.js";
export { createSimulationRuntime } from "./simulation.js";
export {
  NATIVE_CONTROL_PROTOCOL_V1,
  NATIVE_TOOL_REGISTRY_V1,
  NATIVE_RESPONSE_V1,
  DEFAULT_NATIVE_LIMITS,
  TOOL_REGISTRY,
  TOOL_REGISTRY_LIST,
  TOOL_REGISTRY_DIGEST,
  nativeCapabilityManifestV1,
  assertCapabilityNegotiation,
  toolDefinition,
} from "./native-registry.js";
export {
  NativeControlFacade,
  NativeFacadeError,
  JsonFacadeStateStore,
  responseEnvelope,
  errorEnvelope,
} from "./native-facade.js";
export { LocalNativeHttpTransport } from "./native-http.js";
export {
  DC_COMPATIBILITY_REGISTRY_V1,
  DC_COMPATIBILITY_RESPONSE_V1,
  DESKTOP_COMMANDER_REFERENCE_VERSION,
  DC_VENDOR_NON_EQUIVALENTS,
  DC_COMPATIBILITY_REGISTRY,
  DC_COMPATIBILITY_REGISTRY_LIST,
  DC_COMPATIBILITY_REGISTRY_DIGEST,
  desktopCommanderToolDefinition,
  desktopCommanderCompatibilityManifestV1,
} from "./dc-compatibility-registry.js";
export {
  DesktopCommanderCompatibilitySurface,
  DcCompatibilityError,
  JsonDcCompatibilityStore,
  normalizeDesktopCommanderError,
} from "./dc-compatibility.js";
export {
  EXECUTOR_OUTCOME_V1,
  EXECUTOR_OUTCOME_JOURNAL_RECORD_V1,
  EXECUTOR_OUTCOME_JOURNAL_LOOKUP_V1,
  EXECUTOR_CAPABILITIES_V1,
  EXECUTOR_ACTION_PREFLIGHT_V1,
  VISION_VERIFICATION_INPUT_V1,
  VISION_VERIFICATION_RESULT_V1,
  VISION_PERCEPTION_SNAPSHOT_V2,
  ConformanceValidationError,
  canonicalJson,
  canonicalSha256,
  gitBlobSha1,
  parseExecutorActionOutcomeV1,
  adaptExecutorActionOutcomeV1,
  executorJournalExecutionId,
  parseExecutorOutcomeJournalLookupV1,
  adaptExecutorOutcomeJournalLookupV1,
  parseExecutorCapabilitiesV1,
  adaptExecutorCapabilitiesV1,
  buildExecutorActionPreflightRequestV1,
  parseExecutorActionPreflightRequestV1,
  parseExecutorActionPreflightResultV1,
  adaptExecutorActionPreflightResultV1,
  parseVisionVerificationInputV1,
  parseVisionVerificationResultV1,
  VisionVerificationResultV1Adapter,
} from "./conformance.js";

export {
  VISION_SEMANTIC_UI_DELTA_V1,
  VISION_OBSERVATION_CONSISTENCY_V1,
  parseVisionSemanticUiDeltaV1,
  parseVisionObservationConsistencyV1,
  VisionSensorReconciliationAdapter,
} from "./sensor-reconciliation.js";

export {
  EXECUTOR_EXECUTION_CONTEXT_BINDING_V1,
  EXECUTOR_EXECUTION_CONTEXT_VALIDATION_V1,
  VISION_OBSERVATION_EPOCH_V1,
  VISION_TARGET_LIVENESS_V1,
  parseExecutorExecutionContextBindingV1,
  parseExecutorExecutionContextValidationV1,
  parseVisionObservationEpochV1,
  parseVisionTargetLivenessV1,
  validateVisionTargetLivenessV1,
} from "./context-epoch.js";

export {
  MCP_HOST_VERSION,
  MCP_MODERN_PROTOCOL,
  NativeMcpRuntime,
  nativeMcpServerFactory,
} from "./mcp-host.js";
export {
  MCP_TOOL_SCHEMAS,
  MCP_TOOL_DESCRIPTIONS,
  MCP_COMPATIBILITY_TOOL_SCHEMAS,
  MCP_COMPATIBILITY_TOOL_DESCRIPTIONS,
  mcpToolSchema,
  mcpToolDescription,
  mcpCompatibilityToolSchema,
  mcpCompatibilityToolDescription,
} from "./mcp-tool-schemas.js";
export { startNativeMcpHttpServer, isLoopbackHost as isMcpLoopbackHost } from "./mcp-http-host.js";
export { createConfiguredNativeMcpRuntime, PRODUCTION_BRIDGE_CONTRACT } from "./mcp-runtime-config.js";

export {
  REMOTE_FRAME_VERSION,
  DEFAULT_RELAY_LIMITS,
  REMOTE_FRAME_TYPES,
  RelayProtocolError,
  RelayAuthenticationError,
  RelayReplayError,
  RelayStaleEpochError,
  ReplayGuard,
  StreamAssembler,
  canonicalJson as canonicalRelayJson,
  sha256Hex as relaySha256Hex,
  digestJson as relayDigestJson,
  encodeRelayFrame,
  decodeRelayFrame,
  parseRelayEnvelope,
  validateRequestPayload,
  requestFingerprint,
  assertHelloPayload,
} from "./native-relay-protocol.js";
export { JsonRelayStateStore, NativeRelayState, RelayStateError } from "./native-relay-state.js";
export { NativeRelayServer, NativeRelayServerError } from "./native-relay-server.js";

export {
  NATIVE_RELAY_PROVIDER_IDENTITY,
  NativeRelayProviderError,
  NativeRelayExecutorProvider,
  createNativeRelayExecutorBridge,
  createExecutorBridge as createNativeRelayExecutorBridgeModule,
} from "./native-relay-provider.js";
export {
  EXECUTOR_MODULE_PIN_V1,
  inspectExecutorModuleIdentity,
  verifyExecutorModuleIdentity,
  importPinnedExecutorModule,
  readExecutorModulePin,
} from "./executor-module-identity.js";
