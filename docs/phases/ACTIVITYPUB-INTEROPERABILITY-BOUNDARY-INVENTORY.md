# ActivityPub Interoperability Boundary Inventory

Status: **ACTIVE inventory / fixture work not yet authorized**  
Inventory baseline: **2026-08-20**  
Architecture base: `4a1b15390d834b4e8e6078733c076376c12b312c`  
ActivityPods evidence baseline: `0ae54f0a898df3fb4e6516504c4e649669834d69`

## Purpose

This document closes the first ordered deliverable of ActivityPub Interoperability Hardening: identify the existing ActivityPods/SemApps processing and test boundaries before defining a cross-implementation fixture schema or corpus.

It does **not** authorize the fixture corpus, live third-party interoperability testing, NATS Core, JetStream, or any change to the frozen ADSP promotion gates.

The critical architectural distinction is that ActivityPods does not own the entire ActivityPub protocol stack. It composes and configures SemApps services, then adds ActivityPods-specific authority, privacy, product semantics, and federation-delivery policy. A useful interoperability suite therefore cannot treat every observable behavior as one undifferentiated ActivityPods parser contract.

## Runtime-source caveat

`pod-provider/backend/package.json` pins the relevant published SemApps packages (`@semapps/activitypub`, `@semapps/jsonld`, `@semapps/ldp`, `@semapps/ontologies`, `@semapps/webacl`, and related packages) to `1.1.4`. ActivityPods also runs postinstall patch scripts against installed SemApps code for distributed/locality/cache and delivery behavior.

The SemApps GitHub repository currently does not expose an obvious `1.1.4` or `v1.1.4` Git ref. Therefore:

1. current upstream SemApps source is useful for locating architectural seams;
2. it must **not** be silently equated with the exact npm `1.1.4` runtime implementation;
3. fixture implementation must assert against the installed ActivityPods dependency tree and its patches, with upstream source used as explanatory/reference evidence until the npm release can be tied to an exact source commit.

This prevents a false-positive inventory that tests SemApps `master` instead of the code ActivityPods actually executes.

## End-to-end boundary map

```text
remote HTTP request
  |
  v
[0] HTTP/body decoding + content negotiation
  |
  v
[1] transport integrity + cryptographic authentication
    - Digest
    - HTTP Signature
    - authenticated remote principal / verified actor provenance
  |
  v
[2] ActivityPub envelope / ActivityStreams structural handling
    - actor/object/type/recipient shapes
    - string vs object identifiers
    - supported extension surface
  |
  v
[3] JSON-LD + ontology semantic normalization
    - context loading
    - term/type expansion
    - RDF/JSON-LD equivalence where relevant
    - ActivityPods cached/local ontology contexts
  |
  +----------------------------+
  |                            |
  v                            v
[4a] authority/policy       [4b] visibility/ACL
    - actor authority           - public addressing
    - local actor authority     - recipients
    - remote-fetch trust        - WebACL rights
    - extension fail-closed     - blind-address privacy
  |                            |
  +-------------+--------------+
                |
                v
[5] persistence + ActivityPub side effects
    - remote activity/object storage
    - collections/inbox/outbox effects
    - follow/reply/share/etc. handlers
                |
                v
[6] stable application-consumption boundary
    - SemApps LDP/JSON-LD resource representation
    - ActivityPods feature/API semantics layered on those resources
    - NOT the internal federation-sidecar bridge itself
```

The fixture program must preserve these boundaries. In particular, a parser-level case may deliberately enter at [2] or [3], but it must be labelled as such and cannot be counted as evidence for [1], [4], or [5].

## 0. HTTP/body decoding and route boundary

### Existing implementation

SemApps ActivityPub and LDP routes disable Moleculer-Web's default body parser and use the SemApps middleware chain (`parseUrl`, `parseHeader`, content negotiation, `parseJson`, `parseTurtle`, file parsing, and dataset metadata). ActivityPods' API gateway supplies the authentication dispatch and distinguishes HTTP Signature, OIDC, ActivityPods JWT, and anonymous requests.

### Existing evidence

The repository has extensive API and integration tests, but this workstream does not yet have a dedicated cross-dialect matrix for media type, JSON body, context/header, malformed-body, or equivalent ActivityStreams wire representations.

### Correct fixture seam

Use full HTTP fixtures when the assertion concerns content type, headers, digest/signature bytes, body decoding, or route behavior. Do not replace those with direct Moleculer action calls.

