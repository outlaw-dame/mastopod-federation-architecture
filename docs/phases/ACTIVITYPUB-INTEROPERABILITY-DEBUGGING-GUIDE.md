# ActivityPub Interoperability Debugging Guide

Status: **deliverable 6 of `ACTIVITYPUB-INTEROPERABILITY-HARDENING.md`'s ordered deliverables — complete**
Depends on: `ACTIVITYPUB-INTEROPERABILITY-FIXTURE-SCHEMA.md` (deliverable 3), `ACTIVITYPUB-INTEROPERABILITY-FIXTURE-SIBLINGS.md` (deliverable 5)

## Purpose

`ACTIVITYPUB-INTEROPERABILITY-HARDENING.md` names BrowserPub as "a human-driven
investigation/reproduction aid, not a required CI dependency" and lays out a 10-step
BrowserPub-to-regression workflow. That workflow was previously prose only. This guide is the
concrete, hands-on version of it: what to actually run, in what order, and exactly which files
in this repo a discovery turns into. It's written for an ActivityPods application developer who
hit a real-world interoperability discrepancy and needs to turn it into a permanent regression
fixture.

## What BrowserPub is

[BrowserPub](https://browser.pub/) is a web-based ActivityPub browser built by John Spurlock:
paste in any ActivityPub-discoverable URL or a fediverse handle (`@user@host`) and it resolves
and displays the underlying ActivityPub data — actors, posts, collections — with both a visual
and a raw JSON view. It supports logging in to a federated account, which lets it inspect
followers-only/direct content and other authenticated endpoints you can't reach with a plain
unsigned GET. ([browser.pub](https://browser.pub/), [background from its author](https://lemmy.sdf.org/comment/13881907))

Use it first for anything visual or exploratory — profile pages, threads, collections, anything
where "click around and see what's there" beats writing a request by hand. Its limits, for this
program's purposes:

- It's a third-party hosted service — never a CI dependency (the hardening doc is explicit:
  "Live third-party availability must not gate ordinary pull requests").
- It won't show you this repo's own request framing (our actual `Accept` header, our own
  redirect handling, etc.) — for that, use the manual inspection tool below.
- It's a good reproduction aid, not a source of truth for what's "correct" — the fixture you
  end up writing encodes what *ActivityPods/SemApps* should do with the observed shape, not
  what BrowserPub's own renderer does with it.

## Manual inspection: `inspect-remote-object.mjs`

For everything BrowserPub can't show you — this repo's own content negotiation, response
headers, or redirect behavior — use
`fedify-sidecar/interop/ap/scripts/inspect-remote-object.mjs`, a small dependency-free Node
script.

```bash
# By fediverse handle (resolves WebFinger, prints the actor URL, stops there)
node fedify-sidecar/interop/ap/scripts/inspect-remote-object.mjs @user@example.social

# By URL (actor, object, activity, collection — anything ActivityPub-dereferenceable)
node fedify-sidecar/interop/ap/scripts/inspect-remote-object.mjs https://example.social/users/alice
```

It sends a single unsigned GET with
`Accept: application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams", application/json`
and prints the status, the headers that actually matter (`content-type`, `date`, `location`,
`cache-control`, `vary`), and the pretty-printed body.

Two things it deliberately never does:

- **It never follows redirects automatically** (`redirect: "manual"`). If the response is a
  redirect, it prints the target and tells you whether it's same-origin, and stops — you decide
  whether to re-run it on that URL. This is the same class of gap Codex flagged for real in
  PR #106's `assert-real-return-accept.mjs` ("Reject cross-origin redirects while fetching
  following pages" / "Validate redirects before following evidence URLs"): a redirect to a
  different origin during investigation is itself a fact worth noticing, not something to
  silently chase.
- **It never signs or authenticates the request.** For followers-only/direct content or a
  server that enforces authorized fetch (GoToSocial does, unconditionally — see the PR #106
  root-cause note on its 401s), this script will correctly show you a rejection or empty
  result. Use BrowserPub's login for that case instead of trying to extend this script into a
  signing client — keeping it a plain GET is what keeps it safe to hand to any developer.

Verified against a real, live public actor while writing this guide (`mastodon.social`, a
public Mastodon instance's own profile) — WebFinger resolution, actor dereference, a 404 case,
and the non-https/bad-handle/no-args guards all behave as documented above.

## From discovery to fixture

This is the BrowserPub-to-regression workflow from `ACTIVITYPUB-INTEROPERABILITY-HARDENING.md`,
mapped onto the actual schema and files that exist in this repo as of deliverables 3 and 5.

1. **Identify** the remote actor/object/activity that behaves differently. Usually: an
   application-level bug report, or something noticed while testing against a real instance.
2. **Inspect** it — BrowserPub for a first look, `inspect-remote-object.mjs` for the exact wire
   bytes and headers.
3. **Redact.** Before anything from this step leaves your terminal into a committed file:
   strip real display names, bios, avatar URLs, follower/following IRIs, and any post content
   that isn't the specific structural shape you're investigating. Rewrite actor/object IRIs to
   a synthetic `*.example` domain unless the identity itself is what you're testing (a specific
   well-known relay actor, for instance) — and if so, that becomes
   `redaction.identifierScheme: "real_identity_justified"` with a written
   `identityJustificationNote`, not a silent exception.
4. **Record provenance**: which software family, which version/release if you can determine it,
   and the `content-type` you actually got back. This becomes `softwareVersion` and
   `redaction.sourceCaptureNote`/`sourceCaptureDate` on the fixture metadata.
5. **Reduce** to the minimal payload that still reproduces the shape. Don't commit a whole real
   timeline page when the interesting part is one field on one object.
6. **Reproduce against normalization** — for `activitystreams_structure`/`jsonld_semantics`
   boundaries, this means: does `runActivityStreamsStructureCheck` (or the real ActivityPods/
   SemApps pipeline, for anything beyond this hermetic runner's scope — see
   `FixtureBoundaryRunner.ts`'s own scope note) treat it the way you expect?
7. **Classify** the failure: `transport_authority` | `parsing` | `semantic_normalization` |
   `authorization_visibility` | `app_presentation` — this becomes
   `regressionClassification`.
8. **Write the fixture.** Two files:
   - The payload JSON under `fedify-sidecar/interop/ap/fixtures/<targetId>/<fixtureId>.json`.
   - An entry in `AP_INTEROP_FIXTURES` (`fedify-sidecar/src/interop/ap/FixtureCorpus.ts`)
     conforming to `FixtureMetadataSchema`. Pick `disposition` and `expectedOutcome` together —
     `ACTIVITYPUB-INTEROPERABILITY-FIXTURE-SCHEMA.md` documents which combinations the schema
     accepts. **If this is a `permissible_variation`**, it needs a `malformed_structure` /
     `unsafe_authority_bypass_attempt` / `adversarial_replay` / `adversarial_duplicate` sibling
     in the same `targetId` + `capability` family, or `assertFixtureSiblingCoverage()` fails the
     build — see `ACTIVITYPUB-INTEROPERABILITY-FIXTURE-SIBLINGS.md`.
9. **Add the boundary assertion.** `FixtureCorpus.test.ts` runs each fixture through the
   boundary its own `boundariesExercised` declares and asserts the real outcome equals
   `expectedOutcome` — that's what makes step 8 a regression test and not just documentation.
   If your fixture needs a boundary `FixtureBoundaryRunner.ts` doesn't implement yet, extend it
   there (staying inside its documented scope: a hermetic reference validator, not a
   replacement for real ActivityPods/SemApps enforcement or the sidecar's production path).
10. **Prove no regression**: `npx vitest run src/interop/ap/` from `fedify-sidecar/`.

## Worked example (discovered live while writing this guide)

Running `inspect-remote-object.mjs https://mastodon.social/users/Gargron` against Mastodon's
own live production instance today returns an actor whose `@context` extension terms include
not just Mastodon's own `toot:` namespace but `gts:interactionPolicy` and `gts:canQuote` —
GoToSocial-namespaced terms — plus a `https://w3id.org/fep/7aa9#canFeature` FEP term. That's a
real, current instance of exactly the dialect convergence
`ACTIVITYPUB-INTEROPERABILITY-HARDENING.md` exists to track: one implementation's extension
vocabulary showing up on another's actor document.

Walking it through the steps above: this is a `permissible_variation` fixture candidate for
`(mastodon, note)` or a new `actor` capability family — the correct behavior is to tolerate and
preserve these unrecognized-but-safe extension terms exactly the way
`mastodon.note-quote-extension-permissible` already does for `quoteUri`. It is **not** yet
turned into a committed fixture as part of this guide — doing so is ordinary follow-on work
using the steps above, called out here so the example is a real, live one rather than a
hypothetical.

## Redaction checklist (before you commit anything)

- [ ] No real display name, bio, avatar, or post content beyond the structural shape under test.
- [ ] No real follower/following IRIs or private-visibility content.
- [ ] Actor/object IRIs rewritten to a synthetic `*.example` domain, unless real identity is
      justified in `identityJustificationNote`.
- [ ] `redaction.containsRealUserContent` is `false` (the schema won't let you set it any other
      way, but the file you paste from before redacting might still have it — check before you
      strip, not after).
- [ ] Software/version/capture-date recorded for anything not `sourceClass: "synthetic"`.

## Non-goals

This guide does not add new fixtures itself (that's deliverable 4/5's territory, already
seeded) and does not change what BrowserPub does — it documents how to use it and its manual
alternative inside this program's actual workflow. It does not touch fedify-sidecar's
production inbound path or ActivityPods.
