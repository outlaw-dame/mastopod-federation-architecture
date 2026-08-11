# APDM Status

Last updated: 2026-08-11

## Phase status

| Phase | ActivityPods slice | Federation slice | Gate |
|---|---|---|---|
| APDM-P0 | PR #13 merged | PR #8 merged | PASS |
| APDM-P1 | PR #14 merged; hardening PR #23 merged | PR #9 merged; hardening PR #18 finalizing | HARDENING IMPLEMENTED; pending federation merge |
| APDM-P2 | PR #15 merged; hardening PR #22 merged | PR #10 merged; hardening PR #16 merged | PASS |
| APDM-P3 | PR #16 merged; hardening PR #21 merged | PR #11 merged; hardening PR #14 merged | PASS |
| APDM-P4 | PR #17 merged | PR #12 merged | PASS |
| APDM-P5 | not started | not started | blocked only until P1 federation hardening PR #18 merges |
| APDM-P6 | not started | not started | blocked by P5 |
| APDM-P7–P13 | not started | as needed | blocked by remote-authority stabilization |
| APDM-P14 | support as needed | not started | final network hardening proof before P15 |
| APDM-P15 | not started | not started | blocked by implementation phases |
| APDM-P16 | not started | not started | blocked by P15 |

## Phase 1 post-merge hardening

A pre-P5 retrospective of the original Delivery Plan contract found issues important enough to reopen the P1 gate. The fixes preserve the `ap.delivery-plan.v1` field shape and version while strengthening producer, consumer, native rollback, crash recovery, and external-delivery semantics.

### ActivityPods hardening — PR #23 merged

PR #23 was squash-merged as `e8ee664564bcfbd4cb832cbf5d3edc29f1ec0ef4` after its final Backend Checks, stable unit lane, and offline ATProto smoke passed and its substantive review threads were resolved.

Implemented:
- producer/consumer/schema agreement for `searchConsent` object-or-null semantics;
- execution endpoint rejection of credentials, fragments including a bare trailing `#`, whitespace, and control characters;
- canonical lowercase `targetDomain` with DNS trailing-dot aliases removed;
- fail-closed canonicalization for non-JSON values and sparse arrays;
- sender-specific followers-address detection;
- explicit recipient completeness checks;
- recursive blind-address recognition/sanitization for compact, expanded, prefixed, and inline-aliased ActivityStreams `bto`/`bcc` properties;
- native rollback, local delivery, events, persistence, and external planning receive sanitized Activity bytes while legitimate blind recipients remain routable;
- external mode writes a private Redis blind-recipient recovery snapshot **before** `activitypub.activity.post`, so a crash after Fuseki persistence but before Bull handoff cannot permanently lose blind recipients;
- the recovery snapshot identity deliberately excludes the persistence-assigned Activity id; reconciliation restores the snapshot only for recipient discovery and still builds the Delivery Plan from sanitized persisted Activity bytes;
- snapshot write failure fails closed before Activity persistence;
- bare Objects such as `Note` do not have top-level `bto`/`bcc` reintroduced as generated-Create recipients, matching exact SemApps 1.1.4 `activitypub.object.wrap` behavior;
- unsupported unique `audience` recipients and sender-followers audience fail **before persistence**; a concrete audience actor is accepted only when already represented in SemApps-supported addressing;
- hardened internal handoff URL normalization;
- dedicated blind-reconciliation, bare-Object, expanded/aliased JSON-LD, privacy, and existing P2–P4 compatibility regressions.

### Federation hardening — PR #18

Implemented on the finalizing branch:
- Zod consumer mirrors producer endpoint/domain/search-consent semantics;
- consumer resolves ActivityStreams addressing across compact keys, expanded full IRIs, prefixed compact IRIs, and inline `@context` aliases;
- consumer rejects outbound Activity payloads containing `bto`/`bcc` in compact, expanded, prefixed, or aliased form, including nested values;
- consumer completeness checks include visible and audience recipients expressed through the same normalized JSON-LD term forms;
- sender-followers audience fails closed under the current SemApps 1.1.4 compatibility policy;
- canonicalizer rejects sparse arrays/non-JSON values;
- authoritative contract documentation records blind-address, audience, recovery, and network-security boundaries.

