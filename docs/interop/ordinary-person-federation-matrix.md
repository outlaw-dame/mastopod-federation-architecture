# Ordinary ActivityPub Person interoperability — target acceptance

**Status: source review / live tests pending, 2026-11-12.** This track is separate from
Paper Groups, from FEP-1b12 Group moderation, and from the currently
unresolved Friendica fixture. ActivityPods' canonical WebID is the `Person`
actor ID. Fedify may deliver signed server-to-server HTTP requests but MUST
NOT become a separate authorization or account store.

## What counts as tested

An external software target passes **only** after two independent paths are
run against a fresh, disposable local user on a pinned version:

1. In native ActivityPods delivery mode, dereference remote `Person` actor,
   POST a signed `Follow` to its advertised inbox, observe durable remote
   following/follower record for the **exact ActivityPods actor URI**, then
   observe matching `Accept(Follow)` where its local privacy policy allows.
2. Reset both fixtures; in external Fedify delivery mode, repeat the same
   proof and verify the actual ActivityPods signing API call, committed
   remote follower and `Accept` processing.
3. Send public `Create(Note)` and `Create(Article)` where each platform
   documents support; prove the remote post and authorship, reply/reaction
   when implemented; `Undo(Follow)` clears the exact follower relation.
4. Run hostile cases: spoofed `actor`/signing key, wrong-origin Activity
   ID, missing/invalid signature, duplicated Activity ID, allow/block list,
   429/503 bounded backoff and restart. Nothing writes into an unrelated
   public instance. Private/limited interactions require direct authorized
   recipients (never host-wide fanout).
5. Record the exact source/image digest, CI run/job, actor type, transport,
   verified remote state and known unsupported types; do not promote an
   HTTP 200/202 receipt, successful cURL, or passing synthetic parser to
   accepted federation.

