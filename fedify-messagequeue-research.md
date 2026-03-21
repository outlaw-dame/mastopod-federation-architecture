# Fedify MessageQueue Interface Research

## Key Findings from Official Documentation and Source Code

### MessageQueue Interface Requirements

The `MessageQueue` interface in Fedify requires:

1. **`enqueue(message: any, options?: MessageQueueEnqueueOptions): Promise<void>`**
   - Add a message to the queue
   - Handle `delay` option if provided (for delayed messages)
   - Must be non-blocking (async)

2. **`enqueueMany(messages: readonly any[], options?: MessageQueueEnqueueOptions): Promise<void>`** (optional, since Fedify 1.5.0)
   - Batch enqueue for better performance
   - If not implemented, Fedify calls `enqueue()` for each message

3. **`listen(handler: (message: any) => void | Promise<void>, options?: MessageQueueListenOptions): Promise<void>`**
   - Start listening for messages
   - Call handler for each received message
   - **CRITICAL**: The returned Promise should NEVER resolve unless the `signal` is triggered
   - Handle `signal` (AbortSignal) for graceful shutdown

4. **`nativeRetrial: boolean`** (optional, since Fedify 1.7.0)
   - If `true`, Fedify skips its own retry logic
   - If `false` or omitted, Fedify handles retries

### How Official RedisMessageQueue Works

From `@fedify/redis` source code:

1. **Uses Redis Sorted Set (ZADD)** for the queue, NOT Redis Streams
   - Messages stored with timestamp as score
   - Delayed messages have future timestamp
   - Immediate messages have timestamp 0

2. **Uses Redis Pub/Sub** for notifications
   - When message enqueued with no delay, publishes to channel
   - Listeners subscribe to channel for immediate notification

3. **Polling mechanism**
   - Subscribes to Pub/Sub channel
   - On message notification, polls the sorted set
   - Also polls periodically (default 5 seconds) as backup

4. **Message format**
   - Each message wrapped with UUID: `[uuid, message]`
   - Encoded using codec (default JSON)

### Key Differences from Our Implementation

Our current implementation uses Redis Streams (XADD/XREADGROUP), but the official implementation uses:
- **Sorted Set (ZADD/ZRANGEBYSCORE)** for message storage
- **Pub/Sub** for notifications
- **Polling** as backup

### Should We Use Redis Streams or Sorted Set?

**Redis Streams (our approach) advantages:**
- Consumer groups for horizontal scaling
- Message acknowledgment (XACK)
- Automatic redelivery of unacknowledged messages
- Better for work queue semantics

**Sorted Set (official approach) advantages:**
- Simpler implementation
- Built-in delay support via score
- Works with Redis Cluster more easily

**Recommendation**: Redis Streams is actually MORE appropriate for our use case because:
1. We need consumer groups for horizontal scaling
2. We need message acknowledgment for reliability
3. We need automatic redelivery for crash recovery

The official `@fedify/redis` uses Sorted Set for simplicity, but Redis Streams is a valid and arguably better choice for production workloads.

### Critical Implementation Details

1. **`listen()` must never resolve** unless signal is aborted
2. **Message deduplication** is NOT handled by Fedify - we need to implement idempotency
3. **Retry logic** - if `nativeRetrial` is false, Fedify handles retries
4. **Delay support** - must honor `options.delay` for scheduled messages

### Our Redis Streams Implementation Checklist

- [x] XADD for enqueue
- [x] XREADGROUP for listen
- [x] Consumer groups for scaling
- [x] XACK for acknowledgment
- [x] XAUTOCLAIM for crash recovery
- [x] Delay support (using separate sorted set or stream)
- [ ] Verify listen() never resolves unless signal aborted
- [ ] Verify proper error handling in poll loop
