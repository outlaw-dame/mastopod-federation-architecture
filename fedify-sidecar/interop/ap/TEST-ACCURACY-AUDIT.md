# Federation test accuracy audit

Audited 2026-10-03 against architecture PR #106 commit
`40cec5db9c0802dd7abf18554d65f3d5b01e8392` and ActivityPods PR #107 commit
`c7a1aba4ea6e597b4816e1f66fd465d47497ef71`.

## Test generation and evidence scope

The repository's tests are custom harness code, rather than an imported certification suite.
Test inputs include authored synthetic payloads, production-generated activities,
and fixture metadata capable of distinguishing synthetic from captured/reduced inputs.
The presence of a provenance schema does not establish that every fixture has been
individually validated against its upstream implementation.

| Family | Components exercised | Evidence established | Limits |
| --- | --- | --- | --- |
| Unit and payload fixtures | Controlled inputs and mocked dependencies | Particular parsing, validation, privacy, authority, and error behavior | No real-platform interoperability claim |
| AP Interop Smoke | Real sidecar and remote implementations; mock ActivityPods authority | Sidecar interaction with the deployed target and returning Accept observation | Does not validate real ActivityPods signing or native delivery |
| Real Multi-Implementation Federation | Real ActivityPods, remote implementation, native delivery, external sidecar delivery | Exact remote actor relationship persisted, returning Accept applied, external signer result correlated to the wire request | Follow/Accept handshake only; not complete ActivityPub compatibility |
| Media and other architecture lanes | Separate scenario-specific harnesses | Only their explicit object/media/stream assertions | Their success must not be transferred to unexercised modes or platforms |

The real Follow originates through `activitypub.outbox.post`, with the provisioned
actor's WebID and dataset. External mode requires an observed durable handoff and
exactly one suppressed native remote POST. The remote persistence script queries
each platform's database for the exact actor and local target; accepted-state
predicates are used where the schema exposes them. Signing assertions check the
plan-bound destination, actor, activity ID, payload digest, key ID, and signed
headers. The workflow also requires matching wire evidence and local application
of the returning Accept. Its summary fails if either mode is incomplete.

`continue-on-error` on a proof step must never be interpreted using the GitHub
step conclusion alone: the workflow gates on the step outcome and assertion files.

## Latest campaign inspected

[Run 33110618787](https://github.com/outlaw-dame/mastopod-federation-architecture/actions/runs/33110618787)
executed at the audited architecture commit and completed on 2026-08-27.
GitHub reports successful jobs for Mastodon, GoToSocial, Akkoma, Pixelfed, Misskey,
and Castopod; failed jobs for Friendica, Loops, Owncast, and PeerTube.
These are job conclusions checked during this audit, not a new campaign or an
independent revalidation of every archived evidence artifact. Overall run failed.
Bonfire, Bandwagon, Micro.blog, and write.as are absent from that executable matrix.
Their documented deployment/access blockers are not successful compatibility tests.

## Claims and gaps requiring care

Development following this audit adds independent RSA verification using the
published actor key, port-8080 listener absence checks before and after the
native proof, runtime image identity capture, and a Mastodon-only independent
Create exchange in both modes. The Create check requires remote database
persistence, exact inbox membership and content on return, independent RSA
verification, and external signing API correlation with the authoritative
Create delivery plan. These are new executable assertions, not evidence
of a successful runtime until the changed commit passes CI. The observations
below describe the original audited commit where those checks were absent.

Castopod's current fixture replaces HttpSignature.php and prepends an actor
materialization compatibility helper. CI now declares that variant and retains
the patch hashes. Its result must not be presented as stock Castopod compatibility.

- A Follow with a returning Accept proves a handshake with traffic in both
  directions. Independent remote-origin Follow/Create and local processing are
  separate scenarios and cannot be inferred from that handshake.
- Full platform compatibility requires explicit capability/scenario coverage,
  including applicable Create, Update, Delete, Undo, Like, Announce, addressing,
  private delivery, attachments, replay, and adverse signature behavior. A single
  aggregate handshake boolean does not establish this coverage.
- CI worker connectivity and custom trusted test certificates are controlled
  deployment conditions; public-network behavior must be evidenced separately.
- Database queries should be cross-checked against the pinned upstream schema and
  transition semantics before being treated as accepted processing for new releases.
- Fixture authority is mixed: some images use immutable digests or source SHAs,
  while the base Mastodon and GoToSocial images use version tags. Tags alone do
  not establish immutable container bytes; retain resolved image digests in results.
- Assertions should establish a clean baseline and a state transition for the
  unique test actor, not merely an existing matching row.
- `assert-real-wire-signature.mjs` establishes field validity, destination/body
  identity, successful upstream response, and external signing-result correlation.
  It does not independently perform RSA verification against the published key.
  Remote accepted processing is additional evidence; the wire assertion alone
  must not be described as independent cryptographic verification.
- The summary writes `sidecarRunning: false` for native mode. The sidecar starts
  later in the workflow, but this field is not a process-inventory measurement.
  A runtime isolation assertion would strengthen the no-sidecar claim.
- Separate RedPanda/OpenSearch benchmark and integration successes do not prove
  one federation activity traversed every architecture component end to end.

## Published suites

The [W3C ActivityPub Recommendation](https://www.w3.org/TR/activitypub/) links a
historical test suite. [go-fed/testsuite](https://github.com/go-fed/testsuite)
describes itself as an unofficial, machine-assisted suite.
[steve-bate/activitypub-testsuite](https://github.com/steve-bate/activitypub-testsuite)
describes an exploratory compliance framework requiring server-specific support;
its README says the original proof-of-concept projects were retired.
These are possible sources of test cases and independent oracles. They do not
make this repository certified, and do not substitute for deployed-platform tests.

Conversation retrieval returned six available turns from the referenced
Interoperability Inventory task. The visible continuation messages were also
reviewed. This audit does not claim access to missing or truncated prior messages.
