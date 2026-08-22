/**
 * OpenSearchBootstrapService — OS3 unit tests.
 */

import { describe, expect, it, vi } from 'vitest';
import { OpenSearchBootstrapService } from '../service/OpenSearchBootstrapService.js';

type StubCallRecord = { method: string; args: unknown[] };

function buildHealthyClusterStub(calls: StubCallRecord[]) {
  return {
    cluster: {
      health: vi.fn(async () => {
        calls.push({ method: 'cluster.health', args: [] });
        return { body: { status: 'yellow' } };
      }),
    },
    indices: {
      exists: vi.fn(async () => {
        calls.push({ method: 'indices.exists', args: [] });
        return { body: false };
      }),
      create: vi.fn(async ({ index, body }: { index: string; body: any }) => {
        calls.push({ method: 'indices.create', args: [index, body] });
        return { body: {} };
      }),
      putMapping: vi.fn(async () => ({ body: {} })),
      putSettings: vi.fn(async () => ({ body: {} })),
    },
    close: vi.fn(async () => {}),
  };
}

function buildAlreadyExistsStub(calls: StubCallRecord[]) {
  return {
    cluster: {
      health: vi.fn(async () => ({ body: { status: 'green' } })),
    },
    indices: {
      exists: vi.fn(async () => ({ body: true })),
      create: vi.fn(async () => {
        calls.push({ method: 'indices.create', args: ['SHOULD_NOT_CREATE'] });
        return { body: {} };
      }),
      putMapping: vi.fn(async () => {
        calls.push({ method: 'indices.putMapping', args: [] });
        return { body: {} };
      }),
      putSettings: vi.fn(async (args: Record<string, unknown>) => {
        calls.push({ method: 'indices.putSettings', args: [args] });
        return { body: {} };
      }),
    },
    close: vi.fn(async () => {}),
  };
}

const FAST_CONFIG = {
  opensearchUrl: 'http://localhost:9200',
  opensearchSslVerify: false,
  maxRetries: 3,
  baseRetryDelayMs: 10,
  maxRetryDelayMs: 50,
  bootstrapTimeoutMs: 10_000,
};

