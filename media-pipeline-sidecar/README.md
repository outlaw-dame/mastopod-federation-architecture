# Media Pipeline Sidecar

Focused media infrastructure service for the Mastopod federation architecture.

## Responsibilities

- secure remote media ingress
- MIME and file validation
- media transformation and derivative generation
- Filebase-backed canonical storage
- Cloudflare delivery URL generation
- raw safety signal collection adapters
- protocol-specific media projection helpers
- media lifecycle events and indexing payloads

## Non-responsibilities

- final moderation decisions
- feed filtering or ranking policy
- user safety preferences
- human moderation workflow

## Runtime shape

```text
queue ingress -> ingest worker -> fetch worker -> process:image|video -> finalize worker
```

The finalize stage persists the canonical asset, emits a media lifecycle event, and writes a media indexing payload. Any safety signals are emitted as raw signals only for downstream MRF evaluation.

## Supported media types

### Images
- image/jpeg
- image/png
- image/webp
- image/gif
- image/avif

### Videos
- video/mp4
- video/webm
- video/quicktime

## Runtime note

The current cleaned branch runs with `tsx` for source execution. That is intentional.
The branch still uses extensionless ESM imports internally, so `node dist/...` would need a systematic `.js` import conversion or bundling pass before claiming emitted-JS runtime support.

## Worker commands

- `npm run worker:ingest`
- `npm run worker:fetch`
- `npm run worker:process:image`
- `npm run worker:process:video`
- `npm run worker:finalize`
