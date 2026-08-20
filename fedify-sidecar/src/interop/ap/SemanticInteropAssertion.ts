import { z } from "zod";
import { getInteropTarget } from "./InteropTargetRegistry.js";

export const AP_INTEROP_ASSERTION_VERSION = "ap-interop-semantic-v1" as const;

export const InteropEntryPointSchema = z.enum([
  "wire_fedify",
  "wire_native",
  "trusted_synthetic_reconciliation",
  "trusted_synthetic_backfill",
  "authenticated_benchmark",
  "trusted_activitypods_bridge",
  "parser_semantic_only",
  "target_persistence_probe",
]);

export const TransportAuthenticationSchema = z.enum([
  "fedify_http_signature",
  "native_http_signature",
  "trusted_internal",
  "benchmark_token",
  "none",
]);

export const ActorProvenanceSchema = z.enum([
  "authenticated",
  "origin_bound",
  "self_claimed",
  "absent",
]);

export const ActorAuthorityClassSchema = z.enum([
  "activitypods_pod_actor",
  "sidecar_service_actor",
  "remote_actor",
  "unknown",
  "not_applicable",
]);

export const SignerPathSchema = z.enum([
  "activitypods_internal_api",
  "sidecar_local_signer",
  "remote_implementation",
  "test_only",
  "none",
]);

export const AssertionBoundarySchema = z.enum([
  "http_body",
  "wire_authentication",
  "trusted_handoff",
  "activitystreams_structure",
  "jsonld_semantics",
  "authority_policy",
  "visibility_privacy",
  "external_delivery_plan",
  "native_local_persistence",
  "target_persistence",
  "application_consumption",
]);

export const VisibilityClassSchema = z.enum([
  "public",
  "unlisted",
  "followers",
  "direct",
  "restricted",
  "unknown",
  "not_applicable",
]);

export const ExtensionDispositionSchema = z.enum([
  "supported",
  "preserved_opaque",
  "ignored_bounded",
  "rejected_authority_bearing",
  "not_observed",
]);

export const SemanticOutcomeSchema = z.enum([
  "accepted",
  "rejected",
  "ignored",
  "not_executed",
]);

const SemanticIdentitySchema = z.object({
  id: z.string().min(1).optional(),
  types: z.array(z.string().min(1)).min(1),
  actor: z.string().min(1).optional(),
  attributedTo: z.array(z.string().min(1)).default([]),
  object: z.string().min(1).optional(),
  target: z.string().min(1).optional(),
}).strict();

const AttachmentFactSchema = z.object({
  semanticType: z.string().min(1),
  url: z.string().min(1).optional(),
  mediaType: z.string().min(1).optional(),
  name: z.string().optional(),
}).strict();

const ExtensionFactSchema = z.object({
  namespace: z.string().min(1),
  term: z.string().min(1),
  disposition: ExtensionDispositionSchema,
  semanticValue: z.unknown().optional(),
}).strict();

const EvidenceSchema = z.object({
  entryPoint: InteropEntryPointSchema,
  transportAuthentication: TransportAuthenticationSchema,
  actorProvenance: ActorProvenanceSchema,
  actorAuthorityClass: ActorAuthorityClassSchema,
  signerPath: SignerPathSchema,
  boundariesExecuted: z.array(AssertionBoundarySchema).min(1),
  implementationEvidence: z.array(z.string().min(1)).default([]),
}).strict();

const VisibilitySchema = z.object({
  class: VisibilityClassSchema,
  recipients: z.array(z.string().min(1)).default([]),
  blindRecipientFieldsObserved: z.array(z.enum(["bto", "bcc"])).default([]),
  externalDeliveryBlindFieldsPresent: z.boolean().optional(),
  nativeLocalBlindFieldsPresent: z.boolean().optional(),
}).strict();

const PersistenceSchema = z.object({
  attempted: z.boolean(),
  persisted: z.boolean().optional(),
  idempotentReplayObserved: z.boolean().optional(),
  applicationVisible: z.boolean().optional(),
  targetRepresentation: z.string().min(1).optional(),
}).strict();

