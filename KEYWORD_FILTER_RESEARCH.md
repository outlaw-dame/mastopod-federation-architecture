# Keyword Filter Implementation Research: Mastodon vs Bluesky vs ActivityPods

## Executive Summary

**Mastodon** and **Bluesky** both have sophisticated keyword filtering systems that are significantly more feature-rich than ActivityPods' current implementation. Key improvements to emulate:

1. **Temporal controls** (expiration, time-limited rules)
2. **Contextual application** (home, notifications, public, threads, profiles)
3. **Filter organization** (named groups, categorization)
4. **Multiple matching strategies** (substring, whole-word, case-sensitivity)
5. **Persistent state tracking** (match history, hit counters)
6. **Labeler-based remote filtering** (subscribe to moderation lists)

---

## 1. MASTODON: CustomFilter Model

### Current Implementation
**File**: `app/models/custom_filter.rb`

### Features

#### Action Types (3 levels)
```
- warn  : Show with warning overlay (most lenient)
- hide  : Collapse content in feed (moderate)
- blur  : Blur media (legacy → now same as hide in UI)
```

#### Context Scoping (5 domains)
```
VALID_CONTEXTS = %w(
  home              # Main timeline
  notifications     # Notification feed
  public            # Public/federated timelines
  thread            # Within conversation threads
  account           # On user profiles
).freeze
```

**Why this matters**: Users typically want different rules in different contexts. E.g., mute "politics" from home but allow in threads.

#### Expiration System
```ruby
EXPIRATION_DURATIONS = [
  30.minutes,
  1.hour,
  6.hours,
  12.hours,
  1.week
].freeze

# Tracks: expires_at (timestamp) + expires_in (calculated duration)
```

**Why this matters**: Allows temporary mutes during trending topics or seasonal events.

#### Keyword Matching
- **Multiple keywords per filter**: Uses `CustomFilterKeyword` join table
- **Pattern matching**: Convert to regex, union all keywords for efficient matching
- **Searchable text**: Matches against `status.proper.searchable_text` (content + hashtags)

#### Caching Strategy
```ruby
def self.cached_filters_for(account_id)
  # Compiled regex union stored in Redis
  # Keywords: Regexp.union(keywords)
  # Also caches specific status IDs (hard filters)
end

def self.apply_cached_filters(cached_filters, status)
  # Efficient matching: regex match + OR lookup by status ID
  # Returns FilterResultPresenter with match details
end
```

**Why this matters**: Prevents database queries on every status render.

#### Rich Result Data
```ruby
FilterResultPresenter(
  filter: filter,
  keyword_matches: [matched_phrases],
  status_matches: [matched_status_ids]
)
```

### Gaps
- No word-boundary matching (whole-word option was removed)
- No category/grouping beyond context
- No visibility into why a filter matched (the presenter helps)

---

## 2. BLUESKY: Moderation Lists + Labelers

### Current Implementation
**Source**: `/src/screens/Moderation/index.tsx` + ATProto labeler protocol

### Features

#### Mute Lists (Decentralized)
- **User-created lists** of accounts to mute
- **Subscription to public lists** (e.g., block lists, spam lists)
- **List composition**: Can mute multiple accounts at once
- **Account-level only** (no keywords at mute list layer)

#### App Labels (Labeler-based)
- **Decentralized labeling**: Any service can emit labels
- **Label scopes**: `warn`, `hide`, `blur`, `ignore` (action taken on label)
- **Builtin labels**: `!hide`, `!warn`, `!no-unauthenticated`, `porn`, `sexual`, `spam`, `bot`, etc.
- **Label subscription**: Users subscribe to labelers' feeds
- **No keyword filters at client level** ← **KEY DIFFERENCE**

### Why Bluesky Chose This Model
Instead of client-side keyword filtering like Mastodon, Bluesky offloaded to **labelers** (decentralized services):
- No client state explosion
- Moderation is composable (subscribe to multiple labelers)
- Labelers can use AI/heuristics
- Privacy: labelers don't store user's local filters

