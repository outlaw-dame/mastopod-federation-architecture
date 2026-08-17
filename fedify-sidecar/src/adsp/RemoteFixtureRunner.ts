import type { AdspControlledRemoteScenario } from "./ControlledActivityPubTarget.js";
import {
  assertEmptyControlledTargetSnapshot,
  type AdspControlledTargetFixturePort,
} from "./ControlledTargetFixtureClient.js";
import type {
  AdspRemoteFixtureDurableObserver,
} from "./RemoteFixtureDurableObserver.js";
import type {
  AdspRemoteFixtureHandoffAcceptance,
  AdspRemoteFixtureHandoffClient,
  AdspRemoteFixtureHandoffInput,
} from "./RemoteFixtureHandoffClient.js";
import type { AdspRemoteFixtureReconciliation } from "./RemoteFixtureOutcomeReconciler.js";
import {
  waitForAdspRemoteFixtureSettlement,
  type AdspRemoteSettlementOptions,
} from "./RemoteFixtureSettlement.js";

export interface AdspRemoteFixtureRunInput {
  scenario: AdspControlledRemoteScenario;
  jobId: string;
  handoff: AdspRemoteFixtureHandoffInput;
  transientFailuresBeforeSuccess?: number;
  settlement?: AdspRemoteSettlementOptions;
}

export interface AdspRemoteFixtureRunResult {
  acceptance: AdspRemoteFixtureHandoffAcceptance;
  reconciliation: AdspRemoteFixtureReconciliation;
}

function exactNonEmpty(name: string, value: string): string {
  if (!value || value !== value.trim()) {
    throw new TypeError(`${name} must be a non-empty exact string`);
  }
  return value;
}

export class AdspRemoteFixtureRunner {
  constructor(
    private readonly handoffClient: Pick<AdspRemoteFixtureHandoffClient, "enqueue">,
    private readonly observer: Pick<AdspRemoteFixtureDurableObserver, "captureBaseline" | "observe">,
    private readonly target: AdspControlledTargetFixturePort,
  ) {}

  async run(input: AdspRemoteFixtureRunInput): Promise<AdspRemoteFixtureRunResult> {
    const jobId = exactNonEmpty("jobId", input.jobId);
    const activityId = exactNonEmpty("handoff.activityId", input.handoff.activityId);
    const embeddedActivityId = input.handoff.activity["id"];
    if (embeddedActivityId !== activityId) {
      throw new TypeError("handoff activity.id must exactly match handoff.activityId");
    }

    await this.target.reset();
    const emptyTarget = await this.target.readSnapshot();
    assertEmptyControlledTargetSnapshot(emptyTarget);

    const baseline = await this.observer.captureBaseline();
    const acceptance = await this.handoffClient.enqueue(input.handoff);

    const reconciliation = await waitForAdspRemoteFixtureSettlement({
      observer: this.observer,
      target: this.target,
      expectation: {
        scenario: input.scenario,
        activityId,
        ...(input.transientFailuresBeforeSuccess !== undefined
          ? { transientFailuresBeforeSuccess: input.transientFailuresBeforeSuccess }
          : {}),
      },
      intentId: acceptance.intentId,
      jobId,
      baseline,
      ...(input.settlement ? { options: input.settlement } : {}),
    });

    return { acceptance, reconciliation };
  }
}
