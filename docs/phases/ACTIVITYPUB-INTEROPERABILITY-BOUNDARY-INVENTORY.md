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

### C2 — Signing authority is actor-class scoped, not globally ActivityPods-only

#### Pod/user actors

For ActivityPods-owned pod/user actors, ActivityPods remains the private-key/signing authority. The internal `POST /api/internal/signatures/batch` path resolves an exact local account, exact ActivityPub actor, and SemApps RSA key material; requires owner/controller/actor-key linkage; requires an unambiguous signer-controlled key; derives `keyId` from signer-controlled linkage; and keeps the private key inside ActivityPods.

For these actors, Fedify/the sidecar requests signatures and does not become the key authority.

#### Sidecar-owned service actors

The sidecar also has an intentional, separate signing authority for configured **sidecar-owned service actors** such as the relay/provider class. `SidecarLocalSigningService` generates RSA key pairs for those identities, persists them in Redis, exposes only the public key through actor documents, and signs their outbound requests locally. `FedifyFederationAdapter` routes configured sidecar service actors through this local signer instead of ActivityPods.

Therefore the correct invariant is:

- ActivityPods exclusively owns private keys/signing for ActivityPods pod/user actors;
- the sidecar exclusively owns private keys/signing for explicitly configured sidecar service actors;
- actor class/identity determines the authority boundary;
- no generic fallback may silently move a pod/user actor into the sidecar-owned key domain.

Future interoperability assertions must carry the actor authority class and prove the appropriate signer was used.

### C3 — Inbound verification provenance has multiple preverified producers

Two wire-verification paths remain intentional:

1. **Fedify wire verification** for requests actually verified by the Fedify runtime before enqueue;
2. **sidecar-native HTTP-signature verification** for raw inbound envelopes that have not already crossed a trusted verification boundary.

However, `InboundEnvelope.verification.source: "fedify-v2"` is **not by itself proof that Fedify verified a remote wire request**. The current runtime also uses that marker for internally synthesized/preverified activities, including origin reconciliation and replies backfill, and an authenticated benchmark path can construct equivalent preverified envelopes. `InboundWorker` treats the marker as preverified and skips native verification.

Those producers are not automatically unsafe: they enter through bounded internal/authenticated paths and still carry actor identity that is checked before forwarding. But the marker is overloaded and cannot be used by the interoperability assertion model as a unique verifier provenance claim.

The local interop architecture deliberately exercises shared inbox requests through actual Fedify wire verification while keeping per-actor inboxes on the sidecar-native verifier.

Whichever trusted path establishes the principal, the worker checks verified actor equality with `activity.actor`. The ActivityPods internal bridge independently rechecks `verifiedActorUri === activity.actor`, validates the destination as a trusted local inbox, and only then enters SemApps with duplicate signature validation skipped.

That skip is a bounded trusted-infrastructure handoff, not a generic signature bypass. Future fixtures need to preserve the difference between wire-verified, internally synthesized/preverified, benchmark-only, bridge-only, and parser-only evidence. They must **not infer actual Fedify wire verification solely from `source: "fedify-v2"`**.

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
    - actual Fedify wire verification OR sidecar-native HTTP-signature verification
    - explicit test-entry/runtime provenance
    - verified actor equality
  |
  +--> trusted internal synthetic/preverified producers
  |      - reconciliation/backfill classes
  |      - authenticated benchmark class (non-production evidence)
  |      - must not be mislabeled as Fedify wire verification
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

## 1. Transport authentication, signer authority, and provenance

The authority design is established but must be represented with enough precision to avoid collapsing distinct trust paths.

The shared assertion model should distinguish at least:

- `wire_fedify_verified` — only when the harness/runtime has evidence that Fedify verified the remote HTTP request;
- `wire_native_verified` — sidecar-native HTTP-signature verification;
- `preverified_synthetic_reconciliation` — trusted internally synthesized reconciliation activity;
- `preverified_synthetic_backfill` — trusted internally synthesized replies/backfill activity;
- `preverified_benchmark` — authenticated benchmark-only preverified ingress, never production interoperability evidence;
- `preverified_activitypods_bridge` — authenticated trusted sidecar-to-ActivityPods handoff after actor equality checks;
- `parser_semantic_only` — no transport-authentication claim.

The model must also carry signer authority class for outbound evidence:

- `activitypods_pod_actor`;
- `sidecar_service_actor`.

A direct `activitypub.inbox.post` with signature validation skipped is never wire-conformance evidence. A `source: "fedify-v2"` value without independent entry-point/runtime evidence is only a preverified marker and cannot establish the `wire_fedify_verified` assertion class.

## 2. ActivityStreams structure

