import { describe, expect, it } from "vitest";
import {
  AP_INTEROP_ASSERTION_VERSION,
  SemanticInteropAssertionSchema,
  type SemanticInteropAssertion,
} from "./SemanticInteropAssertion.js";

function validAssertion(): SemanticInteropAssertion {
  return {
    schemaVersion: AP_INTEROP_ASSERTION_VERSION,
    caseId: "mastodon.follow-accept.roundtrip",
    software: {
      targetId: "mastodon",
      family: "Mastodon",
      version: "v4.5.8",
    },
    direction: "round_trip",
    evidence: {
      entryPoint: "wire_fedify",
      transportAuthentication: "fedify_http_signature",
      actorProvenance: "authenticated",
      actorAuthorityClass: "remote_actor",
      signerPath: "remote_implementation",
      boundariesExecuted: [
        "http_body",
        "wire_authentication",
        "activitystreams_structure",
        "jsonld_semantics",
        "authority_policy",
        "visibility_privacy",
        "target_persistence",
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
      class: "direct",
      recipients: ["https://local.example/users/bob"],
      blindRecipientFieldsObserved: [],
    },
    attachments: [],
    extensions: [],
    structuralOutcome: "accepted",
    authorizationOutcome: "accepted",
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

  it("requires a canonical governed target identity", () => {
    const candidate = validAssertion();
    candidate.software.targetId = "write.as";
    candidate.software.family = "Write.as";

    const parsed = SemanticInteropAssertionSchema.safeParse(candidate);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.message.includes("canonical governed"))).toBe(true);
    }
  });

  it("prevents WriteFreely evidence from being relabeled as Write.as", () => {
    const candidate = validAssertion();
    candidate.software.targetId = "writefreely";
    candidate.software.family = "Write.as";

    const parsed = SemanticInteropAssertionSchema.safeParse(candidate);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.message.includes("family must match governed target"))).toBe(true);
    }
  });

  it("does not accept the overloaded fedify-v2 concept as Fedify wire proof", () => {
    const candidate = validAssertion();
    candidate.evidence.transportAuthentication = "trusted_internal";

    const parsed = SemanticInteropAssertionSchema.safeParse(candidate);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.message.includes("Fedify HTTP-signature"))).toBe(true);
    }
  });

  it("forbids parser-only evidence from claiming authenticated actor provenance", () => {
    const candidate = validAssertion();
    candidate.direction = "semantic_only";
    candidate.evidence.entryPoint = "parser_semantic_only";
    candidate.evidence.transportAuthentication = "benchmark_token";
    candidate.evidence.boundariesExecuted = ["activitystreams_structure", "jsonld_semantics"];
    candidate.authorizationOutcome = "not_executed";
    candidate.persistence = { attempted: false };

    const parsed = SemanticInteropAssertionSchema.safeParse(candidate);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.message.includes("executed compatible wire-authentication"))).toBe(true);
    }
  });

  it("forbids synthetic reconciliation from claiming authenticated remote actor provenance", () => {
    const candidate = validAssertion();
    candidate.evidence.entryPoint = "trusted_synthetic_reconciliation";
    candidate.evidence.transportAuthentication = "trusted_internal";
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
    candidate.evidence.actorAuthorityClass = "sidecar_service_actor";
    candidate.evidence.signerPath = "activitypods_internal_api";

    const parsed = SemanticInteropAssertionSchema.safeParse(candidate);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.message.includes("ActivityPods pod/user actors"))).toBe(true);
    }
  });

  it("forbids sidecar-local signer evidence for ActivityPods pod actors", () => {
    const candidate = validAssertion();
    candidate.direction = "outbound";
    candidate.evidence.actorAuthorityClass = "activitypods_pod_actor";
    candidate.evidence.signerPath = "sidecar_local_signer";

    const parsed = SemanticInteropAssertionSchema.safeParse(candidate);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.message.includes("sidecar service actors"))).toBe(true);
    }
  });

  it("requires authority_policy before reporting an authorization decision", () => {
    const candidate = validAssertion();
    candidate.evidence.boundariesExecuted = candidate.evidence.boundariesExecuted.filter(
      (boundary) => boundary !== "authority_policy",
    );

    const parsed = SemanticInteropAssertionSchema.safeParse(candidate);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.message.includes("authority_policy"))).toBe(true);
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
    candidate.direction = "semantic_only";
    candidate.evidence.entryPoint = "parser_semantic_only";
    candidate.evidence.transportAuthentication = "none";
    candidate.evidence.actorProvenance = "self_claimed";
    candidate.evidence.boundariesExecuted = ["activitystreams_structure", "jsonld_semantics"];
    candidate.authorizationOutcome = "not_executed";

    const parsed = SemanticInteropAssertionSchema.safeParse(candidate);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.message.includes("persistence evidence"))).toBe(true);
    }
  });

  it("rejects every persistence-dependent result when no persistence attempt occurred", () => {
    const candidate = validAssertion();
    candidate.persistence = {
      attempted: false,
      applicationVisible: true,
      idempotentReplayObserved: true,
      targetRepresentation: "row",
    };

    const parsed = SemanticInteropAssertionSchema.safeParse(candidate);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.message.includes("persistence-dependent"))).toBe(true);
    }
  });
});
