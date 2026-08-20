# ActivityPub Interoperability Boundary Inventory

Status: **ACTIVE inventory / semantic assertion-model work next**  
Inventory baseline: **2026-08-20**  
Architecture base: `4a1b15390d834b4e8e6078733c076376c12b312c`  
ActivityPods evidence baseline: `0ae54f0a898df3fb4e6516504c4e649669834d69`

## Purpose

This document closes the first ordered deliverable of ActivityPub Interoperability Hardening: identify the existing ActivityPods/SemApps/Fedify processing, authority, normalization, privacy, persistence, and test boundaries before defining a new cross-implementation semantic fixture contract.

It does **not** start interoperability from zero. The architecture repository already contains a local Dockerized real-implementation ActivityPub harness covering GoToSocial, Mastodon, and Akkoma. What is still missing is one explicit, versioned semantic assertion model shared across those proofs, lower-level fixtures, and the ActivityPods/SemApps application boundary.

No new public-internet dependency, NATS Core authorization, JetStream authorization, or ADSP gate weakening is implied.

## Re-audit corrections

### C1 — SemApps `1.1.4` provenance is identifiable

ActivityPods pins the relevant published SemApps middleware packages exactly to `1.1.4`.

The upstream SemApps release commit is:

`b8e1061c9d94cbaa42ef5c5bca87f38f0da9fb1` — `middleware-v1.1.4`

At that commit, `src/middleware/lerna.json` declares `1.1.4`, `@semapps/activitypub` declares `1.1.4`, and its SemApps middleware dependencies are moved to the same release line. The earlier claim that the release still needed an identifiable upstream commit is therefore closed.

The package metadata's historical `gitHead` field is not reliable as a release-source locator by itself; resolving it produces an older package state. Use the release commit plus the installed package/lockfile instead.

ActivityPods then patches the installed SemApps runtime at postinstall for ActivityPub local-delivery behavior and distributed LDP/JSON-LD/ontology locality/cache behavior. Executable interoperability tests therefore target **installed SemApps `1.1.4` after ActivityPods patches**, not current SemApps `master`.

### C2 — Signing and inbound verification authority are already established

#### Outbound

ActivityPods remains the private-key/signing authority. The internal `POST /api/internal/signatures/batch` path resolves an exact local account, exact ActivityPub actor, and SemApps RSA key material; requires owner/controller/actor-key linkage; requires an unambiguous signer-controlled key; derives `keyId` from signer-controlled linkage; and keeps the private key inside ActivityPods.

Fedify/the sidecar requests signatures. It does not become the key authority.

#### Inbound

Two intentional sidecar ingress modes exist:

1. **Fedify-verified ingress** — `InboundEnvelope.verification` explicitly carries `source: "fedify-v2"`, `actorUri`, and `verifiedAt`. The worker trusts only this explicit runtime provenance and does not redundantly invoke the native verifier.
2. **Sidecar-native verification** — raw inbound envelopes without that trusted marker go through the sidecar HTTP-signature verification path.

The local interop architecture deliberately exercises shared inbox requests through Fedify while keeping per-actor inboxes on the sidecar-native verifier.

Whichever verifier establishes the principal, the worker checks verified actor equality with `activity.actor`. The ActivityPods internal bridge independently rechecks `verifiedActorUri === activity.actor`, validates the destination as a trusted local inbox, and only then enters SemApps with duplicate signature validation skipped.

That skip is a bounded trusted-infrastructure handoff, not a generic signature bypass. Future fixtures need to **label and preserve** these established trust classes, not redesign them.

## Existing real-implementation interop harness

`fedify-sidecar/interop/ap/` already provides local-only Dockerized interoperability evidence using:

- the real sidecar;
- Redis and Redpanda;
- a deliberately small ActivityPods authority mock for actor metadata/internal signing;
- GoToSocial;
- Mastodon;
- Akkoma from pinned official source;
- local TLS without weakening production HTTPS requirements;
- outbound signed `Follow`;
- remote actor/key dereference;
- inbound `Accept` through the sidecar path;
- target-side persistence/media proofing for selected cases;
- fast non-Docker queue/runtime/signing compatibility tests.

`smoke:interop:ap` runs the normal GoToSocial + Mastodon lane; `smoke:interop:ap:extended` adds Akkoma. These are real implementations but local harness targets, not public-internet dependencies.

The next work is semantic convergence across these proof surfaces, not creation of interop testing from scratch.

## Boundary map