export const SemanticInteropAssertionSchema = z.object({
  schemaVersion: z.literal(AP_INTEROP_ASSERTION_VERSION),
  caseId: z.string().min(1).regex(/^[a-z0-9][a-z0-9._-]*$/),
  software: z.object({
    targetId: z.string().min(1),
    family: z.string().min(1),
    version: z.string().min(1),
    implementation: z.string().min(1).optional(),
    sourceRef: z.string().min(1).optional(),
  }).strict(),
  direction: z.enum(["inbound", "outbound", "round_trip", "semantic_only"]),
  evidence: EvidenceSchema,
  semantic: SemanticIdentitySchema,
  visibility: VisibilitySchema,
  attachments: z.array(AttachmentFactSchema).default([]),
  extensions: z.array(ExtensionFactSchema).default([]),
  structuralOutcome: SemanticOutcomeSchema,
  authorizationOutcome: SemanticOutcomeSchema,
  persistence: PersistenceSchema,
  notes: z.array(z.string().min(1)).default([]),
}).strict().superRefine((value, ctx) => {
  const boundarySet = new Set(value.evidence.boundariesExecuted);
  const governedTarget = getInteropTarget(value.software.targetId);

  if (!governedTarget || governedTarget.id !== value.software.targetId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["software", "targetId"],
      message: "software.targetId must be a canonical governed ActivityPub interoperability target id",
    });
  } else if (governedTarget.family !== value.software.family) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["software", "family"],
      message: `software family must match governed target ${governedTarget.id}: ${governedTarget.family}`,
    });
  }

  if (
    value.evidence.entryPoint === "wire_fedify" &&
    value.evidence.transportAuthentication !== "fedify_http_signature"
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidence", "transportAuthentication"],
      message: "wire_fedify evidence requires Fedify HTTP-signature verification",
    });
  }

  if (
    value.evidence.entryPoint === "wire_native" &&
    value.evidence.transportAuthentication !== "native_http_signature"
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidence", "transportAuthentication"],
      message: "wire_native evidence requires native HTTP-signature verification",
    });
  }

  if (
    value.evidence.entryPoint === "trusted_activitypods_bridge" &&
    value.evidence.transportAuthentication !== "trusted_internal"
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidence", "transportAuthentication"],
      message: "trusted ActivityPods bridge evidence requires trusted-internal authentication provenance",
    });
  }

  if (
    (value.evidence.entryPoint === "trusted_synthetic_reconciliation" ||
      value.evidence.entryPoint === "trusted_synthetic_backfill") &&
    value.evidence.actorProvenance === "authenticated"
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidence", "actorProvenance"],
      message: "synthetic reconciliation/backfill cannot claim authenticated actor provenance without a separate verifier boundary",
    });
  }

  if (value.evidence.actorProvenance === "authenticated") {
    const authenticatedWire =
      (value.evidence.entryPoint === "wire_fedify" &&
        value.evidence.transportAuthentication === "fedify_http_signature" &&
        boundarySet.has("wire_authentication")) ||
      (value.evidence.entryPoint === "wire_native" &&
        value.evidence.transportAuthentication === "native_http_signature" &&
        boundarySet.has("wire_authentication"));
    const preservingBridge =
      value.evidence.entryPoint === "trusted_activitypods_bridge" &&
      value.evidence.transportAuthentication === "trusted_internal" &&
      boundarySet.has("trusted_handoff");

    if (!authenticatedWire && !preservingBridge) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence", "actorProvenance"],
        message: "authenticated actor provenance requires an executed compatible wire-authentication boundary or preserving trusted ActivityPods handoff",
      });
    }
  }

  if (
    value.evidence.signerPath === "activitypods_internal_api" &&
    value.evidence.actorAuthorityClass !== "activitypods_pod_actor"
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidence", "actorAuthorityClass"],
      message: "ActivityPods signing API evidence is valid only for ActivityPods pod/user actors",
    });
  }

  if (
    value.evidence.signerPath === "sidecar_local_signer" &&
    value.evidence.actorAuthorityClass !== "sidecar_service_actor"
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidence", "actorAuthorityClass"],
      message: "sidecar-local signing is valid only for explicit sidecar service actors",
    });
  }

  if (value.authorizationOutcome !== "not_executed" && !boundarySet.has("authority_policy")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["authorizationOutcome"],
      message: "authorization outcomes require the authority_policy boundary to execute",
    });
  }

  if (
    value.visibility.externalDeliveryBlindFieldsPresent !== undefined &&
    !boundarySet.has("external_delivery_plan")
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["visibility", "externalDeliveryBlindFieldsPresent"],
      message: "external-delivery privacy may only be asserted when that boundary executed",
    });
  }

  if (
    value.visibility.nativeLocalBlindFieldsPresent !== undefined &&
    !boundarySet.has("native_local_persistence")
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["visibility", "nativeLocalBlindFieldsPresent"],
      message: "native/local privacy may only be asserted when that boundary executed",
    });
  }

  if (value.persistence.attempted && !boundarySet.has("target_persistence") && !boundarySet.has("native_local_persistence")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["persistence", "attempted"],
      message: "persistence evidence requires an executed persistence boundary",
    });
  }

  if (!value.persistence.attempted) {
    const claimedFields = [
      value.persistence.persisted,
      value.persistence.idempotentReplayObserved,
      value.persistence.applicationVisible,
      value.persistence.targetRepresentation,
    ];
    if (claimedFields.some((field) => field !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["persistence"],
        message: "persistence-dependent results cannot be asserted when persistence was not attempted",
      });
    }
  }
});

export type SemanticInteropAssertion = z.infer<typeof SemanticInteropAssertionSchema>;

export function parseSemanticInteropAssertion(input: unknown): SemanticInteropAssertion {
  return SemanticInteropAssertionSchema.parse(input);
}

export function isSemanticInteropAssertion(input: unknown): input is SemanticInteropAssertion {
  return SemanticInteropAssertionSchema.safeParse(input).success;
}
