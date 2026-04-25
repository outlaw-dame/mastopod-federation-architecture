# Media Pipeline Sidecar Scope

This service is a focused media infrastructure component.

## It owns

1. secure media ingress and remote fetch
2. source URL safety checks at the media boundary
3. MIME and file validation and sanitation
4. media processing and derivative generation
5. canonical asset persistence and storage adapters
6. CDN and delivery adapters
7. raw safety signal adapters only
8. protocol-specific media projections only where representation is media-specific
9. media lifecycle events and indexing payloads

## It does not own

1. final moderation policy decisions
2. instance-wide moderation policy
3. user safety preferences
4. feed filtering or ranking policy
5. human moderation workflow or review queue
6. federation-wide trust policy
7. app-level visibility rules beyond media metadata

## Required boundary

The sidecar may collect raw safety signals from providers such as Google Safe Browsing, Google Vision SafeSearch, Google Video Intelligence, and Cloudflare-delivered CSAM-related signals.

Those signals are emitted downstream for MRF evaluation. The sidecar must not be the final authority for allow/review/block decisions.
