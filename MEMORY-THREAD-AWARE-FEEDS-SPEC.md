# Memory Thread-Aware Feeds Specification

## Status

Proposed architecture and implementation plan for Memory's next-generation feed system.

This specification is grounded in the current Memory API feed pipeline:

- `memory/api/src/routes/atBridge.ts`
- `memory/api/src/db/atBridgeSchema.ts`
- `memory/api/src/utils/threadBumps.ts`

The current system supports:

- A unified ActivityPods + ATProto feed via `unified_feed_view`
- Chronological and protocol-balanced timeline modes
- Follow-aware reply bumping based on the reply author
- Reply root and parent URI tracking

The next system extends this to support:

- Relationship-aware thread scoring
- Thread-aware grouping and inline context
- Viewer-specific moderation-aware context hydration
- Multiple first-class feed types
- Memory-native custom feeds and AT custom feed interop

## Product Goals

Memory should optimize for:

1. Quality conversation
2. Quality content discovery
3. Transparent ranking instead of opaque suppression
4. Strong user curation and moderation controls
5. Feed behavior that feels familiar to Mastodon and Bluesky users

Memory should not rely on shadow banning or heavy-handed hidden ranking rules. Instead, it should uplift high-quality conversations by using social context, thread relevance, recency, participation quality, and explicit user interest signals.

## Feed Product Model

Memory should support four feed families.

### 1. Following

This is the canonical default feed.

Properties:

- Mostly chronological
- Follow-graph first
- Conversation-aware
- Conservative ranking changes only within a bounded recent window
- Familiar to Mastodon and Bluesky users as the default home experience

Content sources:

- Posts from followed accounts
- Replies involving followed accounts, ranked using relationship-aware scoring
- Thread cards for active followed conversations
- Reposts or equivalent re-shares only if product policy allows them later

### 2. For You

This is the interest-focused ranked feed.

Properties:

- Mixes social graph and content graph
- Includes followed hashtags and topic affinity
- Uses a broader candidate pool than Following
- May surface adjacent conversations and content outside the direct follow graph

Content sources:

- Follow graph candidates
- Hashtag-follow candidates
- Interest/topic candidates
- Relevant AT feed/custom feed candidates
- High-quality thread candidates with strong context relevance

### 3. Memory Custom Feeds

Memory should support internal custom feed definitions that operate over the same feed-candidate pipeline.

Examples:

- Topic-specific feeds
- Local-community feeds
- Quality conversation feeds
- Long-form or article-heavy feeds

### 4. AT Custom Feeds

Memory should support ingesting and rendering external AT feed outputs where feasible.

This does not require Memory to copy Bluesky's implementation exactly. It does require Memory to normalize AT custom feed candidates into the same internal feed item model used by Following, For You, and Memory-native custom feeds.

## Current System Constraints

The current feed design stores only enough reply metadata to identify:

- `replyParentUri`
- `replyRootUri`

This is insufficient for the selected product direction because Memory currently does not model:

- Who is being replied to
- Who authored the root of the thread
- Which participants are followed or mutual follows
- Thread-level participant aggregates
- Viewer-filtered visible reply counts
- Moderation-aware thread hydration

The current bump algorithm in `threadBumps.ts` is also destructive:

- It replaces a followed-author reply with its root or parent anchor
- It deduplicates by resulting anchor key
- It can collapse multiple sibling replies into one item without preserving why the root was surfaced

This behavior should be replaced by thread-aware grouping rather than further extended.

## Core Design Decision

Memory should promote reply relationships from incidental metadata to first-class feed primitives.

The unit of ranking is no longer always a single post. In many cases, the unit of ranking should be a thread summary candidate backed by one root plus a set of relevant visible replies.

## Conversation Visibility Rule

When a user opens or expands a post, Memory should show all available context that the viewer is allowed to see after applying all relevant curation and moderation rules.

Example:

- Bob has a post with 40 replies
- Alice opens Bob's post
- Alice should see the fullest thread context available to her
- Alice must not see replies hidden by her own blocks, mutes, keyword filters, or other curation rules
- Alice must also not see replies hidden due to author-side audience restrictions, author moderation rules, or any thread-level visibility constraint

