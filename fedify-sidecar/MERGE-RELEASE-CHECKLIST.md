# Fedify Sidecar Merge And Release Checklist

Use this checklist for federation-runtime, signing, queueing, and AP interop changes.

## PR Merge Gate

- `Fedify Sidecar Fast Checks` is green.
- `AP Interop Smoke` is green when the change touches federation/runtime-critical paths.
- The architecture baseline and harness docs still describe the actual runtime behavior.
- ActivityPods remains the only signing authority. No private keys are forwarded, copied, or cached into Fedify or the sidecar.
- Any new retry loop has bounded backoff, capped failure behavior, and explicit logging/metrics.

## When To Require AP Interop Smoke

Require the dockerized AP proof lane for changes in these areas:

- `fedify-sidecar/src/federation/**`
- `fedify-sidecar/src/delivery/**`
- `fedify-sidecar/src/signing/**`
- `fedify-sidecar/src/queue/**`
- `fedify-sidecar/src/interop/ap/**`
- `fedify-sidecar/interop/ap/**`
- `fedify-sidecar/src/index.ts`
- `Dockerfile.interop`

That is the same scope the CI workflow uses to decide whether the heavy lane should run on PRs.

## Before A Release Candidate

- Run `npm --prefix fedify-sidecar run check:fast`.
- Run `npm --prefix fedify-sidecar run smoke:interop:ap:extended`.
- Confirm the three-target matrix is green:
  - GoToSocial
  - Mastodon
  - Akkoma
- Review the latest proof output and confirm each target returned a real inbound `Accept`, not just an outbound `2xx`.

## Key Boundary Checks

- Outbound ActivityPub requests are signed only by ActivityPods through the internal signing API.
- The sidecar sends the exact bytes that were signed.
- Fedify receives only a signing callback boundary and never raw private key material.
- Per-actor inbox verification still uses the sidecar-native verifier where that is required to preserve the key boundary.

## Branch Protection

Configure GitHub branch protection to require:

- `Fedify Sidecar Fast Checks`
- `AP Interop Smoke`

For repositories with high release velocity, keep `Fedify Sidecar Fast Checks` required on every PR and `AP Interop Smoke` required for federation/runtime changes or all PRs if runner budget allows.

## Manual Akkoma Guidance

The Akkoma profile is part of the release matrix and should also be run for:

- changes under `fedify-sidecar/interop/ap/akkoma/**`
- changes under `fedify-sidecar/interop/ap/scripts/*akkoma*`
- changes to `fedify-sidecar/src/interop/ap/**`
- any fix meant to improve Pleroma/Akkoma-family interoperability

Use:

```sh
npm --prefix fedify-sidecar run interop:ap:akkoma
```
