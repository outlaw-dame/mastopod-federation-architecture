import { describe, expect, it, vi } from 'vitest';
import { createSearchIndexerService } from '../service/SearchIndexerService.js';

function makePayload(raw: string, pause = vi.fn(() => vi.fn())) {
  const resolveOffset = vi.fn();
  const heartbeat = vi.fn(async () => undefined);
  return {
    payload: {
      batch: {
        topic: 'ap.firehose.v1',
        partition: 2,
        messages: [{
          offset: '17',
          value: Buffer.from(raw, 'utf8'),
          headers: { 'outbox-intent-id': Buffer.from('intent-os4', 'utf8') },
        }],
      },
      resolveOffset,
      heartbeat,
      isRunning: () => true,
      isStale: () => false,
      pause,
    } as any,
    resolveOffset,
    heartbeat,
    pause,
  };
}

function failingService(maxProcessingAttempts: number) {
  const service = createSearchIndexerService({
    brokers: ['localhost:9092'],
    redis: null,
    maxProcessingAttempts,
    backpressureRetryDelayMs: 60_000,
  });
  const claim = vi.fn(async () => true);
  const release = vi.fn(async () => undefined);
  const send = vi.fn(async () => []);
  (service as any).outboxIntentDeduper = { claim, release };
  (service as any).producer = { send };
  (service as any).projector = {
    onApFirehoseEvent: vi.fn(async () => { throw new Error('opensearch unavailable'); }),
    onApTombstoneEvent: vi.fn(async () => { throw new Error('opensearch unavailable'); }),
  };
  return { service, claim, release, send };
}

describe('OS4 search replay ordering', () => {
  it('releases a claimed intent and leaves the offset unresolved on transient failure', async () => {
    const { service, claim, release, send } = failingService(2);
    const raw = JSON.stringify({ outboxIntentId: 'intent-os4', activity: { id: 'a1' } });
    const { payload, resolveOffset, heartbeat, pause } = makePayload(raw);

    await (service as any).processBatch(payload);

    expect(claim).toHaveBeenCalledWith('intent-os4');
    expect(release).toHaveBeenCalledWith('intent-os4');
    expect(send).not.toHaveBeenCalled();
    expect(resolveOffset).not.toHaveBeenCalled();
    expect(heartbeat).not.toHaveBeenCalled();
    expect(pause).toHaveBeenCalledOnce();
  });

  it('publishes the original payload to DLQ before resolving a poison offset', async () => {
    const { service, release, send } = failingService(1);
    const raw = JSON.stringify({ outboxIntentId: 'intent-os4', activity: { id: 'a2' } });
    const { payload, resolveOffset, heartbeat, pause } = makePayload(raw);

    await (service as any).processBatch(payload);

    expect(release).toHaveBeenCalledWith('intent-os4');
    expect(pause).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();

    const record = send.mock.calls[0]?.[0] as any;
    expect(record.topic).toBe('ap.search-indexer.dlq.v1');
    expect(record.messages[0].value).toBe(raw);
    expect(record.messages[0].headers['search-dlq-source-topic']).toBe('ap.firehose.v1');
    expect(record.messages[0].headers['search-dlq-source-partition']).toBe('2');
    expect(record.messages[0].headers['search-dlq-source-offset']).toBe('17');
    expect(record.messages[0].headers['search-dlq-attempts']).toBe('1');
    expect(resolveOffset).toHaveBeenCalledWith('17');
    expect(heartbeat).toHaveBeenCalledOnce();
  });

  it('does not resolve the source offset if DLQ publication fails', async () => {
    const { service } = failingService(1);
    (service as any).producer = {
      send: vi.fn(async () => { throw new Error('redpanda unavailable'); }),
    };
    const raw = JSON.stringify({ outboxIntentId: 'intent-os4', activity: { id: 'a3' } });
    const { payload, resolveOffset, heartbeat } = makePayload(raw);

    await expect((service as any).processBatch(payload)).rejects.toThrow(/redpanda unavailable/);
    expect(resolveOffset).not.toHaveBeenCalled();
    expect(heartbeat).not.toHaveBeenCalled();
  });
});