This means thread context is always viewer-specific.

Memory must distinguish between:

1. Total thread size
2. Viewer-visible thread size
3. Followed-participant visible replies
4. Mutual-follow visible replies

The interface should never falsely imply that a user can see all replies when the visible set is filtered.

This does not mean all available visible context should be loaded immediately.

Memory should separate:

1. what the viewer is allowed to see
2. what is initially hydrated into the feed card
3. what is fetched on expansion or deeper thread navigation

For large threads, the feed should load only a minimal visible summary plus a small preview set. Additional visible replies should load progressively on expansion or in the dedicated thread view.

## Data Model Changes

## Reply Relationship Metadata

Each reply item should resolve or persist the following fields.

### Per-item relationship fields

- `replyAuthorId`
- `parentUri`
- `parentAuthorId`
- `rootUri`
- `rootAuthorId`
- `directReplyToFollowed`
- `directReplyToMutual`
- `rootAuthorFollowed`
- `rootAuthorMutual`

These fields may be materialized in a new view or denormalized table rather than stored only on the canonical post row.

### Thread aggregate fields

- `threadReplyCount`
- `threadVisibleReplyCount` (viewer-specific at hydration time)
- `threadFollowedReplyCount`
- `threadMutualReplyCount`
- `threadParticipantCount`
- `threadFollowParticipantCount`
- `threadMutualParticipantCount`
- `threadLastActivityAt`
- `threadLastFollowedActivityAt`

### Participant summary fields

For thread summary rendering, Memory should support a small participant projection:

- participant actor id
- participant display name
- participant avatar
- relationship class: followed, mutual, other
- visible reply count in thread
- most recent visible reply timestamp

## Recommended Persistence Shape

Instead of forcing all of this into `at_posts` or `posts`, Memory should add dedicated derived structures.

Recommended additions:

1. `thread_edges`
2. `thread_participants`
3. `thread_stats`
4. `unified_feed_candidates_view`

### `thread_edges`

Represents reply relationships.

Suggested shape:

- `item_source`
- `item_id`
- `item_uri`
- `reply_author_id`
- `parent_uri`
- `parent_author_id`
- `root_uri`
- `root_author_id`
- `created_at`

### `thread_participants`

Represents who is participating in a thread, independent of a single viewer.

Suggested shape:

- `root_uri`
- `participant_actor_id`
- `reply_count`
- `first_reply_at`
- `last_reply_at`

### `thread_stats`

Represents thread-level aggregates.

Suggested shape:

- `root_uri`
- `reply_count`
- `participant_count`
- `last_activity_at`

### `unified_feed_candidates_view`

Represents feed-ready candidates with enough metadata for scoring and grouping.

This should supersede the current model where `unified_feed_view` plus helper functions must infer too much at request time.

## Viewer-Specific Moderation Projection

Not all context should be precomputed globally because visibility is viewer-specific.

At hydration time, Memory should apply:

1. Blocks
2. Mutes
3. Keyword filters
4. Hidden/restricted authors
5. Per-thread author controls
6. Audience restrictions
7. Additional curation preferences

Recommended request-time projections:

- `visibleReplyCount`
- `visibleFollowedReplyCount`
- `visibleMutualReplyCount`
- `visibleParticipants[]`
- `hiddenReplyCount`

`hiddenReplyCount` should not leak suppressed identities. It only communicates that not all total replies are visible if product chooses to expose that distinction.

## Ranking Model

## Dimension A: A5 Relationship-Aware Scoring

Replies should not be hard filtered by default in Following. They should be scored.

Recommended signals:

### Social graph signals

- author followed
- direct reply target followed
- root author followed
- author mutual
- direct reply target mutual
- root author mutual
- multiple followed participants in thread
- multiple mutual participants in thread

### Content and quality signals

- recency
- thread recency
- thread activity velocity
- visible reply count
- followed reply count
- mutual reply count
- modest engagement signals such as likes/replies/re-shares when available

