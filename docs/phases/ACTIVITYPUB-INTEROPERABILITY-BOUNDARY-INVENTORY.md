# ActivityPub Interoperability Boundary Inventory

Status: **ACTIVE inventory / semantic assertion-model work next**  
Inventory baseline: **2026-08-20**  
Architecture base: `4a1b15390d834b4e8e6078733c076376c12b312c`  
ActivityPods evidence baseline: `0ae54f0a898df3fb4e6516504c4e649669834d69`

## Purpose

This document inventories the existing ActivityPods/SemApps/Fedify processing, authority, normalization, privacy, persistence, and interoperability-test boundaries before a shared cross-implementation semantic assertion contract is introduced.

It does **not** start interoperability from zero. `fedify-sidecar/interop/ap/` already contains a local Dockerized real-implementation harness for GoToSocial, Mastodon, and Akkoma. The next work is to converge those proofs on one versioned semantic contract and then expand the same harness to additional ActivityPub implementations.

No public-internet CI dependency, NATS Core authorization, JetStream authorization, or ADSP gate weakening is implied.

The target additions in this inventory are **additive**. They do not replace the implementation families already required by `ACTIVITYPUB-INTEROPERABILITY-HARDENING.md`; that active phase remains the authoritative coverage taxonomy.

## Re-audit corrections

### C1 — SemApps `1.1.4` provenance is identifiable

ActivityPods pins the relevant published SemApps middleware packages exactly to `1.1.4`. The upstream release commit is:

`b8e1061c9d94cbaa42ef5c5bca87f38f0da9fb1` — `middleware-v1.1.4`

At that commit, `src/middleware/lerna.json` and `@semapps/activitypub` declare `1.1.4`, and the SemApps middleware dependencies move to the same release line. The package metadata's historical `gitHead` is not a reliable release-source locator by itself.

ActivityPods patches the installed SemApps runtime at postinstall for ActivityPub local-delivery behavior and distributed LDP/JSON-LD/ontology locality/cache behavior. Executable interoperability tests therefore target **installed SemApps `1.1.4` after ActivityPods patches**, not current SemApps `master`.

### C2 — Pod/user signing authority is established; service-actor signing is not yet uniform across every runtime path

#### ActivityPods pod/user actors

For ActivityPods-owned pod/user actors, ActivityPods is the private-key/signing authority. `POST /api/internal/signatures/batch` resolves an exact local account, exact ActivityPub actor, and SemApps RSA key material; requires owner/controller/actor-key linkage; requires an unambiguous signer-controlled key; derives `keyId` from signer-controlled linkage; and keeps the private key inside ActivityPods.

This is an established invariant for pod/user federation signing.

#### Sidecar-owned service actors

`SidecarLocalSigningService` intentionally owns RSA keys for configured sidecar service identities such as relay/provider actors. `FedifyFederationAdapter` uses that local signer for its configured sidecar service actors rather than asking ActivityPods to sign.

However, this is **not yet a runtime-wide exclusive service-actor signer invariant**. Replies backfill and origin reconciliation are currently constructed with the shared ActivityPods `SigningClient` while defaulting their authenticated-GET signer identity to the relay actor. Their remote GETs therefore ask `/api/internal/signatures/batch` to sign as an identity that the Fedify adapter otherwise treats as sidecar-owned. Under ActivityPods' exact local-account/actor enforcement, that request either requires an ActivityPods-owned relay identity or fails.

Therefore the current evidence supports these narrower statements:

- ActivityPods exclusively owns signing for ActivityPods pod/user actors;
- `FedifyFederationAdapter` locally signs configured sidecar service actors;
- replies-backfill/origin-reconciliation signed GETs are a **known signer-routing inconsistency** that must be resolved before claiming runtime-wide service-actor authority separation;
- no test may infer a universal signer from actor URI alone until that gap is closed.

The semantic assertion model must carry both `actorAuthorityClass` and `signerPath`, rather than pretending the two are currently identical across all code paths.

### C3 — Fedify wire verification, trusted enqueue provenance, and actor authentication are distinct facts

Two real wire-verification modes exist:

1. **Fedify wire verification** for requests actually verified by Fedify before enqueue;
2. **sidecar-native HTTP-signature verification** for raw inbound requests that have not crossed a trusted verification boundary.

`InboundEnvelope.verification.source: "fedify-v2"` is **not unique proof of Fedify wire verification**. Origin reconciliation, replies backfill, and an authenticated benchmark path also construct envelopes carrying that marker.

More importantly, reconciliation/backfill do **not** cryptographically authenticate the ActivityPub actor merely by copying a fetched object's `actor`/`attributedTo` into both `activity.actor` and `verification.actorUri`. The worker equality check is tautological for those synthesized envelopes. HTTPS and an authenticated/signed outbound GET establish properties of the fetch transaction and origin endpoint; they do not by themselves prove that a returned actor claim was signed by that actor.

Accordingly:

