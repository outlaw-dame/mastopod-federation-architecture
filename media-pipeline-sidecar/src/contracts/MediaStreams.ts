export const MediaStreams = {
  INGEST: 'media:ingest',
  FETCH_REMOTE: 'media:fetch:remote',
  INSPECT: 'media:inspect',
  PROCESS_IMAGE: 'media:process:image',
  PROCESS_VIDEO: 'media:process:video',
  STORE: 'media:store:filebase',
  BIND_AP: 'media:bind:activitypub',
  BIND_AT: 'media:bind:atproto',
  FINALIZE: 'media:finalize',
  DELETE: 'media:delete',
  DLQ: 'media:dlq'
} as const;
