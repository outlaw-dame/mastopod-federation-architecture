# ActivityPods + Media Sidecar: Blob Storage Integration Map

## Overview

ActivityPods uses a **three-layer blob storage architecture** with **isolated per-pod filesystem storage**. The media-pipeline-sidecar currently operates on **processed derivatives** but does **NOT own the canonical blob storage**. This document maps the exact integration points and proposes a unified CID-based approach.

---

## 1. CURRENT ACTIVITYPODS BLOB ARCHITECTURE

### 1.1 Layer Stack

```
┌─────────────────────────────────────────────────────────┐
│ ActivityPub Object Layer (FEP-1311 Attachments)         │
│ - type: Image|Video|Audio                              │
│ - url: https://pods.example/alice/files/photo-1        │
│ - size, mediaType, digestMultibase (optional)           │
└──────────────┬──────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────────┐
│ LDP Container Layer (Linked Data Platform)              │
│ /{username}/files/ - RDF resources + filesystem link    │
│ - Managed by @semapps/ldp framework                     │
│ - Access control via WebACL                             │
└──────────────┬──────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────────┐
│ Filesystem/RDF Storage Layer                            │
│ - RDF metadata: ./data/fuseki/{username}/files          │
│ - Binary blobs: ./uploads/{username}/files/             │
└─────────────────────────────────────────────────────────┘
```

### 1.2 Pod File Directory Structure

```
/pods/alice
├── /files/                          # LDP Container for media
│   ├── photo-1                      # RDF resource URI
│   │   ├── (RDF metadata in Fuseki triplestore)
│   │   └── (Binary blob in ./uploads/alice/photo-1)
│   ├── photo-2
│   └── video-1
├── /posts/                          # ActivityPub posts
│   └── 123
│       └── (object with attachments referencing /files/photo-1)
└── /contacts/
    └── (other pod data)
```

### 1.3 ActivityPub Attachment Model (FEP-1311)

**Current representation:**
```json
{
  "type": "Note",
  "content": "Look at my photo!",
  "attachment": [
    {
      "type": "Image",
      "url": "https://alice.pods.example/files/photo-1",
      "mediaType": "image/jpeg",
      "size": 152000,
      "name": "My vacation photo",
      "digestMultibase": "zQmaeDPzhNL3...",  // Optional, rarely used
      "width": 1200,
      "height": 800,
      "blurHash": "U3O_5XOS9]t8",             // Optional
      "focalPoint": [0.5, 0.3]                // Optional
    }
  ]
}
```

**Key issues:**
- `digestMultibase` field exists but is **never populated** during upload
- No automatic CID computation
- No cross-pod blob sharing
- File deletion orphans from old posts

---

## 2. SIDECAR CURRENT ROLE & LIMITATIONS

### 2.1 Sidecar Scope

**What sidecar OWNS:**
- Remote media ingestion + SSRF validation
- Media transformation (resize, transcode)
- Safety signal collection (Google Vision, etc.)
- Derivative generation (thumbnails, mobile formats)
- Canonical asset indexing + lifecycle events