## 1. Transport integrity, signature, and authenticated authority provenance

### SemApps-owned machinery

The SemApps inbox path:

- requires raw request/body metadata for normal signed federation requests;
- verifies the digest;
- verifies the HTTP Signature;
- obtains the authenticated remote actor principal through signature verification;
- requires `activity.actor` to match that authenticated principal before normal inbox processing;
- only then changes execution metadata to system authority for internal processing.

SemApps signature verification resolves the signer key and validates the HTTP signature against remote RSA public keys.

### ActivityPods-owned additions

ActivityPods selects the remote-delivery authority profile around the SemApps ActivityPub service. Separately, the internal Fedify/ActivityPods bridge has a narrowly scoped inbound path in which the sidecar supplies `verifiedActorUri`. ActivityPods revalidates that the activity actor matches this value and that the destination is a trusted local inbox, then calls the normal SemApps inbox with `skipSignatureValidation: true`.

That bridge shortcut is legitimate only because signature verification has already occurred in the trusted sidecar. It is **not** a general rule for fixture ingestion or normal ActivityPub HTTP traffic.

ActivityPods also has explicit authority/signing regression tests, including Phase-5/local-signing and integrated authority-profile tests.

### Correct fixture seam

Create two evidence classes:

- `wire_authenticated`: complete HTTP request; signature/digest/actor provenance must be exercised;
- `preverified_internal`: only for the authenticated internal bridge contract; fixture metadata must identify the external verifier and actor binding.

A direct `activitypub.inbox.post` call with signature checks disabled must never be promoted to wire-conformance evidence.

## 2. ActivityPub envelope and ActivityStreams structural handling

### Existing implementation

After HTTP parsing, SemApps ActivityPub actions operate on JavaScript ActivityStreams-shaped objects. The inbox currently performs important actor/signature checks but does not provide a single comprehensive schema validator for every valid or invalid ActivityStreams dialect; upstream source still contains a TODO to check general activity validity at the inbox boundary.

ActivityPods then layers extension-specific middleware and utilities for features such as:

- actor metadata;
- app control;
- author attribution;
- content warnings;
- collection views;
- hashtag normalization;
- link previews;
- long-form text;
- media attachments;
- polls;
- quote posts;
- reply policies;
- search consent;
- trust evaluation.

The existing PR #106 semantic proof establishes broad type-processing coverage, but it is a semantic/distributed proof, not a replacement for a deliberately versioned interoperability dialect corpus.

### Existing evidence

ActivityPods already contains feature proofs for multiple ActivityPub/FEP surfaces and the PR #106 ActivityStreams semantic probe. These are valuable seed evidence, but their current test inputs were written to prove individual features rather than to define one normalized cross-implementation fixture contract.

### Correct fixture seam

Parser/shape fixtures may enter after HTTP decoding only when the fixture explicitly says `assertionBoundary: activitystreams-structure` and does not claim transport/authentication coverage.

Structural fixtures should preserve source form sufficiently to test meaningful dialect differences, including:

- scalar vs array values where ActivityStreams permits both;
- IRI string vs embedded object identifier forms;
- compact terms vs expanded/aliased forms;
- absent optional fields;
- unknown extensions;
- invalid authority-bearing shapes.

Unknown or malformed extensions must not acquire authority, visibility, or capabilities merely because the generic structure remains parseable.

## 3. JSON-LD and ontology semantic normalization

### SemApps-owned machinery

ActivityPods mixes in SemApps `JsonLdService`. The SemApps JSON-LD parser exposes compact/expand/flatten/frame/normalize/RDF conversions and term/type expansion using a document loader and ontology/context information.

ActivityPods configures local cached contexts for at least ActivityStreams and the blocked vocabulary. It also registers/patches SemApps JSON-LD, LDP, and ontology behavior for distributed locality/cache correctness.

### Existing ActivityPods hardening

Postinstall patch/test pairs cover important runtime-distribution hazards, including:

- JSON-LD distributed context caching;
- JSON-LD distributed locality;
- LDP distributed semantic locality;
- LDP local registry bootstrap;
- LDP special-endpoint races;
- ontology distributed caching;
- ActivityPub local-delivery/local-context reuse behavior.

PR #106's 58-type semantic proof belongs primarily at this semantic-normalization layer and demonstrates that the distributed topology does not silently lose local ActivityStreams ontology semantics.

### Correct fixture seam

Semantic fixtures should assert equivalence at the JSON-LD/ontology boundary, not incidental lexical equality of incoming JSON.

