import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { assertVideoToolingReady } from '../utils/videoTooling';

interface ServiceDefinition {
  name: string;
  scriptPath: string;
}

interface ServiceRuntime {
  definition: ServiceDefinition;
  process: ChildProcess | null;
  consecutiveFailures: number;
  restartTimer: NodeJS.Timeout | null;
  startedAtMs: number;
}

const services: ServiceDefinition[] = [
  { name: 'ingress', scriptPath: 'src/server/queueIngress.ts' },
  { name: 'worker:ingest', scriptPath: 'src/workers/ingestWorker.ts' },
  { name: 'worker:fetch', scriptPath: 'src/workers/fetchWorker.ts' },
  { name: 'worker:process:image', scriptPath: 'src/workers/processImageWorker.ts' },
  { name: 'worker:process:video', scriptPath: 'src/workers/processVideoWorker.ts' },
  { name: 'worker:rendition:video', scriptPath: 'src/workers/videoRenditionWorker.ts' },
  { name: 'worker:finalize', scriptPath: 'src/workers/finalizeWorker.ts' }
];

const baseDelayMs = 500;
const maxDelayMs = 30_000;
const healthyRuntimeResetMs = 30_000;
const currentDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(currentDir, '../..');
const runtimes = new Map<string, ServiceRuntime>();
let stopping = false;

for (const definition of services) {
  runtimes.set(definition.name, {
    definition,
    process: null,
    consecutiveFailures: 0,
    restartTimer: null,
    startedAtMs: 0
  });
}

function log(message: string, meta?: Record<string, unknown>): void {
  const line = meta ? `${message} ${JSON.stringify(meta)}` : message;
  process.stdout.write(`[media-local-stack] ${line}\n`);
}

function logChildOutput(name: string, chunk: Buffer | string, stream: 'stdout' | 'stderr'): void {
  const prefix = `[${name}]`;
  const content = chunk.toString();
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    if (!line) {
      continue;
    }

    const target = stream === 'stderr' ? process.stderr : process.stdout;
    target.write(`${prefix} ${line}\n`);
  }
}

function spawnService(runtime: ServiceRuntime): void {
  if (stopping) {
    return;
  }

  const scriptPath = resolve(projectRoot, runtime.definition.scriptPath);
  const child = spawn(process.execPath, ['--import', 'tsx', scriptPath], {
    cwd: projectRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  runtime.process = child;
  runtime.startedAtMs = Date.now();

  child.stdout?.on('data', (chunk) => logChildOutput(runtime.definition.name, chunk, 'stdout'));
  child.stderr?.on('data', (chunk) => logChildOutput(runtime.definition.name, chunk, 'stderr'));
  child.on('error', (error) => {
    log('service-spawn-error', {
      service: runtime.definition.name,
      error: error.message
    });
  });
  child.on('exit', (code, signal) => {
    runtime.process = null;
    if (stopping) {
      return;
    }

    const runtimeMs = Date.now() - runtime.startedAtMs;
    runtime.consecutiveFailures = runtimeMs >= healthyRuntimeResetMs
      ? 0
      : runtime.consecutiveFailures + 1;

    const delayMs = computeBackoffDelay(runtime.consecutiveFailures);
    log('service-exited', {
      service: runtime.definition.name,
      code,
      signal,
      runtimeMs,
      restartDelayMs: delayMs
    });

    runtime.restartTimer = setTimeout(() => {
      runtime.restartTimer = null;
      spawnService(runtime);
    }, delayMs);
  });

  log('service-started', {
    service: runtime.definition.name,
    pid: child.pid
  });
}

function computeBackoffDelay(attempt: number): number {
  const maxDelayForAttempt = Math.min(maxDelayMs, baseDelayMs * (2 ** Math.max(0, attempt)));
  return Math.floor(Math.random() * Math.max(baseDelayMs, maxDelayForAttempt));
}

function shutdown(signal: NodeJS.Signals): void {
  if (stopping) {
    return;
  }

  stopping = true;
  log('shutdown-requested', { signal });

  for (const runtime of runtimes.values()) {
    if (runtime.restartTimer) {
      clearTimeout(runtime.restartTimer);
      runtime.restartTimer = null;
    }

    if (runtime.process && !runtime.process.killed) {
      runtime.process.kill('SIGTERM');
    }
  }

  setTimeout(() => {
    for (const runtime of runtimes.values()) {
      if (runtime.process && !runtime.process.killed) {
        runtime.process.kill('SIGKILL');
      }
    }
  }, 5_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

await assertVideoToolingReady();

for (const runtime of runtimes.values()) {
  spawnService(runtime);
}
