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
queue ingress -> ingest worker -> fetch worker -> process worker -> finalize worker
```

The finalize stage persists the canonical asset, emits a media lifecycle event, and writes a media indexing payload. Any safety signals are emitted as raw signals only for downstream MRF evaluation.
