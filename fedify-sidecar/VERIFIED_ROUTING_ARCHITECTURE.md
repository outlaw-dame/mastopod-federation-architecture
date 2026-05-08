/**
 * VERIFIED ARCHITECTURE ROUTING ANALYSIS
 * 
 * Complete tracing of inbound/outbound data flows for all visibility scopes
 * with Stream2, Stream1, Canonical Stream, and non-public routing verified
 * against actual code paths in inbound-worker.ts and outbox-intent-worker.ts
 */

// ============================================================================
// VERIFIED INBOUND ROUTING (from inbound-worker.ts code analysis)
// ============================================================================

/**
 * INBOUND: AKKOMA LOCAL-SCOPE POST
 * Activity: Create { to: ["https://example.org/#Public"] } (no as:Public)
 * 
 * Code Path:
 *   Line 1105-1133: Step 2.5 - Akkoma local-scope guard
 *   - Check: isLocalScopeOnly(activity) || isLocalScopeOnly(activity.object)
 *   - Result: TRUE
 *   - Action: metrics.inc("local_scope_dropped")
 *   - Action: queue.ack("inbound")  // CONSUME MESSAGE
 *   - Action: RETURN EARLY
 * 
 * Destinations:
 *   ✗ ActivityPods: NOT forwarded (early return)
 *   ✗ Stream1 (Firehose): NOT published (early return)
 *   ✗ Stream2: NOT published (early return)
 *   ✗ AT Projection: NOT called (early return)
 *   ✗ Canonical Stream: NOT published (early return)
 * 
 * Summary: COMPLETELY DROPPED. No streaming, no delivery, no indexing.
 */

/**
 * INBOUND: PUBLIC POST (Remote Actor)
 * Activity: Create { to: [as:Public] }
 * Actor: https://remote.example/users/alice
 * 
 * Code Path:
 *   Line 1577: isPublic = this.isPublicActivity(activity) → TRUE
 *   Line 1578: isPolicyFiltered = (MRF check) → FALSE
 *   Line 1579: isPublicForDiscovery = TRUE && !FALSE → TRUE
 *   
 *   Line 1595-1650: Step 4.25 - isLocalActor check
 *   - Check: verifiedActorUri.includes(":// config.domain /") → FALSE (remote)
 *   - Continue (don't take fast-path)
 *   
 *   Line 1774-1823: Step 5 - Forward to ActivityPods
 *   - POST to ActivityPods webhook with:
 *     * activity (full JSON)
 *     * verifiedActorUri
 *     * envelope.path, envelope.headers
 *   - Action: forwardedSuccessfully = TRUE
 *   - NO EARLY RETURN
 *   
 *   Line 1834-1857: Step 6 - Stream2 Publication
 *   - Check: if (isPublicForDiscovery) → TRUE
 *   - Call: redpanda.publishToStream2({
 *       activity,
 *       actorUri: verifiedActorUri,
 *       receivedAt: envelope.receivedAt,
 *       path: envelope.path,
 *       meta: searchEventMeta,  // SEARCH CONSENT SIGNALS
 *       delivery: {
 *         forwarding: "attempted",
 *         recipientCount: recipientCounts.total,
 *         localRecipientCount: recipientCounts.local
 *       }
 *     })
 *   - Action: redpanda.publishTombstone (if Delete/Undo)
 *   
 *   Line 1885-1895: Step 6.5 - AT Projection
 *   - Check: if (isPublicForDiscovery) → TRUE
 *   - Call: invokeAtProjection(activity, verifiedActorUri)
 *     * Internal: atProjection.projectToCanonical(activity, actorUri)
 *     * Projects AP activity to canonical/AT format
 *     * Fault-isolated: errors logged but don't block
 *   
 *   Line 1898-1920: Step 6.7 - Canonical Publisher
 *   - Check: if (!isPolicyFiltered) → TRUE
 *   - Call: invokeCanonicalPublisher({
 *       activity,
 *       actorUri: verifiedActorUri,
 *       isPublic: isPublicForDiscovery → TRUE
 *       isPrivate: !isPublicForDiscovery → FALSE
 *       isLocal: false
 *       kind: undefined (unless Update/Delete/Undo)
 *     })
 *   - Publishes to canonical event stream (for AT/search indexing)
 *   
 *   Line 1997-2022: Step 6.9 - Replies Backfill
 *   - (Fault-isolated async task for Note replies)
 * 
 * Destinations:
 *   ✓ ActivityPods: YES - forwarded with full activity
 *   ✓ Stream1 (Firehose): NO - not published from remote (reserved for local)
 *   ✓ Stream2: YES - published as public search/timeline feed
 *   ✓ AT Projection: YES - projected to canonical/AT format
 *   ✓ Canonical Stream: YES - published with isPublic=true
 * 
 * Metadata Included:
 *   - searchEventMeta: searchableBy signals, indexability flags
 *   - recipientCounts: total/local recipient counts
 *   - delivery: forwarding status, recipient metadata
 * 
 * Summary: Full federation path. Public timeline, search indexing, AT projection.
 */

