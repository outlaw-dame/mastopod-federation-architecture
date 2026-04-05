# ActivityPods ATProto Unblock Blueprint (V6.5)

## Goal
Unblock live AT provisioning by implementing the two missing ActivityPods-side dependencies first:

1. `keys.generateSecp256k1Key`
2. `keys.getAtprotoKeyPair({ keyRef })`
3. `identitybindings` service actions used by signing/provisioning

Keep contract stable: **do not rename `canonicalAccountId` now**.
For this first implementation: **`canonicalAccountId = webId`**.

## Current blockers confirmed
The signing service already assumes the missing actions:

- `identitybindings.getByCanonicalAccountId`
- `keys.getAtprotoKeyPair`

Those assumptions are present in `pod-provider/backend/services/signing.service.js` and prevent end-to-end AT provisioning until real ActivityPods implementations exist.

## Implementation order (required)
1. `keys.generateSecp256k1Key`
2. `keys.getAtprotoKeyPair`
3. `identitybindings.getByCanonicalAccountId`
4. `identitybindings.upsert`
5. Add `identitybindings.getByDid`, `identitybindings.getByHandle`
6. Patch `signing.service.js` to consume the concrete return contract (not assumptions)
7. Run provisioning smoke test

---

## 1) Keys service: add secp256k1 support

### Target file
- `pod-provider/backend/services/core/keys.js`

### Why here
`core/keys.js` already wraps `@semapps/crypto` `KeysService` and is the right extension point to keep key generation/storage inside the existing key boundary (`keys.container`, public key publication, WebID attachment).

### New constants (service-local)
Define service-local key type constants (do not modify node_modules):

- `ATPROTO_KEY_TYPE = 'urn:secp256k1-key'`
- `VERIFICATION_METHOD_TYPE = 'https://w3id.org/security#VerificationMethod'`

### New action: `keys.generateSecp256k1Key`

#### Params
- `webId: string` (required)
- `attachToWebId?: boolean` (default `false`)
- `publishKey?: boolean` (default `false`)

#### Behavior
1. Generate EC keypair with Node crypto:
   - algorithm: `ec`
   - namedCurve: `secp256k1`
   - public: SPKI PEM
   - private: PKCS8 PEM
2. Build key object:
   - `@type: [ATPROTO_KEY_TYPE, VERIFICATION_METHOD_TYPE]`
   - `publicKeyPem`
   - `privateKeyPem`
   - `owner = webId`
   - `controller = webId`
3. Persist private key object in `keys.container.post`.
4. If publish/attach enabled:
   - call `keys.publishPublicKeyLocally` (creates linked public key resource)
   - set `rdfs:seeAlso` on returned object
   - optionally attach to WebID via `keys.attachPublicKeyToWebId`
5. Return:
   - `keyRef` (private key resource URI)
   - `publicKeyRef` (public key resource URI when available)
   - `publicKeyPem`
   - `privateKeyPem`
   - optional `publicKeyMultibase` (compressed secp256k1 + multicodec base58btc)

For the first AT implementation, AT commit and rotation keys are not attached to WebID by default.
Their authoritative public projection is the AT identity surface (`getAtprotoPublicKey`, DID document generation, and AT identity routes), not automatic WebID mutation.

### New action: `keys.getAtprotoKeyPair`

#### Params
- `keyRef: string` (required)

#### Behavior
1. Resolve key object by `keys.container.get({ resourceUri: keyRef })`.
2. Assert key type includes `urn:secp256k1-key`.
3. Require `keyRef` to be the private key resource URI; fail loudly if it is not.
4. Return **stable contract**:
   - `keyRef`
   - `privateKeyPem`
   - `publicKeyPem`
   - `publicKeyMultibase` (optional)

#### Compatibility alias (recommended)
Temporarily also return:
- `privateKey` = `privateKeyPem`
- `publicKey` = `publicKeyPem`

This removes immediate break risk in `signing.service.js` while you migrate call sites.

`keys.getAtprotoKeyPair` is internal-only and must remain inside the signing/key trust boundary.
It must not be exposed beyond internal service-to-service usage.

### Utility method to add in `core/keys.js`
- `secp256k1PublicPemToMultibase(publicKeyPem)`
  - export SPKI DER
  - extract uncompressed EC point
  - compress to 33-byte point
  - prepend multicodec `0xe7 0x01`
  - base58btc encode with `z` prefix

Use same encoding path as AT profile expected by DID docs / PLC.

---

## 2) New identitybindings Moleculer service

### New file
- `pod-provider/backend/services/identitybindings.service.js`

### Service objective
Provide concrete identity binding persistence and lookup used by:
- AT provisioning
- signing handlers
- DID doc rendering
- future handle/DID resolution

### Storage model (first implementation)
Use one deterministic binding resource per account (canonical account = webId now), persisted in ActivityPods storage.

- Resource type: `apods:AtprotoIdentityBinding`
- Canonical rule now: `canonicalAccountId` value equals `webId`
- Deterministic rule: exactly one resource per `canonicalAccountId` / `webId`
- Upsert rule: always write to the deterministic resource URI, never create ad hoc duplicates

Suggested deterministic URI shape:
- `<webId>#identity-binding-atproto`

Equivalent deterministic local path form is acceptable if you prefer container resources, as long as the mapping is one-to-one and stable.

