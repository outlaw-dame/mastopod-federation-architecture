import { afterEach, describe, expect, it, vi } from 'vitest';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { createSearchIndexerService } from '../service/SearchIndexerService.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('OS4 canonical search ingestion policy', () => {
  it('defaults to bounded retries and a replayable search DLQ', () => {
    const service = createSearchIndexerService({
      brokers: ['localhost:9092'],
      redis: null,
    });
    const config = (service as any).config;

    expect(config.dlqTopic).toBe('ap.search-indexer.dlq.v1');
    expect(config.maxProcessingAttempts).toBe(5);
    expect(config.backpressureRetryDelayMs).toBeGreaterThan(0);
  });

  it('invokes the KafkaJS resume callback after bounded backpressure', async () => {
    vi.useFakeTimers();
    const service = createSearchIndexerService({
      brokers: ['localhost:9092'],
      redis: null,
      backpressureRetryDelayMs: 25,
    });
    (service as any).isRunning = true;

    const resume = vi.fn();
    const pause = vi.fn(() => resume);
    (service as any).activateBackpressure(pause);

    expect(pause).toHaveBeenCalledOnce();
    expect(resume).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(25);
    expect(resume).toHaveBeenCalledOnce();
    expect((service as any).backpressureActive).toBe(false);
  });

  it('keeps the historical Redpanda Connect firehose sink outside the active streams glob', async () => {
    const sidecarRoot = resolve(process.cwd());
    const activePath = resolve(sidecarRoot, 'redpanda-connect/streams/01-firehose-to-opensearch.yaml');
    const archivePath = resolve(sidecarRoot, 'redpanda-connect/archive/01-firehose-to-opensearch.yaml');

    await expect(access(activePath, constants.F_OK)).rejects.toThrow();
    await expect(access(archivePath, constants.F_OK)).resolves.toBeUndefined();

    const overlay = await readFile(
      resolve(sidecarRoot, 'redpanda-connect/docker-compose.connect.yml'),
      'utf8',
    );
    expect(overlay).toContain('/redpanda-connect/streams/*.yaml');
    expect(overlay).not.toContain('/redpanda-connect/archive/*.yaml');
    expect(overlay).toContain('opensearchproject/opensearch:3.8.0');
  });
});
