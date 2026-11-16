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
  -> mandatory new-account WebID + Pod + ActivityPub actor + did:plc
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
ENTRYWAY_OWNER_SESSION_ISSUER=https://pods.memory.example
ENTRYWAY_OWNER_SESSION_JWKS_URL=https://pods.memory.example/api/entryway-owner-session/jwks
ENTRYWAY_OWNER_SESSION_AUDIENCE=urn:paper:entryway:owner-session:v1
# Optional, operator-owned authenticated provider SAI consent page:
ENTRYWAY_SAI_AUTHORIZATION_URL=https://pods-ui.memory.example/authorize
ENTRYWAY_SAI_APP_URI=https://memory.example/app
ENTRYWAY_DATABASE_URL=postgresql://entryway_runtime:<password>@postgres.example/entryway
# Optional PEM CA for PostgreSQL TLS (certificate verification stays enabled):
ENTRYWAY_DATABASE_CA=<PEM CA certificate>
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
    "ownerSessionIssuer": "https://pods-us-east.memory.example",
    "ownerSessionJwksUrl": "https://pods-us-east.memory.example/api/entryway-owner-session/jwks",
    "ownerSessionAudience": "urn:paper:entryway:owner-session:v1",
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
It must also supply a fresh provider-signed owner-session proof obtained by
the authenticated browser from the provider. The proof is ES256, has a maximum
accepted age of five minutes, and is bound to the exact provider issuer,
account ID, username, WebID and app client ID. Entryway accepts keys only from
the operator-pinned same-origin JWKS URL. In the same CAS operation that claims
the route fence, it stores only a bounded, expiry-pruned set of HMAC proof-JTI
digests, so failed attempts require fresh proofs, A/B/A replay is rejected, and
JWT bytes never enter route state.
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
  "appClientId": "https://memory.example/app",
  "ownerSessionProof": "<short-lived provider-signed ES256 JWT>"
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

The browser obtains `ownerSessionProof` from the ActivityPods
`POST /api/entryway-owner-session/proof` endpoint using its native Solid-OIDC
access token and a DPoP proof verified for that exact HTTP request. The
provider route is disabled unless both
`ENTRYWAY_OWNER_SESSION_PROOF_ENABLED=true` and
`APODS_SOLID_OIDC_DPOP_ENFORCE_ENABLED=true`. The request supplies only the
account ID, username, WebID and app client ID; the backend idempotency key is
never exposed to the browser. Paper must deliver the returned JWT to its
protected server-side signup transaction without placing it in a URL, log,
analytics event or durable client storage.
The same opt-in service publishes its matching public ES256 key, never private
key material, at `GET /api/entryway-owner-session/jwks`; configure Entryway
with that exact same-origin URL.

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
The provider proof verifier and one-time fenced route-state consumption boundary are
implemented, but the browser-to-Paper authenticated return and secure
transaction linkage are not yet implemented by this Entryway route. The
production signed-PDS, PostgreSQL canonical Entryway route store with
restricted credentials, native SAI permission enforcement and real browser
acceptance remain separate release gates.

## Crash recovery, idempotency and reconciliation

A network timeout **does not** mean the provider failed to create an identity.
The provider may already have committed a WebID, ActivityPub actor, PLC DID
or signed PDS repository before the HTTP acknowledgment was lost. Entryway
therefore has a strict boundary between retrying *verification* and retrying
*creation*.

- Before the first provider account-create POST, Entryway atomically records
  `PROVIDER_CREATE_STARTED` and the irreversible
  `providerCreateMayHaveSideEffects=true` marker in its PostgreSQL route.
  The provider-create POST is issued **at most once** by this coordinator
  operation. Safe provider capability GETs retain bounded HTTP retries.
- A lost response, incomplete provider bundle or crash after that marker is
  not permission to call `/api/accounts/create` again. A stale client
  retry must inspect the persisted marker under its CAS fence and refuse a
  second provider call. If the outcome cannot be established, Entryway
  transitions into `reconciliation_required`, using
  `RECONCILIATION_REQUIRED` as the provisioning phase. This is a
  non-active, non-automatically-retryable state.
- The recovery worker uses versioned, fenced PostgreSQL updates. Incomplete
  identities or malformed legacy `updatedAt` timestamps are quarantined
  rather than repeatedly requeued. Once quarantined, the account is
  atomically excluded from the pending-recovery partial index. Active accounts
  and `awaiting_consent` routes are not unattended recovery candidates.
- When a complete provider-owned account bundle was durably recorded,
  recovery may reverify the same WebID, ActivityPub actor, and ATProto
  binding without a second create. Activation of a grant-bound account
  rechecks the current persisted Pod-owner SAI authorization; historical
  `ready` snapshots are not proof of current consent.
