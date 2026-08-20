import { describe, expect, it } from "vitest";
import {
  AP_INTEROP_ASSERTION_VERSION,
  SemanticInteropAssertionSchema,
} from "./SemanticInteropAssertion.js";

function validAssertion() {
  return {
    schemaVersion: AP_INTEROP_ASSERTION_VERSION,
    caseId: "mastodon.follow-accept.roundtrip",
    software: {
      family: "Mastodon",
      version: "fixture-pin",
    },
    direction: "round_trip" as const,
    evidence: {
      entryPoint: "wire_fedify" as const,
      transportAuthentication: "fedify_http_signature" as const,
      actorProvenance: "authenticated" as const,
      actorAuthorityClass: "remote_actor" as const,
      signerPath: "remote_implementation" as const,
      boundariesExecuted: [
        "http_body" as const,
        "wire_authentication" as const,
        "activitystreams_structure" as const,
        "jsonld_semantics" as const,
        "authority_policy" as const,
        "visibility_privacy" as const,
        "target_persistence" as const,
      ],
      implementationEvidence: ["mastodon-postgres-proof"],
    },
    semantic: {
      id: "https://remote.example/activities/1",
      types: ["Accept"],
      actor: "https://remote.example/users/alice",
      attributedTo: [],
      object: "https://local.example/activities/follow-1",
    },
    visibility: {
      class: "direct" as const,
      recipients: ["https://local.example/users/bob"],
      blindRecipientFieldsObserved: [],
    },
    attachments: [],
    extensions: [],
    structuralOutcome: "accepted" as const,
    authorizationOutcome: "accepted" as const,
    persistence: {
      attempted: true,
      persisted: true,
    },
    notes: [],
  };
}

describe("SemanticInteropAssertion", () => {
  it("accepts boundary-scoped real implementation evidence", () => {
    expect(SemanticInteropAssertionSchema.safeParse(validAssertion()).success).toBe(true);
  });

  it("does not accept the overloaded fedify-v2 concept as Fedify wire proof", () => {
    const candidate = validAssertion();
    candidate.evidence.transportAuthentication = "trusted_internal" as any;

    const parsed = SemanticInteropAssertionSchema.safeParse(candidate);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.message.includes("Fedify HTTP-signature"))).toBe(true);
    }
  });

  it("forbids synthetic reconciliation from claiming authenticated remote actor provenance", () => {
    const candidate = validAssertion();
    candidate.evidence.entryPoint = "trusted_synthetic_reconciliation" as any;
    candidate.evidence.transportAuthentication = "trusted_internal" as any;
    candidate.evidence.actorProvenance = "authenticated";

    const parsed = SemanticInteropAssertionSchema.safeParse(candidate);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.message.includes("cannot claim authenticated actor provenance"))).toBe(true);
    }
  });

  it("forbids ActivityPods signing evidence for sidecar service actors", () => {
    const candidate = validAssertion();
    candidate.direction = "outbound";
    candidate.evidence.actorAuthorityClass = "sidecar_service_actor" as any;
    candidate.evidence.signerPath = "activitypods_internal_api" as any;

    const parsed = SemanticInteropAssertionSchema.safeParse(candidate);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.message.includes("ActivityPods pod/user actors"))).toBe(true);
    }
  });

  it("forbids sidecar-local signer evidence for ActivityPods pod actors", () => {
    const candidate = validAssertion();
    candidate.direction = "outbound";
    candidate.evidence.actorAuthorityClass = "activitypods_pod_actor" as any;
    candidate.evidence.signerPath = "sidecar_local_signer" as any;

    const parsed = SemanticInteropAssertionSchema.safeParse(candidate);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.message.includes("sidecar service actors"))).toBe(true);
    }
  });

  it("keeps external delivery privacy separate from native/local persistence privacy", () => {
    const candidate = validAssertion();
    candidate.visibility.nativeLocalBlindFieldsPresent = false;

    const parsed = SemanticInteropAssertionSchema.safeParse(candidate);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.message.includes("native/local privacy"))).toBe(true);
    }
  });

  it("does not allow persistence claims from parser-only evidence", () => {
    const candidate = validAssertion();
    candidate.evidence.entryPoint = "parser_semantic_only" as any;
    candidate.evidence.transportAuthentication = "none" as any;
    candidate.evidence.actorProvenance = "self_claimed" as any;
    candidate.evidence.boundariesExecuted = ["activitystreams_structure", "jsonld_semantics"] as any;

    const parsed = SemanticInteropAssertionSchema.safeParse(candidate);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.message.includes("persistence evidence"))).toBe(true);
    }
  });
});