```text
remote HTTP request
  |
  v
[0] HTTP/body decoding + content negotiation
  |
  v
[1] authenticated ingress
    - Fedify verified OR sidecar-native HTTP-signature verification
    - explicit provenance
    - verified actor equality
  |
  v
[2] trusted sidecar -> ActivityPods handoff
    - trusted local inbox
    - actor equality re-check
    - duplicate SemApps signature verification skipped only here
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
    - not the internal federation bridge
```

A test that enters below the wire boundary must say so and cannot claim authentication, authority, visibility, or persistence evidence it bypassed.

## 0. HTTP/body boundary

SemApps ActivityPub/LDP routes use the SemApps middleware chain for URL/header parsing, content negotiation, JSON/Turtle/file parsing, and dataset metadata. ActivityPods' API gateway dispatches HTTP Signature, Solid/OIDC, ActivityPods JWT, and anonymous authentication as applicable.

**Remaining work:** one versioned cross-dialect media/body/context matrix. Full HTTP fixtures are required for assertions about headers, digest/signature bytes, content type, malformed bodies, and wire representation.

## 1. Transport authentication and provenance

The authority design is established. The shared assertion model should distinguish at least:

- `wire_fedify_verified`;
- `wire_native_verified`;
- `preverified_activitypods_bridge`;
- `parser_semantic_only`.

A direct `activitypub.inbox.post` with signature validation skipped is never wire-conformance evidence.

## 2. ActivityStreams structure

SemApps operates on ActivityStreams-shaped objects after HTTP parsing. ActivityPods layers feature behavior for actor metadata, app control, attribution, content warnings, collection views, hashtags, previews, long-form content, media, polls, quote posts, reply policies, search consent, trust evaluation, and other supported extensions.

The broad ActivityPods semantic/distributed probes and the real GoToSocial/Mastodon/Akkoma flows are useful evidence, but they are not yet one versioned semantic dialect corpus.

**Remaining work:** preserve and compare meaningful dialect differences such as scalar/array forms, IRI versus embedded identifiers, compact/aliased/expanded terms, absent optionals, unknown extensions, polymorphic link/attachment forms, and invalid authority-bearing shapes. Unknown extensions must never acquire authority or visibility merely because they parse.

## 3. JSON-LD and ontology normalization

ActivityPods uses SemApps `JsonLdService`, cached ActivityStreams/blocked contexts, and ActivityPods postinstall hardening for distributed JSON-LD/LDP/ontology locality/cache correctness.

**Remaining work:** assert semantic equivalence—canonical/expanded types, behavior-relevant predicates, alias/context equivalence, bounded unknown-term behavior, topology consistency, and preservation of remote-context security policy. Lexical JSON equality is not the default contract.

## 4. Authority and policy

Authentication alone is not the complete ActivityPods authority model. Existing controls cover local account/actor ownership, signer/key authority, remote-delivery authority, remote fetches, provider identity, sidecar handoff, and feature policy.

**Remaining work:** cross-implementation negative cases should declare authenticated principal and claimed authority, with outcomes such as `accept`, `reject`, or deliberately bounded `ignore_extension`.

## 5. Visibility, addressing, WebACL, and blind-address privacy

This layer has an important split that must not be blurred.

### SemApps/native/local behavior

SemApps recipient discovery and WebACL side effects are part of the native ActivityPub path. Exact SemApps `1.1.4` recipient discovery reads `to`, `bto`, `cc`, and `bcc`, while the native outbox can continue carrying the same Activity bytes.

The APDM Delivery Plan contract explicitly states that its blind-address repair **does not by itself repair SemApps native/local persistence or delivery behavior**. Therefore this inventory does not claim that native/local persisted Activity representations are already free of `bto`/`bcc` leakage.

That native/local surface is an explicit privacy/interoperability test target.

### APDM external Delivery Plan behavior

For external/Fedify delivery, ActivityPods uses unsanitized blind-address input only for authoritative recipient planning and constructs a sanitized Delivery Plan activity with `bto`/`bcc` removed recursively. The sidecar rejects a Delivery Plan that still contains blind-address fields. Private routing information is handled separately.

Likewise, APDM's `audience` fail-closed behavior belongs to recipient-plan/delivery compatibility. It must not be generalized into a claim that every source Activity is rejected before native/local persistence.

### Required assertions

Relevant cases need separately scoped outcomes for:

1. semantic visibility/recipient decision;
2. external Delivery Plan representation, where applicable;
3. native/local persisted or application-visible representation, where applicable;
4. WebACL/authorization behavior.

A passing external-handoff test cannot be used as evidence that native/local persistence is private.

