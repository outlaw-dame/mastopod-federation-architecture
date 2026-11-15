export type EntrywayProtocolSet = {
  solid: boolean;
  activitypub: boolean;
  atproto: boolean;
};

export type EntrywayDidMethod = "did:plc" | "did:web";

export type EntrywayAccountStatus =
  | "provisioning"
  | "active"
  | "awaiting_consent"
  // Partial provider side effects cannot be safely recreated without
  // an authoritative reconciliation of the original signup operation.
  | "reconciliation_required"
  | "migrating"
  | "suspended"
  | "failed";

export type EntrywayProvisioningPhase =
  | "PENDING"
  | "USERNAME_RESERVED"
  | "PROVIDER_SELECTED"
  | "POD_ACCOUNT_CREATED"
  | "WEBID_DISCOVERED"
  | "ACTOR_VALIDATED"
  | "APP_BOOTSTRAP_READY"
  | "AWAITING_APP_CONSENT"
  | "RECONCILIATION_REQUIRED"
  | "SESSION_READY"
  | "ACTIVE"
  | "FAILED";

export interface EntrywayProfileInput {
  displayName: string;
  summary?: string;
}

export interface EntrywayAtprotoInput {
  enabled?: boolean;
  handle?: string;
  didMethod?: EntrywayDidMethod;
}

export interface EntrywayAccountCreateInput {
  username: string;
  email?: string;
  password: string;
  profile: EntrywayProfileInput;
  protocols?: {
    solid?: boolean;
    activitypub?: boolean;
    atproto?: boolean | EntrywayAtprotoInput;
  };
  providerId?: string;
  appClientId?: string;
  redirectUri?: string;
  verification?: Record<string, unknown>;
  idempotencyKey: string;
}

/**
 * Server-to-server resumption of an existing consent-pending signup.
 * Never contains a password, verification token, OIDC bearer or browser URL.
 */
export interface EntrywayConsentResumeInput {
  username: string;
  appClientId: string;
  idempotencyKey: string;
}

export interface EntrywayProviderDefinition {
  providerId: string;
  baseUrl: string;
  provisioningBearerToken: string;
  appClientId: string;
  origin?: string;
  redirectUri?: string;
  enabled?: boolean;
  appBootstrapPath?: string;
  appBootstrapEnabled?: boolean;
  // Operator-pinned URL to the provider's authenticated native SAI UI.
  // Not a caller-supplied callback or an untrusted provider error redirect.
  saiAuthorizationUrl?: string;
  // Exact provider-approved SAI application URI; may differ from appClientId.
  saiAppUri?: string;
}

export interface EntrywayProviderSelectionInput {
  providerId?: string;
  username: string;
  protocols: EntrywayProtocolSet;
}

export interface EntrywayBundleCheck {
  name: string;
  status: "passed" | "failed" | "warning";
  checkedAt: string;
  message?: string;
  retryable?: boolean;
}

export interface EntrywayProvisioningSnapshot {
  phase: EntrywayProvisioningPhase;
  attempts: number;
  // Rotated whenever a new worker wins ownership of a provisioning attempt.
  fenceToken?: string;
  idempotencyKeyHash: string;
  requestFingerprint: string;
  checks: EntrywayBundleCheck[];
  lastErrorCode?: string;
  lastErrorMessage?: string;
  lastAttemptAt?: string;
  completedAt?: string;
}

export interface EntrywaySessionHandoff {
  type: "redirect" | "handoff";
  url?: string;
  handoffId?: string;
  expiresAt?: string;
}

export interface EntrywayAppBootstrapSnapshot {
  status: "not_configured" | "awaiting_consent" | "ready" | "failed";
  appClientId: string;
  appRegistrationUri?: string;
  accessGrantUris: string[];
  bootstrappedAt?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
}

export interface AccountRoute {
  accountId: string;
  // Monotonic CAS revision; absent on pre-migration routes (treated as zero).
  revision?: number;
  canonicalAccountId?: string;
  username: string;
  handle: string;
  webId: string;
  actorId: string;
  inbox?: string;
  outbox?: string;
  followers?: string;
  following?: string;
  publicKeyOwner?: string;
  podStorageUrl: string;
  providerId: string;
  providerBaseUrl: string;
  oidcIssuer: string;
  atprotoDid?: string;
  atprotoHandle?: string;
  appBootstrap?: EntrywayAppBootstrapSnapshot;
  status: EntrywayAccountStatus;
  provisioning: EntrywayProvisioningSnapshot;
  createdAt: string;
  updatedAt: string;
}

export interface AccountRouteReservationInput {
  accountId: string;
  username: string;
  idempotencyKeyHash: string;
  requestFingerprint: string;
  route: AccountRoute;
}

export type AccountRouteReservationResult =
  | { kind: "created"; route: AccountRoute }
  | { kind: "replayed"; route: AccountRoute }
  | { kind: "username_taken"; route: AccountRoute }
  | { kind: "idempotency_conflict"; route?: AccountRoute };

export interface AccountRouteStore {
  reserve(input: AccountRouteReservationInput): Promise<AccountRouteReservationResult>;
  getByAccountId(accountId: string): Promise<AccountRoute | null>;
  getByUsername(username: string): Promise<AccountRoute | null>;
  // No read/modify/write update may bypass this atomic version/fence check.
  compareAndSet(expected: AccountRoute, next: AccountRoute): Promise<boolean>;
  listStaleProvisioning(beforeIso: string, limit: number): Promise<AccountRoute[]>;
}

export interface EntrywayBundleVerificationResult {
  passed: boolean;
  checks: EntrywayBundleCheck[];
  routeUpdates: Partial<AccountRoute>;
}

export interface EntrywayProvisioningResult {
  route: AccountRoute;
  replayed: boolean;
  sessionHandoff?: EntrywaySessionHandoff;
}