- actual Fedify/native wire verification may claim an authenticated remote actor when their verifier establishes it;
- reconciliation/backfill may claim a **trusted internal enqueue source** and remote-origin fetch evidence, but **not authenticated actor provenance** merely from the synthetic envelope marker;
- benchmark injection may claim an authenticated benchmark caller/path where applicable, but not remote-actor authentication unless separately proven;
- the ActivityPods bridge equality re-check protects against mutation between trusted stages but cannot upgrade an unauthenticated synthetic actor claim into authenticated actor evidence.

The existing `fedify-v2` marker is therefore an overloaded trusted-envelope signal and must not be used as the semantic assertion model's verifier identity.

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

The next harness expansion will use this same framework for additional implementations rather than create isolated one-off test systems.

## Boundary map

```text
remote HTTP request
  |
  v
[0] HTTP/body decoding + content negotiation
  |
  v
[1] wire authentication, when present
    - actual Fedify verification
    - sidecar-native HTTP-signature verification
  |
  +--> trusted internal producers
  |      - reconciliation / replies backfill
  |      - authenticated benchmark injection
  |      - trusted enqueue != authenticated remote actor
  |
  v
[2] trusted sidecar -> ActivityPods handoff
    - trusted local inbox
    - actor-value equality re-check
    - does not upgrade provenance established above
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

The assertion contract must model facts separately rather than encode a single overloaded `source` label.

Recommended inbound evidence classes:

- `wire_fedify_verified` — independently proven Fedify wire-verification path;
- `wire_native_verified` — sidecar-native HTTP-signature verification;
- `trusted_synthetic_reconciliation` — internal reconciliation enqueue; no authenticated actor claim by default;
- `trusted_synthetic_backfill` — internal replies-backfill enqueue; no authenticated actor claim by default;
- `authenticated_benchmark_injection` — benchmark-only path, never production interoperability evidence;
- `trusted_activitypods_bridge` — authenticated sidecar-to-ActivityPods handoff preserving, not upgrading, upstream provenance;
- `parser_semantic_only` — no transport/authentication claim.

Recommended outbound signer evidence separates:

- `actorAuthorityClass`: `activitypods_pod_actor | sidecar_service_actor | unknown`;
- `signerPath`: `activitypods_internal_api | sidecar_local_signer | other_test_only`.

Until the signed-fetch inconsistency is fixed, `sidecar_service_actor` must not mechanically imply `sidecar_local_signer`.

A direct SemApps inbox call with signature validation skipped is never wire-conformance evidence. A `source: "fedify-v2"` value without independent entry-point/runtime evidence is not enough to establish `wire_fedify_verified`.

## 2. ActivityStreams structure

SemApps operates on ActivityStreams-shaped objects after HTTP parsing. ActivityPods layers feature behavior for actor metadata, app control, attribution, content warnings, collections, hashtags, previews, long-form content, media, polls, quote posts, reply policies, search consent, trust evaluation, and supported extensions.

**Remaining work:** compare meaningful dialect differences such as scalar/array forms, IRI versus embedded identifiers, compact/aliased/expanded terms, absent optionals, unknown extensions, polymorphic links/attachments, and invalid authority-bearing shapes. Unknown extensions must never acquire authority or visibility merely because they parse.

## 3. JSON-LD and ontology normalization

ActivityPods uses SemApps `JsonLdService`, cached ActivityStreams/blocked contexts, and ActivityPods postinstall hardening for distributed JSON-LD/LDP/ontology locality/cache correctness.

**Remaining work:** assert semantic equivalence—canonical/expanded types, behavior-relevant predicates, alias/context equivalence, bounded unknown-term behavior, topology consistency, and preservation of remote-context security policy. Lexical JSON equality is not the default contract.

## 4. Authority and policy

Authentication is not the complete ActivityPods authority model. Existing controls cover local account/actor ownership, signer/key authority, remote-delivery authority, remote fetches, provider identity, sidecar handoff, and feature policy.

Synthetic origin/backfill data needs its own authority treatment: trusted scheduling/fetch origin does not automatically make every actor claim authoritative.

**Remaining work:** negative cases must declare the authenticated principal (if any), claimed actor, origin evidence, signer path where relevant, and expected `accept | reject | ignore_extension` outcome.

## 5. Visibility, addressing, WebACL, and blind-address privacy

This layer must remain split.

### SemApps/native/local behavior

Exact SemApps `1.1.4` recipient discovery reads `to`, `bto`, `cc`, and `bcc`, while the native outbox can continue carrying the source Activity representation. The APDM Delivery Plan contract explicitly states that its blind-address repair **does not by itself repair SemApps native/local persistence or delivery behavior**.

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

Therefore the next deliverable is a **test-facing semantic assertion contract**, not a new production serialization layer.

It should describe at least:

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
- whether actor provenance is authenticated, origin-bound, self-claimed, or absent;
- actor authority class and actual signer path;
- persistence/application-visible outcome.

## Evidence inventory

| Layer | Established evidence | Remaining work |
| --- | --- | --- |
| HTTP/body | SemApps middleware; ActivityPods gateway; local implementation harness | Versioned media/body/context dialect cases |
| Pod/user outbound signing | exact ActivityPods account/actor/key authority chain | Preserve + negative interop cases |
| Service-actor signing | sidecar local signer in Fedify adapter | **Resolve replies-backfill/origin-reconciliation signed-fetch inconsistency** |
| Wire verification | actual Fedify path + native verifier | Encode independently from overloaded envelope marker |
| Synthetic ingress | trusted internal enqueue/origin fetch | **Do not claim authenticated actor without separate proof; harden authority semantics** |
| ActivityStreams | SemApps actions, ActivityPods feature probes, GoToSocial/Mastodon/Akkoma | Shared semantic/dialect schema |
| JSON-LD/ontology | JsonLdService, cached contexts, distributed hardening | Shared semantic-equivalence assertions |
| External delivery privacy | APDM sanitized Delivery Plan + sidecar rejection | Integrate into shared model |
| Native/local privacy | SemApps/WebACL path exists | **Direct persistence/application-visible privacy evidence** |
| Persistence | SemApps side effects + target-specific proofs | Shared replay/idempotency-aware assertions |
| App consumption | LDP/JSON-LD + ActivityPods feature APIs | **One explicit versioned semantic assertion model** |

## Remaining gaps

### G1 — No single shared semantic assertion model

Existing assertions need one small versioned contract defining which semantic facts are comparable and which boundary produced them.

### G2 — Service-actor signed-fetch routing is inconsistent

Fedify delivery can sign sidecar service actors locally, while replies backfill and origin reconciliation currently use ActivityPods `SigningClient` for relay-authenticated GETs. Resolve this before claiming runtime-wide service-actor signer separation.

### G3 — `fedify-v2` is an overloaded trusted-envelope marker

It cannot serve as verifier provenance. Split or supplement it with explicit producer/verifier metadata, and keep test evidence independent from that overloaded field.

### G4 — Synthetic origin/backfill actor claims are not authenticated by equality alone

The producer currently copies a fetched actor/attribution claim into both the synthetic activity and its verification metadata. Equality downstream therefore cannot prove the actor. Define and enforce the correct origin/authority policy before allowing these paths to claim authenticated actor evidence.

### G5 — No universal strict ActivityStreams schema gate

SemApps uses targeted validation/handlers rather than one universal schema. Characterize real compatibility without prematurely rejecting legitimate dialects.

### G6 — Native/local versus external-delivery privacy require separate evidence

External blind-address sanitization does not establish native/local persistence privacy.

### G7 — Existing implementation-specific proofs need semantic convergence and expansion

GoToSocial, Mastodon, and Akkoma should project into the shared model while retaining target-specific diagnostics.

The expansion set is **non-exhaustive and additive**. It includes the active phase's already-required implementation families—**WordPress ActivityPub, Lemmy/PieFed, and Mobilizon**—plus the newly requested **Bonfire, Castopod, Emissary/Bandwagon, Friendica, Funkwhale, Ghost ActivityPub, Loops, Owncast, PeerTube, Pixelfed, Misskey, Vernissage**, and the **Write.as family**. Where the exact service is hosted-only, a local open-source relative such as WriteFreely may provide local dialect coverage but must not be mislabeled as exact Write.as conformance. **Micro.blog** and exact hosted **Write.as** remain fixture/explicit opt-in external-conformance targets rather than required public-internet CI dependencies.

The target taxonomy in `ACTIVITYPUB-INTEROPERABILITY-HARDENING.md` continues to govern any additional required families not repeated here.

## Established invariants, not gaps

- SemApps middleware `1.1.4` has an identifiable upstream release commit; the installed/patched runtime is executable authority.
- ActivityPods owns private keys/signing authority for ActivityPods pod/user actors.
- Fedify adapter delivery has an explicit sidecar-local signer for configured sidecar service actors; this is not yet generalized to every signed-fetch path.
- actual Fedify wire verification and sidecar-native verification are real ingress modes; `source: "fedify-v2"` alone is not verifier proof.
- actor equality checks preserve an already-established principal but do not create one for self-claimed synthetic data.
- local GoToSocial/Mastodon/Akkoma interoperability testing already exists.
- APDM external Delivery Plan privacy guarantees must not be generalized to native/local persistence.

## Ordered next work

1. Close the two newly identified authority inconsistencies: service-actor signed-fetch routing and synthetic-origin actor provenance.
2. Define the stable **semantic interoperability assertion model**.
3. Project the existing GoToSocial/Mastodon/Akkoma proofs into it.
4. Expand the local real-implementation matrix in validated batches, preserving every family required by the active phase and adding the new targets above.
5. Pin official versions/commits and retain local-only CI for required lanes.
6. Add hosted-only dialect evidence as fixtures or explicit opt-in external conformance, never required public-internet CI.

No new production DTO is implied.