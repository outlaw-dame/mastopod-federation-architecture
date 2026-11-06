# Paper Dual-Protocol Groups — G0 Developer-Fork Reconciliation

**Status:** REVIEW REQUIRED / G0 IN PROGRESS  
**Reviewed:** 2026-11-06  
**Target architecture:** [ARCHITECTURE-BASELINE.md](../../ARCHITECTURE-BASELINE.md) and [ATProto Authority Convergence](../atproto-authority-convergence.md).  
**Developer source:** [Lawhacknifemi/mastopod-federation-architecture, sh-mvp](https://github.com/Lawhacknifemi/mastopod-federation-architecture/tree/sh-mvp).

> This is a source inspection and integration plan, not a claim of production-ready ATProto hosting, executed tests, or finished group support. Group identity, membership, permissions and group signing remain proposed ActivityPods/SemApps Tier-1 capabilities.

## Integration decision

**DO NOT MERGE `sh-mvp` WHOLESALE.** Review and selectively forward-port conformant components and tests to current upstream, preserving the provider's authoritative account/group identity, key custody, AT repository state and event handoff.

The connected GitHub comparison returned:
- `Lawhacknifemi:master...sh-mvp`: **30 ahead, 0 behind**.
- `outlaw-dame:master...Lawhacknifemi:sh-mvp`: **30 ahead, 282 behind**, sharing an older merge base.

Compare: https://github.com/Lawhacknifemi/mastopod-federation-architecture/compare/outlaw-dame:master...sh-mvp

The change set includes new provider-side ATProto Moleculer services under `fedify-sidecar/activitypods-integration/backend/services/atproto/`, MST/CAR/repo utilities, XRPC and firehose changes, a broad internal social API, sidecar routes and a PostgreSQL post-sync cache. These are separate review concerns, not one atomic feature.

An added top-level `activitpod-aptoroto` entry is present in the comparison. The connected content reader could not fetch it as an ordinary file; **inspect its Git object type and any referenced submodule source/SHA** before asserting the actual full ActivityPods middleware is completely accounted for.

## Code-backed findings and blockers

| ID | Evidence | Risk | Required disposition |
| --- | --- | --- | --- |
| F-01 | [identity.service.js](https://github.com/Lawhacknifemi/mastopod-federation-architecture/blob/sh-mvp/fedify-sidecar/activitypods-integration/backend/services/atproto/identity.service.js): `createDid()` hashes handle, PDS and timestamp then prefixes `did:plc:`. | This is **not valid DID PLC genesis/registration**. | Replace with provider's cryptographically valid PLC provisioning, protected rotation keys and resolution proof. |
| F-02 | Same identity service persists a `hasPrivateKey` field with base64url JSON metadata. | Base64url is not encryption; the stored JSON is metadata, not a private signing key. | Remove misleading schema; persist protected key reference instead; audit RDF ACLs and logs. |
| F-03 | [repo.js](https://github.com/Lawhacknifemi/mastopod-federation-architecture/blob/sh-mvp/fedify-sidecar/activitypods-integration/backend/services/atproto/utils/repo.js): commit `sig` is TODO/omitted. | **Blocker** for ATProto signed repository conformance. | Use Tier-1 AT signing and verify signed commit bytes and valid CIDs. |
| F-04 | [atproto.service.js](https://github.com/Lawhacknifemi/mastopod-federation-architecture/blob/sh-mvp/fedify-sidecar/activitypods-integration/backend/services/atproto/atproto.service.js): `repositories: new Map()`, `MemoryStorage`, `globalSeq: 0`. | Restart and multi-node correctness are unproven; RDF storage alone does not demonstrate durable full repo reconstruction. | Tier-1 durable repo/MST/CAR/commit state, replay-safe sequence/outbox and restart proof. |
| F-05 | Same service builds `#commit` with empty `blocks` and uses commit CID as temporary `rev`. | **Blocker** for spec-correct repo sync/firehose. | Conform to current AT repository/sync specs and prove relay-client verification and cursor replay. |
| F-06 | [federation.service.js](https://github.com/Lawhacknifemi/mastopod-federation-architecture/blob/sh-mvp/fedify-sidecar/activitypods-integration/backend/services/atproto/federation.service.js): `JWT_SECRET || 'your-secret-key'`. | Weak/default token signing secret if deployed unset. | Fail closed on missing required keys; review OAuth and credential boundaries. |
| F-07 | [bridge.service.js](https://github.com/Lawhacknifemi/mastopod-federation-architecture/blob/sh-mvp/fedify-sidecar/activitypods-integration/backend/services/atproto/bridge.service.js): identity link `Map()`. | Non-durable, potentially unverified actor↔DID claims. | Keep verified canonical `IdentityBinding` in Tier 1; no authorization based on hints. |
| F-08 | [internal-social-api.service.js](https://github.com/Lawhacknifemi/mastopod-federation-architecture/blob/sh-mvp/fedify-sidecar/activitypods-integration/backend/services/internal-social-api.service.js): bearer path and selected-actor `ctx.meta.webId`; master-call mode. | Confused-deputy and actor-impersonation **review surface**; exploitability not established from this inspection. | Bind acting user, app, actor, scope and permitted operation before any write; remove broad bypasses. |
| F-09 | [sidecar postgres.ts](https://github.com/Lawhacknifemi/mastopod-federation-architecture/blob/sh-mvp/fedify-sidecar/src/db/postgres.ts): local post cache and sync. | Possible competing authoritative social-state pathway. | Classify as reconstructable projection or reject; never house authoritative group membership in Tier 2. |
| F-10 | MST/CAR utilities, XRPC handling and new tests are present. | Potentially reusable, but unverified against current upstream. | Selective forward-port only with real signed repository, migration and failure tests. |

## Provider-authority contract for groups

1. ActivityPods owns **canonical group identity**, actor provisioning, signing authorization, provider-level policy, and authoritative membership/governance records. Individual Pod owners remain autonomous under provider policy. Paper and other approved apps supply UI and delegate operations; the sidecar never originates group membership authority.
2. Group issuance produces a canonical Group ID, an independent ActivityPub `Group` actor URI, and a real AT DID. Group WebID and dedicated group Pod are separate optional design decisions; never imitate a `Person` or user Pod to achieve group federation.
3. Existing internal AP signing API may be extended to authorize group actors; AT commit signing and DID rotation must use protocol-appropriate Tier-1 mechanisms. Group-authored operations require explicit authorization binding `(user/app/group/action/policy revision)`. No general-purpose signing oracle or raw key export.
4. Group membership and role decisions are provider-authoritative. AT `meta`, `members`, and app spaces are **protocol projections** with independent consistency and access tests, not secondary membership authorities. Remote AP actor to AT DID links need verified control of both identities.
5. Public AT repositories are **not** safe stores for restricted group data. ATProto Spaces permissioned data is a separate, evolving protocol and must be treated as experimental until current Lexicon/Group Host conformance is demonstrated. Default deny cross-protocol restricted projection.
6. Native AT managed repositories must contain durable real signed commits, MST/record/CAR blocks and a crash-safe repository-to-event outbox; Redis caches, bridge mappings and RedPanda logs cannot replace Tier-1 repo authority.
7. Fedify public Group actor dispatch, collection fidelity, Follow/Accept and Announce interop should be built against the current provider-authorization and AP delivery contracts, not folded into the fork's unrelated app-feed changes.

## G0 execution checklist

- [ ] Freeze exact SHA of `sh-mvp` and current upstream `master`; attach compare report.
- [ ] Inspect `activitpod-aptoroto` Git object and any separate developer ActivityPods middleware source/ref.
- [ ] Classify all fork files as `selective-port`, `superseded`, `unsafe`, `test-only` or `needs-review`.
- [ ] Prove PLC DID creation, DID document/service resolution and recovery/rotation keys.
- [ ] Prove signed AT repository commits, real MST data, CAR export/import, record CRUD, restart/migration and cursor replay.
- [ ] Audit all internal privileged APIs and chosen-actor mappings for confused-deputy risks.
- [ ] Agree exact provider Group actor identity, canonical binding and group-specific signer authorization contract.
- [ ] Define experimental AT Spaces/Group Host adapter with versioned schema and no public-data leakage.
- [ ] Attach hermetic tests and code coverage; agree narrowly scoped upstream PR sequence.
- [ ] Mark G0 **VERIFIED** only when the required evidence and peer review are attached.

## Gates for the Paper Groups phases

- **G0:** In progress; branch found, unresolved authority and code-quality gaps.
- **G1 (identity):** Draftable; promotion blocked until canonical AP/AT group issuance/signing decisions are proven.
- **G2 (membership):** Design and fixtures can proceed; authority must stay Tier 1.
- **G3 (public AP groups):** Work may proceed independently from AT Spaces, preserving the provider's existing delivery and signing API.
- **G4 (native AT Group Host):** Experimental, not production-ready until Tier-1 managed PDS conformance and upstream Spaces compatibility are proven.
- **G5–G8:** Cross-protocol, restricted privacy, reliability and deployment follow their separate acceptance gates.

## Normative and project references

- [AT Protocol Repository specification](https://atproto.com/specs/repository) — signed commit, MST, CAR and CID requirements.
- [AT Protocol DID specification](https://atproto.com/specs/did) — recognized DID methods.
- [ATProto Spaces alpha](https://atproto.com/blog/atproto-spaces-alpha) and [Atmospheric Groups](https://atproto.com/blog/atmospheric-groups-intro) — evolving group/permissioned data model.
- [Fedify Threadiverse community tutorial](https://fedify.dev/tutorial/threadiverse) — AP Group actor, Follow/Accept and Announce baseline.
- [ATProto Authority Convergence](../atproto-authority-convergence.md) — upstream target authority model and transactional outbox invariants.
- [ActivityPub Delivery Plan Contract](../activitypub-delivery-migration/CONTRACT.md) — recipient and privacy boundaries.
- [ADSP status](../activitypods-distributed-scalability/STATUS.md) — existing deployment and transport gates.

**Evidence scope:** Source inspection on accessible fork branches on 2026-11-06. The developer branch was not executed, dependencies were not exhaustively traced, and no claim of end-to-end PDS compliance is made. Revalidate against pinned SHAs before forward-porting.
