import type { MRFPermission } from "../mrf/types.js";
import type { CanonicalActorRef } from "../../protocol-bridge/canonical/CanonicalActorRef.js";
import type { CanonicalObjectRef } from "../../protocol-bridge/canonical/CanonicalObjectRef.js";
import type { CanonicalReportReasonType, CanonicalReportSubject } from "../../protocol-bridge/canonical/CanonicalIntent.js";

// ---------------------------------------------------------------------------
// Cross-Protocol Moderation Bridge — Types
//
// This module defines the type layer for dashboard-driven moderation decisions
// and their AT Protocol propagation state.
//
// Decision flow:
//   Provider applies decision (Dashboard UI)
//     → (1) Resolve the target into a concrete AT subject when possible
//     → (2) Emit signed AT label for target DID
//     → (3) Optionally: com.atproto.admin.updateSubjectStatus (suspend)
//     → (4) Store decision record (Redis-backed, returned to UI)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Action + Protocol types
// ---------------------------------------------------------------------------

/** The moderation action to apply across both protocols. */
export type ModerationAction =
  | "label"     // Attach an informational AT label
  | "warn"      // AT !warn label
  | "filter"    // AT !hide label
  | "block"     // Full AT !hide label
  | "suspend";  // AT takedown via PDS admin updateSubjectStatus + block label

/** Which protocol(s) the decision was propagated to. */
export type ModerationProtocol = "at" | "ap" | "both" | "none";

/** Mastodon-compatible provider domain block severity. */
export type DomainBlockSeverity = "noop" | "silence" | "suspend";

/** Source of the moderation decision. */
export type ModerationDecisionSource =
  | "provider-dashboard"  // Manual decision via provider UI
  | "mrf-auto"            // Auto-decision from trust-eval / content-policy MRF module
  | "at-firehose";        // Incoming AT label from external labeler subscription

// ---------------------------------------------------------------------------
// AT Protocol label constants (global reserved labels)
// ---------------------------------------------------------------------------

export const AT_GLOBAL_LABELS = [
  "!hide",
  "!warn",
  "!no-unauthenticated",
  "spam",
  "porn",
  "sexual",
  "graphic-media",
  "nudity",
  "bot",
] as const;

export type AtGlobalLabel = (typeof AT_GLOBAL_LABELS)[number];

/** Maps a ModerationAction to the primary AT label value to emit. */
export const ACTION_TO_AT_LABEL: Record<ModerationAction, string> = {
  label:   "!warn",
  warn:    "!warn",
  filter:  "!hide",
  block:   "!hide",
  suspend: "!hide",
};

// ---------------------------------------------------------------------------
// Cross-protocol AT label record (AT Protocol label lexicon)
// ---------------------------------------------------------------------------

/**
 * AT Protocol signed label record.
 *
 * Ref: com.atproto.label.defs#label
 * Spec: https://atproto.com/specs/label
 */
export interface AtLabel {
  /**
   * DID of the labeler service that created this label.
   * Must match the authenticated labeler DID.
   */
  src: string;

  /**
   * Target: DID of an account (account-level label) or full AT-URI
   * (record-level label like at://did:plc:xxx/app.bsky.feed.post/xxxxx).
   */
  uri: string;

  /**
   * Optional CID of the record being labelled (for record-level labels).
   * Omit for account-level labels.
   */
  cid?: string;

  /** Label value — one of the global reserved values or a custom labeler-defined value. */
  val: string;

  /** If true, negates a previously emitted label (removes it). */
  neg?: boolean;

  /** Creation timestamp in ISO 8601 format. */
  cts: string;

  /** Optional expiry timestamp (ISO 8601). After this time the label is considered retracted. */
  exp?: string;

  /**
   * secp256k1 signature over dag-cbor(label without sig field).
   * Omit if labeler signing key is not configured — clients will see an "unsigned" label.
   */
  sig?: Uint8Array | string;
}

// ---------------------------------------------------------------------------
// Cross-protocol moderation decision record
// ---------------------------------------------------------------------------