### Gaps for Individual Users
- No personal keyword muting
- No temporary/expiring rules
- All muting is account-based, not phrase-based

---

## 3. ACTIVITYPODS: Current State

### Current Implementation
**File**: `src/pages/SettingsPage/ModerationPage.tsx`

### Features

#### Actions (3 basic options)
```
- hide   : Hide content
- warn   : Show warning
- filter : ???  (unclear implementation)
```

#### Storage
```typescript
type KeywordFilter = {
  pattern: string;     // Plain text, no regex support
  action: FilterAction; // 'hide' | 'warn' | 'filter'
};

type MutedAccount = {
  subjectCanonicalId: string;
  subjectProtocol: string; // 'ap' currently
};

type BlockedAccount = {
  subjectCanonicalId: string;
  subjectProtocol: string;
};
```

#### Matching
- Stored in LDP container
- No efficient regex compilation
- No caching layer
- No context-aware filtering

### Gaps
1. ❌ No expiration/time-limited rules
2. ❌ No context scoping (home vs notifications vs public)
3. ❌ No word-boundary or regex matching
4. ❌ No filter organization/grouping
5. ❌ No match history or performance tracking
6. ❌ Protocol-agnostic (says "ap" but should support "at" for ATProto)
7. ❌ No Redis caching for performance
8. ❌ UI doesn't explain what "filter" action does
9. ❌ No support for subscribing to remote moderation lists
10. ❌ Single flat list (no categorization)

---

## Recommended Improvements for ActivityPods

### Phase 1: Core Feature Parity (with Mastodon)

#### 1.1 Expand Action Types
```typescript
type FilterAction = 'warn' | 'hide' | 'blur' | 'ignore';
// ignore = no UI notification, effect only
```

#### 1.2 Add Context Scoping
```typescript
type FilterContext = 'home' | 'notifications' | 'public' | 'thread' | 'profile';

type KeywordFilter = {
  id: string;
  pattern: string;
  action: FilterAction;
  contexts: FilterContext[]; // Multiple contexts
  wholWord?: boolean;        // Word boundary matching
  caseSensitive?: boolean;
  expiresAt?: ISO8601Date;   // Optional expiration
  createdAt: ISO8601Date;
  updatedAt: ISO8601Date;
};
```

#### 1.3 Implement Efficient Caching
```typescript
// Use Redis for compiled filters per account
// Expire cache on any filter change
// Store: { accountId → { contexts → { regex, actions } } }
```

#### 1.4 Backend Filtering
```typescript
// In ModerationPage.tsx or hook:
1. Fetch user's filters
2. Build regex union per context
3. Test incoming posts against context-specific regex
4. Apply action (hide, warn, blur)
5. Return matched phrases in UI
```

### Phase 2: Advanced Features (Bluesky + Mastodon Hybrid)

#### 2.1 Named Filter Groups
```typescript
type FilterGroup = {
  id: string;
  name: string;           // "Politics", "Sports Drama", etc.
  description?: string;
  rules: KeywordFilter[]; // Batch of rules
  enabled: boolean;
  locked?: boolean;       // Can't delete (e.g., admin-created)
};
```

#### 2.2 Filter List Subscription (Bluesky-style)
```typescript
type RemoteFilterList = {
  id: string;
  uri: string;                    // LDP container or AT Protocol DID
  name: string;
  maintainer: string;
  subscriptionStatus: 'active' | 'unsubscribed' | 'error';
  rules: KeywordFilter[];         // Fetched remotely
  lastFetch: ISO8601Date;
  autoUpdate?: boolean;           // Periodic refresh
};
```

#### 2.3 Match History & Analytics
```typescript
type FilterMatch = {
  filterId: string;
  postUri: string;
  matchedPhrase: string;
  matchedAt: ISO8601Date;
  context: FilterContext;
  action: FilterAction;
};

// UI: Show "This filter matched 3 posts this week"
```

