# Canonical Reporting And Moderation Design

## Status

Proposed design for end-user reporting and cross-protocol moderation forwarding.

This document defines:

- a canonical report model for ActivityPods + `fedify-sidecar`
- routing rules for local, ActivityPub, and ATProto report forwarding
- a dedicated ActivityPub moderation actor that is narrower than a Mastodon-style instance actor

It does not implement the design by itself.

## Why This Exists

Mastodon and Bluesky both provide useful guidance, but neither model maps directly to this architecture.

- Mastodon couples report intake, moderation workflow, and ActivityPub forwarding to a server-local moderation surface.
- Bluesky separates hosting, moderation, and labeling more aggressively, and reports target moderation services rather than the data host alone.
- This architecture has a different trust boundary:
  - ActivityPods owns local account state, WebID, authoritative inbox handling, and policy-bearing mutations.
  - `fedify-sidecar` owns remote ActivityPub ingress/egress and native ATProto runtime surfaces.
  - the protocol bridge is internal parity infrastructure, not a third-party bridge product.

Relevant baseline:

- [ARCHITECTURE-BASELINE.md](../../ARCHITECTURE-BASELINE.md)
- [protocol-bridge/README.md](../src/protocol-bridge/README.md)

## Design Principles

1. Local-first

Every user report creates a local case first. Remote forwarding is optional projection, not the source of truth.

2. Reporter privacy

The reporting user identity is private internal state. When projecting to ActivityPub, the outgoing report is sent by a dedicated moderation actor, not by the reporting user.

3. Subject fidelity

Reports must support both account-level and object-level subjects. A report about a post is not the same thing as a report about the whole account.

4. Routing by authority, not identity count

A single logical person may have a WebID, AP actor URI, and AT DID. We must not fan a single report out to every bound protocol automatically. Forwarding follows the authoritative surface of the reported subject or object.

5. Reporting and enforcement are separate

A report creates a case. A moderator decision may later become:

- a local-only action
- an ActivityPub subject policy rule
- an AT label or AT admin action
- a remote forwarded report

Those are related, but not the same thing.

## Comparison With Existing Models

### Mastodon

What we should borrow:

- local report object first
- optional remote ActivityPub `Flag`
- reporter privacy via a server-controlled actor

What we should not copy directly:

- a full "instance actor" that also owns unrelated server jobs
- the assumption that one server boundary is the whole identity and moderation model

### Bluesky / ATProto

What we should borrow:

- account or record as first-class report subjects
- moderation service routing separate from data-hosting concerns
- explicit auditability of moderation workflow

What we should not copy directly:

- treating every moderation artifact as a public network object
- assuming our local source of truth is a PDS-equivalent only

## Terminology

### Moderation Actor

Use the term `moderation actor`, not `instance actor`, in our design.

Reason:

- this actor is narrower than a Mastodon instance actor
- it exists only to represent the local provider's moderation service in ActivityPub moderation flows
- it should not silently accumulate unrelated federation jobs

Suggested URI shape:

- `https://<provider-domain>/actors/moderation`

Display naming may vary by deployment:

- "Moderation"
- "Pod Moderation"
- "Provider Moderation"

The protocol term remains `moderation actor`.

### Local Case

A durable ActivityPods-owned moderation record created from:

- a local user report
- an inbound ActivityPub `Flag`
- future ATProto report ingestion if we add it

### Forwarded Report

A protocol-specific projection of a local case to a remote authority.

## Non-Goals

- Reproducing Mastodon's full instance actor behavior
- Making moderation cases or reporter identity public
- Automatically forwarding every report remotely
- Automatically forwarding the same report to every bound AP and AT identity for the same person
- Making remote forwarding a requirement for local moderation

## Proposed Canonical Model

### Canonical Intent Additions

Extend `CanonicalIntentKind` with:

- `ReportCreate`

Do not model case records themselves as protocol bridge intents. A case is durable control-plane state owned by ActivityPods, not a transport event that should be mirrored around the network.

### Canonical Report Subject

```ts
type CanonicalReportSubject =
  | {
      kind: "account";
      actor: CanonicalActorRef;
      authoritativeProtocol?: "local" | "ap" | "at";
    }
  | {
      kind: "object";
      object: CanonicalObjectRef;
      owner?: CanonicalActorRef | null;
      authoritativeProtocol?: "local" | "ap" | "at";
    };
```

Notes:

- `account` is for user/account/profile level reporting.
- `object` is for a specific AP object or AT record.
- `authoritativeProtocol` is a routing hint, not a fan-out list.

### Canonical Report Intent

