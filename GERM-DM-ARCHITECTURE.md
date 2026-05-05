# Germ Network Direct Messages (DM) Architecture for Mastopod

**Status**: Phase 1 Foundation (Complete) | Phase 2-3 Ready for Development  
**Last Updated**: May 1, 2026  
**Owner**: Mastopod Federation Architecture  

---

## Executive Summary

This document defines the architecture for integrating AT Protocol Germ Network direct messaging (DM) capabilities into the Mastopod federation platform. The design enables:

1. **Cross-Protocol Federation**: ActivityPub users ↔ AT Protocol Germ users
2. **Unified Chat API**: Single interface for DMs via `chat.bsky.*` lexicon
3. **P2P Message Routing**: Direct DIM delivery via Germ Network (vs. centralized inbox)
4. **Backward Compatibility**: Existing ActivityPods messaging (contacts.message) remains functional

---

## 1. Current State Analysis

### 1.1 ActivityPods Messaging (contacts.message)

**Location**: `pod-provider/backend/services/contacts/message.js`

**Architecture**:
```
User A sends Create(Note) → ActivityPub Activity → 
  ActivityPods Backend (onReceive) → Mail Notification → 
    Recipient Pod (contacts.message container)
```

**Capabilities**:
- ✅ 1-1 direct messages via Note objects
- ✅ ActivityPub activity federation
- ✅ Per-message access control (WebACL)
- ✅ Email/in-app notifications

**Limitations**:
- ❌ No group messaging
- ❌ No AT Protocol integration
- ❌ No P2P routing (only inbox-based)
- ❌ No conversation metadata (read state, reactions)
- ❌ No Germ Network support

### 1.2 AT Protocol Chat Architecture (chat.bsky.*)

**Introduced**: PR #4415 (bluesky-social/atproto)

**Architecture**:
```
User A sends Message → Germ Network Declaration → P2P Discovery → 
  Germ Node (P2P) or Service Endpoint → User B Inbox → 
    chat.bsky.convo.getMessage() → UI
```

**Capabilities**:
- ✅ 1-1 direct messages
- ✅ Group conversations (invite links, join requests)
- ✅ Message reactions
- ✅ Conversation read state tracking
- ✅ P2P message routing
- ✅ Service discovery via DID documents

---

## 2. Design Goals

| Goal | Rationale | Implementation |
|------|-----------|-----------------|
| **Federation First** | Users on different protocols should seamlessly communicate | Translator layer converts between AP and AT formats |
| **Backwards Compatible** | Existing AP messaging shouldn't break | Parallel route handling, legacy fallback |
| **Decentralized** | Support both service-based and P2P routing | Germ Network declaration + inbox endpoints |
| **Data Sovereignty** | Users control their conversation data | Store in Pod containers + PDS repos |
| **Interoperable** | Multiple AT Protocol services can participate | Standardized `chat.bsky.*` lexicons |

---

## 3. Phase 1: Foundation (COMPLETE)

### 3.1 Lexicon Definitions

Created `fedify-sidecar/lexicons/chat/bsky/convo/`:
- `defs.json` - Conversation and message type definitions
- `sendMessage.json` - Procedure to send a message
- `getMessages.json` - Query to retrieve messages
- `getConvo.json` - Query to get conversation metadata
- `listConvos.json` - Query to list user's conversations

**Key Types**:
```json
{
  "convoView": {
    "id": "string",           // Unique conversation ID
    "rev": "string",          // Revision counter
    "members": [{...}],       // Participant list
    "lastMessage": {...},     // Most recent message
    "opened": "datetime"      // Creation timestamp
  },
  "messageView": {
    "id": "string",
    "rev": "string",
    "text": "string",         // Max 10,000 chars
    "sender": {...},         // Actor reference
    "sentAt": "datetime"
  }
}
```

### 3.2 Translator Implementation

**File**: `fedify-sidecar/src/protocol-bridge/activitypub/translators/DirectMessageTranslator.ts`

**Flow**:
```
ActivityPub Create(Note) → DirectMessageTranslator.supports() → 
  translateDirectMessageActivity() → 
  CanonicalIntent[chat.bsky.convo.sendMessage] → 
  Storage/Federation
```

**Key Functions**:
- `supports()`: Detects ActivityPub direct messages (single recipient, Note type)
- `translate()`: Converts AP activity to Germ chat intent
- Schema validation with Zod

**Limitations** (Phase 1):
- Single recipient only (1-1 DMs)
- No reply threading
- No media attachments

### 3.3 Memory API Chat Routes

**File**: `memory/api/src/routes/chat/chatRoutes.ts`

