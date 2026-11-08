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

## 9. Application-neutral group capability, SAI consent and per-group delegation

**Architectural invariant:** Paper is only one of potentially many ActivityPods clients. The hosting ActivityPods provider issues Group identity and authoritative role/membership state. No app URI is hard-coded as the unique Group UI or long-term operator, and a group's continued existence is not dependent on Paper's installation or availability.

### Evidence from the current ActivityPods app framework

- `app-framework/app/service.js` declares `settings.accessNeeds.required` and `optional` and registers both groups of needs.
- `pod-provider/backend/services/sai/applications.js` resolves the app's required access needs and special rights from its advertised Access Need Groups.
- `pod-provider/backend/services/sai/auth-agent.js` provides `registerApp`, `upgradeApp` and `removeApp` flows, passing accepted access needs and special rights to app registrations.
- `pod-provider/backend/services/sai/access-authorizations.js` persists application-specific authorizations and supports retrieval of special rights; `data-authorizations.js` handles access needs for Shape Tree-registered resources.
- The provider also implements OAuth consent services. **Solid-OIDC authentication, OAuth token scopes, SAI app registration/resource grants, and group-specific provider operation delegations are not automatically the same entitlement.** Group operation checks must bind these layers explicitly and avoid granting privileges by merely detecting a successful login.
- Existing `apods:CreateAclGroup` and WAC `acl:Control` grant WebACL-related actions, **not** the right to issue or administer a federated social Group.

