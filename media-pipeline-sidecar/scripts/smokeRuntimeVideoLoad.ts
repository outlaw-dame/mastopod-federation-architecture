#!/usr/bin/env tsx

import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function formatMs(value: number): string {
  return `${value.toFixed(1)}ms`;
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 1) {
    return values[0];
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

async function main(): Promise<void> {
  const runs = parsePositiveInt(process.env.SMOKE_VIDEO_LOAD_RUNS, 3);
  const concurrency = Math.min(parsePositiveInt(process.env.SMOKE_VIDEO_LOAD_CONCURRENCY, 2), runs);
  const durations: number[] = [];
  let launched = 0;

  async function workerLoop(): Promise<void> {
    while (launched < runs) {
      const runNumber = launched;
      launched += 1;

      const startedAt = performance.now();
      try {
        await execFileAsync(process.execPath, [
          '--import',
          'tsx',
          'scripts/smokeRuntimeVideo.ts'
        ], {
          cwd: packageRoot,
          env: process.env,
          timeout: 120000,
          maxBuffer: 1024 * 1024
        });
      } catch (error) {
        const candidate = error as { stdout?: string; stderr?: string; message?: string };
        throw new Error([
          `Video load child run ${runNumber + 1} failed`,
          candidate.message || 'unknown error',
          candidate.stdout ? `stdout:\n${candidate.stdout}` : '',
          candidate.stderr ? `stderr:\n${candidate.stderr}` : ''
        ].filter(Boolean).join('\n'));
      }

      durations.push(performance.now() - startedAt);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => workerLoop()));

  console.log('smoke-runtime:video:load success');
  console.log(`runs=${runs}`);
  console.log(`concurrency=${concurrency}`);
  console.log(`min=${formatMs(Math.min(...durations))}`);
  console.log(`avg=${formatMs(average(durations))}`);
  console.log(`p50=${formatMs(percentile(durations, 0.5))}`);
  console.log(`p95=${formatMs(percentile(durations, 0.95))}`);
  console.log(`max=${formatMs(Math.max(...durations))}`);
}

main().catch((err) => {
  console.error('smoke-runtime:video:load failed');
  console.error(err);
  process.exit(1);
});
