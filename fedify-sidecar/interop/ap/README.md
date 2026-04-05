# AP Interop Harness

This harness gives us a local, dockerized ActivityPub interoperability target set without pushing traffic onto the public internet. It is designed to prove the real trust boundary we care about:

1. ActivityPods remains the only signer.
2. The sidecar serves the public actor document and inbox routes.
3. A representative remote server accepts the outbound `Follow`.
4. The remote server sends an `Accept` back to the sidecar inbox.
5. The proof runner confirms that `Accept` landed in the sidecar inbound stream.

## Scope

The harness includes:

- `mock-activitypods`: a minimal internal ActivityPods authority surface for:
  - `GET /api/internal/actors/:identifier`
  - `POST /api/internal/signatures/batch`
- `fedify-sidecar`: the real sidecar build from this repo
- `redis` and `redpanda`
- `ap-proxy`: internal TLS termination for `sidecar`, `gotosocial`, and optional `mastodon`
- `gotosocial-app`: lightweight reference ActivityPub implementation
- `mastodon-*`: optional heavier reference profile
- `ap-interop-proof`: a proof runner that posts a `Follow` through `/webhook/outbox` and waits for the remote `Accept`

## Why The Proof Uses `Follow`

`Follow` is the cleanest AP round-trip for interop proofing:

- it exercises outbound HTTP Signatures
- it forces the remote server to fetch our actor document and public key
- it causes a real federated reply (`Accept`) that comes back through our inbox path

That is a stronger proof than a bare `2xx` on the outbound POST.

## TLS Model

The sidecar currently requires HTTPS federation targets, and that is correct for production. To keep the harness honest without weakening those safety checks, we terminate internal TLS with `ap-proxy` and issue a local CA plus leaf certs for these internal hostnames:

- `sidecar`
- `gotosocial`
- `mastodon`

The generated root CA is mounted into the sidecar, GoToSocial, Mastodon, and the proof runner so they can trust those certificates during local federation.

## Setup

For the fastest repeatable GoToSocial proof, use the one-command runner:

```sh
bash ./fedify-sidecar/interop/ap/scripts/run-gotosocial-proof.sh
```

That script:

- rebuilds the local harness images by default so the proof runs against current source
- generates local certs if needed
- starts the shared harness stack
- stops the heavier Mastodon web/Sidekiq services first so the GoToSocial run keeps its memory footprint small
- creates or reuses the GoToSocial interop account
- confirms, enables, and unlocks the account for federation proofing
- clears only the harness `ap:*` Redis keys before proofing so warm reruns do not inherit stale queue state
- runs the end-to-end proof

If you want the individual steps, they are:

1. Generate the local CA and leaf certs:

```sh
bash ./fedify-sidecar/interop/ap/scripts/generate-certs.sh
```

2. Start the common stack plus GoToSocial:

```sh
docker compose -f fedify-sidecar/interop/ap/docker-compose.ap-interop.yml up -d \
  redis redpanda mock-activitypods fedify-sidecar gotosocial-app ap-proxy
```

3. Create the GoToSocial test account:

```sh
bash ./fedify-sidecar/interop/ap/scripts/bootstrap-gotosocial-account.sh
```

The GoToSocial bootstrap is intentionally idempotent. It uses the official admin CLI for create/confirm/enable, then reconciles the local profile flags the CLI does not currently expose (`locked`, `discoverable`, `indexable`) directly in the harness SQLite DB so the proof account is always follower-open and discoverable.

4. Run the proof:

```sh
docker compose -f fedify-sidecar/interop/ap/docker-compose.ap-interop.yml \
  --profile proof run --rm ap-interop-proof
```

The default proof target is `gotosocial`. Override it with `AP_INTEROP_TARGET=mastodon` when the Mastodon profile is running.

## Optional Mastodon Profile

Mastodon is heavier, so it is behind the `mastodon` profile.

For the fastest repeatable Mastodon proof, use:

```sh
bash ./fedify-sidecar/interop/ap/scripts/run-mastodon-proof.sh
```

Both one-command runners rebuild the local harness images by default so the proof always uses current source. Set `AP_INTEROP_SKIP_BUILD=1` when you intentionally want a warm-image loop.
The profile-specific runners also stop the other server’s heavyweight services before proofing so local Docker memory is spent on the target under test.

For the full local smoke lane, use:

```sh
npm --prefix fedify-sidecar run smoke:interop:ap
```

That lane runs sidecar typecheck, the Redis consumer-group recovery regression, and then the GoToSocial and Mastodon one-command proofs back-to-back.

For a lighter fast-feedback lane, use:

```sh
npm --prefix fedify-sidecar run check:fast
```