The previously verified real matrix covers Mastodon, GoToSocial, Akkoma,
Pixelfed, Misskey, Castopod for native+Fedify **ordinary Follow**.
Friendica remains deferred because its real fixture still has a native URLVerifier rejection and no persisted Follow. It is intentionally excluded from the mandatory real multi-implementation CI matrix; the dedicated [PR153](https://github.com/outlaw-dame/mastopod-federation-architecture/pull/153) keeps the strict diagnostic assertion. This does not constitute an acceptance pass.
No target below is covered just because it federates with Mastodon.

## Additional required targets

| Software / exact reference | Ordinary actor expectation | Group dependency | Live status / first executable gate |
| --- | --- | --- | --- |
| **Bonfire Social/Community**, upstream `bonfire-networks/bonfire-app` `v1.1.0-rc.8` (2026-11-12) | Standard signed AP `Person`, Follow/Accept, Create/Note; choose Social for individual tests | None for People; Community FEP-1b12 is a separate test | **Person actor discovery passed, Follow not tested**: official SHA-256-verified RC8 Community tarball, 169 migrations on disposable PostGIS17, and real disposable user registration. Both instance/user open-federation settings were confirmed, anonymous WebFinger returned 200 and a full local `Person` actor with inbox/public key validated in [CI 43367699540](https://github.com/outlaw-dame/mastopod-federation-architecture/actions/runs/43367699540). Older 1.0.6 Social fixture remains broken; signed ActivityPods Follow, Accept and durable remote follower query remain untested |
| **Emissary**, `EmissarySocial/emissary` `597b9b16a63b4a60db0fab096c918291335f4a16` | Upstream FEDERATION.md specifies inbound signed Follow creates a Follower row and sends Accept; requires actor-owned signature and same-origin activity ID, draft Cavage signature | None; Streams and templates can add other actor types | **Local Person preflight passed, Follow not tested**: pinned source built; disposable MongoDB 8 replica-set initialized; local `Person`, same-origin inbox and public PEM key verified in [CI 43365737504](https://github.com/outlaw-dame/mastopod-federation-architecture/actions/runs/43365737504). Local-only HTTP is explicitly not production federation TLS. Next signed Follow/Accept + exact persisted follower query |
| **Lemmy**, `LemmyNet/lemmy` `0.19.21` stable (Oct 2026) | Official docs explicitly allow *remote* People to follow Lemmy users; Lemmy users themselves cannot follow ordinary people | None for inbound Person Follow; Posts/Comments usually depend on a Community | **Not tested**: pin target user, Postgres and activitypub-federation worker; verify exact inbound follower state, not generic Group subscriptions |
| **PieFed**, `karasugawasu/pyfedi` (release family 1.7+) | v1.7 adds following Mastodon people, so Person Subscribe tests are meaningful, including directionality | None for public People follow; some posts remain community-scoped | **Not tested**: pin supported release, Flask worker/DB/bootstrap and durable follower query |
| **Mbin**, `MbinOrg/mbin` `v1.11.1` (2026-11-10) | Mbin supports microblogging as well as magazines, interacting with Mastodon | No for microblogs and People; magazines are Group actors | **Not tested**: pinned Symfony worker/queue + exact inbound follow state |
| **NodeBB**, `NodeBB/NodeBB` `v4.16.8` (2026-11-12) | Remote People can be discovered and followed; AP v4 supports draft Cavage and newer RFC9421 signatures | No for People; federated categories need explicit privileges | **Not tested**: pin source and enable federation; for upgraded servers the admin toggle is disabled by default; prove actor/Follow persistence |
| **Catodon**, official 26.10.x documentation and release | Misskey-derived Person microblogging, Mastodon API compatible; community actor flows different | No for People; its Lemmy-compatible forums are separate | **Not tested**: obtain immutable release build from official codefloe.com registry, run a user fixture and exact follower-state proof |

### Behavior that must remain distinct

- **Lemmy** official federation spec: Community=`Group`, User=`Person`, Post=`Page`, Comment=`Note`. A normal ActivityPods person following a Lemmy person is supported; conversely Lemmy cannot initiate following arbitrary remote People according to its docs. That asymmetry is *not* evidence of a transport failure.
- **Emissary** rejects an externally forwarded `Follow` if the HTTP signer does
  not own the `actor`; this is correct. Fedify must use the ActivityPods actor
  signing key and same-origin `id`; relays do not impersonate that Person.
- **Bonfire** RC1+ public Groups and channels can federate via FEP-1b12;
  private clubs and local-only presets do not. They are *not* an ordinary
  Person test.
- **NodeBB** new v4 installs default to federation on; upgrades default off,
  with additional category permission requirements. Prove configuration before
  interpreting a missing Follow as protocol incompatibility.
- **Catodon** documents `Event` object incompatibilities with NodeBB/Mbin/
  PieFed; do not misclassify Event refusal as failed `Person` or `Note`
  federation.
- **PieFed**'s newer Mastodon Follow integration may not accept all
  standalone `Note` semantics, depending on its community feed rules.
  Keep Follow, Note and Page acceptance results separately labeled.

### November 13 live Bonfire verification correction

The RC8 release now passes the official digest, PostGIS startup, disposable
Person creation and WebFinger actor proof. Native ActivityPods Follow
persistence has been observed in the strict real multi-implementation job.
The external Fedify attempt then exposed a **test-verifier defect**: Bonfire
release `bin/bonfire rpc` evaluates Elixir inside the running BEAM server,
which does not inherit environment variables injected into the short-lived
Compose exec process. The persistence checker no longer attempts to read
those variables inside BEAM. It passes canonical, prevalidated actor/target
identifiers as safely encoded literal arguments, and uses the local
`get_character_by_ap_id` lookup rather than calling the network-fetching
`get_or_fetch_character_by_ap_id` on every poll.

**Fedify Follow persistence is not yet accepted** until both the signed
ActivityPods origin, remote Bonfire follower state, and recorded signer prove
successful in the *same* exact-head CI run. The verifier failure is not
silently labeled successful. The full matrix retains hard persistence
assertions for its remaining targets and no synthetic result is promoted.

## Incremental rollout and affordability

The Bonfire RC8/PostGIS17 and Emissary/Mongo8 disposable boot and
**local Person actor** gates now pass. Neither test used real remote
delivery; both still need valid HTTPS actors beyond loopback.
Next execute their live Person Follow/Accept fixtures with **actual HTTPS
and signed ActivityPods origin**, then Lemmy/PieFed/Mbin/NodeBB/Catodon
individual Person actor checks. Each fixture needs its own authoritative
follower persistence query; a boot check is a prerequisite, not federation. Run one isolated target per
CI job with bounded time and cleanup, no persistent shared credentials and
no unbounded instance scraping. Select explicit versions by commit/digest;
do not disable SSRF checks or accept 2xx in place of persisted-state proof.
Reuse the existing ActivityPods + Fedify two-mode origin harness, queue,
signing API and deterministic disposable TLS domains. No extra broker or
runtime Group service.

**Related release gates:** ActivityPods four-cell Solid bootstrap still
occasionally lacks preferences, authorization agent and registry links.
PostgreSQL operational account candidate and Group consent authority are
separate, non-activated migrations. No source-only test can waive them.

## Primary sources

- Existing CI fixture and blocker inventory:
  `fedify-sidecar/interop/ap/EXTERNAL-IMPLEMENTATION-COVERAGE.md`
- <https://github.com/bonfire-networks/bonfire-app/releases/tag/v1.1.0-rc.8>
- <https://docs.bonfirenetworks.org/groups.html>
- <https://github.com/EmissarySocial/emissary/blob/main/FEDERATION.md>
- <https://github.com/EmissarySocial/emissary/tree/597b9b16a63b4a60db0fab096c918291335f4a16>
- <https://join-lemmy.org/docs/contributors/05-federation.html>
- <https://join.piefed.social/2026/07/03/piefed-v1-7-is-released-following-users-faster-browsing-smarter-moderation/>
- <https://github.com/karasugawasu/pyfedi>
- <https://docs.joinmbin.org/user/user_guide/>
- <https://docs.nodebb.org/activitypub/>
- <https://community.nodebb.org/topic/19491/nodebb-v4-16-0-ap-improvements-moderation-updates-security-updates-and-more>
- <https://why.catodon.rocks/docs/events-federation/>
