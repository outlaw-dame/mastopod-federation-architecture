# Friendica ↔ Mastodon: real ActivityPub Follow acceptance

This is a source-based diagnostic and acceptance note for pinned Friendica 2026.05 and Mastodon v4.5.8. **An HTTP 202 is not proof of a persisted follow** for either implementation.

## Incoming Follow pipeline: source comparison

| Stage | Mastodon v4.5.8 | Friendica 2026.05 |
| --- | --- | --- |
| Inbox entry | `ActivityPub::InboxesController#create` checks request and actor signature, schedules `ActivityPub::ProcessingWorker`, returns 202 | `Module/ActivityPub/Inbox::post` checks content type and body, invokes `Receiver::processInbox`, then throws `AcceptedException` (202) |
| Remote actor | Signed request account and actor are resolved ahead of queue handoff | `Receiver::processInbox` runs `APContact::getByURL(actor)` **before HTTP signature verification**; failure logs a notice and returns without persisting |
| HTTP signature | `require_actor_signature!` precondition before processing queue | `HTTPSignature::getSigner` and `getKeyIdContact` after actor lookup; an unverifiable signer is not trusted |
| Actor dereference | Request account/actor resolution and background processing | `APContact::getByURL` fetches WebFinger and, if needed, `HTTPSignature::fetchRaw` (signed GET using Friendica's system account), validates content type and JSON-LD compaction, requires recognized account type and nonempty inbox |
| Follow | `ActivityPub::Activity::Follow#perform`: resolve local target, verify blocks, create/update `FollowRequest`, run `AuthorizeFollowService` or leave pending if locked | `Receiver::processActivity` dispatches account Follow to `Processor::followUser`; accepting `as:Follow` depends on proper target object typing and permission/relationship state |
| Persisted acceptance | DB `follows` or `follow_requests` (pending), local target; signer/transport evidence | DB `apcontact` discovery, `contact` relationship and pending/intro state, `inbox-entry` and receiver as applicable; verified signer/transport evidence |

Source files:
- https://github.com/mastodon/mastodon/blob/v4.5.8/app/controllers/activitypub/inboxes_controller.rb
- https://github.com/mastodon/mastodon/blob/v4.5.8/app/lib/activitypub/activity/follow.rb
- https://github.com/friendica/friendica/blob/2026.05/src/Module/ActivityPub/Inbox.php
- https://github.com/friendica/friendica/blob/2026.05/src/Protocol/ActivityPub/Receiver.php
- https://github.com/friendica/friendica/blob/2026.05/src/Model/APContact.php
- https://github.com/friendica/friendica/blob/2026.05/src/Util/HTTPSignature.php

## What the fixture has actually demonstrated

- Both ActivityPods native and sidecar Follow deliveries reached Friendica with HTTP 202.
- The same actor URL was fetchable using an ordinary in-container curl with `Accept: application/activity+json` and the disposable root CA. **This is not the same as Friendica's own `HTTPSignature::fetchRaw` signed fetch and JSON-LD compaction**.
- The Friendica DB still showed zero persisted remote contacts, zero matching inbox entries and no matching relationship. The worker queue was empty at the failure checkpoint.
- Earlier logs showed Friendica's URL verifier receiving 503 from its own site root. Treat this as a lead, not an independently proven cause.
- The fixture already corrects an empty reserved `uid=0` system-account nickname before requiring signed actor fetch. Do not duplicate this workaround or misdiagnose its prior absence as the current failure.
- Production signature validation, origin validation, URL checks and private-address SSRF safety must remain enabled. This is a disposable test with synthetic hostnames, not permission to disable validation in the actual product.

## Latest fixture evidence and interpretation (2026-11-12)

The latest pinned Friendica 2026.05 run on this diagnostic branch
([43311520418](https://github.com/outlaw-dame/mastopod-federation-architecture/actions/runs/43311520418))
created a matching remote `apcontact` with a nonempty public key and inbox,
but **did not** create the remote `contact` relationship or `inbox-entry`.
The local Friendica target exists as a `user` and self `contact`. Its
`apcontact` row was absent at the checkpoint, which is **not sufficient by
itself** to prove a defect: Friendica's `Receiver::fetchObjectType()` can
resolve the local account through `APContact::getByURL()` or by a signed
dereference when the cached APContact does not exist. Do not insert synthetic
`apcontact` rows to make this test pass.

Because Mastodon and Friendica accept an actor URI as the Follow `object`,
a raw Follow with that object is not malformed merely for lacking an embedded
`Person` object. The key difference in their pipelines is *where trust and
object classification happen*: Mastodon performs its signature prerequisite
before its processing worker, while Friendica resolves actor information and
may fetch the Follow's target object as part of processing. Both ultimately
require real relationship state. The new fixture bootstrap checks the local
target's canonical ActivityPub JSON `id`, account `type` and `inbox`
**before** starting the real Follow test. Its status is not assumed green.

The diagnostic logger contains `url_unreachable` hits; their specific URL
and causal relevance have not been proven. A `200` raw actor GET does not
establish a successful Friendica signed GET, nor does a `202` delivery
establish HTTP-signature trust.

## False-lead isolation and worker status (2026-11-12)

A disposable test-router experiment redirected only `https://friendica.test/`
to the valid local actor profile. The exact-head multi-implementation run
[43317124844](https://github.com/outlaw-dame/mastopod-federation-architecture/actions/runs/43317124844)
removed the earlier 503 mentions from the bounded log counters, **but the
verified result remained `NATIVE_PROOF_OUTCOME=failure` and
`EXTERNAL_PROOF_OUTCOME=failure`**. Both `contact` and `inbox-entry`
acceptance evidence stayed empty. The experiment was reverted in
`18ad8fa`; do not present the site-root 503 as the established failure cause.

The Friendica app config reports `system.debugging => true`. The
previous `php bin/console.php daemon status` probe printed
`Daemon process isn't running (/var/run/friendica.pid)`. **That status is a
false-negative for the official pinned Docker image**: its `/cron.sh`
runs `php /var/www/html/bin/console.php daemon start -f`, and Friendica
2026.05's `src/System/Daemon.php::start` writes the PID file only in the
`!$foreground` branch. The controller's `status` command relies on that
file, so it cannot detect the official foreground process. A trial that
changed the PID file location also failed this invalid check and does not
prove the worker had exited. The fixture now uses bounded Docker process
health, not a PID file, and leaves the upstream daemon configuration
unchanged. **The Follow persistence defect still needs its own proof.**

Next isolate the **first** Friendica receiving-side rejection in the path
`Inbox::post → Receiver::processInbox → HTTPSignature::getSigner →
Receiver::prepareObjectData/fetchObjectType → Processor::followUser`.
Capture bounded stage presence/absence, signed actor GET outcomes, object
type, local-user target resolution, and queue processing without dumping raw
signed payloads or disabling URL/SSRF protection. The existing remote actor
`apcontact` and local actor JSON success do not establish these downstream
stages.

## Exact next diagnostic sequence (do not weaken pass conditions)

1. Verify the disposable Friendica application config genuinely enables logging **after** installation, and read only bounded log-category counts; never upload raw signed requests, body text, credentials or private actor data.
2. Verify `apcontact` has the exact canonical ActivityPods actor URI, public key, type and inbox. If missing, the failure precedes HTTP signature processing. Investigate Friendica's **signed** actor GET, JSON-LD context resolution, WebFinger handling, URL/SSRF verifier, and origin certificate trust. Do not infer success from raw curl GET.
3. If `apcontact` exists, check signing principal: the received `actor`, `Signature keyId`/actor URI, digest, host, path and Date must agree under Friendica's own signature verification. Keep negative-signer tests.
4. If signatures verify, trace `Receiver::processActivity` object type, recipient, local target ID and the `Processor::followUser` path; assert actual SQL accepted or pending state.
5. Check that both native and sidecar modes produce verified remote state, real ActivityPods signer evidence and no cross-pod authorization regression; then run the complete seven-target protected matrix on the *exact head*.
6. Repeat the test with a disposable Mastodon-style actor fixture that exercises `application/activity+json`, canonical actor ID, public key ownership, `inbox`, `outbox`, `followers` and optional `endpoints.sharedInbox`. A passing Mastodon lane is a comparison, not a reason to skip Friendica.

The release gate remains closed while either native or sidecar Friendica persistence is absent. See issue #149 and PR #153.
