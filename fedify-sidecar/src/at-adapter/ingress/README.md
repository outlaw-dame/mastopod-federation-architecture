# AT Protocol Ingress Pipeline (Phase 5.5)

This directory contains the full intake pipeline for federated AT Protocol content.

## Architecture

1. **AtFirehoseConsumer**: Connects to an upstream relay (e.g. `wss://relay.bsky.network`), handles ping/pong, exponential backoff, and tracks cursors.
2. **AtFirehoseDecoder**: Cheaply decodes CBOR headers to route events.
3. **AtIngressEventClassifier**: Filters events by relevant DIDs (allowlist) and deduplicates them using a 24h sliding window.
4. **AtIngressVerifier**: Cryptographically verifies commits, re-resolves identities, and rebuilds sync state.
5. **AtIngressWebhookForwarder**: Forwards fully verified `at.ingress.v1` events to downstream consumers (like the Memory UI) via HMAC-authenticated HTTP webhooks with exponential backoff retries.

## Local Testing

You can run the entire pipeline locally without needing a live AT Firehose or a running Memory UI instance. The local test harness spins up a mock WebSocket firehose, runs the pipeline in-memory, and catches the output with a mock webhook receiver.

To run the test harness:

```bash
npm run test:harness
```

### What the harness does:
1. Starts a **Mock AT Firehose** on `ws://localhost:8999` emitting a `#commit` event every 2 seconds.
2. Starts a **Mock Webhook Receiver** on `http://localhost:8998/at/webhook/ingress`.
3. Boots the **Ingress Pipeline** with in-memory dependencies (no Redis/RedPanda required).
4. Connects the pipeline to the mock firehose.
5. You will see the events flow from the mock firehose $\rightarrow$ consumer $\rightarrow$ verifier $\rightarrow$ webhook forwarder $\rightarrow$ mock receiver.

## Production Setup

In production, the `AtIngressWebhookForwarder` must be registered with the downstream URL and a shared secret:

```typescript
const forwarder = new AtIngressWebhookForwarder();

forwarder.registerEndpoint({
  id: 'memory-ui',
  url: 'https://api.memory.app/at/webhook/ingress',
  secret: process.env.FIREHOSE_BRIDGE_SECRET, // Must match the downstream API
});
```
