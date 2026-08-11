# APDM Status

Last updated: 2026-08-11

## Phase status

| Phase | ActivityPods slice | Federation slice | Gate |
|---|---|---|---|
| APDM-P0 | PR #13 merged | PR #8 merged | PASS |
| APDM-P1 | PR #14 merged; hardening PR #23 finalizing | PR #9 merged; hardening PR #18 finalizing | HARDENING IMPLEMENTED; pending final paired merge |
| APDM-P2 | PR #15 merged; hardening PR #22 merged | PR #10 merged; hardening PR #16 merged | PASS |
| APDM-P3 | PR #16 merged; hardening PR #21 merged | PR #11 merged; hardening PR #14 merged | PASS |
| APDM-P4 | PR #17 merged | PR #12 merged | PASS |
| APDM-P5 | not started | not started | blocked until P1 hardening PRs merge |
| APDM-P6 | not started | not started | blocked by P5 |
| APDM-P7–P13 | not started | as needed | blocked by remote-authority stabilization |
| APDM-P14 | support as needed | not started | final network hardening proof before P15 |
| APDM-P15 | not started | not started | blocked by implementation phases |
| APDM-P16 | not started | not started | blocked by P15 |

## Phase 1 post-merge hardening

A pre-P5 retrospective of the original Delivery Plan contract found issues important enough to reopen the P1 gate. The fixes preserve the `ap.delivery-plan.v1` field shape and version while strengthening producer, consumer, native rollback, and external-delivery semantics.

### ActivityPods hardening — PR #23

Implemented:
- producer/consumer/schema agreement for `searchConsent` object-or-null semantics;
- execution endpoint rejection of credentials, fragments including a bare trailing `#`, whitespace, and control characters;
- canonical lowercase `targetDomain` with DNS trailing-dot aliases removed;
- fail-closed canonicalization for non-JSON values and sparse arrays;
- sender-specific followers-address detection;
- explicit recipient completeness checks;
- recursive removal of `bto`/`bcc` before SemApps persistence/delivery while recovering those values only inside request-local `getRecipients` routing;
- native rollback, local delivery, events, persistence, and external planning therefore receive sanitized Activity bytes while blind recipients remain routable;
- unsupported unique `audience` recipients and sender-followers audience fail **before persistence**; a concrete audience actor is accepted only when already represented in SemApps-supported `to/bto/cc/bcc` addressing;
- hardened internal handoff URL normalization;
- focused regression coverage plus the existing P2–P4 backend suites.

### Federation hardening — PR #18

Implemented:
- Zod consumer mirrors producer endpoint/domain/search-consent semantics;
- consumer rejects outbound Activity payloads containing `bto`/`bcc` anywhere;
- consumer checks visible/audience recipient completeness;
- sender-followers audience fails closed under the current SemApps 1.1.4 compatibility policy;
- canonicalizer rejects sparse arrays/non-JSON values;
- authoritative contract documentation records blind-address, audience, and network-security boundaries.

### Codex review findings

Codex identified two valid consumer issues on an earlier PR #18 head:
1. a bare URL fragment delimiter (`.../inbox#`) bypassed `URL.hash` truthiness even though the mirrored JSON Schema rejected it;
2. sparse JavaScript arrays could collide under array canonicalization because `Array.prototype.map` skips holes.

Both findings are fixed in **both** repositories with dedicated regressions. The corresponding review threads remain part of the closeout evidence and are resolved only after the final CI heads pass.

### Phase 1 hardening exit gate

P1 hardening returns to PASS when all of the following are true:
1. ActivityPods Backend Checks pass on the final PR #23 head, including the stable unit lane and offline ATProto smoke;
2. Fedify Fast Checks and AP Interop Smoke pass on the final PR #18 head;
3. producer, JSON Schema, and Zod consumer remain compatible;
4. blind-address routing is preserved while persistence/local/native/external Activity bytes remain sanitized;
5. unsupported `audience` semantics fail before persistence rather than after commit;
6. no unresolved substantive review threads/comments remain;
7. final manual/Codex review finds no remaining P1 blocker;
8. both hardening PRs are merged.

Only after this gate is PASS may APDM Phase 5 begin.

## Baseline phases carried forward

- P0: federation PR #8 / ActivityPods PR #13 merged.
- P1 baseline: federation PR #9 / ActivityPods PR #14 merged; strict cross-repo `ap.delivery-plan.v1` contract established.
- P2: federation PR #10 / ActivityPods PR #15 merged; hardening federation PR #16 / ActivityPods PR #22 merged. Pre-`remotePost` interception and native rollback are tested.
- P3: federation PR #11 / ActivityPods PR #16 merged; hardening federation PR #14 / ActivityPods PR #21 merged. SemApps' expanded live local/remote partition is the authoritative Delivery Plan source.
- P4: federation PR #12 / ActivityPods PR #17 merged. Durable handoff and crash-safe duplicate suppression are complete.

## Verified SemApps 1.1.4 baseline relevant to P1

- `activitypub.activity.getRecipients` scans `to`, `bto`, `cc`, and `bcc`, expands the sender's local followers collection, skips Public, and does not process `audience`;
- the native outbox persists/processes the Activity before recipient discovery, then creates native `remotePost` jobs, emits `activitypub.outbox.posted`, and invokes local delivery;
- without the APDM request-local privacy wrapper, that same Activity object would otherwise carry blind-address fields into downstream surfaces;
- `activitypub.object.wrap` lifts only `to` and `cc` from a bare Object into a generated Create activity.

## Remaining later-phase security/measurements

P1 syntax/semantic validation is not a complete SSRF defense. DNS resolution, private/link-local/loopback address rejection, redirect revalidation, and DNS-rebinding protections remain execution-layer responsibilities and must be validated at the sidecar HTTP boundary in the appropriate remote-authority/network-hardening phases.

Later measurements also remain:
- nested Tier 1 local fan-out operation count;
- runtime duplicate-HTTP frequency during the pre-cutover coexistence window;
- optional historical recipient snapshots if exact follower membership at original post time is required across recovery windows.
