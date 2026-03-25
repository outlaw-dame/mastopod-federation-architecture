/**
 * V6.5 Phase 7: com.atproto.server.describeServer
 *
 * Returns server capability information without requiring authentication.
 * Allows AT clients to discover what features this PDS supports before
 * attempting to create sessions or write records.
 *
 * This route is read-only and config-driven — no Tier 1 writes.
 *
 * Ref: https://atproto.com/lexicon/com-atproto-server#comatprotoserverdescribeserver
 */

export interface ServerDescribeServerConfig {
  /** Hostname of this PDS, e.g. pods.example */
  hostname: string;
  /** DID of the server itself (optional, if registered) */
  did?: string;
  /** Whether new accounts can be created via this PDS */
  inviteCodeRequired: boolean;
  /** Whether the server accepts account creation at all */
  acceptsNewAccounts: boolean;
  /** Contact email if publicly listed */
  contactEmail?: string;
  /** Links to external resources */
  links?: {
    privacyPolicy?: string;
    termsOfService?: string;
  };
}

export interface ServerDescribeServerResponse {
  /** Hostname of the PDS */
  availableUserDomains: string[];
  /** Server invitation code policy */
  inviteCodeRequired: boolean;
  /** Whether new accounts can be created */
  phoneVerificationRequired: boolean;
  /** Server DID if available */
  did?: string;
  /** Contact information */
  contact?: {
    email?: string;
  };
  /** Links to policies */
  links?: {
    privacyPolicy?: string;
    termsOfService?: string;
  };
}

export class ServerDescribeServerRoute {
  constructor(private readonly config: ServerDescribeServerConfig) {}

  async handle(): Promise<{ headers: Record<string, string>; body: ServerDescribeServerResponse }> {
    const body: ServerDescribeServerResponse = {
      availableUserDomains: [this.config.hostname],
      inviteCodeRequired: this.config.inviteCodeRequired,
      // Phone verification is not used in this deployment
      phoneVerificationRequired: false,
      ...(this.config.did ? { did: this.config.did } : {}),
      ...(this.config.contactEmail
        ? { contact: { email: this.config.contactEmail } }
        : {}),
      ...(this.config.links ? { links: this.config.links } : {}),
    };

    return {
      headers: { 'Content-Type': 'application/json' },
      body,
    };
  }
}