**What sidecar does NOT own:**
- User pod storage (stays in pod's filesystem/Fuseki)
- ActivityPub object creation/updates
- Access control for media
- Direct blob federation between pods

### 2.2 Current Integration Points

```
┌─ Pod ────────────────────────────────────────────┐
│  POST /files                                      │
│  + user uploads photo.jpg                        │
│  └─> files.service.js                           │
│      ├─ stores RDF metadata in Fuseki           │
│      ├─ stores binary blob in ./uploads/alice   │
│      └─ emits event: "files:uploaded"           │
└──────────────────┬───────────────────────────────┘
                   │
                   │ "files:uploaded" event
                   │ {username, fileId, url, mimeType}
                   ▼
┌─ Sidecar ──────────────────────────────────────┐
│  Media Pipeline                                 │
│  ├─ ingest worker: fetch from pod URL          │
│  ├─ fetch worker: validate + download          │
│  ├─ process worker: transform (resize, etc)    │
│  ├─ analyze worker: safety signals (Vision API)│
│  └─ finalize: store derivatives to Filebase S3 │
└──────────────────────────────────────────────────┘
```

**Problem:** Sidecar fetches media from **pod HTTP URL** (on open internet), not from pod storage directly. No privileged access to pod's filesystem.

---

## 3. EXACT STORAGE MAPPING: Pod vs Sidecar

### 3.1 Pod Storage (`pod-provider/backend`)

**Service:** `services/files.js` + `ControlledContainerMixin`

```typescript
// Pod stores blobs in two places:
1. RDF Metadata (Fuseki triplestore)
   - Type: semapps:File
   - Properties: fileSize, mediaType, name, dateCreated
   - Queryable via SPARQL
   - Located in: ./data/fuseki/{username}/files/

2. Binary Blob (Filesystem)
   - Raw file bytes
   - Located in: ./uploads/{username}/files/{uuid}
   - No deduplication
   - Direct filesystem access via service layer
```

**File Upload Flow (Inside Pod):**
```
HTTP PUT /alice/files/photo
  ↓
ControlledContainerMixin.handlePut()
  ├─ Parse Content-Type header
  ├─ Create RDF resource (semapps:File)
  ├─ Store in Fuseki: /files/photo (RDF metadata)
  ├─ Write binary to: ./uploads/alice/files/{uuid}
  └─ Return: 201 + Location: /alice/files/photo

// RDF Resource:
<https://alice.example/files/photo>
  rdf:type semapps:File
  semapps:fileSize "152000"^^xsd:integer
  dcat:mediaType "image/jpeg"
  dcterms:title "My vacation"
```

### 3.2 Sidecar Storage (`media-pipeline-sidecar`)

**Service:** `storage/filebaseClient.ts`

```typescript
// Sidecar stores derivatives in S3-compatible backend (Filebase)
uploadToFilebase({
  key: `derivatives/${assetId}/thumbnail.webp`,
  body: Buffer<thumbnail bytes>,
  contentType: 'image/webp'
})
  ↓
S3/Filebase Storage
  ├─ derivatives/{assetId}/original.jpg
  ├─ derivatives/{assetId}/thumbnail-640x360.webp
  └─ derivatives/{assetId}/mobile-480x360.jpg
```

**Key difference:** Sidecar has **NO direct pod blob** — it fetches from pod HTTP URL, processes, and stores derivatives elsewhere.

---

## 4. CURRENT DATA FLOW & GAPS

### 4.1 User Uploads Photo to Pod

```
1. Alice uploads photo.jpg to her pod
   POST /alice/files
   Content-Type: image/jpeg
   Body: <binary bytes>

2. Pod stores:
   - RDF: /{pod}/data/fuseki/alice/files/photo.rdf
     <https://alice.pods.example/files/photo>
       a semapps:File ;
       semapps:fileSize "152000"^^xsd:integer ;
       dcat:mediaType "image/jpeg"
   
   - Binary: /uploads/alice/files/abc-123-def

3. Pod returns:
   201 Created
   Location: https://alice.pods.example/files/photo
```

### 4.2 Alice Creates Post with Attachment

```
3. Alice creates post with attachment
   POST /alice/posts
   {
     "type": "Note",
     "content": "Check it out!",
     "attachment": [
       {
         "type": "Image",
         "url": "https://alice.pods.example/files/photo",
         "mediaType": "image/jpeg"
       }
     ]
   }

4. Pod stores post + attachment metadata
```

### 4.3 Bob Receives Post (Federation)

```
5. ActivityPub federation delivers post to bob@otherpod.example

6. Bob's pod:
   - Fetches attachment URL: https://alice.pods.example/files/photo
   - Stores as remote media in his pod's cache
   - Creates attachment reference in his feed

7. Sidecar MIGHT process:
   - Download: https://alice.pods.example/files/photo
   - Transform + store derivatives to Filebase S3
   - Emit safety signals
```

### 4.4 Gaps Identified

**GAP #1: No CID in canonical pod blob**
- Pod does NOT compute/store CID for user-uploaded files
- `digestMultibase` field exists in ActivityPub but is never populated
- Deduplication impossible across pods

**GAP #2: Separate storage systems**
- Pod: Filesystem + Fuseki
- Sidecar: Filebase S3
- No shared blob store
- Inefficient: 2× storage for same media (pod + sidecar)

**GAP #3: No pod-to-pod blob sharing**
- Each pod independently caches remote media
- 100 pods downloading same media = 100 independent copies
- No CID-based federation protocol

**GAP #4: Limited blob lifecycle**
- Pod stores uploaded blob indefinitely (until account deletion)
- No reference counting
- No garbage collection for orphaned files
- No migration path to distributed storage

---

## 5. PROPOSED INTEGRATION: "ActivityPods + Bluesky Model"

### 5.1 Enhanced Pod Storage (CID-Based)

**Phase 1: Add CID Computation**

```typescript
// In pod-provider/backend/services/files.js
// Extend ControlledContainerMixin to compute CID on upload

import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { json } from '@ipld/dag-json'

async function uploadFile(buffer: Buffer, mimeType: string) {
  // Compute CID of blob
  const cid = await computeCID(buffer)
  
  // Store metadata with CID
  const rdfMetadata = {
    '@type': 'semapps:File',
    'semapps:cid': cid.toString(),        // NEW
    'semapps:fileSize': buffer.length,
    'dcat:mediaType': mimeType,
    'dcterms:dateCreated': new Date()
  }
  
  // Store in Fuseki with CID reference
  await storeFusekiTriple(rdfMetadata)
  
  // Store blob using CID as key (enables dedup)
  await storeBlob(`${config.uploadsDir}/${cid}`, buffer)
  
  return { cid, url: `https://pod/files/${cid}` }
}
```

**Phase 2: Reference Counting in Pod**

```typescript
// Track blob references per pod
interface BlobReference {
  cid: string
  recordId: string      // Post URI that references this blob
  uploadedBy: string    // User who uploaded
  createdAt: Date
}

