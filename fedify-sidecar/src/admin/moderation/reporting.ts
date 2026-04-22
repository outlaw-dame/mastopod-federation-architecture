import type { CanonicalActorRef } from "../../protocol-bridge/canonical/CanonicalActorRef.js";
import type { CanonicalObjectRef } from "../../protocol-bridge/canonical/CanonicalObjectRef.js";
import type {
  CanonicalReportCreateIntent,
  CanonicalReportReasonType,
  CanonicalReportSubject,
} from "../../protocol-bridge/canonical/CanonicalIntent.js";
import { buildCanonicalIntentId } from "../../protocol-bridge/idempotency/CanonicalIntentIdBuilder.js";

export interface CanonicalReportCreateDraft {
  sourceProtocol: "activitypub" | "activitypods";
  sourceEventId: string;
  sourceAccountRef: CanonicalActorRef;
  reporterWebId?: string | null;
  subject: CanonicalReportSubject;
  reasonType: CanonicalReportReasonType;
  reason?: string | null;
  evidenceObjectRefs?: CanonicalObjectRef[];
  requestedForwarding?: {
    remote: boolean;
  } | null;
  clientContext?: {
    app?: string | null;
    surface?: string | null;
  } | null;
  createdAt: string;
  observedAt: string;
}

export function createCanonicalReportCreateIntent(
  draft: CanonicalReportCreateDraft,
): CanonicalReportCreateIntent {
  const intentWithoutId = {
    kind: "ReportCreate" as const,
    sourceProtocol: draft.sourceProtocol,
    sourceEventId: draft.sourceEventId,
    sourceAccountRef: draft.sourceAccountRef,
    reporterWebId: draft.reporterWebId ?? null,
    subject: draft.subject,
    reasonType: draft.reasonType,
    reason: draft.reason ?? null,
    evidenceObjectRefs: draft.evidenceObjectRefs ?? [],
    requestedForwarding: draft.requestedForwarding ?? null,
    clientContext: draft.clientContext ?? null,
    createdAt: draft.createdAt,
    observedAt: draft.observedAt,
    visibility: "direct" as const,
    provenance: {
      originProtocol: draft.sourceProtocol,
      originEventId: draft.sourceEventId,
      originAccountId:
        draft.sourceAccountRef.canonicalAccountId ??
        draft.reporterWebId ??
        draft.sourceAccountRef.webId ??
        null,
      projectionMode: "native" as const,
    },
    warnings: [],
  };

  return {
    ...intentWithoutId,
    canonicalIntentId: buildCanonicalIntentId(intentWithoutId),
  };
}
