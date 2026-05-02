# Entryway Account Provisioning

The Entryway is the sidecar front-door coordinator for app-mediated signup. It
does not replace the ActivityPods provider. It routes a signup request to an
approved provider, calls the provider-owned `provider.account.provisioning`
path, stores account routing metadata, and verifies the returned account bundle
before the route becomes active.

## Runtime Shape

```text
Memory backend / Entryway client
  -> POST /entryway/accounts
  -> Entryway provider router
  -> ActivityPods POST /api/accounts/create
  -> WebID + Pod + ActivityPub actor + optional ATProto
  -> Entryway verification
  -> AccountRoute(status=active)
```

The Entryway stores routing metadata only. It must not store the user's
password, verification challenge token, provider bearer token, access token, or
refresh token.

Before provisioning, the Entryway fetches each candidate provider's
`/.well-known/provider-capabilities` document and requires:

- `provider.account.provisioning` is `enabled` or `beta`
- approved apps are required
- user verification is required
- requested protocol bundle is supported
- `security.failClosed=true`

If the first configured provider fails preflight and another eligible provider
exists, the Entryway tries the next provider. Explicit provider choices fail
closed instead of silently rerouting.

## Required Environment

```text
ENABLE_ACCOUNT_PROVISIONING=true
ENABLE_ENTRYWAY=true
ENTRYWAY_TOKEN=<backend-to-entryway bearer token>
ENTRYWAY_FINGERPRINT_SECRET=<32+ char HMAC secret>
ENTRYWAY_APP_CLIENT_ID=https://memory.example/app
ENTRYWAY_PROVIDER_PROVISIONING_TOKEN=<provider-approved provisioning token>
ENTRYWAY_DEFAULT_PROVIDER_URL=https://pods.memory.example
ENTRYWAY_APP_BOOTSTRAP_ENABLED=true
ENTRYWAY_APP_BOOTSTRAP_PATH=/api/internal/entryway/app-bootstrap
REDIS_URL=redis://redis:6379
```

`ENTRYWAY_PROVIDERS_JSON` can replace the single default provider:

```json
[
  {
    "providerId": "memory-us-east",
    "baseUrl": "https://pods-us-east.memory.example",
    "provisioningBearerToken": "provider-issued-token",
    "appClientId": "https://memory.example/app",
    "origin": "https://memory.example",
    "redirectUri": "https://memory.example/signup/callback",
    "appBootstrapEnabled": true,
    "appBootstrapPath": "/api/internal/entryway/app-bootstrap",
    "enabled": true
  }
]
```

## API

`POST /entryway/accounts` requires `Authorization: Bearer $ENTRYWAY_TOKEN` and
an `Idempotency-Key` header.

The request includes username, email, password, profile, optional protocol
choices, and provider/user-verification fields. The provider receives the
password for account creation; the Entryway only stores an HMAC request
fingerprint and route metadata.

`GET /entryway/accounts/:accountId` is always protected by `ENTRYWAY_TOKEN`.

`GET /entryway/accounts/by-username/:username` is protected unless
`ENTRYWAY_PUBLIC_RESOLVE=true`.

`POST /entryway/recover` retries verification for stale provisioning routes
that already have enough provider metadata to self-heal.

The sidecar also starts a bounded background recovery loop when Entryway is
enabled:

```text
ENTRYWAY_RECOVERY_INITIAL_DELAY_MS=60000
ENTRYWAY_RECOVERY_INTERVAL_MS=300000
ENTRYWAY_RECOVERY_BATCH_LIMIT=25
ENTRYWAY_STALE_PROVISIONING_AFTER_MS=600000
```

Recovery only re-verifies routes that already contain provider account metadata.
It does not blindly call account creation again.

## App Bootstrap

When `appBootstrapEnabled` is true for the selected provider, Entryway calls the
provider-owned bootstrap endpoint after account bundle verification and before
marking the account route active. The endpoint is expected to register the app,
create provider-owned grants, and optionally return a short-lived session
handoff.

On the ActivityPods provider, enable the internal bootstrap endpoint with:

```text
ENTRYWAY_APP_BOOTSTRAP_PROVIDER_ENABLED=true
ENTRYWAY_APP_BOOTSTRAP_APPS_JSON='[
  {
    "appClientId": "https://memory.example/app",
    "appUri": "https://memory.example/app",
    "acceptedAccessNeeds": [
      "https://memory.example/ns/access-needs#timeline"
    ],
    "acceptedSpecialRights": [
      "apods:ReadInbox",
      "apods:ReadOutbox"
    ]
  }
]'
```

Entryway persists only:

- app client id
- app registration URI
- access grant URIs
- bootstrap status and timestamps

Entryway does not persist access tokens, refresh tokens, session cookies,
passwords, or verification challenge tokens.

## Current Limits

The provider bootstrap endpoint still needs to be implemented by the selected
ActivityPods provider. Entryway now has the orchestration contract and will fail
closed if configured bootstrap does not complete.