/**
 * A persisted cross-protocol moderation decision.
 * Stored in Redis and returned to the provider dashboard.
 */
export interface ModerationDecision {
  /** opaque ULID identifier */
  id: string;

  /** Source of the decision */
  source: ModerationDecisionSource;

  /** Target WebID (ActivityPods user), if known */
  targetWebId?: string;

  /** Target ActivityPub actor URI, if known */
  targetActorUri?: string;

  /** Target AT Protocol DID, if known */
  targetAtDid?: string;

  /** Human-readable handle or username (AT handle, AP username, etc.) */
  targetHandle?: string;

  /** Remote server domain for provider-level ActivityPub rules, if targeted. */
  targetDomain?: string;

  /**
   * Mastodon-compatible provider domain severity.  `silence` is implemented as
   * an internal AP filter rule; `suspend` is implemented as AP reject; `noop`
   * records domain metadata without changing delivery.
   */
  domainBlockSeverity?: DomainBlockSeverity;

  /** Mastodon-compatible domain block media rejection flag. */
  rejectMedia?: boolean;

  /** Mastodon-compatible domain block report rejection flag. */
  rejectReports?: boolean;

  /** Provider-private note for the domain decision. */
  privateComment?: string;

  /** Optional public note for the domain decision. */
  publicComment?: string;

  /** Whether public domain displays should be partially censored. */
  obfuscate?: boolean;

  /** Optional moderation case id that triggered this decision. */
  sourceCaseId?: string;

  /** The action applied */
  action: ModerationAction;

  /**
   * AT label values applied.
   * Always includes the primary action label; may include additional custom labels.
   */
  labels: string[];

  /** Human-readable reason for the decision (optional, shown in dashboard) */
  reason?: string;

  /** WebID of the provider actor who applied this decision */
  appliedBy: string;

  /** ISO timestamp when the decision was created */
  appliedAt: string;

  /** Which protocol(s) the decision was propagated to */
  protocols: ModerationProtocol;

  /**
   * Whether a subject-specific ActivityPub moderation rule was applied.
   */
  mrfPatched: boolean;

  /** Whether an AT label record was emitted */
  atLabelEmitted: boolean;

  /** Whether com.atproto.admin.updateSubjectStatus was called (for suspend action) */
  atStatusUpdated: boolean;

  /** Whether the decision has been revoked */
  revoked: boolean;

  /** ISO timestamp if revoked */
  revokedAt?: string;

  /** WebID of the provider actor who revoked this decision */
  revokedBy?: string;
}

// ---------------------------------------------------------------------------
// Inbound moderation case record
// ---------------------------------------------------------------------------

export type ModerationCaseSource = "activitypub-flag" | "local-user-report";
export type ModerationCaseStatus = "open" | "resolved" | "dismissed";
export type ModerationCaseProtocol = "ap" | "activitypods";

export interface ModerationCaseReporter extends CanonicalActorRef {
  webId?: string | null;
}

export interface ModerationCaseRecipient {
  webId?: string | null;
  activityPubActorUri?: string | null;
}

export interface ModerationCaseCanonicalEventState {
  status: "pending" | "published" | "failed";
  canonicalIntentId?: string;
  lastAttemptAt?: string;
  publishedAt?: string;
  lastError?: string;
}

export interface ModerationCaseActivityPubForwardingState {
  status: "pending" | "queued" | "delivered" | "failed" | "skipped";
  canonicalIntentId?: string;
  moderationActorUri?: string;
  activityId?: string;
  outboxIntentId?: string;
  targetActorUri?: string;
  targetInbox?: string;
  targetDomain?: string;
  lastAttemptAt?: string;
  queuedAt?: string;
  deliveredAt?: string;
  lastError?: string;
  skippedReason?: string;
  lastStatusCode?: number;
}

