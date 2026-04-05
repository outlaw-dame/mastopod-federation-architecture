import type {
  AccountLinkVerificationStatus,
  IdentityBinding,
} from "../identity/IdentityBinding.js";

export interface LinkVerificationResult {
  status: AccountLinkVerificationStatus;
  actorDocumentVerified: boolean;
  didDocumentVerified: boolean;
  webIdDocumentVerified: boolean;
  errors: string[];
  verifiedAt: string;
}

interface LinkCheckResult {
  matched: boolean;
  contradictory: boolean;
  error?: string;
}

export class AccountLinkVerifier {
  private readonly HTTP_TIMEOUT_MS = 15_000;

  async verifyAccountLink(binding: IdentityBinding): Promise<LinkVerificationResult> {
    const now = new Date().toISOString();

    const actorCheck = await this.verifyActorDocument(binding);
    const didCheck = await this.verifyDidDocument(binding);
    const webIdCheck = await this.verifyWebIdDocument(binding);

    const errors = [actorCheck.error, didCheck.error, webIdCheck.error].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );

    const status = this.resolveStatus(actorCheck, didCheck, webIdCheck, errors);

    return {
      status,
      actorDocumentVerified: actorCheck.matched,
      didDocumentVerified: didCheck.matched,
      webIdDocumentVerified: webIdCheck.matched,
      errors,
      verifiedAt: now,
    };
  }

  isLinkStale(binding: IdentityBinding, maxAgeDays = 30): boolean {
    const records = binding.accountLinks.verificationRecords ?? [];
    if (records.length === 0) {
      return true;
    }

    const latest = records[0];
    if (!latest) {
      return true;
    }

    if (latest.status === "error" || latest.status === "conflict" || latest.status === "unverified") {
      return true;
    }

    const expiresAt = Date.parse(latest.expiresAt);
    if (!Number.isNaN(expiresAt)) {
      return Date.now() > expiresAt;
    }

    const checkedAt = Date.parse(latest.checkedAt);
    if (Number.isNaN(checkedAt)) {
      return true;
    }

    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    return Date.now() - checkedAt > maxAgeMs;
  }

  formatResult(result: LinkVerificationResult): string {
    const parts = [
      `Status: ${result.status}`,
      `Actor: ${result.actorDocumentVerified ? "yes" : "no"}`,
      `DID: ${result.didDocumentVerified ? "yes" : "no"}`,
      `WebID: ${result.webIdDocumentVerified ? "yes" : "no"}`,
    ];

    if (result.errors.length > 0) {
      parts.push(`Errors: ${result.errors.join("; ")}`);
    }

    return parts.join(" | ");
  }

  private resolveStatus(
    actorCheck: LinkCheckResult,
    didCheck: LinkCheckResult,
    webIdCheck: LinkCheckResult,
    errors: string[],
  ): AccountLinkVerificationStatus {
    if (actorCheck.contradictory || didCheck.contradictory || webIdCheck.contradictory) {
      return "conflict";
    }

    if (errors.length > 0) {
      return "error";
    }

    if (actorCheck.matched && didCheck.matched && webIdCheck.matched) {
      return "fresh_verified";
    }

    return "unverified";
  }

  private async verifyActorDocument(binding: IdentityBinding): Promise<LinkCheckResult> {
    const actor = await this.fetchJsonDocument(
      binding.activityPubActorUri,
      "application/activity+json, application/ld+json",
    );

    if (!actor.ok) {
      return { matched: false, contradictory: false, error: actor.error };
    }

    const aliases = this.toStringArray(actor.body["alsoKnownAs"]);
    const matched = aliases.some((alias) => this.matchesDidAlias(alias, binding.atprotoDid));
    const contradictory =
      this.hasExplicitDidReference(aliases) &&
      !matched;

    return {
      matched,
      contradictory,
      error: contradictory
        ? "ActivityPub actor links to a different ATProto identity"
        : undefined,
    };
  }

  private async verifyDidDocument(binding: IdentityBinding): Promise<LinkCheckResult> {
    if (!binding.atprotoDid) {
      return { matched: false, contradictory: false };
    }

    const didDocument = await this.fetchJsonDocument(
      this.resolveDidDocumentUrl(binding.atprotoDid),
      "application/json",
    );

    if (!didDocument.ok) {
      return { matched: false, contradictory: false, error: didDocument.error };
    }

    const documentBody = this.extractDidDocumentBody(didDocument.body);
    const aliases = this.toStringArray(documentBody["alsoKnownAs"]);
    const matched = aliases.some((alias) => alias === binding.activityPubActorUri);
    const contradictory =
      aliases.some((alias) => this.looksLikeHttpUrl(alias) && alias !== binding.activityPubActorUri) &&
      !matched;

    return {
      matched,
      contradictory,
      error: contradictory
        ? "ATProto DID document links to a different ActivityPub actor"
        : undefined,
    };
  }

  private async verifyWebIdDocument(binding: IdentityBinding): Promise<LinkCheckResult> {
    const webIdDocument = await this.fetchJsonDocument(
      binding.webId,
      "application/ld+json, application/json",
    );

    if (!webIdDocument.ok) {
      return { matched: false, contradictory: false, error: webIdDocument.error };
    }

    const sameAs = this.toStringArray(
      webIdDocument.body["sameAs"] ?? webIdDocument.body["schema:sameAs"],
    );
    const hasActivityPubLink = sameAs.some((alias) => alias === binding.activityPubActorUri);
    const hasDidLink = binding.atprotoDid
      ? sameAs.some((alias) => this.matchesDidAlias(alias, binding.atprotoDid))
      : false;
    const contradictory =
      this.hasExplicitDidReference(sameAs) &&
      !hasDidLink;

    return {
      matched: hasActivityPubLink && hasDidLink,
      contradictory,
      error: contradictory
        ? "WebID document links to a different ATProto identity"
        : undefined,
    };
  }

  private async fetchJsonDocument(
    url: string,
    accept: string,
  ): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string }> {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { Accept: accept },
        signal: AbortSignal.timeout(this.HTTP_TIMEOUT_MS),
      });

      if (!response.ok) {
        return { ok: false, error: `Failed to fetch ${url}: HTTP ${response.status}` };
      }

      const body = (await response.json()) as Record<string, unknown>;
      return { ok: true, body };
    } catch (error) {
      return {
        ok: false,
        error: `Failed to fetch ${url}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private extractDidDocumentBody(body: Record<string, unknown>): Record<string, unknown> {
    const operation = body["operation"];
    return operation && typeof operation === "object"
      ? (operation as Record<string, unknown>)
      : body;
  }

  private resolveDidDocumentUrl(did: string): string {
    if (did.startsWith("did:plc:")) {
      return `https://plc.directory/${did}`;
    }

    if (did.startsWith("did:web:")) {
      const segments = did.slice("did:web:".length).split(":").map((segment) => decodeURIComponent(segment));
      const [host, ...pathSegments] = segments;

      if (!host) {
        throw new Error(`Unsupported did:web identifier: ${did}`);
      }

      if (pathSegments.length === 0) {
        return `https://${host}/.well-known/did.json`;
      }

      return `https://${host}/${pathSegments.join("/")}/did.json`;
    }

    throw new Error(`Unsupported DID method for account-link verification: ${did}`);
  }

  private toStringArray(value: unknown): string[] {
    if (typeof value === "string") {
      return [value];
    }

    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === "string");
    }

    return [];
  }

  private matchesDidAlias(alias: string, did: string | null): boolean {
    if (!did) {
      return false;
    }

    return (
      alias === did ||
      alias === `at://${did}` ||
      alias === `https://bsky.app/profile/${did}` ||
      alias.includes(did)
    );
  }

  private hasExplicitDidReference(aliases: string[]): boolean {
    return aliases.some(
      (alias) =>
        alias.startsWith("did:plc:") ||
        alias.startsWith("did:web:") ||
        alias.startsWith("at://did:") ||
        alias.startsWith("https://bsky.app/profile/did:"),
    );
  }

  private looksLikeHttpUrl(value: string): boolean {
    return value.startsWith("http://") || value.startsWith("https://");
  }
}
