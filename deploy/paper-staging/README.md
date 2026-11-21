# Paper unified-account staging review

**Release CLOSED. Review package, not production readiness.** This first deployment
phase exercises the merged canonical Entryway PostgreSQL implementation with real
TLS and a restricted login. It does not deploy a working provider/PDS signup flow.
Do not substitute fixture attestations to make the remaining phases pass.

## Prepare and inspect

Requirements: Python 3.9+, Git, OpenSSL, Docker Engine with Compose v2+, and enough
disk for a Node dependency image. Preparation itself needs no daemon or cloud
credentials. The pinned federation commit must exist in this checkout.

```sh
python3 deploy/paper-staging/prepare.py /absolute/new/private/paper-staging
docker compose -f /absolute/new/private/paper-staging/compose.json --profile acceptance config --quiet
```

The parent directory must exist; the destination must not. Preparation never
overwrites credentials or reuses a volume. Each bundle gets a unique Compose project.
`PREPARED` is written last; an incomplete directory must not be deployed. Do not
commit, upload, email, or publish the generated directory: it contains secrets.
The CA private key is outside every container mount. Certificates expire after
seven days. Prepare a fresh disposable bundle for a later rehearsal; do not
silently replace credentials under an existing database.

`lock.json` pins both approved repository baselines and multi-platform image
digests. Only federation code is built in this phase, using `npm ci` and the pinned
lockfile. Package lifecycle scripts are disabled. Updating pins is a reviewed
change followed by a new acceptance run. The current ActivityPods pin is merged PR #252 at `ab7c486488a8d926bc9fade8ac32f9e9af270435`.
It includes the prior merged navigation, signed PLC readback and incomplete-enrollment
fencing fixes, plus disposable browser enrollment, owner activation, independent
native SAI permissions, current-grant OIDC admission and signed provider genesis.
Exact PR-head CI on `3db561b56e8be9759b591afaecd73a2b7a545468` passed all 12 workflows
before merge. CI fetches the merge commit from **this single lock file**, not
from a second source pin. This staging profile still runs `NODE_ENV=production`,
so all new-account release fuses remain enforced. A green negative-gate smoke
is not proof of positive signup or PDS readiness.

## Execute only after reviewing the bundle

```sh
docker compose -f /absolute/new/private/paper-staging/compose.json --profile acceptance build acceptance
docker compose -f /absolute/new/private/paper-staging/compose.json up -d --wait --wait-timeout 120 postgres
docker compose -f /absolute/new/private/paper-staging/compose.json --profile acceptance run --rm acceptance
docker compose -f /absolute/new/private/paper-staging/compose.json restart postgres
docker compose -f /absolute/new/private/paper-staging/compose.json up -d --wait --wait-timeout 120 postgres
docker compose -f /absolute/new/private/paper-staging/compose.json --profile acceptance run --rm acceptance
```

The database has no published ports and only an isolated internal network. The
administrator is socket-only inside the container; runtime TCP access requires
TLS and SCRAM. Initial schema migration runs once on a new volume. The application
login inherits only `paper_entryway_runtime`. No restore fence is reset, no existing
Redis data is imported, and no unknown mutation outcome is retried. Startup and
queries have bounded waits. Container restarts are operator controlled.

The runner checks production connection options, verified TLS, runtime-role
readiness, denied direct reads, denied owner escalation, and rejected plaintext.
The existing `Entryway PostgreSQL authority` workflow separately covers concurrent
reservations, CAS, restart evidence and logical-restore quarantine. A TLS smoke
pass does not replace that evidence or prove deployed multiworker recovery.

Stop without deleting data using `docker compose -f .../compose.json down`.
Only for this disposable rehearsal, `down --volumes` removes its database. Never
point this package at production data or copy production secrets into it.

## Provider/PDS deployment specification for the next phase

### Local provider browser profile

The optional `provider` profile builds the actual pinned ActivityPods backend and
frontend. It adds Redis, Fuseki and explicit HTTPS ingress on **127.0.0.1:8443**.
It tests actual provider configuration/UI delivery and the **closed** unified-signup
response, not successful new-account creation. PR #252's positive browser/consent,
PostgreSQL activation and signed provider genesis proofs ran only in its separately
gated disposable environment, **not in this deployment-equivalent profile**. The
staging PostgreSQL foundation and provider account-completion services remain
unconnected; no disposable identity bypass is enabled here.

```sh
python3 deploy/paper-staging/prepare.py /absolute/new/private/paper-provider \
  --activitypods-checkout /absolute/activity-pods-checkout
docker compose -f /absolute/new/private/paper-provider/compose.json --profile provider config --quiet
docker compose -f /absolute/new/private/paper-provider/compose.json --profile provider build provider frontend
docker compose -f /absolute/new/private/paper-provider/compose.json --profile provider up -d postgres ingress
docker compose -f /absolute/new/private/paper-provider/compose.json exec -T provider node /staging/provider-probe.mjs
```

