/**
 * Bound external ATProto Sync v1.1 raw payloads end-to-end.
 * Sync v1.1 caps the complete WebSocket frame at 5,000,000 bytes (decimal MB),
 * inclusive of CBOR framing. Base64 expands that to 6,666,668 bytes before
 * JSON metadata and Kafka overhead.
 * Keep large-message allowances scoped to the raw external firehose topic.
 */
export const AT_SYNC_MAX_FRAME_BYTES = 5_000_000;
export const AT_SYNC_RAW_MAX_EVENT_BYTES = 8 * 1024 * 1024;
export const AT_SYNC_RAW_TOPIC_MAX_MESSAGE_BYTES = 9 * 1024 * 1024;
export const AT_SYNC_RAW_FETCH_BYTES_PER_PARTITION = 10 * 1024 * 1024;
export const AT_SYNC_RAW_FETCH_BYTES = 16 * 1024 * 1024;
