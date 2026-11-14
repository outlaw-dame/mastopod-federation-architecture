# External Sync firehose: large raw frame acceptance

AT Protocol Sync v1.1 caps the complete WebSocket firehose frame at exactly
5,000,000 bytes (5 MB, decimal), including its encoded protocol overhead.
The consumer enforces this exact cap rather than rounding up to 5 MiB. The sidecar wraps the
raw frame as Base64 in JSON before publishing to the external Redpanda raw
topic. Therefore a valid high-end frame cannot reliably fit the ordinary
512,000-byte application-event publisher budget or the default 1 MiB
Redpanda topic configuration.

The following explicit limits apply **only when**
`ENABLE_AT_EXTERNAL_FIREHOSE=true`:

- Socket maximum: 5,000,000 bytes (5 MB); one byte beyond is rejected.
- Serialized raw JSON event: 8 MiB; only for the configured
  `AT_EXTERNAL_FIREHOSE_RAW_TOPIC`, not trusted `at.ingress.v1`.
- Raw Redpanda topic `max.message.bytes`: 9 MiB. The topic
  bootstrapper sets this and startup topic governance requires it.
- KafkaJS raw consumer per-partition fetch: 10 MiB; total fetch: 16 MiB.
  These are large enough to avoid a permanently stuck fetch on a valid
  raw message, while bounding expected fetch memory.

The regular event budget remains 512,000 bytes. Other Redpanda topics do
not have their maximum message size raised.

**Operator acceptance:**

1. Bootstrap/reconcile topics with the verified external source flag
   enabled, then verify the topic's actual `max.message.bytes` is at
   least 9 MiB. The Redpanda cluster also needs to permit that size;
   `kafka_max_message_size_upper_limit_bytes` must not prevent it.
2. Prove producer acknowledgment and raw consumer decoding of a
   protocol-maximum frame against the actual broker version, with and without
   compression, and verify that trusted ingress still requires cryptographic
   validation.
3. Measure batching/network/RSS under burst loads. A 9 MiB raw message
   budget raises **maximum** memory requirements, not normal retained
   memory. Avoid batching many raw 5 MiB events, and audit
   broker/topic retention cost (currently three days for raw firehose).
4. Never drop, truncate, or advance the cursor past a frame that cannot be
   durably accepted. Investigate oversize broker rejects as release blockers
   rather than looping indefinitely.

Primary references:
- https://atproto.com/specs/sync
- https://docs.redpanda.com/streaming/current/reference/properties/topic-properties/
- https://kafka.js.org/docs/consuming
