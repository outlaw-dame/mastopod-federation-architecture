# Cloudflare CSAM + CDN integration

## Important constraint

Cloudflare's CSAM Scanning Tool is not exposed here as a direct request/response API in the current public docs.
It is configured in the Cloudflare dashboard and operates on content served through Cloudflare cache.

That means the correct architecture is:

1. serve canonical media URLs through a Cloudflare-proxied hostname
2. enable the CSAM Scanning Tool for that zone in the dashboard
3. continue to use Safe Browsing before fetch and internal moderation states in the pipeline
4. treat Cloudflare CSAM detections as asynchronous enforcement / review signals

## Recommended delivery topology

```text
Media Pipeline -> Filebase (origin storage)
             -> canonical media.yourdomain URLs
             -> Cloudflare proxy/cache/CDN
             -> end users
```

This preserves:
- Filebase/IPFS-backed storage truth
- Cloudflare edge delivery and caching
- compatibility with Cloudflare CSAM scanning requirements

## Optional Cloudflare Images path

For image-heavy deployments, you can optionally mirror selected public image variants into Cloudflare Images.
Use this only for public/derivative delivery, not as the canonical storage source of truth.

## Enforcement model

- pre-ingest URL safety: Google Safe Browsing
- pre-fetch SSRF controls: local guardrails
- post-delivery detection: Cloudflare CSAM Scanning Tool
- local policy state: moderation flags / quarantine / removal workflows

## What should not be assumed

- do not assume a synchronous CSAM verdict API exists in this integration
- do not block pipeline completion on Cloudflare CSAM scanning
- do not replace canonical asset persistence with Cloudflare delivery identifiers
