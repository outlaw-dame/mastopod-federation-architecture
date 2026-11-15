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
# Optional, operator-owned authenticated provider SAI consent page:
ENTRYWAY_SAI_AUTHORIZATION_URL=https://pods-ui.memory.example/authorize
ENTRYWAY_SAI_APP_URI=https://memory.example/app
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
    "saiAuthorizationUrl": "https://pods-ui.memory.example/authorize",
    "saiAppUri": "https://memory.example/app",
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
marking the account route active. The provider **does not automatically issue
app grants**. Only the Pod owner's authenticated native SAI authorization flow
may register the application and create its approved permissions; bootstrap
then checks persisted account, grant and (where configured) durable PostgreSQL
consent evidence without mutating rights.

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

## Native SAI user-consent continuation

When the provider returns HTTP 428 (owner authorization required), Entryway
holds the provider-backed account in `awaiting_consent` and **does not activate
it or retry automatically**. For an authenticated signup caller, Entryway can
return a trusted `authorizationUrl` along with the stable
`app_consent_required` error. This is a direct link to the provider's existing
native `/authorize?client_id=...` page. The page requires real Pod-owner login
and explicit SAI application authorization, with optional permissions unselected
by default.

A link is returned only if the operator has explicitly configured **both**
`saiAuthorizationUrl` and `saiAppUri` (or the single-provider environment
equivalents), using canonical HTTPS; the page must end in `/authorize` with
no existing query, fragment or credentials. Do **not** substitute the signup
app-client ID for the SAI app URI: they can be different resource identifiers.
Neither the user request, the provider error body nor a remote application
callback is allowed to set the redirect destination. If no safe URL is
configured, the error has no link and the route remains non-active.

After authorizing the app, the trusted backend can invoke the
**backend-only consent-resume endpoint below**, supplying the same
idempotency reference from its protected server-side transaction store.
The earlier exact-original-signup replay remains supported for legacy
backend clients, but new clients do not need to resend the signup password
or verification token. The Paper client must still implement and test
its authenticated browser return and secure transaction binding.

## Backend-only consent resumption without resending signup credentials

After the Pod owner completes native SAI authorization, the trusted Paper
backend can resume an **already provisioned** consent-pending account using
only its existing server-side transaction reference:

```http
POST /entryway/accounts/consent/resume
Authorization: Bearer <backend-to-entryway token>
Idempotency-Key: <original high-entropy signup key>
Content-Type: application/json

{
  "username": "alice",
  "appClientId": "https://memory.example/app"
}
```

The endpoint is **not publicly callable**. It rejects requests without
`ENTRYWAY_TOKEN` before looking up an account, requires the original
idempotency key in the HTTP header, and rejects client-supplied passwords,
redirect URIs and unsolicited body properties. The Paper backend must
retain the key inside a protected, expiring **server-side transaction**
bound to the original authenticated signup session. Never put the
idempotency key, signup password, verification challenge, provider bearer
or access token in a browser callback URL, query string, web storage,
analytics, or log.

Entryway loads the canonical username route and uses the same HMAC secret
as the original reservation to check the supplied idempotency key
without revealing whether an unrelated username exists. It additionally
requires the exact original provider, enabled bootstrap policy and
app-client ID, even if multiple clients share one SAI application URI.
No signup password, verification token or provider account creation RPC
is needed for an account with complete existing provider identity.

For a still-`awaiting_consent` account, Entryway claims the existing
route with its Redis/PostgreSQL-independent route CAS revision/fence,
reverifies the WebID/ActivityPub/ATProto bundle, and invokes the
provider-owned read-only SAI bootstrap. Only verified current owner
grants can advance the route to active. A second worker cannot overwrite
the winning fence or create a second WebID/DID. A 428 response leaves
the original route non-active, with only the operator-pinned SAI consent
URL. A repeated call after activation rechecks **current** provider
grants and returns routing state, not a newly minted user session.

The resume response intentionally **never returns a provider session
handoff**. This is not a replacement for Solid-OIDC login; an actual
browser session must authenticate as the Pod owner independently.
The browser-to-Paper authenticated callback and secure state linkage are
not yet implemented by this Entryway route. The production signed-PDS,
restricted PostgreSQL credentials, native SAI permission enforcement
and real browser callback acceptance remain separate release gates.

## Current limits and release boundaries

The provider-owned bootstrap endpoint is implemented with local-owner and
SAI grant checks; its production authority deliberately refuses readiness
until the real signed PDS, canonical PostgreSQL and native SAI owner flows are
reviewed together. The consent URL is an **initiation link**, not a login token
or an assertion that any permission was granted. The native browser handoff,
trusted application callback, multi-worker recovery and revocation-at-operation
checks still need full cross-repository acceptance. Production signup remains
source-controlled closed.
