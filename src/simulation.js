import { ControlPlane } from "./control-plane.js";
import { FakeExecutorAdapter, FakeVisionObservationAdapter } from "./adapters.js";

export function createSimulationRuntime({ executorScript = [], observationScript = [], idFactory, clock, policy, store } = {}) {
  const executor = new FakeExecutorAdapter({ script: executorScript, dryRun: true });
  const vision = new FakeVisionObservationAdapter({ script: observationScript });
  const controlPlane = new ControlPlane({
    providers: [executor],
    verificationProviders: [vision],
    idFactory,
    clock,
    policy,
    store,
  });
  return { controlPlane, executor, vision };
}
