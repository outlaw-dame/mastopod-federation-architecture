# G1 Design Contract — Provider-Issued Collective Identity

**Status:** PROPOSED CONTRACT / NOT IMPLEMENTED  
**Project:** Paper — dual-protocol Group actors  
**Date:** 2026-11-06  
**Prerequisite:** G0 evidence review and authority-convergence acceptance.  
**Explicit non-dependency:** Existing ActivityPods legacy `groups.js` provisioning and PR outlaw-dame/activity-pods#116 are NOT the implementation or prerequisite for this contract.

## 1. Scope and authority

A Paper group is a **collective actor with provider-issued identity and provider-enforced policy**, not a new personal Pod, a legacy `foaf:Group` storage account, or a Fedify-owned service identity. An authorized ActivityPods app (e.g., Paper) presents group creation and administration; it cannot unilaterally issue identities or keys.

- **Ultimate infrastructure/policy authority:** ActivityPods Pod provider.
- **Pod owner/user:** independently controls personal Pod data and authorizes app operations; can create and govern groups within provider policy.
- **Group governance:** owners, co-owners, admins and moderators hold *revocable, explicit, delegated* group rights. Their privileges are not derivable from a legacy account's `owns` RDF property alone.
- **Protocols:** Fedify and ATProto expose/execute the provider's identity/authorization decisions; they do not mint independent authoritative membership databases or grant keys.
- **Boundaries:** membership, public AP Following, permission to read, permission to contribute, directory visibility and federation reach are separate.

## 2. Verified existing seams — not group support

| Existing seam | Verified behavior | Group-specific gap |
|---|---|---|
| `activity-pods/pod-provider/backend/services/groups.js` | Creates legacy `foaf:Group`/`as:Group` account/WebID, storage and ACL, owner claim | No proved group social membership, policy, delegated governance or threadiverse federation; do not reuse as G1 by default. |
| `activity-pods/pod-provider/backend/services/signing.service.js` | `signHttpRequestsBatch` checks a registered local account/actor and its attached RSA key; AT commit and PLC sign actions are separate | A group-issued authorization/operation policy check is not established; no evidence of provisioned signer-owned independent group keys. |
| `activity-pods/pod-provider/backend/services/identitybindings.service.js` | Current account binding upsert requires `canonicalAccountId === webId`, with account-oriented storage | Group entity must not be squeezed into account schema or assigned fake Person / Pod account to satisfy the invariant. |
| `activity-pods/pod-provider/backend/services/provider-capabilities.service.js` | Provides account-provisioning discovery and approved-app grant model | Group-specific approved app grant, provider policy and lifecycle not implemented. |
| `mastopod-federation-architecture/fedify-sidecar/src/federation/FedifyFederationAdapter.ts` | Normal Pod actor dispatcher uses `Person`; synthetic collections empty | Typed `Group` actor, real group collections and group submission/distribution semantics need implementation. |
| `mastopod-federation-architecture/fedify-sidecar/src/signing/ActorAuthoritySigningRouter.ts` | Provider-owned Pod actors sign through ActivityPods; sidecar service actors are special | New group actor must be recognized as provider-controlled, never sidecar-owned, with scoped operation authorization. |
| `Lawhacknifemi/mastopod-federation-architecture:sh-mvp` | Experimental AT hosting components on an older fork | Source for selective AT integration, not group authority design and not proof of production Group Host. |

## 3. Proposed identity record

The provider persists a typed collective subject, distinct from existing person-account identity bindings, with a unique stable group ID and independently bound protocol representations:

```ts
interface CollectiveGroupIdentityV1 {
  canonicalGroupId: string; // immutable provider-issued opaque ID, never a username supplied by an app
  hostingProviderId: string;
  activityPubActorUri: string; // exact authoritative Group.actor.id
  actorType: "Group";
  atprotoDid: string | null; // valid registered DID, NOT a hash with did:plc prefix
  webId: string | null; // only if correct RDF collective-WebID semantics are established
  storageMode: "provider_managed" | "group_pod"; // group Pod optional, not required in v1
  status: "provisioning" | "active" | "suspended" | "retired";
  identityRevision: number; // monotonic for CAS and stale-operation prevention
  policyRevision: number; // monotonic authorization revision
  signerKeyRefs: { activitypub: string | null; atprotoCommit: string | null; didRotation: string | null };
}
```

**Uniqueness requirements:** one canonical Group ID ↔ one hosted AP Group URI; DID uniqueness is enforced as a separate binding, with verified DID control and rotation proof. Neither WebFinger handles nor arbitrary remote actor hints are sufficient identity evidence.

**No assumption:** AP URI may become the group's WebID *if* RDF/ACL conformance is proven; this must not require a personal Pod account or a duplicate person account. The actual provider datasets and actor URL routing require an implementation decision before code is written.

## 4. App-initiated issuance and durable state

