# Memory Feed Frontend Contract

## Purpose

This document defines the frontend-facing feed and thread contract for the next Memory feed architecture.

Grounding:

- current home tabs: [memory/frontend/src/views/HomeView.vue](/Users/damonoutlaw/activitypods-work/mastopod-federation-architecture/memory/frontend/src/views/HomeView.vue)
- current feed list: [memory/frontend/src/components/UnifiedFeedList.vue](/Users/damonoutlaw/activitypods-work/mastopod-federation-architecture/memory/frontend/src/components/UnifiedFeedList.vue)
- current feed store: [memory/frontend/src/stores/atBridgeStore.ts](/Users/damonoutlaw/activitypods-work/mastopod-federation-architecture/memory/frontend/src/stores/atBridgeStore.ts)
- current thread view: [memory/frontend/src/views/ThreadView.vue](/Users/damonoutlaw/activitypods-work/mastopod-federation-architecture/memory/frontend/src/views/ThreadView.vue)

## Feed Tabs

The current UI labels are `for-you` and `home`.

Recommended product mapping:

- `home` becomes `following`
- `for-you` remains `for-you`

The UI may keep the current route and state names temporarily, but the API contract should use:

- `following`
- `for-you`
- `custom`
- `at-custom`

## Feed Item Types

The feed should support two top-level item types.

### 1. `post`

Flat content item.

Example shape:

```ts
type FeedItem = PostFeedItem | ThreadSummaryFeedItem

interface PostFeedItem {
  type: 'post'
  id: number
  source: 'activitypods' | 'atproto'
  uri: string
  content: string
  createdAt: string | null
  author: FeedAuthor
  objectUri?: string | null
  atUri?: string | null
  threadContext?: ThreadContextSummary | null
}
```

### 2. `thread_summary`

Root post plus lightweight visible conversation context.

```ts
interface ThreadSummaryFeedItem {
  type: 'thread_summary'
  root: PostFeedItem
  thread: ThreadSummary
}
```

## Shared Types

```ts
interface FeedAuthor {
  id: string
  name: string
  handle?: string | null
  webId?: string | null
  did?: string | null
  avatarUrl?: string | null
  relationship?: {
    followed: boolean
    mutual: boolean
  }
}

interface ThreadContextSummary {
  isReply: boolean
  rootUri?: string | null
  parentUri?: string | null
  visibleReplyCount?: number
  visibleFollowedReplyCount?: number
  visibleMutualReplyCount?: number
  lastActivityAt?: string | null
  hasMoreVisibleReplies?: boolean
}

interface ThreadParticipantPreview {
  actorId: string
  name: string
  handle?: string | null
  avatarUrl?: string | null
  relationship: 'mutual' | 'followed' | 'other'
  visibleReplyCount: number
  lastReplyAt?: string | null
}

interface ReplyPreviewItem {
  uri: string
  content: string
  createdAt: string | null
  author: FeedAuthor
  relationshipToViewer?: 'mutual' | 'followed' | 'other'
}

interface ThreadSummary {
  rootUri: string
  visibleReplyCount: number
  visibleFollowedReplyCount: number
  visibleMutualReplyCount: number
  hasMoreVisibleReplies: boolean
  lastActivityAt?: string | null
  participants: ThreadParticipantPreview[]
  replyPreviews: ReplyPreviewItem[]
  nextCursor?: string | null
}
```

## Lazy Loading Rules

The frontend must not assume all visible replies are present in the feed payload.

### Feed card behavior

Initial payload should include:

- root item
- summary counts
- 0 to 3 reply previews
- participant preview strip
- `hasMoreVisibleReplies`
- `nextCursor` if more visible replies exist

This keeps the feed performant and avoids over-rendering large threads.

### Feed expansion behavior

When a user expands a thread card in-feed:

1. render existing preview replies immediately
2. request the next page of visible replies
3. append replies incrementally
4. stop when `nextCursor` is null or user navigates into thread view

### Thread view behavior

The dedicated thread view should support deep pagination for large threads. It is the correct place to inspect a conversation with dozens or hundreds of replies.

The thread view should not require the feed to preload everything.

## Visual Signals

## Mutual follow emphasis

Mutual follow participants should receive only subtle emphasis.

Recommended UI behavior:

- username slightly heavier weight
- thin green ring around avatar
- no loud badge in collapsed feed state

## Minimal thread affordance

Avoid noisy badges.

Recommended collapsed text examples:

- `3 visible replies`
- `2 people you follow replied`
- `more in thread`

Use inline metadata rather than standalone pill counters whenever possible.

## Temporal gap hints

The frontend should support optional time-gap separators in expanded thread views.

Example:

- `6 months later`

These should not appear on every feed card by default.

## Store Changes

Current store file:

- [memory/frontend/src/stores/atBridgeStore.ts](/Users/damonoutlaw/activitypods-work/mastopod-federation-architecture/memory/frontend/src/stores/atBridgeStore.ts)

Recommended changes:

### Replace flat `UnifiedFeedItem` assumption

Current store assumes a single flat item interface.

Replace with:

- `FeedItem = PostFeedItem | ThreadSummaryFeedItem`

### Add feed identity state

Replace or supplement `timelineMode` with:

- `feedType: 'following' | 'for-you' | 'custom' | 'at-custom'`

Keep `feedSource` only if the product still wants protocol filtering as a debug or advanced control.

### Add thread loading actions

Recommended actions:

- `fetchFeed(feedType, append?)`
- `expandThread(rootUri)`
- `fetchThreadPage(rootUri, cursor?)`
- `openThread(rootUri)`

### Add per-thread expansion state

Store should keep UI state such as:

- expanded root URIs
- per-thread loading flags
- per-thread cursors
- per-thread loaded reply pages

## Component Changes

## `UnifiedFeedList.vue`

Should render by item type.

Recommended branching:

- `post` -> existing post renderer
- `thread_summary` -> new thread summary renderer

## New component: `ThreadSummaryCard.vue`

Responsibilities:

- render root post
- render subtle summary line
- render participant strip
- render preview replies
- render expand affordance
- request more visible replies lazily

## `UnifiedFeedItem.vue`

Should remain focused on standalone post rendering. Thread-summary behavior should not be forced into it if that would create excessive conditional complexity.

## `ThreadView.vue`

Should stop relying on mock data and adopt the paginated thread endpoint contract.

It should:

- load root post
- load first visible reply page
- fetch more on scroll or button press
- support time-gap separators

## Backward Compatibility Plan

To avoid a large flag day:

1. keep accepting old flat items during transition
2. add `type: 'post'` to current feed items first
3. introduce `thread_summary` only after components are ready

## Recommended Sequence

### Step 1

Extend store types and route contract with `type: 'post'`.

### Step 2

Add `ThreadSummaryCard.vue` and no-op rendering support in `UnifiedFeedList.vue`.

### Step 3

Add `expandThread()` and paginated `GET /at/thread` usage.

### Step 4

Rename product tabs from implementation terms to feed terms:

- `Home` -> `Following`
- `For You` stays `For You`

## Summary

The frontend contract should treat the feed as a summary surface and the thread view as the full conversation surface. Users should be able to access as much visible context as possible without the system trying to eagerly load massive threads into the feed itself.