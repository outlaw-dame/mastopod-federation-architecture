/**
 * Worker pool for ProductionAtCommitVerifier.
 *
 * The verifier is CPU-bound (CBOR decode, secp256k1/p256 signature verify,
 * MST reconstruction). On a single Node thread, throughput tops out around
 * the cost of one core's worth of crypto. This pool offloads verifyCommit()
 * to N worker threads so multi-core hosts can drive the AT firehose at the
 * full per-core ceiling × N.
 *
 * Behavior:
 *   - Drop-in for the AtCommitVerifier interface — upstream code is
 *     unchanged.
 *   - Round-robin dispatch across ready workers, with a bounded number of
 *     in-flight requests per worker.
 *   - Per-worker Redis client; identity / repo registry caches are still
 *     shared via Redis itself, so workers do not duplicate hot DID lookups.
 *   - Pool size is opt-in via AT_VERIFIER_WORKER_POOL_SIZE; set to 0 to
 *     keep the existing in-process verifier.
 */

import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type {
  AtCommitVerifier,
} from "./AtIngressVerifier.js";
import type { HttpAtIdentityResolverOptions } from "./HttpAtIdentityResolver.js";
import type { ProductionAtCommitVerifierOptions } from "./ProductionAtCommitVerifier.js";

const WORKER_PATH = fileURLToPath(new URL("./AtCommitVerifierWorker.bootstrap.mjs", import.meta.url));

export interface AtCommitVerifierWorkerPoolOptions {
  size: number;
  maxInFlightPerWorker?: number;
  redisUrl: string;
  didDocCacheTtlSeconds: number;
  identityResolverOptions: Omit<HttpAtIdentityResolverOptions, "redisCache" | "fetchImpl" | "resolveTxtImpl">;
  verifierOptions: Omit<ProductionAtCommitVerifierOptions, "identityResolver" | "repoRegistry">;
  /** Optional logger for pool-level events. */
  logger?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

interface PendingRequest {
  id: number;
  resolve: (value: Awaited<ReturnType<AtCommitVerifier["verifyCommit"]>>) => void;
  reject: (err: Error) => void;
}

interface WorkerSlot {
  worker: Worker;
  ready: Promise<void>;
  isReady: boolean;
  pending: Map<number, PendingRequest>;
}

export class AtCommitVerifierWorkerPool implements AtCommitVerifier {
  private readonly slots: WorkerSlot[] = [];
  private readonly waitQueue: Array<(slot: WorkerSlot) => void> = [];
  private readonly maxInFlightPerWorker: number;
  private nextId = 1;
  private rrCursor = 0;
  private shuttingDown = false;
  private readonly logger: AtCommitVerifierWorkerPoolOptions["logger"];

  public constructor(private readonly options: AtCommitVerifierWorkerPoolOptions) {
    if (options.size <= 0) {
      throw new Error("AtCommitVerifierWorkerPool requires size >= 1");
    }
    this.logger = options.logger;
    this.maxInFlightPerWorker = Math.max(1, Math.floor(options.maxInFlightPerWorker ?? 64));
    for (let i = 0; i < options.size; i++) {
      this.slots.push(this.spawnWorker(i));
    }
  }

  public async verifyCommit(
    body: any,
  ): Promise<Awaited<ReturnType<AtCommitVerifier["verifyCommit"]>>> {
    if (this.shuttingDown) {
      throw new Error("AtCommitVerifierWorkerPool is shutting down");
    }
    const slot = await this.acquireSlot();
    const id = this.nextId++;
    return await new Promise<Awaited<ReturnType<AtCommitVerifier["verifyCommit"]>>>(
      (resolve, reject) => {
        slot.pending.set(id, { id, resolve, reject });
        slot.worker.postMessage({ kind: "verify", id, body });
      },
    );
  }

  public async shutdown(): Promise<void> {
    this.shuttingDown = true;
    while (this.waitQueue.length > 0) {
      const w = this.waitQueue.shift();
      if (w) {
        w(this.createShutdownSlot());
      }
    }
    for (const slot of this.slots) {
      this.rejectPending(slot, new Error("AtCommitVerifierWorkerPool is shutting down"));
    }
    await Promise.allSettled(
      this.slots.map(async (slot) => {
        try {
          await slot.worker.terminate();
        } catch {
          // ignore
        }
      }),
    );
  }

