/**
 * SpamEvaluator
 *
 * Unified spam evaluation orchestrator for both ActivityPub and ATProto paths.
 *
 * For ActivityPub activities (evaluateAp):
 *   1. Actor reputation  — new accounts, link density, hashtag flood, etc.
 *   2. Content fingerprint — copy-paste spam across distinct actors.
 *   3. Domain reputation — blocked domains in content URLs.
 *
 * For ATProto posts (evaluateAt):
 *   1. Content fingerprint — same hash algorithm, synthetic activity wrapper.
 *   2. Domain reputation — URLs extracted from ATProto facets.
 *   (Actor reputation is skipped — actor metadata requires expensive external fetches.)
 *
 * Returns the first blocking decision (filter or reject) and stops.
 * Returns null when all checks pass or all checks are disabled.
 *
 * Callers are responsible for building the envelope (buildEnvelopeFromAT) before
 * calling evaluateAt. For evaluateAp, the envelope is built internally from the
 * original activity and actorDocument to avoid double-parsing.
 */

import type { MRFAdminStore } from "../admin/mrf/store.js";
import type { ContentFingerprintStore } from "../delivery/ContentFingerprintGuard.js";
import type { DomainReputationStore } from "../delivery/DomainReputationStore.js";
import type { MRFActivityEnvelope } from "./MRFActivityEnvelope.js";
import { buildEnvelopeFromAP } from "./MRFActivityEnvelope.js";
import { evaluateActorReputation } from "./ActorReputationPolicy.js";
import { evaluateContentFingerprint } from "./ContentFingerprintPolicy.js";
import { evaluateDomainReputation } from "./DomainReputationPolicy.js";

// ---------------------------------------------------------------------------
// Public result type
// ---------------------------------------------------------------------------

export interface SpamDecision {
  moduleId: string;
  traceId: string;
  appliedAction: "accept" | "label" | "filter" | "reject";
  reason?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isBlocking(action: string): boolean {
  return action === "filter" || action === "reject";
}

// Build a minimal synthetic activity so evaluateContentFingerprint can extract
// the content body via extractActivityContent (checks object.content / object.text).
function buildSyntheticActivityForCfp(
  text: string | null,
): Record<string, unknown> {
  if (!text) return {};
  return { object: { content: text } };
}

// ---------------------------------------------------------------------------
// SpamEvaluator
// ---------------------------------------------------------------------------

export class SpamEvaluator {
  constructor(
    private readonly getMrfAdminStore: () => MRFAdminStore | null,
    private readonly contentFingerprintStore: ContentFingerprintStore | null,
    private readonly domainReputationStore: DomainReputationStore | null,
  ) {}

  /**
   * Evaluate an ActivityPub inbound activity.
   * Calls all three evaluators in priority order using the original data structures
   * (no re-parsing) and returns the first blocking decision, or null if clean.
   */
  async evaluateAp(opts: {
    activityId: string;
    actorUri: string;
    actorDocument: Record<string, unknown> | null;
    activity: Record<string, unknown>;
    originHost?: string;
    visibility?: "public" | "unlisted" | "followers" | "direct" | "unknown";
    requestId?: string;
    now?: () => string;
  }): Promise<SpamDecision | null> {
    const {
      activityId,
      actorUri,
      actorDocument,
      activity,
      originHost,
      visibility,
      requestId,
      now,
    } = opts;

    const mrfStore = this.getMrfAdminStore();
    const sharedOpts = { requestId, now };
    const inputMeta = { originHost, visibility };

    // 1. Actor reputation
    const arDecision = await evaluateActorReputation(
      mrfStore,
      { activityId, actorUri, actorDocument, activity, ...inputMeta },
      sharedOpts,
    );
    if (arDecision && isBlocking(arDecision.appliedAction)) {
      return {
        moduleId: arDecision.moduleId,
        traceId: arDecision.traceId,
        appliedAction: arDecision.appliedAction,
        reason: arDecision.reason,
      };
    }

    // 2. Content fingerprint
    if (this.contentFingerprintStore) {
      const cfpDecision = await evaluateContentFingerprint(
        mrfStore,
        this.contentFingerprintStore,
        { activityId, actorUri, activity, ...inputMeta },
        sharedOpts,
      );
      if (cfpDecision && isBlocking(cfpDecision.appliedAction)) {
        return {
          moduleId: cfpDecision.moduleId,
          traceId: cfpDecision.traceId,
          appliedAction: cfpDecision.appliedAction,
          reason: cfpDecision.reason,
        };
      }
    }

    // 3. Domain reputation — build envelope only to extract domains; no actor fetch.
    if (this.domainReputationStore) {
      const envelope = buildEnvelopeFromAP({
        activityId,
        actorUri,
        actorDocument,
        activity,
        visibility,
        requestId,
      });
      const domDecision = await evaluateDomainReputation(
        mrfStore,
        this.domainReputationStore,
        {
          activityId,
          actorUri,
          domains: envelope.content.domains,
          originHost,
          visibility,
        },
        sharedOpts,
      );
      if (domDecision && isBlocking(domDecision.appliedAction)) {
        return {
          moduleId: domDecision.moduleId,
          traceId: domDecision.traceId,
          appliedAction: domDecision.appliedAction,
          reason: domDecision.reason,
        };
      }
    }

    return null;
  }

  /**
   * Evaluate an ATProto post from a pre-built envelope (see buildEnvelopeFromAT).
   * Actor reputation is skipped because AT actor metadata requires external fetches.
   */
  async evaluateAt(
    envelope: MRFActivityEnvelope,
    opts?: { now?: () => string },
  ): Promise<SpamDecision | null> {
    const mrfStore = this.getMrfAdminStore();
    const sharedOpts = { requestId: envelope.requestId, now: opts?.now };

    // 1. Content fingerprint — wrap plain text as synthetic AP object
    if (this.contentFingerprintStore) {
      const syntheticActivity = buildSyntheticActivityForCfp(envelope.content.text);
      const cfpDecision = await evaluateContentFingerprint(
        mrfStore,
        this.contentFingerprintStore,
        {
          activityId: envelope.activityId,
          actorUri: envelope.actorId,
          activity: syntheticActivity,
          originHost: envelope.originHost ?? undefined,
          visibility: envelope.visibility === "unknown" ? undefined : envelope.visibility,
        },
        sharedOpts,
      );
      if (cfpDecision && isBlocking(cfpDecision.appliedAction)) {
        return {
          moduleId: cfpDecision.moduleId,
          traceId: cfpDecision.traceId,
          appliedAction: cfpDecision.appliedAction,
          reason: cfpDecision.reason,
        };
      }
    }

    // 2. Domain reputation
    if (this.domainReputationStore) {
      const domDecision = await evaluateDomainReputation(
        mrfStore,
        this.domainReputationStore,
        {
          activityId: envelope.activityId,
          actorUri: envelope.actorId,
          domains: envelope.content.domains,
          originHost: envelope.originHost ?? undefined,
          visibility: envelope.visibility === "unknown" ? undefined : envelope.visibility,
        },
        sharedOpts,
      );
      if (domDecision && isBlocking(domDecision.appliedAction)) {
        return {
          moduleId: domDecision.moduleId,
          traceId: domDecision.traceId,
          appliedAction: domDecision.appliedAction,
          reason: domDecision.reason,
        };
      }
    }

    return null;
  }
}
