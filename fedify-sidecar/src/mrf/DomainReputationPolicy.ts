import { randomUUID } from "node:crypto";
import type { MRFAdminStore } from "../admin/mrf/store.js";
import type { MRFMode } from "../admin/mrf/types.js";
import {
  domainReputationRegistration,
  type DomainReputationConfig,
} from "../admin/mrf/registry/modules/domain-reputation.js";
import type { DomainReputationStore } from "../delivery/DomainReputationStore.js";

export interface DomainReputationInput {
  activityId: string;
  actorUri: string;
  /** Pre-extracted sanitized hostnames from the activity's content URLs. */
  domains: string[];
  originHost?: string;
  visibility?: "public" | "unlisted" | "followers" | "direct" | "unknown";
}

export interface DomainReputationDecision {
  moduleId: "domain-reputation";
  traceId: string;
  mode: MRFMode;
  desiredAction: "label" | "filter" | "reject";
  appliedAction: "accept" | "label" | "filter" | "reject";
  matchedDomain: string;
  reason?: string;
}

export async function evaluateDomainReputation(
  mrfStore: MRFAdminStore | null,
  domainStore: DomainReputationStore | null,
  input: DomainReputationInput,
  options?: {
    now?: () => string;
    requestId?: string;
  },
): Promise<DomainReputationDecision | null> {
  if (!mrfStore || !domainStore) return null;
  if (input.domains.length === 0) return null;

  const moduleConfig = await mrfStore.getModuleConfig("domain-reputation");
  if (!moduleConfig || !moduleConfig.enabled) return null;

  const parsed = domainReputationRegistration.validateAndNormalizeConfig(moduleConfig.config, {
    existingConfig: domainReputationRegistration.getDefaultConfig(),
    partial: true,
  });
  const config = parsed.config as DomainReputationConfig;

  // Check each domain — first match wins.
  let matchedDomain: string | null = null;
  for (const domain of input.domains) {
    if (await domainStore.isDomainBlocked(domain)) {
      matchedDomain = domain;
      break;
    }
  }

  if (!matchedDomain) return null;

  const nowFn = options?.now ?? (() => new Date().toISOString());
  const timestamp = nowFn();
  const requestId = options?.requestId ?? randomUUID();
  const traceId = randomUUID();
  const desiredAction = config.action;
  const appliedAction = moduleConfig.mode === "enforce" ? desiredAction : "accept";
  const reason = config.traceReasons
    ? `Domain reputation: blocked domain "${matchedDomain}" found in activity content`
    : undefined;

  await mrfStore.appendTrace({
    traceId,
    requestId,
    activityId: input.activityId,
    actorId: input.actorUri,
    originHost: input.originHost,
    visibility: input.visibility,
    moduleId: "domain-reputation",
    mode: moduleConfig.mode,
    action: desiredAction,
    reason,
    createdAt: timestamp,
    redacted: false,
  });

  return {
    moduleId: "domain-reputation",
    traceId,
    mode: moduleConfig.mode,
    desiredAction,
    appliedAction,
    matchedDomain,
    reason,
  };
}
