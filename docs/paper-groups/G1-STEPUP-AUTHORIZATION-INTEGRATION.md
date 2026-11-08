# G1 Solid-OIDC / SAI consent and Group reservation step-up: implementation handoff

Status: **draft, off by default, unmerged**, as of 2026-11-08. Source: [ActivityPods PR #117](https://github.com/outlaw-dame/activity-pods/pull/117). This is provider-owned capability; Paper is only one possible authorized ActivityPods application.

## Architectural correction: isolated Group-only credentials

The normal Solid-OIDC ID token remains **unchanged**. In this ActivityPods version ID tokens can live up to one year and are accepted as application identity by the general gateway. Adding `cnf.jkt` and `auth_time` to that general token, or signing an otherwise unrestricted new ID token, would risk token-type confusion or backwards-compatibility regressions.

Instead, a dedicated provider service issues a **five-minute, scope-limited Group reservation JWT signed by a separate HS256 secret** (`PROVIDER_COLLECTIVES_STEPUP_SECRET`). The standard `jwk.verifyToken` ES256 verifier does **not** accept it. The Group-specific verifier requires exact purpose `apods:collective-reservation-stepup:v1`, operation `reserve`, issuer, audience, `sub == webid`, app `azp`, recent actual WebAuthn `auth_time`, method `webauthn`, and a DPoP key thumbprint `cnf.jkt`.

The separate Group reservation endpoint deliberately does not use generic gateway authorization; it verifies the isolated credential and its DPoP proof itself, then has the provider-authoritative reservation service independently recheck current SAI permissions before writing to Fuseki.

## Required browser experience

Because WebAuthn checks **the relying party ID and browser origin**, a Paper browser hosted on a different domain must not attempt to pretend its own `navigator.credentials.get()` assertion originated on the provider's domain. The passkey ceremony should occur in the **provider-controlled authentication origin**, normally as a secure popup or redirect, then return the Group-only credential to the authorized client through a strict-origin messaging or equivalent OAuth-style result channel. Never post bearer credentials using `targetOrigin='*'`.

An existing authenticated app user's Solid ID token is used solely to establish the applicant WebID and app client ID before the step-up; the app's Group DPoP keypair remains under app control. The provider-controlled step-up page must securely coordinate signing the DPoP proof with that key, or use a cryptographically bound, single-use challenge/exchange if the keys cannot be shared. **This provider popup/client orchestration is NOT yet implemented; do not claim browser UX/E2E completed.**

The existing ActivityPods `/auth/passkeys/authentication/options` endpoint issues a signed WebAuthn challenge and ticket. The new `passkeys-api.verifyAssertion` internal action runs the exact existing WebAuthn signature, origin, RP ID, user-verification and counter checks but returns **only** the verified WebID (not a general account bearer token).

## Protocol flow

1. Sign into ActivityPods through the existing Solid-OIDC client flow. The application presents the current ActivityPods consent sheet, with requested `apods:CreateGroup` and (if needed) `apods:ReadGroups`. A Group-only grant is **not a personal Pod read/write grant**. The provider also maintains an explicit approved-app allowlist.
2. Obtain existing passkey authentication options and signed ticket at `POST /auth/passkeys/authentication/options` **on the proper WebAuthn origin**. Complete the browser passkey request using `navigator.credentials.get()`.
3. Build an ES256 DPoP JWT (`typ: dpop+jwt`) signed by the app-bound key, with `htm=POST`, `htu=https://PROVIDER/api/collectives/stepup/verify`, `iat`, unique `jti`, and `ath=base64url(SHA256(ordinary Solid ID token bytes))`.
4. `POST /api/collectives/stepup/verify` with `Authorization: Bearer <existing Solid ID token>`, `DPoP: <signed proof>`, JSON `{ "ticket": "<WebAuthn ticket>", "response": { ...WebAuthn assertion... } }`. Provider verifies the signed ID token's subject and app, account status, **current SAI app registration and CreateGroup grant**, replay-fenced DPoP, one-time WebAuthn ticket, actual passkey assertion and exact WebID match; rechecks current SAI after signature verification. Uses a Redis fixed-window rate limit (eight attempts/minute per app+person). No long-lived ID token is accepted directly by Group reservation.
5. On success the provider returns `{ "token": "<Group-only JWT>", "tokenType": "DPoP", "expiresIn": 300 }` with no-store headers and browser CORS restricted to approved origins.
6. Create a **fresh** DPoP JWS for `htu=https://PROVIDER/api/collectives/reserve` with `ath=SHA256(the new Group-only JWT)` and a new `jti`.
7. `POST /api/collectives/reserve` with `Authorization: DPoP <Group-only JWT>`, `DPoP: <new proof>`, `Idempotency-Key: <24–128 URL-safe random characters>`, and JSON `{ "displayName": "<group name>" }`. Returns HTTP **202**, a durable **reserved** Group ID and URI only. No AP signer, AT DID or public actor exists yet.
8. For revocation, remove the app via ActivityPods `auth-agent.removeApp` or revoke `apods:CreateGroup` in the provider. New step-ups are denied and any still-valid five-minute Group token is blocked at reservation by the **live SAI access check**. A concurrency race between consent deletion and reservation write still requires a provider-policy revision fence before subsequent active provisioning.

## Configuration

All three switches are required: `PROVIDER_COLLECTIVES_RESERVATIONS_ENABLED=true`, `PROVIDER_COLLECTIVES_API_ENABLED=true`, and `PROVIDER_COLLECTIVES_STEPUP_ENABLED=true`. Defaults are **false**.

- `PROVIDER_COLLECTIVES_APPROVED_APPS`: comma-separated **exact HTTPS app URIs** for provider policy.
- `PROVIDER_COLLECTIVES_ALLOWED_ORIGINS`: comma-separated **HTTPS browser origins** permitted by route CORS; provider origin always included by default. No wildcard or credentials mode.
- `PROVIDER_COLLECTIVES_STEPUP_SECRET`: separate strong secret (min 32 UTF-8 bytes), not the Solid-OIDC ES256 key, not the general auth JWT key.
- `PROVIDER_COLLECTIVES_GRANT_SECRET`: distinct provider-internal reservation operation HMAC secret.
- `PROVIDER_COLLECTIVES_ID_KEY`: **stable and backed up** opaque group identifier derivation key.
- `PROVIDER_COLLECTIVES_WORKER_SECRET`: separate provider-worker credential signing key.
- `SEMAPPS_HOME_URL`: exact canonical HTTPS provider origin.
- Existing `WEBAUTHN_ORIGIN`, `WEBAUTHN_RP_ID`, `WEBAUTHN_TICKET_SECRET` and Redis configuration must match the provider-controlled WebAuthn ceremony.

Use independent secrets; do not commit them, log them, or include real user tokens in CI artifacts.

## Verification and remaining acceptance gates

Automated tests validate:
- Real ES256 signed ordinary Solid JWTs and actual DPoP signatures and JWK thumbprints.
- Actual WebAuthn P-256 authenticator signature, RP ID, user-verification flags and counter replay behavior.
- Separate Group-only HS256 signing/verification; rejection as a standard ES256 Solid ID token.
- Valid and invalid SAI registration/rights, revocation while verifying WebAuthn, app/user mismatch, ticket/JTI replays.
- Running Moleculer-Web HTTP route with signed token → consent check → Group step-up → reservation → denied after revocation, **using test doubles for SAI storage, WebAuthn hardware and reservation state**.
- Real isolated Fuseki/TDB2 durable identity and lease-fencing recovery, and actual Redis concurrent token/ticket/nonce/replay operations.

**NOT YET VERIFIED**: an actual configured ActivityPods user completing the consent sheet in a browser against the full running provider, real provider-side SAI RDF resource persistence, passkey ceremony on the configured provider web origin, cross-origin popup messaging back to Paper, concurrent revocation-vs-reservation transaction fencing, and deployed readiness. Keep the three feature flags **off** and PR #117 **draft** until an end-to-end test runs these checks with an isolated staging provider. Do not confuse this limited identity reservation step with full G1 Group provisioning, signing or federation.
