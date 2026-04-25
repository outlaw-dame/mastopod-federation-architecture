export const MediaStreams = {
  INGEST: 'media:ingest',
  FETCH: 'media:fetch',
  PROCESS_IMAGE: 'media:process:image',
  PROCESS_VIDEO: 'media:process:video',
  RENDITION_VIDEO: 'media:rendition:video',
  FINALIZE: 'media:finalize',
  DLQ: 'media:dlq'
} as const;
