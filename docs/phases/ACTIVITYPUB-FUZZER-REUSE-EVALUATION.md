# ActivityPub Fuzzer Reuse Evaluation

Status: **deliverable 7 of `ACTIVITYPUB-INTEROPERABILITY-HARDENING.md`'s ordered deliverables — evaluated, decision: emulate, do not vendor**
Depends on: `ACTIVITYPUB-INTEROPERABILITY-FIXTURE-SCHEMA.md` (deliverable 3), `ACTIVITYPUB-INTEROPERABILITY-FIXTURE-SIBLINGS.md` (deliverable 5)

## What deliverable 7 actually asks

`ACTIVITYPUB-INTEROPERABILITY-HARDENING.md`: "Evaluate direct reuse where practical; otherwise
emulate its core method by turning observed implementation dialects into executable
inbound/outbound regression cases." This is a decision deliverable, not a code deliverable —
it exists to produce and record the reuse-or-emulate call, not to ship a new fixture corpus
(deliverables 3/5 already cover that).

## What ActivityPub Fuzzer actually is

[berkmancenter/activitypub-fuzzer](https://github.com/berkmancenter/activitypub-fuzzer) — a
Node.js project from Harvard's Berkman Klein Center Applied Social Media Lab (Darius Kazemi),
licensed **AGPL-3.0**. Concretely, it is:

- A **standalone local web application** (default port 3000) with a browser UI — not a library,
  not a CLI, no documented API for programmatic/headless invocation.
- Built to **actually deliver live ActivityPub messages** to a real target inbox: the README
  workflow requires exposing your local instance to the public internet via a tunnel (ngrok or
  Fedify) so the messages it sends are genuinely federated, not just generated in-process.
- Its message corpus — "every known version of a specific Fediverse software project" — is not
  bundled static fixtures. It's driven by a separately-downloaded **Fediverse Schema Observatory
  snapshot** (`observatory.db`), placed in the project root by hand. The Fuzzer is a delivery
  mechanism over that external database, not an independent corpus of its own.

## Direct reuse: not viable, for three independent reasons

1. **Architecturally incompatible with this program's own required harness properties.**
   `ACTIVITYPUB-INTEROPERABILITY-HARDENING.md` requires fixtures/tests to be "deterministic and
   hermetic" and explicitly forbids ordinary CI from depending on live third-party availability.
   The Fuzzer's whole design is the opposite: it exists to push real messages across the open
   internet to a real target through a public tunnel. There's no code path in it that produces
   a static, replayable fixture — running it *is* the live delivery.
2. **Nothing importable.** No CLI, no API, no package export — the "product" is the browser
   session plus a downloaded database file. There's no function or module to `import`, and no
   static corpus file that could be copied in and versioned the way `AP_INTEROP_FIXTURES`
   fixtures are.
3. **License incompatibility for vendoring.** AGPL-3.0 is strong copyleft with an explicit
   network-use clause: operating a modified/derivative work as a network service obligates
   releasing that work's source under AGPL. This repository carries no `LICENSE` file (default,
   effectively proprietary) and `fedify-sidecar` is itself a network-facing service. Copying
   AGPL-licensed code (or the AGPL-derived Observatory-snapshot-driven message logic) into this
   tree would create exactly the obligation this repo isn't set up to satisfy. This is a
   sufficient reason on its own, independent of the two architectural reasons above.

**Conclusion: do not vendor or import ActivityPub Fuzzer code or its bundled data into this
repository.**

## What to do instead: emulate its core method (already underway)

The Fuzzer's actual value isn't its delivery mechanism — it's the idea it wraps: *known,
real-world dialect variance across Fediverse software, turned into inbound/outbound test
traffic.* `ACTIVITYPUB-INTEROPERABILITY-HARDENING.md` names this exact fallback, and it's
already the shape of deliverables 3 and 5:

| Fuzzer's approach | This repo's equivalent |
|---|---|
| Send a live message shaped like software X's dialect to a real inbox over a public tunnel | Commit a synthetic-or-redacted fixture payload shaped like the observed dialect under `fedify-sidecar/interop/ap/fixtures/<targetId>/` |
| Observatory snapshot as the source of "known" dialect variance | Manual/BrowserPub-driven discovery per `ACTIVITYPUB-INTEROPERABILITY-DEBUGGING-GUIDE.md`, reduced to a minimal fixture |
| No persistent, replayable, versioned test artifact | `AP_INTEROP_FIXTURES` entry + `FixtureMetadataSchema` record, replayed deterministically by `FixtureCorpus.test.ts` every run |
| Any implementation, any message, exercised ad hoc through the UI | `disposition`/`expectedOutcome` pairing enforced by `assertFixtureSiblingCoverage()` — permissible variation always ships with a malformed/adversarial sibling |

This is precisely "emulate its core method... rather than copying behavior ad hoc" from the
ordered-deliverables list itself (item 7's own wording) — the ad hoc thing being avoided is
exactly what the Fuzzer's live-tunnel model would import if vendored wholesale.

## A narrow, license-clean way to still use the real tool

Running the actual upstream Fuzzer **locally, unmodified, under its own AGPL license**, purely
as a human-driven investigation aid — the same posture `ACTIVITYPUB-INTEROPERABILITY-HARDENING.md`
already takes toward BrowserPub — is not the reuse this evaluation was scoped to (no code enters
this repo, nothing changes here), but it's worth naming as legitimate follow-on practice: a
developer can `git clone` it separately, run it locally with their own tunnel, observe a message
shape they don't recognize, and then manually reduce that observation into a fixture using
`ACTIVITYPUB-INTEROPERABILITY-DEBUGGING-GUIDE.md`'s discovery-to-fixture workflow — the same path
BrowserPub discoveries already follow. This is optional and not required to close deliverable 7.

## Non-goals

This evaluation does not add new fixtures (deliverables 3/5 already seeded the corpus this
method produces) and does not change the ADSP transporter decision or the ActivityPods/SemApps
authority and privacy boundaries. It is a recorded decision, not new test coverage.
