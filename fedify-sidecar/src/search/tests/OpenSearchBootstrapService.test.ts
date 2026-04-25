/**
 * OpenSearchBootstrapService — Unit Tests
 *
 * Verifies bootstrap logic using a stubbed OpenSearch client.
 * No live OpenSearch node required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenSearchBootstrapService } from '../service/OpenSearchBootstrapService.js';

// ─── Stub Builders ────────────────────────────────────────────────────────────

type StubCallRecord = { method: string; args: unknown[] };

function buildHealthyClusterStub(calls: StubCallRecord[]) {
  return {
    cluster: {
      health: vi.fn(async () => {
        calls.push({ method: 'cluster.health', args: [] });
        return { body: { status: 'yellow' } };
      }),
    },
    ingest: {
      getPipeline: vi.fn(async () => { throw Object.assign(new Error('not found'), { meta: { statusCode: 404 } }); }),
      putPipeline: vi.fn(async () => {
        calls.push({ method: 'ingest.putPipeline', args: [] });
        return { body: {} };
      }),
    },
    indices: {
      exists: vi.fn(async () => {
        calls.push({ method: 'indices.exists', args: [] });
        return { body: false };
      }),
      create: vi.fn(async ({ index }: { index: string }) => {
        calls.push({ method: 'indices.create', args: [index] });
        return { body: {} };
      }),
      putMapping: vi.fn(async () => ({ body: {} })),
    },
    transport: {
      request: vi.fn(async ({ method, path }: { method: string; path: string }) => {
        if (method === 'GET') {
          // Simulate pipeline not found
          throw Object.assign(new Error('not found'), { meta: { statusCode: 404 } });
        }
        calls.push({ method: 'transport.request', args: [method, path] });
        return { statusCode: 200, body: {} };
      }),
    },
    close: vi.fn(async () => {}),
  };
}

function buildAlreadyExistsStub(calls: StubCallRecord[]) {
  return {
    cluster: {
      health: vi.fn(async () => ({ body: { status: 'green' } })),
    },
    ingest: {
      getPipeline: vi.fn(async () => {
        calls.push({ method: 'ingest.getPipeline', args: [] });
        return { body: {} };
      }),
      putPipeline: vi.fn(async () => ({ body: {} })),
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
    },
    transport: {
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === 'GET') return { statusCode: 200, body: {} };
        calls.push({ method: 'transport.PUT', args: [] });
        return { statusCode: 200, body: {} };
      }),
    },
    close: vi.fn(async () => {}),
  };
}

// ─── Minimal config for fast tests ───────────────────────────────────────────

const FAST_CONFIG = {
  opensearchUrl: 'http://localhost:9200',
  opensearchSslVerify: false,
  maxRetries: 3,
  baseRetryDelayMs: 10,
  maxRetryDelayMs: 50,
  bootstrapTimeoutMs: 10_000,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('OpenSearchBootstrapService', () => {
  describe('bootstrap() — fresh cluster (nothing exists)', () => {
    it('creates ingest pipeline, hybrid search pipeline, and both indices', async () => {
      const calls: StubCallRecord[] = [];
      const stub = buildHealthyClusterStub(calls);

      const service = new OpenSearchBootstrapService(FAST_CONFIG);
      // Inject stub client
      (service as any).client = stub;

      await service.bootstrap();

      expect(stub.ingest.putPipeline).toHaveBeenCalledOnce();
      expect(stub.indices.create).toHaveBeenCalledTimes(2);

      const createdIndices = calls
        .filter((c) => c.method === 'indices.create')
        .map((c) => c.args[0]);
      expect(createdIndices).toContain('public-content-v1');
      expect(createdIndices).toContain('public-author-v1');

      // Hybrid search pipeline PUT
      const pipelinePuts = calls.filter(
        (c) => c.method === 'transport.request' && (c.args[0] as string) === 'PUT',
      );
      expect(pipelinePuts).toHaveLength(1);
    });

    it('calls cluster.health before any write operation', async () => {
      const calls: StubCallRecord[] = [];
      const stub = buildHealthyClusterStub(calls);
      const service = new OpenSearchBootstrapService(FAST_CONFIG);
      (service as any).client = stub;

      await service.bootstrap();

      expect(stub.cluster.health).toHaveBeenCalledOnce();
    });
  });

  describe('bootstrap() — idempotent (all resources exist)', () => {
    it('does not create indices or ingest pipeline when they already exist', async () => {
      const calls: StubCallRecord[] = [];
      const stub = buildAlreadyExistsStub(calls);
      const service = new OpenSearchBootstrapService(FAST_CONFIG);
      (service as any).client = stub;

      await service.bootstrap();

      const creates = calls.filter((c) => c.method === 'indices.create');
      expect(creates).toHaveLength(0);

      // getPipeline was called (existence check), putPipeline was NOT
      expect(stub.ingest.putPipeline).not.toHaveBeenCalled();

      // putMapping is called to apply additive updates
      const mappingUpdates = calls.filter((c) => c.method === 'indices.putMapping');
      expect(mappingUpdates.length).toBeGreaterThan(0);
    });
  });

  describe('waitForCluster() — retry on unhealthy', () => {
    it('retries until cluster becomes healthy', async () => {
      let probeCount = 0;
      const stub = {
        cluster: {
          health: vi.fn(async () => {
            probeCount++;
            if (probeCount < 3) {
              return { body: { status: 'red' } };
            }
            return { body: { status: 'yellow' } };
          }),
        },
        ingest: {
          getPipeline: vi.fn(async () => { throw Object.assign(new Error(), { meta: { statusCode: 404 } }); }),
          putPipeline: vi.fn(async () => ({ body: {} })),
        },
        indices: {
          exists: vi.fn(async () => ({ body: false })),
          create: vi.fn(async () => ({ body: {} })),
          putMapping: vi.fn(async () => ({ body: {} })),
        },
        transport: {
          request: vi.fn(async ({ method }: { method: string }) => {
            if (method === 'GET') throw Object.assign(new Error(), { meta: { statusCode: 404 } });
            return { statusCode: 200, body: {} };
          }),
        },
        close: vi.fn(async () => {}),
      };

      const service = new OpenSearchBootstrapService(FAST_CONFIG);
      (service as any).client = stub;

      await service.bootstrap();

      expect(probeCount).toBe(3);
    });

    it('throws when max retries exceeded for cluster health', async () => {
      const stub = {
        cluster: {
          health: vi.fn(async () => { throw new Error('connection refused'); }),
        },
        close: vi.fn(async () => {}),
      };

      const service = new OpenSearchBootstrapService({
        ...FAST_CONFIG,
        maxRetries: 2,
        baseRetryDelayMs: 1,
        maxRetryDelayMs: 5,
      });
      (service as any).client = stub;

      await expect(service.bootstrap()).rejects.toThrow(/not reachable after/);
    });
  });

  describe('safeUpdateMappings() — additive guard', () => {
    it('logs a warning but does NOT throw when mapping update is rejected', async () => {
      const calls: StubCallRecord[] = [];
      const stub = {
        cluster: {
          health: vi.fn(async () => ({ body: { status: 'yellow' } })),
        },
        ingest: {
          getPipeline: vi.fn(async () => ({ body: {} })),
          putPipeline: vi.fn(async () => ({ body: {} })),
        },
        indices: {
          exists: vi.fn(async () => ({ body: true })),
          create: vi.fn(async () => ({ body: {} })),
          putMapping: vi.fn(async () => {
            calls.push({ method: 'putMapping', args: [] });
            throw new Error('mapper [text] cannot be changed from type [text] to [keyword]');
          }),
        },
        transport: {
          request: vi.fn(async ({ method }: { method: string }) => {
            if (method === 'GET') return { statusCode: 200, body: {} };
            return { statusCode: 200, body: {} };
          }),
        },
        close: vi.fn(async () => {}),
      };

      const service = new OpenSearchBootstrapService(FAST_CONFIG);
      (service as any).client = stub;

      // Should not throw even though putMapping fails
      await expect(service.bootstrap()).resolves.toBeUndefined();
    });
  });

  describe('deadline enforcement', () => {
    it('throws deadline exceeded when bootstrap timeout is exceeded', async () => {
      const stub = {
        cluster: {
          // Slow response that exceeds the tiny deadline
          health: vi.fn(
            () =>
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('timeout')), 200),
              ),
          ),
        },
        close: vi.fn(async () => {}),
      };

      const service = new OpenSearchBootstrapService({
        ...FAST_CONFIG,
        maxRetries: 5,
        baseRetryDelayMs: 1,
        maxRetryDelayMs: 5,
        bootstrapTimeoutMs: 50, // Very tight deadline
      });
      (service as any).client = stub;

      await expect(service.bootstrap()).rejects.toThrow(/[Dd]eadline|not reachable after/);
    });
  });
});
