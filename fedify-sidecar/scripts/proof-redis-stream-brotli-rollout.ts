import { createClient } from "redis";
import {
  RedisStreamsQueue,
  type OutboundJob,
} from "../src/queue/sidecar-redis-queue-core.js";

const redisUrl = process.env["REDIS_URL"] ?? "redis://127.0.0.1:6379";
const outputPath = process.env["REDIS_BROTLI_ROLLOUT_PROOF_OUTPUT"];
const token = `${process.pid}-${Date.now()}`;
const outboundStream = `ap:proof:brotli-rollout:${token}:outbound`;
const consumerGroup = `brotli-rollout-${token}`;

function makeActivity(label: string): string {
  return JSON.stringify({
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `https://local.example/activities/${label}`,
    type: "Create",
    actor: "https://local.example/users/alice",
    object: {
      id: `https://local.example/objects/${label}`,
      type: "Note",
      content: `${label} ${"ActivityPub rollout compression proof ".repeat(700)}`,
    },
  });
}

function makeJob(label: string): OutboundJob {
  return {
    jobId: `job-${label}`,
    activityId: `https://local.example/activities/${label}`,
    actorUri: "https://local.example/users/alice",
    activity: makeActivity(label),
    targetInbox: "https://remote.example/inbox",
    targetDomain: "remote.example",
    attempt: 0,
    maxAttempts: 8,
    notBeforeMs: 0,
  };
}

function queueConfig(consumerId: string, writeEnabled: boolean) {
  const base = `ap:proof:brotli-rollout:${token}`;
  return {
    redisUrl,
    inboundStreamKey: `${base}:inbound`,
    outboundStreamKey: outboundStream,
    outboxIntentStreamKey: `${base}:outbox-intent`,
    originReconcileStreamKey: `${base}:origin-reconcile`,
    inboundDlqStreamKey: `${base}:dlq-inbound`,
    outboundDlqStreamKey: `${base}:dlq-outbound`,
    outboxIntentDlqStreamKey: `${base}:dlq-outbox-intent`,
    originReconcileDlqStreamKey: `${base}:dlq-origin-reconcile`,
    consumerGroup,
    consumerId,
    blockTimeoutMs: 50,
    claimIdleTimeMs: 5,
    readBatchCount: 10,
    claimBatchCount: 10,
    payloadCompression: {
      writeEnabled,
      minBytes: 4 * 1024,
      brotliQuality: 0,
    },
  };
}

async function consumeOne(queue: RedisStreamsQueue) {
  const iterator = queue.consumeOutbound()[Symbol.asyncIterator]();
  const result = await iterator.next();
  await iterator.return?.();
  if (result.done || !result.value) throw new Error("Outbound queue ended before yielding proof work");
  return result.value;
}

async function rawEntryForJob(admin: ReturnType<typeof createClient>, jobId: string) {
  const entries = await admin.xRange(outboundStream, "-", "+");
  const entry = entries.find((item) => item.message["jobId"] === jobId);
  if (!entry) throw new Error(`Missing raw Redis Stream entry for ${jobId}`);
  return entry;
}

