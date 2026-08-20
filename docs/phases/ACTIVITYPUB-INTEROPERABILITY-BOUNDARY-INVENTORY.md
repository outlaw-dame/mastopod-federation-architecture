# ActivityPub Interoperability Boundary Inventory

Status: **ACTIVE inventory / semantic assertion-model work next**  
Inventory baseline: **2026-08-20**  
Architecture base: `4a1b15390d834b4e8e6078733c076376c12b312c`  
ActivityPods evidence baseline: `0ae54f0a898df3fb4e6516504c4e649669834d69`

## Purpose

This document closes the first ordered deliverable of ActivityPub Interoperability Hardening: identify the existing ActivityPods/SemApps/Fedify processing, authority, normalization, and test boundaries before defining a new cross-implementation semantic fixture contract.

It does **not** start interoperability from zero. The architecture repository already contains a local Dockerized real-implementation ActivityPub harness covering GoToSocial, Mastodon, and Akkoma. That harness remains valid evidence. What is still missing is one explicit, versioned semantic assertion model that can be shared across those implementation proofs, lower-level fixtures, and the ActivityPods/SemApps application-consumption boundary.

This document does not authorize a new public-internet test dependency, NATS Core, JetStream, or any weakening of the frozen ADSP promotion gates.

## Corrections established by the repository-wide re-audit

The initial inventory pass was too conservative in two places. Both are corrected here.

### C1 — SemApps `1.1.4` source provenance is identifiable

`pod-provider/backend/package.json` pins the relevant published SemApps middleware packages (`@semapps/activitypub`, `@semapps/jsonld`, `@semapps/ldp`, `@semapps/ontologies`, `@semapps/webacl`, and related packages) exactly to `1.1.4`.

The upstream SemApps repository contains release commit:

`b8e1061c9d94cbaa42ef5c5bca87f38f0da9fb1` — `middleware-v1.1.4`

At that commit:

- `src/middleware/lerna.json` declares version `1.1.4`;
- `src/middleware/packages/activitypub/package.json` declares `@semapps/activitypub` version `1.1.4`;
- its SemApps middleware dependencies are changed to the same `1.1.4` release line.

Therefore the earlier statement that release provenance still needed to be tied to an exact upstream commit is no longer a gap.

One caution remains: the `gitHead` field embedded in that package metadata is not reliable release provenance by itself; resolving that historical SHA yields an older package state. The release commit above plus the installed package/lockfile are the useful provenance anchors.

ActivityPods also applies postinstall patches to the installed SemApps runtime, including ActivityPub local-delivery behavior and distributed LDP/JSON-LD/ontology locality/cache behavior. Consequently executable interoperability tests must still run against the ActivityPods-installed SemApps `1.1.4` tree **after ActivityPods patches**, not current SemApps `master`.

### C2 — ActivityPods/Fedify signing and inbound verification authority are established, not missing

The current architecture already has multiple complementary controls.

#### Outbound authority

ActivityPods remains the only private-key/signing authority. Its internal `POST /api/internal/signatures/batch` contract:

- authenticates the internal caller;
- requires the requested actor to bind to an exact local ActivityPods account via `auth.account.findByWebId`;
- resolves that exact ActivityPub actor via `activitypub.actor.get`;
- obtains RSA material from SemApps `keys.getOrCreateWebIdKeys` in the account dataset;
- requires owner and controller to equal the actor;
- requires the signing key to be attached through the actor's public-key linkage;
- requires one unambiguous signer-controlled candidate;
- derives `keyId` from that signer-controlled linkage rather than caller input;
- never exports the private key to Fedify/the sidecar.

Fedify/sidecar requests signatures; ActivityPods owns signing authority.

#### Inbound authority

There are two intentional verified-ingress modes in the sidecar runtime:

1. **Fedify-verified ingress.** `InboundEnvelope.verification` is an explicit typed trust marker with `source: "fedify-v2"`, `actorUri`, and `verifiedAt`. The inbound worker trusts only envelopes carrying that explicit runtime provenance and does not redundantly run its native signature verifier for them.
2. **Sidecar-native fallback verification.** Raw inbound envelopes without that trusted marker go through the sidecar's HTTP-signature verification path.

The architecture's local interop documentation additionally records that shared-inbox requests are exercised through Fedify while per-actor inboxes intentionally remain on the sidecar-native verifier. This is an architectural choice, not an accidental split.

