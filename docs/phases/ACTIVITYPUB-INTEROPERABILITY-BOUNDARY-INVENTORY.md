# ActivityPub Interoperability Boundary Inventory

Status: **ACTIVE inventory / semantic assertion-model work next**  
Inventory baseline: **2026-08-20**  
Architecture base: `4a1b15390d834b4e8e6078733c076376c12b312c`  
ActivityPods evidence baseline: `0ae54f0a898df3fb4e6516504c4e649669834d69`  
Companion signing/provenance repair evidence: PR #97 head `fde88cb499fb1aa23883af95100613dca150fd64`

## Purpose

This document inventories the existing ActivityPods/SemApps/Fedify processing, authority, normalization, privacy, persistence, and interoperability-test boundaries before the shared cross-implementation semantic assertion contract is expanded.

It does **not** start interoperability from zero. `fedify-sidecar/interop/ap/` already contains a local Dockerized real-implementation harness for GoToSocial, Mastodon, and Akkoma. The next work is to converge those proofs on one versioned semantic contract and expand the same harness to additional ActivityPub implementations.

No public-internet CI dependency, NATS Core authorization, JetStream authorization, or ADSP gate weakening is implied. The target additions in this inventory are additive; `ACTIVITYPUB-INTEROPERABILITY-HARDENING.md` remains the authoritative coverage taxonomy.

## Re-audit corrections

### C1 — SemApps `1.1.4` provenance is identifiable

ActivityPods pins the relevant published SemApps middleware packages exactly to `1.1.4`. The upstream release commit is:

`b8e1061c9d94cbaa42ef5c5bca87f38f0da9fb1` — `middleware-v1.1.4`

ActivityPods patches the installed SemApps runtime at postinstall for ActivityPub local-delivery behavior and distributed LDP/JSON-LD/ontology locality/cache behavior. Executable interoperability tests therefore target **installed SemApps `1.1.4` after ActivityPods patches**, not current SemApps `master`.

### C2 — Signing authority is split by actor class, with no cross-authority fallback

#### ActivityPods pod/user actors

For ActivityPods-owned pod/user actors, ActivityPods is the private-key/signing authority. `POST /api/internal/signatures/batch` resolves the exact local account, exact ActivityPub actor, and SemApps RSA key material; requires owner/controller/actor-key linkage; requires an unambiguous signer-controlled key; derives `keyId` from signer-controlled linkage; and keeps the private key inside ActivityPods.

#### Sidecar-owned service actors

`SidecarLocalSigningService` owns RSA keys for configured sidecar service identities such as relay/provider actors. The runtime authority router on companion PR #97 routes those exact sidecar service actors only to the sidecar-local signer. All other actors remain delegated to ActivityPods, where the exact local account/actor/key authority chain decides whether signing is allowed.

The same router is applied to the concrete `SigningClient.signOne` path used by authenticated GETs. Replies backfill and origin reconciliation therefore no longer need ActivityPods to sign as the sidecar-owned relay actor. A sidecar-service signing failure does **not** fall back to ActivityPods.

Established signer invariants:

- `activitypods_pod_actor` -> `activitypods_internal_api`;
- `sidecar_service_actor` -> `sidecar_local_signer`;
- no cross-authority fallback;
- actor URI shape alone never grants signing authority.

The semantic assertion model still records both `actorAuthorityClass` and `signerPath` so the evidence remains explicit rather than inferred.

### C3 — Wire verification, synthetic enqueue, and authenticated actor provenance are distinct facts

Two real inbound wire-verification modes exist:

1. **Fedify wire verification** for requests actually verified by Fedify before enqueue;
2. **sidecar-native HTTP-signature verification** for raw inbound requests that have not crossed a trusted Fedify verification boundary.

Historically, `InboundEnvelope.verification.source: "fedify-v2"` was overloaded: origin reconciliation, replies backfill, and a benchmark path could also construct that marker. Reconciliation/backfill copied a fetched object's actor/attribution claim into both the activity and verification metadata, so equality downstream was tautological rather than actor authentication.

Companion PR #97 closes the authority-upgrade path at the queue boundary:

