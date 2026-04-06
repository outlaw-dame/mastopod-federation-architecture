export const MediaStreams = {
  INGEST: 'media:ingest',
  FETCH: 'media:fetch',
  PROCESS_IMAGE: 'media:process:image',
  PROCESS_VIDEO: 'media:process:video',
  FINALIZE: 'media:finalize',
  DLQ: 'media:dlq'
} as const;