Whichever verifier establishes the principal, the worker requires the verified actor to match `activity.actor`. The ActivityPods internal bridge then independently requires the supplied `verifiedActorUri` to match the activity actor and requires the target inbox to be a trusted local inbox before calling the normal SemApps inbox with duplicate signature validation skipped.

That final `skipSignatureValidation` is therefore a bounded trusted-infrastructure handoff, not a generic bypass.

The remaining interoperability work must **preserve and label** these provenance classes; it does not need to invent this authority boundary again.

## Existing real-implementation interoperability harness

The architecture repository already has `fedify-sidecar/interop/ap/` with a local-only Dockerized matrix.

It currently exercises:

- the real sidecar;
- Redis and Redpanda;
- an ActivityPods authority mock limited to actor metadata and the internal signing contract;
- GoToSocial;
- Mastodon;
- Akkoma from pinned official source;
- local TLS without weakening production HTTPS requirements;
- outbound signed `Follow`;
- remote actor/key dereference;
- remote `Accept` returning through the sidecar inbound path;
- target-side persistence/media verification for the supported proof cases;
- a fast non-Docker lane for queue/runtime/signing compatibility.

`smoke:interop:ap` runs the default local GoToSocial + Mastodon proof lane and `smoke:interop:ap:extended` adds Akkoma. These tests do not rely on public federation endpoints.

This means the next phase is **not** “start third-party interoperability testing.” It is to make the semantic expectations across the existing proof surfaces explicit and reusable.

## End-to-end boundary map

```text
remote HTTP request
  |
  v
[0] HTTP/body decoding + content negotiation
  |
  v
[1] transport integrity + authenticated principal
    - Fedify-verified ingress OR sidecar-native HTTP-signature verification
    - explicit verification provenance
    - activity.actor equality
  |
  v
[2] trusted sidecar -> ActivityPods handoff
    - trusted local inbox
    - verifiedActorUri equality re-check
    - duplicate SemApps signature verification skipped only here
  |
  v
[3] ActivityPub envelope / ActivityStreams structural handling
    - actor/object/type/recipient shapes
    - string vs object identifiers
    - supported extension surface
  |
  v
[4] JSON-LD + ontology semantic normalization
    - context loading
    - term/type expansion
    - RDF/JSON-LD equivalence where relevant
    - ActivityPods cached/local ontology contexts
  |
  +----------------------------+
  |                            |
  v                            v
[5a] authority/policy       [5b] visibility/ACL
    - actor authority           - public addressing
    - local actor authority     - recipients
    - remote-fetch trust        - WebACL rights
    - extension fail-closed     - blind-address privacy
  |                            |
  +-------------+--------------+
                |
                v
[6] persistence + ActivityPub side effects
    - remote activity/object storage
    - collections/inbox/outbox effects
    - follow/reply/share/etc. handlers
                |
                v
[7] stable application-consumption boundary
    - SemApps LDP/JSON-LD resource representation
    - ActivityPods feature/API semantics layered on those resources
    - NOT the internal federation-sidecar bridge itself
```

A lower-level parser/semantic case may deliberately enter below the wire boundary, but it must be labelled and cannot claim transport, authority, ACL, or persistence evidence that it bypassed.

## 0. HTTP/body decoding and route boundary

SemApps ActivityPub and LDP routes disable Moleculer-Web's default body parser and use the SemApps middleware chain for URL/header parsing, content negotiation, JSON/Turtle/file parsing, and dataset metadata. ActivityPods' API gateway supplies authentication dispatch for HTTP Signature, Solid/OIDC, ActivityPods JWT, and anonymous access where applicable.

### Remaining interoperability work

The existing implementation/proof suites do not form one versioned cross-dialect media-type/body/context matrix. Full HTTP fixtures are therefore still useful when the assertion concerns content type, headers, digest/signature bytes, malformed bodies, or equivalent wire representations.

## 1. Transport authentication and actor provenance

This boundary is already architecturally established by the Fedify/native verifier split described in C2.

### Required assertion classes

The semantic fixture model should distinguish at least:

- `wire_fedify_verified` — verified by the trusted Fedify runtime and represented by explicit `fedify-v2` envelope provenance;
- `wire_native_verified` — verified by the sidecar-native HTTP-signature path;
- `preverified_activitypods_bridge` — the authenticated internal handoff after one of the two trusted sidecar verification paths;
- `parser_semantic_only` — deliberately bypasses transport and therefore cannot claim transport/authentication conformance.

