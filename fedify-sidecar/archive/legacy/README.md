# Legacy Code Archive

This directory contains outdated implementations from earlier sidecar architecture versions. These files are **NOT** part of the active codebase and should **NOT** be used.

## Archived Files

### Queue Implementations
- **redpanda-message-queue.ts** - v3 implementation using RedPanda as work queue (INCORRECT per v5)
  - Incorrectly treats RedPanda as work queue instead of event log
  - Mishandles delay semantics
  - Use `src/queue/sidecar-redis-queue.ts` instead

### Delivery Workers
- **delivery-worker.ts** - v3 generic delivery worker
  - Expects different job fields
  - Imports non-existent queue factory
  - Use `src/delivery/outbound-worker.ts` instead

- **domain-batched-worker.ts** - v3 domain-batched delivery
  - Uses RedPanda-path architecture
  - Contains local signature caching (INCORRECT - keys never leave ActivityPods)
  - Incomplete signing API integration
  - Use `src/delivery/outbound-worker.ts` instead

### Handlers
- **inbound-handler.ts** - v3 inbound handler
  - **SECURITY ISSUE**: Signature verifier is stubbed and accepts any request with signature field
  - Use `src/delivery/inbound-worker.ts` instead

### Services
- **signing.ts** / **signing.js** - v3 local signing service
  - Implements single-request signing with local key caching
  - Makes keyId assumptions like `${actorId}#main-key`
  - **INCORRECT per v5**: Keys must never leave ActivityPods
  - Use `src/signing/signing-client.ts` (calls ActivityPods signing API) instead

## Why These Were Archived

The v5 architecture represents a fundamental redesign:

1. **Queue Layer**: Redis Streams for work queues, RedPanda for event logs only
2. **Signing**: Keys never leave ActivityPods; sidecar calls internal signing API
3. **Inbound Verification**: Sidecar verifies HTTP signatures, then forwards to ActivityPods
4. **Error Handling**: Proper permanent vs retryable error classification
5. **Configuration**: Unified token management, explicit feature flags

These legacy files represent incompatible designs and should not be referenced for new development.

## If You Need Historical Reference

These files are preserved for:
- Understanding the evolution of the architecture
- Comparing old vs new approaches
- Learning what NOT to do

For any new work, refer to the active implementation in `src/` and the v5 architecture documentation.