// When post with attachment created:
// 1. Extract CID from attachment
// 2. Create BlobReference entry
// 3. Increment pod's blob.references count

// When post deleted:
// 1. Find all blob references for that post
// 2. Decrement pod's blob.references
// 3. If references === 0, mark for GC after TTL
```

**Phase 3: Pod-Level GC**

```typescript
// Garbage collection job (runs hourly per pod)
async function gcOrphanedBlobs(podUserName: string) {
  const orphaned = await db.BlobReference.find({
    pod: podUserName,
    references: 0,
    createdAt: { $lt: Date.now() - 24*60*60*1000 } // 24h TTL
  })
  
  for (const blob of orphaned) {
    // Delete from filesystem
    await fs.remove(`${config.uploadsDir}/${blob.cid}`)
    // Delete from Fuseki
    await deleteFusekiTriple(blob.cid)
  }
}
```

### 5.2 Enhanced ActivityPub Attachment Format

```json
{
  "type": "Note",
  "content": "Look at my photo!",
  "attachment": [
    {
      "type": "Image",
      "url": "https://alice.pods.example/files/photo",
      "mediaType": "image/jpeg",
      "size": 152000,
      "name": "My vacation photo",
      
      "digestMultibase": "zQmaeDPzhNL32...",  // NOW POPULATED
      "cid": "bafkreigexompbfjsyxmdepqnp4gdcg4yz2odfhkabdszc5evz22kqyvj4",
      
      "width": 1200,
      "height": 800,
      "blurHash": "U3O_5XOS9]t8",
      "focalPoint": [0.5, 0.3]
    }
  ]
}
```

### 5.3 Sidecar Integration Points (Enhanced)

**Change 1: Sidecar can now receive canonical blob CID**

```typescript
// ingest worker receives media reference
interface IngestJob {
  sourceUrl: string         // https://pods/files/photo (existing)
  cid?: string             // NEW: CID from ActivityPub attachment
  podOrigin: string        // NEW: source pod domain
}

// If CID provided:
// - Use CID as canonical identifier
// - Check if already cached locally before fetching
// - Store with CID instead of random UUID
```

**Change 2: Sidecar can participate in pod-to-pod blob sharing**

```typescript
// When Pod B encounters attachment from Pod A
// POST to Pod A's blob federation endpoint:
GET https://alice.pods.example/blobs/{cid}

