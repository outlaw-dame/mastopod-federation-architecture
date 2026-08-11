# APDM Phase 2 — post-merge hardening

This is the architecture-side companion for the post-merge audit of the ActivityPods pre-`remotePost` interception seam. It does not change Fedify runtime behavior and does not start APDM Phase 5.

## Scope and ownership

Phase 2 remains primarily an ActivityPods concern because the critical seam exists before SemApps creates native `remotePost` work. Fedify does not participate in deciding whether those native jobs are created.

The paired ActivityPods hardening validates the exact assumptions that make external interception safe:

- `@semapps/activitypub` remains pinned to 1.1.4;
- the installed outbox still contains `getRecipients -> remotePost creation -> activitypub.outbox.posted -> localPost` in the expected order;
- the `localPost` method and `remotePost` queue processor still exist;
- every suppressed remote job contains a safe concrete recipient and the same Activity identity as the outbox result;
- all observed local-delivery calls use the same Activity identity and safe concrete recipients;
- multiple localPost observations are accumulated instead of overwritten;
- malformed intercepted jobs fail closed before Delivery Plan construction or durable handoff.

## Why this matters to the federation side

Fedify can only be a safe eventual remote authority if the upstream ActivityPods seam can prove that no native recipient was silently discarded during interception. A delivery plan generated from a filtered or malformed intercepted job would create a permanent delivery gap before the sidecar ever received work.

The federation side therefore treats the following as preconditions inherited from ActivityPods:

1. native mode remains exact SemApps rollback behavior;
2. external interception is request-local and never mutates the shared Moleculer service instance;
3. unrelated queue jobs continue through the native queue implementation;
4. intercepted remote jobs are validated before their recipients become authoritative planning inputs;
5. local delivery remains Tier 1 and is only observed, never replaced by the sidecar.

## Additional seam hardening

The ActivityPods adapter also fails closed on unsafe external handoff configuration: credential-bearing or fragment-bearing HTTP URLs, blank handoff tokens, missing durable queue configuration, and unreasonable/non-finite handoff timeouts.

These checks live on the same strategy boundary but do not transfer remote-delivery authority to Fedify. Phase 4 still owns durable acceptance and Phase 5 still owns production authority cutover.

## Gate

The hardening is complete only after:

- ActivityPods full Backend Checks pass on the final hardening head;
- the exact SemApps registration-parity and interception-invariant tests pass;
- any substantive Codex/review findings are addressed;
- this architecture companion is merged;
- APDM status is updated to record the actual hardening PRs/merge commits.

Production remote authority remains **not started** until APDM Phase 5.