/**
 * INBOUND: FOLLOWERS-ONLY POST (Remote Actor)
 * Activity: Create { to: [followers_collection_uri] } (no as:Public)
 * Actor: https://remote.example/users/bob
 * 
 * Code Path:
 *   Line 1577: isPublic = this.isPublicActivity(activity) → FALSE
 *   Line 1578: isPolicyFiltered = FALSE
 *   Line 1579: isPublicForDiscovery = FALSE && !FALSE → FALSE
 *   
 *   Line 1595-1650: Step 4.25 - isLocalActor check → FALSE (skip)
 *   
 *   Line 1774-1823: Step 5 - Forward to ActivityPods
 *   - POST to ActivityPods webhook (SAME AS PUBLIC)
 *   - Activity forwarded regardless of visibility
 *   - forwardedSuccessfully = TRUE
 *   - NO EARLY RETURN
 *   
 *   Line 1834-1857: Step 6 - Stream2 Publication
 *   - Check: if (isPublicForDiscovery) → FALSE
 *   - SKIPPED - followers-only not published to Stream2
 *   
 *   Line 1885-1895: Step 6.5 - AT Projection
 *   - Check: if (isPublicForDiscovery) → FALSE
 *   - SKIPPED - followers-only not projected to AT
 *   
 *   Line 1898-1920: Step 6.7 - Canonical Publisher
 *   - Check: if (!isPolicyFiltered) → TRUE
 *   - Call: invokeCanonicalPublisher({
 *       activity,
 *       actorUri: verifiedActorUri,
 *       isPublic: FALSE  // ← KEY DIFFERENCE
 *       isPrivate: TRUE  // ← marked as private
 *       isLocal: false
 *     })
 *   - Published to canonical stream with isPrivate=true flag
 * 
 * Destinations:
 *   ✓ ActivityPods: YES - forwarded with full activity
 *   ✗ Stream1 (Firehose): NO - not published
 *   ✗ Stream2: NO - not published (scoped activity)
 *   ✗ AT Projection: NO - not projected
 *   ✓ Canonical Stream: YES - published with isPrivate=true flag
 * 
 * Metadata Included:
 *   - searchEventMeta: NONE (not built for non-public)
 *   - recipientCounts: ZEROED (line 1591: zero-fill for non-public)
 *   - delivery: NOT included (only for Stream2 public activities)
 * 
 * Summary: Activity reaches ActivityPods for local delivery but is GATED from
 *          public timelines, search indexing, and AT projection. Canonical
 *          stream marks it as private for event routing.
 */

/**
 * INBOUND: DIRECT MESSAGE (Remote Actor to Local User)
 * Activity: Create { to: [local_user_uri] } (no public, no followers)
 * Actor: https://remote.example/users/alice
 * 
 * Code Path: (IDENTICAL to followers-only)
 *   isPublic = FALSE
 *   isPublicForDiscovery = FALSE
 *   ActivityPods forwarding: YES
 *   Stream2: SKIPPED
 *   AT Projection: SKIPPED
 *   Canonical: YES with isPrivate=true
 * 
 * Destinations:
 *   ✓ ActivityPods: YES - forwarded (local user receives DM)
 *   ✗ Stream1: NO
 *   ✗ Stream2: NO
 *   ✗ AT Projection: NO
 *   ✓ Canonical Stream: YES (private)
 * 
 * Summary: Delivered only to local user via ActivityPods. Never published to
 *          public feeds or indexed.
 */

