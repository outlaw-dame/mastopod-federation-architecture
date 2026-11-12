/**
 * Bound external ATProto Sync v1.1 raw payloads end-to-end.
 * The WebSocket frame ceiling predates the JSON/Redpanda envelope:
 * base64 expands 5 MiB to ~6.67 MiB before metadata and Kafka headers.
 * Keep large-message allowances scoped to the raw external firehose topic.
 */
export const AT_SYNC_MAX_FRAME_BYTES = 5 * 1024 * 1024;
export const AT_SYNC_RAW_MAX_EVENT_BYTES = 8 * 1024 * 1024;
export const AT_SYNC_RAW_TOPIC_MAX_MESSAGE_BYTES = 9 * 1024 * 1024;
export const AT_SYNC_RAW_FETCH_BYTES_PER_PARTITION = 10 * 1024 * 1024;
export const AT_SYNC_RAW_FETCH_BYTES = 16 * 1024 * 1024;
