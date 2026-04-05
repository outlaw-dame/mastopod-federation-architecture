# ActivityPods Internal AT Endpoint Contracts (Live-Verified)

These contracts were verified against a running ActivityPods instance with
real secp256k1 keys and a live identity binding.  The sidecar may depend
on these without further assumption.

---

## Auth

All internal AT endpoints require:

```
Authorization: Bearer <ACTIVITYPODS_TOKEN>
```

`ACTIVITYPODS_TOKEN` is the shared secret set in the ActivityPods environment
and the sidecar environment.  Requests missing the header receive `401`; wrong
token receives `403`.

---

## POST /api/internal/atproto/provision

Provision keys and identity binding for one account.  Internal orchestration
use only — not exposed to clients.

**Request body**

| Field                | Type   | Required | Notes                                    |
|----------------------|--------|----------|------------------------------------------|
| `canonicalAccountId` | string | yes      | Canonical account identifier (= webId)  |
| `webId`              | string | no       | Defaults to `canonicalAccountId`         |
| `did`                | string | no       | Defaults to `did:plc:<slug>`             |
| `handle`             | string | no       | Defaults to `<slug>.test`                |

**Response 200**

```json
{
  "binding": { ...IdentityBindingDTO },
  "commitKeyRef": "https://.../keys/...",
  "rotationKeyRef": "https://.../keys/..."
}
```

**Error cases**

| HTTP | code             | Cause                            |
|------|------------------|----------------------------------|
| 401  | `AUTH_FAILED`    | Missing/invalid bearer token     |
| 403  | `AUTH_FAILED`    | Wrong bearer token               |
| 500  | `KEY_UNAVAILABLE`| Key generation failed            |

---

## GET /api/internal/atproto/public-key

Return the compressed secp256k1 public key for a given account purpose.

**Query parameters**

| Param                | Type                     | Required |
|----------------------|--------------------------|----------|
| `canonicalAccountId` | string                   | yes      |
| `purpose`            | `"commit"` \| `"rotation"` | yes    |

**Response 200**

```json
{
  "did": "did:plc:...",
  "keyId": "did:plc:...#atproto",
  "publicKeyMultibase": "z...",
  "algorithm": "k256"
}
```

`publicKeyMultibase` always starts with `z` (base58btc multibase prefix).
`keyId` fragment is `#atproto` for `commit` purpose, `#atproto-rotation-key`
for `rotation` purpose.

**Error cases**

| HTTP | code              | Cause                               |
|------|-------------------|-------------------------------------|
| 404  | `ACTOR_NOT_FOUND` | No identity binding for account     |
| 422  | `KEY_UNAVAILABLE` | Keys not yet provisioned            |
| 500  | `KEY_UNAVAILABLE` | Key lookup or conversion failed     |

---

## POST /api/internal/atproto/commit-sign

Sign an ATProto repository commit payload.

**Request body**

| Field                        | Type   | Required | Notes                              |
|------------------------------|--------|----------|------------------------------------|
| `canonicalAccountId`         | string | yes      |                                    |
| `did`                        | string | yes      | Must match binding DID if set      |
| `unsignedCommitBytesBase64`  | string | yes      | base64-encoded commit bytes        |
| `rev`                        | string | yes      | Commit revision identifier         |

**Response 200**

```json
{
  "did": "did:plc:...",
  "keyId": "did:plc:...#atproto",
  "signatureBase64Url": "...",
  "algorithm": "k256",
  "signedAt": "2026-03-25T00:00:00.000Z"
}
```

**Error cases**

| HTTP | code              | Cause                                  |
|------|-------------------|----------------------------------------|
| 400  | `INVALID_INPUT`   | `did` does not match binding DID       |
| 404  | `ACTOR_NOT_FOUND` | No identity binding for account        |
| 422  | `KEY_UNAVAILABLE` | Signing key not yet provisioned        |
| 500  | `SIGNING_FAILED`  | Signing operation failed               |

---

## POST /api/internal/atproto/plc-sign

Sign a `did:plc` operation using the rotation key.

**Request body**

| Field                  | Type   | Required | Notes                              |
|------------------------|--------|----------|------------------------------------|
| `canonicalAccountId`   | string | yes      |                                    |
| `did`                  | string | yes      | Must match binding DID if set      |
| `operationBytesBase64` | string | yes      | base64-encoded PLC op bytes        |

**Response 200**

```json
{
  "did": "did:plc:...",
  "keyId": "did:plc:...#atproto-rotation-key",
  "signatureBase64Url": "...",
  "algorithm": "k256",
  "signedAt": "2026-03-25T00:00:00.000Z"
}
```

**Error cases**

| HTTP | code              | Cause                                  |
|------|-------------------|----------------------------------------|
| 400  | `INVALID_INPUT`   | `did` does not match binding DID       |
| 400  | `INVALID_INPUT`   | Effective DID is not `did:plc:*`       |
| 404  | `ACTOR_NOT_FOUND` | No identity binding for account        |
| 422  | `KEY_UNAVAILABLE` | Rotation key not yet provisioned       |
| 500  | `SIGNING_FAILED`  | Signing operation failed               |

> `did:web` and all non-`did:plc` DIDs are explicitly rejected.

---

## Identity Binding DTO

All endpoints that return a binding use this shape:

```json
{
  "id":                  "https://<webId>#identity-binding-atproto",
  "canonicalAccountId":  "https://<webId>",
  "webId":               "https://<webId>",
  "atprotoDid":          "did:plc:...",
  "atprotoHandle":       "alice.pods.example",
  "atSigningKeyRef":     "https://.../keys/...",
  "atRotationKeyRef":    "https://.../keys/...",
  "status":              "active",
  "createdAt":           "2026-03-25T00:00:00.000Z",
  "updatedAt":           "2026-03-25T00:00:00.000Z"
}
```

---

## Key invariants (verified)

- `publicKeyMultibase` always starts with `z`
- Commit key and rotation key have distinct `keyRef` values
- Commit keyId fragment is exactly `#atproto`
- Rotation keyId fragment is exactly `#atproto-rotation-key`
- `signAtprotoPlcOp` rejects `did:web` with HTTP 400
- Caller-supplied `did` mismatching `binding.atprotoDid` → HTTP 400 `INVALID_INPUT` (not 422)
- 422 is reserved for missing/unprovisioned keys only
- Low-S normalization is applied to all secp256k1 signatures
- Signatures are returned as base64url (no padding)

---

## Smoke test commands (one-command verification)

```bash
# Multibase boundary check (z-prefix, stability, distinctness)
npm run test:atproto:multibase

# Full Part-6 signing path (provision → public-key → commit-sign → plc-sign → negative)
npm run test:atproto:signing
```

Both scripts live in `pod-provider/backend/scripts/`.
Environment defaults: `ATPROTO_SMOKE_BASE_URL=http://localhost:3004`,
`ACTIVITYPODS_TOKEN=test-atproto-signing-token-local`,
`ATPROTO_SMOKE_CANONICAL_ACCOUNT_ID=http://localhost:3000/atproto365133`.