#### 2.4 Protocol Awareness
```typescript
type KeywordFilter = {
  ...
  appliesTo: ('ap' | 'at')[]; // Which protocols trigger this
  // Allows: "hide this keyword on ActivityPub but warn on ATProto"
  // Or: protocol-specific keywords
};
```

### Phase 3: Bridging (Cross-Protocol Moderation)

#### 3.1 Sync Filters to MRF (ActivityPub)
```
User creates filter: { pattern: 'crypto', action: 'hide' }
→ Automatically creates MRF rule via dedicated MRF module
→ All pods in federation see consistent filtering
```

#### 3.2 Sync Filters to AT Labeler
```
User creates filter: { pattern: 'spam', action: 'hide' }
→ Emit AT label with `!hide` val
→ Cross-pod visibility for labelers
→ Bluesky-compatible moderation
```

---

## Proposed Data Model (RDF/LDP)

```turtle
# ActivityPods Pod Storage (LDP Container)

ex:alice/settings/filters/
  a ldp:Container ;
  ldp:contains 
    ex:alice/settings/filters/politics-2024 ,
    ex:alice/settings/filters/spam ,
    ex:alice/settings/filters/drama ;
  .

ex:alice/settings/filters/politics-2024
  a ap:Filter ;  # Activity Streams extension
  ap:pattern "politics|election|vote" ;
  ap:action "warn" ;
  ap:contexts "home", "public" ;
  ap:expiresAt "2024-12-25T00:00:00Z" ;
  ap:wholeWord false ;
  ap:caseSensitive false ;
  dct:created "2024-04-01T12:00:00Z" ;
  dct:modified "2024-04-06T00:00:00Z" ;
  .

ex:alice/settings/mutelists/
  a ldp:Container ;
  ldp:contains
    ex:alice/settings/mutelists/spam-farmers ;
  .

ex:alice/settings/mutelists/spam-farmers
  a as:OrderedCollection ;
  as:name "Spam Farmers List" ;
  as:orderedItems (
    https://bad-instance.com/users/spammer1
    https://bad-instance.com/users/spammer2
  ) ;
  .
```

---

## Implementation Priority

1. **Short-term (1-2 weeks)**
   - Add expiration support
   - Add context scoping (5 contexts like Mastodon)
   - Improve UI to explain each action
   - Add Redis caching for filters

2. **Medium-term (3-4 weeks)**
   - Add whole-word & case-sensitivity options
   - Named filter groups
   - Filter match history
   - Protocol awareness (ap vs at)

3. **Long-term (research track)**
   - Remote filter list subscription
   - MRF integration (auto-create rules)
   - AT Labeler integration  (auto-emit labels)
   - Admin-created templates/defaults

---

## Reference Implementation Links

- **Mastodon CustomFilter**: https://github.com/mastodon/mastodon/blob/main/app/models/custom_filter.rb
- **Mastodon CustomFilterKeyword**: https://github.com/mastodon/mastodon/blob/main/app/models/custom_filter_keyword.rb
- **Mastodon API Filters Endpoint**: https://docs.joinmastodon.org/methods/filters/
- **Bluesky Moderation Screen**: https://github.com/bluesky-social/social-app/blob/main/src/screens/Moderation/index.tsx
- **ATProto Labeler Spec**: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/label/
- **Your current implementation**: `/activity-pods/pod-provider/frontend/src/pages/SettingsPage/ModerationPage.tsx`

---

## Key Design Philosophy

**Mastodon approach**: Client-side filtering with efficient regex union + Redis caching. Simple, fast, privacy-preserving.

**Bluesky approach**: Server-side labeling (decentralized) + user list subscription. Composable, AI-friendly, but requires external services.

**Recommended for ActivityPods**: Adopt Mastodon's **core model** (context + expiration + caching) + add Bluesky's **list subscription** (for federation-wide block lists). This gives:
- ✅ Fast local filtering (Mastodon-style)
- ✅ Composable remote lists (Bluesky-style)
- ✅ Cross-protocol bridging (native to AP+AT)
- ✅ No vendor lock-in