export interface ModerationCaseAtprotoForwardingState {
  status: "pending" | "delivered" | "failed" | "skipped";
  canonicalIntentId?: string;
  serviceDid?: string;
  pdsUrl?: string;
  reporterDid?: string;
  reporterHandle?: string;
  subjectDid?: string;
  subjectAtUri?: string;
  reportId?: number;
  lastAttemptAt?: string;
  deliveredAt?: string;
  lastError?: string;
  skippedReason?: string;
  lastStatusCode?: number;
}

export interface ModerationCaseForwardingState {
  activityPub?: ModerationCaseActivityPubForwardingState | null;
  atproto?: ModerationCaseAtprotoForwardingState | null;
}

/**
 * A stored moderation case, owned by ActivityPods and shared by local user
 * reports plus inbound federated reports.
 */
export interface ModerationCase {
  /** Opaque local identifier (UUID/ULID) */
  id: string;

  /** Source of the case */
  source: ModerationCaseSource;

  /** Protocol or local surface where the case originated */
  protocol: ModerationCaseProtocol;

  /** Remote activity identifier when present */
  activityId?: string;

  /**
   * Internal de-duplication key derived from the verified source actor,
   * reported activity id, and local inbox target.
   */
  dedupeKey: string;

  /** Reporter identity retained for local moderation only. */
  reporter?: ModerationCaseReporter | null;

  /** Local inbox path the report was delivered to (ActivityPub only). */
  inboxPath?: string;

  /** Recipient/local target that received the report (when applicable). */
  recipient?: ModerationCaseRecipient | null;

  /** Structured reason category */
  reasonType: CanonicalReportReasonType;

  /** Free-form reason/content extracted from the report */
  reason?: string;

  /** Whether the reporter requested remote forwarding. */
  requestedForwarding?: {
    remote: boolean;
  } | null;

  /** Client surface metadata for local reports when available. */
  clientContext?: {
    app?: string | null;
    surface?: string | null;
  } | null;

  /** Normalized report subject. */
  subject: CanonicalReportSubject;

  /** Evidence objects attached to the report. */
  evidenceObjectRefs: CanonicalObjectRef[];

  /** Timestamp on the original remote report when present */
  createdAt?: string;

  /** Local receipt timestamp */
  receivedAt: string;

  /** Current moderation workflow status */
  status: ModerationCaseStatus;

  /** Related manual or automated decision ids */
  relatedDecisionIds: string[];

  /**
   * Canonical event publication status for this case.
   * Forwarding to remote moderation systems is tracked separately later.
   */
  canonicalEvent: ModerationCaseCanonicalEventState;

  /** Remote moderation forwarding state by protocol. */
  forwarding?: ModerationCaseForwardingState | null;

  /** Last time the case was updated by a decision or workflow action */
  updatedAt?: string;

  /** Resolution timestamp when the case is no longer open */
  resolvedAt?: string;

  /** Provider actor who resolved or dismissed the case */
  resolvedBy?: string;
}

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

export interface ModerationDecisionQuery {
  limit?: number;
  cursor?: string;
  action?: ModerationAction;
  targetAtDid?: string;
  targetWebId?: string;
  targetActorUri?: string;
  targetDomain?: string;
  domainBlockSeverity?: DomainBlockSeverity;
  includeRevoked?: boolean;
}

export interface ModerationDecisionPage {
  decisions: ModerationDecision[];
  cursor?: string;
}

export interface ModerationCaseQuery {
  limit?: number;
  cursor?: string;
  status?: ModerationCaseStatus;
  source?: ModerationCaseSource;
  sourceActorUri?: string;
  recipientWebId?: string;
  reportedActorUri?: string;
}

export interface ModerationCasePage {
  cases: ModerationCase[];
  cursor?: string;
}

export interface AtLabelQuery {
  limit?: number;
  cursor?: number;
  subject?: string;
}

export interface AtLabelPage {
  labels: AtLabel[];
  cursor: number;
}

export interface ModerationBridgeStore {
  /** Persist a new decision record. Rejects if id already exists. */
  addDecision(decision: ModerationDecision): Promise<void>;

  /** Retrieve a single decision by its ULID. Returns null if not found. */
  getDecision(id: string): Promise<ModerationDecision | null>;