// If Pod A has it (and public):
// - Stream blob to Pod B
// - Pod B stores locally under same CID
// - Both pods reference same CID
// - Automatic federation-level deduplication
```

**Change 3: Federated storage optimization**

```typescript
// Sidecar's finalize worker
async function finalizeMedia(assetId: string) {
  const asset = await loadAsset(assetId)
  
  // Store derivatives with pod's CID reference
  const derivatives = {
    original: {
      cid: asset.cid,              // Canonical blob CID
      storage: 'pod'               // Stored in pod's Fuseki/filesystem
    },
    thumbnail: {
      cid: computeCID(thumbnailBuffer),
      storage: 'filebase',          // Sidecar derivative storage
      derivedFrom: asset.cid
    },
    mobile: {
      cid: computeCID(mobileBuffer),
      storage: 'filebase',
      derivedFrom: asset.cid
    }
  }
  
  // Emit indexing payload with CID tracking
  await indexer.emit('media:finalized', derivatives)
}
```

---

## 6. INTEGRATION MATRIX: Where Everything Connects

### 6.1 Pod → Sidecar Integration Points

| Operation | Pod Action | Sidecar Trigger | Data Passed |
|-----------|-----------|-----------------|------------|
| **User uploads** | Store blob + RDF in pod | Event: `files:uploaded` | `{username, fileId, cid, url, mimeType}` |
| **Post created** | Create attachment ref | Event: `posts:created` | `{postId, attachments[{cid, url}]}` |
| **Remote media** | Cache remote blob | Event: `media:remote-ingested` | `{sourceUrl, cid, remoteOrigin}` |
| **Post deleted** | Decrement blob refs | Event: `posts:deleted` | `{postId, blobRefs[cid]}` |
| **Pod sync** | Emit GC signal | No trigger (internal) | Blob refs ≤ 0 |

### 6.2 Configuration: Pod ↔ Sidecar Coordination

**Pod config** (`pod-provider/config/config.js`):
```javascript
{
  // Blob storage
  blobStorageBackend: 'filesystem',    // Can extend: 's3', 'ipfs'
  computeCIDOnUpload: true,             // NEW
  blobGCEnabled: true,                  // NEW
  blobGCTTLMs: 24 * 60 * 60 * 1000,    // 24h
  
  // Sidecar coordination
  sidecarUrl: 'http://sidecar:3001',
  sidecarWebhookUrl: '/media/webhook',
  enableBlobFederation: true,           // NEW
  blobFederationPort: 3002              // NEW
}
```

**Sidecar config** (`media-pipeline-sidecar/src/config/config.ts`):
```typescript
export const config = {
  // Pod coordination
  podOrigin: process.env.POD_ORIGIN || 'http://pod:3000',
  podBlobEndpoint: '/blobs',             // NEW
  
  // Storage strategy
  assetStoreBackend: 'redis',            // For multi-instance consistency
  assetStoreRedisPrefix: 'media:asset',
  
  // Blob deduplication
  enableCIDTracking: true,               // NEW
  enableBlobFederation: true,            // NEW
  
  // Versioning
  supportLegacyBytesBase64: true         // Accept old format for migration
}
```

---

## 7. PHASED IMPLEMENTATION ROADMAP

### Phase 1: Pod CID Computation (Week 1-2)

**Goal:** Pod computes + stores CID on upload

**Tasks:**
- [ ] Add `multiformats` + `dag-cbor` dependencies to pod
- [ ] Extend `files.js` service to compute CID on upload
- [ ] Store CID in RDF metadata (Fuseki)
- [ ] Update ActivityPub attachment serializer to include `cid` + `digestMultibase`
- [ ] Test: Upload photo, verify CID in ActivityPub object

**Code locations:**
- `pod-provider/backend/services/files.js` (upload handler)
- `pod-provider/backend/utils` (add CID computation utility)
- `pod-provider/backend/middlewares/media-attachments.js` (add CID to attachment)

**Verification:**
```bash
# Upload test photo
curl -X POST http://localhost:3000/alice/files \
  -H 'Content-Type: image/jpeg' \
  --data-binary @test.jpg

# Verify RDF has CID
curl http://localhost:3000/alice/files/photo | grep semapps:cid

