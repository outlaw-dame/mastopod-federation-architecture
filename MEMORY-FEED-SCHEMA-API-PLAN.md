# Memory Feed Schema And API Plan

## Purpose

This document translates the thread-aware feed specification into concrete backend work against the current Memory API codebase.

Grounding:

- Current unified feed route: [memory/api/src/routes/atBridge.ts](/Users/damonoutlaw/activitypods-work/mastopod-federation-architecture/memory/api/src/routes/atBridge.ts)
- Current AT schema and unified view: [memory/api/src/db/atBridgeSchema.ts](/Users/damonoutlaw/activitypods-work/mastopod-federation-architecture/memory/api/src/db/atBridgeSchema.ts)
- Current local post schema: [memory/api/src/db/schema.ts](/Users/damonoutlaw/activitypods-work/mastopod-federation-architecture/memory/api/src/db/schema.ts)
- Current reply bump helper: [memory/api/src/utils/threadBumps.ts](/Users/damonoutlaw/activitypods-work/mastopod-federation-architecture/memory/api/src/utils/threadBumps.ts)
- Current migrations: [memory/api/drizzle](/Users/damonoutlaw/activitypods-work/mastopod-federation-architecture/memory/api/drizzle)

## Current State

The feed currently relies on:

1. `posts.replyParentUri` and `posts.replyRootUri`
2. `at_posts.replyParentUri` and `at_posts.replyRootUri`
3. `unified_feed_view`
4. request-time helper logic that infers follow-aware reply bumps from author identity only

This is not enough for:

- scoring based on who is being replied to
- thread participant summaries
- visible reply counts
- mutual-follow highlighting
- `Following` and `For You` as distinct feed identities
- thread-summary candidates

## Implementation Strategy

Implement in three backend layers.

### Layer 1: Thread graph persistence

Persist reply relationship edges and thread-level aggregates.

### Layer 2: Candidate enrichment

Build a feed-oriented projection that joins content, relationships, and thread stats.

### Layer 3: Response shaping

Emit `post` and `thread_summary` response items with viewer-specific visible counts and lazy-loading affordances.

## Proposed Database Additions

## Migration 0004: Thread graph foundation

Recommended migration name:

- `0004_thread_graph_foundation.sql`

Add tables:

### `thread_edges`

Purpose:

- normalize reply relationships for both ActivityPods and ATProto items

Suggested columns:

- `id` serial primary key
- `item_source` text not null
- `item_local_post_id` integer null
- `item_at_post_id` integer null
- `item_uri` text not null unique
- `reply_author_id` text not null
- `parent_uri` text null
- `parent_author_id` text null
- `root_uri` text null
- `root_author_id` text null
- `created_at` timestamptz null
- `updated_at` timestamptz default now not null

Notes:

- `reply_author_id`, `parent_author_id`, and `root_author_id` should store canonical actor identifiers. In practice this is `users.web_id` for local ActivityPods content and DID for AT content, unless a canonical actor abstraction is introduced later.
- `item_uri` should be populated from `posts.object_uri` or `at_posts.at_uri`.

Indexes:

- unique index on `item_uri`
- index on `root_uri`
- index on `parent_uri`
- index on `reply_author_id`
- index on `(root_uri, created_at desc)`

### `thread_participants`

Purpose:

- aggregate participants per thread for fast participant summaries

Suggested columns:

- `root_uri` text not null
- `participant_actor_id` text not null
- `reply_count` integer not null default 0
- `first_reply_at` timestamptz null
- `last_reply_at` timestamptz null
- primary key `(root_uri, participant_actor_id)`

Indexes:

- index on `(root_uri, last_reply_at desc)`

### `thread_stats`

Purpose:

- aggregate thread-level counts and recency

Suggested columns:

- `root_uri` text primary key
- `reply_count` integer not null default 0
- `participant_count` integer not null default 0
- `last_activity_at` timestamptz null
- `updated_at` timestamptz default now not null

Indexes:

- index on `last_activity_at desc`

## Migration 0005: Feed candidate projection

Recommended migration name:

- `0005_feed_candidates.sql`

Add a derived view:

### `unified_feed_candidates_view`

Purpose:

- unify content rows with thread graph enrichment
- allow the route layer to score and group candidates without repeatedly re-resolving root/parent authors

Suggested columns:

- existing content fields from `unified_feed_view`
- `candidate_uri`
- `thread_root_uri`
- `thread_parent_uri`
- `thread_reply_author_id`
- `thread_parent_author_id`
- `thread_root_author_id`
- `thread_reply_count`
- `thread_participant_count`
- `thread_last_activity_at`
- `is_reply`
- `is_thread_root`

Implementation note:

- This can be built by left joining `unified_feed_view` to `thread_edges` and `thread_stats`.

## Backfill Jobs

Two backfill passes are needed.

### Pass 1: local ActivityPods posts

Input source:

- `posts`

Rules:

- `reply_author_id` from joined `users.web_id`
- `parent_uri` from `posts.reply_parent_uri`
- `root_uri` from `posts.reply_root_uri`
- `parent_author_id` resolved by lookup on `posts.object_uri`
- `root_author_id` resolved by lookup on `posts.object_uri`

