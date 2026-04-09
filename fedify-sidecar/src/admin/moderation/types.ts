import type { MRFPermission } from "../mrf/types.js";

// ---------------------------------------------------------------------------
// Cross-Protocol Moderation Bridge — Types
//
// This module defines the type layer for bi-directional moderation decisions
// between ActivityPub (via MRF policy) and ATProto (via AT labels / admin ops).
//
// Decision flow:
//   Provider applies decision (Dashboard UI)
//     → (1) PATCH content-policy MRF module (blockedLabels / warnLabels)
//     → (2) Emit signed AT label for target DID (if AT identity is known)
//     → (3) Optionally: com.atproto.admin.updateSubjectStatus (suspend)
//     → (4) Store decision record (Redis-backed, returned to UI)
//
//   AT Firehose label event (AtIngressEventClassifier → bridge)
//     → (1) PATCH content-policy MRF module (adds label to blockedLabels)
//     → (2) Store decision record
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Action + Protocol types
// ---------------------------------------------------------------------------

/** The moderation action to apply across both protocols. */
export type ModerationAction =
  | "label"     // Attach an informational AT label; add to MRF content-policy warnLabels
  | "warn"      // AT !warn label; add to MRF content-policy warnLabels
  | "filter"    // AT !hide label; add to MRF content-policy blockedLabels
  | "block"     // Full AT !hide label; add to MRF blockedLabels; reject incoming AP activity
  | "suspend";  // AT takedown via PDS admin updateSubjectStatus + block label

/** Which protocol(s) the decision was propagated to. */
export type ModerationProtocol = "at" | "ap" | "both" | "none";

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

/** Maps a ModerationAction to the MRF content-policy target array. */
export const ACTION_TO_MRF_FIELD: Record<ModerationAction, "blockedLabels" | "warnLabels" | null> = {
  label:   "warnLabels",
  warn:    "warnLabels",
  filter:  "blockedLabels",
  block:   "blockedLabels",
  suspend: "blockedLabels",
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

  /** Target AT Protocol DID, if known */
  targetAtDid?: string;

  /** Human-readable handle or username (AT handle, AP username, etc.) */
  targetHandle?: string;

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

  /** Whether the MRF content-policy module was updated (blockedLabels / warnLabels) */
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
// Store interface
// ---------------------------------------------------------------------------

export interface ModerationDecisionQuery {
  limit?: number;
  cursor?: string;
  action?: ModerationAction;
  targetAtDid?: string;
  targetWebId?: string;
  includeRevoked?: boolean;
}

export interface ModerationDecisionPage {
  decisions: ModerationDecision[];
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

  /**
   * Fetch function for patching MRF content-policy module.
   * Called with { method, path, body, permission }.
   */
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