SemApps operates on ActivityStreams-shaped objects after HTTP parsing. ActivityPods layers feature behavior for actor metadata, app control, attribution, content warnings, collection views, hashtags, previews, long-form content, media, polls, quote posts, reply policies, search consent, trust evaluation, and other supported extensions.

The broad ActivityPods semantic/distributed probes and the real GoToSocial/Mastodon/Akkoma flows are useful evidence, but they are not yet one versioned semantic dialect corpus.

**Remaining work:** preserve and compare meaningful dialect differences such as scalar/array forms, IRI versus embedded identifiers, compact/aliased/expanded terms, absent optionals, unknown extensions, polymorphic link/attachment forms, and invalid authority-bearing shapes. Unknown extensions must never acquire authority or visibility merely because they parse.

## 3. JSON-LD and ontology normalization

ActivityPods uses SemApps `JsonLdService`, cached ActivityStreams/blocked contexts, and ActivityPods postinstall hardening for distributed JSON-LD/LDP/ontology locality/cache correctness.

**Remaining work:** assert semantic equivalence—canonical/expanded types, behavior-relevant predicates, alias/context equivalence, bounded unknown-term behavior, topology consistency, and preservation of remote-context security policy. Lexical JSON equality is not the default contract.

## 4. Authority and policy

Authentication alone is not the complete ActivityPods authority model. Existing controls cover local account/actor ownership, signer/key authority, remote-delivery authority, remote fetches, provider identity, sidecar handoff, sidecar service-actor identity, and feature policy.

**Remaining work:** cross-implementation negative cases should declare authenticated principal, signer authority class where relevant, and claimed authority, with outcomes such as `accept`, `reject`, or deliberately bounded `ignore_extension`.

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
- evidence provenance and assertion boundary;
- outbound signer authority class.

## Evidence inventory and remaining work

| Layer | Established evidence | Remaining work |
| --- | --- | --- |
| HTTP/body | SemApps middleware; ActivityPods gateway; local real-implementation harness | Versioned media/body/context dialect cases |
| Outbound signing | ActivityPods signer for pod/user actors; sidecar-local signer for explicitly configured service actors | Preserve actor-class separation; add targeted negative interop cases |
| Inbound verification | Actual Fedify wire verification, native fallback, internal preverified producers, worker actor check, ActivityPods bridge re-check | Encode provenance classes; stop treating `fedify-v2` marker alone as wire-verifier proof |
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

### G2 — `fedify-v2` is currently an overloaded preverified marker

The marker is used by actual Fedify-verified wire ingress and by trusted synthetic/benchmark producers. It remains useful to the worker as a preverified signal inside bounded paths, but interoperability evidence cannot equate it with a unique verifier source. The assertion model must use independent entry-point/runtime provenance, and a later runtime-hardening slice may split the marker into explicit producer classes without weakening existing actor checks.

### G3 — No universal strict ActivityStreams schema gate

SemApps uses targeted validation and handlers rather than one universal schema. Interop work should characterize/harden real compatibility without prematurely rejecting legitimate dialects.

### G4 — Native/local versus external-delivery privacy must be tested separately

The external Delivery Plan has explicit blind-address sanitization. That does not establish equivalent privacy for SemApps native/local persistence/application-visible resources. The shared model must keep those scopes distinct and add direct native/local evidence.

### G5 — Existing implementation-specific proofs need semantic convergence

GoToSocial, Mastodon, and Akkoma already have useful target-specific proof logic. The shared model should project those proofs into common semantic outcomes while retaining implementation-specific diagnostics.

## Established invariants, not gaps

- SemApps middleware `1.1.4` has an identifiable upstream release commit; the installed/patched runtime remains executable authority.
- ActivityPods owns private keys/signing authority for ActivityPods pod/user actors.
- explicitly configured sidecar service actors have a separate sidecar-local key/signing authority and must never be confused with pod/user actors.
- actual Fedify wire verification and sidecar-native verification are intentional ingress modes, but the current `fedify-v2` envelope marker is not unique wire-verifier provenance.
- actor equality is checked before forwarding and rechecked at the ActivityPods bridge.
- duplicate signature verification is skipped only at authenticated/trusted preverified boundaries.
- local GoToSocial/Mastodon/Akkoma interop testing already exists.
- APDM external Delivery Plan privacy guarantees must not be generalized to native/local persistence.

## Ordered next step

Define the **stable semantic interoperability assertion model** before expanding a new fixture metadata/schema and seed corpus.

It must be reusable by the existing local implementation harness, authenticated wire tests, Fedify/native ingress tests, trusted synthetic ingress tests, JSON-LD semantic tests, boundary-scoped privacy/visibility tests, persistence tests, and application-boundary assertions.

The next implementation expansion should then extend the existing local-only real-implementation harness, under the same assertion contract, to additional ActivityPub platforms rather than creating isolated one-off harnesses.

No new production DTO or public-internet dependency is implied.