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

## 13. Provider persistence and consent integration evidence (2026-11-08)

**Current draft:** [ActivityPods #117](https://github.com/outlaw-dame/activity-pods/pull/117), still disabled by default and not merged.

### Verified live Fuseki test (now performed)

[GitHub Actions run 42464763873](https://github.com/outlaw-dame/activity-pods/actions/runs/42464763873) uses the actual `semapps/jena-fuseki-webacl` Docker image and a TDB2 `settings` dataset. It runs the real reservation service against a direct authenticated SPARQL HTTP adapter. The proof reported:

- 12 simultaneous reservation requests across separately constructed service instances → **one deterministic canonical Group ID** (all received the same outcome).
- 12 competing CAS transitions from revision 1 → **exactly one success**, 11 rejected as stale.
- Persisted group and revision 2 survived an actual Fuseki container restart, retaining the same mounted dataset.
- Conflicting idempotency-key payload rejected.
- No actual Group actor was published; no key/DID was minted.

**Scope:** This proves the narrowly exercised real Fuseki/TDB2 reserve/transition/restart semantics, not broad deployment durability, full browser/OIDC integration, SAI persistence, failover to new hosting providers or arbitrary replica network partitions.

### Added live SAI authorization defense

`pod-provider/backend/services/utils/collective-access-policy.js` verifies, independently of a signed operation token, that:
- the referenced WebID maps to a current local ActivityPods account;
- the precise app URI is in the provider-configured allowlist `PROVIDER_COLLECTIVES_APPROVED_APPS`;
- the user has an active SAI application registration for that precise app;
- the user's present SAI AccessAuthorizations include `apods:CreateGroup` for reservation or `apods:ReadGroups` for reads.

These checks are made before reserve/read actions, not supplied by the caller in `ctx.meta`. A missing registration, missing right, unavailable authority service or disallowed app must not yield access. Removing registration or withdrawing SAI permission causes subsequent reserve/read operations to fail despite an otherwise unexpired HMAC grant. The existing `advance` action is an internal provisioning-phase primitive and must be confined to a trusted provider worker issuer before enabling the service.

`pod-provider/frontend/src/common/list/AccessNeedsList.js` and EN/FR localization files now label `apods:CreateGroup` and `apods:ReadGroups` as **social-group capabilities**, distinct from the older WAC/ACL permission-group right.

### Still incomplete—do not enable in production

1. A secure **trusted operation-grant issuer** binding actual authenticated Solid-OIDC client/principal, selected app identity, requested Group operation and live SAI consent. Merely signing a token for a client-provided app URI is not acceptable.
2. Group-provisioning worker authorization, ephemeral stage leases and durable external side-effect evidence. In particular, no app should acquire the ability to skip key/DID verification by requesting its own advancement grant.
3. Real AP Group key issuance, valid AT DID registration/control proof, actor lookup, signing policy, Fedify Group dispatch and interoperable collections.
4. End-to-end SAI registration/revocation integration tests against running ActivityPods, not just mocked SAI calls. User-level and provider revocation fencing needs verification under concurrency.
5. Service configuration/secret rotation operational runbook. No new default-on Group functionality.

Do not interpret application authorization, owner status or an HMAC grant alone as sufficient authority. The publisher's authorization must survive cross-component execution without silently broadening audience or protocol scopes.

## 14. Default-off Solid-OIDC→SAI→reservation ingress and worker separation (2026-11-08)

**Draft code:** [ActivityPods #117](https://github.com/outlaw-dame/activity-pods/pull/117). This is an independent ActivityPods provider capability, not a Paper-specific service or a complete Group implementation.

### Implemented reservation ingress

`pod-provider/backend/services/collective-reservations-api.service.js` conditionally registers `POST /api/collectives/reserve` when **both** `PROVIDER_COLLECTIVES_RESERVATIONS_ENABLED=true` and `PROVIDER_COLLECTIVES_API_ENABLED=true`. The route requires gateway authentication and authorization.

The handler re-verifies the provider-signed Solid-OIDC JWT with the provider's `jwk.verifyToken`; **neither the principal WebID nor app WebID is taken from request JSON**. It derives:
- app identity from signed `azp` and checks it against the gateway's verified app projection;
- human identity from signed `webid` and checks it against the gateway's impersonated-user projection;
- actual token audience `aud` against the app, `iss` against the provider, and `iat` within a 10-minute issuance window;
- an appropriately formatted `Idempotency-Key` from the HTTP header.

Using shared exact request-fingerprint generation (`utils/collective-grant-claims.js`), the gateway mints a bounded, short-lived HMAC operation token **inside provider services**, invokes `collective-reservations.reserve` and returns only inactive reservation details. The app does not receive the internal grant or any signing material.

The reservation service **independently** checks `auth.account.findByWebId` (including disabled/deleted/suspended-account rejection), exact provider-approved app URI, `app-registrations.isRegistered`, and `access-authorizations.getSpecialRights` for `apods:CreateGroup`. A read instead requires `apods:ReadGroups`. These proposed rights are visibly labeled on the existing ActivityPods SAI consent sheet in English and French; they are not blanket personal Pod rights.

### Internal worker boundary

Lifecycle `advance` does **not** accept an app-signed `provider.collective.reservation.v1` token. It requires a distinct `provider.collective.worker.advance.v1` grant with a separate `PROVIDER_COLLECTIVES_WORKER_SECRET`, bound to exact Group ID, expected revision and next stage. The worker issuer, step evidence, reconciler and safe side-effect handling are **not implemented**. No active/public status transition is exposed. Worker tokens must never be minted or returned through user app routes.

### Security and privacy findings incorporated

- Valid Solid WebIDs containing a fragment such as `#me` are supported; actor and app URI parsing is separately stricter.
- HMAC checks reject malformed Unicode or nonhex digests before `timingSafeEqual`, preventing unequal-buffer-length crypto exceptions.
- Group IDs depend on stable provider identity key, not the rotatable app or worker signing secret.
- The existing ActivityPods Solid-OIDC configuration allows ID tokens with **1-year validity**. The experimental endpoint requires fresh token `iat`, but **this is not proof of recent reauthentication and is not a substitute for DPoP/sender constraints or step-up authorization**. Do not enable in production until the actual Solid-OIDC browser client/token/proof flow has been verified and strengthened.
- App revocation is rechecked before the current reserve/read request, rather than relying solely on a previously minted HMAC grant. Concurrent revocation versus a reservation commit is an outstanding transaction-policy/fencing integration test.

### Deployment controls and remaining non-negotiable gates

Configuration: `PROVIDER_COLLECTIVES_RESERVATIONS_ENABLED`, `PROVIDER_COLLECTIVES_API_ENABLED`, `PROVIDER_COLLECTIVES_APPROVED_APPS`, `PROVIDER_COLLECTIVES_GRANT_SECRET`, `PROVIDER_COLLECTIVES_WORKER_SECRET`, `PROVIDER_COLLECTIVES_ID_KEY`, and canonical `SEMAPPS_HOME_URL`. The two signing keys and identity-derivation key must be strong, distinct, access-controlled and backed up appropriately; do not reuse credentials.

Still missing: full real OIDC/SAI browser-provider end-to-end proof; sender-constrained client authorization; service-to-service worker issuer/reconciliation; rate limits and audit telemetry; restart/retry safety for real AP keys and DID genesis; provider-governed membership; real `Group` actor dereference, collections, signing and ActivityPub/ATProto interop. Keep all Group functionality disabled by default and the implementation PR in draft until proven.

**Proof status:** Actual isolated Fuseki TDB2 concurrency/restart proof has passed. SAI and Solid-OIDC service interactions have regression tests using test doubles; do not represent them as an authenticated production integration test.

## 15. Final reviewed incremental verification (2026-11-08)

Current source head of [ActivityPods draft PR #117](https://github.com/outlaw-dame/activity-pods/pull/117): `ce33fd587efd0e2dbf8118d8d3f2650b9030348d`.

- [Backend checks 42466061490](https://github.com/outlaw-dame/activity-pods/actions/runs/42466061490): **134/134 test suites, 1,067/1,067 Jest tests passed**, including the Group projection validator, Fuseki reservation adapter fixtures, live SAI consent policy checks and reverified Solid-OIDC gateway tests.
- [Frontend checks 42466061462](https://github.com/outlaw-dame/activity-pods/actions/runs/42466061462): completed **successfully**, including the frontend production build and tests.
- [Real Fuseki TDB2 integration 42466061497](https://github.com/outlaw-dame/activity-pods/actions/runs/42466061497): completed **successfully**. It uses the service's actual SPARQL conditional writes, validates 12 concurrent reservations, rejects concurrent stale CAS updates and checks persisted revision after container restart.
- The backend workflow retains native dependency execution, installing system libvips rather than depending on an unreliable external Sharp binary download. It has bounded retries without skipping all native postinstall work.

**Verified outcome:** durable G1 reservation, revision-fenced staging, application-independent provider records, current SAI registration/special-right gating, a provider-only worker token boundary, and a disabled-by-default, signed-Solid-OIDC provider-mediated reservation route are implemented and tested at the levels above.

**Not verified/not built:** production sender-constrained OIDC or step-up; actual in-browser SAI registration/revocation against the running provider; a durable worker issuer/reconciler; AP Group signing-key issuance, valid AT DID genesis, group activation, Fedify Group dispatch/collections, or cross-protocol community federation. **G1 is not complete and PR #117 must remain draft/unmerged.**

## 16. G1 high-trust authorization and durable lease-fenced provisioning boundary (2026-11-08)

[ActivityPods draft PR #117](https://github.com/outlaw-dame/activity-pods/pull/117) now contains **three** mutually reinforcing security boundaries for collective identity reservations:

1. **User/application consent:** a provider-verified Solid-OIDC subject and authorized app identity; current local account status; explicit SAI app registration and `apods:CreateGroup` for reservation or `apods:ReadGroups` for reads; provider-approved app allowlist. No app, including Paper, owns the Group after creation.
2. **High-trust sender proof for the experimental HTTP reservation route:** a signed, short-lived token carrying exact issuer, audience, `sub == webid`, `azp`, recent `iat` and **recent `auth_time`**, nonempty authentication methods, and `cnf.jkt` binding to the actual DPoP signing key. The HTTP request's DPoP JWS must prove method, URI, JWK thumbprint and `ath` matching the exact bearer token; Redis atomic replay fencing rejects a used JTI. Invalid or absent claims fail closed. This is cryptographic gating **not proof that the current Solid-OIDC provider already issues suitable bound tokens**.
3. **Independent provider worker ownership:** operations that change provisioning stages require a distinct signed worker grant, with exact Group ID, stage, revision, worker ID, lease epoch and lease-token digest. A live lease record is maintained by conditional SPARQL writes in the authoritative Fuseki settings dataset; claims are unique, renewals and releases are token-scoped, and expired ownership may be reclaimed after a crash. The Group lifecycle CAS **atomically requires** matching nonexpired worker lease fields in its own conditional write. App operation tokens cannot substitute for worker credentials.

### Verification categories and non-equivalence

- **Actual Redis/DPoP cryptography:** Jest signs real ES256 JWTs and DPoP JWS, validates `cnf.jkt`, `ath`, endpoint/method, wrong bearer, wrong key and JTI replay; Redis nonce consumption uses atomic `GETDEL` instead of a `GET`/ `DEL` race.
- **Actual Fuseki/TDB2 integration:** isolated CI uses persistent Fuseki storage for 12-worker contention, renewal/release, lease expiration and recovery following container restart, plus 12-way identity reservation and single-winner stage CAS. Test operation credentials are fixtures, not production worker identities.
- **SAI and Solid-OIDC service integration:** permission / account checks and gateway binding are tested with service call doubles. The cryptographic verification pieces have an additional combined real-signature test. This **is not** a running-provider browser/OIDC/SAI end-to-end authorization ceremony.
- **Feature status:** Group service, API and lease worker capability remain **off by default** and the PR is draft/unmerged; no live AP Group actor, key material, DID, group member store or active federation has been issued.

### Critical unresolved production gates

1. Current ActivityPods Solid-OIDC configuration emits long-lived ID tokens and is **not verified to issue short-lived `cnf.jkt`-bound tokens with recent real `auth_time`** suitable for this Group API. Implement and test an interoperable sender-constrained token issuance and reauthentication flow—or replace with an equally secure user-verified, request-bound step-up flow—without changing established Solid-OIDC client behavior.
2. Exercise **real browser sign-in → app manifest/Solid consent sheet → SAI grant → authenticated Group reservation → revocation** against a running ActivityPods provider, including denied rights, client substitution and a revoke-vs-reserve race. Existing mocks and signed-fixture tests are insufficient.
3. Build a **trusted provider worker credential issuer and actual reconciliation executor** which securely uses the new durable leases. An app must never receive the worker key or obtain a grant for another worker's lease. Confirm bounded retry/backoff, crash recovery, telemetry, leasing under multiple replicas and correct state transitions under fault injection. Lease plumbing alone is not the worker.
4. Implement provider-controlled AP Group key creation with durable side-effect evidence, actual AT DID genesis/signing/verification, actor profile and collections, and complete cross-protocol privacy controls **before any transition to active**.
5. Review Redis `GETDEL` availability across supported Redis deployments (requires Redis 6.2+), lease expiry clock skew and production backup/restore of stable identity derivation and signing secrets.

**Implementation status:** provider-side high-trust and worker-fencing foundations are coded, tests/checks are running, but complete G1 provisioning is **not yet deliverable**. Do not equate an isolated passing proof with production issuance, group governance or federation.