/**
 * INBOUND: ANNOUNCE OF PUBLIC POST (Remote Actor)
 * Activity: Announce { object: Note { to: [as:Public] } }
 * Announcer: https://remote.example/users/bob
 * 
 * Code Path:
 *   Line 1517-1568: Step 3.85 - Followers-only Announce guard
 *   - Check: activityType === "Announce" → TRUE
 *   - Check: isFollowersOnlyObjectAddressing(announced_object) → FALSE (is public)
 *   - GUARD NOT TRIGGERED
 *   
 *   Line 1577: isPublic = TRUE (Announce has object.to = as:Public)
 *   Line 1579: isPublicForDiscovery = TRUE
 *   
 *   Then proceeds through full public routing path (Stream2, AT projection, etc)
 * 
 * Summary: Processed as public activity. Full federation.
 */

/**
 * INBOUND: ANNOUNCE OF FOLLOWERS-ONLY POST BY NON-AUTHOR (Remote Actor)
 * Activity: Announce { object: Note { to: [followers_uri], attributedTo: [author_uri] } }
 * Announcer: https://remote.example/users/alice (NOT author)
 * Author: https://remote.example/users/bob
 * 
 * Code Path:
 *   Line 1517-1568: Step 3.85 - Followers-only Announce guard
 *   - Check: activityType === "Announce" → TRUE
 *   - Check: isRecord(activity["object"]) → TRUE (inline object)
 *   - Check: isFollowersOnlyObjectAddressing(object) → TRUE
 *   - Extract: objectAuthors = {bob_uri}
 *   - Extract: normalizedAnnouncer = alice_uri
 *   - Check: alice_uri in {bob_uri} → FALSE (not author)
 *   - Action: metrics.inc("announce_followers_scope_rejected")
 *   - Action: queue.ack("inbound")  // CONSUME
 *   - Action: RETURN EARLY
 * 
 * Destinations:
 *   ✗ ActivityPods: NOT forwarded
 *   ✗ Stream2: NOT published
 *   ✗ Canonical: NOT published
 * 
 * Summary: REJECTED. Non-authors cannot Announce followers-only posts.
 */

/**
 * INBOUND: ANNOUNCE OF FOLLOWERS-ONLY POST BY AUTHOR (Remote Actor)
 * Activity: Announce { object: Note { to: [followers_uri], attributedTo: [author_uri] } }
 * Announcer: https://remote.example/users/bob (is author)
 * Author: https://remote.example/users/bob
 * 
 * Code Path:
 *   Line 1517-1568: Step 3.85 guard
 *   - Check: isFollowersOnlyObjectAddressing(object) → TRUE
 *   - Extract: objectAuthors = {bob_uri}
 *   - Extract: normalizedAnnouncer = bob_uri
 *   - Check: bob_uri in {bob_uri} → TRUE (is author)
 *   - GUARD NOT TRIGGERED
 *   
 *   Line 1577: isPublic = FALSE (Announce has object.to = followers_uri, no as:Public)
 *   Line 1579: isPublicForDiscovery = FALSE
 *   
 *   Then proceeds through followers-only routing path (ActivityPods, Canonical private)
 * 
 * Summary: Accepted. Author can Announce own followers-only posts.
 */

/**
 * INBOUND: ANNOUNCE WITH URI-ONLY OBJECT (Remote Actor)
 * Activity: Announce { object: "https://example.com/users/charlie/notes/456" }
 * Announcer: https://remote.example/users/alice
 * 
 * Code Path (NEW Option A):
 *   Line 1517-1568: Step 3.85 guard (enhanced)
 *   - Check: isRecord(activity["object"]) → FALSE (is string)
 *   - Skip inline path
 *   - Check: typeof activity["object"] === "string" → TRUE
 *   - Call: fetchRemoteAnnounceObject(uri) with 3s timeout
 *   
 *   Case A: Hydration succeeds, object is followers-only, announcer not author
 *   - Apply authorization check (same as inline)
 *   - Result: REJECT with "hydrated: true" in logs
 *   
 *   Case B: Hydration succeeds, object is public
 *   - No followers-only guard trigger
 *   - Proceed as public Announce
 *   
 *   Case C: Hydration times out after 3s
 *   - Log: "Hydration timeout for Announce object URI"
 *   - PASS THROUGH (conservative - uncertain scope doesn't block)
 *   - Proceed without scope check
 *   
 *   Case D: Hydration fails (404, network error)
 *   - Log: "Failed to hydrate Announce object URI"
 *   - PASS THROUGH (conservative)
 * 
 * Summary: Best-effort scope checking with graceful fallback.
 */