Expected assertions include:

- canonical/expanded type identity;
- expanded predicates where application behavior depends on them;
- context alias equivalence;
- safe behavior for unknown terms;
- deterministic output across the supported distributed topology;
- no remote-context behavior that bypasses the existing remote-fetch/cache security policy.

Do not freeze the entire compacted JSON document byte-for-byte unless a downstream public API explicitly promises that lexical form.

## 4a. Authority and policy boundary

### Existing implementation

Cryptographic authentication alone is not the complete ActivityPods authority model. ActivityPods has additional local/remote authority checks around signing, actor ownership, delivery authority, remote fetching, feature policy, and sidecar handoff.

Existing tests include authority-profile, signing-authority, provider-URI, and observability coverage. This is where a syntactically valid extension must fail closed if it attempts to change signer, controller, local actor ownership, remote-delivery authority, or another security-sensitive interpretation.

### Correct fixture seam

Authority fixtures must state which principal is authenticated and which resource/actor claims authority. The expected result should be a policy decision (`accept`, `reject`, or explicitly bounded `ignore-extension`) rather than merely a parsed object.

No fixture expectation may infer authority from an unknown JSON-LD extension.

## 4b. Visibility, addressing, and ACL boundary

### SemApps-owned machinery

SemApps derives recipients/public visibility through ActivityPub activity helpers and applies WebACL read rights as ActivityPub side effects. ActivityPods mixes in SemApps WebACL in pod-provider mode.

### ActivityPods-owned hardening

ActivityPods adds privacy-sensitive delivery behavior beyond the generic WebACL mapping. Existing tests verify, among other things:

- `bto`/`bcc` are stripped recursively from outward-visible activity representations while remaining routable through the dedicated blind-recipient snapshot;
- expanded and aliased ActivityStreams blind-recipient properties are recognized;
- unsupported unique `audience` semantics fail before persistence;
- duplicate visible/blind recipients converge safely;
- failure to persist required private routing state fails closed.

### Correct fixture seam

Visibility fixtures need two distinct expected products:

1. semantic visibility/recipient decision; and
2. externally observable normalized representation.

This prevents a test from passing because delivery routing was correct while accidentally leaking blind-recipient fields, or vice versa.

## 5. Persistence and ActivityPub side-effect boundary

### Existing implementation

Once SemApps accepts an inbound activity, its inbox processing invokes ActivityPub side effects, stores remote activity/object material through LDP remote storage, attaches the activity to the ActivityPub activity container and recipient inbox, and emits inbox-received events.

This boundary is where feature behavior (follow state, reply/share/like semantics, ACL changes, collection membership, etc.) can become durable application state.

### Correct fixture seam

Only fixtures that execute through this boundary may claim persistence/behavioral interoperability. Pure normalization fixtures must not be counted as evidence that ActivityPods applies the normalized result correctly.

Where persistence is asserted, tests should additionally check idempotency/replay behavior if the activity can be retried, and should avoid real private-user data.

## 6. Normalized representation exposed to applications

### Finding

There is **not** one dedicated `NormalizedActivity` DTO in ActivityPods that applications consume after federation. The stable application-facing substrate is instead the SemApps/ActivityPods LDP + JSON-LD resource model, with ActivityPods APIs and feature middleware exposing higher-level semantics over those resources.

The generic LDP catch-all route runs the SemApps parsing/content-negotiation machinery and ActivityPods configures `LdpService` in pod-provider mode. ActivityPods' normal API gateway authenticates callers using HTTP Signatures, Solid/OIDC, ActivityPods JWTs, or anonymous access as applicable.

The `internal-activitypub-bridge-api` is **not** this public normalized application contract. It is a federation infrastructure trust adapter between the sidecar and ActivityPods.

### Consequence for the next deliverable

The stable assertion model should not invent a replacement wire DTO for applications. It should describe the semantic facts applications are entitled to rely on after ActivityPods/SemApps processing, for example:

- canonical resource/activity identity;
- semantic type(s);
- actor/attribution identity;
- object/target identity;
- visible addressing class without blind-recipient leakage;
- normalized content/attachment/extension facts where ActivityPods explicitly supports them;
- accepted/ignored/rejected extension disposition;
- public/private authorization outcome as an assertion, not leaked ACL internals;
- provenance indicating whether the assertion was reached from authenticated wire input, preverified bridge input, or a parser-only test.

This assertion model should be a **test contract**, not a new production serialization layer unless later implementation evidence shows a real application API needs one.

