import { withNormalizedAttributionDomains } from "../../utils/authorAttribution.js";

export function withActorAuthorAttributionProperties(
  payload: unknown,
  sourceActor: unknown,
): string {
  return withNormalizedAttributionDomains(payload, sourceActor);
}