```ts
interface CanonicalReportCreateIntent extends CanonicalIntentBase {
  kind: "ReportCreate";

  reporterAccountRef: CanonicalActorRef;
  reporterWebId?: string | null;

  subject: CanonicalReportSubject;

  reasonType:
    | "spam"
    | "harassment"
    | "abuse"
    | "impersonation"
    | "copyright"
    | "illegal"
    | "safety"
    | "other";

  reason?: string | null;

  evidenceObjectRefs?: CanonicalObjectRef[];

  requestedForwarding?: {
    remote: boolean;
  } | null;

  clientContext?: {
    app?: string | null;
    surface?: string | null;
  } | null;
}
```

Important:

- `reporterAccountRef` and `reporterWebId` are internal only.
- projectors must not expose the reporter identity unless a future protocol explicitly requires it and policy allows it.

### Local Case Model

Create an ActivityPods-owned durable `ModerationCase` record that sits above protocol-specific forwarding state.

Minimum fields:

```ts
interface ModerationCase {
  id: string;
  createdAt: string;
  updatedAt: string;

  source:
    | "local-user-report"
    | "activitypub-flag"
    | "atproto-report";

  reporterWebId?: string | null;
  reporterAccountRef?: CanonicalActorRef | null;

  subject: CanonicalReportSubject;

  reasonType: string;
  reason?: string | null;

  status: "open" | "resolved" | "dismissed";

  forwarding: Array<{
    protocol: "ap" | "at";
    target: string;
    status: "pending" | "sent" | "failed" | "skipped";
    lastAttemptAt?: string;
    remoteReference?: string;
    error?: string;
  }>;

  linkedDecisionIds: string[];
}
```

This lets us preserve:

- the local case
- the private reporter identity
- the protocol-specific forwarding lifecycle
- the later moderator decision lifecycle

## Moderation Actor Design

### Responsibilities

The moderation actor exists to:

- send outbound ActivityPub `Flag` activities for forwarded reports
- receive inbound ActivityPub `Flag` activities at a dedicated inbox
- expose enough actor metadata and key material for interoperable AP delivery and verification

### Explicit Non-Responsibilities

The moderation actor should not automatically become responsible for:

- general-purpose HTTP fetch signing
- relay behavior
- platform announcements
- public content posting
- provider capability negotiation
- user notification delivery
- non-moderation federation tasks

### Required AP Surfaces

To interoperate safely, the moderation actor should still expose:

- actor document
- inbox
- outbox
- public key

The outbox may be minimal and moderation-only. We do not need to make it a general instance event stream.

The inbox should be externally reachable for server-to-server ActivityPub delivery, but "public" here should mean narrowly reachable and strongly verified, not broadly interactive. In practice this means:

- no browser-facing moderation UI on the inbox route
- only signed and verified server-to-server POST delivery
- strict allow-listing to moderation-relevant activity types such as `Flag`
- no assumption that the moderation inbox can be used as a general shared inbox
- no leakage of private reporter identity in the ActivityPub payload

### Authority Boundary

The moderation actor is provider-scoped.

Reason:

- provider moderation is already the administrative boundary in the current dashboard
- one provider may manage many local accounts and pods
- outgoing remote reports should represent the authority that can review and act on the case

If a deployment wants per-pod moderation actors later, treat that as an explicit extension, not the default design.

## Routing Rules

### Rule 1: Always Create A Local Case

Every report creates a local case before any remote forwarding decision is made.

### Rule 2: Route By The Authoritative Surface Of The Reported Subject

Use the protocol where the reported thing actually lives.

Examples:

- local WebID/AP/AT identity hosted by this provider:
  - local case only
  - no remote forwarding
- remote ActivityPub actor or object:
  - local case
  - optional AP `Flag` forwarding
- remote ATProto DID or record:
  - local case
  - optional `com.atproto.moderation.createReport`

### Rule 3: Do Not Auto-Fan-Out To Every Bound Identity

If the same person has:

- WebID
- AP actor URI
- AT DID

we still forward based on the specific reported object or authoritative target, not every known alias.

Examples:

- user reports a Bluesky post:
  - route to ATProto moderation
  - do not also emit an AP `Flag` just because we know an AP alias
- user reports an AP post:
  - route to ActivityPub
  - do not also send an ATProto report

### Rule 4: Ambiguous Account-Level Reports Stay Local By Default

If the user reports an account-level identity and we cannot determine a single authoritative remote moderation surface safely, keep the case local unless:

- the user explicitly chooses a forwarding target, or
- moderation policy picks one deterministic authority