- envelopes carrying `x-origin-reconciliation: true` have synthetic preverification stripped before Redis enqueue;
- envelopes carrying `x-backfill-source` have synthetic preverification stripped before Redis enqueue;
- genuine Fedify wire traffic retains its trusted verification marker;
- the benchmark path remains explicitly test-only and retains its benchmark marker;
- stripped synthetic envelopes enter the native verifier with no incoming HTTP Signature and therefore fail closed before the ActivityPods trusted bridge.

This means synthetic origin/backfill material is **not forwarded to ActivityPods as an authenticated remote actor** merely because a fetched payload names that actor. The bridge does not receive those failed synthetic cases and therefore cannot upgrade them by assigning `meta.webId` with skipped duplicate validation.

Accordingly:

- `wire_fedify_verified` requires independently established Fedify wire verification;
- `wire_native_verified` requires sidecar-native HTTP-signature verification;
- reconciliation/backfill may carry origin/fetch evidence for parser/reconciliation purposes, but not authenticated remote-actor provenance unless a future independent verifier establishes it;
- benchmark injection is test-only and never promotion evidence;
- `preverified_activitypods_bridge` means a trusted handoff that preserves an already-authenticated principal; it is not a verifier class of its own;
- `parser_semantic_only` makes no transport/authentication claim.

The overloaded `fedify-v2` string must never be treated by tests as sufficient verifier identity by itself.

## Existing real-implementation interoperability harness

`fedify-sidecar/interop/ap/` already provides local-only Dockerized evidence using:

- the real sidecar;
- Redis and Redpanda;
- a deliberately small ActivityPods authority mock for actor metadata/internal signing;
- GoToSocial;
- Mastodon;
- Akkoma from pinned official source;
- local TLS without weakening production HTTPS requirements;
- signed outbound `Follow`;
- remote actor/key dereference;
- inbound `Accept` through the sidecar path;
- selected target-side persistence/media proofing;
- fast non-Docker queue/runtime/signing compatibility tests.

`smoke:interop:ap` runs GoToSocial + Mastodon. `smoke:interop:ap:extended` adds Akkoma. These are real local implementations, not public-internet dependencies.

## Boundary map

```text
remote HTTP request
  |
  v
[0] HTTP/body decoding + content negotiation
  |
  v
[1] wire authentication, when present
    - Fedify verification
    - sidecar-native HTTP-signature verification
  |
  +--> synthetic/internal producers
  |      - reconciliation / replies backfill
  |      - synthetic preverification stripped before queue storage
  |      - no authenticated remote actor merely from fetched actor equality
  |
  v
[2] trusted sidecar -> ActivityPods handoff
    - only after an accepted authenticated inbound path
    - trusted local inbox
    - actor-value equality re-check
    - preserves, never upgrades, upstream authenticated principal
  |
  v
[3] ActivityStreams structural handling
  |
  v
[4] JSON-LD / ontology semantic normalization
  |
  +----------------------------+
  |                            |
  v                            v
[5a] authority/policy       [5b] visibility/privacy
  |                            |
  +-------------+--------------+
                |
                v
[6] persistence + ActivityPub side effects
                |
                v
[7] application-consumption boundary
    - SemApps LDP/JSON-LD resources
    - ActivityPods supported feature/API semantics
```

A test that enters below a boundary must declare that entry point and cannot claim evidence for a boundary it bypassed.

## 0. HTTP/body boundary

SemApps ActivityPub/LDP routes use the SemApps middleware chain for URL/header parsing, content negotiation, JSON/Turtle/file parsing, and dataset metadata. ActivityPods' gateway dispatches HTTP Signature, Solid/OIDC, ActivityPods JWT, and anonymous authentication where applicable.

**Remaining work:** one versioned media/body/context matrix. Full HTTP fixtures are required for assertions about headers, digest/signature bytes, content type, malformed bodies, and exact wire representation.

## 1. Authentication, provenance, and signer evidence

The assertion contract models facts separately rather than encoding a single overloaded source label.

Inbound evidence classes:

- `wire_fedify_verified` — independently proven Fedify wire-verification path;
- `wire_native_verified` — sidecar-native HTTP-signature verification;
- `preverified_activitypods_bridge` — trusted handoff preserving an already authenticated principal;
- `parser_semantic_only` — no transport/authentication claim.

Synthetic reconciliation/backfill is deliberately **not** an authenticated inbound evidence class after the queue-boundary repair. Those producers may be exercised for origin/parser/reconciliation behavior, but they cannot claim an authenticated remote actor unless a separate verifier is introduced.