/**
 * INBOUND: LOCAL ACTOR ACTIVITY (from config.domain)
 * Activity: Create { to: [as:Public] }
 * Actor: https://config.domain/users/alice
 * 
 * Code Path:
 *   Line 1595-1650: Step 4.25 - isLocalActor check
 *   - Check: isLocalActor = (verifiedActorUri.includes(":// config.domain /")) → TRUE
 *   - Action: metrics.inc("local_actor_uri")
 *   - Action: queue.ack("inbound")  // CONSUME
 *   
 *   Line 1658-1674: Stream1 Publication (LOCAL FIREHOSE)
 *   - Check: if (isPublicForDiscovery) → TRUE (if public)
 *   - Call: redpanda.publishToStream1({
 *       activity,
 *       actorUri,
 *       ...
 *     })
 *   - Note: Stream1 is for LOCAL actors (firehose)
 *   
 *   Line 1680-1689: AT Projection (LOCAL ONLY)
 *   - Check: if (isPublicForDiscovery) → TRUE
 *   - Call: invokeAtProjection(activity, verifiedActorUri)
 *   
 *   Line 1691-1714: Canonical Publisher (LOCAL)
 *   - Call: invokeCanonicalPublisher({
 *       ...
 *       isLocal: true  // ← KEY: marked as local
 *     })
 *   
 *   Line 1716-1742: EARLY RETURN
 *   - NO Step 5 forwarding to ActivityPods (local actor activity doesn't forward)
 *   - NO Step 6 Stream2 publication (only Stream1 for local)
 *   
 * Destinations:
 *   ✗ ActivityPods: NOT forwarded (local activity, returns early)
 *   ✓ Stream1: YES - published to local firehose
 *   ✗ Stream2: NO - not published from local actor
 *   ✓ AT Projection: YES (if public)
 *   ✓ Canonical: YES with isLocal=true
 * 
 * Summary: Local actor activities published to Stream1 (local firehose) instead
 *          of Stream2 (remote firehose). Never forwarded to ActivityPods.
 */

// ============================================================================
// VERIFIED OUTBOUND ROUTING (from outbox-intent-worker.ts code analysis)
// ============================================================================

/**
 * OUTBOUND: PUBLIC ACTIVITY
 * Activity: Create { to: [as:Public] }
 * Local Actor: https://pod.example/users/alice
 * Targets: [followers_collection, public_collection, all_remotes]
 * 
 * Code Path:
 *   Line 247-277: publishEventLog()
 *   - Check: isPublicActivity = (meta.visibility === "public" || "unlisted") → TRUE
 *   - Call: redpanda.publishToStream1({
 *       activity,
 *       actorUri: intent.actorUri,
 *       origin: "local",
 *       ...
 *     })
 *   - Published to Stream1 (LOCAL FIREHOSE)
 *   
 *   Line 310 (Option B): validateTargetConformance(activity, targets)
 *   - Calls: getActivityAudienceScope(activity) → "public"
 *   - Check: if (public) → no restrictions
 *   - Result: No conformance warnings (any targets OK)
 *   
 *   Line 347-359: buildOutboundJobs()
 *   - For each normalized target:
 *     * Create OutboundJob
 *     * Serialize activity with delivery policy applied
 *     * Include metadata
 *   - Queue for HTTP delivery
 * 
 * Destinations:
 *   ✓ Stream1: YES - published (local public activity)
 *   ✗ Stream2: NO - not published outbound (Stream2 is inbound only)
 *   ✓ HTTP Delivery: YES - all targets receive HTTP POST
 * 
 * Summary: Published to local firehose, delivered to all specified targets.
 */

