# Stream1 Local Observation Authority

## Contract

`ap.stream1.local-public.v1` is the provider-wide append-only observation stream for committed ActivityPub activities originating from local ActivityPods actors and addressed to the ActivityStreams Public audience.

Stream1 membership is independent of remote federation fan-out. A committed local public activity belongs to Stream1 whether it has many remote recipients, one remote recipient, or zero remote recipients.

ActivityPub activities classified as `public` or `unlisted` are federation-public and may enter Stream1. `followers` and `direct` activities must not enter Stream1. Search/discovery eligibility is a separate policy boundary represented by `searchConsent` and `isPublicIndexable`; an unlisted activity being present in Stream1 does not imply that it is search-indexable.

## Authority path

```text
ActivityPods committed outbox activity
        |
        v
APDM ap.delivery-plan.v1
(authoritative local/remote recipient snapshot)
        |
        v
Durable ActivityPods handoff
        |
        v
Redis Streams outbox intent
        |
        +--> RedPanda Stream1 + AP firehose, when federation-public
        |
        `--> remote delivery fan-out, only when remote targets exist
```

A zero-length `remoteRecipients` / `remoteTargets` array is therefore a valid Delivery Plan outcome. It means "observe the committed activity but create no remote delivery jobs"; it does not mean the handoff is malformed.

No synthetic recipient may be manufactured merely to cause Stream1 publication, and no second ActivityPub routing authority is introduced.

## Ordering and failure semantics

Event-log observation happens before remote target normalization and outbound job fan-out. Delivery failure must not erase the fact that an already-committed local public activity belongs to the provider-wide public event stream.

The Redis-to-RedPanda boundary is **at-least-once**, not physically exactly-once. The worker persists an `eventLogPublishedAt` marker after successful broker publication, which prevents ordinary duplicate processing. A process crash after the RedPanda acknowledgement but before that Redis marker is persisted can still produce a physical replay.

Every replay preserves:

- the same durable APDM `intentId` as `outboxIntentId`;
- the same committed `createdAt` value as the Stream1 publication timestamp.

Consumers that materialize exactly-once state must therefore deduplicate on the stable semantic intent identity rather than assuming there can never be two physical log records.

## Stream boundaries

| Activity | Stream1 | Remote fan-out |
| --- | --- | --- |
| local public, zero remote recipients | yes | none |
| local public, remote recipients | yes | yes |
| local unlisted, zero or more remote recipients | yes | only when targets exist |
| local followers-only | no | according to authoritative recipients |
| local direct | no | according to authoritative recipients |
| remote public | no; Stream2 | inbound path |
| tombstone record | dedicated tombstone topic | separate lifecycle handling |

`ap.firehose.v1` remains the union of Stream1 and Stream2 public ActivityPub activities; the separate tombstone record is not copied into the firehose.
