import type { ModuleRegistration } from "./types.js";
import { trustEvalRegistration } from "./modules/trust-eval.js";
import { spamFilterRegistration } from "./modules/spam-filter.js";
import { contentPolicyRegistration } from "./modules/content-policy.js";
import { mediaPolicyRegistration } from "./modules/media-policy.js";
import { activityPubSubjectPolicyRegistration } from "./modules/activitypub-subject-policy.js";
import { actorReputationRegistration } from "./modules/actor-reputation.js";
import { contentFingerprintRegistration } from "./modules/content-fingerprint.js";
import { domainReputationRegistration } from "./modules/domain-reputation.js";
import { keywordFilterRegistration } from "./modules/keyword-filter.js";

export * from "./types.js";
export * from "./descriptor.js";

const registrations = new Map<string, ModuleRegistration<Record<string, unknown>>>([
  [
    trustEvalRegistration.manifest.id,
    trustEvalRegistration as unknown as ModuleRegistration<Record<string, unknown>>,
  ],
  [
    spamFilterRegistration.manifest.id,
    spamFilterRegistration as unknown as ModuleRegistration<Record<string, unknown>>,
  ],
  [
    contentPolicyRegistration.manifest.id,
    contentPolicyRegistration as unknown as ModuleRegistration<Record<string, unknown>>,
  ],
  [
    mediaPolicyRegistration.manifest.id,
    mediaPolicyRegistration as unknown as ModuleRegistration<Record<string, unknown>>,
  ],
  [
    activityPubSubjectPolicyRegistration.manifest.id,
    activityPubSubjectPolicyRegistration as unknown as ModuleRegistration<Record<string, unknown>>,
  ],
  [
    actorReputationRegistration.manifest.id,
    actorReputationRegistration as unknown as ModuleRegistration<Record<string, unknown>>,
  ],
  [
    contentFingerprintRegistration.manifest.id,
    contentFingerprintRegistration as unknown as ModuleRegistration<Record<string, unknown>>,
  ],
  [
    domainReputationRegistration.manifest.id,
    domainReputationRegistration as unknown as ModuleRegistration<Record<string, unknown>>,
  ],
  [
    keywordFilterRegistration.manifest.id,
    keywordFilterRegistration as unknown as ModuleRegistration<Record<string, unknown>>,
  ],
]);

export function listRegistrations(): ModuleRegistration<Record<string, unknown>>[] {
  return [...registrations.values()];
}

export function getRegistration(moduleId: string): ModuleRegistration<Record<string, unknown>> | null {
  return registrations.get(moduleId) || null;
}
