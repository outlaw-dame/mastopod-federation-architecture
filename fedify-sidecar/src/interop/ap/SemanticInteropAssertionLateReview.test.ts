import { describe, expect, it } from "vitest";
import {
  AP_INTEROP_ASSERTION_VERSION,
  SemanticInteropAssertionSchema,
  type SemanticInteropAssertion,
} from "./SemanticInteropAssertion.js";

function validAssertion(): SemanticInteropAssertion {
  return {
    schemaVersion: AP_INTEROP_ASSERTION_VERSION,
    caseId: "mastodon.note.inbound",
    software: {
      targetId: "mastodon",
      family: "Mastodon",
      version: "v4.5.8",
    },
    direction: "inbound",
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
      implementationEvidence: ["wire-proof"],
    },
    semantic: {
      id: "https://mastodon/activities/1",
      types: ["Create"],
      actor: "https://mastodon/users/alice",
      attributedTo: ["https://mastodon/users/alice"],
      object: "https://mastodon/objects/1",
    },
    visibility: {
      class: "public",
      recipients: ["https://www.w3.org/ns/activitystreams#Public"],
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

describe("SemanticInteropAssertion late-review boundaries", () => {
  it("requires visibility_privacy for a concrete visibility class", () => {
    const candidate = validAssertion();
    candidate.evidence.boundariesExecuted = candidate.evidence.boundariesExecuted.filter(
      (boundary) => boundary !== "visibility_privacy",
    );
    candidate.visibility.recipients = [];

    const parsed = SemanticInteropAssertionSchema.safeParse(candidate);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.message.includes("visibility_privacy"))).toBe(true);
    }
  });

  it("requires visibility_privacy for recipient evidence even when class is unknown", () => {
    const candidate = validAssertion();
    candidate.evidence.boundariesExecuted = candidate.evidence.boundariesExecuted.filter(
      (boundary) => boundary !== "visibility_privacy",
    );
    candidate.visibility.class = "unknown";

    const parsed = SemanticInteropAssertionSchema.safeParse(candidate);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.message.includes("recipient evidence"))).toBe(true);
    }
  });

  it("permits unknown visibility with no recipient claims below the privacy boundary", () => {
    const candidate = validAssertion();
    candidate.evidence.boundariesExecuted = candidate.evidence.boundariesExecuted.filter(
      (boundary) => boundary !== "visibility_privacy",
    );
    candidate.visibility = {
      class: "unknown",
      recipients: [],
      blindRecipientFieldsObserved: [],
    };

    expect(SemanticInteropAssertionSchema.safeParse(candidate).success).toBe(true);
  });

  it("requires jsonld_semantics for normalized semantic facts", () => {
    const candidate = validAssertion();
    candidate.evidence.boundariesExecuted = candidate.evidence.boundariesExecuted.filter(
      (boundary) => boundary !== "jsonld_semantics",
    );

    const parsed = SemanticInteropAssertionSchema.safeParse(candidate);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.message.includes("jsonld_semantics"))).toBe(true);
    }
  });

  it("rejects Fedify signature claims outside the wire_fedify entry point", () => {
    const candidate = validAssertion();
    candidate.evidence.entryPoint = "parser_semantic_only";
    candidate.evidence.actorProvenance = "self_claimed";

    const parsed = SemanticInteropAssertionSchema.safeParse(candidate);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.message.includes("wire_fedify"))).toBe(true);
    }
  });

  it("rejects native signature claims outside the wire_native entry point", () => {
    const candidate = validAssertion();
    candidate.evidence.entryPoint = "target_persistence_probe";
    candidate.evidence.transportAuthentication = "native_http_signature";
    candidate.evidence.actorProvenance = "self_claimed";

    const parsed = SemanticInteropAssertionSchema.safeParse(candidate);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.message.includes("wire_native"))).toBe(true);
    }
  });
});