Resolve `provider.paper.example.org` and `login.paper.example.org` to `127.0.0.1` on the local
browser host. Trust this bundle's `certificates/ca.crt` only in a disposable browser
profile; do not disable certificate validation globally or install the private CA
key. Then visit `https://login.paper.example.org:8443/login`. Generated secrets are read
at startup; they are not baked into images or expanded into Compose configuration.
The backend reads its private secret file before dropping to UID/GID 1000.
JWT keys, provider state, uploads, Redis and Fuseki have dedicated volumes.
The `local-provider` CI job also restarts the Redis, Fuseki and provider
containers without replacing their volumes or credentials. It repeats
CA-verified discovery, JWKS, UI and signup-denial probes after restart and
compares a canonical SHA-256 fingerprint of the **public** OIDC signing keys.
Key continuity alone is not evidence of signing-key custody under an
independent production HSM or of completed account/ATProto recovery.
A separate optional `storage-proof` profile now creates a physically independent
protected Jena/Fuseki TDB2 service with an owner-private Shiro policy and volume.
The ordinary provider receives **none** of its provisioner, projector or attestor
credentials. The disposable proof container, separately mounted with those
credentials, creates one protected dataset and verifies that ordinary provider
credentials cannot read, update or administrate it; the independent reader can
query and not mutate, and only the projector can write. The proof is repeated
after protected-Fuseki restart to establish durable isolation. The proof service
is a restricted **rehearsal**, not the production canonical consent/identity store:
no signup or SAI projection has been connected to it, and protected-storage
release gates remain disabled.

These names are under the reserved documentation domain `example.org`; this is
local-only naming, not evidence of public domain ownership or resolvable ATProto
handles. Production URL syntax checks and all signup release fuses remain intact.

The profile does not provide email delivery, app-server transaction binding or
a hosted PDS. Its negative signup check must remain a separate result from future
positive signup acceptance. Keep enough local disk space for Node build layers and
data; do not prune unrelated Docker resources to make room. Bounded diagnostics:

```sh
python3 deploy/paper-staging/diagnose.py /absolute/new/private/paper-provider
```

Use a dedicated disposable host/project and HTTPS names for provider API, provider
frontend, PDS, and an ActivityPods app. Paper/Memory remain apps: the provider owns
identity creation, signing and consent. Frontend-to-provider login/consent must use
real Solid-OIDC/DPoP sessions and server-bound signup transactions. Entryway's bearer
token and provisioning requests remain backend-only, never browser credentials.

Only the HTTPS ingress may publish a port. Route app/provider/PDS hosts explicitly;
do not publish PostgreSQL, Redis, Fuseki, admin endpoints or Docker's socket. Use
separate named volumes, per-service secrets and immutable built images. Keep the
Entryway runtime role separate from the migration role. The provider owns its
existing Redis/Fuseki storage; PostgreSQL alone owns Entryway routes. This package
does not change that boundary. Media/search workers are outside this signup gate.

The following are required before enabling successful provider/PDS signup:

| Gate | Required evidence | Current status |
| --- | --- | --- |
| Provider completion | Genuine signed PDS, Solid and current SAI evidence committed to the same canonical operation; uncertain creates reconcile without replay | Disposable local PR #252 proof passed; production pathway still blocked by `ACCOUNT_COMPLETION_ATTESTATION_PENDING` |
| Signed hosted PDS | Actual HTTPS DID/handle/key/repository checks, native writes, key persistence and restart | Disposable signed genesis/readback passed; hosted production PDS, native writes, restart and release gate still unverified |
| App transaction | Authenticated app-server session, expiry, single-use state, exact callback and owner binding; concurrent tab and replay tests | Local Chromium callback/PKCE proved in PR #252; staged independent app-server transaction and concurrent tab/replay acceptance still pending |
| Consent/revocation | Real browser owner consent; required/optional grants; operation-time denial after revocation | Local real-Jena / OIDC session admission regression checks passed; staging browser and refresh-token lifecycle proof still pending |
| Multiworker failure | Two deployed workers; kill before/after provider create, lost acknowledgement, restart and replay; exactly one identity/route | Local PostgreSQL/two-worker consent races passed; deployed kill/recovery/restore and exactly-one-identity acceptance still pending |
| Cutover and restore | Frozen Redis reconciliation, database ownership inspection, TLS, backup/restore, external physical/PITR write epoch fence | Logical restore CI exists; external restore fence remains open |

Do not add fake successful health endpoints for these gates or remove release
constants. Record repository SHA, built image digest, environment identifier,
scenario, timestamp and sanitized result for each run. Keep raw tokens, passwords,
proofs, browser storage and signing keys out of logs/artifacts. Any failed or absent
scenario keeps release CLOSED. No provider/PDS deployment is authorized by the
database smoke passing alone.