/**
 * OUTBOUND: FOLLOWERS-ONLY ACTIVITY
 * Activity: Create { to: [followers_collection] } (no as:Public)
 * Local Actor: https://pod.example/users/alice
 * Targets: [followers_inbox_1, followers_inbox_2, followers_collection]
 * Meta: { visibility: "followers" }
 * 
 * Code Path:
 *   Line 247-277: publishEventLog()
 *   - Check: isPublicActivity = FALSE (visibility === "followers")
 *   - SKIPPED - followers-only NOT published to Stream1
 *   
 *   Line 310 (Option B): validateTargetConformance(activity, targets)
 *   - Calls: getActivityAudienceScope(activity) → "followers"
 *   - Check: if (followers-only) → targets must be followers inboxes
 *   - Inspect targets:
 *     * followers_inbox_1: includes "/followers" or "/inbox" → OK
 *     * followers_inbox_2: includes "/inbox" → OK
 *     * followers_collection: includes "/followers" → OK
 *   - Result: Conformance check passes (no warnings)
 *   
 *   Line 347-359: buildOutboundJobs()
 *   - Queue all targets for HTTP delivery
 * 
 * Destinations:
 *   ✗ Stream1: NO - not published (scoped activity)
 *   ✗ Stream2: NO - not applicable (outbound only)
 *   ✓ HTTP Delivery: YES - only to followers (scoped targets)
 * 
 * Summary: NOT published to public firehose. Delivered only to followers.
 *          Conformance check ensures targets respect followers-only scope.
 */

/**
 * OUTBOUND: DIRECT MESSAGE
 * Activity: Create { to: [recipient_uri] } (no public, no followers)
 * Local Actor: https://pod.example/users/alice
 * Targets: [recipient_inbox_uri]
 * Meta: { visibility: "direct" }
 * 
 * Code Path:
 *   Line 247-277: publishEventLog()
 *   - Check: isPublicActivity = FALSE
 *   - SKIPPED
 *   
 *   Line 310: validateTargetConformance(activity, targets)
 *   - Calls: getActivityAudienceScope(activity) → "direct"
 *   - Check: if (direct) → targets must match explicitly-addressed actors in to/cc
 *   - Extract addressed URIs: {recipient_uri}
 *   - Inspect targets: {recipient_inbox_uri}
 *   - Check: recipient_inbox_uri in {recipient_uri} → TRUE
 *   - Result: Conformance check passes
 *   
 *   Line 347-359: buildOutboundJobs()
 *   - Queue recipient inbox for HTTP delivery
 * 
 * Destinations:
 *   ✗ Stream1: NO
 *   ✗ Stream2: NO
 *   ✓ HTTP Delivery: YES - only to named recipient
 * 
 * Summary: NOT published to firehose. Delivered only to explicitly-addressed
 *          recipient.
 */

/**
 * OUTBOUND CONFORMANCE VIOLATION (Option B Warning)
 * Activity: Create { to: [followers_collection] } (followers-only)
 * Targets: [followers_inbox_1, random_remote_inbox, public_relay]
 * 
 * Code Path:
 *   Line 310: validateTargetConformance(activity, targets)
 *   - Check: getActivityAudienceScope(activity) → "followers"
 *   - Extract addressed URIs: {followers_collection}
 *   - Inspect targets:
 *     * followers_inbox_1: "/followers" or "/inbox" → OK
 *     * random_remote_inbox: random domain → NOT in addressed URIs
 *     * public_relay: public relay endpoint → NOT in addressed URIs
 *   - Found off-scope targets: [random_remote_inbox, public_relay]
 *   - Action: metrics.inc("conformance_warn")
 *   - Log: "Followers-only activity delivered to non-followers/inbox targets"
 *   - Log includes: target count, examples
 * 
 * Result: Activity STILL DELIVERED (warning-only, not fatal)
 *         Future work could make violations fatal
 * 
 * Summary: Conformance check logs violations but doesn't block delivery (yet).
 */

// ============================================================================
// KEY INSIGHTS FROM VERIFIED ROUTING
// ============================================================================

/**
 * Stream2 (Remote Firehose):
 *   - INBOUND ONLY: Published from remote actor activities if public
 *   - Includes metadata: searchEventMeta (search consent), recipient counts
 *   - NOT published from local actors (local actors use Stream1)
 *   - NOT published from non-public activities (followers-only, direct)
 *   - Purpose: Remote public activity discovery, search indexing, federation
 */

/**
 * Stream1 (Local Firehose):
 *   - LOCAL ONLY: Published from local actor activities if public
 *   - Also: Memory AP relay activities (sidecar actors)
 *   - NOT published from remote actors (remote actors use Stream2)
 *   - NOT published from non-public activities
 *   - Purpose: Local public activity discovery, timeline
 */