### Codex review findings addressed

Codex review found four material issues during closeout and all were fixed before merge:
1. a bare URL fragment delimiter (`.../inbox#`) bypassed `URL.hash` truthiness;
2. sparse JavaScript arrays could collide under canonicalization;
3. pre-persistence blind-address sanitization initially made P4 crash reconciliation unable to recover blind-only recipients;
4. expanded/custom-aliased ActivityStreams properties could bypass blind-address rejection or explicit-recipient completeness checks.

A separate ActivityPods finding also caught that blindly recovering top-level `bto`/`bcc` from a bare Object would invent recipients that SemApps 1.1.4 `object.wrap` never lifted into the generated Create activity. That behavior is now explicitly prevented and regression-tested.

### Phase 1 hardening exit gate

P1 hardening returns to PASS when all of the following are true:
1. ActivityPods Backend Checks pass on the final PR #23 head, including the stable unit lane and offline ATProto smoke — **PASS**;
2. Fedify Fast Checks and AP Interop Smoke pass on the final PR #18 head — Fast Checks **PASS**, final interop pending after this status-only update;
3. producer, JSON Schema, and Zod consumer remain compatible — **PASS in focused regressions**;
4. blind-address routing is preserved while persistence/local/native/external Activity bytes remain sanitized — **PASS**;
5. crash reconciliation can recover blind recipients without exposing blind fields in persisted/outbound Activity bytes — **PASS**;
6. unsupported `audience` semantics fail before persistence rather than after commit — **PASS**;
7. compact/expanded/prefixed/aliased ActivityStreams addressing cannot bypass privacy or completeness checks — **PASS**;
8. no unresolved substantive review threads/comments remain — pending final PR #18 closeout;
9. both hardening PRs are merged — ActivityPods #23 **merged**, federation #18 pending.

Only after this gate is PASS may APDM Phase 5 begin. Phase 5 has **not** started.

## Baseline phases carried forward

- P0: federation PR #8 / ActivityPods PR #13 merged.
- P1 baseline: federation PR #9 / ActivityPods PR #14 merged; strict cross-repo `ap.delivery-plan.v1` contract established.
- P2: federation PR #10 / ActivityPods PR #15 merged; hardening federation PR #16 / ActivityPods PR #22 merged. Pre-`remotePost` interception and native rollback are tested.
- P3: federation PR #11 / ActivityPods PR #16 merged; hardening federation PR #14 / ActivityPods PR #21 merged. SemApps' expanded live local/remote partition is the authoritative Delivery Plan source.
- P4: federation PR #12 / ActivityPods PR #17 merged. Durable handoff and crash-safe duplicate suppression are complete; P1 hardening adds a private blind-recipient recovery snapshot so that guarantee also holds for blind-addressed Activities.

## Verified SemApps 1.1.4 baseline relevant to P1

- `activitypub.activity.getRecipients` scans `to`, `bto`, `cc`, and `bcc`, expands the sender's local followers collection, skips Public, and does not process `audience`;
- the native outbox persists/processes the Activity before recipient discovery, then creates native `remotePost` jobs, emits `activitypub.outbox.posted`, and invokes local delivery;
- `activitypub.object.wrap` lifts only `to` and `cc` from a bare Object into a generated Create activity;
- APDM therefore treats blind routing separately from serialized Activity bytes and preserves SemApps' bare-Object semantics rather than inventing new recipient behavior.

## Remaining later-phase security/measurements

P1 syntax/semantic validation is not a complete SSRF defense. DNS resolution, private/link-local/loopback address rejection, redirect revalidation, and DNS-rebinding protections remain execution-layer responsibilities and must be validated at the sidecar HTTP boundary in the appropriate remote-authority/network-hardening phases.

Later measurements also remain:
- nested Tier 1 local fan-out operation count;
- runtime duplicate-HTTP frequency during the pre-cutover coexistence window;
- optional historical follower-membership snapshots if exact follower membership at original post time is required across recovery windows.