async function main() {
  const admin = createClient({ url: redisUrl });
  await admin.connect();

  const keys = [
    outboundStream,
    `ap:proof:brotli-rollout:${token}:inbound`,
    `ap:proof:brotli-rollout:${token}:outbox-intent`,
    `ap:proof:brotli-rollout:${token}:origin-reconcile`,
    `ap:proof:brotli-rollout:${token}:dlq-inbound`,
    `ap:proof:brotli-rollout:${token}:dlq-outbound`,
    `ap:proof:brotli-rollout:${token}:dlq-outbox-intent`,
    `ap:proof:brotli-rollout:${token}:dlq-origin-reconcile`,
  ];

  try {
    // Stage 1: decode-capable deployment with compressed writes still disabled.
    const plaintextQueue = new RedisStreamsQueue(queueConfig("stage-1-plaintext", false));
    await plaintextQueue.connect();
    const plaintextJob = makeJob("plaintext-before-enable");
    await plaintextQueue.enqueueOutbound(plaintextJob);
    await plaintextQueue.disconnect();

    const rawPlaintext = await rawEntryForJob(admin, plaintextJob.jobId);
    if (rawPlaintext.message["activity"] !== plaintextJob.activity) {
      throw new Error("Write-disabled stage did not retain the legacy plaintext representation");
    }

    // Stage 2: turn compressed writes on. The new reader must first consume retained plaintext.
    const enabledQueue = new RedisStreamsQueue(queueConfig("stage-2-enabled", true));
    await enabledQueue.connect();
    const consumedPlaintext = await consumeOne(enabledQueue);
    if (consumedPlaintext.job.jobId !== plaintextJob.jobId || consumedPlaintext.job.activity !== plaintextJob.activity) {
      throw new Error("Compression-enabled reader failed to consume retained plaintext work");
    }
    await enabledQueue.ack("outbound", consumedPlaintext.messageId);

    // Persist compressed work and deliberately leave it pending to simulate a worker crash/restart.
    const compressedJob = makeJob("compressed-before-rollback");
    await enabledQueue.enqueueOutbound(compressedJob);
    const rawCompressed = await rawEntryForJob(admin, compressedJob.jobId);
    if (!rawCompressed.message["activity"]?.startsWith("apq1:br:")) {
      throw new Error("Compression-enabled stage did not persist the versioned Brotli envelope");
    }

    const pendingCompressed = await consumeOne(enabledQueue);
    if (pendingCompressed.job.jobId !== compressedJob.jobId || pendingCompressed.job.activity !== compressedJob.activity) {
      throw new Error("Compression-enabled reader did not round-trip its compressed work");
    }
    // No ACK: this entry must survive as pending work and be reclaimable after restart.
    await enabledQueue.disconnect();

    const pendingBeforeRollback = await admin.sendCommand([
      "XPENDING",
      outboundStream,
      consumerGroup,
      "-",
      "+",
      "10",
    ]);
    if (!Array.isArray(pendingBeforeRollback) || pendingBeforeRollback.length !== 1) {
      throw new Error(`Expected exactly one pending compressed entry before rollback, got ${JSON.stringify(pendingBeforeRollback)}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 20));

    // Stage 3: rollback writer flag to disabled. Readers must still decode/reclaim compressed work.
    const rollbackQueue = new RedisStreamsQueue(queueConfig("stage-3-rollback", false));
    await rollbackQueue.connect();
    const reclaimed = await consumeOne(rollbackQueue);
    if (reclaimed.messageId !== pendingCompressed.messageId) {
      throw new Error("Rollback reader did not reclaim the exact pending compressed Stream entry");
    }
    if (reclaimed.job.jobId !== compressedJob.jobId || reclaimed.job.activity !== compressedJob.activity) {
      throw new Error("Rollback reader failed to decode reclaimed compressed work");
    }
    await rollbackQueue.ack("outbound", reclaimed.messageId);

    // With writes disabled again, newly persisted work must return to plaintext without a schema migration.
    const rollbackPlaintextJob = makeJob("plaintext-after-rollback");
    await rollbackQueue.enqueueOutbound(rollbackPlaintextJob);
    const rawRollback = await rawEntryForJob(admin, rollbackPlaintextJob.jobId);
    if (rawRollback.message["activity"] !== rollbackPlaintextJob.activity) {
      throw new Error("Rollback writer did not return to the legacy plaintext representation");
    }
    const consumedRollbackPlaintext = await consumeOne(rollbackQueue);
    if (consumedRollbackPlaintext.job.jobId !== rollbackPlaintextJob.jobId) {
      throw new Error("Rollback reader failed to consume newly written plaintext work");
    }
    await rollbackQueue.ack("outbound", consumedRollbackPlaintext.messageId);
    await rollbackQueue.disconnect();

    const pendingAfterRollback = await admin.sendCommand(["XPENDING", outboundStream, consumerGroup]);
    const pendingCount = Array.isArray(pendingAfterRollback) ? Number(pendingAfterRollback[0] ?? -1) : -1;
    if (pendingCount !== 0) {
      throw new Error(`Rollout proof left pending work behind: ${JSON.stringify(pendingAfterRollback)}`);
    }

    const output = {
      schema: "apdm-redis-stream-brotli-rollout.v1",
      measuredAt: new Date().toISOString(),
      node: process.version,
      redisUrl: redisUrl.replace(/:\/\/[^@]+@/u, "://***@"),
      stages: {
        decodeCapableWriteDisabled: {
          persistedEncoding: "plaintext",
          consumedByEnabledReader: true,
        },
        compressionEnabled: {
          persistedEncoding: "apq1:br",
          inMemoryActivityUnchanged: true,
          deliberatelyLeftPending: true,
        },
        writerRollback: {
          reclaimedCompressedPendingEntry: true,
          compressedPayloadDecodedUnchanged: true,
          newWritesReturnedToPlaintext: true,
          finalPendingCount: 0,
        },
      },
      invariants: {
        streamKeyUnchanged: true,
        consumerGroupUnchanged: true,
        jobContractUnchanged: true,
        ackAfterSuccessfulDecodeOnly: true,
      },
    };

    const rendered = `${JSON.stringify(output, null, 2)}\n`;
    if (outputPath) {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, rendered);
    }
    process.stdout.write(rendered);
  } finally {
    await admin.del(keys).catch(() => 0);
    await admin.quit();
  }
}

await main();