  private spawnWorker(index: number): WorkerSlot {
    const worker = new Worker(WORKER_PATH, {
      workerData: {
        redisUrl: this.options.redisUrl,
        identityResolverOptions: this.options.identityResolverOptions,
        didDocCacheTtlSeconds: this.options.didDocCacheTtlSeconds,
        verifierOptions: this.options.verifierOptions,
      },
      // The bootstrap shim registers the tsx ESM loader inside the worker
      // before importing the .ts entry. We don't pass --import tsx here:
      // the bootstrap handles it, and avoiding the flag prevents tsx from
      // being loaded twice or interacting badly with execArgv inheritance.
      execArgv: [],
    });

    let resolveReady: () => void = () => {};
    const ready = new Promise<void>((r) => {
      resolveReady = r;
    });

    const slot: WorkerSlot = { worker, ready, isReady: false, pending: new Map() };

    worker.on("message", (msg: any) => {
      if (msg?.kind === "ready") {
        this.logger?.info("at-verifier-worker ready", { index });
        slot.isReady = true;
        resolveReady();
        this.releaseSlot(slot);
        return;
      }
      if (msg?.kind === "verify-result") {
        const pending = slot.pending.get(msg.id);
        slot.pending.delete(msg.id);
        if (pending && pending.id === msg.id) {
          if (msg.ok) {
            pending.resolve(msg.result);
          } else {
            pending.reject(new Error(msg.errorMessage ?? "verifier worker error"));
          }
        }
        this.releaseSlot(slot);
        return;
      }
    });

    worker.on("error", (err) => {
      this.logger?.error("at-verifier-worker error", {
        index,
        error: err.message,
      });
      this.rejectPending(slot, err);
      // Replace the worker so the pool stays at desired size.
      if (!this.shuttingDown) {
        this.slots[index] = this.spawnWorker(index);
      }
    });

    worker.on("exit", (code) => {
      if (this.shuttingDown) return;
      this.logger?.warn("at-verifier-worker exited; respawning", {
        index,
        code,
      });
      this.rejectPending(slot, new Error(`verifier worker exited with code ${code}`));
      this.slots[index] = this.spawnWorker(index);
    });

    return slot;
  }

  private acquireSlot(): Promise<WorkerSlot> {
    if (this.shuttingDown) {
      return Promise.reject(new Error("AtCommitVerifierWorkerPool is shutting down"));
    }

    let selected: WorkerSlot | null = null;
    for (let i = 0; i < this.slots.length; i++) {
      const idx = (this.rrCursor + i) % this.slots.length;
      const slot = this.slots[idx];
      if (!slot?.isReady || slot.pending.size >= this.maxInFlightPerWorker) {
        continue;
      }
      if (!selected || slot.pending.size < selected.pending.size) {
        selected = slot;
        this.rrCursor = (idx + 1) % this.slots.length;
        if (slot.pending.size === 0) {
          break;
        }
      }
    }

    if (selected) {
      return Promise.resolve(selected);
    }

    return new Promise<WorkerSlot>((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  private releaseSlot(slot: WorkerSlot): void {
    if (!slot.isReady || slot.pending.size >= this.maxInFlightPerWorker) {
      return;
    }
    while (slot.pending.size < this.maxInFlightPerWorker) {
      const next = this.waitQueue.shift();
      if (!next) {
        return;
      }
      next(slot);
    }
  }

  private rejectPending(slot: WorkerSlot, error: Error): void {
    for (const pending of slot.pending.values()) {
      pending.reject(error);
    }
    slot.pending.clear();
  }

  private createShutdownSlot(): WorkerSlot {
    return {
      worker: {
        postMessage: () => {
          throw new Error("AtCommitVerifierWorkerPool is shutting down");
        },
      } as unknown as Worker,
      ready: Promise.resolve(),
      isReady: true,
      pending: new Map(),
    };
  }
}