## Existing test/evidence inventory by layer

| Layer | Existing evidence | Current gap for interoperability hardening |
| --- | --- | --- |
| HTTP/body | SemApps ActivityPub/LDP route middleware; ActivityPods API auth dispatch | No versioned dialect/media-type corpus |
| Signature/auth principal | SemApps digest + HTTP Signature verification; inbox actor equality; ActivityPods signing/authority tests | Need fixture provenance classes and negative cross-implementation wire cases |
| ActivityStreams structure | SemApps ActivityPub actions; ActivityPods extension middlewares/proofs | No unified structural/dialect fixture schema |
| JSON-LD/ontology | SemApps JsonLdService/parser; ActivityPods cached contexts; locality/cache patches; 58-type semantic proof | Need semantic equivalence assertions across dialect inputs |
| Authority/policy | ActivityPods Phase-5 authority/signing/provider-boundary tests | Need extension-specific cross-implementation negative cases |
| Visibility/ACL | SemApps WebACL side effects; ActivityPods blind-address/delivery-plan hardening | Need combined semantic-visibility + outward-representation assertions |
| Persistence/side effects | SemApps inbox store/attach/events and ActivityPub handlers | Need replay/idempotency-aware empirical cases |
| App consumption | LDP/JSON-LD resource substrate + ActivityPods feature APIs | No explicit stable interoperability assertion model yet; this is the **next** deliverable |

## Fixture-boundary rules established by this inventory

The next fixture schema/corpus work must obey all of the following:

1. Every case declares an `assertionBoundary`; no test may implicitly claim a lower-layer guarantee it bypassed.
2. Every case declares provenance: authenticated wire, trusted/preverified internal bridge, or parser/semantic unit input.
3. Signature validation may only be bypassed for explicitly labelled lower-level or preverified-internal cases.
4. Parser success alone never means authority, visibility, ACL, persistence, or application compatibility succeeded.
5. Unknown extensions may be retained or ignored but cannot grant authority/capabilities/visibility.
6. Blind-recipient data must have separate private-routing and outward-representation assertions.
7. JSON-LD semantic equivalence should be asserted semantically; lexical JSON equality is not the default contract.
8. App-facing assertions target the LDP/JSON-LD semantic substrate and supported ActivityPods feature facts; the internal sidecar bridge is excluded.
9. Runtime tests must execute against ActivityPods' installed SemApps `1.1.4` dependency plus ActivityPods patches. Current SemApps `master` is not a substitute runtime target.
10. Live third-party endpoints remain optional smoke/evidence only and are not required CI dependencies.
11. No real private user data is admitted to the fixture corpus.
12. Existing SSRF/remote-fetch, signature, authority, and ACL protections stay active; the interoperability program cannot weaken them for convenience.

## Gaps discovered during inventory

### G1 — No single explicit stable assertion model

This is the intended next ordered deliverable. It should be test-facing and semantic, with enough structure to compare Mastodon/Akkoma/GoToSocial/etc. dialects without freezing irrelevant lexical differences.

### G2 — Runtime SemApps release provenance is not tied to an obvious Git tag

Before using upstream source lines as executable-version evidence, tie npm `1.1.4` to its package provenance/commit if available from the lockfile/package metadata or published artifact. Until then, tests must treat the installed ActivityPods dependency as authoritative.

### G3 — General inbox structural validation is not a complete schema gate

The current SemApps inbox has targeted authentication/actor checks and downstream handlers, but no single comprehensive ActivityStreams schema validation step. The fixture work should expose actual compatibility behavior without prematurely adding a strict schema that rejects valid ecosystem dialects.

### G4 — Internal bridge provenance must remain explicit

The inbound sidecar path deliberately skips duplicate signature validation after verifying actor provenance at the infrastructure boundary. Tests must prevent this mechanism from becoming an accidental general bypass.

### G5 — Visibility has two observable contracts

Delivery/ACL correctness and privacy-safe serialization are distinct. The fixture model needs to represent both or it can miss blind-address leakage/regressions.

## Ordered next step

With this boundary inventory established, the next authorized design task is the **stable interoperability assertion model** described by `ACTIVITYPUB-INTEROPERABILITY-HARDENING.md`.

That model should be specified before the fixture metadata/schema and before the seed corpus. It should remain intentionally smaller than the full ActivityStreams object model and should encode semantic outcomes rather than implementation-specific SemApps internals.

No fixture implementation or live third-party testing is started by this document.
