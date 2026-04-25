# ActivityPods Backend Deterministic Signup Patch Set

This folder stages backend-ready artifacts for the ActivityPods backend.
When the live backend repo is available in the same workspace, prefer applying
the corresponding files directly there and treat this folder as a mirror of the
integration patch set. Copy these files into:

- `pod-provider/backend/services/internal-identity-projection.service.js`
- `pod-provider/backend/services/internal-identity-projection-api.service.js`
- `pod-provider/backend/services/actor-status-normalization.service.js`
- `pod-provider/backend/scripts/proof-unified-account-at-ready.js`

## Package Script Wiring

Add this script to `pod-provider/backend/package.json`:

```json
{
  "scripts": {
    "proof:unified-account:at-ready": "node scripts/proof-unified-account-at-ready.js"
  }
}
```

Useful proof cluster:

```json
{
  "scripts": {
    "proof:identity-projection": "node scripts/proof-internal-identity-projection.js",
    "proof:identity-changes": "node scripts/proof-internal-identity-changes.js",
    "proof:secure-dataset": "node scripts/proof-secure-dataset-provisioning.js",
    "proof:unified-account": "node scripts/unified-account-live-proof.js",
    "proof:unified-account:at-ready": "node scripts/proof-unified-account-at-ready.js"
  }
}
```

## Actor Status Integration Contract

The sidecar now supports FEP-82f6 actor statuses and expects the real backend
to surface two capabilities:

1. Actor profile writes must normalize `actor.status` using the staged
   `actor-status-normalization` service (or equivalent logic) so local status
   updates always have:
   - `type: "ActorStatus"`
   - `id`
   - `attributedTo`
   - `published`
   - optional validated `endTime`
   - optional validated rich-presence `attachment`

2. An authenticated internal endpoint must expose status history at:

```text
GET /api/internal/actors/:identifier/status-history
Authorization: Bearer <ACTIVITYPODS_TOKEN>
Accept: application/activity+json
```

Return either:
- an `OrderedCollection` / `Collection` with `orderedItems` or `items`, or
- a bare array of `ActorStatus` objects.

When the actor has no history support, return `404` and do not expose
`statusHistory` on the actor document.

## Required `/api/accounts/create` Response Contract

Return a response shaped like:

```js
return {
  canonicalAccountId: canonical.canonicalAccountId,
  webId: solid.webId,

  solid: {
    webId: solid.webId,
    podBaseUrl: solid.podBaseUrl || null
  },

  activitypub: {
    actorId: activitypub.actorId,
    handle: activitypub.handle || null,
    inbox: activitypub.inbox || null,
    outbox: activitypub.outbox || null
  },

  atproto: {
    did: atproto.did,
    handle: atproto.handle,
    repoInitialized: !!atproto.repoInitialized,
    signingReady: true
  },

  provisioning: {
    state: "completed"
  },

  createdAt: canonical.createdAt || new Date().toISOString()
};
```

Fail closed when ATProto is enabled but deterministic provisioning did not
finish:

```js
if (params.atproto?.enabled && (!atproto?.did || !atproto?.repoInitialized)) {
  throw new MoleculerError(
    "ATProto provisioning incomplete",
    500,
    "ATPROTO_PROVISIONING_INCOMPLETE"
  );
}
```

## Prerequisites In The Real Backend Repo

These staged files assume the earlier backend work also exists:

- `identitybindings.upsertRepoBootstrap`
- `identitybindings` persistence for:
  - `repoInitialized`
  - `repoRootCid`
  - `repoRev`
- `atproto-provisioning.provisionForAccount` returns:
  - `did`
  - `handle`
  - `repoInitialized`
- unified-account signup calls AT provisioning before returning success

## Recommended Verification Order

```bash
npm --prefix activitypods-work/activity-pods/pod-provider/backend run proof:secure-dataset
npm --prefix activitypods-work/activity-pods/pod-provider/backend run proof:identity-projection
npm --prefix activitypods-work/activity-pods/pod-provider/backend run proof:identity-changes
npm --prefix activitypods-work/activity-pods/pod-provider/backend run proof:unified-account:at-ready
```

Then from the sidecar repo:

```bash
npm run smoke:identity-repo:upsert
npm run smoke:identity-sync:direct
npm run proof:identity-sync
npm run proof:identity-sync:write-miss
IDENTITY_WARM_INTERVAL_MS=5000 npm run proof:identity-warmup
```