### Vocabulary lock (explicit predicates)
Lock predicate names now to avoid ad hoc drift:

- `apods:canonicalAccountId`
- `apods:webId`
- `apods:atprotoDid`
- `apods:atprotoHandle`
- `apods:atSigningKeyRef`
- `apods:atRotationKeyRef`
- `apods:status`
- `apods:createdAt`
- `apods:updatedAt`

### Required fields
- `canonicalAccountId` (string)  // equals webId for now
- `webId` (string)
- `atprotoDid` (string)
- `atprotoHandle` (string)
- `atSigningKeyRef` (string)
- `atRotationKeyRef` (string)
- `status` (enum-like string; e.g. `pending`, `active`, `disabled`)
- `createdAt` (ISO string)
- `updatedAt` (ISO string)

### Required actions

#### `identitybindings.getByCanonicalAccountId`
Params:
- `canonicalAccountId: string`

Behavior:
1. Treat `canonicalAccountId` as webId.
2. Resolve deterministic binding URI from `canonicalAccountId` and fetch that exact resource.
3. Return normalized DTO.

#### `identitybindings.upsert`
Params:
- `canonicalAccountId: string` (must equal `webId` in this phase)
- `webId: string`
- optional `atprotoDid`, `atprotoHandle`, `atSigningKeyRef`, `atRotationKeyRef`, `status`

Behavior:
1. Enforce invariant `canonicalAccountId === webId` (for now).
2. Create or update deterministic binding resource only.
3. Always set `updatedAt`; set `createdAt` on first insert.
4. Return normalized DTO.

#### `identitybindings.getByDid`
Params:
- `atprotoDid: string`

Behavior:
- Query by DID predicate and return one binding or `null`.

#### `identitybindings.getByHandle`
Params:
- `atprotoHandle: string`

Behavior:
- Query by handle predicate and return one binding or `null`.

### DTO normalization
Return plain JSON with consistent names:

- `id`
- `canonicalAccountId`
- `webId`
- `atprotoDid`
- `atprotoHandle`
- `atSigningKeyRef`
- `atRotationKeyRef`
- `status`
- `createdAt`
- `updatedAt`

No RDF-specific field leakage (`@id`, compacted keys) to callers.

---

## 3) Exact `signing.service.js` patch points

### Target file
- `pod-provider/backend/services/signing.service.js`

### Existing assumptions to replace
In AT actions, comments currently state assumptions and code expects legacy field names (`privateKey`, `publicKey`).

Patch these points:

1. In `signAtprotoCommit` key lookup block:
   - action call stays `keys.getAtprotoKeyPair({ keyRef: binding.atSigningKeyRef })`
   - use `keyPair.privateKeyPem || keyPair.privateKey`
   - fail if neither present

2. In `signAtprotoPlcOp` key lookup block:
   - use `keyPair.privateKeyPem || keyPair.privateKey`
   - gate operation to `did:plc` only (reject `did:web` with explicit validation error)

3. In `getAtprotoPublicKey`:
   - prefer `keyPair.publicKeyMultibase` if provided by keys service
   - fallback convert from `keyPair.publicKeyPem || keyPair.publicKey`
   - fail with clear `KEY_UNAVAILABLE` if neither present

4. Keep action params unchanged:
   - `canonicalAccountId` remains as-is
   - no contract rename

### Dependency line
`dependencies` already includes `identitybindings`; no dependency change required.

---

## 4) Provisioning flow to wire after services exist

1. Resolve account webId.
2. Generate commit key: `keys.generateSecp256k1Key({ webId })` -> `atSigningKeyRef`
3. Generate rotation key: `keys.generateSecp256k1Key({ webId })` -> `atRotationKeyRef`
4. Upsert binding:
   - `canonicalAccountId = webId`
   - include DID/handle when available
5. Signing endpoints then work via real internal lookups.

---

## 5) Smoke test checklist (end-to-end)

1. Provision keys for one test webId.
2. Upsert identity binding for same webId.
3. Call:
   - `POST /api/internal/atproto/commit-sign`
   - `POST /api/internal/atproto/plc-sign`
   - `GET /api/internal/atproto/public-key?canonicalAccountId=<webId>&purpose=commit`
4. Verify:
   - signatures returned in base64url
   - public key multibase starts with `z`
   - commit key and rotation key refs are distinct
   - `signAtprotoPlcOp` rejects non-`did:plc`

## 5.1) Multibase conversion tests (required)

Add focused tests for the secp256k1 PEM -> multibase conversion path:

1. generated secp256k1 PEM converts to multibase starting with `z`
2. same key produces stable multibase across repeated reads
3. commit key and rotation key produce distinct multibase values
4. DID doc/public key endpoint emits the exact same multibase as key conversion helper

---

## 6) Do-not-do list (kept explicit)

- Do not redesign canonical account model first.
- Do not bypass ActivityPods by storing bindings only in sidecar.
- Do not map AT signing to RSA/ED25519 paths.
- Do not reuse same key ref for commit and rotation semantics.

---

## 7) Suggested low-risk commit split

1. `feat(keys): add secp256k1 generation + AT key retrieval contract`
2. `feat(identitybindings): add binding service and minimum lookup/upsert actions`
3. `fix(signing): consume stable AT key contract and multibase path`
4. `test(atproto): provisioning and signing smoke tests`

This split keeps rollback/simple bisect possible if provisioning still fails.
