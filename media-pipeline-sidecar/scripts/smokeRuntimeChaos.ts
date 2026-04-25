#!/usr/bin/env tsx

import { randomUUID } from 'node:crypto';
import { reloadConfigFromEnv } from '../src/config/config';
import { MediaStreams } from '../src/contracts/MediaStreams';
import { enqueue } from '../src/queue/producer';
import { initRedis, redis } from '../src/queue/redisClient';
import { runSecureWorker } from '../src/queue/secureWorker';
import { NonRetryableMediaPipelineError, RetryableMediaPipelineError } from '../src/utils/errorHandling';
import { sleep } from '../src/utils/retry';

interface ChaosScenario {
  name: string;
  mode: 'recover' | 'retryable-dlq' | 'nonretryable-dlq';
  retryableFailuresBeforeSuccess?: number;
  expectedAttempts: number;
  expectedRetryAttempts: number;
}

interface DlqEntry {
  id: string;
  message: Record<string, string>;
}

async function main(): Promise<void> {
  const restoreEnv = applyEnv({
    WORKER_MAX_SCHEDULED_RETRIES: '2',
    WORKER_RETRY_BASE_DELAY_MS: '5',
    WORKER_RETRY_MAX_DELAY_MS: '5',
    PENDING_MIN_IDLE_MS: '25'
  });

  try {
    reloadConfigFromEnv();
    await initRedis();

    console.log('Chaos smoke: real Redis-backed worker proof\n');

    const scenarios: ChaosScenario[] = [
      {
        name: 'retryable recovery',
        mode: 'recover',
        retryableFailuresBeforeSuccess: 2,
        expectedAttempts: 3,
        expectedRetryAttempts: 0
      },
      {
        name: 'retryable exhaustion to DLQ',
        mode: 'retryable-dlq',
        expectedAttempts: 3,
        expectedRetryAttempts: 2
      },
      {
        name: 'non-retryable direct DLQ',
        mode: 'nonretryable-dlq',
        expectedAttempts: 1,
        expectedRetryAttempts: 0
      }
    ];

    for (const scenario of scenarios) {
      await runScenario(scenario);
    }

    console.log('\nChaos smoke: success');
  } finally {
    restoreEnv();
    reloadConfigFromEnv();
    if (redis.isOpen) {
      await redis.quit();
    }
  }
}

async function runScenario(scenario: ChaosScenario): Promise<void> {
  const stream = `media:chaos:${randomUUID()}`;
  const retryKey = `${stream}:retry`;
  const traceId = `trace-${randomUUID()}`;
  const group = `chaos-${randomUUID()}`;
  const stopController = new AbortController();
  let attempts = 0;
  let successes = 0;

  await redis.del(stream, retryKey);

  const workerPromise = runSecureWorker({
    stream,
    group,
    consumer: 'chaos-proof-worker',
    readCount: 1,
    blockMs: 25,
    stopSignal: stopController.signal,
    handler: async (message) => {
      if (message.traceId !== traceId) {
        return;
      }

      attempts += 1;

      switch (scenario.mode) {
        case 'recover':
          if (attempts <= (scenario.retryableFailuresBeforeSuccess || 0)) {
            throw new RetryableMediaPipelineError({
              code: 'CHAOS_RECOVERABLE',
              message: `retryable failure ${attempts}`
            });
          }
          successes += 1;
          return;
        case 'retryable-dlq':
          throw new RetryableMediaPipelineError({
            code: 'CHAOS_RETRY_EXHAUSTED',
            message: `retryable failure ${attempts}`
          });
        case 'nonretryable-dlq':
          throw new NonRetryableMediaPipelineError({
            code: 'CHAOS_PERMANENT',
            message: 'non-retryable failure'
          });
      }
    }
  });

  try {
    await enqueue(stream, {
      traceId,
      ownerId: 'chaos-proof-owner'
    });

    await waitForCondition(async () => {
      const dlqEntries = await readMatchingDlqEntries(stream);
      const pendingRetries = await redis.zCard(retryKey);

      if (scenario.mode === 'recover') {
        return successes === 1 && dlqEntries.length === 0 && pendingRetries === 0;
      }

      return dlqEntries.length === 1 && pendingRetries === 0;
    }, 4000, 20);

    const dlqEntries = await readMatchingDlqEntries(stream);
    const dlqMessage = dlqEntries[0]?.message;

    if (attempts !== scenario.expectedAttempts) {
      throw new Error(`Scenario "${scenario.name}" observed ${attempts} attempts, expected ${scenario.expectedAttempts}`);
    }

    if (scenario.mode === 'recover') {
      if (successes !== 1) {
        throw new Error(`Scenario "${scenario.name}" did not complete successfully`);
      }
      console.log(`- ${scenario.name}: recovered after ${attempts} attempts`);
      return;
    }

    if (!dlqMessage) {
      throw new Error(`Scenario "${scenario.name}" did not produce a DLQ entry`);
    }

    const retryAttempts = Number.parseInt(dlqMessage.retryAttempts || '0', 10);
    if (retryAttempts !== scenario.expectedRetryAttempts) {
      throw new Error(`Scenario "${scenario.name}" wrote retryAttempts=${retryAttempts}, expected ${scenario.expectedRetryAttempts}`);
    }

    if (scenario.mode === 'retryable-dlq' && dlqMessage.retriesExhausted !== 'true') {
      throw new Error(`Scenario "${scenario.name}" did not mark retriesExhausted=true`);
    }

    if (scenario.mode === 'nonretryable-dlq' && dlqMessage.retryable !== 'false') {
      throw new Error(`Scenario "${scenario.name}" unexpectedly marked non-retryable failure as retryable`);
    }

    console.log(`- ${scenario.name}: DLQ verified after ${attempts} attempts`);
  } finally {
    stopController.abort();
    await workerPromise;
    await redis.del(stream, retryKey);
  }
}

async function waitForCondition(
  condition: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }

    await sleep(intervalMs);
  }

  throw new Error(`Timed out waiting for condition after ${timeoutMs}ms`);
}

async function readMatchingDlqEntries(stream: string): Promise<DlqEntry[]> {
  const entries = await redis.xRange(MediaStreams.DLQ, '-', '+');
  return entries.filter((entry) => entry.message.stream === stream);
}

function applyEnv(overrides: Record<string, string>): () => void {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }

  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (typeof value === 'undefined') {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

main().catch((error) => {
  console.error('Chaos smoke failed');
  console.error(error);
  process.exit(1);
});