**Endpoints Implemented**:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/chat/sendMessage` | POST | Send message to conversation |
| `/chat/getMessages` | GET | Fetch message history (paginated) |
| `/chat/getConvo` | GET | Retrieve conversation metadata |
| `/chat/listConvos` | GET | List user's conversations |
| `/chat/getConvoForMembers` | POST | Get/create 1-1 conversation |

**Request Format**:
```bash
curl -X POST http://localhost:8796/chat/sendMessage \
  -H "x-user-did: did:example:user123" \
  -H "Content-Type: application/json" \
  -d '{"convoId": "convo_abc123", "text": "Hello!"}'
```

**Response**:
```json
{
  "message": {
    "id": "msg_1234567890",
    "rev": "0",
    "text": "Hello!",
    "sender": {
      "did": "did:example:user123",
      "handle": "alice.example"
    },
    "sentAt": "2026-05-01T12:34:56Z"
  }
}
```

**Authentication**:
- Required header: `x-user-did` (user's DID/identifier)
- Membership verification before operations
- 403 error if user not in conversation

**State Management** (Phase 1):
- In-memory store (Map<convoId, messages>)
- Placeholder for database migration
- Revision tracking for CRDTs

---

## 4. Phase 2: Germ Network Integration (Planned)

### 4.1 Germ Network Declaration

**Objective**: Advertise DM capability via DID documents

**Implementation**:
```json
{
  "id": "did:example:mastopod-service",
  "service": [{
    "id": "#germ-chat",
    "type": "GermNetworkService",
    "serviceEndpoint": {
      "uri": "germ://mastopod-sidecar/chat",
      "declaration": {
        "capability": "chat.bsky.convo",
        "protocols": ["chat.bsky.*"]
      }
    }
  }]
}
```

**Actor Declaration** (in activity-pods):
```typescript
// Add to fedify-sidecar actor resolution
async function getActorCapabilities(actorUri: string) {
  return {
    canSendMessages: true,
    germNetworkEndpoint: "germ://...",
    chatProtocols: ["chat.bsky.convo.*"]
  }
}
```

### 4.2 P2P Message Routing

**Flow**:
```
1. User A sends message via `/chat/sendMessage`
2. System resolves recipient B's Germ declaration
3. Routes via:
   a) Germ P2P network (if available)
   b) Fallback to service endpoint
   c) Legacy ActivityPub inbox (if needed)
4. Recipient B fetches via `/chat/getMessages`
```

**Implementation Steps**:
- Add `GermNetworkRouter` class to handle routing logic
- Implement backoff/retry for network failures
- Support multiple routing strategies (priority order):
  1. Germ P2P discovery
  2. Service endpoint from DID
  3. ActivityPub inbox (fallback)

### 4.3 ActivityPods Backend Integration

**Extend user-settings-api.service.js** (similar to moderation):
```typescript
// Add new actions
actions: {
  async listDirectConversations(ctx) {
    // Fetch all 1-1 convos for user
    const convos = await ctx.call('ldp.container.getAll', {
      containerUri: userDmContainer
    });
    return convos.map(toConvoView);
  },
  
  async getConversationMessages(ctx) {
    // Paginate messages from container
    // Map to chat.bsky.convo.messageView format
  },
  
  async sendDirectMessage(ctx) {
    // Create message in container
    // Emit Germ network event
    // Notify recipient
  }
}
```

---

## 5. Phase 3: Enhanced Features (Future)

### 5.1 Group Conversations

**Design**:
```json
{
  "groupConvo": {
    "id": "group_xyz",
    "type": "group",
    "name": "Project Alpha",
    "members": [
      { "did": "did:example:alice", "role": "admin" },
      { "did": "did:example:bob", "role": "member" }
    ],
    "joinLink": "join://mastopod/group/xyz",
    "settings": {
      "allowInvites": true,
      "moderationEnabled": true
    }
  }
}
```

### 5.2 Message Reactions

**Lexicon**: `chat.bsky.convo.reaction` (similar to `app.bsky.feed.like`)

**Schema**:
```json
{
  "messageId": "msg_123",
  "emoji": "👍",
  "reactedAt": "2026-05-01T12:35:00Z"
}
```

### 5.3 Read State & Typing Indicators

**Endpoints**:
- `chat.bsky.convo.updateRead` - Mark messages as read
- `chat.bsky.convo.sendTypingIndicator` - Real-time typing presence

---

## 6. Data Model & Storage

### 6.1 ActivityPods Pod Container

**Location**: `/user/dms/` (private container)

**Structure**:
```
/user/dms/
  /conversations/
    /convo_alice_bob/
      /messages/
        /msg_001
        /msg_002
      /metadata.json
  /metadata.json