That fast lane runs sidecar typecheck plus a focused Vitest slice for queue recovery, bridge/runtime behavior, and ActivityPub signing compatibility without bringing up the Docker interop stack.

1. Generate the local Mastodon env file:

```sh
bash ./fedify-sidecar/interop/ap/scripts/prepare-mastodon-env.sh
```

The generated env file now includes the three Active Record encryption secrets required by current Mastodon builds, in addition to `SECRET_KEY_BASE`, `OTP_SECRET`, and the VAPID keys.

2. Start the Mastodon profile:

```sh
set -a
. ./fedify-sidecar/interop/ap/runtime/mastodon.env
set +a
docker compose \
  -f fedify-sidecar/interop/ap/docker-compose.ap-interop.yml \
  --profile mastodon up -d mastodon-db mastodon-redis mastodon-web-app mastodon-sidekiq ap-proxy
```

3. Create the Mastodon test account:

```sh
AP_INTEROP_MASTODON_ENV_FILE=./fedify-sidecar/interop/ap/runtime/mastodon.env \
  bash ./fedify-sidecar/interop/ap/scripts/bootstrap-mastodon-account.sh
```

4. Run the proof against Mastodon:

```sh
set -a
. ./fedify-sidecar/interop/ap/runtime/mastodon.env
set +a
AP_INTEROP_TARGET=mastodon docker compose \
  -f fedify-sidecar/interop/ap/docker-compose.ap-interop.yml \
  --profile proof run --rm ap-interop-proof
```

## What The Proof Verifies

The proof runner:

1. Resolves the target account through WebFinger.
2. Fetches the remote actor document and inbox/sharedInbox endpoints.
3. Posts a signed `Follow` through the sidecar webhook.
4. Polls the Redis inbound stream for a matching `Accept` from the remote actor.

Success output includes:

- target account
- remote actor URI
- follow activity ID
- inbound stream message ID for the returning `Accept`

## Important Notes

- The mock authority is intentionally tiny. It exists only to preserve the real ActivityPods trust boundary for signing and actor metadata during local interop proofing.
- The harness is local-only. The generated CA and any runtime data under `fedify-sidecar/interop/ap/runtime/` are git-ignored.
- The repo now includes `.github/workflows/fedify-sidecar-fast-checks.yml` for quick PR feedback and `.github/workflows/ap-interop-smoke.yml` for the full dockerized interop lane. The interop workflow uploads Compose logs on failure.
- The one-command runners reset only the interop Redis keys under the `ap:*` prefix before each proof. That keeps runs repeatable without a blanket `FLUSHALL`.
- The Mastodon profile uses current official image/tag conventions from the upstream Mastodon repository and sample env files. GoToSocial config keys were aligned to the current official documentation for general, database, storage, and reverse-proxy configuration.
- Shared inbox requests are exercised through Fedify, but per-actor inboxes intentionally stay on the sidecar-native verifier in this architecture. That keeps ActivityPods as the only signing authority and avoids forwarding or duplicating private actor keys into Fedify.
- The sidecar queue runtime now recreates missing Redis consumer groups after a Redis reset. That makes the harness recover cleanly from `FLUSHALL` or empty-volume cold starts instead of livelocking on `NOGROUP`.
- GoToSocial currently exposes some local-account flags only at the database layer, so the harness uses the official admin CLI for account creation and then reconciles `locked`, `discoverable`, and `indexable` directly in SQLite. Current Mastodon, by contrast, requires the Active Record encryption secrets to be present before `db:prepare` or account bootstrap will succeed.
- Mastodon also needs the local interop account to be explicitly approved before the actor URL published by WebFinger starts resolving. The bootstrap script now performs that approval step automatically with `tootctl accounts modify <user> --approve`.
- Mastodon blocks dereferencing private-network actor and key URLs by default. The harness enables `ALLOWED_PRIVATE_ADDRESSES=172.31.240.0/24` for the Mastodon web and Sidekiq services so Mastodon can resolve the sidecar-hosted actor document and public key during local signature verification.
- The Mastodon profile is intentionally tuned below upstream defaults for local proofing: `WEB_CONCURRENCY=0`, `MAX_THREADS=2`, `SIDEKIQ_CONCURRENCY=1`, `DB_POOL=2`, and `RUBY_YJIT_ENABLE=0`. The web service also uses the harness-specific `fedify-sidecar/interop/ap/mastodon/puma.local.rb` instead of Mastodon’s stock preloading Puma config. That keeps the harness stable on workstation-class Docker memory limits and avoids mistaking an OOM-killed Puma or Sidekiq process for a federation regression.