# Verify ActivityPub has CID
curl http://localhost:3000/alice/posts/123 | jq .attachment[0].cid
```

### Phase 2: Reference Counting in Pod (Week 2-3)

**Goal:** Track blob references; prepare for GC

**Tasks:**
- [ ] Add blob reference table to pod DB
- [ ] When post created: record blob references
- [ ] When post deleted: decrement reference counts
- [ ] Initial GC: mark unreferenced blobs for deletion
- [ ] Test: Delete post, verify blob.references decremented

**Code locations:**
- `pod-provider/backend/services/files.js` (ref counting logic)
- `pod-provider/backend/services/posts` (hook into post lifecycle)
- New: `pod-provider/backend/services/blob-lifecycle.service.js`

**Verification:**
```bash
# Create post with attachment
curl -X POST http://localhost:3000/alice/posts \
  -H 'Content-Type: application/activity+json' \
  -d '{...attachment with CID...}'

# Check DB: blob_references table has entry

# Delete post
curl -X DELETE http://localhost:3000/alice/posts/123

# Check DB: blob.references decremented to 0
```

### Phase 3: Sidecar CID Input Support (Week 3-4)

**Goal:** Sidecar accepts + tracks CID; enables cross-pod reference checking

**Tasks:**
- [ ] Modify sidecar ingest worker: accept optional `cid` parameter
- [ ] Add blob dedup check: if CID exists locally, skip re-fetch
- [ ] Store asset with CID instead of random UUID
- [ ] Test: Upload same file twice via two pods; verify dedup

**Code locations:**
- `media-pipeline-sidecar/src/ingest/ingestWorker.ts` (add CID param)
- `media-pipeline-sidecar/src/storage/assetStore.ts` (CID-based keying)
- `media-pipeline-sidecar/src/contracts/CanonicalAsset.ts` (add `cid` field)

**Verification:**
```bash
# Emit ingest job with CID
redis> XADD media:ingest * sourceUrl="https://pods/files/photo" \
         cid="bafkrei..." podOrigin="pods.example"

# Check: asset stored with CID as key
redis> HGET media:asset:bafkrei... assetId
# Should return: bafkrei...
```

### Phase 4: Pod-to-Pod Blob Federation (Week 4-5)

**Goal:** Pods can request blobs from each other via CID

**Tasks:**
- [ ] Add blob federation endpoint to pod: `GET /blobs/{cid}`
- [ ] Access control: check if CID is public/federated
- [ ] Sidecar: when receiving remote media, try pod federation first
- [ ] Test: Pod B requests blob from Pod A; verify successful transfer

**Code locations:**
- New: `pod-provider/backend/services/blob-federation.service.js`
- `media-pipeline-sidecar/src/workers/fetchWorker.ts` (add pod federation fetch strategy)
- `media-pipeline-sidecar/src/security/ssrfGuard.ts` (update SSRF rules for pod federation)

**Verification:**
```bash
# Request blob from Pod A via CID
curl http://alice.pods.example/blobs/bafkrei... \
  -H 'Accept: image/jpeg'
# Should return: 200 + blob bytes

# Sidecar fetches via CID first
# Check logs: "Blob federation: fetching from alice.pods.example"
```

### Phase 5: Pod-Level Garbage Collection (Week 5-6)

**Goal:** Unreferenced blobs auto-deleted after TTL

**Tasks:**
- [ ] Add GC job to pod: runs hourly
- [ ] Find blobs with references = 0 + expired TTL
- [ ] Delete from filesystem + Fuseki
- [ ] Emit event: `blob:collected` for audit
- [ ] Test: Create + delete post; verify blob cleaned after TTL

**Code locations:**
- `pod-provider/backend/services/blob-lifecycle.service.js` (GC job)
- `pod-provider/backend/config/config.js` (GC_TTL_MS, GC_ENABLED settings)

**Verification:**
```bash
# Manual GC trigger (for testing)
curl -X POST http://localhost:3000/admin/gc/blobs \
  -H 'Authorization: Bearer <admin-token>'

