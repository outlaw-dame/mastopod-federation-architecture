# App-Delegated Account Provisioning

## Purpose

Approved applications must be able to start account creation without requiring a
user to visit the Pod provider UI directly. For example, Alice should be able to
open Memory, choose a provider that supports this architecture, and create the
underlying ActivityPods account, Pod, ActivityPub actor, WebID, and optional
ATProto identity from Memory.

This is an onboarding capability, not a transfer of authority. The provider
still owns account issuance, identity creation, pod storage, signing-key custody,
policy checks, and user verification.

## Ground Rules

- The provider remains the authority for account lifecycle, Pod data, WebID,
  ActivityPub actor state, and private keys.
- Apps can initiate provisioning only when they are approved by the provider and
  authorized for `provider.account.provisioning`.
- User verification is mandatory. The app can host the UX, but the provider must
  verify the human through an approved mechanism such as email, passkey, magic
  link, phone, invite, or provider policy.
- Apps must never receive provider admin credentials, raw private signing keys,
  ATProto rotation keys, or broad internal bearer tokens.
- App-mediated signup must create the same canonical account shape as
  provider-mediated signup. There must not be a "Memory account" that later has
  to be reconciled with a "real provider account."
- Protocol-specific provisioning is feature-gated. AP-only providers can still
  support app-mediated signup; dual-protocol providers can additionally provision
  ATProto identity and repository state.

## Capability Discovery

Providers advertise support through:

```http
GET /.well-known/provider-capabilities
```

The relevant capability is:

```json
{
  "id": "provider.account.provisioning",
  "version": "1.0.0",
  "status": "enabled",
  "dependencies": [],
  "limits": {
    "approvedAppsRequired": true,
    "requiresUserVerification": true,
    "maxAccountsPerAppPerDay": 250,
    "supportedProtocolSet": "solid,activitypub,atproto"
  }
}
```

Apps must treat this endpoint as the source of truth. They must not infer signup
support from `/api/accounts/create`, ATProto XRPC routes, or provider UI routes.

## Approval Model

An app must have a provider-approved registration before it can provision
accounts. The registration should bind:

- app actor / client identifier
- app backend origin and redirect URIs
- terms and privacy policy URIs
- requested access needs and special rights
- allowed protocol set for new accounts
- rate limits, abuse thresholds, and optional invite policy
- whether the app can request ATProto provisioning during signup

This extends ActivityPods' existing application-registration model, where apps
declare OIDC metadata, access needs, shape trees, and special rights. The new
capability is provider-level account lifecycle authority and should not be
granted through normal user WAC permissions alone.

## Public Flow

1. Memory discovers provider capabilities.
2. Memory checks that `provider.account.provisioning` is enabled.
3. Memory starts signup with the provider using its approved app identity and an
   idempotency key.
4. The provider verifies the app registration, origin, redirect URI, capability,
   rate limits, and requested protocol set.
5. The provider verifies Alice through the configured human-verification path.
6. The provider reserves the username, WebID URI, ActivityPub actor URI, and
   optional ATProto handle.
7. ActivityPods creates the canonical account, Pod storage, WebID, actor,
   containers/type-index registrations, WAC baseline, inbox/outbox, and keys.
8. If ATProto is requested and enabled, the provider provisions DID, handle,
   commit key, rotation key, repository state, XRPC session surface, and firehose
   identity/account events.
9. The provider creates the app authorization grant for Memory based on its
   approved access needs and Alice's consent.
10. Memory receives a normal app session or OIDC result, plus public identity
    metadata. It does not receive internal credentials.

## Suggested Public API Shape

The current proof path uses `/api/accounts/create`. This can remain the public
entry point if it is capability-gated and app-aware.

```http
POST /api/accounts/create
Idempotency-Key: <stable app-generated key>
Authorization: <app client assertion or provider-approved signup token>
Content-Type: application/json
```

```json
{
  "appClientId": "https://memory.example/app",
  "username": "alice",
  "email": "alice@example.com",
  "verification": {
    "method": "email",
    "challengeToken": "opaque-provider-token"
  },
  "profile": {
    "displayName": "Alice",
    "summary": "Optional profile text"
  },
  "protocols": {
    "solid": true,
    "activitypub": true,
    "atproto": {
      "enabled": true,
      "didMethod": "did:plc",
      "handle": "alice.pods.example"
    }
  },
  "acceptedTermsVersion": "2026-05-01"
}
```