```

**Message Resource**:
```json
{
  "@context": "https://www.w3.org/ns/activitystreams",
  "@id": "/user/dms/conversations/convo_abc/messages/msg_001",
  "type": "Note",
  "content": "Hello!",
  "attributedTo": "https://pod.example/user",
  "published": "2026-05-01T12:34:56Z",
  "to": ["https://other-pod.example/user"]
}
```

### 6.2 PDS Repository (AT Protocol)

**Repo**: `did:example:user`

**Collection**: `chat.bsky.convo`

**Record**:
```json
{
  "uri": "at://did:example:user/app.bsky.chat.convo/abc123",
  "value": {
    "$type": "chat.bsky.convo",
    "id": "convo_abc123",
    "members": [
      "did:example:alice",
      "did:example:bob"
    ],
    "createdAt": "2026-05-01T12:34:56Z"
  }
}
```

### 6.3 Conversation ID Generation

**Algorithm** (ensures bidirectional matching):
```typescript
function generateConvoId(did1: string, did2: string): string {
  const sorted = [did1, did2].sort();
  const combined = sorted.join("|");
  return `convo_${base64(combined).slice(0, 12)}`;
}
// Result: convo_xyz remains same whether Alice→Bob or Bob→Alice
```

---

## 7. Cross-Protocol Mapping

### 7.1 ActivityPub ↔ AT Protocol Bridge

**Conversation Mapping**:
| ActivityPub | AT Protocol | Resolution |
|-------------|-------------|-----------|
| Create(Note) activity | `chat.bsky.convo.sendMessage` | Translator detects and converts |
| Message in contacts container | `chat.bsky.convo` record | Sync on create |
| Actor URI | DID | Resolve via identity bridge |
| WebACL permissions | Service endpoint auth | Check DID capability |

**Example Flow**:
```
AP User (alice@mastodon.social) sends DM to
AP User (bob@activity-pods.example)