References: [ActivityPods app framework](https://github.com/outlaw-dame/activity-pods/blob/master/app-framework/app/service.js), [SAI auth agent](https://github.com/outlaw-dame/activity-pods/blob/master/pod-provider/backend/services/sai/auth-agent.js), [SAI authorization storage](https://github.com/outlaw-dame/activity-pods/blob/master/pod-provider/backend/services/sai/access-authorizations.js), [ActivityPods permissions docs](https://docs.activitypods.org/app-framework/backend/handling-permissions/).

### Proposed three-part authorization model

1. **App access and provider capability:** The user explicitly authorizes the identifiable app for well-scoped group actions, and the provider permits this app to request those operations. Approved app status is a ceiling, not proof of user consent.
2. **Per-group delegation:** For management actions, an app is allowed to act on an explicitly selected Group and operation set, not all groups globally by default. The provider stores the delegation in its durable authoritative authorization registry, with expiry/revocation, actor/app/group binding, and versioning.
3. **Current effective group authority:** At mutation and signer boundaries the provider reevaluates the acting human/automated principal's live group role, suspended/removed state, group policy revision, provider restrictions and object/visibility ACL. An app cannot grant group roles it lacks authorization to assign.

**Example proposed app permission vocabulary (not existing framework rights; exact names are provisional and subject to operation inventory):**

| Proposed permission | Meaning | Default consent posture |
| --- | --- | --- |
| `apods:ReadGroups` | Read group metadata/content the user may access | Optional unless essential for app function; no member-directory disclosure implied |
| `apods:CreateGroup` | Request provider-issued group creation | Just-in-time on Create Group, with provider eligibility checks |
| `apods:JoinGroups` | Request/accept/leave membership as user | Optional, user-scoped |
| `apods:ContributeToGroups` | Submit contributions using user identity | Optional; no automatic group-actor signing |
| `apods:ManageGroupMembers` | Moderate admissions/membership where principal authorized | Optional; per-group delegation required |
| `apods:ModerateGroups` | Apply authorized moderation to group | Optional; per-group delegation required |
| `apods:ManageGroupSettings` | Change group boundaries and configuration as allowed | Optional; per-group delegation required |
| `apods:ManageGroupGovernance` | Grant/revoke roles; protected governance transitions | Optional, elevated reauthorization; per-operation controls |

**Avoid unnecessary consent prompts:** Apps request only operations they actually support. Ordinary participation needs no blanket group-administration scope. Initial registration can contain minimal access needs; additional privileges may use ActivityPods' `upgradeApp` path. High-risk provider actions can additionally use transaction-bound step-up approval. The scope vocabulary and exact mechanism (SAI special rights extension vs OAuth claim vs a separate provider-issued operation grant) require implementation review; **a new SAI right alone is not sufficient enforcement**.

**Do not mistake group resource access for a Pod-wide grant.** Shape Tree permissions apply to explicitly registered resource types; no app obtains unrestricted access to every user's Pod by holding a group action permission. A group's owner cannot authorize access to another member's Pod resources. Similarly `apods:ReadInbox` and `apods:ReadOutbox` are not automatically required just to receive group notifications; prefer a scoped event subscription when supported.

### App portability and simultaneous apps

Alice may authorize Paper, a forum-oriented ActivityPods client, and a third moderation dashboard independently. All three resolve the **same** provider-issued Group actor URI, AT DID and revisioned group governance, but each receives independent app-specific grants. Revoking Paper must not suspend/delete the group, strip Alice's legitimate member/owner role, or revoke another app's authorization; it must terminate Paper's ability to perform new group actions (including queued or signed actions) and revoke associated group-specific access/subscriptions and credentials. Neither an app installation nor its service credentials imply ownership of the Group.

A group may outlive its original creator/app and have co-owners. If Alice leaves, other authorized owners can continue group governance. If the hosting provider suspends the Group, all app and group operation grants are subordinate to suspension.

### Security and negative acceptance tests

- App is authenticated through Solid-OIDC but did not obtain `CreateGroup` authorization: creation denied.
- App has `CreateGroup` permission but provider disabled group issuance: creation denied before any durable side effects.
- Alice authorizes group moderation in Group A but not Group B: Group B mutation/signing denied despite app-level general moderation permission.
- Alice is removed as moderator while app retains consent: all subsequent moderation and queued operations fail, including stale signed-action authorization.
- Two apps have independent grants; revoking App A cannot revoke App B or destroy the Group.
- Group owner Alice changes applications; Group actor URI, AT DID, content ownership and group role history remain stable.
- App asks for `apods:CreateAclGroup` or `acl:Control` but not a social group operation: cannot create or govern an AP Group.
- App requests only group member interaction: no implicit access to personal inbox, all Pod data, group owner keys, or full member directory.
- Login alone never confers app provisioning permission; remote AP follower state alone never confers restricted group membership.
- Replay of an expired app-group grant, cross-user or cross-group request, wrong app ID, retired group, changed policy revision or mismatched signed payload: deny.
- OAuth consent, SAI access-grant and provider group-operation checks cannot be confused or bypassed by an untrusted client-controlled `ctx.meta` field.
- Concurrent permission revocation and queued delivery use revision-fenced decisions; no post-revocation group action is newly authorized.

### G1 implementation decision gate

Before coding any group permission screen, map each provider Group API to (a) a canonical authenticated principal, (b) a registered app and approved capability, (c) user consent where required, (d) group-specific delegated grants, (e) current owner/role authorization, and (f) resource policy. Add authorization denial integration tests for every sensitive mutation and for the internal signer. Keep the vocabulary provider-wide and app-neutral; do not introduce Paper-specific hard-coded grants.

## 10. Concrete G1→G3 provider/Fedify integration seam — implementation review (2026-11-07)

Source reconnaissance establishes that current provider `internal-actors-api.getActorByIdentifier` is a **username→account.webId** lookup, and the current Fedify dispatcher returns `Person` from `/users/{identifier}`; its collections are placeholders. These are not the Group API. Building Paper Groups by calling that API would recreate the legacy-account dependency that the specification forbids.

### Proposed minimum typed provider read interface (contract, not deployed endpoint)

```ts
type GroupAuthorityResultV1 =
  | { found: false }
  | {
      found: true;
      canonicalGroupId: string;            // opaque, provider-issued
      actorUri: string;                   // exact provider-approved public URI
      actorType: "Group";
      displayName: string;
      preferredUsername: string;
      state: "active" | "suspended" | "retired" | "provisioning";
      identityRevision: number;
      policyRevision: number;
      approvedPublicKeyId: string | null; // reference to public verification material only
      inboxUri: string;
      outboxUri: string;
      followersUri: string;               // NOT group membership roster
      publicCollectionVersion: number;
    };
```

The provider must **authenticate the workload** querying nonpublic operational metadata, bind the returned group to the target provider tenant, and not disclose private membership/role records through this public actor read DTO. Public actor rendering requires only vetted public fields. Data projections must be explicitly typed, provenance-checked, revisioned and bounded in size.

**URI routing:** `/groups/{opaque-or-stable-id}` is a *candidate namespace* to avoid aliasing `/users/{identifier}`; it is not yet a finalized address. The canonical URI must be selected by provider routing ownership (hostname/proxy), dereferenceability and signing-key controller tests. No application, including Paper, may define a separate group actor URI after issuance.

**Group WebID:** Optional collective-WebID representation is evaluated separately from the ActivityPub Group actor URI. If a combined URI is used, RDF/ACL semantics and DID link proof must be validated. Do not require a personal-style group Pod or put Group actors into `auth.account` solely to satisfy existing `signing._validateLocalActor`.

### Proposed provider-only mutating actions (contracts, not exposed today)

- `provider.collectives.reserve`: requires signed verified principal+app authorization, unique idempotency key and exact payload hash. Produces a pending opaque ID and reserved URI without keys or public federation.
- `provider.collectives.provision`: idempotently advances a durable state machine; may issue AP key and real AT DID with separate, unique signer references. Does not accept arbitrary remote DID or private key from caller.
- `provider.collectives.getPublicActor`: returns only approved public typed Group profile and public signing material when `active`.
- `provider.collectives.authorizeOperation`: derives current app, principal, group role, provider policy, visibility and immutable recipient/payload digest; issues bounded approval for a specific activity.
- `provider.collectives.getPublicCollection`: paginated, ordered, visibility-filtered data. Followers are subscription state, NOT membership by default; do not disclose private group roster.

Names and shapes are working interfaces, not additional deployed microservices. Prefer extending provider modules and existing persistence, transaction, signing and authorization primitives where those are proven suitable; no duplication for its own sake.

### Required cross-repository acceptance fixtures (not yet executed)

1. **Valid public group:** given exact verified provider Group response, Fedify renders `type: Group` with correct `id`, endpoints and matching public key controller, never `Person` or `Service`.
2. **Unknown or stale group:** missing/revoked/suspended/provisioning actor cannot be silently converted to `Person`, and private group metadata is never exposed.
3. **URI mismatch:** requested public URL differing from returned authoritative `actorUri` fails closed; no cross-host or user/group namespace alias.
4. **Legacy group account:** RDF `foaf:Group` / `as:Group` typed legacy storage record without an actual collective authority record cannot be treated as a federated community.
5. **Signed group post:** valid group Announce uses a provider-authorized Group key with immutable payload and recipient plan; sidecar cannot select a local key or substitute the principal.
6. **Collections:** real empty collection and missing/unavailable collection are distinguished; pagination/audience rules are tested against AP threadiverse implementation fixtures.
7. **App neutrality:** two distinct approved apps with separately granted permissions manage the same provider Group, and revoking one does not transfer the group's identity or remove the other's access.
8. **AT binding:** a DID claimed for a Group resolves to a valid provider-controlled DID document; unregistered mock did:plc strings are rejected.
9. **Resume after partial provisioning:** replay with same idempotency key and payload never issues a second canonical Group ID, signing-key set or DID.
10. **Tenancy/IDOR:** authenticated operations cannot access or mutate another provider's Group by changing `groupId`, `actorUri` or `appId`.

### Decision gate

**Do not implement production Fedify Group dispatch against the existing Person-only `/users/{identifier}` or synthetic collection APIs.** First agree the provider's typed Group record, public Group URI/namespace, signing-key attachment and exact authorization operation path. Then implement with live provider + sidecar integration tests and separate reviewable PRs. This protects the agreed authority model while leaving ordinary Person and Service federation behavior unchanged.

## 11. G1 implementation increment — pure public projection boundary (2026-11-07)

**Draft runtime PR:** [ActivityPods #117](https://github.com/outlaw-dame/activity-pods/pull/117) on `feat/collectives-g1-authority-boundary`.

The PR adds `pod-provider/backend/services/utils/collective-identity-boundary.js` and a focused Jest regression suite. The module strictly screens a **provider-originated and separately authorized** typed public Group projection: exact provider/actor URI, state `active`, revision numbers, public endpoint URI consistency, public key URI binding shape, and explicit field allowlisting (no private membership, group-policy internals or key secrets). A separate DID helper checks managed `did:plc` syntax **only**.

**Do not misrepresent this increment:** It is not a functioning provider Group store, provisioning saga, DID genesis/PLC validation, API authorization, signing enforcement or Fedify Group dispatcher. No public service route or database mutation is introduced. The input **must** be from trusted provider-authoritative storage and separately authorized; the helper does not prove source authenticity, signer possession or DID control.

**Verified backend CI:** [workflow run 42444806999](https://github.com/outlaw-dame/activity-pods/actions/runs/42444806999) on PR #117 head `b22462b5d0e5386d1a0295970d4a6fcac6060303` completed successfully: **131/131 Jest suites and 995/995 tests passed**, including `collective-identity-boundary.test.js`. This is unit-test evidence for the validation module, not integration or deployment proof. G1 remains in progress. Subsequent steps must establish actual provider persistence and authoritative lookup before integrating this DTO with a public actor route.

## 12. Implemented G1 reservation/staging substrate — independently verified CI (2026-11-07)

**Source:** [ActivityPods draft PR #117](https://github.com/outlaw-dame/activity-pods/pull/117), `pod-provider/backend/services/collective-reservations.service.js` and `pod-provider/backend/tests/collective-reservations.test.js`.

### Implemented, with explicit boundaries

- **Provider persistence:** Group reservations live in the Fuseki `settings` dataset. They are not persisted in Redis, sidecar state, legacy group Pods or account records.
- **No public route and default-off:** `PROVIDER_COLLECTIVES_RESERVATIONS_ENABLED` must be `true`. Requests must carry short-lived HMAC-bound operation grants minted by a trusted issuer; the current service does **not** mint them, and it does not treat app-provided `ctx.meta` as proof of authorization.
- **Opaque identity:** stable `cg_<32 hex>` Group ID and a proposed `https://provider.example/groups/{id}` actor URI, reserved without publishing a Group actor. Idempotency is scoped to original principal, creator app and request key, but **the creating app is provenance, not exclusive long-term group authority**.
- **Stable identity key:** `PROVIDER_COLLECTIVES_ID_KEY` is separate from `PROVIDER_COLLECTIVES_GRANT_SECRET`. Keep the identity derivation key backed up and versioned; rotating only the short-lived authorization signing key does not rename an existing group.
- **Conditional atomic writes:** SPARQL conditional `INSERT ... WHERE FILTER NOT EXISTS` prevents duplicate reservation records in an appropriately transactional Fuseki/TDB2 dataset. Read-back rejects mismatched payloads, app/owner or actor URI. A revision compare-and-swap stage transition writes a unique transition nonce and verifies it, so an identical concurrent losing request cannot claim a winner's success.
- **Stages only:** `reserved -> ap-key-pending -> did-pending` with monotonically increasing revisions. There is **no active transition**, no claimed signer or DID verification, and no public Group actor. This prevents the workflow from pretending cryptographic issuance is complete.
- **Resumption:** `get` returns persisted current stage/revision for authorized users, enabling later reconciler design without in-memory-only state; actual worker leases, scanning and external-step replay evidence remain to be implemented.
- **Security tests:** malformed URI, missing/tampered/expired grants, disabled provider, conflicting requests, cross-user IDOR, cross-app authority, concurrent reservations and CAS, stable IDs across grant-key rotation, simulated restart using retained store, write failure and recovery.

**Final checked CI:** [ActivityPods Backend checks 42445818480](https://github.com/outlaw-dame/activity-pods/actions/runs/42445818480) on commit `5bdde01b2d88644ec44fc8fe9bb067911b749488`: **132/132 Jest suites and 1013/1013 tests passed.** All new service persistence tests use a fake SPARQL adapter that models conditional writes. CI success **does not prove live Jena/Fuseki concurrency, durability, replicated-service behavior or public authorization integration**.

### Required gates before enabling the default-off service

1. Wire an issuer that **independently verifies Solid-OIDC principal, SAI app registration, explicit group permissions and current provider policy**, then mints exact short-lived operation grants. A self-reported principal/app identifier or generic server bearer does not suffice.
2. Verify conditional SPARQL UPDATE semantics against the **actual configured Fuseki/TDB2 production dataset**, with two service replicas, conflict and restart testing; test rollback under write failure and restore from backups.
3. Implement secure persistent provider key issuance/attachment and **valid actual AT DID issuance**, with independently checked proof and durable side-effect evidence before any transition to active.
4. Implement background reconciliation/leases and bounded retries for partial provisioning; do not repeat DID genesis or key issuance on uncertain outcome.
5. Provide the authenticated provider collective actor lookup and real Fedify Group dispatcher and collections, without routing through `auth.account` or `Person`.
6. Verify multi-app access and role-based per-group delegation beyond the initial owner-only restriction.

**Status:** The provider-side reservation and revision-fenced staging subsystem is coded and unit-tested; its provider-origin handling accepts an optional canonical trailing slash without creating double-slash actor IDs. **Complete G1 collective issuance, app/user authorization integration, external reconciliation and group federation are NOT yet complete.** Keep ActivityPods PR #117 draft and disabled until gates pass. Neither its passing CI nor its submitted source is evidence of production Group provisioning.