This avoids duplicate or contradictory remote reports.

## ActivityPub Projector

### Trigger Conditions

Project a local case to ActivityPub only when:

- forwarding is allowed by local policy
- the subject authority is ActivityPub
- the subject resolves to a remote AP actor or AP object

### Outbound Shape

Emit an ActivityPub `Flag` from the moderation actor.

High-level shape:

```json
{
  "type": "Flag",
  "actor": "https://provider.example/actors/moderation",
  "object": [
    "https://remote.example/users/bob",
    "https://remote.example/users/bob/statuses/123"
  ],
  "content": "Optional reporter comment"
}
```

Constraints:

- include the reported actor when known
- include reported objects when known
- do not include internal reporter WebID
- do not include internal local case identifiers unless carried in a non-public extension that we explicitly define
- do not assume remote category parity with local categories

### Inbound ActivityPub `Flag`

Inbound verified `Flag` already maps to a local moderation case in the sidecar.

That path should evolve to produce the same local case shape as local user reports, not a special parallel model.

## ATProto Projector

### Trigger Conditions

Project a local case to ATProto only when:

- forwarding is allowed by local policy
- the subject authority is ATProto
- the subject resolves to:
  - an account-level AT identity, or
  - a specific AT record

### Outbound Shape

Call `com.atproto.moderation.createReport` against the selected moderation service.

Subject mapping:

- account report -> AT repo/DID subject
- object report -> AT record subject

Reason mapping:

- map canonical `reasonType` to the closest AT `reasonType`
- pass free-form comment in `reason`
- preserve local richer metadata only in the local case

### Service Resolution

Do not assume the data host alone is the moderation authority.

Resolution order should be explicit policy:

1. subject-native moderation service if discoverable and trusted
2. configured provider policy for that AT authority
3. local-only case with forwarding skipped

If service discovery is ambiguous, keep the case local instead of guessing.

## Local User Workflow

1. User submits a report from Memory or another ActivityPods app.
2. ActivityPods creates a local `ModerationCase`.
3. A canonical `ReportCreate` intent is emitted for bridge/routing logic.
4. Routing decides:
   - local only
   - AP forward
   - AT forward
5. Forwarding state is recorded on the case.
6. Provider moderators review the case and apply actions.
7. Moderator actions may become:
   - AP subject rules
   - AT labels
   - AT admin actions
   - local-only enforcement

## Current Codebase Implications

What already exists:

- inbound verified AP `Flag` capture into moderation cases
- provider moderation decisions
- AP subject-policy enforcement
- AT label emission and AT suspend hook

What is missing for this design:

- canonical `ReportCreate` intent
- local app/user report submission path
- unified local `ModerationCase` ownership in ActivityPods
- AP report projector
- AT report projector
- explicit forwarding-state tracking on cases
- subject-level object/account distinction in moderator workflow

## Recommended Phase Order

### Phase 1: Canonical And Local Case Foundation

- add `ReportCreate` to canonical intent model
- define shared `ModerationCase` schema
- create local user report API in ActivityPods
- unify inbound AP `Flag` cases with the same schema

### Phase 2: ActivityPub Moderation Actor

- add moderation actor document, inbox, outbox, and keys
- implement outbound AP `Flag` projector
- track AP forwarding state on cases

### Phase 3: ATProto Report Projection

- add AT moderation service resolution policy
- implement `com.atproto.moderation.createReport`
- track AT forwarding state on cases

### Phase 4: Moderator Workflow Upgrade

- expose object-vs-account subject clearly in provider dashboard
- add forward/retry controls per case
- add clear separation between "report forwarded" and "enforcement applied"

## Design Decisions To Keep

- Use `moderation actor`, not `instance actor`, in our architecture and docs.
- Keep the moderation actor narrow.
- Treat reports as local cases first, protocol projections second.
- Forward based on the authoritative surface of the reported thing.
- Never expose reporter identity in ActivityPub forwarded reports.
- Do not auto-fan-out one report across every bound protocol identity.

## External Reference Points

- Mastodon reports API: https://docs.joinmastodon.org/methods/reports/
- Mastodon ActivityPub docs: https://docs.joinmastodon.org/spec/activitypub/
- Mastodon moderation docs: https://docs.joinmastodon.org/admin/moderation/
- AT Protocol overview: https://atproto.com/guides/overview?protocol-overview=
- AT labels guide: https://atproto.com/guides/labels
- ATProto createReport API: https://docs.bsky.app/docs/api/com-atproto-moderation-create-report
- Ozone guide: https://atproto.com/guides/using-ozone