# Check: orphaned blobs deleted from filesystem
ls /uploads/alice/files/ | wc -l
# Should show fewer files after GC
```

### Phase 6: Sidecar Derivative Storage Linking (Week 6)

**Goal:** Sidecar derivatives linked to canonical blob CID

**Tasks:**
- [ ] Finalize worker: emit derivative references with canonical CID
- [ ] Index payload includes: `{canonical_cid, derivatives[thumbnail, mobile]}`
- [ ] Enable downstream systems to trace derivatives → canonical
- [ ] Test: Verify indexing payload has proper CID chain

**Code locations:**
- `media-pipeline-sidecar/src/workers/finalizeWorker.ts` (update payload schema)
- `media-pipeline-sidecar/src/contracts/CanonicalAsset.ts` (add derivative tracking)
- `media-pipeline-sidecar/src/indexing/` (update indexer to track CID chain)

---

## 8. DATA MODEL: Exact Schema Changes

### 8.1 Pod RDF Schema Extension

**Current:**
```turtle
<https://alice.pods.example/files/photo-1>
  rdf:type semapps:File ;
  dcterms:title "Vacation Photo" ;
  semapps:fileSize "152000"^^xsd:integer ;
  dcat:mediaType "image/jpeg" ;
  dcterms:dateCreated "2024-04-10T12:00:00Z"^^xsd:dateTime .
```

**Extended (Phase 1):**
```turtle
<https://alice.pods.example/files/photo-1>
  rdf:type semapps:File ;
  dcterms:title "Vacation Photo" ;
  semapps:fileSize "152000"^^xsd:integer ;
  dcat:mediaType "image/jpeg" ;
  semapps:blobCID "bafkreigexompbfjsyxmdepqnp4gdcg4yz2odfhkabdszc5evz22kqyvj4" ;    # NEW
  dcterms:dateCreated "2024-04-10T12:00:00Z"^^xsd:dateTime .
```

### 8.2 Pod Database Schema Extension

**New table for Phase 2:**
```sql
CREATE TABLE blob_references (
  id UUID PRIMARY KEY,
  pod_username VARCHAR NOT NULL,
  blob_cid VARCHAR NOT NULL,
  record_id VARCHAR NOT NULL,       -- URI of post/object referencing blob
  record_type VARCHAR,               -- 'post', 'profile', etc.
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(pod_username, blob_cid, record_id),
  FOREIGN KEY (pod_username) REFERENCES pods(username)
);

CREATE TABLE blob_lifecycle (
  cid VARCHAR PRIMARY KEY,
  pod_username VARCHAR NOT NULL,
  state VARCHAR DEFAULT 'active',    -- 'active', 'orphaned', 'pending_gc'
  references_count INT DEFAULT 1,
  uploaded_at TIMESTAMP DEFAULT NOW(),
  gc_scheduled_at TIMESTAMP,         -- When marked for deletion
  created_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (pod_username) REFERENCES pods(username)
);
```

### 8.3 Sidecar Contract Extension

**Current CanonicalAsset:**
```typescript
interface CanonicalAsset {
  assetId: string;              // UUID or object key
  traceId: string;
  sourceUrl: string;
  mimeType: string;
  sizeBytes: number;
  fetchedAt: Date;
  createdAt: Date;
}
```

**Extended (Phase 3):**
```typescript
interface CanonicalAsset {
  assetId: string;              // Now: CID if available, else UUID
  cid?: string;                 // NEW: canonical CID if source is pod blob
  podOrigin?: string;           // NEW: source pod domain
  traceId: string;
  sourceUrl: string;
  mimeType: string;
  sizeBytes: number;
  fetchedAt: Date;
  createdAt: Date;
  