Outbound signer evidence records:

- `actorAuthorityClass`: `activitypods_pod_actor | sidecar_service_actor | remote_actor | unknown`;
- `signerPath`: `activitypods_internal_api | sidecar_local_signer | remote_implementation | other_test_only`.

A direct SemApps inbox call with signature validation skipped is never wire-conformance evidence. A `source: "fedify-v2"` value without independent entry-point/runtime evidence is not enough to establish `wire_fedify_verified`.

## 2. ActivityStreams structure

SemApps operates on ActivityStreams-shaped objects after HTTP parsing. ActivityPods layers feature behavior for actor metadata, app control, attribution, content warnings, collections, hashtags, previews, long-form content, media, polls, quote posts, reply policies, search consent, trust evaluation, and supported extensions.

**Remaining work:** compare meaningful dialect differences such as scalar/array forms, IRI versus embedded identifiers, compact/aliased/expanded terms, absent optionals, unknown extensions, polymorphic links/attachments, and invalid authority-bearing shapes. Unknown extensions must never acquire authority or visibility merely because they parse.

## 3. JSON-LD and ontology normalization

ActivityPods uses SemApps `JsonLdService`, cached ActivityStreams/blocked contexts, and ActivityPods postinstall hardening for distributed JSON-LD/LDP/ontology locality/cache correctness.

**Remaining work:** assert semantic equivalence—canonical/expanded types, behavior-relevant predicates, alias/context equivalence, bounded unknown-term behavior, topology consistency, and preservation of remote-context security policy. Lexical JSON equality is not the default contract.

## 4. Authority and policy

Authentication is not the complete ActivityPods authority model. Existing controls cover local account/actor ownership, signer/key authority, remote-delivery authority, remote fetches, provider identity, sidecar handoff, and feature policy.

Synthetic origin/backfill data remains non-authoritative for remote actor identity unless independently verified. Trusted scheduling/fetch origin does not automatically make every actor claim authoritative.

Negative cases must declare the authenticated principal, if any; claimed actor; origin evidence; signer path where relevant; and expected `accept | reject | ignore_extension` outcome.

## 5. Visibility, addressing, WebACL, and blind-address privacy

This layer remains split.

### SemApps/native/local behavior

Exact SemApps `1.1.4` recipient discovery reads `to`, `bto`, `cc`, and `bcc`, while the native outbox can continue carrying the source Activity representation. The APDM Delivery Plan contract explicitly states that its blind-address repair does **not** by itself repair SemApps native/local persistence or delivery behavior.

Native/local persisted and application-visible representations therefore require direct privacy evidence.

### APDM external Delivery Plan behavior

External/Fedify delivery uses unsanitized blind-address input for authoritative recipient planning and produces a sanitized Delivery Plan activity with recursive `bto`/`bcc` removal. The sidecar rejects a Delivery Plan that still leaks blind-address fields.

APDM's `audience` fail-closed behavior is recipient-plan/delivery compatibility and must not be generalized into source-persistence behavior.

Relevant tests must separately assert:

1. semantic visibility/recipient decision;
2. external Delivery Plan representation;
3. native/local persisted or application-visible representation;
4. WebACL/authorization behavior.

## 6. Persistence and ActivityPub side effects

Accepted activities can become remote resources, collection/inbox membership, events, follow/reply/share/like state, ACL state, and other durable behavior. Existing target proofs already inspect selected persistence/media outcomes.

Only cases that execute this layer may claim behavioral interoperability. Retryable flows should assert idempotency/replay where relevant.

## 7. Application-consumption boundary

There is no single production `NormalizedActivity` DTO consumed by ActivityPods applications. The application-facing substrate is SemApps/ActivityPods LDP + JSON-LD resources plus ActivityPods-supported feature/API semantics. The federation bridge is infrastructure, not a public normalized application contract.

The test-facing semantic assertion contract therefore describes at least:

- canonical activity/resource identity;
- semantic type(s);
- actor/attribution identity;
- object/target identity;
- visibility class and boundary-specific privacy expectations;
- content/attachment/extension facts;
- extension disposition;
- authorization outcome without exposing ACL internals;
- evidence boundary and test entry point;
- transport/authentication provenance;
- actor provenance quality;
- actor authority class and actual signer path;
- persistence/application-visible outcome.