  /** List decisions, newest first. */
  listDecisions(query?: ModerationDecisionQuery): Promise<ModerationDecisionPage>;

  /** Update fields on an existing decision. Returns the updated record or null. */
  patchDecision(id: string, patch: Partial<ModerationDecision>): Promise<ModerationDecision | null>;

  /** Persist a new moderation case. Rejects if id already exists. */
  addCase(entry: ModerationCase): Promise<void>;

  /** Retrieve a single case by its local id. Returns null if not found. */
  getCase(id: string): Promise<ModerationCase | null>;

  /** Retrieve a single case by its internal de-duplication key. */
  findCaseByDedupeKey(dedupeKey: string): Promise<ModerationCase | null>;

  /** List stored moderation cases, newest first. */
  listCases(query?: ModerationCaseQuery): Promise<ModerationCasePage>;

  /** Update fields on an existing case. Returns the updated record or null. */
  patchCase(id: string, patch: Partial<ModerationCase>): Promise<ModerationCase | null>;

  /** Store an emitted AT label record. */
  addAtLabel(label: AtLabel): Promise<void>;

  /** List AT labels, optionally filtered by subject (DID or AT-URI). */
  listAtLabels(query?: AtLabelQuery): Promise<AtLabelPage>;
}

// ---------------------------------------------------------------------------
// AT Label Emitter interface
// ---------------------------------------------------------------------------

export interface AtLabelEmitter {
  /**
   * Emit a new label for the given subject.
   * Signs the label if a signing key is configured.
   * Stores the label in the bridge store.
   */
  emit(params: {
    uri: string;
    cid?: string;
    val: string;
    exp?: string;
    reason?: string;
  }): Promise<AtLabel>;

  /**
   * Negate a previously emitted label (marks it as removed).
   */
  negate(uri: string, val: string): Promise<AtLabel>;
}

// ---------------------------------------------------------------------------
// Dependency injection bundle
// ---------------------------------------------------------------------------

export interface ModerationBridgeDeps {
  /** The shared admin bearer token (same as MRF admin token) */
  adminToken: string;

  /** Redis-backed moderation decision + AT label store */
  store: ModerationBridgeStore;

  /** Reserved hook for future subject-specific ActivityPub moderation integration. */
  mrfInternalFetch(opts: {
    method: string;
    path: string;
    body?: unknown;
    permission: MRFPermission;
    actorWebId?: string;
  }): Promise<Response>;

  /** AT label emitter with signing support */
  labelEmitter: AtLabelEmitter;

  /**
   * Optional AT admin client for account suspension/deactivation.
   * When configured, suspend actions can call updateSubjectStatus.
   */
  updateAtSubjectStatus?(params: {
    did: string;
    reason?: string;
  }): Promise<boolean>;

  /**
   * Resolve the AT DID for a given WebID (from identity binding store).
   * Returns null if no binding exists (user has not linked ATProto account).
   */
  resolveAtDid(webId: string): Promise<string | null>;

  /**
   * Resolve the WebID for a given AT DID (from identity binding store).
   * Returns null if no binding exists or DID belongs to an external user.
   */
  resolveWebId(atDid: string): Promise<string | null>;

  /**
   * Resolve the ActivityPub actor URI for a given WebID.
   * Returns null if no local binding exists.
   */
  resolveActivityPubActorUri(webId: string): Promise<string | null>;

  /**
   * Resolve the WebID for a given ActivityPub actor URI when a local binding
   * exists. Returns null for unbound remote actors.
   */
  resolveWebIdForActorUri(actorUri: string): Promise<string | null>;

  /** Return the current ISO timestamp. */
  now(): string;

  /** Return a new ULID suitable for decision IDs. */
  uuid(): string;

  /** Extract the actor WebID from an incoming internal request. */
  actorFromRequest(req: Request): string;

  /**
   * Verify the incoming request has the required MRF permission.
   * Throws HttpError(403) if not.
   */
  authorize(req: Request, permission: MRFPermission): void;
}