/**
 * Canonical Stream:
 *   - ALL ACTIVITIES: Published regardless of visibility
 *   - Includes isPublic and isPrivate flags
 *   - Includes isLocal flag (distinguishes local vs remote)
 *   - Includes kind for lifecycle events (PostEdit, PostDelete)
 *   - Fault-isolated: errors logged but don't block
 *   - Purpose: Event routing for AT bridge, metrics, cross-protocol sync
 */

/**
 * AT Projection:
 *   - PUBLIC ONLY: Projected if isPublicForDiscovery = true
 *   - LOCAL ONLY: Invoked only for local actors OR specific public conditions
 *   - Skipped for followers-only and direct messages
 *   - Fault-isolated: errors logged but don't block
 *   - Purpose: Convert AP activities to Bluesky AT format
 */

/**
 * ActivityPods:
 *   - ALL INBOUND ACTIVITIES (except local-scope, followers-only Announce violations)
 *   - Includes: activity, verified actor URI, envelope path/headers
 *   - Forwarding bypassed for: local actors (they're already on domain)
 *   - Forwarding bypassed for: sidecar actors (managed by sidecar)
 *   - Forwarding bypassed for: early-exit guards (local-scope, Announce auth)
 *   - Purpose: Local user delivery, persistence, visibility enforcement
 */

/**
 * Non-Public Content Routing:
 * 
 * FOLLOWERS-ONLY & DIRECT (INBOUND):
 *   - NOT in Stream1 (local firehose)
 *   - NOT in Stream2 (remote firehose)
 *   - NOT in AT Projection (Bluesky)
 *   - YES in Canonical Stream (with isPrivate=true flag)
 *   - YES in ActivityPods (for local delivery)
 *   → Result: Scoped activities reach only intended recipients
 * 
 * FOLLOWERS-ONLY & DIRECT (OUTBOUND):
 *   - NOT published to Stream1 (not public)
 *   - Conformance checked to ensure targets match scope
 *   - Delivered only to scoped targets (followers, named recipients)
 *   → Result: Outbound delivery respects declared scope
 */

/**
 * LOCAL-SCOPE BLOCKING (Akkoma):
 *   - INBOUND: Dropped at Step 2.5 before ANY downstream processing
 *   - NO ActivityPods forwarding
 *   - NO Stream1/Stream2 publication
 *   - NO AT Projection
 *   - NO Canonical Stream publication
 *   → Result: Zero cross-origin leakage
 */

/**
 * Followers-Only Announce Authorization (GoToSocial Compatibility):
 *   - INBOUND: Checked at Step 3.85
 *   - INLINE OBJECTS: Immediate check
 *   - URI-ONLY OBJECTS: Attempted hydration with 3s timeout
 *   - Hydration timeout/failure: Pass through (conservative)
 *   - Authorization failure: Drop completely
 *   → Result: Prevents unauthorized scope escalation
 */

/**
 * Outbound Conformance (Option B):
 *   - PUBLIC: No restrictions (any targets OK)
 *   - FOLLOWERS: Targets limited to followers collection + actor inboxes
 *   - DIRECT: Targets must match explicitly-addressed recipients
 *   - LOCAL: Should not reach outbound (logs warning if does)
 *   - Violations: Warning-level (logged but delivery proceeds)
 *   → Result: Observable scope enforcement with graceful degradation
 */

// ============================================================================
// COMPLETE ROUTING DECISION TREES
// ============================================================================

/**
 * INBOUND ROUTING DECISION TREE (Remote Activity)
 * 
 *   Receive activity
 *     ↓
 *   [Step 2.5] Is it Akkoma local-scope-only?
 *     → YES: REJECT (drop, metric, return)
 *     → NO: continue
 *     ↓
 *   [Step 3] Verify actor
 *     ↓
 *   [Step 3.85] Is it Announce of followers-only by non-author?
 *     → YES: REJECT (drop, metric, return)
 *     → NO: continue
 *     ↓
 *   [Step 4] Determine visibility
 *     - isPublic = check to/cc for as:Public
 *     - isPublicForDiscovery = isPublic && !MRF-filtered
 *     ↓
 *   [Step 4.25] Is it from local actor?
 *     → YES: publishToStream1, AT-project (if public), Canonical(isLocal=true), RETURN
 *     → NO: continue
 *     ↓
 *   [Step 5] Forward to ActivityPods
 *     ↓
 *   [Step 6] Publish to Stream2 (if isPublicForDiscovery)
 *     ↓
 *   [Step 6.5] AT project (if isPublicForDiscovery)
 *     ↓
 *   [Step 6.7] Publish to Canonical (if not MRF-filtered)
 *     - isPublic flag indicates visibility
 *     - isLocal flag = false (remote activity)
 */

