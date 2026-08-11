# APDM Phase 3 post-merge hardening

Phase 3 established `ap.delivery-plan.v1` and the authoritative recipient-planning boundary. This follow-up tightens semantic invariants discovered during a Codex-level post-merge review.

## Hardened invariants

A structurally valid JSON object is not sufficient. Producer and consumer validation now require:

- `intentId` is the canonical `apdm-v1-<sha256>` value derived from `activityId`, `actorUri`, and the unique sorted local/remote actor URI sets;
- the embedded Activity ID and actor match the Delivery Plan envelope;
- `meta.visibility` is derived from normalized ActivityPub `to`/`cc` addressing, including object-valued `id` / `@id` references;
- `meta.isPublicActivity` agrees with visibility;
- local and remote recipient actor identities are unique and mutually exclusive;
- federation endpoint URLs are HTTP(S) and cannot contain embedded credentials;
- each remote `targetDomain` equals the hostname of the effective delivery endpoint (`sharedInboxUrl` when present, otherwise `inboxUrl`);
- the producer uses one global bounded resolver budget across local and remote target resolution, instead of allowing each class to consume the full concurrency limit independently.

## Runtime boundary note

The TypeScript `ActivityPubDeliveryPlanContract` remains a sidecar compatibility/contract artifact. Phase 4 currently maps the validated Delivery Plan inside ActivityPods into the established `/webhook/outbox` payload rather than transmitting the full Delivery Plan object to a sidecar parser. Do not describe the TypeScript parser as a live network trust boundary until a later phase explicitly makes the full Delivery Plan the sidecar ingress format.

This distinction is intentional and documented to prevent contract tests from being mistaken for runtime enforcement on the sidecar HTTP boundary.
