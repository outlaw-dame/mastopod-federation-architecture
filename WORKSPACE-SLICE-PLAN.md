# Workspace Slice Plan

This workspace spans the ActivityPods app, the Fedify/media sidecars, and the Memory app. The goal is to keep the local developer workflow explicit: run shared infrastructure once, start only the services you are actively working on, and keep external integrations mocked or disabled unless you are validating them directly.

## Slices

### 1. Core Infrastructure
Run this first and keep it stable while you work.

- Colima / Docker VM with enough headroom for OpenSearch and RedPanda
- ActivityPods compose dependencies from [activity-pods/scripts/bootstrap-local-dev.sh](../activity-pods/scripts/bootstrap-local-dev.sh)
- Federation compose dependencies from [activity-pods/scripts/bootstrap-local-dev.sh](../activity-pods/scripts/bootstrap-local-dev.sh)
- Memory PostgreSQL and local AT bridge harness from [memory/docker-compose.local.yml](memory/docker-compose.local.yml)

Recommended baseline:

- `colima start --cpu 4 --memory 8 --disk 100`
- `docker compose -f pod-provider/docker-compose.yml up -d`
- `docker compose -f memory/docker-compose.local.yml up -d --build`

### 2. ActivityPods Active Services
This is the slice you keep running when working on provider behavior, moderation, auth, or federation glue.

Entry point:

- `sh ./scripts/bootstrap-local-dev.sh`

What it starts:

- ActivityPods backend on `http://localhost:3000`
- ActivityPods frontend on `http://localhost:5000`
- Fedify sidecar on `http://localhost:8080`
- Media pipeline sidecar on `http://localhost:8090`

Use this slice for:

- pod-provider backend changes
- frontend auth and moderation flows
- Fedify bridge behavior
- media pipeline delivery and ingestion
- RedPanda topic bootstrapping

### 3. Memory App Slice
Use this when working on the Memory UI, API, migrations, or AT ingestion path.

Entry point:

- `docker compose -f docker-compose.local.yml up --build`

What it starts:

- PostgreSQL on `localhost:5432`
- Memory API on `http://localhost:8794`
- Memory frontend on `http://localhost:5173`
- Mastopod AT harness

Use this slice for:

- thread graph and reply policy work
- Memory API migrations
- UI rendering and API integration
- local AT content proofing

### 4. External Integration Slice
Keep this off unless you are validating an integration path end to end.

- ngrok or another tunnel only when you need remote browser access
- live Jetstream / XRPC only when you are validating public federation behavior
- OpenSearch indexing only when the workload needs it
- real relay or remote actor traffic only when the fixture path is no longer enough

## Current Workspace Commands

These are the commands already wired into the repos.

### ActivityPods

- `npm run dev:bootstrap-all`
- `npm run dev:status-all`
- `npm run dev:shutdown-all`

These map to the scripts in [activity-pods/package.json](../activity-pods/package.json).

### Memory

- `docker compose -f docker-compose.local.yml up -d --build`
- `docker compose -f docker-compose.local.yml ps`
- `curl http://localhost:8794/health`
- `open http://localhost:5173` or use the browser in VS Code

## Local Rules

- Keep only one Fedify sidecar instance running at a time.
- Prefer host-process sidecars when OpenSearch or Docker memory pressure causes restart loops.
- Clear only the targeted Redis relay state when the relay gets stuck in backoff.
- Keep the Memory frontend build aligned with the API base URL you actually expose.
- Treat ngrok as an access layer, not as the source of truth for service topology.

## Known Gaps

- The Memory frontend is still tied to a local API origin in the built bundle, so public access through a tunnel is partial unless the frontend is rebuilt for a public API URL.
- The current ngrok setup has not been normalized into separate public endpoints for UI and API.
- The root workspace has separate bootstrap paths, but it does not yet have a single command that starts every repo in one coherent topology.

## Suggested Next Step

Normalize the workspace around three launch targets:

1. ActivityPods active slice
2. Memory app slice
3. Minimal core infra slice

Then add a single root-level task or launch group for each slice instead of trying to force one monolithic startup path.