### Pass 2: AT posts

Input source:

- `at_posts`
- `at_records` where needed for richer author/context resolution

Rules:

- `reply_author_id` from `at_posts.author_did`
- `parent_uri` from `at_posts.reply_parent_uri`
- `root_uri` from `at_posts.reply_root_uri`
- `parent_author_id` resolved from matching `at_posts.at_uri` first, then `at_records.at_uri` if needed
- `root_author_id` resolved the same way

## Route Changes

## 1. Introduce feed identity explicitly

Current endpoint:

- `GET /at/feed`

Recommended near-term extension:

- keep `GET /at/feed` for compatibility
- add `feedType` query param

Suggested values:

- `following`
- `for-you`
- `custom`
- `at-custom`

Compatibility mapping:

- current `mode=chronological` maps roughly to `following`
- current `mode=balanced` maps roughly to `for-you`

## 2. Replace bump-centric shaping with candidate shaping

Current helper path:

- `resolveFollowedAuthorIds()`
- `loadReplyThreadMeta()`
- `loadThreadAnchorRows()`
- `applyReplyThreadBumps()`

New path:

1. load candidate rows from `unified_feed_candidates_view`
2. resolve viewer relationship set
3. compute lightweight social score for each candidate
4. group eligible candidates by thread root
5. emit either `post` or `thread_summary`

## 3. Add thread summary response type

Current response type is effectively a flat `UnifiedFeedRow`.

Add response discriminant:

- `type: 'post' | 'thread_summary'`

### `post`

Should include:

- current item fields
- `threadContext` object when relevant

### `thread_summary`

Should include:

- root content item
- visible summary counts
- participant preview metadata
- reply preview list
- pagination cursor for more replies

## 4. Add thread context endpoint

Recommended new endpoint:

- `GET /at/thread`

Suggested query params:

- `uri`
- `limit`
- `cursor`

Purpose:

- load visible thread replies progressively for feed expansion and thread view

This endpoint should return viewer-filtered results only.

## 5. Add reply preview endpoint only if needed

If feed payload size becomes too large, split feed summary from preview hydration.

Optional endpoint:

- `GET /at/thread/preview`

This is not required for phase 1 if the feed returns at most 0 to 3 previews.

## Following Feed Rules

Route-level behavior:

- default feed type
- near chronological ordering
- A5-style social scoring only within recent candidate windows
- modest engagement influence
- conservative grouping

Candidate priority examples:

1. followed author posts
2. replies where followed or mutual participants exist on both sides of the interaction
3. active thread summaries with visible followed participants

## For You Feed Rules

Route-level behavior:

- includes followed hashtags
- includes social graph and content graph candidates
- broader ranking freedom
- may include Memory custom feed and AT custom feed candidates

## Viewer-Specific Counts

These should not be stored as global DB columns because they vary per viewer.

Compute at response time:

- `visibleReplyCount`
- `visibleFollowedReplyCount`
- `visibleMutualReplyCount`
- `hiddenReplyCount` only if product chooses to expose it

Filtering inputs should include:

- block lists
- mute lists
- keyword filters
- conversation mutes
- visibility restrictions

## Recommended Phase Breakdown

### Phase 1

- add `thread_edges`
- add `thread_participants`
- add `thread_stats`
- backfill author resolution for replies

### Phase 2

- add `unified_feed_candidates_view`
- extend route candidate loading to use it
- stop depending on reply bump replacement for correctness

### Phase 3

- add `type` discriminant to feed response
- implement `thread_summary`
- add `GET /at/thread`

### Phase 4

- add `feedType`
- define `following` and `for-you`
- add custom feed plumbing

## Files Likely To Change

- [memory/api/src/db/atBridgeSchema.ts](/Users/damonoutlaw/activitypods-work/mastopod-federation-architecture/memory/api/src/db/atBridgeSchema.ts)
- [memory/api/src/db/schema.ts](/Users/damonoutlaw/activitypods-work/mastopod-federation-architecture/memory/api/src/routes/atBridge.ts)
- [memory/api/src/routes/atBridge.ts](/Users/damonoutlaw/activitypods-work/mastopod-federation-architecture/memory/api/src/routes/atBridge.ts)
- [memory/api/src/utils/threadBumps.ts](/Users/damonoutlaw/activitypods-work/mastopod-federation-architecture/memory/api/src/utils/threadBumps.ts)
- [memory/api/drizzle/0004_thread_graph_foundation.sql](/Users/damonoutlaw/activitypods-work/mastopod-federation-architecture/memory/api/drizzle/0004_thread_graph_foundation.sql)
- [memory/api/drizzle/0005_feed_candidates.sql](/Users/damonoutlaw/activitypods-work/mastopod-federation-architecture/memory/api/drizzle/0005_feed_candidates.sql)

## Immediate Recommendation

Start with Phase 1 plus a thin Phase 2 slice. That unlocks the crucial capability the current system lacks: tracking not just who is replying, but who is being replied to and who anchors the thread.