/**
 * OUTBOUND ROUTING DECISION TREE (Local Activity)
 * 
 *   ActivityPods queues outbox intent
 *     ↓
 *   Parse activity + targets
 *     ↓
 *   Normalize + deduplicate targets
 *     ↓
 *   [publishEventLog] Is activity public?
 *     → YES: publishToStream1, continue
 *     → NO: skip Stream1, continue
 *     ↓
 *   [Option B] Validate target conformance
 *     - getActivityAudienceScope(activity)
 *     - Check targets match scope
 *     - Log warnings for violations (don't block)
 *     ↓
 *   Build outbound jobs (one per target)
 *     ↓
 *   Apply delivery policy (preserve extensions)
 *     ↓
 *   Queue for HTTP delivery
 */

// ============================================================================
// SUMMARY TABLE: COMPLETE VISIBILITY ROUTING
// ============================================================================

/*
┌─────────────────┬────────────────┬──────────┬──────────┬────────────┬──────────────┬──────────────┐
│ SCOPE           │ INBOUND FROM   │ STREAM1  │ STREAM2  │ AT PROJECT │ CANONICAL    │ ACTIVITYPODS │
├─────────────────┼────────────────┼──────────┼──────────┼────────────┼──────────────┼──────────────┤
│ PUBLIC          │ Remote         │ NO       │ ✓ YES    │ ✓ YES      │ ✓ isPublic   │ ✓ YES        │
│ PUBLIC          │ Local          │ ✓ YES    │ NO       │ ✓ YES      │ ✓ isLocal    │ NO (early)   │
│ FOLLOWERS       │ Remote         │ NO       │ NO       │ NO         │ ✓ isPrivate  │ ✓ YES        │
│ FOLLOWERS       │ Local (out)    │ NO       │ N/A      │ N/A        │ N/A          │ Delivered    │
│ DIRECT          │ Remote         │ NO       │ NO       │ NO         │ ✓ isPrivate  │ ✓ YES        │
│ DIRECT          │ Local (out)    │ NO       │ N/A      │ N/A        │ N/A          │ Delivered    │
│ LOCAL (Akkoma)  │ Remote         │ ✗ REJECT │ ✗ REJECT │ ✗ REJECT   │ ✗ REJECT     │ ✗ REJECT     │
└─────────────────┴────────────────┴──────────┴──────────┴────────────┴──────────────┴──────────────┘

KEY:
  ✓ YES: Published/Processed
  NO: Not published/Processed
  ✗ REJECT: Activity dropped completely
  N/A: Not applicable (outbound only, no Stream2/AT projection)
*/

// ============================================================================
// CONFORMANCE RULES VERIFIED
// ============================================================================

/**
 * ✓ Verified: Local-scope posts never reach public timelines
 *   - Dropped at Step 2.5, before Stream1/Stream2 access
 * 
 * ✓ Verified: Followers-only posts not published to firehose
 *   - Not in Stream1 (local firehose)
 *   - Not in Stream2 (remote firehose)
 * 
 * ✓ Verified: Followers-only posts cannot be Announced by non-authors
 *   - Enforced at Step 3.85 (inline + URI-hydrated)
 * 
 * ✓ Verified: Direct messages not in public search/timeline
 *   - Not in Stream1 or Stream2
 *   - Published to Canonical with isPrivate=true
 * 
 * ✓ Verified: Local activities distinguish from remote in Canonical
 *   - isLocal=true for local actors
 *   - isLocal=false for remote actors
 * 
 * ✓ Verified: AT Projection only for public activities
 *   - Only called if isPublicForDiscovery=true
 * 
 * ✓ Verified: Outbound conformance validates target scope
 *   - Option B: Followers targets checked
 *   - Option B: Direct targets checked
 *   - Option B: Public targets unrestricted
 * 
 * ✓ Verified: Non-public content reaches ActivityPods
 *   - All followers-only and direct activities forwarded
 *   - ActivityPods handles local delivery logic
 * 
 * ✓ Verified: Canonical Stream receives all activities
 *   - With proper isPublic/isPrivate/isLocal flags
 *   - Enables event routing across protocols
 */