1. mastodon.social → ActivityPubs backend
2. Activity federation to activity-pods.example
3. Detect AP → AT translation needed
4. Create chat.bsky.convo intent
5. Store in Pod + notify via Germ
```

### 7.2 Translator Registry

**File**: `fedify-sidecar/src/protocol-bridge/activitypub/ActivityPubToCanonicalTranslator.ts`

**Update**:
```typescript
export class ActivityPubToCanonicalTranslator extends TranslatorRegistry<unknown> {
  public constructor() {
    super([
      // ...existing translators...
      new DirectMessageTranslator(),  // NEW
    ]);
  }
}
```

---

## 8. Security & Privacy

### 8.1 Access Control

**Rules**:
1. **Message Owner**: Can always read their own messages
2. **Recipient**: Can read messages sent to them
3. **Non-Participant**: Cannot access any conversation data

**Implementation**:
```typescript
function canAccessConversation(userId: string, convoId: string): boolean {
  const convo = getConversation(convoId);
  return convo.members.some(m => m.did === userId);
}
```

### 8.2 Encryption

**Minimum Phase 3** (placeholder for now):
- Optional E2E encryption for messages
- Key exchange protocol (similar to Signal protocol)
- Stored encrypted in Pod/PDS

### 8.3 Moderation

**Extension** (integrates with existing moderation settings):
```typescript
// Check moderation policy before delivering message
const state = await resolveViewerModerationState(recipientDid);
if (state.blocks.includes(senderDid)) {
  // Don't deliver or mark as hidden
  return { blocked: true };
}
```

---

## 9. API Reference

### 9.1 Chat Routes (Memory API)

#### POST /chat/sendMessage
Send a message to a conversation.

**Headers**:
- `x-user-did` (required): Sender's DID

**Body**:
```json
{
  "convoId": "convo_abc123",
  "text": "Your message here"
}
```

**Response** (200):
```json
{
  "message": {
    "id": "msg_1234567890",
    "rev": "0",
    "text": "Your message here",
    "sender": { "did": "...", "handle": "..." },
    "sentAt": "2026-05-01T12:34:56Z"
  }
}
```

**Errors**:
- 401: Unauthorized (missing x-user-did)
- 403: Not a member of conversation
- 404: Conversation not found

---

#### GET /chat/getMessages
Retrieve messages from a conversation.

**Query Parameters**:
- `convoId` (required): Conversation ID
- `limit` (optional): 1-100, default 50
- `cursor` (optional): Pagination cursor

**Response** (200):
```json
{
  "messages": [{...}, {...}],
  "cursor": "next_page_token"
}
```

---

#### GET /chat/getConvo
Get conversation metadata.

**Query Parameters**:
- `convoId` (required): Conversation ID

**Response** (200):
```json
{
  "id": "convo_abc123",
  "rev": "0",
  "members": [
    { "did": "did:example:alice", "handle": "alice" }
  ],
  "lastMessage": {...},
  "opened": "2026-05-01T12:00:00Z"
}
```

---

#### GET /chat/listConvos
List all conversations for the user.

**Query Parameters**:
- `limit` (optional): 1-100, default 50
- `cursor` (optional): Pagination cursor

**Response** (200):
```json
{
  "convos": [{...}, {...}],
  "cursor": "next_page_token"
}
```

---

#### POST /chat/getConvoForMembers
Get or create a 1-1 conversation.

**Body**:
```json
{
  "members": ["did:example:alice", "did:example:bob"]
}
```

**Response** (200):
```json
{
  "id": "convo_abc123",
  "rev": "0",
  "members": [...],
  "opened": "2026-05-01T12:00:00Z"
}
```

---

## 10. Testing Strategy

### 10.1 Unit Tests

**Test File**: `memory/api/tests/chat.test.ts`

```typescript
describe('Chat Routes', () => {
  describe('sendMessage', () => {
    it('should send message to conversation', async () => {
      // Create conversation
      // Send message
      // Verify response structure
      // Check state updated
    });

    it('should reject if not member', async () => {
      // Create conversation with Alice
      // Try to send as Bob (not member)
      // Expect 403
    });
  });

  describe('getMessages', () => {
    it('should paginate messages', async () => {
      // Create 100 messages
      // Fetch with limit=10
      // Verify cursor works
    });
  });
});
```

### 10.2 Integration Tests

**Test File**: `fedify-sidecar/tests/DirectMessageTranslator.test.ts`

```typescript
describe('DirectMessageTranslator', () => {
  it('should detect AP direct messages', () => {
    const activity = createAPCreateNoteActivity();
    expect(translator.supports(activity)).toBe(true);
  });

  it('should translate to Germ chat intent', async () => {
    const intent = await translator.translate(activity, ctx);
    expect(intent.kind).toBe('chat.bsky.convo.sendMessage');
  });
});
```

### 10.3 End-to-End Tests

**Scenario**: Cross-protocol DM

```typescript
describe('E2E: Cross-Protocol DMs', () => {
  it('should send AP message from ActivityPods to AT Protocol user', async () => {
    // 1. Create AP user on activity-pods
    // 2. Create AT user on mastopod PDS
    // 3. AP user sends Create(Note) to AT user
    // 4. Verify message appears in AT user's chat
    // 5. AT user sends reply
    // 6. Verify reply in AP user's contacts.message container
  });
});
```

---

## 11. Deployment & Migration

### 11.1 Rollout Plan

**Phase 1** (Current):
- Deploy lexicons to fedify-sidecar
- Deploy chat routes to Memory API
- Test with manual curl requests

**Phase 2** (Q3 2026):
- Integrate translator into protocol bridge
- Deploy to staging environment
- Test AP → AT message flow

**Phase 3** (Q4 2026):
- Enable Germ network declarations
- Production rollout
- Monitor message delivery

### 11.2 Feature Flags

```typescript
const CHAT_FEATURES = {
  enableGermChat: process.env.ENABLE_GERM_CHAT === 'true',
  enableDirectMessageTranslation: process.env.ENABLE_DM_TRANSLATION === 'true',
  enableGroupConversations: process.env.ENABLE_GROUP_CHAT === 'true',
  enableMessageReactions: process.env.ENABLE_MESSAGE_REACTIONS === 'true',
};
```

---

## 12. Known Limitations & Future Work

### 12.1 Phase 1 Limitations
- ❌ No group conversations
- ❌ No message reactions
- ❌ In-memory storage only (not persistent)
- ❌ No end-to-end encryption
- ❌ No media attachments

### 12.2 Phase 2 Limitations
- ❌ No true P2P discovery (Germ network not fully implemented)
- ❌ Single service endpoint only
- ❌ No message edit/delete

### 12.3 Open Questions
1. **Conversation Ownership**: Who owns a conversation—both parties equally or one?
2. **Message Deletion**: Should deletes propagate cross-protocol?
3. **Read Receipts**: Privacy implications of read state in federated context?
4. **Typing Indicators**: Real-time presence reliability across slow networks?

---

## 13. References

- **ATProto Germ Support**: [bluesky-social/atproto#4415](https://github.com/bluesky-social/atproto/pull/4415)
- **Chat Lexicons**: `lexicons/chat/bsky/**/*.json` (ATProto repo)
- **ActivityPods Messaging**: `pod-provider/backend/services/contacts/message.js`
- **Fedify Sidecar**: `fedify-sidecar/src/protocol-bridge/`
- **Memory API**: `memory/api/src/`

---

## 14. Approval & Versioning

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 1.0 | May 1, 2026 | Initial design | Draft |
| 2.0 | TBD | Germ integration | Planned |
| 3.0 | TBD | Full feature parity | Planned |

**Document Owner**: Mastopod Architecture Team  
**Last Review**: May 1, 2026  
**Next Review**: May 15, 2026
