import path from 'node:path';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { config } from '../config/config';
import { logger } from '../logger';

let lastScratchCleanupAt = 0;

function scratchRoot(): string {
  const configured = config.workerScratchDir || 'tmp';
  if (path.isAbsolute(configured)) {
    return configured;
  }

  if (config.mediaDataDir) {
    return path.resolve(config.mediaDataDir, configured);
  }

  return path.resolve(tmpdir(), configured);
}

export async function createWorkerScratchDir(prefix: string): Promise<string> {
  const root = scratchRoot();
  await mkdir(root, { recursive: true });
  await maybeCleanupStaleScratchDirs(root);
  return mkdtemp(path.join(root, `${prefix}-`));
}

export async function cleanupWorkerScratchDir(dirPath: string | undefined): Promise<void> {
  if (!dirPath) {
    return;
  }

  await rm(dirPath, { recursive: true, force: true });
}

async function maybeCleanupStaleScratchDirs(root: string): Promise<void> {
  const now = Date.now();
  if (now - lastScratchCleanupAt < config.workerScratchCleanupIntervalMs) {
    return;
  }

  lastScratchCleanupAt = now;

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }

  await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory()) {
      return;
    }

    const entryPath = path.join(root, String(entry.name));
    try {
      const metadata = await stat(entryPath);
      if (now - metadata.mtimeMs < config.workerScratchMaxAgeMs) {
        return;
      }

      await rm(entryPath, { recursive: true, force: true });
      logger.info({ scratchDir: entryPath }, 'worker-scratch-dir-pruned');
    } catch (error) {
      logger.warn({
        scratchDir: entryPath,
        error: error instanceof Error ? error.message : String(error)
      }, 'worker-scratch-dir-prune-failed');
    }
  }));
}