1. Alice authenticates using ActivityPods; Paper obtains a user- and app-bound, scoped `provider.group.provisioning` grant. No arbitrary `ctx.meta.webId`, caller-controlled `system`, or self-declared group owner is trusted.
2. Provider verifies account status, provider group feature flag, approved app, identity binding, group slug/handle reservation policy, rate limits and user-level create eligibility **before issuing keys**.
3. Provider atomically reserves (where supported) opaque group ID, unique AP URI and immutable creator/principal reference; persists `provisioning` with idempotency key + request fingerprint; a duplicate key with changed payload is rejected.
4. Reconcile/retry independently idempotent external work: ActivityPub signing key, valid DID PLC genesis/rotation keys, AP actor publication, provider membership/initial-owner grant and optional AT Group Host/Spaces setup. Each step records durable state and its provider action evidence.
5. Transition to `active` only after required actor URI/metadata, signing-key attachment, authoritative owner grant, DID proof and provider policy gates succeed. Avoid public advertising while incomplete.
6. Crash/restart recovery scans bounded pending states; retries only safe, idempotent steps with jittered backoff and retry budget for transient failures. Permanent authorization, conflict or invalid-DID errors **never** retry automatically.
7. Provider suspension immediately blocks new authorized group mutations and outgoing group signing; remote delivery already accepted by other servers cannot be recalled.

**Open design choice:** whether a Group DID is required to reach `active` when AT group federation is feature-gated. Original Paper requirement favors issuance at creation; if the DID directory is unavailable, keep an explicit pending state and do not claim full dual identity.

## 5. Group signing authorization (security-critical)

Reusing an internal signing *implementation* must never imply that the existing bearer-only AP HTTP signing endpoint is adequate for group authority. A trusted transport principal alone must not be able to sign arbitrary Group activities.

**Proposed signed-action authorization inputs:** canonicalGroupId, exact actor URI, requesting app ID and authenticated user or authorized federation event, activity semantic class, payload hash, destination/audience class, expiry, unique request ID and policy/governance revision.

The provider resolves **each field from trusted state** and enforces provider policy, group roles, current suspension/revocation and content visibility **at the operation boundary**. The provider checks the bound activity (e.g., Group `Announce`) against a committed approved action and recipient plan; the sidecar cannot expand recipients or change the actor.

AP HTTP signature, AT repository commit signature and DID PLC rotation signatures are distinct protocol operations and key references, under one provider custody boundary. Refuse group signing if the authorization decision is missing, stale, expired, revoked, mismatched to the bytes or attached to a different group. Prevent arbitrary actor URI / key substitution and record audit correlation without leaking private content.

## 6. Membership and scoped group security invariants

- Group member identity and governance grants are authoritative only in provider Tier 1.
- A contributor's AP actor/DID belongs to its issuing remote/local authority, not the host group; contributing does not hand over personal account keys or Pod ACLs.
- An AP Follow/subscription does not grant social membership or restricted-content access automatically.
- Remote AP/DID linkage requires proof of control of both identities; do not infer it from display names, handles or common links.
- Permissioned AT Spaces are not ordinary public AT repositories or the public firehose. For unsupported visibility mappings, **drop the projection** rather than downgrade privacy.
- Group membership and policy changes use durable revisioned state. Check authorization again before critical mutation/commit and delivery; stale grants fail closed.
- Provider-wide blocks/suspensions override any group/admin grant; owner transfer must not orphan the group; no group role can override a personal Pod resource ACL.

## 7. Negative tests required before a runtime implementation can pass G1

| Case | Expected behavior |
|---|---|
| App requests creation with no valid provider-approved grant | Reject before identity/key/DB side effects |
| Request supplies `ownerWebId` different from authenticated principal | Reject; no spoofed ownership |
| Two concurrent creates reserve the same URI/handle | Exactly one winner or deterministic idempotent result; no conflicting actor |
| Same idempotency key, different payload | Conflict; no new group |
| Crash after group record reserved but before DID/key issuance | Durable resumable pending state; not publicly active |
| Crash after valid DID issuance but before AP actor provisioned | Reconcile without duplicate DID or split-brain identity |
| Suspended group requests group `Announce` signing | Reject even with valid sidecar bearer |
| Removed moderator replays old authorization/policy revision | Reject; cannot sign or modify state |
| ActivityPub Follow arrives from unapproved remote server | No membership or private content access |
| App tries to read member-only resources through public AP/AT projection | Deny and emit nothing to public feeds/indexes |
| Group claims a Person URI or account DID as its own | Reject identity collision |
| Legacy group Pod/record exists with same slug | Explicit coexistence/collision policy; never silent identity takeover |

## 8. Required reviewed decisions before G1 code

1. Is the Group AP actor URI to be the group's WebID or a distinct hosted collective actor? Decide via actual SemApps actor routing + RDF conformance evidence, not by inheriting `groups.js`.
2. Which existing Tier-1 key mechanism can provision a Group-specific AP signer without requiring a person account? Confirm key owner/controller and attachment.
3. Which native managed-AT repository/PLC issuer from current upstream should issue Group DIDs, and how does Spaces Group Host assume delegated authorization?
4. What is the durable group record store and compare-and-swap/idempotent provisioning substrate already in ActivityPods? Reuse existing infrastructure, do not add an unneeded broker.
5. What are the exact app capability checks and internal action authentication paths? Reject generic service-level `system` impersonation by external callers.

**Phase disposition:** The contract is a design artifact only. Group provisioning, membership, AT Group Host and federated Group dispatch are **not implemented**. Do not promote G1 as complete on the basis of this document, existing `groups.js`, or a green legacy-security test PR.
