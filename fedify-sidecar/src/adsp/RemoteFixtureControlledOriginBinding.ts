import type { AdspControlledRemoteScenario } from "./ControlledActivityPubTarget.js";
import type { AdspActivityPodsOriginEvidence } from "./RemoteFixtureActivityPodsOrigin.js";
import { normalizeAndDedupeOutboundTargets } from "../delivery/outbound-webhook.js";

export function assertActivityPodsOriginMatchesControlledScenario(input: {
  origin: AdspActivityPodsOriginEvidence;
  scenario: AdspControlledRemoteScenario;
  targetStatsUrl: string;
}): void {
  const statsUrl = new URL(input.targetStatsUrl);
  const expectedActor = new URL(`/actor/${input.scenario}`, statsUrl.origin).toString();
  const expectedInbox = new URL(`/inbox/${input.scenario}`, statsUrl.origin).toString();

  if (input.origin.remoteActorUri !== expectedActor) {
    throw new Error(
      `ActivityPods origin actor ${input.origin.remoteActorUri} does not match controlled scenario actor ${expectedActor}`,
    );
  }

  const normalized = normalizeAndDedupeOutboundTargets(
    [{
      inboxUrl: input.origin.inboxUrl,
      ...(input.origin.sharedInboxUrl ? { sharedInboxUrl: input.origin.sharedInboxUrl } : {}),
    }],
    { maxTargetsPerRequest: 1 },
  );
  const target = normalized.targets[0];
  if (!target || normalized.targets.length !== 1 || target.deliveryUrl !== expectedInbox) {
    throw new Error(
      `ActivityPods origin delivery target does not match controlled scenario inbox ${expectedInbox}`,
    );
  }
}