### Interest signals

- followed hashtag match
- strong topic affinity
- custom feed inclusion
- AT custom feed inclusion

### Negative or dampening signals

- muted author
- keyword-filtered content
- low-quality or repetitive thread behavior
- stale replies into very old threads unless recent thread activity is strong

## Following Ranking Policy

Following should remain near-chronological.

Recommended rule:

- sort primarily by time
- apply score-based reordering only within a bounded recency window
- do not produce globally opaque reorder behavior across large time spans

This preserves expected behavior while still uplifting relevant conversations.

## For You Ranking Policy

For You should permit broader ranking.

Recommended rule:

- allow stronger use of social, topic, hashtag, and engagement signals
- permit adjacent-graph conversations
- permit AT and Memory custom-feed candidates
- still avoid opaque suppression where possible

## Thread Rendering Model

## Dimension B: B3 and B4 Hybrid

Memory should use a hybrid of:

- grouped thread summary cards
- inline visible replies for the most relevant participants

### Thread summary card rules

A thread summary card should be generated when:

- multiple relevant replies share the same root inside the candidate window, or
- thread-level social/context score exceeds a threshold, or
- a single reply is strong enough that the conversation is more useful than the isolated reply

### Thread summary card contents

- root post
- minimal summary line describing visible relevant participation
- subtle participant strip
- optional lightweight affordance that more replies are available
- zero or small number of inline visible reply previews

Recommended initial preview budget:

- 0 to 3 inline visible replies in-feed
- first expansion loads the next page of visible replies
- dedicated thread view handles deeper pagination for large threads

### Important UI constraint

Replies should not all be collapsed aggressively.

The UI should decide among three states:

1. standalone reply card
2. thread card with one inline reply preview
3. thread card with multiple inline previews and expansion affordance

Recommended decision logic:

- If one reply is strongly relevant and readable on its own, keep it visible inline.
- If multiple replies create noise as separate cards, group them.
- If grouping would hide the main conversational value, do not collapse the critical reply.

This keeps the interface careful, tasteful, and minimal.

For very large threads, Memory should not attempt to render the entire visible thread body in-feed. The feed is a summary surface, not the full conversation surface.

## Badge and Affordance Policy

Reply count indicators should be understated.

Avoid loud numeric badges. Prefer flush integrated metadata such as:

- `3 visible replies`
- `2 people you follow replied`
- `more in thread`

When expanded, the UI can then reveal fuller counts and structure.

The collapsed state should indicate that additional visible context exists without turning every card into a dashboard.

## Dimension C: C4 with Phanpy-Inspired Signals

Memory should expose thread count and participant signals in a minimal way.

### Required visible signals

- visible reply count
- visible followed reply count when meaningful
- thread last activity time

### Mutual follow emphasis

Mutual follows in inline replies should slightly stand out.

Recommended treatment:

- slightly heavier username weight
- thin green avatar ring
- no loud badge in collapsed state

This should be subtle enough to read as "this person matters in your graph" and not as a gamified status marker.

### Temporal gap hints

Inspired by Phanpy, Memory should show temporal gap hints inside threads where meaningful.

Examples:

- `6 months later`
- `2 years later`

Only show these in expanded thread context or rich thread cards, not on every standalone post.

## Feed Candidate Pipeline

Memory should move toward a candidate pipeline closer to Bluesky's skeleton-plus-hydration model.

Recommended phases:

1. Candidate acquisition
2. Relationship enrichment
3. Moderation and curation filtering
4. Scoring
5. Grouping into post or thread-summary candidates
6. Hydration for response payload

## Candidate Types

Memory should support at least two first-class candidate types.

### `post`

Single standalone post or reply.

### `thread_summary`

Root post plus grouped conversation context.

Suggested response shape:

```json
{
  "type": "thread_summary",
  "root": {},
  "visibleReplyCount": 8,
  "visibleFollowedReplyCount": 3,
  "visibleMutualReplyCount": 1,
  "participants": [],
  "replyPreviews": [],
  "lastActivityAt": "2026-04-20T10:00:00.000Z"
}
```