describe('OpenSearchBootstrapService', () => {
  it('creates only public content and author indices on a fresh cluster', async () => {
    const calls: StubCallRecord[] = [];
    const stub = buildHealthyClusterStub(calls);
    const service = new OpenSearchBootstrapService(FAST_CONFIG);
    (service as any).client = stub;

    await service.bootstrap();

    expect(stub.indices.create).toHaveBeenCalledTimes(2);
    expect(stub.indices.putSettings).not.toHaveBeenCalled();
    const creates = calls.filter((call) => call.method === 'indices.create');
    const createdIndices = creates.map((call) => call.args[0]);
    expect(createdIndices).toEqual(expect.arrayContaining(['public-content-v1', 'public-author-v1']));

    const contentCreate = creates.find((call) => call.args[0] === 'public-content-v1');
    const contentBody = contentCreate?.args[1] as any;
    expect(contentBody.settings?.index?.knn).toBeUndefined();
    expect(contentBody.settings?.index?.default_pipeline).toBeUndefined();
    expect(contentBody.mappings?.properties?.embedding).toBeUndefined();
    expect(contentBody.mappings?.properties?.embeddingStatus).toBeUndefined();
    expect(contentBody.mappings?.properties?.embeddingUpdatedAt).toBeUndefined();
  });

  it('checks cluster health before writes', async () => {
    const calls: StubCallRecord[] = [];
    const stub = buildHealthyClusterStub(calls);
    const service = new OpenSearchBootstrapService(FAST_CONFIG);
    (service as any).client = stub;

    await service.bootstrap();

    expect(stub.cluster.health).toHaveBeenCalledOnce();
    expect(calls[0]?.method).toBe('cluster.health');
  });

  it('clears the legacy content default pipeline and applies additive mappings on existing indices', async () => {
    const calls: StubCallRecord[] = [];
    const stub = buildAlreadyExistsStub(calls);
    const service = new OpenSearchBootstrapService(FAST_CONFIG);
    (service as any).client = stub;

    await service.bootstrap();

    expect(stub.indices.create).not.toHaveBeenCalled();
    expect(stub.indices.putMapping).toHaveBeenCalledTimes(2);
    expect(stub.indices.putSettings).toHaveBeenCalledTimes(1);
    expect(stub.indices.putSettings).toHaveBeenCalledWith({
      index: 'public-content-v1',
      body: { index: { default_pipeline: '_none' } },
    });
  });

  it('retries unhealthy cluster probes until healthy', async () => {
    let probeCount = 0;
    const stub = {
      cluster: {
        health: vi.fn(async () => {
          probeCount += 1;
          return { body: { status: probeCount < 3 ? 'red' : 'yellow' } };
        }),
      },
      indices: {
        exists: vi.fn(async () => ({ body: false })),
        create: vi.fn(async () => ({ body: {} })),
        putMapping: vi.fn(async () => ({ body: {} })),
        putSettings: vi.fn(async () => ({ body: {} })),
      },
      close: vi.fn(async () => {}),
    };
    const service = new OpenSearchBootstrapService(FAST_CONFIG);
    (service as any).client = stub;

    await service.bootstrap();

    expect(probeCount).toBe(3);
  });

  it('throws when cluster health exhausts retries', async () => {
    const service = new OpenSearchBootstrapService({
      ...FAST_CONFIG,
      maxRetries: 2,
      baseRetryDelayMs: 1,
      maxRetryDelayMs: 5,
    });
    (service as any).client = {
      cluster: { health: vi.fn(async () => { throw new Error('connection refused'); }) },
      close: vi.fn(async () => {}),
    };

    await expect(service.bootstrap()).rejects.toThrow(/not reachable after/);
  });

  it('does not fail startup when an additive mapping update is rejected', async () => {
    const service = new OpenSearchBootstrapService(FAST_CONFIG);
    (service as any).client = {
      cluster: { health: vi.fn(async () => ({ body: { status: 'yellow' } })) },
      indices: {
        exists: vi.fn(async () => ({ body: true })),
        create: vi.fn(async () => ({ body: {} })),
        putSettings: vi.fn(async () => ({ body: {} })),
        putMapping: vi.fn(async () => {
          throw new Error('mapper [text] cannot be changed');
        }),
      },
      close: vi.fn(async () => {}),
    };

    await expect(service.bootstrap()).resolves.toBeUndefined();
  });

  it('fails closed if the legacy content default pipeline cannot be disabled', async () => {
    const service = new OpenSearchBootstrapService({
      ...FAST_CONFIG,
      maxRetries: 1,
    });
    (service as any).client = {
      cluster: { health: vi.fn(async () => ({ body: { status: 'yellow' } })) },
      indices: {
        exists: vi.fn(async () => ({ body: true })),
        putSettings: vi.fn(async () => {
          throw new Error('put settings rejected');
        }),
        putMapping: vi.fn(async () => ({ body: {} })),
      },
      close: vi.fn(async () => {}),
    };

    await expect(service.bootstrap()).rejects.toThrow(/put settings rejected/);
  });

  it('enforces the bootstrap deadline', async () => {
    const service = new OpenSearchBootstrapService({
      ...FAST_CONFIG,
      maxRetries: 5,
      baseRetryDelayMs: 1,
      maxRetryDelayMs: 5,
      bootstrapTimeoutMs: 50,
    });
    (service as any).client = {
      cluster: {
        health: vi.fn(
          () => new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 200)),
        ),
      },
      close: vi.fn(async () => {}),
    };

    await expect(service.bootstrap()).rejects.toThrow(/[Dd]eadline|not reachable after/);
  });
});