Success response:

```json
{
  "canonicalAccountId": "acct:<stable-provider-subject>",
  "webId": "https://pods.example/alice/profile/card#me",
  "activityPubActorUri": "https://pods.example/alice",
  "atproto": {
    "enabled": true,
    "did": "did:plc:...",
    "handle": "alice.pods.example",
    "repoInitialized": true
  },
  "authorization": {
    "type": "oidc",
    "next": "redirect"
  }
}
```

The response must not include private keys, provider admin tokens, raw internal
API bearer tokens, or unrestricted refresh credentials for other apps.

## Internal Flow

App-mediated signup calls the same provider orchestration used by direct
provider signup:

- create stable `canonicalAccountId`
- create current `webId`
- create current `activityPubActorUri`
- create Pod storage and default containers
- generate ActivityPub signing key inside ActivityPods
- persist `IdentityBinding`
- provision ATProto only when enabled and requested
- emit identity/account events
- warm sidecar runtime projections

The existing internal AT endpoint remains internal-only:

```http
POST /api/internal/atproto/provision
```

Apps must not call this route. Public signup calls the provider account
orchestrator, and the provider account orchestrator calls internal AT
provisioning when policy allows it.

## Multi-Identity Result

A successfully provisioned account may have all of these identifiers:

- stable internal account subject: `canonicalAccountId`
- current Solid/WebID URI: `webId`
- current ActivityPub actor URI: `activityPubActorUri`
- ATProto DID: `atprotoDid`
- ATProto handle: `atprotoHandle`
- app authorization grant for Memory

The stable internal subject must not be permanently defined as the WebID URI.
Provider-owned WebIDs can change during provider migration. The current WebID is
an externally visible identifier attached to the account; it is not the only
identity.

## Provider Migration Compatibility

When a user creates or imports an account at a new provider that supports this
architecture, the target provider must prepare every identity surface it claims
to support:

- Solid storage and WebID profile
- ActivityPub actor, inbox, outbox, collections, and signing key
- app registrations and grants for approved apps such as Memory
- ATProto DID/PDS/repo/handle only if ATProto is enabled
- verified predecessor links from old WebID/actor/DID where available

ATProto migration can preserve the DID when using `did:plc`. Solid/WebID and
ActivityPub actor continuity depends on URI control. If the old provider owns
the URI, the migration must use verified successor identifiers rather than
pretending the URI is unchanged.

## Failure Modes

- `feature_disabled`: provider does not offer app-mediated provisioning.
- `unauthorized_app`: app is not approved for account provisioning.
- `user_verification_required`: Alice has not completed provider verification.
- `protocol_disabled`: requested protocol is disabled by provider policy.
- `handle_unavailable`: username or ATProto handle reservation failed.
- `provisioning_partial`: Solid/AP account exists but optional ATProto
  provisioning failed; response must clearly mark AT disabled or pending.
- `identity_conflict`: requested WebID, actor URI, DID, or handle is already
  bound to another canonical account.

## Acceptance Criteria

1. Memory can discover whether a provider supports app-mediated account
   provisioning.
2. An unapproved app cannot create accounts even if it knows the signup route.
3. A verified user can create a Solid + ActivityPub account without visiting the
   provider dashboard.
4. On a dual-protocol provider, the same flow can provision ATProto without
   exposing AT private keys to the app.
5. The created account has one canonical account subject and all protocol
   identities are bound to it.
6. The same orchestration is used for provider UI signup and app-mediated signup.
7. Migration/import into a new provider uses the same binding model and does not
   assume provider-owned WebID URLs are immutable.

## References

- ActivityPods application registration:
  https://docs.activitypods.org/app-framework/backend/application-registration/
- ActivityPods account creation guide:
  https://docs.activitypods.org/guides/create-your-first-social-app/
- ActivityPods authorization and capabilities:
  https://docs.activitypods.org/architecture/authorization/
- ATProto account creation:
  https://docs.bsky.app/docs/api/com-atproto-server-create-account
- ATProto account migration:
  https://atproto.com/guides/account-migration
