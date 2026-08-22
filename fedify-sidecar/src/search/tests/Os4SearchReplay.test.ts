import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSearchIndexerService } from '../service/SearchIndexerService.js';

afterEach(() => {
  vi.useRealTimers();
});

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

function serviceWithProjector(options: { fail?: boolean; maxProcessingAttempts?: number } = {}) {
  const service = createSearchIndexerService({
    brokers: ['localhost:9092'],
    redis: null,
    maxProcessingAttempts: options.maxProcessingAttempts ?? 2,
    backpressureRetryDelayMs: 60_000,
  });
  const has = vi.fn(async () => false);
  const claim = vi.fn(async () => true);
  const send = vi.fn(async () => []);
  const onApFirehoseEvent = options.fail
    ? vi.fn(async () => { throw new Error('opensearch unavailable'); })
    : vi.fn(async () => undefined);
  (service as any).outboxIntentDeduper = { has, claim };
  (service as any).producer = { send };
  (service as any).projector = {
    onApFirehoseEvent,
    onApTombstoneEvent: onApFirehoseEvent,
  };
  return { service, has, claim, send, onApFirehoseEvent };
}

describe('OS4 search replay ordering', () => {
  it('records completion only after a successful projection and before resolving the offset', async () => {
    const { service, has, claim, onApFirehoseEvent } = serviceWithProjector();
    const raw = JSON.stringify({ outboxIntentId: 'intent-os4', activity: { id: 'success' } });
    const { payload, resolveOffset, heartbeat } = makePayload(raw);
    const order: string[] = [];

    has.mockImplementation(async () => { order.push('has'); return false; });
    onApFirehoseEvent.mockImplementation(async () => { order.push('project'); });
    claim.mockImplementation(async () => { order.push('complete'); return true; });
    resolveOffset.mockImplementation(() => { order.push('resolve'); });

    await (service as any).processBatch(payload);

    expect(order).toEqual(['has', 'project', 'complete', 'resolve']);
    expect(resolveOffset).toHaveBeenCalledWith('17');
    expect(heartbeat).toHaveBeenCalledOnce();
  });

  it('does not record completion or resolve the offset on transient projection failure', async () => {
    vi.useFakeTimers();
    const { service, has, claim, send } = serviceWithProjector({ fail: true, maxProcessingAttempts: 2 });
    const raw = JSON.stringify({ outboxIntentId: 'intent-os4', activity: { id: 'a1' } });
    const { payload, resolveOffset, heartbeat, pause } = makePayload(raw);

    await (service as any).processBatch(payload);

    expect(has).toHaveBeenCalledWith('intent-os4');
    expect(claim).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(resolveOffset).not.toHaveBeenCalled();
    expect(heartbeat).not.toHaveBeenCalled();
    expect(pause).toHaveBeenCalledOnce();
    vi.clearAllTimers();
  });

  it('publishes the original payload to DLQ before resolving a poison offset', async () => {
    const { service, claim, send } = serviceWithProjector({ fail: true, maxProcessingAttempts: 1 });
    const raw = JSON.stringify({ outboxIntentId: 'intent-os4', activity: { id: 'a2' } });
    const { payload, resolveOffset, heartbeat, pause } = makePayload(raw);

    await (service as any).processBatch(payload);

    expect(claim).not.toHaveBeenCalled();
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
    const { service } = serviceWithProjector({ fail: true, maxProcessingAttempts: 1 });
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