A direct `activitypub.inbox.post` call with signature checks skipped is never wire-conformance evidence.

## 2. ActivityPub envelope and ActivityStreams structural handling

After HTTP parsing, SemApps operates on ActivityStreams-shaped objects and ActivityPods layers feature-specific middleware/utilities for actor metadata, app control, attribution, content warnings, collection views, hashtags, link previews, long-form text, media, polls, quote posts, reply policies, search consent, trust evaluation, and other supported extensions.

The existing ActivityPods semantic/distributed probes cover broad ActivityStreams type behavior, while the local GoToSocial/Mastodon/Akkoma harness proves selected real cross-implementation flows. Neither is yet one deliberately versioned semantic dialect corpus.

### Remaining interoperability work

Structural fixtures should preserve meaningful source differences such as:

- scalar versus array values where permitted;
- IRI strings versus embedded object identifiers;
- compact versus aliased/expanded terms;
- absent optional fields;
- unknown extensions;
- polymorphic attachment/link forms already observed in real implementations;
- invalid authority-bearing shapes.

Unknown or malformed extensions must never acquire authority, visibility, or capabilities simply because the containing JSON remains parseable.

## 3. JSON-LD and ontology semantic normalization

ActivityPods mixes in SemApps `JsonLdService`, caches local ActivityStreams/blocked contexts, and patches SemApps JSON-LD/LDP/ontology behavior for distributed locality/cache correctness. Existing postinstall patch/test pairs and the broad ActivityStreams semantic proof demonstrate that distributed topology must not silently lose ontology semantics.

### Remaining interoperability work

Assertions should compare semantic meaning rather than incidental lexical JSON. Useful expectations include:

- canonical/expanded type identity;
- expanded predicates where behavior depends on them;
- alias/context equivalence;
- deterministic supported behavior across topology;
- bounded handling of unknown terms;
- no remote-context behavior that bypasses remote-fetch/security policy.

Do not freeze an entire compacted JSON document byte-for-byte unless an actual public API promises that exact lexical form.

## 4. Authority and policy boundary

Cryptographic verification is necessary but not sufficient for ActivityPods authority. Existing controls cover local account/actor ownership, signer/key authority, delivery authority, remote fetching, feature policy, provider identity, and sidecar handoff.

### Remaining interoperability work

Cross-implementation cases should state both authenticated principal and claimed authority. Expected outcomes should be semantic policy results such as `accept`, `reject`, or a deliberately bounded `ignore_extension`; unknown JSON-LD extensions cannot grant authority.

## 5. Visibility, addressing, WebACL, and blind-recipient privacy

SemApps derives recipients/public visibility and applies WebACL read rights as ActivityPub side effects. ActivityPods adds privacy-sensitive behavior around blind addressing and delivery planning.

Existing tests already cover:

- recursive removal of `bto`/`bcc` from outward-visible representations;
- private blind-recipient routing state;
- expanded/aliased blind-address properties;
- unsupported unique `audience` semantics failing before persistence;
- duplicate visible/blind recipients converging safely;
- required private routing state failing closed when it cannot be persisted.

### Remaining interoperability work

Each relevant case needs two separate observable products:

1. semantic visibility/recipient decision; and
2. externally observable representation.

Correct routing must not hide a serialization leak, and correct serialization must not hide incorrect ACL/delivery semantics.

## 6. Persistence and ActivityPub side effects

Once accepted, SemApps/ActivityPods can store remote activity/object material, attach activities to collections/inboxes, emit inbox events, and apply feature-specific durable effects such as follow/reply/share/like/ACL changes.

The existing local target proofs already inspect persistence for selected flows, including media representation differences across GoToSocial, Mastodon, and Akkoma.

### Remaining interoperability work

Only cases executing through this boundary may claim persistence/behavioral interoperability. Normalization-only tests cannot. Retryable flows should additionally assert idempotency/replay behavior where applicable.

## 7. Representation exposed to applications

There is no single dedicated production `NormalizedActivity` DTO that ActivityPods applications consume after federation.

The stable application-facing substrate is the SemApps/ActivityPods LDP + JSON-LD resource model, with ActivityPods APIs and feature middleware exposing higher-level supported semantics. The internal ActivityPub bridge is infrastructure and must not be promoted into the public application contract.