## 6. Persistence and ActivityPub side effects

Accepted activities can become remote resources, collection/inbox membership, events, follow/reply/share/like state, ACL state, and other durable behavior.

Existing local target proofs already inspect persistence for selected flows, including target-specific media storage/representation.

**Remaining work:** only cases executing this layer may claim behavioral interoperability. Retryable flows should assert idempotency/replay where relevant. Native/local blind-address persistence needs explicit evidence rather than inference from APDM external-delivery tests.

## 7. Application-consumption boundary

There is no single production `NormalizedActivity` DTO that ActivityPods applications consume after federation.

The application-facing substrate is SemApps/ActivityPods LDP + JSON-LD resources plus ActivityPods-supported feature/API semantics. The internal federation bridge is infrastructure, not the public normalized application contract.

This finding remains valid after the re-audit.

### Consequence

The next deliverable should be a **test-facing semantic assertion contract**, not a new production serialization layer. It should describe facts applications can rely on, such as:

- canonical activity/resource identity;
- semantic type(s);
- actor/attribution identity;
- object/target identity;
- visibility class with boundary-specific privacy expectations;
- supported content/attachment/extension facts;
- extension disposition;
- authorization outcome without leaking ACL internals;
- evidence provenance and assertion boundary.

## Evidence inventory and remaining work

| Layer | Established evidence | Remaining work |
| --- | --- | --- |
| HTTP/body | SemApps middleware; ActivityPods gateway; local real-implementation harness | Versioned media/body/context dialect cases |
| Outbound signing | ActivityPods internal signing API and exact account/actor/key authority chain | Preserve; add targeted negative interop cases |
| Inbound verification | Fedify provenance, native fallback, worker actor check, ActivityPods bridge re-check | Encode provenance classes; do not redesign authority |
| ActivityStreams | SemApps actions, ActivityPods feature proofs, GoToSocial/Mastodon/Akkoma flows | Shared semantic/dialect schema |
| JSON-LD/ontology | JsonLdService, cached contexts, distributed hardening, semantic proof | Shared semantic-equivalence assertions |
| Authority/policy | Signing/provider/delivery/remote-fetch hardening | Cross-implementation negative extension cases |
| External delivery privacy | APDM sanitized Delivery Plan + sidecar rejection | Integrate into shared assertion model |
| Native/local privacy | SemApps/WebACL behavior exists; APDM contract explicitly does not prove blind-address repair here | **Direct persistence/application-visible privacy evidence required** |
| Persistence | SemApps side effects + target-specific persistence proofs | Shared replay/idempotency-aware cases |
| App consumption | LDP/JSON-LD + ActivityPods feature APIs | **One explicit versioned semantic assertion model** |

## Remaining gaps

### G1 — No single shared semantic assertion model

Many assertions already exist. The missing piece is one small versioned contract telling every harness/fixture which semantic facts are comparable and which boundary produced them.

### G2 — No universal strict ActivityStreams schema gate

SemApps uses targeted validation and handlers rather than one universal schema. Interop work should characterize/harden real compatibility without prematurely rejecting legitimate dialects.

### G3 — Native/local versus external-delivery privacy must be tested separately

The external Delivery Plan has explicit blind-address sanitization. That does not establish equivalent privacy for SemApps native/local persistence/application-visible resources. The shared model must keep those scopes distinct and add direct native/local evidence.

### G4 — Existing implementation-specific proofs need semantic convergence

GoToSocial, Mastodon, and Akkoma already have useful target-specific proof logic. The shared model should project those proofs into common semantic outcomes while retaining implementation-specific diagnostics.

## Established invariants, not gaps

- SemApps middleware `1.1.4` has an identifiable upstream release commit; the installed/patched runtime remains executable authority.
- ActivityPods owns private keys and outbound signing authority.
- Fedify-verified and sidecar-native verification are explicit ingress modes.
- actor equality is checked before forwarding and rechecked at the ActivityPods bridge.
- duplicate signature verification is skipped only at the authenticated preverified bridge boundary.
- local GoToSocial/Mastodon/Akkoma interop testing already exists.
- APDM external Delivery Plan privacy guarantees must not be generalized to native/local persistence.

## Ordered next step

Define the **stable semantic interoperability assertion model** before expanding a new fixture metadata/schema and seed corpus.

It must be reusable by the existing local implementation harness, authenticated wire tests, Fedify/native ingress tests, JSON-LD semantic tests, boundary-scoped privacy/visibility tests, persistence tests, and application-boundary assertions.

No new production DTO or public-internet dependency is implied.