## Evidence inventory

| Layer | Established evidence | Remaining work |
| --- | --- | --- |
| HTTP/body | SemApps middleware; ActivityPods gateway; local implementation harness | Versioned media/body/context dialect cases |
| Pod/user outbound signing | exact ActivityPods account/actor/key authority chain | Preserve + negative interop cases |
| Service-actor signing | authority-aware router + sidecar local signer, including signed GETs | Federation-level proof with real ActivityPods signer API |
| Wire verification | actual Fedify path + native verifier | Keep semantic evidence independent from overloaded marker |
| Synthetic ingress | synthetic preverification stripped; unauthenticated cases fail before bridge | Optional future non-authoritative hydration/reconciliation path |
| ActivityStreams | SemApps actions, ActivityPods feature probes, GoToSocial/Mastodon/Akkoma | Shared semantic/dialect schema |
| JSON-LD/ontology | JsonLdService, cached contexts, distributed hardening | Shared semantic-equivalence assertions |
| External delivery privacy | APDM sanitized Delivery Plan + sidecar rejection | Integrate into shared model |
| Native/local privacy | SemApps/WebACL path exists | Direct persistence/application-visible privacy evidence |
| Persistence | SemApps side effects + target-specific proofs | Shared replay/idempotency-aware assertions |
| App consumption | LDP/JSON-LD + ActivityPods feature APIs | Continue semantic contract coverage |

## Remaining gaps

### G1 — Semantic assertion coverage still needs expansion

The versioned assertion contract exists on companion work, but existing and future implementation lanes still need to project all relevant evidence into it consistently.

### G2 — Real ActivityPods internal-signing federation proof is still required

Unit and smoke evidence establish routing and signature behavior. Before this signing work is considered complete, run federation with a real ActivityPods internal signing API and prove both modes:

- sidecar enabled: ActivityPods pod/user signing crosses the internal signing API while sidecar service actors remain locally signed;
- sidecar disabled: native ActivityPods/SemApps federation still works independently.

This is an explicit completion gate, not an inferred result from unit tests.

### G3 — `fedify-v2` remains an overloaded storage marker

The queue-boundary repair prevents synthetic reconciliation/backfill from exploiting it as authenticated actor provenance, but the stored field is still unsuitable as the semantic model's verifier identity. Tests must continue to rely on explicit entry-point/runtime evidence.

### G4 — Synthetic origin/backfill needs a deliberately non-authoritative product path if retained

The security repair correctly fails these synthetic envelopes before the trusted ActivityPods bridge. If product behavior still needs fetched reconciliation/backfill material, introduce a separate non-authoritative hydration/parser path rather than weakening wire authentication.

### G5 — No universal strict ActivityStreams schema gate

SemApps uses targeted validation/handlers rather than one universal schema. Characterize real compatibility without prematurely rejecting legitimate dialects.

### G6 — Native/local versus external-delivery privacy require separate evidence

External blind-address sanitization does not establish native/local persistence privacy.

### G7 — Existing implementation-specific proofs need semantic convergence and expansion

GoToSocial, Mastodon, and Akkoma should project into the shared model while retaining target-specific diagnostics.

The expansion set is non-exhaustive and additive. It includes the active phase's already-required implementation families—**WordPress ActivityPub, Lemmy/PieFed, and Mobilizon**—plus **Bonfire, Castopod, Emissary/Bandwagon, Friendica, Funkwhale, Ghost ActivityPub, Loops, Owncast, PeerTube, Pixelfed, Misskey, Vernissage**, and the **Write.as family**. Where the exact service is hosted-only, a local open-source relative such as WriteFreely may provide local dialect coverage but must not be mislabeled as exact Write.as conformance. **Micro.blog** and exact hosted **Write.as** remain fixture/explicit opt-in external-conformance targets rather than required public-internet CI dependencies.

`ACTIVITYPUB-INTEROPERABILITY-HARDENING.md` continues to govern any additional required families not repeated here.

## Ordered next work

1. run the real ActivityPods federation proof with sidecar enabled and disabled;
2. project that evidence into the versioned semantic assertion contract;
3. keep native/local privacy evidence separate from external-delivery evidence;
4. expand the existing local implementation harness without introducing public-internet CI dependencies.

No new production DTO is implied.