This finding remains valid after the re-audit.

### Consequence

The next deliverable should be a **test-facing semantic assertion contract**, not a new production serialization layer. It should describe facts applications are entitled to rely on, such as:

- canonical resource/activity identity;
- semantic type(s);
- actor/attribution identity;
- object/target identity;
- visible addressing class without blind-recipient leakage;
- supported content/attachment/extension semantics;
- accepted/ignored/rejected extension disposition;
- authorization/visibility outcome without leaking ACL internals;
- provenance showing which verification/entry boundary produced the assertion.

## Existing evidence and remaining gaps

| Layer | Existing evidence | Remaining work |
| --- | --- | --- |
| HTTP/body | SemApps route middleware; ActivityPods API auth; real local harness | Versioned media/body/context dialect cases |
| Outbound signing | ActivityPods internal signing API; exact local account/actor/key authority chain | Preserve in interop assertions; add implementation-specific negative cases where useful |
| Inbound verification | Fedify `fedify-v2` provenance; native verifier fallback; worker actor check; ActivityPods bridge re-check | Encode provenance classes in shared assertion model, not redesign authority |
| ActivityStreams structure | SemApps actions; ActivityPods feature proofs; real GoToSocial/Mastodon/Akkoma flows | Unified semantic/dialect fixture schema |
| JSON-LD/ontology | SemApps JsonLdService; cached contexts; distributed locality/cache patches; broad semantic proof | Shared semantic-equivalence assertions |
| Authority/policy | Signing/provider/delivery/remote-fetch hardening | Cross-implementation negative extension/authority cases |
| Visibility/ACL | SemApps WebACL; ActivityPods blind-address privacy tests | Combined visibility + outward-representation fixture expectations |
| Persistence | SemApps side effects plus target-specific real-implementation persistence proofs | Shared replay/idempotency-aware semantic cases |
| App consumption | LDP/JSON-LD substrate + ActivityPods feature APIs | **One explicit versioned semantic assertion model** |

## Remaining gaps

### G1 — No single shared semantic assertion model

This is the real next ordered deliverable.

The repository already has many assertions and a real implementation harness. The missing piece is one small, versioned contract that tells every harness/fixture which semantic facts are comparable across implementations and which evidence boundary produced them.

It should not become a second ActivityPub object model or freeze irrelevant storage/lexical differences.

### G2 — General ActivityStreams structural validation is intentionally not one strict schema gate

SemApps has targeted validation and downstream handlers rather than one universal ActivityStreams schema validator. Interoperability work should characterize and harden real compatibility behavior without prematurely imposing a strict schema that rejects legitimate ecosystem dialects.

### G3 — Visibility has two observable contracts

Delivery/ACL correctness and privacy-safe outward representation remain distinct and must both be represented in the shared assertion model.

### G4 — Existing implementation-specific proofs need semantic convergence, not replacement

GoToSocial, Mastodon, and Akkoma already have useful target-specific proof logic, including differing persistence/storage representations. The new model should let those proofs project into common semantic outcomes while retaining target-specific diagnostics where needed.

## Invariants, not gaps

The following were initially easy to misread as unfinished work but are established boundaries that future work must preserve:

- SemApps middleware `1.1.4` has an identifiable upstream release commit; ActivityPods' installed/patched runtime remains the executable authority.
- ActivityPods is the sole private-key/outbound signing authority.
- Fedify-verified and sidecar-native inbound verification are explicit trusted ingress modes.
- verified actor equality is checked before forwarding and rechecked at the ActivityPods bridge.
- duplicate signature validation is skipped only at the authenticated preverified ActivityPods bridge boundary.
- existing local real-implementation interop testing is already present; no public-internet dependency is required.

## Ordered next step

Define the **stable semantic interoperability assertion model** before expanding a new fixture metadata/schema and seed corpus.

That model should be intentionally smaller than the full ActivityStreams object model and should be reusable by:

- the existing GoToSocial/Mastodon/Akkoma local harness;
- authenticated wire tests;
- Fedify-verified and native-verifier ingress tests;
- parser/JSON-LD semantic tests;
- persistence/visibility/privacy tests;
- application-boundary assertions.

No new production DTO, public-internet federation dependency, NATS authorization, JetStream authorization, or promotion-gate weakening is implied by this inventory.