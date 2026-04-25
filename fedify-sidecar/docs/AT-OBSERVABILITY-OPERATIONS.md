# AT Observability Operations

This document covers the sidecar's AT identity observability surface for operator use.

## Purpose

Track AT identity coverage and projection outcomes without treating unbound external identities as failures.

Key idea:
- AT ingestion and canonical processing continue for all valid identities.
- AT->AP projection is skipped for unbound external identities.
- Skip/project/fail outcomes are explicit in metrics and report APIs.

## Metrics

Prometheus counter:
- `fedify_protocol_bridge_projection_outcomes_total`

Labels:
- `direction`: currently `at_to_ap`
- `outcome`: `projected`, `skipped`, `failed`
- `reason`: reason code for the outcome

Useful queries:
- Projected:
  - `sum by (reason) (fedify_protocol_bridge_projection_outcomes_total{direction="at_to_ap",outcome="projected"})`
- Skipped:
  - `sum by (reason) (fedify_protocol_bridge_projection_outcomes_total{direction="at_to_ap",outcome="skipped"})`
- Failed:
  - `sum by (reason) (fedify_protocol_bridge_projection_outcomes_total{direction="at_to_ap",outcome="failed"})`

## Admin Report Endpoint

Route:
- `GET /internal/admin/at-observability/identities?limit=25`

Headers:
- `authorization: Bearer <MRF_ADMIN_TOKEN>`
- `x-provider-permissions: provider:read`

Response highlights:
- `summary`: counts for observed identities and outcome totals
- `topUnbound`: most-seen unbound external DIDs (with handle and PDS endpoint when resolvable)
- `topBound`: most-seen bound identities
- `recent`: recently observed identities
- `queries`: copy-paste Prometheus query snippets

## CLI Helper

Script:
- `scripts/at-observability-report.sh`

Environment:
- `ADMIN_TOKEN` or `MRF_ADMIN_TOKEN` (required)
- `BASE_URL` (default `http://127.0.0.1:8080`)
- `LIMIT` (default `10`)
- `FORMAT` (`pretty`, `json`, or `csv`; default `pretty`)
- `OUTPUT_FILE` (optional output path)

Examples:

Pretty output:

```bash
ADMIN_TOKEN=mrf-admin-local-token ./scripts/at-observability-report.sh
```

JSON export:

```bash
ADMIN_TOKEN=mrf-admin-local-token FORMAT=json OUTPUT_FILE=/tmp/at-observability.json ./scripts/at-observability-report.sh
```

CSV export:

```bash
ADMIN_TOKEN=mrf-admin-local-token FORMAT=csv OUTPUT_FILE=/tmp/at-observability.csv ./scripts/at-observability-report.sh
```

## Operator Interpretation

Healthy dual-support posture typically looks like:
- high `skipped_unbound_actor` counts for external traffic
- low `failed` counts
- stable AT ingestion and canonical pipelines

This is expected when AP projection is intentionally bound-only.
