# Provider Capabilities Implementation Pack

This directory contains implementation artifacts for provider capability discovery and enforcement.

## Files

- `provider-capabilities.schema.v1.json`
  - JSON schema for `/.well-known/provider-capabilities` response.
- `example.ap-core.v1.json`
  - AP-only baseline profile example.
- `example.ap-scale.v1.json`
  - AP-only scale profile example.
- `example.dual-protocol-standard.v1.json`
  - AP+AT profile example.
- `startup-validation-matrix.md`
  - Fail-fast capability dependency and infrastructure validation rules.
- `enforcement-patterns.md`
  - Shared pseudocode patterns for HTTP, workers, and event subscription authorization.
- `../../../APP-DELEGATED-ACCOUNT-PROVISIONING.md`
  - Account and pod provisioning flow for approved apps such as Memory.

## Suggested Adoption Order

1. Implement startup validator from `startup-validation-matrix.md`.
2. Serve endpoint payload conforming to `provider-capabilities.schema.v1.json`.
3. Add gate middleware/guards based on `enforcement-patterns.md`.
4. Add conformance tests using AP-only and dual-protocol examples.
5. Gate app-mediated signup and migration entry points on `provider.account.provisioning`.