  // Phase 6: derivative chain
  derivativeChain?: {           // NEW
    canonical_cid: string;
    derivatives: {
      thumbnail: { cid: string; storage: 'filebase' };
      mobile: { cid: string; storage: 'filebase' };
    };
  };
}
```

---

## 9. EXACT CONNECTION POINTS: Code File Map

### Pod → Sidecar Communication

| Trigger | Pod Code | Event/Webhook | Sidecar Handler |
|---------|----------|---------------|-----------------|
| File upload | `services/files.js:handlePut()` | `files:uploaded` | `ingest/ingestWorker.ts` |
| Post creation | `services/posts.js:handleCreate()` | `posts:created` | `queue/redisClient.ts:emitEvent()` |
| Post deletion | `services/posts.js:handleDelete()` | `posts:deleted` | `workers/finalizeWorker.ts:cleanupReferences()` |
| Media federation | `services/blob-federation.js:handleGetBlob()` | N/A (HTTP) | `workers/fetchWorker.ts:fetchFromPodFederation()` |

### Sidecar → Pod Communication

| Direction | Sidecar Code | Pod Endpoint | Data |
|-----------|--------------|--------------|------|
| Fetch blob | `workers/fetchWorker.ts` | `GET /{username}/files/{cid}` | Raw bytes |
| Report processed | `workers/finalizeWorker.ts` | Webhook: `/media/webhook` | `{assetId, cid, derivatives}` |
| Query pod blobs | `security/ssrfGuard.ts` | `GET /blobs?q={cid}` | Blob metadata |

---

## 10. VALIDATION CHECKPOINTS

### After Phase 1 (CID Computation)

```typescript
// Test: Upload returns CID
const response = await fetch('http://pod/alice/files', {
  method: 'POST',
  headers: { 'Content-Type': 'image/jpeg' },
  body: photoBuffer
});
const fileUri = response.headers.get('location');  // /alice/files/{uuid}

// Verify CID in ActivityPub
const apObject = await fetch(fileUri, {
  headers: { 'Accept': 'application/activity+json' }
}).then(r => r.json());

assert(apObject.cid === 'bafkrei...');
assert(apObject.digestMultibase === 'zQmae...');
```

### After Phase 2 (Reference Counting)

```typescript
// Test: Blob refs tracked
const blob1 = await uploadFile('photo.jpg');
const post1 = await createPost({ attachment: blob1.cid });
const post2 = await createPost({ attachment: blob1.cid });

// Query: 2 posts reference blob
const refs = await db.query(
  'SELECT COUNT(*) FROM blob_references WHERE blob_cid = ?',
  [blob1.cid]
);
assert(refs[0].count === 2);

// Delete post 1
await deletePost(post1.id);

// Query: now 1 post references blob
assert((await getRefCount(blob1.cid)) === 1);
```

### After Phase 4 (Pod Federation)

```typescript
// Test: Pod A has blob, Pod B can request it
const blobCID = 'bafkrei...';
const blobFromA = await fetch(
  `http://alice.pods.example/blobs/${blobCID}`
);
assert(blobFromA.status === 200);

