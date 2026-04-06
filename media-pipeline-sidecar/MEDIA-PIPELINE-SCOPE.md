# Media Pipeline Sidecar Scope

This document defines the **allowed scope** of the media pipeline sidecar and supersedes any broader drift.

## The sidecar owns

1. secure media ingress and remote fetch
2. source URL safety checks at the media boundary
3. MIME / file validation and sanitation
4. media processing and derivative generation
5. canonical asset persistence and storage adapters
6. CDN and delivery adapters
7. raw safety signal adapters (only)
8. protocol-specific media projections (only media representation)
9. media lifecycle events and indexing payloads

## The sidecar does NOT own

1. final moderation policy decisions
2. instance-wide moderation policy
3. user safety preferences
4. feed filtering or ranking policy
5. human moderation workflow / review queue
6. federation-wide trust policy
7. app-level visibility rules beyond media metadata

## Required boundary

The sidecar may collect **raw signals** from providers such as:
- Google Safe Browsing
- Google Vision SafeSearch
- Google Video Intelligence
- Cloudflare CSAM tooling

But the sidecar must not be the final authority for allow/review/block decisions.
Those decisions belong to MRF.

## Sidecar output contract

The sidecar should emit:
- canonical asset metadata
- raw safety signals
- optional media presentation metadata intrinsic to the asset (alt text, blur preview URL, sensitive hint, content warning text)
- media lifecycle events

The sidecar should not emit final global policy state as its source of truth.