- The original username and idempotency reservation remain reserved
  during reconciliation. They must not be recycled simply because a
  worker failed or a client received HTTP 409.

### Operator handling of `account_reconciliation_required`

Treat HTTP 409 `account_reconciliation_required` or an account route in
`reconciliation_required` as an investigation gate, **not** a signal for
the client to retry account creation. Inspect only through an authorized
operational path; preserve the original idempotency scope, route revision,
fence and non-secret error code. Compare against the **provider-owned**
PostgreSQL signup journal and account record, exact WebID/ActivityPub actor,
did:plc mapping, signed repository head, Solid Pod ownership, and canonical
SAI consent/revocation revision where relevant. A database or provider
timeout must itself be reported as uncertain, not interpreted as absence.

Do **not** clear the Redis username/idempotency keys, reset the
`providerCreateMayHaveSideEffects` marker, change the route to `active`,
mint a replacement DID, replay the provider-create POST, or create synthetic
consent or repository readiness evidence. The existing Entryway API **does
not** provide an approved operator reconciliation/reset action. Only a
separately reviewed provider-owned reconciliation transaction with durable
identity proofs may close that gap. Existing-account migrations remain
outside this new-account flow.

### Verification baseline

The protected Fedify Sidecar Fast Checks workflow executes
`npm exec -- vitest run src/entryway/tests`, plus a separate
`ENTRYWAY_REDIS_INTEGRATION=1` suite against real Redis 8.2. It checks
CAS revisions, winner-only fences, monotonic provider-create markers,
quarantine index removal, and lost-response behavior. These checks do not
replace a deployed multiworker crash and backup/restore acceptance test
against the actual ActivityPods PostgreSQL and hosted PDS infrastructure.

## Current limits and release boundaries

The provider-owned bootstrap endpoint is implemented with local-owner and
SAI grant checks; its production authority deliberately refuses readiness
until the real signed PDS, canonical PostgreSQL and native SAI owner flows are
reviewed together. The consent URL is an **initiation link**, not a login token
or an assertion that any permission was granted. The native browser handoff,
trusted application callback, deployed cross-worker crash recovery,
PostgreSQL canonical Entryway route authority with restricted credentials,
hosted signed PDS, and
revocation-at-operation checks still need full cross-repository acceptance.
The runtime now requires the PostgreSQL route store described below. The Redis
implementation remains only for historical compatibility tests; startup has no
Redis fallback and never dual-writes route authority. Existing Redis installations
must stop signup and reconcile their reservations before switching authority.
Production signup remains source-controlled closed.

## PostgreSQL canonical route store and cutover

Apply `sql/entryway-control-plane-v1.sql` once using a migration administrator in
a dedicated database. It creates a non-login owner and a non-login runtime role.
Provision a separate login with only membership in `paper_entryway_runtime`;
never grant it ownership, direct table privileges or membership in the owner
role. The application does not run migrations. Startup verifies restricted
credentials and required function grants, failing closed when unavailable.

The runtime has only reservation, read, CAS and bounded recovery functions.
Unique database constraints enforce account, username and idempotency ownership.
All updates require the current revision and fence, preserve established identity,
and cannot clear provider-create uncertainty or unexpired proof replay evidence.
Each mutation is one database transaction. Connection loss is not retried as an
assumed rollback. Connection acquisition, locks, statements, pool size and route
payloads are bounded. Production connections verify TLS certificates; plaintext
is accepted only on loopback under explicit disposable-test configuration.

Do not point a newly empty PostgreSQL database at existing Redis signups. This
change intentionally provides no automatic migration or reset API. Freeze all
writers, inventory reservations (including uncertain outcomes), reconcile against
the provider-owned signup journal, and review a separate cutover before enabling
the new authority. Redis must not remain a parallel writer.

The `Entryway PostgreSQL authority` workflow uses real PostgreSQL 18 and separate
administrator/runtime logins. It checks concurrent reservations, CAS winners,
restricted roles, marker/replay preservation, database restart, and logical
backup/restore. Restored rows are compared exactly; a logical restore to a new
database is write-quarantined by its database OID and actual PostgreSQL cluster
system identifier. Acceptance also restores to another cluster with the same
database OID, which must still reject writes. Do not reset that
identity merely to make restore tests pass. Reconcile external provider effects
since the backup first. Physical restore and same-database point-in-time recovery
also require an external deployment fence and remain deployed acceptance gates.

Passing these repository tests is not deployed multiworker acceptance and does
not prove the hosted PDS, browser return binding, or native operation-level SAI
revocation gates. Those release fuses stay closed until their independent evidence
is available.