## API Direction

The current `GET /at/feed` endpoint should remain available, but the next iteration should introduce feed identity explicitly.

Recommended model:

- `GET /feed?type=following`
- `GET /feed?type=for-you`
- `GET /feed?type=custom&feedId=...`
- `GET /feed?type=at-custom&feedId=...`

The existing `mode=chronological|balanced` model should eventually be replaced or treated as an implementation detail.

Recommended response additions:

- candidate type
- ranking reason summary
- thread context metadata
- viewer-visible counts
- relationship metadata for preview participants

## Moderation and Curation Rules

The thread hydration layer must be viewer-aware.

When building visible thread context for a viewer, Memory must apply:

1. viewer blocks
2. viewer blocked-by state if known and relevant to visibility
3. viewer mutes
4. viewer keyword filters
5. viewer conversation mutes
6. author-side visibility restrictions
7. thread-specific moderation decisions
8. feed-specific curation policies

This means counts shown in feed cards should default to visible counts, not raw global counts.

Where product wants to hint that more exists, that hint must not reveal suppressed identities or filtered content.

## Implementation Plan

## Phase 1: Data foundation

Add reply-target and thread aggregate structures.

Changes:

- add thread edge model
- add thread participant aggregates
- add thread stats aggregates
- backfill parent/root author resolution for existing AT and ActivityPods replies

Outcome:

- Memory can answer who replied to whom and who is in the thread

## Phase 2: Feed candidate enrichment

Introduce a new candidate-building layer over the current unified feed view.

Changes:

- resolve followed and mutual relationships for reply author, parent author, and root author
- compute thread social context signals
- emit richer candidate metadata

Outcome:

- A5 ranking becomes possible without hard filtering

## Phase 3: Thread-summary feed items

Replace destructive reply bumping with grouping.

Changes:

- deprecate `applyFollowedReplyThreadBumps()` as the primary strategy
- group eligible replies into thread summary candidates
- preserve strong standalone replies when grouping would hide too much signal

Outcome:

- B3/B4 hybrid becomes available

## Phase 4: Viewer-specific context hydration

Apply moderation and curation decisions during thread expansion and summary hydration.

Changes:

- compute visible counts and visible participants per viewer
- filter hidden replies from previews and expansions

Outcome:

- users get the fullest context they are actually allowed to see

## Phase 5: Feed types

Introduce Following and For You as first-class feed identities.

Changes:

- Following becomes default and canonical
- For You combines hashtags, content graph, and social graph
- custom feed plumbing reused for Memory and AT feeds

Outcome:

- feed product model aligns with Bluesky and Mastodon expectations while preserving Memory's differentiated quality goals

## Concrete Changes to Current Code

### `memory/api/src/db/atBridgeSchema.ts`

Planned changes:

- extend or supplement current unified feed structures with thread participant and thread stats projections
- introduce feed-candidate-oriented derived views or tables

### `memory/api/src/routes/atBridge.ts`

Planned changes:

- split candidate acquisition from final response shaping
- replace reply bump-only logic with relationship enrichment and grouping
- add feed identity semantics beyond source and timeline mode

### `memory/api/src/utils/threadBumps.ts`

Planned changes:

- retain only as a transitional helper, or replace entirely with thread grouping logic

## Non-Goals

This spec does not recommend:

- hidden shadow-ban style suppression as a primary ranking tool
- loud badge-heavy UI
- globally ranking Following as a heavily algorithmic feed
- leaking blocked or filtered identities through counts or previews

## Summary

Memory should evolve from a post-list feed with reply bump heuristics into a thread-aware feed system with:

- Following as the canonical default feed
- For You as the interest-and-graph blended feed
- relationship-aware reply scoring
- grouped but careful thread summaries
- viewer-visible context hydration
- subtle mutual-follow emphasis
- support for Memory-native and AT custom feeds

This direction fits Memory's product goal: uplift quality conversation and quality discovery without relying on heavy suppression or overly aggressive moderation.