// Sidecar uses federation fetch
const sidecarFetch = await sidecarClient.fetchMedia(
  `https://alice.pods.example/files/photo`,
  { cid: blobCID }
);
// Should log: "Using pod federation endpoint for CID bafkrei..."
```

---

## 11. CRITICAL ACCURACY NOTES

### Connection Points Must-Know

1. **Pod filesystem is NOT sidecar accessible**
   - Pod stores blobs at: `/uploads/{username}/files/{uuid}`
   - Sidecar has NO filesystem access to pod
   - Sidecar must fetch via HTTP (public URL or federation endpoint)

2. **RDF Metadata requires Fuseki SPARQL updates**
   - Pod uses Fuseki triplestore for media metadata
   - CID must be stored as RDF triple: `semapps:blobCID`
   - Queries require SPARQL, not direct DB access

3. **ActivityPub attachment format is immutable in object**
   - Once post created with attachment, CID becomes canonical identifier
   - Changing CID = breaking ActivityPub references
   - Must include CID at post-creation time, not retroactively

4. **Sidecar derivatives ≠ canonical blob**
   - Sidecar processes COPIES of pod blob
   - Original stays in pod
   - Derivatives stored in Filebase S3
   - Reference tracking must distinguish: canonical (`pod`) vs derivative (`filebase`)

5. **Reference counting prevents accidental deletion**
   - Multiple posts can reference same CID
   - Deletion of one post must NOT delete blob
   - Only delete when references reach 0
   - TTL grace period prevents "temporary orphan" issues during post creation race conditions

### Security Considerations

1. **SSRF protection when requesting blobs**
   - Pod federation endpoint could be exploited
   - Sidecar must validate pod domain against allowlist
   - Only public/federated blobs should be shared

2. **Access control on blob federation**
   - Private media must NOT be exposed via `/blobs/{cid}`
   - Check WebACL (pod's built-in access control)
   - Return 403 if unauthorized

3. **No CID collision**
   - Same blob = same CID = deterministic
   - ONLY if binary content identical
   - Hash algorithm: SHA2-256 (standard for CID)
   - Collisions: astronomically unlikely (2^256)

---

## 12. SUMMARY: The Three-Step Mental Model

### Step 1: Pod Storage (User's Private Ownership)
- User uploads to pod: `/alice/files/photo`
- Pod computes CID: `bafkrei...`
- Pod stores: RDF metadata + binary blob
- Pod controls access (WebACL)

### Step 2: sidecar Processing (Derivative Generation)
- Sidecar fetches from pod (via HTTP)
- Sidecar transforms (resize, transcode)
- Sidecar stores derivatives to S3 (with CID backref)
- Sidecar emits lifecycle events

### Step 3: Federation Sharing (Pod-to-Pod)
- Post shared: includes CID reference
- Other pod receives CID
- Other pod can request blob from original pod (via `/blobs/{cid}`)
- Automatic deduplication: 100 pods request same CID = 1 transfer

**This structure preserves:**
- User data sovereignty (pod owns blobs)
- Sidecar efficiency (processes once, derivatives copied)
- Federation scalability (CID enables efficient sharing)

---

## 13. App Upload Flow: Memory App -> Correct User Pod

The critical rule is that app-originated media is written through the authenticated user's pod-scoped container path, not a shared global bucket in ActivityPods.

### 13.1 Request path and ownership binding

1. User signs into an ActivityPods app (for example, Memory) using their pod identity.
2. App uploads media to the user's pod file container endpoint (for example `/{username}/files`).
3. Pod backend binds the write to the authenticated pod dataset and container permissions.
4. Blob lands in that user's storage namespace:
  - RDF metadata in Fuseki: `./data/fuseki/{username}/files`
  - Binary bytes in uploads path: `./uploads/{username}/files/...`
5. Post or profile objects reference the resulting pod-local media URL.

Result: media ownership and residency are anchored to the correct user pod by route scope + auth context, not by app origin.

### 13.2 Sidecar processing for app uploads

When sidecar processing is enabled, the sidecar receives a resolvable media URL tied to the uploader's pod object. It then:

1. Resolves/downloads the bytes from the internal bridge resolver.
2. Applies validation + transformation.
3. Stores processed/cached derivatives in S3-compatible object storage.
4. Keeps canonical ownership semantics in the pod record model.

This means apps like Memory can be thin clients while pod residency guarantees remain intact.

---

## 14. S3 Provider Portability and Filebase/IPFS Impact

### 14.1 S3 portability status

The media-pipeline-sidecar uses the AWS S3 SDK and can run against any S3-compatible provider as long as these operations behave normally:

- `PutObject`
- `GetObject`
- `DeleteObject`

Recommended portability settings:

- Use provider-specific `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, and credentials.
- Keep `S3_FORCE_PATH_STYLE=true` unless your provider requires virtual-host style.
- Set `S3_PUBLIC_BASE_URL` when public delivery URL should differ from API endpoint.

### 14.2 Filebase/IPFS-specific impact

Using Filebase introduces optional IPFS gateway semantics in addition to S3 object operations.

Effects to account for:

- CID-based gateway links (`IPFS_GATEWAY_BASE`) can improve portability of content-addressed references.
- Gateway performance/availability can differ from direct object URL delivery.
- For user-facing low-latency delivery, CDN/object URLs should remain primary and IPFS links should be treated as alternate distribution paths.
- Metadata and ownership authority still lives in ActivityPods pod records, not in the gateway URL.

Net: Filebase does not block multi-provider S3 compatibility, but IPFS gateway behavior is an additional operational dimension (latency, cache propagation, and URL strategy).

---

## NEXT IMMEDIATE STEPS

1. **Create PR for Phase 1** (Pod CID computation)
   - Target files: `services/files.js`, new utils for CID
   - Test: Verify ActivityPub attachment includes CID

2. **Bench test current sidecar**
   - Measure: duplicate upload → separate storage
   - Baseline before optimizations

3. **Schema migration plan**
   - Non-breaking: add columns, don't remove
   - Backward compat: accept both CID + UUID keying
   - Test: old files still accessible after migration
