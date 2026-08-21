# External ActivityPub implementation coverage

This inventory distinguishes executable federation proof from deployment research. A target is only marked covered when the CI lane runs both the native ActivityPods delivery path and the external Fedify-sidecar path, observes a durable remote follow, and (for the external path) records the successful ActivityPods signing API result.

| Target | Fixture authority | Durable proof | Status |
| --- | --- | --- | --- |
| Mastodon | `ghcr.io/mastodon/mastodon:v4.5.8` | `follows` row in Mastodon's PostgreSQL database | Executable in `activitypub-real-multi-implementation-federation.yml` |
| Akkoma | source tag `v3.18.1`, commit `792385f4ac1e258c21a3a900342c4ded14db1727` | accepted `following_relationships` row in Akkoma's PostgreSQL database | Executable in `activitypub-real-multi-implementation-federation.yml` |
| GoToSocial | `superseriousbusiness/gotosocial:0.21.3` | `follows` row in GoToSocial's SQLite database | Executable in `activitypub-real-multi-implementation-federation.yml` |
| Pixelfed | source release `v0.12.7`, commit `e33026a9e5334d2c124a7321f8b15d4329b8961f`; MySQL 8.4 LTS index digest `sha256:b3b90af2a6552ae30c266fdb7d5dd55f3afb72404bb78d37fe8a23eb857fd3fb` | `followers` row in Pixelfed's MySQL database | Executable in `activitypub-real-multi-implementation-federation.yml` |
| Bonfire Social | release `v1.0.6`, commit `53f5c428d94a84c0d442f6c842edd47d87321d88`; image digest `sha256:55084069242e4e09619081ca4f05102a8805325371003f79a5bc50d2e91dae05` | None; the pinned release cannot complete a clean database bootstrap | Externally blocked; reproducible fixture retained, not reported as federation coverage |
| Bandwagon | package commit `2ae1237360e9aaa28adc21ece59f727fdac1af75`; Emissary `v0.7.0` commit `c775bb854763f9c7dfb9a8cc966567aeee4bf7b3` | None | Externally blocked; not reported as federation coverage |

## Bonfire Social blocker

The reproducible Bonfire fixture pins release `v1.0.6` by image digest and runs
the release guide's documented `Bonfire.Common.Repo.migrate()` task before app
startup. On a clean PostgreSQL database, that exact release applies migrations
out of order and cannot reach schema readiness. The captured failures include:

- migration `20260426000000` querying the absent
  `bonfire_data_identity_character` table (`42P01`);
- migration `20260629000001` violating the
  `bonfire_data_access_control_grant_subject_id_fkey` constraint (`23503`); and
- migrations older than already-applied `20260716000001`, followed by aborted
  transactions (`25P02`).

The lane therefore cannot create a target actor or reach either delivery mode.
Treating an HTTP process or a partially migrated database as Bonfire federation
coverage would be synthetic evidence. The fixture and durable-follow query stay
in-tree so the lane can be restored when upstream publishes a clean-bootstrap
release or a supported migration repair.

Evidence:

- upstream deployment procedure: <https://github.com/bonfire-networks/bonfire-app/blob/53f5c428d94a84c0d442f6c842edd47d87321d88/docs/DEPLOY.md>
- exact failed fixture job: <https://github.com/outlaw-dame/mastopod-federation-architecture/actions/runs/32443884717/job/96659747504>
- reproducible bootstrap: [`bootstrap-bonfire-account.sh`](./scripts/bootstrap-bonfire-account.sh)
- pinned fixture: [`docker-compose.bonfire.yml`](./docker-compose.bonfire.yml)

## Bandwagon blocker

Bandwagon is not a standalone federation server. Its upstream README says that Emissary must be installed first and that Bandwagon is then installed by opening Emissary's setup console and adding a Git adapter under **Server Settings > Packages**. At the pinned package commit, upstream provides no tagged Bandwagon release, container, noninteractive package-install command, or machine-readable completion check for that setup-console operation.

Running plain Emissary would only prove Emissary federation and must not be labeled a Bandwagon result. A reproducible Bandwagon lane therefore remains blocked until one of these is available and pinned:

1. an upstream-supported noninteractive package installation/bootstrap command plus a deterministic target actor; or
2. a versioned Bandwagon server image/fixture with a documented durable follower query.

Evidence:

- Bandwagon package instructions: <https://github.com/EmissarySocial/bandwagon/blob/2ae1237360e9aaa28adc21ece59f727fdac1af75/README.md#build-with-emissary>
- Emissary federation behavior (which is not by itself Bandwagon coverage): <https://github.com/EmissarySocial/emissary/blob/c775bb854763f9c7dfb9a8cc966567aeee4bf7b3/FEDERATION.md#activitypub>

## Pixelfed database pin

Pixelfed v0.12.7's upstream compose file names the mutable `mysql:9` tag. The
current image rejects Laravel Pulse's `unhex(md5(key))` generated column during
Pixelfed's own migrations. The proof lane therefore pins MySQL 8.4 LTS by OCI
index digest. This is a deployment compatibility correction, not a change to
Pixelfed or its federation behavior.
